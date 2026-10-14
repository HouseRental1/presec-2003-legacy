import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, App } from '../src/app.js';
import { resetDatabase } from '../src/migrate.js';
import { config, pool } from '../src/lib.js';

let app: App;
beforeAll(async () => { await resetDatabase(); config.cronSecret = 'setup-test-code'; app = await buildApp(); });
afterAll(async () => { await app.close(); });

describe('first-run set-up from the sign-in page', () => {
  it('reports an empty database as needing set-up', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toMatchObject({ database: 'ready', needsSetup: true });
  });
  it('refuses a wrong set-up code and a short password', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/api/setup/first-admin', payload: { name: 'Kweku Yeboah', email: 'kweku@example.org', password: 'a-long-enough-pass', code: 'nope' } });
    expect(wrong.statusCode).toBe(403);
    const short = await app.inject({ method: 'POST', url: '/api/setup/first-admin', payload: { name: 'Kweku Yeboah', email: 'kweku@example.org', password: 'short', code: 'setup-test-code' } });
    expect(short.statusCode).toBe(400);
  });
  it('creates the administrator, houses and project once; then signs in', async () => {
    const ok = await app.inject({ method: 'POST', url: '/api/setup/first-admin', payload: { name: 'Kweku Yeboah', email: ' Kweku@Example.org ', password: 'a-long-enough-pass', code: 'setup-test-code' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await pool.query('SELECT count(*)::int n FROM houses')).rows[0].n).toBe(8);
    const again = await app.inject({ method: 'POST', url: '/api/setup/first-admin', payload: { name: 'Intruder', email: 'x@example.org', password: 'a-long-enough-pass', code: 'setup-test-code' } });
    expect(again.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json().needsSetup).toBe(false);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'kweku@example.org', password: 'a-long-enough-pass' } });
    expect(login.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer ' + login.json().token } });
    expect(me.json().roles.sort()).toEqual(['admin', 'approver', 'committee', 'pm', 'treasurer']);
    expect((await app.inject({ method: 'GET', url: '/api/project', headers: { authorization: 'Bearer ' + login.json().token } })).statusCode).toBe(200);
  });
});

describe('set-up recovery (single account only)', () => {
  it('resets the only account with the set-up code, then closes once a second account exists', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json().canRecover).toBe(true);
    const bad = await app.inject({ method: 'POST', url: '/api/setup/recover-admin', payload: { name: 'Kweku', email: 'kweku@example.org', password: 'another-long-pass', code: 'wrong' } });
    expect(bad.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/setup/recover-admin', payload: { name: 'Kweku Yeboah', email: 'kwekuyeboah@gmail.com', password: 'another-long-pass', code: 'setup-test-code' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'kwekuyeboah@gmail.com', password: 'another-long-pass' } })).statusCode).toBe(200);
    await pool.query(`INSERT INTO users (email, password_hash, display_name) VALUES ('second@example.org','x','Second')`);
    const closed = await app.inject({ method: 'POST', url: '/api/setup/recover-admin', payload: { name: 'Intruder', email: 'x@example.org', password: 'another-long-pass', code: 'setup-test-code' } });
    expect(closed.statusCode).toBe(409);
  });
});
