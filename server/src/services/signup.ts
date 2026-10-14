/** Self sign-up: a classmate requests access from the sign-in page; an administrator approves or declines. */
import { z } from 'zod';
import { Actor, Db, q, one, need, audit, notify, conflict, invalid, hashPassword } from '../lib.js';
import { normaliseGhanaPhone } from './messaging.js';
import { nextMemberNo } from './accounts.js';

export const SignupInput = z.object({
  fullName: z.string().trim().min(3, 'Enter your full name.').max(120),
  email: z.string().trim().email('Enter a valid email address.').max(200),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  houseId: z.string().regex(/^H[1-8]$/, 'Choose your house.'),
  city: z.string().trim().max(80).optional().or(z.literal('')),
  profession: z.string().trim().max(80).optional().or(z.literal('')),
  note: z.string().trim().max(500).optional().or(z.literal('')),
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
  website: z.string().max(0).optional(),   // honeypot: real people leave this empty
});
export async function requestSignup(db: Db, input: z.infer<typeof SignupInput>, ip?: string) {
  const email = input.email.toLowerCase();
  // Same answer whether or not the email already has an account, so accounts can't be discovered.
  if ((await q(db, 'SELECT 1 FROM users WHERE email=$1', [email])).length) return { ok: true };
  if ((await q(db, `SELECT 1 FROM signup_requests WHERE email=$1 AND status='pending'`, [email])).length) return { ok: true };
  const [{ n }] = await q<any>(db, `SELECT count(*)::int n FROM signup_requests WHERE status='pending'`);
  if (n >= 1000) throw conflict('Sign-up is temporarily paused. Please contact the committee.');
  await db.query(`INSERT INTO signup_requests (full_name, email, phone, house_id, city, profession, note, password_hash, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.fullName, email, normaliseGhanaPhone(input.phone || undefined) ?? (input.phone || null), input.houseId, input.city || null, input.profession || null, input.note || null, await hashPassword(input.password), ip ?? null]);
  await notify(db, 'perm:admin.members', ['in_app'], `New sign-up request from ${input.fullName} (${email}). Review it under Administration → Sign-up requests.`);
  return { ok: true };
}

export async function listSignups(db: Db | any, actor: Actor, status = 'pending') {
  need(actor, 'admin.members', 'review sign-ups');
  return q(db, `SELECT s.id, s.full_name, s.email, s.phone, s.house_id, s.city, s.profession, s.note, s.status, s.created_at, s.decided_at, s.decision_note, s.member_no, u.display_name decided_by
    FROM signup_requests s LEFT JOIN users u ON u.id=s.decided_by WHERE s.status=$1 ORDER BY s.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`, [status]);
}

export const DecisionInput = z.object({ approve: z.boolean(), houseId: z.string().regex(/^H[1-8]$/).optional(), note: z.string().max(300).optional() });
export async function decideSignup(db: Db, actor: Actor, id: number, input: z.infer<typeof DecisionInput>) {
  need(actor, 'admin.members', 'review sign-ups');
  const s = await one<any>(db, `SELECT * FROM signup_requests WHERE id=$1 FOR UPDATE`, [id]);
  if (s.status !== 'pending') throw conflict(`This request was already ${s.status}.`);
  if (!input.approve) {
    await db.query(`UPDATE signup_requests SET status='rejected', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1`, [id, actor.userId, input.note ?? null]);
    await audit(db, actor, 'Declined sign-up', s.email, input.note ?? '');
    return { status: 'rejected' };
  }
  if ((await q(db, 'SELECT 1 FROM users WHERE email=$1', [s.email])).length) throw conflict('An account with this email already exists. Decline this request.');
  const houseId = input.houseId ?? s.house_id;
  const memberNo = await nextMemberNo(db);
  const u = await one<any>(db, 'INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id', [s.email, s.password_hash, s.full_name]);
  await db.query(`INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1,'member',$2)`, [u.id, actor.userId]);
  const m = await one<any>(db, `INSERT INTO members (member_no, user_id, full_name, email, phone, city, profession, verified_at, verified_by) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8) RETURNING id`,
    [memberNo, u.id, s.full_name, s.email, s.phone, s.city, s.profession, actor.userId]);
  await db.query(`INSERT INTO house_memberships (member_id, house_id, valid_from, reason, changed_by) VALUES ($1,$2,'2000-01-01','Approved sign-up',$3)`, [m.id, houseId, actor.userId]);
  await db.query(`UPDATE signup_requests SET status='approved', decided_by=$2, decided_at=now(), decision_note=$3, member_no=$4, house_id=$5 WHERE id=$1`, [id, actor.userId, input.note ?? null, memberNo, houseId]);
  await notify(db, 'member:' + m.id, ['in_app', 'email', 'sms'], `Ɔdadeɛ 2003: welcome! Your Class of 2003 Legacy account is approved. Sign in with ${s.email} and the password you chose.`);
  await audit(db, actor, 'Approved sign-up', memberNo, `${s.full_name} · ${houseId}`);
  return { status: 'approved', memberNo };
}

/** Used at sign-in so a waiting or declined applicant gets a clear message instead of "incorrect password". */
export async function signupState(db: Db | any, email: string) {
  const [s] = await q<any>(db, `SELECT status FROM signup_requests WHERE email=$1 ORDER BY created_at DESC LIMIT 1`, [email]);
  return s?.status as 'pending' | 'rejected' | 'approved' | undefined;
}
