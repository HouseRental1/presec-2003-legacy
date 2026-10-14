// Vercel build: compile the API, run database migrations, build the web app into /public.
import { execSync } from 'node:child_process';
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });

// Use the compilers directly so the build works whatever NODE_ENV is set to.
run('npx --no-install tsc -p server/tsconfig.build.json');
if (process.env.DATABASE_URL) {
  // Migrations are idempotent (recorded in schema_migrations). Use the direct (unpooled) URL when available.
  run(`node server/dist/migrate-cli.js`, { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL } });
} else {
  console.warn('DATABASE_URL is not set: skipping migrations.');
}
run('npx --no-install tsc --noEmit -p web/tsconfig.json');
run('npx --no-install vite build web');
// The API function serves web/dist itself (with an index.html fallback for app routes).
console.log('Build complete: API in server/dist, web app in web/dist.');
