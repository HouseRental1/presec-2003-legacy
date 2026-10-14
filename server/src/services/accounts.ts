/** Invitations, password reset, profile and role management. */
import { z } from 'zod';
import { Actor, Db, q, one, need, audit, notify, conflict, invalid, forbid, hashPassword, verifyPassword, newToken, sha256, config, Role, AppError, ADMIN_BUNDLE, SUPER_BUNDLE, STAFF_ROLES, accessOf, perms } from '../lib.js';
import { normaliseGhanaPhone } from './messaging.js';

const PASSWORD = z.string().min(10, 'Use at least 10 characters.').max(200);

async function issueToken(db: Db, userId: string, purpose: 'invite' | 'reset', hours: number) {
  const token = newToken();
  await db.query(`INSERT INTO account_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4))`, [sha256(token), userId, purpose, hours]);
  return `${config.appUrl}/set-password?token=${token}`;
}

/** Next free member number in the P03-0001 series. */
export async function nextMemberNo(db: Db) {
  const [r] = await q<any>(db, `SELECT coalesce(max(substring(member_no from '^P03-(\\d+)$')::int), 0) + 1 n FROM members WHERE member_no ~ '^P03-\\d+$'`);
  return 'P03-' + String(r.n).padStart(4, '0');
}

/* ───────── add one classmate from the Houses page (or link the signed-in user to their house) */
export const AddClassmateInput = z.object({
  fullName: z.string().min(3, 'Enter the full name.').max(120), houseId: z.string(), isMe: z.boolean().default(false),
  email: z.string().email().optional().or(z.literal('')), phone: z.string().max(30).optional(), city: z.string().max(80).optional(), profession: z.string().max(80).optional(),
  memberNo: z.string().max(20).optional().or(z.literal('')), sendInvite: z.boolean().default(true),
});
export async function addClassmate(db: Db, actor: Actor, input: z.infer<typeof AddClassmateInput>) {
  need(actor, 'admin.members', 'add classmates');
  if (input.isMe) {
    if (actor.memberId) throw conflict('You are already on the register.');
    if (!(await q(db, 'SELECT 1 FROM houses WHERE id=$1', [input.houseId])).length) throw invalid('Choose one of the eight houses.');
    const memberNo = input.memberNo || await nextMemberNo(db);
    const u = await one<any>(db, 'SELECT email FROM users WHERE id=$1', [actor.userId]);
    let m: any;
    try {
      m = await one<any>(db, 'INSERT INTO members (member_no, user_id, full_name, email, phone, city, profession, verified_at, verified_by) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$2) RETURNING id',
        [memberNo, actor.userId, input.fullName, u.email, normaliseGhanaPhone(input.phone) ?? input.phone ?? null, input.city ?? null, input.profession ?? null]);
    } catch (e: any) { if (e.code === '23505') throw conflict('That member number is already used.'); throw e; }
    await db.query(`INSERT INTO house_memberships (member_id, house_id, valid_from, reason, changed_by) VALUES ($1,$2,'2000-01-01','Added themselves to the register',$3)`, [m.id, input.houseId, actor.userId]);
    await db.query(`INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1,'member',$1) ON CONFLICT DO NOTHING`, [actor.userId]);
    await db.query('UPDATE users SET display_name=$2 WHERE id=$1', [actor.userId, input.fullName]);
    await audit(db, actor, 'Joined the register', memberNo, input.houseId);
    return { memberNo, invited: false };
  }
  const r = await importMembers(db, actor, { rows: [{ memberNo: input.memberNo || undefined, fullName: input.fullName, houseId: input.houseId, email: input.email, phone: input.phone, city: input.city, profession: input.profession }], sendInvites: input.sendInvite });
  if (r.skipped.length) throw conflict(`Not added: ${r.skipped[0].reason}.`);
  return { memberNo: r.memberNos[0], invited: !!input.email && input.sendInvite, link: r.invites[0]?.link ?? null, delivery: inviteDelivery() };
}

/* ───────── bulk import of the year-group register, with invitations */
export const ImportMembersInput = z.object({ rows: z.array(z.object({
  memberNo: z.string().min(3).max(20).optional().or(z.literal('')), fullName: z.string().min(3), houseId: z.string(), email: z.string().email().optional().or(z.literal('')),
  phone: z.string().optional(), city: z.string().optional(), profession: z.string().optional(),
})).min(1).max(1500), sendInvites: z.boolean().default(true) });
export async function importMembers(db: Db, actor: Actor, input: z.infer<typeof ImportMembersInput>) {
  need(actor, 'admin.members', 'import members');
  const houses = new Set((await q<any>(db, 'SELECT id FROM houses')).map((h) => h.id));
  const created: string[] = [], skipped: { memberNo: string; reason: string }[] = [], invites: { memberNo: string; name: string; link: string }[] = [];
  for (const r of input.rows) {
    if (!r.memberNo) r.memberNo = await nextMemberNo(db);
    if (!houses.has(r.houseId)) { skipped.push({ memberNo: r.memberNo!, reason: 'unknown house ' + r.houseId }); continue; }
    if ((await q(db, 'SELECT 1 FROM members WHERE member_no=$1', [r.memberNo])).length) { skipped.push({ memberNo: r.memberNo!, reason: 'already registered' }); continue; }
    const email = r.email ? r.email.toLowerCase() : null;
    let userId: string | null = null;
    if (email) {
      if ((await q(db, 'SELECT 1 FROM users WHERE email=$1', [email])).length) { skipped.push({ memberNo: r.memberNo!, reason: 'email already used' }); continue; }
      // Unusable random password until the member accepts the invitation.
      userId = (await one<any>(db, 'INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id', [email, await hashPassword(newToken()), r.fullName])).id;
      await db.query(`INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1,'member',$2)`, [userId, actor.userId]);
    }
    const [m] = await q<any>(db, 'INSERT INTO members (member_no, user_id, full_name, email, phone, city, profession) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [r.memberNo!, userId, r.fullName, email, normaliseGhanaPhone(r.phone) ?? r.phone ?? null, r.city ?? null, r.profession ?? null]);
    await db.query(`INSERT INTO house_memberships (member_id, house_id, valid_from, reason, changed_by) VALUES ($1,$2,'2000-01-01','Imported from year-group register',$3)`, [m.id, r.houseId, actor.userId]);
    if (userId && input.sendInvites) {
      const link = await issueToken(db, userId, 'invite', 24 * 14);
      await notify(db, 'member:' + m.id, ['email', 'sms'], `Ɔdadeɛ 2003: you are invited to the Class of 2003 Legacy platform. Set your password here (link valid 14 days): ${link}`, 'security');
      invites.push({ memberNo: r.memberNo!, name: r.fullName, link });   // shown to the administrator so it can also be shared directly (e.g. WhatsApp)
    }
    created.push(r.memberNo!);
  }
  await audit(db, actor, 'Imported members', `${created.length} members`, `${skipped.length} skipped`);
  return { created: created.length, skipped, memberNos: created, invites, delivery: inviteDelivery() };
}
export async function resendInvite(db: Db, actor: Actor, memberNo: string) {
  need(actor, 'admin.members', 'send invitations');
  const m = await one<any>(db, 'SELECT id, user_id FROM members WHERE member_no=$1', [memberNo]);
  if (!m.user_id) throw conflict('This member has no email address on record.');
  const link = await issueToken(db, m.user_id, 'invite', 24 * 14);
  await notify(db, 'member:' + m.id, ['email', 'sms'], `Ɔdadeɛ 2003: set your Class of 2003 Legacy password here (valid 14 days): ${link}`, 'security');
  await audit(db, actor, 'Sent invitation', memberNo);
  return { link, delivery: inviteDelivery() };
}
/** Whether invitations actually leave the platform by email/SMS, or must be shared by hand. */
export const inviteDelivery = () => ({ email: config.emailProvider !== 'log', sms: config.smsProvider !== 'log' });

/* ───────── password reset (never reveals whether an email exists) */
export async function forgotPassword(db: Db, email: string) {
  const [u] = await q<any>(db, `SELECT u.id, m.id member_id FROM users u LEFT JOIN members m ON m.user_id=u.id WHERE u.email=lower($1) AND u.status='active'`, [email.trim()]);
  if (u) {
    const link = await issueToken(db, u.id, 'reset', 1);
    await notify(db, u.member_id ? 'member:' + u.member_id : 'email:' + email.trim().toLowerCase(), ['email', 'sms'], `Class of 2003 Legacy password reset (valid 1 hour): ${link} — ignore this if you did not ask.`, 'security');
    await audit(db, null, 'Password reset requested', u.id);
  }
  return { ok: true };
}
export const SetPasswordInput = z.object({ token: z.string().min(20), password: PASSWORD });
export async function setPasswordWithToken(db: Db, input: z.infer<typeof SetPasswordInput>) {
  const [t] = await q<any>(db, 'SELECT * FROM account_tokens WHERE token_hash=$1 FOR UPDATE', [sha256(input.token)]);
  if (!t || t.used_at || new Date(t.expires_at) < new Date()) throw new AppError(400, 'bad_token', 'This link has expired or was already used. Ask for a new one.');
  await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [t.user_id, await hashPassword(input.password)]);
  await db.query('UPDATE account_tokens SET used_at=now() WHERE token_hash=$1', [t.token_hash]);
  await db.query('DELETE FROM sessions WHERE user_id=$1', [t.user_id]);   // sign out everywhere
  await audit(db, null, t.purpose === 'invite' ? 'Accepted invitation' : 'Reset password', t.user_id);
  return { ok: true };
}
export const ChangePasswordInput = z.object({ current: z.string().min(1), next: PASSWORD });
export async function changePassword(db: Db, actor: Actor, input: z.infer<typeof ChangePasswordInput>) {
  const u = await one<any>(db, 'SELECT password_hash FROM users WHERE id=$1', [actor.userId]);
  if (!(await verifyPassword(input.current, u.password_hash))) throw forbid('Your current password is not correct.');
  await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [actor.userId, await hashPassword(input.next)]);
  await audit(db, actor, 'Changed password', actor.userId);
}

/* ───────── profile & preferences */
export const ProfileInput = z.object({ phone: z.string().max(30).optional(), city: z.string().max(80).optional(), profession: z.string().max(120).optional(),
  showOnWall: z.boolean().optional(), smsReminders: z.boolean().optional(), emailUpdates: z.boolean().optional() });
export async function updateProfile(db: Db, actor: Actor, input: z.infer<typeof ProfileInput>) {
  need(actor, 'own', 'edit a profile');
  if (!actor.memberId) throw forbid('Profiles are for members.');
  if (input.phone && !normaliseGhanaPhone(input.phone)) throw invalid('Enter a phone number with country code, e.g. 024 123 4567 or +44 7700 900123.');
  await db.query(`UPDATE members SET phone=coalesce($2,phone), city=coalesce($3,city), profession=coalesce($4,profession), show_on_wall=coalesce($5,show_on_wall),
    sms_reminders=coalesce($6,sms_reminders), email_updates=coalesce($7,email_updates) WHERE id=$1`,
    [actor.memberId, input.phone ? normaliseGhanaPhone(input.phone) : null, input.city ?? null, input.profession ?? null, input.showOnWall ?? null, input.smsReminders ?? null, input.emailUpdates ?? null]);
  await audit(db, actor, 'Updated profile', actor.memberId);
}
export async function profile(db: Db | any, actor: Actor) {
  if (!actor.memberId) return null;
  return one(db, `SELECT m.member_no, m.full_name, m.city, m.profession, m.phone, coalesce(m.email,u.email) email, m.show_on_wall, m.sms_reminders, m.email_updates, hm.house_id
    FROM members m LEFT JOIN users u ON u.id=m.user_id JOIN house_memberships hm ON hm.member_id=m.id AND hm.valid_to IS NULL WHERE m.id=$1`, [actor.memberId]);
}

/* ───────── roles & captains (administrator) */
export async function listStaff(db: Db | any, actor: Actor) {
  need(actor, 'admin.members', 'view roles');
  return q(db, `SELECT u.id, u.email, u.display_name, u.status, u.totp_secret IS NOT NULL AND u.totp_secret NOT LIKE 'PENDING:%' mfa,
      array_agg(r.role ORDER BY r.role) roles, (SELECT array_agg(house_id) FROM house_captains c WHERE c.user_id=u.id) captain_of
    FROM users u JOIN user_roles r ON r.user_id=u.id GROUP BY u.id HAVING array_agg(r.role) <> ARRAY['member']::text[] ORDER BY u.display_name`);
}
export async function revokeRole(db: Db, actor: Actor, userId: string, role: Role) {
  need(actor, 'admin.members', 'revoke roles');
  if (userId === actor.userId) throw forbid('You cannot change your own roles.');
  if (role === 'member') throw invalid('Suspend the account instead of removing membership.');
  await db.query('DELETE FROM user_roles WHERE user_id=$1 AND role=$2', [userId, role]);
  if (role === 'captain') await db.query('DELETE FROM house_captains WHERE user_id=$1', [userId]);
  await db.query('DELETE FROM sessions WHERE user_id=$1', [userId]); // role changes take effect immediately
  await audit(db, actor, 'Revoked role', userId, role);
}
export async function setCaptain(db: Db, actor: Actor, houseId: string, memberNo: string) {
  need(actor, 'admin.members', 'appoint house captains');
  const m = await one<any>(db, 'SELECT user_id FROM members WHERE member_no=$1', [memberNo]);
  if (!m.user_id) throw conflict('The captain needs an account (an email address on record).');
  await db.query(`INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1,'captain',$2) ON CONFLICT DO NOTHING`, [m.user_id, actor.userId]);
  await db.query('DELETE FROM house_captains WHERE house_id=$1', [houseId]);
  await db.query('INSERT INTO house_captains (house_id, user_id) VALUES ($1,$2)', [houseId, m.user_id]);
  await audit(db, actor, 'Appointed house captain', houseId, memberNo);
}
export async function setSuspended(db: Db, actor: Actor, userId: string, suspended: boolean) {
  need(actor, 'admin.members', 'suspend accounts');
  if (userId === actor.userId) throw forbid('You cannot suspend yourself.');
  await db.query('UPDATE users SET status=$2 WHERE id=$1', [userId, suspended ? 'suspended' : 'active']);
  if (suspended) await db.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
  await audit(db, actor, suspended ? 'Suspended account' : 'Restored account', userId);
}

/* ───────── three access levels: Super admin (adds money approvals), Admin (runs everything else, records payments), Member (view-only) */
export const AccessInput = z.object({ who: z.string().min(3, 'Enter a member number or email.'), access: z.enum(['superadmin', 'admin', 'member']) });
export async function setAccess(db: Db, actor: Actor, input: z.infer<typeof AccessInput>) {
  need(actor, 'admin.members', 'change access');
  const who = input.who.trim();
  const u = (await q<any>(db, `SELECT u.id, u.display_name FROM users u LEFT JOIN members m ON m.user_id=u.id WHERE lower(u.email)=lower($1) OR m.member_no=upper($1)`, [who]))[0];
  if (!u) throw invalid('No account found for that member number or email. The classmate needs an account first.');
  if (u.id === actor.userId) throw forbid('You cannot change your own access. Ask another administrator.');
  const current = accessOf((await q<any>(db, 'SELECT role FROM user_roles WHERE user_id=$1', [u.id])).map((r) => r.role));
  if ((current === 'superadmin' || input.access === 'superadmin') && !perms(actor).has('super.manage'))
    throw forbid('Only a super admin can make or change a super admin.');
  if (current === 'superadmin' && input.access !== 'superadmin') {
    const [{ n }] = await q<any>(db, `SELECT count(*)::int n FROM user_roles WHERE role='superadmin' AND user_id<>$1`, [u.id]);
    if (n < 1) throw conflict('The platform must keep at least one super admin.');
  }
  if (current !== 'member' && input.access === 'member') {
    const [{ n }] = await q<any>(db, `SELECT count(*)::int n FROM user_roles WHERE role='admin' AND user_id<>$1`, [u.id]);
    if (n < 1) throw conflict('The platform must keep at least one administrator.');
  }
  if (input.access !== 'member' && current === 'member') {
    const cap = Number((await q<any>(db, `SELECT value FROM settings WHERE key='admin_cap'`))[0]?.value ?? 3);
    const [{ n }] = await q<any>(db, `SELECT count(*)::int n FROM user_roles WHERE role='admin' AND (expires_at IS NULL OR expires_at > now())`);
    if (n >= cap) throw conflict(`There are already ${n} administrators (limit ${cap}). Remove one first.`);
  }
  await db.query(`DELETE FROM user_roles WHERE user_id=$1 AND role = ANY($2)`, [u.id, STAFF_ROLES]);
  const bundle = input.access === 'superadmin' ? SUPER_BUNDLE : input.access === 'admin' ? ADMIN_BUNDLE : [];
  for (const r of [...bundle, 'member']) await db.query('INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1,$2,$3) ON CONFLICT (user_id, role) DO NOTHING', [u.id, r, actor.userId]);
  await db.query('DELETE FROM sessions WHERE user_id=$1', [u.id]);   // takes effect at their next sign-in
  const label = { superadmin: 'super admin', admin: 'admin', member: 'member' }[input.access];
  await audit(db, actor, 'Changed access', u.id, `${u.display_name}: ${current} → ${input.access}`);
  return { name: u.display_name, access: input.access, label };
}
export const ParticipationInput = z.object({ on: z.boolean() });
export async function setParticipation(db: Db, actor: Actor, input: z.infer<typeof ParticipationInput>) {
  need(actor, 'admin.members', 'change member participation');
  await db.query(`INSERT INTO settings (key, value) VALUES ('member_participation', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(input.on)]);
  await audit(db, actor, 'Member voting and event replies', input.on ? 'on' : 'off');
}
