import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './lib.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Apply any migration files not yet recorded in schema_migrations, each in its own transaction. */
export async function migrate(log = true) {
  const c = await pool.connect();
  try {
    const exists = (await c.query(`SELECT to_regclass('public.schema_migrations') t`)).rows[0].t;
    const done = new Set<string>(exists ? (await c.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version) : []);
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      await c.query(readFileSync(join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
      await c.query('COMMIT');
      if (log) console.log('applied', f);
    }
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
/** Development/test only: wipe and rebuild the schema. */
export async function resetDatabase() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to reset a production database.');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
