import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, App } from '../src/app.js';
import { resetDatabase } from '../src/migrate.js';
import { config, pool } from '../src/lib.js';

let app: App, A: Record<string, string>;
const csrf = { 'x-requested-with': 'class-legacy' };
const login = async (email: string) => ({ authorization: 'Bearer ' + (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'a-long-enough-pass' } })).json().token, ...csrf });
const post = (url: string, payload: any, headers: any) => app.inject({ method: 'POST', url, payload, headers });
const get = (url: string, headers: any) => app.inject({ method: 'GET', url, headers });

beforeAll(async () => {
  await resetDatabase(); config.cronSecret = 'access-test'; config.requireMfa = false; app = await buildApp();
  await app.inject({ method: 'POST', url: '/api/setup/first-admin', payload: { name: 'Kweku Yeboah', email: 'admin@example.org', password: 'a-long-enough-pass', code: 'access-test' } });
  A = await login('admin@example.org');
  await post('/api/houses/members', { fullName: 'Kofi Boateng', houseId: 'H2', email: 'kofi@example.org' }, A);
  await pool.query(`UPDATE users SET password_hash=(SELECT password_hash FROM users WHERE email='admin@example.org') WHERE email='kofi@example.org'`);
});
afterAll(async () => { await app.close(); });

describe('two access levels', () => {
  it('the founder is an administrator with the full bundle', async () => {
    const me = (await get('/api/me', A)).json();
    expect(me.access).toBe('admin');
    expect(me.roles).toEqual(expect.arrayContaining(['admin', 'committee', 'treasurer', 'approver', 'pm']));
  });
  it('a member can view, pledge and pay, but cannot change anything else', async () => {
    const K = await login('kofi@example.org');
    const me = (await get('/api/me', K)).json();
    expect(me.access).toBe('member'); expect(me.perms.sort()).toEqual(['dir', 'own', 'pay', 'proj.view']);
    for (const url of ['/api/houses', '/api/houses/H2/members', '/api/dashboard', '/api/project', '/api/project/lifecycle', '/api/members', '/api/standings']) expect((await get(url, K)).statusCode, url).toBe(200);
    expect((await post('/api/pledges', { amountGhs: 500, instalments: 5 }, K)).statusCode).toBe(200);
    for (const [url, body] of [['/api/houses/members', { fullName: 'Someone Else', houseId: 'H1' }], ['/api/houses/H2', { motto: 'x' }], ['/api/project/updates', { title: 'Hello there', body: 'Some text here' }], ['/api/admin/access', { who: 'admin@example.org', access: 'member' }]] as const)
      expect((await post(url, body, K)).statusCode, url).toBe(403);
  });
  it('voting and event replies only when participation is switched on', async () => {
    let K = await login('kofi@example.org');
    expect((await get('/api/me', K)).json().perms).not.toContain('vote');
    expect((await post('/api/admin/participation', { on: true }, A)).statusCode).toBe(200);
    K = await login('kofi@example.org');
    expect((await get('/api/me', K)).json().perms).toEqual(expect.arrayContaining(['vote', 'rsvp']));
    await post('/api/admin/participation', { on: false }, A);
  });
  it('an administrator can make a member an admin and back; the last admin stays', async () => {
    expect((await post('/api/admin/access', { who: 'P03-0001', access: 'admin' }, A)).statusCode).toBe(200);
    expect((await get('/api/me', await login('kofi@example.org'))).json().access).toBe('admin');
    expect((await post('/api/admin/access', { who: 'kofi@example.org', access: 'member' }, A)).statusCode).toBe(200);
    expect((await get('/api/me', await login('kofi@example.org'))).json().access).toBe('member');
    expect((await post('/api/admin/access', { who: 'admin@example.org', access: 'member' }, A)).statusCode).toBe(403);   // not yourself
  });
});

describe('invitation links for administrators', () => {
  it('adding a classmate returns a working set-password link', async () => {
    const r = await post('/api/houses/members', { fullName: 'Ama Test Member', houseId: 'H4', email: 'ama.test@example.org' }, A);
    expect(r.statusCode, r.body).toBe(200);
    const { link, delivery } = r.json(); expect(delivery).toEqual({ email: false, sms: false });
    const token = new URL(link).searchParams.get('token');
    expect((await app.inject({ method: 'POST', url: '/api/auth/set-password', payload: { token, password: 'member-password-1' } })).statusCode).toBe(200);
    const s = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ama.test@example.org', password: 'member-password-1' } });
    expect(s.statusCode).toBe(200);
    expect((await get('/api/me', { authorization: 'Bearer ' + s.json().token })).json().access).toBe('member');
    const again = await post(`/api/admin/members/${r.json().memberNo}/invite`, {}, A);
    expect(again.json().link).toMatch(/set-password\?token=/);
  });
});
