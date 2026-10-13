import { z } from 'zod';
import { Actor, Db, q, one, need, audit, notify, conflict, invalid, today } from '../lib.js';

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
