import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, App } from '../src/app.js';
import { resetDatabase } from '../src/migrate.js';
import { config } from '../src/lib.js';

let app: App, H: Record<string, string>;
const csrf = { 'x-requested-with': 'class-legacy' };
beforeAll(async () => {
  await resetDatabase(); config.cronSecret = 'houses-test-code'; app = await buildApp();
  await app.inject({ method: 'POST', url: '/api/setup/first-admin', payload: { name: 'Kweku Yeboah', email: 'admin@example.org', password: 'a-long-enough-pass', code: 'houses-test-code' } });
  const t = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.org', password: 'a-long-enough-pass' } })).json().token;
  H = { authorization: 'Bearer ' + t, ...csrf };
});
afterAll(async () => { await app.close(); });
const post = (url: string, payload: any, headers = H) => app.inject({ method: 'POST', url, payload, headers });
const get = (url: string, headers = H) => app.inject({ method: 'GET', url, headers });

describe('houses page', () => {
  it('lists all eight houses before anyone is registered', async () => {
    const r = await get('/api/houses');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().map((h: any) => h.name)).toEqual(['Kwansa', 'Clerk', 'Engmann', 'Akro', 'Riis', 'Labone', 'Ako-Adjei', 'Owusu-Parry']);
    expect(r.json().every((h: any) => h.members === 0)).toBe(true);
  });
  it('lets the administrator join their own house, numbered automatically', async () => {
    const r = await post('/api/houses/members', { fullName: 'Kweku Yeboah', houseId: 'H3', isMe: true });
    expect(r.statusCode, r.body).toBe(200); expect(r.json().memberNo).toBe('P03-0001');
    expect((await get('/api/me')).json().member.house_id).toBe('H3');
    expect((await post('/api/houses/members', { fullName: 'Kweku Yeboah', houseId: 'H3', isMe: true })).statusCode).toBe(409);
  });
  it('adds classmates with and without email, and appoints a captain', async () => {
    const a = await post('/api/houses/members', { fullName: 'Kofi Boateng', houseId: 'H3', email: 'kofi@example.org', phone: '0244000111', city: 'Accra' });
    expect(a.statusCode, a.body).toBe(200); expect(a.json()).toMatchObject({ memberNo: 'P03-0002', invited: true });
    const b = await post('/api/houses/members', { fullName: 'Yaw Owusu', houseId: 'H1' });
    expect(b.json()).toMatchObject({ memberNo: 'P03-0003', invited: false });
    expect((await post('/api/houses/members', { fullName: 'Dup', houseId: 'H1', email: 'kofi@example.org' })).statusCode).toBe(409);
    expect((await post('/api/admin/captains', { houseId: 'H3', memberNo: 'P03-0002' })).statusCode).toBe(200);
    const hs = (await get('/api/houses')).json();
    expect(hs.find((h: any) => h.id === 'H3')).toMatchObject({ members: 2, with_accounts: 2, captains: ['Kofi Boateng'] });
    expect((await get('/api/members?house=H3')).json().total).toBe(2);
  });
  it('saves a house profile; only administrators may', async () => {
    expect((await post('/api/houses/H3', { motto: 'Ever forward', about: 'Named after Rev. Engmann.' })).statusCode).toBe(200);
    expect((await get('/api/houses')).json().find((h: any) => h.id === 'H3')).toMatchObject({ motto: 'Ever forward' });
    expect((await post('/api/houses/H3', { motto: 'x' }, csrf as any)).statusCode).toBe(401);
  });
});
