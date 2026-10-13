import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { fresh, as, pool, q, config } from './helpers.js';
import type { App } from '../src/app.js';
import { outbox, dispatch } from '../src/services/messaging.js';
import { tx } from '../src/lib.js';
import { standings } from '../src/services/competition.js';

let app: App;
beforeAll(async () => { app = await fresh(); });
afterAll(async () => { await app.close(); vi.unstubAllGlobals(); config.paymentProvider = 'sandbox'; });

/** Fake Paystack API: records initialize calls and answers verify from a table we control. */
const verified: Record<string, any> = {};
function fakePaystack() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const u = String(url);
    if (u.endsWith('/transaction/initialize')) { const b = JSON.parse(init.body); return new Response(JSON.stringify({ status: true, data: { authorization_url: 'https://checkout.paystack.com/' + b.reference, access_code: 'x', reference: b.reference } })); }
    const ref = decodeURIComponent(u.split('/transaction/verify/')[1] ?? '');
    if (verified[ref]) return new Response(JSON.stringify({ status: true, data: verified[ref] }));
    return new Response(JSON.stringify({ status: false, message: 'Transaction reference not found' }), { status: 400 });
  }));
}
const paystackHook = (body: object, secret = config.paystackSecret) => {
  const raw = JSON.stringify(body);
  return app.inject({ method: 'POST', url: '/api/webhooks/payments/paystack', payload: raw, headers: { 'content-type': 'application/json', 'x-paystack-signature': createHmac('sha512', secret).update(raw).digest('hex') } });
};

describe('Paystack: members and public donors', () => {
  beforeAll(() => { config.paymentProvider = 'paystack'; config.paystackSecret = 'sk_test_fake'; fakePaystack(); });

  it('member checkout → signed charge.success → re-verified → posted once', async () => {
    const ama = await as(app, 'ama');
    const before = (await ama.get('/api/dashboard')).json().cashReceived;
    const init = (await ama.post('/api/payments/initiate', { amount: 300, channel: 'momo', network: 'MTN MoMo' })).json();
    expect(init.checkout.url).toMatch(/^https:\/\/checkout\.paystack\.com\/P03-/);
    verified[init.reference] = { id: 9001, reference: init.reference, status: 'success', amount: 30000, currency: 'GHS', fees: 300, paid_at: new Date().toISOString(), channel: 'mobile_money' };
    expect((await paystackHook({ event: 'charge.success', data: { reference: init.reference } }, 'wrong')).statusCode).toBe(401);
    const ok = await paystackHook({ event: 'charge.success', data: { reference: init.reference } });
    expect(ok.json().outcome).toBe('verified');
    expect((await paystackHook({ event: 'charge.success', data: { reference: init.reference } })).json().outcome).toBe('duplicate_event_ignored');
    expect((await ama.get('/api/dashboard')).json().cashReceived - before).toBe(30000);
    expect((await app.inject({ method: 'GET', url: '/api/payments/status/' + init.reference })).json().status).toBe('verified');
    const [p] = await q<any>(pool, 'SELECT fee_ghs FROM payments WHERE external_ref=$1', [init.reference]);
    expect(p.fee_ghs).toBe(300); // the provider's actual fee is recorded as a cost
  });
  it('a tampered amount is caught by re-verification and parked as an exception', async () => {
    const ama = await as(app, 'ama');
    const init = (await ama.post('/api/payments/initiate', { amount: 200, channel: 'card' })).json();
    verified[init.reference] = { id: 9002, reference: init.reference, status: 'success', amount: 2000, currency: 'GHS', fees: 50, paid_at: new Date().toISOString(), channel: 'card' };
    expect((await paystackHook({ event: 'charge.success', data: { reference: init.reference, amount: 20000 } })).json().outcome).toBe('mismatch');
  });
  it('foreign currency is refused with Paystack (cards are charged in cedis)', async () => {
    const ama = await as(app, 'ama');
    expect((await ama.post('/api/payments/initiate', { amount: 50, currency: 'GBP', channel: 'card' })).statusCode).toBe(400);
  });
  it('the return page can confirm a payment if the webhook is slow', async () => {
    const ama = await as(app, 'ama');
    const init = (await ama.post('/api/payments/initiate', { amount: 150, channel: 'momo' })).json();
    verified[init.reference] = { id: 9003, reference: init.reference, status: 'success', amount: 15000, currency: 'GHS', fees: 150, paid_at: new Date().toISOString(), channel: 'mobile_money' };
    const r = await app.inject({ method: 'POST', url: '/api/payments/check/' + init.reference });
    expect(r.json().status).toBe('verified');
  });
  it('a public donation reaches the project but no house', async () => {
    const lb0 = (await standings(pool)).rows.reduce((s, r) => s + r.raised, 0);
    const d = (await app.inject({ method: 'POST', url: '/api/public/donate', payload: { name: 'Friend of PRESEC', email: 'friend@example.org', amountGhs: 500 } })).json();
    verified[d.reference] = { id: 9004, reference: d.reference, status: 'success', amount: 50000, currency: 'GHS', fees: 500, paid_at: new Date().toISOString(), channel: 'card' };
    expect((await paystackHook({ event: 'charge.success', data: { reference: d.reference } })).json().outcome).toBe('verified');
    const [{ v }] = await q<any>(pool, `SELECT sum(credit) v FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.txn_id WHERE t.source_id=(SELECT id::text FROM payments WHERE external_ref=$1) AND e.account='INC_DONOR'`, [d.reference]);
    expect(v).toBe(50000);
    expect((await standings(pool)).rows.reduce((s, r) => s + r.raised, 0)).toBe(lb0);
  });
});

describe('messaging: queue, preferences, providers', () => {
  it('expands notices to recipients and respects reminder opt-outs but always sends payment notices', async () => {
    const [m] = await q<any>(pool, `SELECT id FROM members WHERE member_no='P03-0050'`);
    await pool.query(`UPDATE members SET phone='0241234567', sms_reminders=false WHERE id=$1`, [m.id]);
    await pool.query(`INSERT INTO notifications (audience, channels, body, kind) VALUES ($1,'{sms}','Gentle reminder','reminder'),($1,'{sms}','Payment received: test','payment')`, ['member:' + m.id]);
    outbox().length = 0;
    await tx((db) => dispatch(db));
    const mine = outbox().filter((x) => x.to === '233241234567');
    expect(mine.map((x) => x.text)).toEqual(['Payment received: test']);
  });
  it('cron endpoints need the secret', async () => {
    config.cronSecret = 'cron-test';
    expect((await app.inject({ method: 'GET', url: '/api/cron/dispatch' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/cron/dispatch', headers: { authorization: 'Bearer cron-test' } })).statusCode).toBe(200);
  });
});

describe('invitations, password reset and sign-in lockout', () => {
  it('imports the register, invites by link, and the link works once', async () => {
    const kwame = await as(app, 'kwame');
    const r = await kwame.post('/api/admin/import-members', { rows: [{ memberNo: 'P03-0901', fullName: 'Kojo Annan', houseId: 'H5', email: 'kojo@example.org', phone: '0201112222' }, { memberNo: 'P03-0902', fullName: 'Bad House', houseId: 'H99' }] });
    expect(r.json()).toMatchObject({ created: 1, skipped: [{ memberNo: 'P03-0902' }] });
    outbox().length = 0;
    await tx((db) => dispatch(db));
    const link = outbox().find((x) => x.to === 'kojo@example.org')!.text.match(/token=([\w-]+)/)![1];
    expect((await app.inject({ method: 'POST', url: '/api/auth/set-password', payload: { token: link, password: 'short' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/auth/set-password', payload: { token: link, password: 'a-good-long-password' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/set-password', payload: { token: link, password: 'another-long-password' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'kojo@example.org', password: 'a-good-long-password' } })).statusCode).toBe(200);
  });
  it('forgot-password never reveals whether an account exists', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'nobody@example.org' } });
    const b = await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'ama@presec2003.test' } });
    expect(a.json()).toEqual(b.json());
  });
  it('locks an account after 8 failed sign-ins', async () => {
    for (let i = 0; i < 8; i++) await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'yaw@presec2003.test', password: 'wrong' } });
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'yaw@presec2003.test', password: 'Legacy-demo-2026' } });
    expect(r.json().error).toBe('locked');
    await pool.query(`DELETE FROM login_failures`);
  });
});

describe('files, exports, community and set-up', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]).toString('base64');
  it('checks file contents and keeps payment evidence private', async () => {
    const ama = await as(app, 'ama'), abena = await as(app, 'abena'), kofi = await as(app, 'kofi');
    expect((await ama.post('/api/files', { kind: 'payment_evidence', fileName: 'x.pdf', mime: 'application/pdf', dataBase64: jpeg })).statusCode).toBe(400);
    const f = (await ama.post('/api/files', { kind: 'payment_evidence', fileName: 'slip.jpg', mime: 'image/jpeg', dataBase64: jpeg })).json();
    expect((await ama.get('/api/files/' + f.id)).statusCode).toBe(200);
    expect((await abena.get('/api/files/' + f.id)).statusCode).toBe(403);
    expect((await kofi.get('/api/files/' + f.id)).statusCode).toBe(200);
    expect((await ama.post('/api/files', { kind: 'site_photo', fileName: 'site.jpg', mime: 'image/jpeg', dataBase64: jpeg })).statusCode).toBe(403);
  });
  it('exports CSV with formula injection neutralised, and only to the right roles', async () => {
    const ama = await as(app, 'ama'), yaw = await as(app, 'yaw');
    expect((await ama.get('/api/exports/payments')).statusCode).toBe(403);
    await pool.query(`UPDATE payments SET receipt_no='=HYPERLINK("x")' WHERE id=(SELECT id FROM payments WHERE receipt_no IS NOT NULL LIMIT 1)`);
    const body = (await yaw.get('/api/exports/payments')).body;
    expect(body).toContain(`"'=HYPERLINK(""x"")"`);
    expect((await ama.get('/api/exports/my-statement')).statusCode).toBe(200);
  });
  it('announcements and events: committee posts, members RSVP', async () => {
    const ama = await as(app, 'ama'), akosua = await as(app, 'akosua');
    expect((await ama.post('/api/announcements', { title: 'Hello', body: 'Not allowed' })).statusCode).toBe(403);
    expect((await akosua.post('/api/announcements', { title: 'Groundbreaking', body: 'Join us at PRESEC Legon.' })).statusCode).toBe(200);
    const e = (await akosua.post('/api/events', { title: 'Ɔdadeɛ 2003 reunion', startsAt: '2026-12-12T10:00:00Z', venue: 'PRESEC Legon assembly hall' })).json();
    expect((await ama.post(`/api/events/${e.id}/rsvp`, { response: 'yes', guests: 2 })).statusCode).toBe(200);
    const ev = (await ama.get('/api/events')).json().find((x: any) => x.id === e.id);
    expect(ev).toMatchObject({ going: 1, guests: 2, my_response: 'yes' });
  });
  it('set-up rules: one baseline, weights ≤ 100%, audited settings, one period in force', async () => {
    const akosua = await as(app, 'akosua'), nana = await as(app, 'nana'), ama = await as(app, 'ama');
    const bl = await akosua.post('/api/setup/baseline', { contractGhs: 1, feesGhs: 1, contingencyGhs: 1, approvedBy: 'x vote' }); expect(bl.statusCode, bl.body).toBe(409);
    expect((await nana.post('/api/setup/work-packages', { id: 'WP12', name: 'Extra', weightPct: 5, budgetGhs: 1000 })).statusCode).toBe(400);
    expect((await ama.post('/api/settings', { dualApprovalAboveGhs: 1 })).statusCode).toBe(403);
    expect((await akosua.post('/api/settings', { dualApprovalAboveGhs: 40000 })).statusCode).toBe(200);
    const [a] = await q<any>(pool, `SELECT detail FROM audit_events WHERE action='Changed setting' ORDER BY seq DESC LIMIT 1`);
    expect(a.detail).toBe('5000000 → 4000000');
    const fp = await akosua.post('/api/setup/first-period', { version: '9', periodName: 'Next drive', start: '2027-01-01', end: '2027-06-01', perMemberTargetGhs: 100, weightTarget: 60, approvedBy: 'EC resolution' }); expect(fp.statusCode, fp.body).toBe(409);
    const ins = await nana.post('/api/setup/inspections', { wpId: 'WP04', inspectedOn: '2026-10-13', inspector: 'Ing. Agyei', result: 'passed_with_defect', note: 'Blockwork', defect: { title: 'Crack in wall W2', action: 'Rebuild course', dueOn: '2026-10-30' } });
    expect(ins.json().defectId).toMatch(/^DEF-/);
  });
  it('profile: members edit their own contact details and preferences', async () => {
    const ama = await as(app, 'ama');
    expect((await ama.post('/api/me/profile', { phone: 'abc' })).statusCode).toBe(400);
    expect((await ama.post('/api/me/profile', { phone: '024 555 0101', smsReminders: false })).statusCode).toBe(200);
    expect((await ama.get('/api/me/profile')).json()).toMatchObject({ phone: '233245550101', sms_reminders: false });
  });
});
