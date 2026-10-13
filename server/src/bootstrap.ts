/**
 * Production first-run setup (safe to run once on an empty, migrated database).
 *   node dist/bootstrap.js
 * Reads: ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME, HOUSES ("H1:Name,H2:Name,..."), PROJECT_NAME
 * Creates the chart of accounts, default control settings, the official houses, the first project
 * and ONE administrator. Everything else (members, roles, budget, contract) is entered in the app.
 */
import { pool, tx, q, hashPassword } from './lib.js';
import { ACCOUNTS } from './services/ledger.js';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`Set ${k}`); return v; };

await tx(async (db) => {
  const [{ n }] = await q<any>(db, 'SELECT count(*)::int n FROM users');
  if (n > 0) throw new Error('Already bootstrapped: users exist. Nothing changed.');
  if (env('ADMIN_PASSWORD').length < 14) throw new Error('ADMIN_PASSWORD must be at least 14 characters.');
  for (const [code, a] of Object.entries(ACCOUNTS)) await db.query('INSERT INTO ledger_accounts VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [code, a.name, a.normal]);
  const defaults: Record<string, unknown> = {
    dual_approval_above: 5_000_000,        // GH₵ 50,000 in pesewas — confirm with the committee
    member_vote_above: 10_000_000,         // GH₵ 100,000
    admin_cap: 3, quorum_bp: 3000,
    fees: { momo_bp: 100, card_bp: 250 },  // replace with the selected provider's contract rates
    fx_indicative: { GHS: 1, USD: 15.6, GBP: 20.4 }, // indicative only; settlement rate comes from the provider
  };
  for (const [k, v] of Object.entries(defaults)) await db.query('INSERT INTO settings VALUES ($1,$2) ON CONFLICT DO NOTHING', [k, JSON.stringify(v)]);
  for (const pair of env('HOUSES').split(',')) { const [id, name] = pair.split(':').map((s) => s.trim()); await db.query('INSERT INTO houses VALUES ($1,$2)', [id, name]); }
  await db.query(`INSERT INTO projects VALUES ('P1',$1,'initiation')`, [env('PROJECT_NAME')]);
  const [u] = await q<any>(db, 'INSERT INTO users (email, password_hash, display_name) VALUES (lower($1),$2,$3) RETURNING id', [env('ADMIN_EMAIL'), await hashPassword(env('ADMIN_PASSWORD')), env('ADMIN_NAME')]);
  await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1,'admin')`, [u.id]);
  console.log('Bootstrapped. Sign in as', env('ADMIN_EMAIL'), 'and set up two-factor sign-in first.');
});
await pool.end();
