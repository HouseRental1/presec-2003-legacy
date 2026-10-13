// Compiled entry for production migrations: node server/dist/migrate-cli.js
import { migrate } from './migrate.js';
import { pool } from './lib.js';
migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
