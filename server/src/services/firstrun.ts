/**
 * First-run set-up: on an empty database, create the chart of accounts, default control settings,
 * PRESEC's houses, Legacy Project 1 and ONE administrator. Refuses once any user exists.
 * Used by the sign-in page (protected by the set-up code) and by scripts/bootstrap.
 */
import { z } from 'zod';
import { Db, q, hashPassword, config, AppError, audit, safeEqualHex, sha256 } from '../lib.js';
import { ACCOUNTS } from './ledger.js';

export const DEFAULT_HOUSES = 'H1:Kwansa,H2:Clerk,H3:Engmann,H4:Akro,H5:Riis,H6:Labone,H7:Ako-Adjei,H8:Owusu-Parry';
export const DEFAULT_PROJECT = 'Legacy Project 1: six-unit classroom block, PRESEC Legon';

/** What the sign-in page needs to know. Never reveals anything once set up. */
export async function setupStatus(db: Db | any) {
  try {
    const [{ n }] = await q<any>(db, 'SELECT count(*)::int n FROM users');
    // canRecover: during set-up only (exactly one account), the set-up code may reset that account.
    return { database: 'ready', needsSetup: n === 0, canRecover: n === 1, codeConfigured: !!setupCode() };
  } catch (e: any) {
    // 42P01 = table missing (migrations have not run); anything else = cannot reach the database.
    return { database: e.code === '42P01' ? 'not_migrated' : 'unreachable', needsSetup: false, canRecover: false, codeConfigured: !!setupCode() };
  }
}
const setupCode = () => process.env.SETUP_CODE || config.cronSecret || '';

export const FirstAdminInput = z.object({
  code: z.string().min(1, 'Enter the set-up code.'),
  name: z.string().trim().min(2, 'Enter your name.').max(120),
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(12, 'Use a password of at least 12 characters.').max(200),
});

function checkSetupCode(code: string) {
  const expected = setupCode();
  if (!expected) throw new AppError(503, 'no_setup_code', 'Set-up is not configured: add SETUP_CODE (or CRON_SECRET) in Vercel and redeploy.');
  if (!safeEqualHex(sha256(code.trim()), sha256(expected))) throw new AppError(403, 'bad_setup_code', 'That set-up code is not correct.');
}

/**
 * Recovery during set-up: while the platform has exactly ONE account, the holder of the set-up
 * code may reset that account's name, email and password (and it keeps the administrator role).
 * Disabled for good as soon as a second account exists.
 */
export async function recoverFirstAdmin(db: Db, input: z.infer<typeof FirstAdminInput>) {
  checkSetupCode(input.code);
  await db.query('SELECT pg_advisory_xact_lock(7311002)');
  const users = await q<any>(db, 'SELECT id FROM users');
  if (users.length !== 1) throw new AppError(409, 'recovery_closed', 'Recovery is only available while the platform has a single account. Use “Forgot password?” instead.');
  const id = users[0].id;
  await db.query(`UPDATE users SET email=lower($2), password_hash=$3, display_name=$4, status='active', totp_secret=NULL WHERE id=$1`, [id, input.email.trim(), await hashPassword(input.password), input.name.trim()]);
  await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1,'admin'),($1,'committee') ON CONFLICT DO NOTHING`, [id]);
  await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
  await db.query('DELETE FROM login_failures');
  await audit(db, null, 'Reset the set-up administrator', input.email.trim().toLowerCase());
  return { ok: true, email: input.email.trim().toLowerCase() };
}

export async function createFirstAdmin(db: Db, input: { name: string; email: string; password: string; houses?: string; projectName?: string }, checkCode?: string) {
  if (checkCode !== undefined) checkSetupCode(checkCode);
  await db.query('SELECT pg_advisory_xact_lock(7311002)'); // two people submitting at once cannot both succeed
  const [{ n }] = await q<any>(db, 'SELECT count(*)::int n FROM users');
  if (n > 0) throw new AppError(409, 'already_set_up', 'Set-up is already complete. Sign in instead.');
  for (const [code, a] of Object.entries(ACCOUNTS)) await db.query('INSERT INTO ledger_accounts VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [code, a.name, a.normal]);
  const defaults: Record<string, unknown> = {
    dual_approval_above: 5_000_000, member_vote_above: 10_000_000, admin_cap: 3, quorum_bp: 3000,
    fees: { momo_bp: 100, card_bp: 250 }, fx_indicative: { GHS: 1, USD: 15.6, GBP: 20.4 },
  };
  for (const [k, v] of Object.entries(defaults)) await db.query('INSERT INTO settings VALUES ($1,$2) ON CONFLICT DO NOTHING', [k, JSON.stringify(v)]);
  for (const pair of (input.houses ?? DEFAULT_HOUSES).split(',')) {
    const [id, name] = pair.split(':').map((s) => s.trim());
    await db.query('INSERT INTO houses VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, name]);
  }
  await db.query(`INSERT INTO projects VALUES ('P1',$1,'initiation') ON CONFLICT DO NOTHING`, [input.projectName ?? DEFAULT_PROJECT]);
  const [u] = await q<any>(db, 'INSERT INTO users (email, password_hash, display_name) VALUES (lower($1),$2,$3) RETURNING id', [input.email.trim(), await hashPassword(input.password), input.name.trim()]);
  // The founder also sits on the executive committee so set-up can proceed before others join.
  await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1,'admin'),($1,'committee')`, [u.id]);
  await audit(db, null, 'Created first administrator', input.email.trim().toLowerCase());
  return { ok: true, email: input.email.trim().toLowerCase() };
}
