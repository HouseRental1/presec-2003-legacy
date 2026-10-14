/**
 * Development seed: SAMPLE people, firms, houses and figures only.
 * Every financial record is created through the same service functions the app uses,
 * so the seeded ledger obeys every rule (maker-checker, balanced postings, audit chain).
 */
import { fileURLToPath } from 'node:url';
import { pool, tx, q, hashPassword, Actor, Role, hmacHex, config } from './lib.js';
import { resetDatabase } from './migrate.js';
import { ACCOUNTS } from './services/ledger.js';
import * as P from './services/payments.js';
import * as F from './services/finance.js';
import * as J from './services/project.js';
import * as G from './services/governance.js';
import { freezeEligible } from './services/competition.js';

export const DEMO_PASSWORD = 'Legacy-demo-2026';
export const STAFF = [
  { key: 'ama', name: 'Ama Mensah', roles: ['member'], house: 'H1' },
  { key: 'kofi', name: 'Kofi Boateng', roles: ['treasurer', 'member'], house: 'H2' },
  { key: 'efua', name: 'Efua Owusu', roles: ['approver', 'member'], house: 'H3' },
  { key: 'yaw', name: 'Yaw Asante', roles: ['auditor', 'member'], house: 'H4' },
  { key: 'nana', name: 'Nana Adjei', roles: ['pm', 'member'], house: 'H1' },
  { key: 'abena', name: 'Abena Darko', roles: ['captain', 'member'], house: 'H2' },
  { key: 'kwame', name: 'Kwame Ofori', roles: ['admin', 'member'], house: 'H3' },
  { key: 'akosua', name: 'Akosua Frimpong', roles: ['committee', 'member'], house: 'H4' },
  { key: 'gifty', name: 'Mrs Gifty Amankwah', roles: ['school'], house: null },
] as const;

function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export async function seed({ members = 380, quiet = false } = {}) {
  await resetDatabase();
  const R = rng(20261013); const pick = <T,>(a: readonly T[]) => a[Math.floor(R() * a.length)];
  const T = new Date().toISOString().slice(0, 10);
  const start = addDays(T, -71);
  const users: Record<string, Actor> = {};

  await tx(async (db) => {
    for (const [code, a] of Object.entries(ACCOUNTS)) await db.query('INSERT INTO ledger_accounts VALUES ($1,$2,$3)', [code, a.name, a.normal]);
    const settings: Record<string, unknown> = {
      dual_approval_above: 5_000_000, member_vote_above: 10_000_000, admin_cap: 5, quorum_bp: 3000, member_participation: true,
      fees: { momo_bp: 100, card_bp: 250 }, fx_indicative: { GHS: 1, USD: 15.6, GBP: 20.4 },
      custody: { entity: 'Registered association — name and number to confirm', signatories: '2 of 3 named signatories (to confirm)' },
    };
    for (const [k, v] of Object.entries(settings)) await db.query('INSERT INTO settings VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, JSON.stringify(v)]);
    for (const [id, name] of [['H1', 'Kwansa'], ['H2', 'Clerk'], ['H3', 'Engmann'], ['H4', 'Akro'], ['H5', 'Riis'], ['H6', 'Labone'], ['H7', 'Ako-Adjei'], ['H8', 'Owusu-Parry']]) await db.query('INSERT INTO houses VALUES ($1,$2)', [id, name]);
    await db.query(`INSERT INTO projects VALUES ('P1','Legacy Project 1: six-unit classroom block, PRESEC Legon','construction')`);
    await db.query(`UPDATE projects SET site='PRESEC Legon campus, Accra', sponsor='Ɔdadeɛ 2003 year group (executive committee)', school_contact='Headmaster’s office, PRESEC Legon',
      description='A six-unit classroom block given to Presbyterian Boys’ Secondary School, Legon, by the Ɔdadeɛ 2003 year group.',
      objectives='Relieve overcrowding with six new classrooms; leave a lasting gift from the Class of 2003.', scope='Six classrooms, veranda, accessible ramp, electrical and drainage works.' WHERE id='P1'`);
    await db.query(`SELECT create_lifecycle('P1')`);
    await db.query(`INSERT INTO budget_versions (project_id, version, total, lines, approved_by, note) VALUES ('P1',1,82000000,$1,'Member vote P1 + committee resolution','Baseline approved with contract award')`,
      [JSON.stringify({ contract: 74200000, fees: 3800000, contingency: 4000000 })]);

    const hash = await hashPassword(DEMO_PASSWORD);
    const F_ = ['Kwame','Kofi','Kwabena','Kwaku','Yaw','Kwesi','Kojo','Ama','Akosua','Abena','Akua','Yaa','Afua','Efua','Adwoa','Esi','Nana','Selorm','Edem','Delali','Elikem','Naa','Nii','Ato','Ekow','Fiifi','Araba','Mawuli','Sena','Dzifa','Zainab','Abdul','Fatima','Ibrahim','Mercy','Gifty','Emmanuel','Comfort','Samuel','Patience'];
    const L_ = ['Mensah','Boateng','Owusu','Asante','Adjei','Darko','Ofori','Frimpong','Tetteh','Agyeman','Appiah','Osei','Amoah','Quaye','Lartey','Addo','Annan','Badu','Gyamfi','Nkansah','Ansah','Sarpong','Amponsah','Agbeko','Dogbe','Kpodo','Issah','Bawa','Quartey','Aryee','Donkor','Opoku','Acquah','Danquah','Yeboah'];
    // PRESEC's eight original houses (sizes differ, as they do in real life)
    const share = { H1: 0.137, H2: 0.132, H3: 0.129, H4: 0.126, H5: 0.124, H6: 0.121, H7: 0.118 };
    const counts: Record<string, number> = Object.fromEntries(Object.entries(share).map(([h, x]) => [h, Math.round(members * x)]));
    counts.H8 = members - Object.values(counts).reduce((a, b) => a + b, 0);
    const fixedHouses = STAFF.filter((s) => s.house).map((s) => s.house as string).concat(['H2']); // + Kwabena Tetteh
    fixedHouses.forEach((h) => counts[h]--);
    const pool_: string[] = []; for (const [h, c] of Object.entries(counts)) for (let i = 0; i < c; i++) pool_.push(h);
    for (let i = pool_.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [pool_[i], pool_[j]] = [pool_[j], pool_[i]]; }

    let n = 0;
    for (const s of STAFF) {
      const [u] = await q<any>(db, 'INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id', [`${s.key}@presec2003.test`, hash, s.name]);
      for (const r of s.roles) await db.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [u.id, r]);
      let memberId: string | null = null;
      if (s.house) {
        n++; const [m] = await q<any>(db, `INSERT INTO members (member_no, user_id, full_name, city, verified_at) VALUES ($1,$2,$3,'Accra',now()) RETURNING id`, ['P03-' + String(n).padStart(4, '0'), u.id, s.name]);
        memberId = m.id; await db.query(`INSERT INTO house_memberships (member_id, house_id, valid_from, reason) VALUES ($1,$2,'2000-01-01','Registered from school records')`, [m.id, s.house]);
      }
      users[s.key] = { userId: u.id, name: s.name, roles: [...s.roles] as Role[], memberId, mfaPassed: true, extra: ['vote', 'rsvp'] };
    }
    await db.query(`INSERT INTO house_captains VALUES ('H2',$1)`, [users.abena.userId]);
    // Kwabena Tetteh: member who owns a bidding firm (conflict of interest)
    n++; const [kt] = await q<any>(db, `INSERT INTO members (member_no, full_name, city, profession, verified_at) VALUES ($1,'Kwabena Tetteh','Accra','Director, Tetteh Builders Ltd',now()) RETURNING id`, ['P03-' + String(n).padStart(4, '0')]);
    await db.query(`INSERT INTO house_memberships (member_id, house_id, valid_from, reason) VALUES ($1,'H2','2000-01-01','Registered from school records')`, [kt.id]);
    const abroad = [['London', 'GBP'], ['Manchester', 'GBP'], ['Houston', 'USD'], ['Toronto', 'USD']];
    while (n < members) {
      n++; const away = R() < 0.13 ? pick(abroad) : null;
      const [m] = await q<any>(db, `INSERT INTO members (member_no, full_name, city, profession, home_currency, verified_at, show_on_wall) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        ['P03-' + String(n).padStart(4, '0'), pick(F_) + ' ' + pick(L_), away ? away[0] : pick(['Accra', 'Accra', 'Kumasi', 'Tema', 'Takoradi', 'Cape Coast', 'Ho', 'Tamale']), pick(['Engineer', 'Nurse', 'Teacher', 'Accountant', 'Banker', 'Doctor', 'Lawyer', 'Entrepreneur', 'IT consultant']), away ? away[1] : 'GHS', n <= members - 8 ? new Date() : null, R() < 0.72]);
      await db.query(`INSERT INTO house_memberships (member_id, house_id, valid_from, reason) VALUES ($1,$2,'2000-01-01','Registered from school records')`, [m.id, pool_.pop()]);
    }
    await db.query(`INSERT INTO competition_rules (version, status, period_name, period_start, period_end, per_member_target, weight_target, weight_participation, approved_by)
      VALUES ('1.0','in_force','Founders’ Drive',$1,$2,150000,60,40,'Executive committee resolution EC-01')`, [start, addDays(start, 150)]);
    await freezeEligible(db, '1.0');
    await db.query(`INSERT INTO competition_rules (version, status, period_name, period_start, period_end, per_member_target, weight_target, weight_participation, approved_by)
      VALUES ('1.1','draft','Roof-to-Handover Drive',$1,$2,120000,55,45,'Pending member vote')`, [addDays(start, 151), addDays(start, 331)]);

    // suppliers, conflicts, contract
    const sup: Record<string, string> = {};
    for (const s of ['Asaase Construction Ltd', 'Tetteh Builders Ltd', 'Northgate Works Ltd', 'Mensa & Partners QS', 'Adomako Design Studio', 'Municipal Assembly (building permit)']) sup[s] = (await q<any>(db, 'INSERT INTO suppliers (name) VALUES ($1) RETURNING id', [s]))[0].id;
    await db.query(`INSERT INTO coi_declarations VALUES ('COI-01',NULL,$1,$2,'Director and shareholder of a bidder for the main contract','Excluded from bid evaluation; interest disclosed on ballot P1',$3)`, [kt.id, sup['Tetteh Builders Ltd'], addDays(start, 7)]);
    await db.query(`INSERT INTO coi_declarations VALUES ('COI-02',$1,$2,$3,'Sister is a partner at the quantity surveyors','Recused from approving payments to Mensa & Partners QS',$4)`, [users.efua.userId, users.efua.memberId, sup['Mensa & Partners QS'], addDays(start, 2)]);
    await db.query(`INSERT INTO contracts VALUES ('CON-01','P1',$1,74200000,1000,$2,$3,$4)`, [sup['Asaase Construction Ltd'], addDays(start, 15), addDays(start, 21), addDays(start, 270)]);
    const wps: [string, string, number, number, number, number, number][] = [
      ['WP01', 'Site preparation and setting out', 300, 2200000, 100, 100, 100], ['WP02', 'Excavation and foundations', 1400, 10400000, 100, 100, 100],
      ['WP03', 'Structural frame (columns, beams, slab)', 1800, 13400000, 60, 45, 0], ['WP04', 'Walling and partitions', 1200, 8900000, 20, 10, 0],
      ['WP05', 'Roofing', 1400, 10400000, 0, 0, 0], ['WP06', 'Doors, windows and security', 800, 5900000, 0, 0, 0], ['WP07', 'Electrical installation', 600, 4500000, 0, 0, 0],
      ['WP08', 'Plumbing and sanitation', 500, 3700000, 0, 0, 0], ['WP09', 'Plastering, flooring, painting', 1300, 9600000, 0, 0, 0], ['WP10', 'External works and drainage', 400, 3000000, 0, 0, 0], ['WP11', 'Final inspection and handover', 300, 2200000, 0, 0, 0]];
    for (const w of wps) {
      await db.query(`INSERT INTO work_packages VALUES ($1,'P1',$2,$3,$4,$5,$6,$7)`, w);
      for (const [stage, pct, by] of [['reported', w[4], users.nana], ['verified', w[5], users.akosua], ['accepted', w[6], users.nana]] as const)
        if (pct > 0) await db.query(`INSERT INTO progress_events (wp_id, stage, pct, evidence, recorded_by) VALUES ($1,$2,$3,'Seeded history',$4)`, [w[0], stage, pct, by.userId]);
    }
    for (const [id, wp, d, res, note] of [['INS-01', 'WP01', 5, 'passed', 'Setting out matches approved drawings'], ['INS-02', 'WP02', 14, 'passed', 'Reinforcement checked before pour'], ['INS-03', 'WP02', 28, 'passed', 'Cube tests 25.4 N/mm² at 28 days'], ['INS-04', 'WP03', 42, 'passed_with_defect', 'Ground-floor columns; see DEF-01']] as const)
      await db.query(`INSERT INTO inspections VALUES ($1,$2,$3,'Ing. Comfort Agyei, structural engineer (sample)',$4,$5)`, [id, wp, addDays(start, 21 + d), res, note]);
    await db.query(`INSERT INTO defects VALUES ('DEF-01','WP03','Honeycombing at base of column C4','Break out and recast per engineer instruction EI-05',$1,'open',NULL,NULL)`, [addDays(T, 3)]);
    for (const r of [['R1', 'Fundraising pace is behind the contract cash-flow forecast', 'High', 'Kofi Boateng', 'Pledge reminders; diaspora drive; hold roofing order until funds reconcile'], ['R2', 'Cement and iron rod prices rise before roofing', 'Medium', 'Nana Adjei', 'Track against contingency'], ['R3', 'Rainy-season delay to roofing', 'Medium', 'Nana Adjei', 'Schedule roofing for the dry season'], ['R4', 'Conflict of interest in procurement', 'Low', 'Akosua Frimpong', 'COI register, recusal, disclosure on ballots']])
      await db.query('INSERT INTO risks VALUES ($1,$2,$3,$4,$5)', r);
    const hv = ['Practical completion certificate (engineer)', 'As-built drawings', 'Operation and maintenance manuals', 'Warranties register (roof, electrical, plumbing)', 'Final account agreed with contractor', 'Release of retention after defects period', 'School acceptance letter and keys'];
    for (const [i, t] of hv.entries()) await db.query(`INSERT INTO handover_items (id, project_id, title, status) VALUES ($1,'P1',$2,'pending')`, ['HO-' + String(i + 1).padStart(2, '0'), t]);
    for (const m of [['Defects liability period', '12 months after handover', 'Asaase Construction Ltd'], ['Roof sheets and gutters inspection', 'Every 6 months, before the rains', 'School + legacy committee'], ['Electrical installation test', 'Every 2 years', 'Licensed electrician'], ['Repainting', 'Every 5 years', 'Legacy fund']])
      await db.query(`INSERT INTO maintenance_items (project_id, item, frequency, owner) VALUES ('P1',$1,$2,$3)`, m);
    await db.query(`INSERT INTO variations (id, project_id, title, amount, reason, funded_from, route, status, decided_by) VALUES ('VAR-01','P1','Access ramp and handrails at block entrance',1450000,'Head teacher requested step-free access','contingency','committee','approved',$1)`, [users.akosua.userId]);
  });

  // ── contributions through the real flows
  const members_ = await q<any>(pool, `SELECT m.id, m.member_no, m.home_currency, m.user_id, hm.house_id FROM members m JOIN house_memberships hm ON hm.member_id=m.id ORDER BY m.member_no`);
  const prob: Record<string, number> = { H1: 0.55, H2: 0.62, H3: 0.71, H4: 0.5, H5: 0.58, H6: 0.66, H7: 0.52, H8: 0.61 };
  const AMTS = [100, 200, 200, 300, 300, 500, 500, 500, 800, 1000, 1000, 1500, 2000, 3000];
  await tx(async (db) => {
    for (const m of members_) {
      if (R() < 0.45 || m.member_no === 'P03-0001') await db.query(`INSERT INTO pledges (member_id, project_id, amount, instalments, status) VALUES ($1,'P1',$2,$3,'active')`, [m.id, m.member_no === 'P03-0001' ? 300000 : pick([1000, 1500, 2000, 2500, 3000, 5000]) * 100, pick([3, 5, 6, 10])]);
    }
  });
  const fakeMember = (m: any): Actor => ({ userId: m.user_id ?? (null as any), name: m.member_no, roles: ['member'], memberId: m.id, mfaPassed: true, extra: ['vote', 'rsvp'] });
  let k = 0;
  for (const m of members_) {
    if (m.member_no !== 'P03-0001' && R() >= prob[m.house_id]) continue;
    const times = m.member_no === 'P03-0001' ? 2 : 1 + (R() < 0.25 ? 1 : 0);
    for (let t = 0; t < times; t++) {
      const paidOn = addDays(start, Math.min(70, Math.floor(Math.pow(R(), 0.85) * 71)));
      const foreign = m.home_currency !== 'GHS';
      const channel = foreign ? 'card' : R() < 0.75 ? 'momo' : 'bank';
      const amount = m.member_no === 'P03-0001' ? 500 : foreign ? pick([30, 50, 80, 100, 150]) : pick(AMTS);
      if (channel === 'bank') {
        const recent = paidOn > addDays(T, -6);
        await tx(async (db) => {
          const p = await P.recordManual(db, users.kofi, { memberNo: m.member_no, amountGhs: amount, channel: 'bank', ref: `BNK-${++k}-${m.member_no}`, paidOn, note: 'Bank statement line', category: 'member' });
          if (!recent) await P.verify(db, users.efua, p.id);
        });
      } else {
        const actor = fakeMember(m);
        const init = await tx((db) => P.initiate(db, actor, { amount, currency: foreign ? m.home_currency : 'GHS', channel, network: channel === 'momo' ? pick(['MTN MoMo', 'MTN MoMo', 'Telecel Cash', 'AT Money']) : undefined }));
        const [p] = await q<any>(pool, 'SELECT * FROM payments WHERE id=$1', [init.paymentId]);
        const body = JSON.stringify({ eventId: 'evt_' + p.id, reference: p.external_ref, status: 'success', currency: p.currency, amount: p.amount_original, settlementRate: p.fx_rate, paidAt: paidOn });
        await tx((db) => P.handleWebhook(db, body, hmacHex(config.webhookSecret, body), 'sandbox'));
      }
    }
  }
  // settle everything older than 4 days, then leave recent ones in clearing
  await tx(async (db) => {
    const cut = addDays(T, -4);
    const [old] = await q<any>(db, `SELECT coalesce(sum(amount_ghs-fee_ghs),0) v FROM payments WHERE status='verified' AND source='gateway' AND paid_on <= $1`, [cut]);
    await P.recordSettlement(db, users.kofi, 'sandbox', old.v / 100, cut);
  });
  // donation, cash pending, unmatched and duplicate exceptions
  await tx(async (db) => {
    const d = await P.recordManual(db, users.kofi, { memberNo: 'P03-0020', amountGhs: 15000, channel: 'bank', ref: 'BNK-DELTA-0930', paidOn: addDays(T, -13), note: 'Corporate donation introduced by P03-0020', category: 'donor', payerName: 'Delta Paints Ghana Ltd (sample)' });
    await P.verify(db, users.efua, d.id);
    await P.recordManual(db, users.kofi, { memberNo: 'P03-0017', amountGhs: 600, channel: 'cash', ref: 'CSH-0412', paidOn: addDays(T, -2), note: 'Collected at Accra chapter meeting, receipt book 0412', category: 'member' });
    await db.query(`INSERT INTO payments (project_id, payer_name, channel, source, currency, amount_original, amount_ghs, external_ref, paid_on, status, exception_reason, recorded_by)
      VALUES ('P1','Unknown — narration “CLASSFUND KWESI 7781”','bank','manual','GHS',75000,75000,'BNK-7781-1008',$1,'exception','Unmatched — bank credit has no member number. Assign it to a member before verifying.',$2)`, [addDays(T, -5), users.kofi.userId]);
  });
  // payments out: professional fees and IPC-01 paid; IPC-02 awaiting second approval
  await tx(async (db) => {
    for (const [title, payee, amt, approver] of [['Architectural and structural design', 'Adomako Design Studio', 18000, users.efua], ['Bill of quantities and cost plan', 'Mensa & Partners QS', 9500, users.akosua], ['Building permit', 'Municipal Assembly (building permit)', 4200, users.akosua]] as const) {
      const r = await F.createRequest(db, users.nana, { title, payee, amountGhs: amt, category: 'Professional fees' });
      await F.decideRequest(db, approver, r.id, 'approved'); await F.releaseRequest(db, users.kofi, r.id);
    }
    const c1 = await F.createCertificate(db, users.nana, { contractId: 'CON-01', grossToDateGhs: 96000, issuedOn: addDays(start, 36), issuedBy: 'Mensa & Partners QS' });
    const r1 = await F.createRequest(db, users.nana, { title: 'Interim payment certificate ' + c1.id, payee: 'Asaase Construction Ltd', category: 'Construction contract', certificateId: c1.id });
    await F.decideRequest(db, users.efua, r1.id, 'approved'); await F.decideRequest(db, users.akosua, r1.id, 'approved'); await F.releaseRequest(db, users.kofi, r1.id);
    const c2 = await F.createCertificate(db, users.nana, { contractId: 'CON-01', grossToDateGhs: 182000, issuedOn: addDays(T, -6), issuedBy: 'Mensa & Partners QS' });
    const r2 = await F.createRequest(db, users.nana, { title: 'Interim payment certificate ' + c2.id, payee: 'Asaase Construction Ltd', category: 'Construction contract', certificateId: c2.id });
    await F.decideRequest(db, users.efua, r2.id, 'approved');
    await F.createRequest(db, users.nana, { title: 'Site signboard and donor panel', payee: 'Graphix Signs, Madina (sample)', amountGhs: 2800, category: 'Site costs' });
  });
  // governance: P1 closed (contract award), P2 open (VAR-02), P3 open (rules v1.1)
  const voters = (await q<any>(pool, `SELECT id FROM members WHERE verified_at IS NOT NULL AND user_id IS NULL ORDER BY random()`));
  await tx(async (db) => {
    const p1 = await G.createProposal(db, users.akosua, { title: 'Award the main contract to Asaase Construction Ltd for GH₵ 742,000', description: 'Recommended by the evaluation panel (price 40%, technical 60%). One bidder is connected to a member: see COI-01.', threshold: 'simple', quorumPct: 30, opensOn: addDays(T, -1), closesOn: T });
    const V = voters.length, n1 = Math.round(V * 0.61), n2 = Math.round(V * 0.24), n3 = Math.round(V * 0.15);
    for (let i = 0; i < n1; i++) await G.castVote(db, fakeMember(voters[i]), p1.id, i < n1 * 0.82 ? 'yes' : i < n1 * 0.94 ? 'no' : 'abstain');
    await G.closeBallot(db, users.akosua, p1.id);
    await db.query(`UPDATE proposals SET opens_on=$2, closes_on=$3 WHERE id=$1`, [p1.id, addDays(start, 5), addDays(start, 12)]);
    const v = await J.proposeVariation(db, users.nana, { title: 'Accessible toilet block (2 stalls, 1 accessible)', amountGhs: 118000, reason: 'School has no accessible toilet' });
    const p2 = await G.createProposal(db, users.akosua, { title: 'Approve variation ' + v.id + ': accessible toilet block (GH₵ 118,000)', description: 'Raises the budget after the contingency balance is applied. Adds about four weeks.', threshold: 'simple', quorumPct: 30, opensOn: addDays(T, -6), closesOn: addDays(T, 7), linkedType: 'variation', linkedId: v.id });
    for (let i = 0; i < n2; i++) await G.castVote(db, fakeMember(voters[V - 1 - i]), p2.id, i < n2 * 0.76 ? 'yes' : i < n2 * 0.92 ? 'no' : 'abstain');
    const p3 = await G.createProposal(db, users.akosua, { title: 'Adopt house competition rules v1.1 for the next drive', description: 'Weights 55% target / 45% participation; per-member target GH₵ 1,200. Applies only to the next period.', threshold: 'two_thirds', quorumPct: 30, opensOn: addDays(T, -3), closesOn: addDays(T, 14), linkedType: 'rules', linkedId: '1.1' });
    for (let i = 0; i < n3; i++) await G.castVote(db, fakeMember(voters[i]), p3.id, i < n3 * 0.72 ? 'yes' : i < n3 * 0.93 ? 'no' : 'abstain');
  });
  // Sample lifecycle: initiation, planning and procurement signed off; execution under way.
  await tx(async (db) => {
    await db.query(`UPDATE phase_deliverables SET status='done', evidence='Seeded sample record', updated_by=$1, updated_at=now() WHERE phase_key IN ('initiation','planning','procurement')`, [users.nana.userId]);
    await db.query(`UPDATE phase_deliverables SET status='done', evidence='Seeded sample record', updated_by=$1, updated_at=now() WHERE phase_key='execution' AND seq IN (1,2)`, [users.nana.userId]);
    await db.query(`UPDATE phase_deliverables SET status='in_progress' WHERE phase_key='execution' AND seq IN (3,4,5)`);
    for (const [k, s0, e0] of [['initiation', -150, -120], ['planning', -120, -80], ['procurement', -80, -55]] as const)
      await db.query(`UPDATE project_phases SET status='complete', actual_start=$2, actual_end=$3, gate_approved_by=$4, gate_approved_at=now(), gate_note='Committee resolution (sample)' WHERE key=$1`, [k, addDays(T, s0), addDays(T, e0), users.akosua.userId]);
    await db.query(`UPDATE project_phases SET status='in_progress', actual_start=$1 WHERE key='execution'`, [addDays(T, -55)]);
    await db.query(`INSERT INTO project_updates (project_id, phase_key, title, body, public, posted_by) VALUES ('P1','execution','Foundations complete','Foundations passed inspection; the structural frame is under way.', true, $1)`, [users.nana.userId]);
  });
  // Sample history is already 'delivered'; only new notices go out.
  await pool.query('UPDATE notifications SET expanded=true');
  await tx(async (db) => {
    await db.query(`INSERT INTO announcements (title, body, posted_by) VALUES ('Groundbreaking done', 'Thank you, Ɔdadeɛ 2003. Foundations for our classroom block at PRESEC Legon passed inspection. Next: the structural frame.', $1),
      ('Founders’ Drive is open', 'The house competition runs until the end of the year. Every classmate who gives, whatever the amount, lifts their house.', $1)`, [users.akosua.userId]);
    await db.query(`INSERT INTO events (title, starts_at, venue, details, created_by) VALUES ('Ɔdadeɛ 2003 end-of-year reunion', $2, 'PRESEC Legon assembly hall', 'Site tour of the classroom block at 10:00, lunch after.', $1),
      ('Committee update call (online)', $3, 'Online — link sent by email', 'Treasurer and project manager report; Q&A.', $1)`, [users.akosua.userId, addDays(T, 60) + 'T10:00:00Z', addDays(T, 9) + 'T19:00:00Z']);
  });
  if (!quiet) console.log(`Seeded ${members} members. Sign in as e.g. ama@presec2003.test / ${DEMO_PASSWORD}`);
  return users;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seed().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
