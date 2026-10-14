import { z } from 'zod';
import { Actor, Db, q, one, need, audit, conflict, invalid, hashPassword, verifyPassword, newToken, sha256, config, verifyTotp, PRIVILEGED, Role, AppError, newTotpSecret, forbid, pool } from '../lib.js';

/* ───────── sessions */
export async function login(db: Db, email: string, password: string, code?: string, ip?: string) {
  const e = email.trim().toLowerCase();
  // Throttle by account across all server instances: 8 failures in 15 minutes locks sign-in for that email.
  const [{ n: recent }] = await q<any>(db, `SELECT count(*)::int n FROM login_failures WHERE email=$1 AND at > now() - interval '15 minutes'`, [e]);
  if (recent >= 8) throw new AppError(429, 'locked', 'Too many failed attempts. Wait 15 minutes or reset your password.');
  const [u] = await q<any>(db, 'SELECT * FROM users WHERE email=$1', [e]);
  // Same message for unknown email and wrong password, so accounts can't be discovered.
  if (!u || !(await verifyPassword(password, u.password_hash))) {
    await pool.query('INSERT INTO login_failures (email, ip) VALUES ($1,$2)', [e, ip ?? null]); // outside the transaction so it survives the rollback
    throw new AppError(401, 'bad_login', 'Email or password is incorrect.');
  }
  if (u.status !== 'active') throw new AppError(403, 'suspended', 'This account is suspended. Contact the membership administrator.');
  const roles = (await q<any>(db, 'SELECT role FROM user_roles WHERE user_id=$1 AND (expires_at IS NULL OR expires_at > now())', [u.id])).map((r) => r.role as Role);
  const privileged = roles.some((r) => PRIVILEGED.includes(r));
  let mfa = false;
  const secret: string | null = u.totp_secret && !u.totp_secret.startsWith('PENDING:') ? u.totp_secret : null;
  if (secret && code) { if (!verifyTotp(secret, code)) throw new AppError(401, 'bad_code', 'That authenticator code is not valid. Try the next one.'); mfa = true; }
  if (config.requireMfa && privileged && secret && !code) throw new AppError(401, 'mfa_required', 'Enter the 6-digit code from your authenticator app.');
  const token = newToken();
  await db.query(`INSERT INTO sessions (token_hash, user_id, mfa_passed, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4))`, [sha256(token), u.id, mfa, config.sessionHours]);
  await audit(db, { userId: u.id, name: u.display_name, roles, memberId: null, mfaPassed: mfa }, 'Signed in', u.email, mfa ? 'with authenticator' : 'password only');
  return { token, user: { id: u.id, name: u.display_name, roles, mfa, needsMfaEnrolment: config.requireMfa && privileged && !secret } };
}
export async function actorFromToken(db: Db | any, token: string | undefined) {
  if (!token) return null;
  const [s] = await q<any>(db, `SELECT s.user_id, s.mfa_passed, u.display_name, u.status, m.id member_id FROM sessions s JOIN users u ON u.id=s.user_id
    LEFT JOIN members m ON m.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at > now()`, [sha256(token)]);
  if (!s || s.status !== 'active') return null;
  const roles = (await q<any>(db, 'SELECT role FROM user_roles WHERE user_id=$1 AND (expires_at IS NULL OR expires_at > now())', [s.user_id])).map((r) => r.role as Role);
  // Voting and event replies are open to members only when the administrators switch member participation on.
  const [part] = await q<any>(db, `SELECT value FROM settings WHERE key='member_participation'`);
  const extra = part?.value === true && roles.includes('member') ? ['vote', 'rsvp'] : [];
  return { userId: s.user_id, name: s.display_name, roles, memberId: s.member_id, mfaPassed: s.mfa_passed, extra } as Actor;
}
export async function logout(db: Db, token: string) { await db.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(token)]); }

export async function startMfaEnrolment(db: Db, actor: Actor) {
  const [u] = await q<any>(db, 'SELECT email, totp_secret FROM users WHERE id=$1', [actor.userId]);
  if (u.totp_secret && !u.totp_secret.startsWith('PENDING:')) throw conflict('Two-factor sign-in is already set up.');
  const secret = newTotpSecret();
  await db.query('UPDATE users SET totp_secret=$2 WHERE id=$1', [actor.userId, 'PENDING:' + secret]);
  return { secret, otpauth: `otpauth://totp/Class%20Legacy:${encodeURIComponent(u.email)}?secret=${secret}&issuer=Class%20Legacy` };
}
export async function confirmMfaEnrolment(db: Db, actor: Actor, code: string) {
  const [u] = await q<any>(db, 'SELECT totp_secret FROM users WHERE id=$1', [actor.userId]);
  if (!u.totp_secret?.startsWith('PENDING:')) throw conflict('Start set-up first.');
  const secret = u.totp_secret.slice(8);
  if (!verifyTotp(secret, code)) throw invalid('That code is not valid. Check the time on your phone and try again.');
  await db.query('UPDATE users SET totp_secret=$2 WHERE id=$1', [actor.userId, secret]);
  await audit(db, actor, 'Enabled two-factor sign-in', actor.userId);
}

/* ───────── members & houses */
export const RegisterInput = z.object({ fullName: z.string().min(3), memberNo: z.string().regex(/^P03-\d{4}$/), houseId: z.string(), email: z.string().email().optional(), password: z.string().min(10).optional(), city: z.string().optional(), profession: z.string().optional() });
export async function registerMember(db: Db, actor: Actor, input: z.infer<typeof RegisterInput>) {
  need(actor, 'admin.members', 'register members');
  let userId: string | null = null;
  if (input.email && input.password) {
    const [u] = await q<any>(db, 'INSERT INTO users (email, password_hash, display_name) VALUES (lower($1),$2,$3) RETURNING id', [input.email, await hashPassword(input.password), input.fullName]);
    userId = u.id; await db.query(`INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1,'member',$2)`, [userId, actor.userId]);
  }
  try {
    const [m] = await q<any>(db, 'INSERT INTO members (member_no, user_id, full_name, city, profession) VALUES ($1,$2,$3,$4,$5) RETURNING id', [input.memberNo, userId, input.fullName, input.city ?? null, input.profession ?? null]);
    await db.query(`INSERT INTO house_memberships (member_id, house_id, valid_from, reason, changed_by) VALUES ($1,$2,'2000-01-01','Registered from school records',$3)`, [m.id, input.houseId, actor.userId]);
    await audit(db, actor, 'Registered member', input.memberNo);
    return { id: m.id };
  } catch (e: any) { if (e.code === '23505') throw conflict('That member number or email is already registered.'); throw e; }
}
export async function verifyMember(db: Db, actor: Actor, memberNo: string) {
  need(actor, 'admin.members', 'confirm members');
  const m = await one<any>(db, 'SELECT * FROM members WHERE member_no=$1 FOR UPDATE', [memberNo]);
  if (m.verified_at) throw conflict('Already confirmed.');
  await db.query('UPDATE members SET verified_at=now(), verified_by=$2 WHERE id=$1', [m.id, actor.userId]);
  await audit(db, actor, 'Confirmed member registration', memberNo);
}
export const HouseFix = z.object({ houseId: z.string(), validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().min(5) });
/** Effective-dated correction: earlier payments stay with the earlier house. Captains cannot do this. */
export async function correctHouse(db: Db, actor: Actor, memberNo: string, input: z.infer<typeof HouseFix>) {
  need(actor, 'admin.members', 'correct house records');
  const m = await one<any>(db, 'SELECT id FROM members WHERE member_no=$1', [memberNo]);
  const cur = await one<any>(db, 'SELECT * FROM house_memberships WHERE member_id=$1 AND valid_to IS NULL FOR UPDATE', [m.id]);
  if (cur.house_id === input.houseId) throw invalid('Member is already in that house.');
  if (input.validFrom <= cur.valid_from) throw invalid('The correction must start after the current record began.');
  const to = new Date(input.validFrom + 'T00:00:00Z'); to.setUTCDate(to.getUTCDate() - 1);
  await db.query('UPDATE house_memberships SET valid_to=$2 WHERE id=$1', [cur.id, to.toISOString().slice(0, 10)]);
  await db.query('INSERT INTO house_memberships (member_id, house_id, valid_from, reason, changed_by) VALUES ($1,$2,$3,$4,$5)', [m.id, input.houseId, input.validFrom, input.reason, actor.userId]);
  await audit(db, actor, 'Corrected house record', memberNo, `${cur.house_id} → ${input.houseId} from ${input.validFrom}: ${input.reason}`);
}
export async function grantRole(db: Db, actor: Actor, userId: string, role: Role, expiresAt?: string) {
  need(actor, 'admin.members', 'grant roles');
  if (role === 'admin') {
    const cap = (await one<any>(db, `SELECT value FROM settings WHERE key='admin_cap'`)).value as number;
    const [{ n }] = await q<any>(db, `SELECT count(*)::int n FROM user_roles WHERE role='admin' AND (expires_at IS NULL OR expires_at > now())`);
    if (n >= cap) throw conflict(`There are already ${n} administrators (limit ${cap}).`);
  }
  if (userId === actor.userId) throw forbid('You cannot change your own roles.');
  await db.query('INSERT INTO user_roles (user_id, role, granted_by, expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, role) DO NOTHING', [userId, role, actor.userId, expiresAt ?? null]);
  await audit(db, actor, 'Granted role', userId, role + (expiresAt ? ` until ${expiresAt}` : ''));
}

export async function directory(db: Db | any, actor: Actor, search = '', house = '', page = 0) {
  need(actor, 'dir', 'view the directory');
  const admin = actor.roles.includes('admin');
  const rows = await q<any>(db, `SELECT m.member_no, m.full_name, m.city, m.profession, hm.house_id ${admin ? ', m.verified_at IS NOT NULL verified' : ''}
    FROM members m JOIN house_memberships hm ON hm.member_id=m.id AND hm.valid_to IS NULL
    WHERE ($1 = '' OR (m.full_name || ' ' || m.member_no || ' ' || coalesce(m.city,'') || ' ' || coalesce(m.profession,'')) ILIKE '%' || $1 || '%')
      AND ($2 = '' OR hm.house_id = $2)
    ORDER BY m.member_no LIMIT 30 OFFSET $3`, [search, house, page * 30]);
  const [{ n }] = await q<any>(db, `SELECT count(*)::int n FROM members m JOIN house_memberships hm ON hm.member_id=m.id AND hm.valid_to IS NULL
    WHERE ($1 = '' OR (m.full_name || ' ' || m.member_no || ' ' || coalesce(m.city,'') || ' ' || coalesce(m.profession,'')) ILIKE '%' || $1 || '%') AND ($2 = '' OR hm.house_id = $2)`, [search, house]);
  return { rows, total: n };
}
