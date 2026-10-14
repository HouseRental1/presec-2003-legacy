import pg from 'pg';
import { createHash, createHmac, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/* ───────────────────────── config */
export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://legacy:legacy@localhost:5432/class_legacy',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  // On by default in production; REQUIRE_MFA=false switches it off (set-up period only — turn it back on before launch).
  requireMfa: process.env.REQUIRE_MFA ? process.env.REQUIRE_MFA === 'true' : process.env.NODE_ENV === 'production',
  webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev-webhook-secret',
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  loginRateMax: Number(process.env.LOGIN_RATE_MAX ?? 10),   // sign-in attempts per IP per minute
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',          // public URL of the web app (links in messages, payment return)
  paymentProvider: (process.env.PAYMENT_PROVIDER ?? 'sandbox') as 'sandbox' | 'paystack',
  paystackSecret: process.env.PAYSTACK_SECRET_KEY ?? '',
  paystackApi: process.env.PAYSTACK_API ?? 'https://api.paystack.co',
  smsProvider: (process.env.SMS_PROVIDER ?? 'log') as 'log' | 'arkesel' | 'hubtel',
  smsSender: process.env.SMS_SENDER_ID ?? 'PRESEC03',
  arkeselKey: process.env.ARKESEL_API_KEY ?? '',
  hubtelClientId: process.env.HUBTEL_CLIENT_ID ?? '', hubtelClientSecret: process.env.HUBTEL_CLIENT_SECRET ?? '',
  emailProvider: (process.env.EMAIL_PROVIDER ?? 'log') as 'log' | 'resend',
  resendKey: process.env.RESEND_API_KEY ?? '', emailFrom: process.env.EMAIL_FROM ?? 'Class of 2003 Legacy <no-reply@example.org>',
  cronSecret: process.env.CRON_SECRET ?? '',
  dbPoolMax: Number(process.env.DB_POOL_MAX ?? 10),
};

/* ───────────────────────── database */
pg.types.setTypeParser(20, (v) => Number(v));      // int8 → number (pesewas fit safely below 2^53)
pg.types.setTypeParser(1700, (v) => Number(v));    // numeric → number (fx rates only)
pg.types.setTypeParser(1082, (v) => v);            // date stays 'YYYY-MM-DD'

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax, ssl: /sslmode=require|neon\.tech/.test(config.databaseUrl) ? { rejectUnauthorized: true } : undefined });
export type Db = pg.PoolClient;

/** Run fn in a SERIALIZABLE-safe transaction; everything inside succeeds or fails together. */
export async function tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}
export async function q<T = any>(db: Db | pg.Pool, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}
export async function one<T = any>(db: Db | pg.Pool, sql: string, params: unknown[] = []): Promise<T> {
  const r = await q<T>(db, sql, params);
  if (!r.length) throw new AppError(404, 'not_found', 'Record not found.');
  return r[0];
}

/* ───────────────────────── errors */
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const forbid = (msg: string) => new AppError(403, 'forbidden', msg);
export const conflict = (msg: string) => new AppError(409, 'conflict', msg);
export const invalid = (msg: string) => new AppError(400, 'invalid', msg);

/* ───────────────────────── money (pesewas) */
export const toPesewas = (ghs: number) => Math.round(ghs * 100);
export const fmt = (p: number) => 'GH₵ ' + (p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Percentage of an integer amount, rounded half-up to the pesewa. bp = basis points (1% = 100). */
export const ofBp = (amount: number, bp: number) => Math.round((amount * bp) / 10000);

/* ───────────────────────── passwords, tokens, TOTP */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [, s, k] = stored.split('$');
  if (!s || !k) return false;
  const key = await scrypt(pw, Buffer.from(s, 'base64'), 64);
  const expected = Buffer.from(k, 'base64');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Decode(s: string): Buffer {
  let bits = 0, val = 0; const out: number[] = [];
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(c); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function newTotpSecret(): string { const b = randomBytes(20); let s = '', bits = 0, val = 0; for (const x of b) { val = (val << 8) | x; bits += 8; while (bits >= 5) { s += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } return s; }
export function totp(secret: string, at = Date.now(), step = 30): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
export function verifyTotp(secret: string, code: string): boolean {
  const now = Date.now();
  return [-1, 0, 1].some((w) => totp(secret, now + w * 30_000) === code);
}
export function hmacHex(secret: string, body: string, algo: 'sha256' | 'sha512' = 'sha256') { return createHmac(algo, secret).update(body).digest('hex'); }
export function safeEqualHex(a: string, b: string) {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/* ───────────────────────── permissions */
export type Role = 'admin' | 'committee' | 'treasurer' | 'approver' | 'auditor' | 'pm' | 'captain' | 'member' | 'school';
export const PERMS: Record<Role, string[]> = {
  member: ['own', 'pay', 'vote', 'dir', 'proj.view'],
  captain: ['house.tools'],
  treasurer: ['fin.view', 'fin.record', 'fin.verify', 'fin.release', 'fin.reconcile', 'reports'],
  approver: ['fin.view', 'fin.verify', 'req.approve', 'reports'],
  auditor: ['fin.view', 'audit.view', 'reports', 'proj.view'],
  pm: ['proj.edit', 'req.create', 'proj.view'],
  committee: ['req.approve', 'var.approve', 'proj.verify', 'gov.manage', 'fin.view', 'reports', 'rules.edit', 'proj.view'],
  admin: ['admin.members', 'audit.view', 'proj.view', 'dir'],   // plus read-only access to the project and directory
  school: ['proj.view'],
};
/** Roles whose actions need a passed MFA check when MFA is enforced. */
export const PRIVILEGED: Role[] = ['admin', 'committee', 'treasurer', 'approver', 'auditor', 'pm'];

export interface Actor {
  userId: string; name: string; roles: Role[]; memberId: string | null; mfaPassed: boolean;
}
export const perms = (a: Actor) => new Set(a.roles.flatMap((r) => PERMS[r] ?? []));
const BASIC = new Set(['own', 'pay', 'vote', 'dir', 'proj.view']);
/** Server-side permission check. Every service function calls this; hiding a button is never enough. */
export function need(a: Actor, perm: string, what: string) {
  if (!perms(a).has(perm)) throw forbid(`Your role cannot ${what}.`);
  if (config.requireMfa && !BASIC.has(perm) && a.roles.some((r) => PRIVILEGED.includes(r)) && !a.mfaPassed)
    throw forbid('This action needs two-factor sign-in. Sign in again with your authenticator code.');
}

/* ───────────────────────── audit (hash-chained, append-only) */
export async function audit(db: Db, actor: Actor | null, action: string, target: string, detail = '') {
  await db.query('SELECT pg_advisory_xact_lock(7311001)'); // serialise chain writers
  const prev = (await q<{ hash: string }>(db, 'SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1'))[0]?.hash ?? '0'.repeat(64);
  const at = new Date().toISOString();
  const label = actor ? `${actor.name} (${actor.roles.join(', ')})` : 'System';
  const hash = sha256([prev, at, actor?.userId ?? '', label, action, target, detail].join('|'));
  await db.query('INSERT INTO audit_events (at, actor_id, actor_label, action, target, detail, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [at, actor?.userId ?? null, label, action, target, detail, prev, hash]);
}
export async function verifyAuditChain(db: Db | pg.Pool): Promise<{ ok: boolean; count: number; brokenAt: number | null }> {
  const rows = await q<any>(db, 'SELECT seq, at, actor_id, actor_label, action, target, detail, prev_hash, hash FROM audit_events ORDER BY seq');
  let prev = '0'.repeat(64);
  for (const r of rows) {
    const at = new Date(r.at).toISOString();
    const h = sha256([prev, at, r.actor_id ?? '', r.actor_label, r.action, r.target, r.detail].join('|'));
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, count: rows.length, brokenAt: Number(r.seq) };
    prev = r.hash;
  }
  return { ok: true, count: rows.length, brokenAt: null };
}

/* ───────────────────────── notifications */
export type NoticeKind = 'payment' | 'governance' | 'security' | 'reminder' | 'general';
/** Queue a notice. Delivery (SMS/email) happens in the dispatcher, which applies member preferences by kind. */
export async function notify(db: Db, audience: string, channels: string[], body: string, kind?: NoticeKind) {
  const k: NoticeKind = kind ?? (/^Payment received|Receipt|Thank you for your gift/.test(body) ? 'payment' : /^Ballot|Voting/.test(body) ? 'governance' : /reminder|yet to give/i.test(body) ? 'reminder' : 'general');
  await db.query('INSERT INTO notifications (audience, channels, body, kind) VALUES ($1,$2,$3,$4)', [audience, channels, body, k]);
}

/* ───────────────────────── settings */
export async function setting<T = any>(db: Db | pg.Pool, key: string): Promise<T> {
  return (await one<{ value: T }>(db, 'SELECT value FROM settings WHERE key=$1', [key])).value;
}
export const today = () => new Date().toISOString().slice(0, 10);
