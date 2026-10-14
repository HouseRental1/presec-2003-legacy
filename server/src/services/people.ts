/** One classmate's page: details, giving, pledge, access. Super admins can edit and remove. */
import { z } from 'zod';
import { Actor, Db, q, one, need, audit, conflict, invalid, forbid, perms, accessOf, today, STAFF_ROLES } from '../lib.js';
import { normaliseGhanaPhone } from './messaging.js';
import { amountsVisibility } from './competition.js';

export async function person(db: Db | any, actor: Actor, memberNo: string) {
  need(actor, 'dir', 'view classmates');
  const [m] = await q<any>(db, `SELECT m.*, u.email user_email, u.status user_status, u.id uid,
      (SELECT house_id FROM house_memberships WHERE member_id=m.id ORDER BY valid_to IS NULL DESC, valid_from DESC LIMIT 1) house_id
    FROM members m LEFT JOIN users u ON u.id=m.user_id WHERE m.member_no=$1`, [memberNo.toUpperCase()]);
  if (!m) throw invalid('No classmate with that member number.');
  const p = perms(actor), admin = p.has('admin.members'), self = m.id === actor.memberId;
  const show = self || p.has('fin.view') || (await amountsVisibility(db)) === 'members';
  const payments = await q<any>(db, `SELECT paid_on, amount_ghs, channel, network, source, status, receipt_no FROM payments WHERE member_id=$1 AND status IN ('verified','pending') ORDER BY paid_on DESC, created_at DESC LIMIT 100`, [m.id]);
  const [pl] = await q<any>(db, `SELECT amount, instalments, created_at FROM pledges WHERE member_id=$1 AND status='active'`, [m.id]);
  const paid = payments.filter((x) => x.status === 'verified').reduce((s, x) => s + Number(x.amount_ghs), 0);
  const roles = m.uid ? (await q<any>(db, 'SELECT role FROM user_roles WHERE user_id=$1', [m.uid])).map((r) => r.role) : [];
  const captainOf = m.uid ? (await q<any>(db, 'SELECT house_id FROM house_captains WHERE user_id=$1', [m.uid])).map((r) => r.house_id) : [];
  return {
    member_no: m.member_no, full_name: m.full_name, house_id: m.house_id, city: m.city, profession: m.profession, joined: m.created_at,
    removed: m.removed_at ? { at: m.removed_at, reason: m.removed_reason } : null,
    access: m.uid ? accessOf(roles) : 'none', captain_of: captainOf,
    contact: admin || self ? { email: m.user_email ?? m.email, phone: m.phone, account: m.uid ? m.user_status : 'none' } : null,
    amountsShown: show,
    giving: { paid: show ? paid : null, payments: payments.filter((x) => x.status === 'verified').length, last_paid: payments.find((x) => x.status === 'verified')?.paid_on ?? null,
      pledge: pl ? { amount: show ? Number(pl.amount) : null, instalments: pl.instalments, since: pl.created_at, outstanding: show ? Math.max(0, Number(pl.amount) - paid) : null } : null },
    payments: show ? payments : [],
    can: { edit: p.has('super.manage'), remove: p.has('super.manage') && !self },
  };
}

export const PersonEdit = z.object({
  fullName: z.string().trim().min(3, 'Enter the full name.').max(120),
  email: z.string().trim().email('Enter a valid email.').max(200).optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  city: z.string().trim().max(80).optional().or(z.literal('')),
  profession: z.string().trim().max(80).optional().or(z.literal('')),
  houseId: z.string().regex(/^H[1-8]$/),
  houseReason: z.string().trim().max(200).optional().or(z.literal('')),
});
export async function editPerson(db: Db, actor: Actor, memberNo: string, input: z.infer<typeof PersonEdit>) {
  need(actor, 'super.manage', 'edit classmates');
  const m = await one<any>(db, 'SELECT * FROM members WHERE member_no=$1 FOR UPDATE', [memberNo.toUpperCase()]);
  if (m.removed_at) throw conflict('This classmate was removed. Restore them first.');
  const email = input.email ? input.email.toLowerCase() : null;
  const changes: string[] = [];
  if (email !== (m.email ?? null)) {
    if (email && (await q(db, 'SELECT 1 FROM users WHERE email=$1 AND id IS DISTINCT FROM $2', [email, m.user_id])).length) throw conflict('Another account already uses that email.');
    if (m.user_id) {
      if (!email) throw invalid('This classmate can sign in, so they need an email address.');
      await db.query('UPDATE users SET email=$2 WHERE id=$1', [m.user_id, email]);
      await db.query('DELETE FROM sessions WHERE user_id=$1', [m.user_id]);
    }
    changes.push('email');
  }
  const phone = input.phone ? normaliseGhanaPhone(input.phone) ?? input.phone : null;
  await db.query('UPDATE members SET full_name=$2, email=$3, phone=$4, city=$5, profession=$6 WHERE id=$1', [m.id, input.fullName, email, phone, input.city || null, input.profession || null]);
  if (m.user_id) await db.query('UPDATE users SET display_name=$2 WHERE id=$1', [m.user_id, input.fullName]);
  for (const [k, a, b] of [['name', m.full_name, input.fullName], ['phone', m.phone, phone], ['city', m.city, input.city || null], ['profession', m.profession, input.profession || null]] as const) if ((a ?? null) !== (b ?? null)) changes.push(k);
  const cur = await one<any>(db, 'SELECT * FROM house_memberships WHERE member_id=$1 AND valid_to IS NULL FOR UPDATE', [m.id]);
  if (cur.house_id !== input.houseId) {
    // A correction of the record: the new house applies from the start, so all their giving counts for it.
    await db.query('UPDATE house_memberships SET house_id=$2, reason=$3, changed_by=$4 WHERE id=$1', [cur.id, input.houseId, `Corrected: ${input.houseReason || 'house record fixed'}`, actor.userId]);
    changes.push(`house ${cur.house_id} → ${input.houseId}`);
  }
  await audit(db, actor, 'Edited classmate', m.member_no, changes.join(', ') || 'no change');
  return { changed: changes };
}

export const RemoveInput = z.object({ reason: z.string().trim().min(3, 'Give a short reason, for the record.').max(300) });
export async function removePerson(db: Db, actor: Actor, memberNo: string, input: z.infer<typeof RemoveInput>) {
  need(actor, 'super.manage', 'remove classmates');
  const m = await one<any>(db, 'SELECT * FROM members WHERE member_no=$1 FOR UPDATE', [memberNo.toUpperCase()]);
  if (m.id === actor.memberId || (m.user_id && m.user_id === actor.userId)) throw forbid('You cannot remove yourself.');
  if (m.removed_at) throw conflict('Already removed.');
  if (m.user_id && (await q(db, `SELECT 1 FROM user_roles WHERE user_id=$1 AND role='superadmin'`, [m.user_id])).length)
    throw conflict('This person is a super admin. Change their access to member first.');
  // Try a complete delete (only possible when nothing refers to them); otherwise archive.
  await db.query('SAVEPOINT rm');
  try {
    await db.query('DELETE FROM house_memberships WHERE member_id=$1', [m.id]);
    await db.query('DELETE FROM members WHERE id=$1', [m.id]);
    if (m.user_id) for (const t of ['sessions', 'account_tokens', 'user_roles', 'house_captains']) await db.query(`DELETE FROM ${t} WHERE user_id=$1`, [m.user_id]);
    if (m.user_id) await db.query('DELETE FROM users WHERE id=$1', [m.user_id]);
    await db.query('RELEASE SAVEPOINT rm');
    await audit(db, actor, 'Deleted classmate', m.member_no, `${m.full_name}: ${input.reason}`);
    return { outcome: 'deleted' };
  } catch {
    await db.query('ROLLBACK TO SAVEPOINT rm');
  }
  await db.query(`UPDATE house_memberships SET valid_to=greatest(valid_from, $2::date) WHERE member_id=$1 AND valid_to IS NULL`, [m.id, today()]);
  await db.query('UPDATE members SET removed_at=now(), removed_by=$2, removed_reason=$3, show_on_wall=false WHERE id=$1', [m.id, actor.userId, input.reason]);
  if (m.user_id) {
    await db.query(`UPDATE users SET status='suspended' WHERE id=$1`, [m.user_id]);
    await db.query(`DELETE FROM user_roles WHERE user_id=$1 AND role = ANY($2)`, [m.user_id, STAFF_ROLES]);
    for (const t of ['sessions', 'house_captains']) await db.query(`DELETE FROM ${t} WHERE user_id=$1`, [m.user_id]);
  }
  await db.query(`UPDATE pledges SET status='cancelled' WHERE member_id=$1 AND status='active'`, [m.id]);
  await audit(db, actor, 'Removed classmate', m.member_no, `${m.full_name}: ${input.reason} (archived; history kept)`);
  return { outcome: 'archived' };
}

export async function restorePerson(db: Db, actor: Actor, memberNo: string) {
  need(actor, 'super.manage', 'restore classmates');
  const m = await one<any>(db, 'SELECT * FROM members WHERE member_no=$1 FOR UPDATE', [memberNo.toUpperCase()]);
  if (!m.removed_at) throw conflict('This classmate is not removed.');
  const last = await one<any>(db, 'SELECT house_id FROM house_memberships WHERE member_id=$1 ORDER BY valid_from DESC, id DESC LIMIT 1', [m.id]);
  await db.query(`INSERT INTO house_memberships (member_id, house_id, valid_from, reason, changed_by) VALUES ($1,$2,$3,'Restored',$4)`, [m.id, last.house_id, today(), actor.userId]);
  await db.query('UPDATE members SET removed_at=NULL, removed_by=NULL, removed_reason=NULL WHERE id=$1', [m.id]);
  if (m.user_id) await db.query(`UPDATE users SET status='active' WHERE id=$1`, [m.user_id]);
  await audit(db, actor, 'Restored classmate', m.member_no, m.full_name);
}
