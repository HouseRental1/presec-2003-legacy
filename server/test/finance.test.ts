import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fresh, as, pool, q, signed, memberNo, config } from './helpers.js';
import type { App } from '../src/app.js';
import { standings } from '../src/services/competition.js';

let app: App;
beforeAll(async () => { app = await fresh(); });
afterAll(async () => { await app.close(); });

const sumLedger = async () => (await q<any>(pool, 'SELECT sum(debit) d, sum(credit) c FROM ledger_entries'))[0];

describe('AC-02 a verified payment updates statement, project total and house ranking exactly once', () => {
  it('posts once and every view reads the same entry', async () => {
    const ama = await as(app, 'ama');
    const before = { st: (await ama.get('/api/me/statement')).json(), dash: (await ama.get('/api/dashboard')).json(), lb: (await ama.get('/api/standings')).json() };
    const init = await ama.post('/api/payments/initiate', { amount: 250, currency: 'GHS', channel: 'momo', network: 'MTN MoMo' });
    expect(init.statusCode).toBe(200);
    const done = await ama.post(`/api/sandbox/complete/${init.json().paymentId}`);
    expect(done.json().outcome).toBe('verified');
    const after = { st: (await ama.get('/api/me/statement')).json(), dash: (await ama.get('/api/dashboard')).json(), lb: (await ama.get('/api/standings')).json() };
    expect(after.st.paid - before.st.paid).toBe(25000);
    expect(after.dash.cashReceived - before.dash.cashReceived).toBe(25000);
    const h = (x: any) => x.rows.find((r: any) => r.houseId === 'H1').raised;
    expect(h(after.lb) - h(before.lb)).toBe(25000);
    // replaying the same provider event changes nothing
    const replay = await ama.post(`/api/sandbox/complete/${init.json().paymentId}`);
    expect(replay.json().outcome).toBe('duplicate_event_ignored');
    expect((await ama.get('/api/dashboard')).json().cashReceived).toBe(after.dash.cashReceived);
  });
});

describe('AC-15 webhooks are authenticated, idempotent and checked', () => {
  it('rejects a bad signature', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/webhooks/payments/sandbox', payload: '{"eventId":"x"}', headers: { 'content-type': 'application/json', 'x-signature': 'deadbeef' } });
    expect(r.statusCode).toBe(401);
  });
  it('sends a provider amount mismatch to exceptions instead of posting', async () => {
    const ama = await as(app, 'ama');
    const init = (await ama.post('/api/payments/initiate', { amount: 100, currency: 'GHS', channel: 'momo' })).json();
    const [p] = await q<any>(pool, 'SELECT external_ref FROM payments WHERE id=$1', [init.paymentId]);
    const { raw, sig } = signed({ eventId: 'evt-mismatch', reference: p.external_ref, status: 'success', currency: 'GHS', amount: 1000 });
    const r = await app.inject({ method: 'POST', url: '/api/webhooks/payments/sandbox', payload: raw, headers: { 'content-type': 'application/json', 'x-signature': sig } });
    expect(r.json().outcome).toBe('mismatch');
    const [row] = await q<any>(pool, 'SELECT status FROM payments WHERE id=$1', [init.paymentId]);
    expect(row.status).toBe('exception');
    expect((await q(pool, `SELECT 1 FROM ledger_transactions WHERE source_id=$1`, [init.paymentId])).length).toBe(0);
  });
  it('converts a GBP card payment at the settlement rate and keeps the original amount', async () => {
    await pool.query(`UPDATE members SET home_currency='GBP' WHERE member_no=$1`, [await memberNo('ama')]);
    const ama = await as(app, 'ama');
    const init = (await ama.post('/api/payments/initiate', { amount: 50, currency: 'GBP', channel: 'card' })).json();
    const [p] = await q<any>(pool, 'SELECT external_ref FROM payments WHERE id=$1', [init.paymentId]);
    const { raw, sig } = signed({ eventId: 'evt-gbp', reference: p.external_ref, status: 'success', currency: 'GBP', amount: 5000, settlementRate: 20.1 });
    await app.inject({ method: 'POST', url: '/api/webhooks/payments/sandbox', payload: raw, headers: { 'content-type': 'application/json', 'x-signature': sig } });
    const [row] = await q<any>(pool, 'SELECT amount_original, currency, fx_rate, amount_ghs, fee_ghs FROM payments WHERE id=$1', [init.paymentId]);
    expect(row).toMatchObject({ amount_original: 5000, currency: 'GBP', fx_rate: 20.1, amount_ghs: 100500 });
    expect(row.fee_ghs).toBe(Math.round(100500 * 0.025)); // fee is a cost; the member is credited gross
  });
  it('refuses MoMo in a foreign currency', async () => {
    const ama = await as(app, 'ama');
    expect((await ama.post('/api/payments/initiate', { amount: 50, currency: 'USD', channel: 'momo' })).statusCode).toBe(400);
  });
});

describe('AC-03 pledges are never counted as cash', () => {
  it('a new pledge changes pledged totals only', async () => {
    const ama = await as(app, 'ama');
    const d0 = (await ama.get('/api/dashboard')).json();
    expect((await ama.post('/api/pledges', { amountGhs: 4000, instalments: 4 })).statusCode).toBe(200);
    const d1 = (await ama.get('/api/dashboard')).json();
    expect(d1.cashReceived).toBe(d0.cashReceived);
    expect(d1.pledged).not.toBe(d0.pledged);
    const lb = (await ama.get('/api/standings')).json();
    const recomputed = await standings(pool);
    expect(lb.rows.map((r: any) => r.raised)).toEqual(recomputed.rows.map((r) => r.raised));
  });
});

describe('maker-checker on manual payments', () => {
  it('the recorder cannot verify; a different officer can', async () => {
    const kofi = await as(app, 'kofi'), efua = await as(app, 'efua');
    const rec = await kofi.post('/api/finance/payments', { memberNo: 'CY-0010', amountGhs: 300, channel: 'cash', ref: 'CSH-T1', paidOn: new Date().toISOString().slice(0, 10), note: 'receipt 0501' });
    expect(rec.statusCode).toBe(200);
    const id = rec.json().id;
    const self = await kofi.post(`/api/finance/payments/${id}/verify`);
    expect(self.statusCode).toBe(403);
    expect(self.json().message).toMatch(/different person/);
    expect((await efua.post(`/api/finance/payments/${id}/verify`)).statusCode).toBe(200);
  });
  it('blocks a duplicate bank reference', async () => {
    const kofi = await as(app, 'kofi');
    const body = { memberNo: 'CY-0011', amountGhs: 100, channel: 'bank', ref: 'BNK-DUP-1', paidOn: '2026-01-01', note: '' };
    expect((await kofi.post('/api/finance/payments', body)).statusCode).toBe(200);
    expect((await kofi.post('/api/finance/payments', body)).statusCode).toBe(409);
  });
  it('an unmatched credit must be assigned, then verified by someone else', async () => {
    const kofi = await as(app, 'kofi'), efua = await as(app, 'efua');
    const [p] = await q<any>(pool, `SELECT id FROM payments WHERE status='exception' AND member_id IS NULL LIMIT 1`);
    expect((await efua.post(`/api/finance/payments/${p.id}/verify`)).statusCode).toBe(409);
    expect((await kofi.post(`/api/finance/payments/${p.id}/assign`, { memberNo: 'CY-0012' })).statusCode).toBe(200);
    expect((await kofi.post(`/api/finance/payments/${p.id}/verify`)).statusCode).toBe(403);
    expect((await efua.post(`/api/finance/payments/${p.id}/verify`)).statusCode).toBe(200);
  });
});

describe('AC-04 reversals keep the original history', () => {
  it('requires two people and adds a linked reversing entry', async () => {
    const kofi = await as(app, 'kofi'), efua = await as(app, 'efua');
    const [p] = await q<any>(pool, `SELECT id, amount_ghs, member_id FROM payments WHERE status='verified' AND source='manual' AND category='member' LIMIT 1`);
    const before = (await kofi.get('/api/dashboard')).json().cashReceived;
    expect((await kofi.post(`/api/finance/payments/${p.id}/reversal-request`, { reason: 'Paid twice by mistake' })).statusCode).toBe(200);
    expect((await kofi.post(`/api/finance/payments/${p.id}/reversal-confirm`)).statusCode).toBe(403);
    expect((await efua.post(`/api/finance/payments/${p.id}/reversal-confirm`)).statusCode).toBe(200);
    expect((await kofi.get('/api/dashboard')).json().cashReceived).toBe(before - p.amount_ghs);
    const txns = await q<any>(pool, `SELECT kind, reversal_of FROM ledger_transactions WHERE source_id=$1 ORDER BY posted_at`, [p.id]);
    expect(txns.map((t) => t.kind)).toEqual(['contribution', 'reversal']);
    expect(txns[1].reversal_of).not.toBeNull();
  });
  it('the database itself refuses edits or deletes of posted entries and audit events', async () => {
    await expect(pool.query('UPDATE ledger_entries SET debit = debit + 1 WHERE id = (SELECT min(id) FROM ledger_entries)')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM ledger_transactions WHERE true')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM audit_events WHERE true')).rejects.toThrow(/append-only/);
  });
  it('the database refuses an unbalanced transaction', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const [{ id }] = (await c.query(`INSERT INTO ledger_transactions (project_id, kind, source_type, source_id, effective_date, memo) VALUES ('P1','test','test','x',current_date,'bad') RETURNING id`)).rows;
      await c.query(`INSERT INTO ledger_entries (txn_id, account, debit) VALUES ($1,'BANK',100)`, [id]);
      await expect(c.query('COMMIT')).rejects.toThrow(/not balanced/);
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  });
});

describe('AC-06 restricted payments cannot be self-approved or bypass approval', () => {
  it('enforces requester ≠ approver, two distinct approvers, conflict recusal and approver ≠ releaser', async () => {
    const nana = await as(app, 'nana'), efua = await as(app, 'efua'), akosua = await as(app, 'akosua'), kofi = await as(app, 'kofi');
    const { requests } = (await kofi.get('/api/requests')).json();
    const ipc2 = requests.find((r: any) => r.certificate_id === 'IPC-02');
    expect(ipc2.required_approvals).toBe(2);
    expect((await efua.post(`/api/requests/${ipc2.id}/decision`, { decision: 'approved' })).json().message).toMatch(/already decided/);
    expect((await kofi.post(`/api/requests/${ipc2.id}/release`)).statusCode).toBe(409); // only 1 of 2
    expect((await akosua.post(`/api/requests/${ipc2.id}/decision`, { decision: 'approved' })).json().status).toBe('approved');
    // a member of the requesting team cannot approve their own request
    const own = (await nana.post('/api/requests', { title: 'Engineer supervision', payee: 'Mensa & Partners QS', amountGhs: 3500 })).json();
    expect((await nana.post(`/api/requests/${own.id}/decision`, { decision: 'approved' })).statusCode).toBe(403);
    // Efua declared an interest in Mensa & Partners
    const coi = await efua.post(`/api/requests/${own.id}/decision`, { decision: 'approved' });
    expect(coi.statusCode).toBe(403); expect(coi.json().message).toMatch(/declared an interest/);
    // release: treasurer only, and enough reconciled cash
    expect((await akosua.post(`/api/requests/${ipc2.id}/release`)).statusCode).toBe(403);
    const bank0 = (await kofi.get('/api/dashboard')).json().bank;
    const rel = await kofi.post(`/api/requests/${ipc2.id}/release`);
    expect(rel.statusCode).toBe(200);
    const d = (await kofi.get('/api/dashboard')).json();
    expect(bank0 - d.bank).toBe(7740000);       // due = 182,000 − 18,200 − 86,400
    expect(d.retention).toBe(1820000);           // 10% of work certified to date
  });
  it('certificate arithmetic: due = certified to date − retention − paid before', async () => {
    const nana = await as(app, 'nana');
    const c = (await nana.post('/api/certificates', { contractId: 'CON-01', grossToDateGhs: 250000, issuedOn: '2026-12-01', issuedBy: 'Mensa & Partners QS' })).json();
    expect(c).toMatchObject({ retention: 2500000, previousPaid: 16380000, due: 25000000 - 2500000 - 16380000 });
    expect((await nana.post('/api/certificates', { contractId: 'CON-01', grossToDateGhs: 10_000_000, issuedOn: '2026-12-05', issuedBy: 'QS' })).statusCode).toBe(400);
  });
});

describe('AC-12 financial reports reconcile to the ledger', () => {
  it('receipts − costs − fees = bank + clearing + suspense, and the trial balance balances', async () => {
    const kofi = await as(app, 'kofi');
    const r = (await kofi.get('/api/finance/report')).json();
    const lhs = r.receipts.members + r.receipts.donors - r.payments.projectCostsPaid - r.payments.fees;
    expect(lhs).toBe(r.closing.bank + r.closing.clearing + r.closing.suspense);
    const tb = (await kofi.get('/api/finance/ledger')).json().trial;
    expect(tb.balanced).toBe(true);
    const s = await sumLedger(); expect(s.d).toBe(s.c);
  });
  it('a settlement short-paid by the provider is parked in suspense, not hidden', async () => {
    const kofi = await as(app, 'kofi');
    const exp = (await q<any>(pool, `SELECT sum(amount_ghs-fee_ghs) v FROM payments WHERE status='verified' AND source='gateway' AND settlement_id IS NULL`))[0].v;
    const s = (await kofi.post('/api/finance/settlements', { provider: 'sandbox', statementGhs: (exp - 500) / 100 })).json();
    expect(s.status).toBe('difference');
    expect((await kofi.get('/api/finance/report')).json().closing.suspense).toBe(500);
  });
});

void config;
