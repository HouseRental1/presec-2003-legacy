import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fresh, as, token, pool, q, config } from './helpers.js';
import type { App } from '../src/app.js';
import { standings } from '../src/services/competition.js';
import { totp } from '../src/lib.js';

let app: App;
beforeAll(async () => { app = await fresh(); });
afterAll(async () => { await app.close(); });

describe('AC-01 accounts: register, confirm, suspend, roles', () => {
  it('only an administrator can register and confirm members', async () => {
    const kwame = await as(app, 'kwame'), ama = await as(app, 'ama');
    const body = { fullName: 'Esi Quaye', memberNo: 'P03-0999', houseId: 'H3', email: 'esi@presec2003.test', password: 'a-long-password-1' };
    expect((await ama.post('/api/members', body)).statusCode).toBe(403);
    expect((await kwame.post('/api/members', body)).statusCode).toBe(200);
    expect((await kwame.post('/api/members', body)).statusCode).toBe(409);
    expect((await kwame.post('/api/members/P03-0999/verify')).statusCode).toBe(200);
  });
  it('a suspended account cannot sign in', async () => {
    await pool.query(`UPDATE users SET status='suspended' WHERE email='esi@presec2003.test'`);
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'esi@presec2003.test', password: 'a-long-password-1' } });
    expect(r.statusCode).toBe(403);
  });
  it('wrong password and unknown email give the same answer', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ama@presec2003.test', password: 'nope' } });
    const b = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@presec2003.test', password: 'nope' } });
    expect(a.statusCode).toBe(401); expect(a.json()).toEqual(b.json());
  });
});

describe('AC-05 private information is protected', () => {
  it('signed-out requests are refused; members cannot read the ledger, queues or audit trail', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/dashboard' })).statusCode).toBe(401);
    const ama = await as(app, 'ama');
    for (const url of ['/api/finance/ledger', '/api/finance/queues', '/api/audit', '/api/finance/report', '/api/requests']) expect((await ama.get(url)).statusCode, url).toBe(403);
  });
  it('the directory never exposes amounts or phone numbers', async () => {
    const ama = await as(app, 'ama');
    const d = (await ama.get('/api/members?q=P03-00')).json();
    expect(Object.keys(d.rows[0]).sort()).toEqual(['city', 'full_name', 'house_id', 'member_no', 'profession']);
  });
  it('captains see names of non-contributors only, and cannot edit payments', async () => {
    const abena = await as(app, 'abena');
    const o = (await abena.get('/api/captain/outreach')).json();
    expect(o.houseId).toBe('H2');
    expect(Object.keys(o.notYet[0] ?? { member_no: 1, full_name: 1, city: 1 }).sort()).toEqual(['city', 'full_name', 'member_no']);
    expect((await abena.post('/api/finance/payments', { memberNo: 'P03-0002', amountGhs: 1, channel: 'cash', ref: 'X-1', paidOn: '2026-01-01' })).statusCode).toBe(403);
  });
  it('cookie sessions need the app header on writes (CSRF)', async () => {
    const t = await token(app, 'ama');
    const r = await app.inject({ method: 'POST', url: '/api/pledges', payload: { amountGhs: 100, instalments: 1 }, cookies: { sid: t } });
    expect(r.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/pledges', payload: { amountGhs: 100, instalments: 1 }, cookies: { sid: t }, headers: { 'x-requested-with': 'class-legacy' } });
    expect(ok.statusCode).toBe(200);
  });
});

describe('AC-07 / AC-08 house rankings are reproducible and history survives corrections', () => {
  it('standings match an independent calculation from raw records', async () => {
    const api = (await (await as(app, 'ama')).get('/api/standings')).json();
    const rule = (await q<any>(pool, `SELECT * FROM competition_rules WHERE status='in_force'`))[0];
    const raw = await q<any>(pool, `SELECT hm.house_id, sum(p.amount_ghs)::bigint raised, count(DISTINCT p.member_id)::int n FROM payments p
      JOIN house_memberships hm ON hm.member_id=p.member_id AND hm.valid_from<=p.paid_on AND (hm.valid_to IS NULL OR hm.valid_to>=p.paid_on)
      WHERE p.status='verified' AND p.category='member' AND p.paid_on BETWEEN $1 AND least($2, current_date) GROUP BY 1`, [rule.period_start, rule.period_end]);
    for (const r of raw) {
      const row = api.rows.find((x: any) => x.houseId === r.house_id);
      const elig = rule.eligible_snapshot[r.house_id];
      const ach = r.raised / (elig * rule.per_member_target), part = r.n / elig;
      expect(row.raised).toBe(r.raised);
      expect(row.score).toBeCloseTo(60 * Math.min(ach, 1.2) / 1.2 + 40 * part, 2);
    }
    const sorted = [...api.rows].sort((a: any, b: any) => b.score - a.score);
    expect(api.rows.map((r: any) => r.houseId)).toEqual(sorted.map((r: any) => r.houseId));
  });
  it('a donation counts for the project but not for any house', async () => {
    const [{ v }] = await q<any>(pool, `SELECT sum(amount_ghs) v FROM payments WHERE category='donor' AND status='verified'`);
    expect(v).toBeGreaterThan(0);
    const s = await standings(pool);
    const [{ m }] = await q<any>(pool, `SELECT sum(amount_ghs) m FROM payments p WHERE category='member' AND status='verified' AND paid_on >= (SELECT period_start FROM competition_rules WHERE status='in_force')`);
    expect(s.rows.reduce((a, r) => a + r.raised, 0)).toBe(m);
  });
  it('correcting a house keeps earlier payments with the earlier house', async () => {
    const kwame = await as(app, 'kwame');
    const [p] = await q<any>(pool, `SELECT m.member_no, hm.house_id, p.amount_ghs FROM payments p JOIN members m ON m.id=p.member_id JOIN house_memberships hm ON hm.member_id=m.id AND hm.valid_to IS NULL
      WHERE p.status='verified' AND p.category='member' AND m.user_id IS NULL ORDER BY p.paid_on LIMIT 1`);
    const before = await standings(pool);
    const target = p.house_id === 'H1' ? 'H2' : 'H1';
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    expect((await kwame.post(`/api/members/${p.member_no}/house`, { houseId: target, validFrom: tomorrow, reason: 'School register shows a different house' })).statusCode).toBe(200);
    const after = await standings(pool);
    expect(after.rows.map((r) => [r.houseId, r.raised]).sort()).toEqual(before.rows.map((r) => [r.houseId, r.raised]).sort());
    expect((await (await as(app, 'abena')).post(`/api/members/${p.member_no}/house`, { houseId: 'H3', validFrom: tomorrow, reason: 'captain trying' })).statusCode).toBe(403);
  });
});

describe('AC-09 secret ballot with eligibility, one vote each, quorum and thresholds', () => {
  it('one vote per member; choice is not linked to the voter', async () => {
    const ama = await as(app, 'ama');
    expect((await ama.post('/api/proposals/P2/vote', { choice: 'yes' })).statusCode).toBe(200);
    expect((await ama.post('/api/proposals/P2/vote', { choice: 'no' })).json().message).toMatch(/already voted/);
    const cols = (await q<any>(pool, `SELECT column_name FROM information_schema.columns WHERE table_name='ballots'`)).map((c) => c.column_name).sort();
    expect(cols).toEqual(['choice', 'proposal_id', 'token']);
    const [{ r }] = await q<any>(pool, `SELECT count(*)::int r FROM voter_roll WHERE proposal_id='P2'`);
    const [{ b }] = await q<any>(pool, `SELECT count(*)::int b FROM ballots WHERE proposal_id='P2'`);
    expect(r).toBe(b);
  });
  it('unverified members cannot vote; open results stay hidden', async () => {
    await pool.query(`UPDATE members SET verified_at=NULL WHERE user_id=(SELECT id FROM users WHERE email='abena@presec2003.test')`);
    expect((await (await as(app, 'abena')).post('/api/proposals/P3/vote', { choice: 'yes' })).statusCode).toBe(403);
    const list = (await (await as(app, 'ama')).get('/api/proposals')).json();
    expect(list.find((p: any) => p.id === 'P2').yes).toBeNull();
  });
  it('fails without quorum; passes and applies the linked variation as a new budget version when quorum is met', async () => {
    const akosua = await as(app, 'akosua');
    const p = (await akosua.post('/api/proposals', { title: 'Quorum test ballot', description: 'Test ballot for the rules engine', threshold: 'simple', quorumPct: 90, opensOn: '2020-01-01', closesOn: '2099-01-01' })).json();
    expect((await akosua.post(`/api/proposals/${p.id}/vote`, { choice: 'yes' })).statusCode).toBe(200);
    expect((await akosua.post(`/api/proposals/${p.id}/close`)).json().result).toBe('no_quorum');
    // P2 already has ~24% turnout + Ama; add 30 voters to pass the 30% quorum, then close
    const { castVote } = await import('../src/services/governance.js');
    const { tx } = await import('../src/lib.js');
    const extra = await q<any>(pool, `SELECT id FROM members WHERE verified_at IS NOT NULL AND id NOT IN (SELECT member_id FROM voter_roll WHERE proposal_id='P2') LIMIT 30`);
    await tx(async (db) => { for (const m of extra) await castVote(db, { userId: null as any, name: 'x', roles: ['member'], memberId: m.id, mfaPassed: true, extra: ['vote'] }, 'P2', 'yes'); });
    const res = (await akosua.post('/api/proposals/P2/close')).json();
    expect(res.result).toBe('passed');
    const bv = await q<any>(pool, `SELECT version, total FROM budget_versions ORDER BY version`);
    expect(bv.map((b) => b.version)).toEqual([1, 2]);                  // baseline kept (AC-11)
    expect(bv[1].total).toBe(bv[0].total + 11800000 - (4000000 - 1450000)); // contingency balance applied first
    expect((await q<any>(pool, `SELECT status FROM variations WHERE id='VAR-02'`))[0].status).toBe('approved');
  });
  it('two-thirds threshold is applied', async () => {
    const akosua = await as(app, 'akosua');
    const p = (await akosua.post('/api/proposals', { title: 'Two-thirds test', description: 'Test ballot for the rules engine', threshold: 'two_thirds', quorumPct: 0, opensOn: '2020-01-01', closesOn: '2099-01-01' })).json();
    const { castVote } = await import('../src/services/governance.js');
    const { tx } = await import('../src/lib.js');
    const ms = await q<any>(pool, `SELECT id FROM members WHERE verified_at IS NOT NULL LIMIT 5`);
    await tx(async (db) => { for (const [i, m] of ms.entries()) await castVote(db, { userId: null as any, name: 'x', roles: ['member'], memberId: m.id, mfaPassed: true, extra: ['vote'] }, p.id, i < 3 ? 'yes' : 'no'); });
    expect((await akosua.post(`/api/proposals/${p.id}/close`)).json().result).toBe('not_passed'); // 60% < 66.7%
  });
});

describe('AC-10 construction progress needs evidence from different people', () => {
  it('report → verify (someone else) → accept; open defect blocks 100%', async () => {
    const nana = await as(app, 'nana'), akosua = await as(app, 'akosua');
    expect((await nana.post('/api/project/wp/WP03/report', { pct: 100, evidence: 'Photos and daily log' })).statusCode).toBe(200);
    expect((await nana.post('/api/project/wp/WP03/verify', { pct: 100, evidence: 'self' })).statusCode).toBe(403);
    expect((await akosua.post('/api/project/wp/WP03/verify', { pct: 100, evidence: 'Site visit' })).statusCode).toBe(200);
    const blocked = await nana.post('/api/project/wp/WP03/accept', { pct: 100, evidence: 'Engineer sign-off', inspector: 'Ing. Agyei' });
    expect(blocked.statusCode).toBe(409);
    expect((await nana.post('/api/project/defects/DEF-01/close', { evidence: 'Re-inspection photos' })).statusCode).toBe(200);
    expect((await nana.post('/api/project/wp/WP03/accept', { pct: 100, evidence: 'Engineer sign-off', inspector: 'Ing. Agyei' })).statusCode).toBe(200);
    expect((await akosua.post('/api/project/wp/WP04/verify', { pct: 50, evidence: 'over-report' })).statusCode).toBe(400);
    const events = await q<any>(pool, `SELECT stage FROM progress_events WHERE wp_id='WP03' ORDER BY id`);
    expect(events.length).toBeGreaterThanOrEqual(5);
  });
  it('variations above the threshold cannot be approved by the committee alone', async () => {
    const nana = await as(app, 'nana'), akosua = await as(app, 'akosua');
    const big = (await nana.post('/api/project/variations', { title: 'Second storey', amountGhs: 250000, reason: 'test' })).json();
    expect(big.route).toBe('member_vote');
    expect((await akosua.post(`/api/project/variations/${big.id}/decision`, { approve: true })).statusCode).toBe(403);
  });
});

describe('AC-14 privileged accounts need two-factor sign-in when enforced', () => {
  it('blocks privileged actions without a code and allows them with one', async () => {
    config.requireMfa = true;
    try {
      const secret = 'JBSWY3DPEHPK3PXP';
      await pool.query(`UPDATE users SET totp_secret=$1 WHERE email='kofi@presec2003.test'`, [secret]);
      const noCode = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'kofi@presec2003.test', password: 'Legacy-demo-2026' } });
      expect(noCode.json().error).toBe('mfa_required');
      const t = await token(app, 'kofi', totp(secret));
      expect((await app.inject({ method: 'GET', url: '/api/finance/ledger', headers: { authorization: 'Bearer ' + t } })).statusCode).toBe(200);
      // a privileged user with no authenticator yet can sign in but cannot act until enrolled
      const efua = await as(app, 'efua');
      expect((await efua.get('/api/finance/ledger')).statusCode).toBe(403);
      // ordinary members are unaffected
      expect((await (await as(app, 'ama')).get('/api/me/statement')).statusCode).toBe(200);
    } finally { config.requireMfa = false; }
  });
});

describe('AC-17/18 audit trail integrity and the legacy archive', () => {
  it('every action is chained; the chain verifies', async () => {
    const yaw = await as(app, 'yaw');
    const v = (await yaw.get('/api/audit/verify')).json();
    expect(v.ok).toBe(true); expect(v.count).toBeGreaterThan(100);
    expect((await (await as(app, 'ama')).get('/api/audit/verify')).statusCode).toBe(403);
  });
  it('handover documents and maintenance work are recorded and retrievable', async () => {
    const nana = await as(app, 'nana');
    expect((await nana.post('/api/legacy/handover/HO-02', { documentRef: 'DRG-ASBUILT-001' })).statusCode).toBe(200);
    expect((await nana.post('/api/legacy/maintenance/2/log', { doneOn: '2027-05-01', note: 'Gutters cleared before rains', costGhs: 450 })).statusCode).toBe(200);
    const a = (await (await as(app, 'gifty')).get('/api/legacy')).json();
    expect(a.handover.find((h: any) => h.id === 'HO-02').status).toBe('received');
    expect(a.maintenance.find((m: any) => m.id === 2).log[0].note).toMatch(/Gutters/);
  });
  it('administrators are capped', async () => {
    const kwame = await as(app, 'kwame');
    await pool.query(`INSERT INTO user_roles (user_id, role) SELECT id, 'admin' FROM users WHERE email IN ('yaw@presec2003.test','nana@presec2003.test','efua@presec2003.test','kofi@presec2003.test')`);
    const [{ id }] = await q<any>(pool, `SELECT id FROM users WHERE email='ama@presec2003.test'`);
    const { grantRole } = await import('../src/services/members.js');
    const { tx } = await import('../src/lib.js');
    const actor = { userId: (await q<any>(pool, `SELECT id FROM users WHERE email='kwame@presec2003.test'`))[0].id, name: 'Kwame', roles: ['admin' as const], memberId: null, mfaPassed: true };
    await expect(tx((db) => grantRole(db, actor, id, 'admin'))).rejects.toThrow(/limit 5/);
    void kwame;
  });
});
