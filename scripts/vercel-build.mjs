// Vercel build: compile the API, run database migrations, build the web app into /public.
import { execSync } from 'node:child_process';
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });

// Use the compilers directly so the build works whatever NODE_ENV is set to.
run('npx --no-install tsc -p server/tsconfig.build.json');
if (process.env.DATABASE_URL) {
  // Migrations are idempotent (recorded in schema_migrations). Use the direct (unpooled) URL when available.
  run(`node server/dist/migrate-cli.js`, { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL } });
  // First administrator: created once, only when ADMIN_EMAIL and ADMIN_PASSWORD are set and the
  // database has no users yet. Remove ADMIN_PASSWORD from Vercel after the first successful deploy.
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    try {
      run(`node server/dist/bootstrap.js`, { env: { NODE_ENV: 'production', ...process.env, DATABASE_URL: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
        ADMIN_NAME: process.env.ADMIN_NAME ?? 'Committee Administrator',
        HOUSES: process.env.HOUSES ?? 'H1:Kwansa,H2:Clerk,H3:Engmann,H4:Akro,H5:Riis,H6:Labone,H7:Ako-Adjei,H8:Owusu-Parry',
        PROJECT_NAME: process.env.PROJECT_NAME ?? 'Legacy Project 1: six-unit classroom block, PRESEC Legon' } });
    } catch { console.warn('Administrator set-up skipped (already done, or see the message above).'); }
  }
} else {
  console.warn('DATABASE_URL is not set: skipping migrations.');
}
run('npx --no-install tsc --noEmit -p web/tsconfig.json');
run('npx --no-install vite build web');
// The API function serves web/dist itself (with an index.html fallback for app routes).
console.log('Build complete: API in server/dist, web app in web/dist.');
