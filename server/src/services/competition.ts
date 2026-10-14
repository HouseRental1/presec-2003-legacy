import { z } from 'zod';
import { Actor, Db, q, one, need, audit, notify, conflict, invalid, today, perms } from '../lib.js';

/**
 * House standings, reproducible from verified payments and the published rule version.
 *   target       = per-member target × eligible members (frozen at period start)
 *   achievement  = verified gross raised in period ÷ target
 *   participation= distinct contributing members ÷ eligible members
 *   score        = wT × min(achievement, cap)/cap + wP × participation         (out of 100)
 * Only category 'member' counts (donations go to the project, not a house). A payment counts for
 * the house the member belonged to on the payment date (effective-dated memberships).
 * Tie-break: participation, then earliest date the house reached half its target.
 */
export async function standings(db: Db | any, asOf = today()) {
  const rules = await q<any>(db, `SELECT * FROM competition_rules WHERE status='in_force' AND period_start <= $1 ORDER BY period_start DESC LIMIT 1`, [asOf]);
  if (!rules.length) return { rule: null, rows: [] };
  const rule = rules[0];
  const end = asOf < rule.period_end ? asOf : rule.period_end;
  const pays = await q<any>(db, `
    SELECT p.member_id, p.amount_ghs, p.paid_on, hm.house_id
    FROM payments p JOIN house_memberships hm ON hm.member_id=p.member_id
      AND hm.valid_from <= p.paid_on AND (hm.valid_to IS NULL OR hm.valid_to >= p.paid_on)
    WHERE p.status='verified' AND p.category='member' AND p.paid_on BETWEEN $1 AND $2
    ORDER BY p.paid_on, p.created_at`, [rule.period_start, end]);
  const houses = await q<any>(db, 'SELECT id, name FROM houses ORDER BY id');
  const rows = houses.map((h) => {
    const eligible = Number(rule.eligible_snapshot?.[h.id] ?? 0);
    return { houseId: h.id, name: h.name, eligible, target: eligible * rule.per_member_target, raised: 0, contributors: new Set<string>(), reachedHalf: null as string | null };
  });
  const by = Object.fromEntries(rows.map((r) => [r.houseId, r]));
  for (const p of pays) {
    const r = by[p.house_id]; if (!r) continue;
    r.raised += p.amount_ghs; r.contributors.add(p.member_id);
    if (!r.reachedHalf && r.raised * 2 >= r.target) r.reachedHalf = p.paid_on;
  }
  const cap = rule.cap_bp / 10000;
  const out = rows.map((r) => {
    const achievement = r.target ? r.raised / r.target : 0;
    const participation = r.eligible ? r.contributors.size / r.eligible : 0;
    const score = rule.weight_target * Math.min(achievement, cap) / cap + rule.weight_participation * participation;
    return { houseId: r.houseId, name: r.name, eligible: r.eligible, target: r.target, raised: r.raised, contributors: r.contributors.size,
      achievement, participation, score: Math.round(score * 100) / 100, reachedHalf: r.reachedHalf };
  });
  out.sort((a, b) => b.score - a.score || b.participation - a.participation || (a.reachedHalf ?? '9999') .localeCompare(b.reachedHalf ?? '9999'));
  const pledged = await q<any>(db, `SELECT hm.house_id, sum(pl.amount) amount FROM pledges pl JOIN house_memberships hm ON hm.member_id=pl.member_id AND hm.valid_to IS NULL
    WHERE pl.status='active' GROUP BY hm.house_id`);
  return {
    rule: { version: rule.version, periodName: rule.period_name, start: rule.period_start, end: rule.period_end, perMemberTarget: rule.per_member_target,
      weightTarget: rule.weight_target, weightParticipation: rule.weight_participation, capBp: rule.cap_bp, approvedBy: rule.approved_by },
    rows: out.map((r, i) => ({ rank: i + 1, ...r })),
    pledgedNotPaid: Object.fromEntries(pledged.map((p) => [p.house_id, p.amount])),
  };
}

/** Captains see who has not yet contributed (names only, never amounts). */
export async function captainOutreach(db: Db | any, actor: Actor) {
  need(actor, 'house.tools', 'use captain tools');
  const [h] = await q<any>(db, 'SELECT house_id FROM house_captains WHERE user_id=$1', [actor.userId]);
  if (!h) throw conflict('You are not captain of a house.');
  const [rule] = await q<any>(db, `SELECT * FROM competition_rules WHERE status='in_force' ORDER BY period_start DESC LIMIT 1`);
  const rows = await q<any>(db, `SELECT m.member_no, m.full_name, m.city FROM members m JOIN house_memberships hm ON hm.member_id=m.id AND hm.valid_to IS NULL
    WHERE hm.house_id=$1 AND m.verified_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.member_id=m.id AND p.status='verified' AND p.category='member' AND p.paid_on >= $2)
    ORDER BY m.full_name`, [h.house_id, rule.period_start]);
  return { houseId: h.house_id, notYet: rows };
}
export async function sendReminder(db: Db, actor: Actor) {
  const { houseId, notYet } = await captainOutreach(db, actor);
  await notify(db, 'house:' + houseId, ['in_app', 'sms'], `From your house captain: ${notYet.length} of us are yet to give. Any amount helps us climb the table.`);
  await audit(db, actor, 'Sent house reminder', houseId, `${notYet.length} members`);
  return { queued: notYet.length };
}

/** Rule changes are drafted for a future period only; current results are never altered retroactively. */
export const RuleDraft = z.object({ version: z.string().min(1), periodName: z.string(), start: z.string(), end: z.string(), perMemberTargetGhs: z.number().positive(), weightTarget: z.number().int().min(0).max(100) });
export async function draftRule(db: Db, actor: Actor, input: z.infer<typeof RuleDraft>) {
  need(actor, 'rules.edit', 'draft competition rules');
  const [cur] = await q<any>(db, `SELECT period_end FROM competition_rules WHERE status='in_force' ORDER BY period_start DESC LIMIT 1`);
  if (cur && input.start <= cur.period_end) throw invalid('A new rule version can only start after the current period ends.');
  await db.query(`INSERT INTO competition_rules (version, status, period_name, period_start, period_end, per_member_target, weight_target, weight_participation, approved_by)
    VALUES ($1,'draft',$2,$3,$4,$5,$6,$7,'Pending member vote')`, [input.version, input.periodName, input.start, input.end, Math.round(input.perMemberTargetGhs * 100), input.weightTarget, 100 - input.weightTarget]);
  await audit(db, actor, 'Drafted competition rules', 'rules-' + input.version);
}
/** Freeze eligible members per house when a period starts. */
export async function freezeEligible(db: Db, version: string) {
  const rows = await q<any>(db, `SELECT hm.house_id, count(*)::int n FROM members m JOIN house_memberships hm ON hm.member_id=m.id AND hm.valid_to IS NULL
    WHERE m.verified_at IS NOT NULL GROUP BY hm.house_id`);
  const snap = Object.fromEntries(rows.map((r) => [r.house_id, r.n]));
  // eligible_snapshot is set once; competition_rules rows are otherwise immutable by policy
  await db.query(`UPDATE competition_rules SET eligible_snapshot=$2 WHERE version=$1 AND eligible_snapshot IS NULL`, [version, snap]);
  return snap;
}
export async function ruleVersions(db: Db | any) {
  return q(db, 'SELECT * FROM competition_rules ORDER BY period_start');
}
void one;

/* ───────── house profiles and rosters (always available, with or without a competition) */
/** Who may see individual amounts on the Houses page: 'finance' (finance roles only) or 'members' (every signed-in classmate). */
export async function amountsVisibility(db: Db | any): Promise<'finance' | 'members'> {
  const [r] = await q<any>(db, `SELECT value FROM settings WHERE key='house_amounts'`);
  return r?.value === 'finance' ? 'finance' : 'members';   // default: fully transparent within the year group
}
const seesAmounts = async (db: Db | any, actor: Actor) => perms(actor).has('fin.view') || (await amountsVisibility(db)) === 'members';

export async function houseOverview(db: Db | any, actor: Actor) {
  need(actor, 'dir', 'view the houses');
  // Money counts for the house the classmate belonged to on the day they paid (same rule as the competition).
  const houses = await q<any>(db, `SELECT h.id, h.name, h.about, h.motto,
      (SELECT count(*)::int FROM house_memberships hm WHERE hm.house_id=h.id AND hm.valid_to IS NULL) members,
      (SELECT count(*)::int FROM house_memberships hm JOIN members m ON m.id=hm.member_id WHERE hm.house_id=h.id AND hm.valid_to IS NULL AND m.user_id IS NOT NULL) with_accounts,
      (SELECT coalesce(json_agg(coalesce(m.full_name, u.display_name)), '[]') FROM house_captains c JOIN users u ON u.id=c.user_id LEFT JOIN members m ON m.user_id=u.id WHERE c.house_id=h.id) captains,
      coalesce(pay.raised, 0)::bigint raised, coalesce(pay.contributors, 0)::int contributors, pay.last_paid
    FROM houses h LEFT JOIN (
      SELECT hm.house_id, sum(p.amount_ghs) raised, count(DISTINCT p.member_id) contributors, max(p.paid_on) last_paid
      FROM payments p JOIN house_memberships hm ON hm.member_id=p.member_id AND hm.valid_from <= p.paid_on AND (hm.valid_to IS NULL OR hm.valid_to >= p.paid_on)
      WHERE p.status='verified' AND p.category='member' GROUP BY hm.house_id) pay ON pay.house_id=h.id
    ORDER BY h.id`);
  const all = houses.reduce((n: number, h: any) => n + Number(h.raised), 0);
  return { houses: houses.map((h: any) => ({ ...h, raised: Number(h.raised) })), totalRaised: all, amountsVisibleTo: await amountsVisibility(db), canSeeAmounts: await seesAmounts(db, actor) };
}

/** One house's classmates with what each has given (amounts only for those allowed to see them). */
export async function houseMembers(db: Db | any, actor: Actor, houseId: string, search = '', sort = 'name', page = 0) {
  need(actor, 'dir', 'view the houses');
  const show = await seesAmounts(db, actor);
  const order = sort === 'amount' && show ? 'given DESC, m.full_name' : sort === 'recent' ? 'last_paid DESC NULLS LAST, m.full_name' : 'm.full_name';
  const where = `hm.house_id=$1 AND hm.valid_to IS NULL AND ($2 = '' OR (m.full_name || ' ' || m.member_no || ' ' || coalesce(m.city,'') || ' ' || coalesce(m.profession,'')) ILIKE '%' || $2 || '%')`;
  const rows = await q<any>(db, `SELECT m.id, m.member_no, m.full_name, m.city, m.profession, m.verified_at IS NOT NULL verified, m.user_id IS NOT NULL has_account,
      coalesce(sum(p.amount_ghs), 0)::bigint given, count(p.id)::int payments, max(p.paid_on) last_paid
    FROM members m JOIN house_memberships hm ON hm.member_id=m.id
    LEFT JOIN payments p ON p.member_id=m.id AND p.status='verified' AND p.category='member'
    WHERE ${where} GROUP BY m.id ORDER BY ${order} LIMIT 50 OFFSET $3`, [houseId, search, page * 50]);
  const [{ n }] = await q<any>(db, `SELECT count(*)::int n FROM members m JOIN house_memberships hm ON hm.member_id=m.id WHERE ${where}`, [houseId, search]);
  return {
    total: n, amountsShown: show,
    rows: rows.map((r: any) => ({ member_no: r.member_no, full_name: r.full_name, city: r.city, profession: r.profession, verified: r.verified, has_account: r.has_account,
      contributed: r.payments > 0, payments: r.payments, last_paid: r.last_paid,
      given: show || r.id === actor.memberId ? Number(r.given) : null })),
  };
}

export const AmountsVisibility = z.object({ visibleTo: z.enum(['finance', 'members']) });
export async function setAmountsVisibility(db: Db, actor: Actor, input: z.infer<typeof AmountsVisibility>) {
  need(actor, 'admin.members', 'change who sees individual amounts');
  await db.query(`INSERT INTO settings (key, value) VALUES ('house_amounts', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(input.visibleTo)]);
  await audit(db, actor, 'Changed who sees individual contributions', 'house_amounts', input.visibleTo);
}
export const HouseProfile = z.object({ about: z.string().max(2000).optional(), motto: z.string().max(200).optional() });
export async function updateHouse(db: Db, actor: Actor, id: string, input: z.infer<typeof HouseProfile>) {
  need(actor, 'admin.members', 'edit house profiles');
  const h = await one<any>(db, 'UPDATE houses SET about=$2, motto=$3 WHERE id=$1 RETURNING name', [id, input.about?.trim() || null, input.motto?.trim() || null]);
  await audit(db, actor, 'Updated house profile', id, h.name);
}

/* ───────── pledges: who promised what, and how much of it has been paid (same rule as each member's statement) */
export async function pledgeList(db: Db | any, actor: Actor, house = '', search = '', status = '', sort = 'recent') {
  need(actor, 'dir', 'view pledges');
  const show = await seesAmounts(db, actor);
  const rows = await q<any>(db, `
    WITH paid AS (SELECT member_id, sum(amount_ghs) paid, max(paid_on) last_paid FROM payments WHERE status='verified' AND category='member' GROUP BY member_id)
    SELECT m.id, m.member_no, m.full_name, hm.house_id, pl.amount pledged, pl.instalments, pl.created_at pledged_at,
      (pl.replaces IS NOT NULL) adjusted, coalesce(pd.paid, 0)::bigint paid, pd.last_paid
    FROM pledges pl JOIN members m ON m.id=pl.member_id
    JOIN house_memberships hm ON hm.member_id=m.id AND hm.valid_to IS NULL
    LEFT JOIN paid pd ON pd.member_id=m.id
    WHERE pl.status='active' AND ($1 = '' OR hm.house_id=$1)
      AND ($2 = '' OR (m.full_name || ' ' || m.member_no) ILIKE '%' || $2 || '%')`, [house, search]);
  const out = rows.map((r: any) => {
    const pledged = Number(r.pledged), paid = Number(r.paid), outstanding = Math.max(0, pledged - paid);
    const state = paid >= pledged ? 'fulfilled' : paid > 0 ? 'part_paid' : 'not_started';
    return { member_no: r.member_no, full_name: r.full_name, house_id: r.house_id, instalments: r.instalments, pledged_at: r.pledged_at, adjusted: r.adjusted, last_paid: r.last_paid, state,
      pledged: show || r.id === actor.memberId ? pledged : null, paid: show || r.id === actor.memberId ? paid : null, outstanding: show || r.id === actor.memberId ? outstanding : null,
      progress: pledged ? Math.min(1, paid / pledged) : 0, _p: pledged, _o: outstanding };
  }).filter((r) => !status || r.state === status);
  const key: Record<string, (a: any, b: any) => number> = {
    recent: (a, b) => +new Date(b.pledged_at) - +new Date(a.pledged_at),
    amount: (a, b) => b._p - a._p, outstanding: (a, b) => b._o - a._o, name: (a, b) => a.full_name.localeCompare(b.full_name),
    progress: (a, b) => a.progress - b.progress,
  };
  out.sort(key[show ? sort : sort === 'amount' || sort === 'outstanding' ? 'recent' : sort] ?? key.recent);
  const all = rows.map((r: any) => ({ p: Number(r.pledged), paid: Number(r.paid) }));
  const [{ members }] = await q<any>(db, `SELECT count(*)::int members FROM house_memberships WHERE valid_to IS NULL AND ($1 = '' OR house_id=$1)`, [house]);
  return {
    amountsShown: show,
    summary: { pledgers: rows.length, members, totalPledged: all.reduce((s, x) => s + x.p, 0), paidAgainst: all.reduce((s, x) => s + Math.min(x.p, x.paid), 0),
      outstanding: all.reduce((s, x) => s + Math.max(0, x.p - x.paid), 0), fulfilled: all.filter((x) => x.paid >= x.p).length },
    rows: out.map(({ _p, _o, ...r }) => r),
  };
}
