/**
 * Command-line alternative to the sign-in page's first-run form.
 *   ADMIN_EMAIL=… ADMIN_PASSWORD=… ADMIN_NAME=… node dist/bootstrap.js
 */
import { pool, tx } from './lib.js';
import { createFirstAdmin } from './services/firstrun.js';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`Set ${k}`); return v; };
try {
  const r = await tx((db) => createFirstAdmin(db, { email: env('ADMIN_EMAIL'), password: env('ADMIN_PASSWORD'), name: process.env.ADMIN_NAME ?? 'Committee Administrator', houses: process.env.HOUSES, projectName: process.env.PROJECT_NAME }));
  console.log('Bootstrapped. Sign in as', r.email);
} catch (e: any) {
  console.log('First administrator NOT created:', e.message);
  process.exitCode = 1;
} finally { await pool.end(); }
