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
    expect(me.access).toBe('superadmin');
    expect(me.roles).toEqual(expect.arrayContaining(['superadmin', 'admin', 'committee', 'treasurer', 'approver', 'pm', 'officer']));
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
    const K = await login('kofi@example.org');
    expect((await get('/api/me', K)).json().access).toBe('admin');
    // an admin records a cash payment but cannot verify it; the super admin can
    const rec = await post('/api/finance/payments', { memberNo: 'P03-0001', amountGhs: 50, channel: 'cash', ref: 'CASH-ADM-1', paidOn: new Date().toISOString().slice(0, 10) }, K);
    expect(rec.statusCode, rec.body).toBe(200);
    const pid = rec.json().id;
    expect((await post(`/api/finance/payments/${pid}/verify`, {}, K)).statusCode).toBe(403);
    expect((await post('/api/admin/access', { who: 'admin@example.org', access: 'member' }, K)).statusCode).toBe(403);   // admins can't touch super admins
    expect((await post(`/api/finance/payments/${pid}/verify`, {}, A)).statusCode).toBe(200);
    expect((await post('/api/admin/access', { who: 'kofi@example.org', access: 'superadmin' }, A)).statusCode).toBe(200);
    expect((await get('/api/me', await login('kofi@example.org'))).json().access).toBe('superadmin');
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

describe('sign-up with administrator approval', () => {
  const apply = (p: any) => app.inject({ method: 'POST', url: '/api/signup', payload: { fullName: 'Yaw Sign Up', email: 'yaw.signup@example.org', houseId: 'H5', password: 'yaw-password-1', city: 'Kumasi', ...p } });
  const signIn = (password = 'yaw-password-1') => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'yaw.signup@example.org', password } });
  it('accepts a request; the applicant cannot sign in until approved', async () => {
    expect((await apply({})).statusCode).toBe(200);
    expect((await apply({})).statusCode).toBe(409);                       // already waiting: told so
    expect((await apply({ email: 'admin@example.org' })).json().message).toMatch(/already has an account/);
    const w = await signIn(); expect(w.statusCode).toBe(403); expect(w.json().message).toMatch(/waiting for an administrator/);
    expect((await signIn('wrong-password-9')).statusCode).toBe(401);       // no hint without the right password
    expect((await apply({ email: 'bad', password: 'short' })).statusCode).toBe(400);
  });
  it('members cannot review requests; an administrator approves into a house', async () => {
    const K = await login('kofi@example.org');
    expect((await get('/api/admin/signups', K)).statusCode).toBe(403);
    const list = (await get('/api/admin/signups', A)).json();
    const req = list.find((s: any) => s.email === 'yaw.signup@example.org'); expect(req).toMatchObject({ house_id: 'H5', city: 'Kumasi' });
    const d = await post(`/api/admin/signups/${req.id}/decision`, { approve: true, houseId: 'H6' }, A);
    expect(d.statusCode, d.body).toBe(200);
    const s = await signIn(); expect(s.statusCode).toBe(200);
    const me = (await get('/api/me', { authorization: 'Bearer ' + s.json().token })).json();
    expect(me).toMatchObject({ access: 'member', member: { house_id: 'H6' } });
    expect((await post(`/api/admin/signups/${req.id}/decision`, { approve: false }, A)).statusCode).toBe(409);
  });
  it('a declined applicant is told so', async () => {
    await apply({ email: 'nope@example.org', password: 'nope-password-1' });
    const req = (await get('/api/admin/signups', A)).json().find((s: any) => s.email === 'nope@example.org');
    expect((await post(`/api/admin/signups/${req.id}/decision`, { approve: false, note: 'Not in the 2003 year group' }, A)).statusCode).toBe(200);
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nope@example.org', password: 'nope-password-1' } });
    expect(r.statusCode).toBe(403); expect(r.json().message).toMatch(/not approved/);
  });
});

describe('pledges list', () => {
  it('shows each pledge with paid and outstanding, and tells administrators', async () => {
    const K = await login('kofi@example.org');
    expect((await post('/api/pledges', { amountGhs: 1200, instalments: 4 }, K)).statusCode).toBe(200);
    await pool.query(`INSERT INTO payments (project_id, member_id, channel, source, currency, amount_original, amount_ghs, external_ref, paid_on, status)
      SELECT 'P1', id, 'momo', 'gateway', 'GHS', 30000, 30000, 'PL-1', current_date, 'verified' FROM members WHERE member_no='P03-0001'`);
    const r = (await get('/api/pledges', A)).json();
    const kofi = r.rows.find((x: any) => x.member_no === 'P03-0001');
    // Kofi also has the GH₵ 50 cash payment verified earlier in this file
    expect(kofi).toMatchObject({ pledged: 120000, paid: 35000, outstanding: 85000, state: 'part_paid', instalments: 4, adjusted: true });
    expect(r.summary).toMatchObject({ pledgers: 1, totalPledged: 120000, paidAgainst: 35000, outstanding: 85000 });
    expect((await get('/api/pledges?status=fulfilled', A)).json().rows).toHaveLength(0);
    const n = (await pool.query(`SELECT body FROM notifications WHERE audience='perm:admin.members' AND body LIKE '%pledge%' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(n.body).toMatch(/changed their pledge to GH₵\s?1,200/);
    expect((await get('/api/pledges', K)).statusCode).toBe(200);     // members can see too (transparent year group)
  });
});
