// Vercel build: compile the API, run database migrations, build the web app into /public.
import { execSync } from 'node:child_process';
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });

run('npm -w server run build');
if (process.env.DATABASE_URL) {
  // Migrations are idempotent (recorded in schema_migrations). Use the direct (unpooled) URL when available.
  run(`node server/dist/migrate-cli.js`, { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL } });
} else {
  console.warn('DATABASE_URL is not set: skipping migrations.');
}
run('npm -w web run build');
// The API function serves web/dist itself (with an index.html fallback for app routes).
console.log('Build complete: API in server/dist, web app in web/dist.');
