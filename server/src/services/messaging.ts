/**
 * Message delivery. notify() stores a notice; dispatch() expands its audience into one delivery
 * per recipient and channel, applies preferences, and sends through the configured providers.
 * SMS: 'log' (default, until the committee picks a provider), Arkesel or Hubtel. Email: 'log' or Resend.
 * Runs from the Vercel cron job (GET /api/cron/dispatch) or manually.
 */
import { config, Db, q, AppError, PERMS, Role } from '../lib.js';

export function normaliseGhanaPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && d.length === 10) d = '233' + d.slice(1);
  return /^\d{10,15}$/.test(d) ? d : null;
}

interface Recipient { email: string | null; phone: string | null; smsOk: boolean; emailOk: boolean }
async function recipients(db: Db, audience: string, kind: string): Promise<Recipient[]> {
  const essential = ['payment', 'governance', 'security'].includes(kind);
  const pref = (r: any) => ({ email: r.email, phone: normaliseGhanaPhone(r.phone), smsOk: essential || r.sms_reminders, emailOk: essential || r.email_updates });
  const base = `SELECT coalesce(m.email, u.email) email, m.phone, m.sms_reminders, m.email_updates FROM members m LEFT JOIN users u ON u.id=m.user_id`;
  if (audience === 'all') return (await q(db, base + ` WHERE m.verified_at IS NOT NULL`)).map(pref);
  if (audience.startsWith('member:')) return (await q(db, base + ` WHERE m.id=$1`, [audience.slice(7)])).map(pref);
  if (audience.startsWith('house:')) return (await q(db, base + ` JOIN house_memberships hm ON hm.member_id=m.id AND hm.valid_to IS NULL WHERE hm.house_id=$1 AND m.verified_at IS NOT NULL`, [audience.slice(6)])).map(pref);
  if (audience.startsWith('email:')) return [{ email: audience.slice(6), phone: null, smsOk: false, emailOk: true }];
  if (audience.startsWith('phone:')) return [{ email: null, phone: normaliseGhanaPhone(audience.slice(6)), smsOk: true, emailOk: false }];
  if (audience.startsWith('perm:')) {
    const roles = (Object.entries(PERMS) as [Role, string[]][]).filter(([, p]) => p.includes(audience.slice(5))).map(([r]) => r);
    return (await q(db, `SELECT DISTINCT u.email, m.phone FROM users u JOIN user_roles r ON r.user_id=u.id LEFT JOIN members m ON m.user_id=u.id WHERE r.role = ANY($1) AND u.status='active'`, [roles]))
      .map((r: any) => ({ email: r.email, phone: normaliseGhanaPhone(r.phone), smsOk: true, emailOk: true }));
  }
  return [];
}

/** Turn new notices into queued deliveries (idempotent: UNIQUE per notice/channel/recipient). */
export async function expand(db: Db, max = 2000) {
  const notices = await q<any>(db, `SELECT * FROM notifications WHERE NOT expanded ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [max]);
  let queued = 0;
  for (const n of notices) {
    for (const r of await recipients(db, n.audience, n.kind)) {
      if (n.channels.includes('sms') && r.phone && r.smsOk) queued += (await db.query(`INSERT INTO notification_deliveries (notification_id, channel, recipient) VALUES ($1,'sms',$2) ON CONFLICT DO NOTHING`, [n.id, r.phone])).rowCount ?? 0;
      if (n.channels.includes('email') && r.email && r.emailOk && !r.email.endsWith('.invalid')) queued += (await db.query(`INSERT INTO notification_deliveries (notification_id, channel, recipient) VALUES ($1,'email',$2) ON CONFLICT DO NOTHING`, [n.id, r.email])).rowCount ?? 0;
    }
    await db.query('UPDATE notifications SET expanded=true WHERE id=$1', [n.id]);
  }
  return queued;
}

export interface SendResult { ok: boolean; provider: string; ref?: string; error?: string }
const sent: { channel: string; to: string; text: string }[] = []; // in-memory log (tests and the 'log' provider)
export const outbox = () => sent;

export async function sendSms(to: string, text: string): Promise<SendResult> {
  const body = text.length > 459 ? text.slice(0, 456) + '…' : text; // 3 SMS parts maximum
  if (config.smsProvider === 'log') { sent.push({ channel: 'sms', to, text: body }); return { ok: true, provider: 'log' }; }
  try {
    if (config.smsProvider === 'arkesel') {
      const r = await fetch('https://sms.arkesel.com/api/v2/sms/send', { method: 'POST', headers: { 'api-key': config.arkeselKey, 'content-type': 'application/json' }, body: JSON.stringify({ sender: config.smsSender, message: body, recipients: [to] }), signal: AbortSignal.timeout(15000) });
      const j: any = await r.json().catch(() => ({}));
      return r.ok && j.status === 'success' ? { ok: true, provider: 'arkesel', ref: j.data?.[0]?.id } : { ok: false, provider: 'arkesel', error: j.message ?? r.statusText };
    }
    const u = new URL('https://smsc.hubtel.com/v1/messages/send');
    Object.entries({ clientid: config.hubtelClientId, clientsecret: config.hubtelClientSecret, from: config.smsSender, to, content: body }).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
    const j: any = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, provider: 'hubtel', ref: j.messageId } : { ok: false, provider: 'hubtel', error: j.message ?? r.statusText };
  } catch (e: any) { return { ok: false, provider: config.smsProvider, error: e.message }; }
}
export async function sendEmail(to: string, subject: string, text: string): Promise<SendResult> {
  if (config.emailProvider === 'log') { sent.push({ channel: 'email', to, text }); return { ok: true, provider: 'log' }; }
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${config.resendKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: config.emailFrom, to: [to], subject, text }), signal: AbortSignal.timeout(15000) });
    const j: any = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, provider: 'resend', ref: j.id } : { ok: false, provider: 'resend', error: j.message ?? r.statusText };
  } catch (e: any) { return { ok: false, provider: 'resend', error: e.message }; }
}

/** Send queued deliveries; failures retry up to 3 times on later runs. */
export async function dispatch(db: Db, limit = 500) {
  const expanded = await expand(db);
  const due = await q<any>(db, `SELECT d.*, n.body, n.kind FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id
    WHERE d.status='queued' OR (d.status='failed' AND d.attempts < 3) ORDER BY d.id LIMIT $1 FOR UPDATE OF d SKIP LOCKED`, [limit]);
  let ok = 0, failed = 0;
  for (const d of due) {
    const r = d.channel === 'sms' ? await sendSms(d.recipient, d.body) : await sendEmail(d.recipient, 'Class of 2003 Legacy — ' + (d.kind === 'payment' ? 'payment' : d.kind === 'governance' ? 'vote' : 'update'), d.body + `\n\n${config.appUrl}`);
    await db.query(`UPDATE notification_deliveries SET status=$2, provider=$3, provider_ref=$4, error=$5, attempts=attempts+1, updated_at=now() WHERE id=$1`, [d.id, r.ok ? 'sent' : 'failed', r.provider, r.ref ?? null, r.error ?? null]);
    r.ok ? ok++ : failed++;
  }
  return { expanded, sent: ok, failed };
}

export function checkCron(authHeader: string | undefined) {
  if (!config.cronSecret || authHeader !== `Bearer ${config.cronSecret}`) throw new AppError(401, 'unauthorised', 'Cron secret missing or wrong.');
}
