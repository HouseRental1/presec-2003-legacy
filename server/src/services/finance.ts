import { z } from 'zod';
import { Actor, Db, q, one, need, audit, notify, forbid, conflict, invalid, setting, ofBp, fmt, today, perms } from '../lib.js';
import { postTxn, balance } from './ledger.js';

const PROJECT = 'P1';

async function supplierId(db: Db, name: string) {
  const r = await q<any>(db, 'SELECT id FROM suppliers WHERE name=$1', [name]);
  if (r.length) return r[0].id as string;
  return (await one<any>(db, 'INSERT INTO suppliers (name) VALUES ($1) RETURNING id', [name])).id as string;
}
async function nextId(db: Db, table: string, prefix: string) {
  const [r] = await q<any>(db, `SELECT count(*)::int n FROM ${table}`);
  return `${prefix}-${String(r.n + 1).padStart(4, '0')}`;
}

/* ───────── contractor payment certificates (issued by the QS, recorded by the PM) */
export const CertInput = z.object({ contractId: z.string(), grossToDateGhs: z.number().positive(), issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), issuedBy: z.string().min(2) });
export async function createCertificate(db: Db, actor: Actor, input: z.infer<typeof CertInput>) {
  need(actor, 'proj.edit', 'record payment certificates');
  const c = await one<any>(db, 'SELECT * FROM contracts WHERE id=$1', [input.contractId]);
  const gross = Math.round(input.grossToDateGhs * 100);
  const [prev] = await q<any>(db, 'SELECT * FROM payment_certificates WHERE contract_id=$1 ORDER BY issued_on DESC, id DESC LIMIT 1', [c.id]);
  if (prev && gross <= prev.gross_to_date) throw invalid('Work certified to date must exceed the previous certificate.');
  const [{ v }] = await q<any>(db, `SELECT coalesce(sum(value),0)::bigint v FROM (SELECT amount AS value FROM variations WHERE project_id=$1 AND status='approved') x`, [c.project_id]);
  if (gross > c.value + v) throw invalid('Certified work cannot exceed the contract sum plus approved variations.');
  const retention = ofBp(gross, c.retention_bp);
  const previousPaid = prev ? prev.gross_to_date - prev.retention_to_date : 0;
  const due = gross - retention - previousPaid;
  const [{ n }] = await q<any>(db, 'SELECT count(*)::int n FROM payment_certificates WHERE contract_id=$1', [c.id]);
  const id = `IPC-${String(n + 1).padStart(2, '0')}`;
  await db.query(`INSERT INTO payment_certificates (id, contract_id, issued_on, gross_to_date, retention_to_date, previous_paid, due, issued_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, c.id, input.issuedOn, gross, retention, previousPaid, due, input.issuedBy]);
  await audit(db, actor, 'Recorded payment certificate', id, `due ${fmt(due)}`);
  return { id, due, retention, previousPaid };
}

/* ───────── payment requests: create → approve (1 or 2, no self, no conflict) → release */
export const RequestInput = z.object({ title: z.string().min(3), payee: z.string().min(2), amountGhs: z.number().positive().optional(), category: z.string().default('Professional fees'), certificateId: z.string().optional() });
export async function createRequest(db: Db, actor: Actor, input: z.infer<typeof RequestInput>) {
  need(actor, 'req.create', 'raise payment requests');
  let amount = input.amountGhs ? Math.round(input.amountGhs * 100) : 0;
  if (input.certificateId) {
    const cert = await one<any>(db, 'SELECT * FROM payment_certificates WHERE id=$1', [input.certificateId]);
    if (amount && amount !== cert.due) throw invalid(`A certificate request must be for exactly ${fmt(cert.due)}.`);
    amount = cert.due;
  }
  if (!amount) throw invalid('Enter an amount.');
  const dual = await setting<number>(db, 'dual_approval_above');
  const id = await nextId(db, 'payment_requests', 'REQ');
  try {
    await db.query(`INSERT INTO payment_requests (id, project_id, title, supplier_id, amount, category, certificate_id, required_approvals, status, requested_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'awaiting',$9)`, [id, PROJECT, input.title, await supplierId(db, input.payee), amount, input.category, input.certificateId ?? null, amount > dual ? 2 : 1, actor.userId]);
  } catch (e: any) { if (e.code === '23505') throw conflict('A request already exists for this certificate.'); throw e; }
  await notify(db, 'perm:req.approve', ['in_app', 'email'], `${id} (${fmt(amount)}) to ${input.payee} needs approval.`);
  await audit(db, actor, 'Raised payment request', id, `${input.payee} ${fmt(amount)}`);
  return { id, amount, requiredApprovals: amount > dual ? 2 : 1 };
}

export async function decideRequest(db: Db, actor: Actor, id: string, decision: 'approved' | 'rejected') {
  need(actor, 'req.approve', 'approve payments');
  const r = await one<any>(db, 'SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
  if (r.status !== 'awaiting') throw conflict(`Request is ${r.status}.`);
  if (r.requested_by === actor.userId) throw forbid('You raised this request, so you cannot decide on it.');
  const coi = await q<any>(db, 'SELECT id FROM coi_declarations WHERE user_id=$1 AND supplier_id=$2', [actor.userId, r.supplier_id]);
  if (coi.length) throw forbid(`You declared an interest in this payee (${coi[0].id}). Another approver must decide.`);
  try {
    await db.query('INSERT INTO request_decisions (request_id, user_id, decision) VALUES ($1,$2,$3)', [id, actor.userId, decision]);
  } catch (e: any) { if (e.code === '23505') throw conflict('You have already decided on this request. A different approver is needed.'); throw e; }
  if (decision === 'rejected') {
    await db.query(`UPDATE payment_requests SET status='rejected' WHERE id=$1`, [id]);
  } else {
    const [{ n }] = await q<any>(db, `SELECT count(*)::int n FROM request_decisions WHERE request_id=$1 AND decision='approved'`, [id]);
    if (n >= r.required_approvals) {
      await db.query(`UPDATE payment_requests SET status='approved' WHERE id=$1`, [id]);
      await notify(db, 'perm:fin.release', ['in_app'], `${id} is fully approved and ready to release.`);
    }
  }
  await audit(db, actor, decision === 'approved' ? 'Approved payment request' : 'Rejected payment request', id, fmt(r.amount));
  return one(db, 'SELECT id, status FROM payment_requests WHERE id=$1', [id]);
}

export async function releaseRequest(db: Db, actor: Actor, id: string) {
  need(actor, 'fin.release', 'release payments');
  const r = await one<any>(db, 'SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id]);
  if (r.status !== 'approved') throw conflict('Only fully approved requests can be released.');
  if (r.requested_by === actor.userId) throw forbid('You raised this request, so you cannot release it.');
  const decided = await q(db, 'SELECT 1 FROM request_decisions WHERE request_id=$1 AND user_id=$2', [id, actor.userId]);
  if (decided.length) throw forbid('You approved this request, so you cannot also release it.');
  const bank = await balance(db, 'BANK');
  if (bank < r.amount) throw conflict(`The reconciled bank balance (${fmt(bank)}) is below ${fmt(r.amount)}.`);
  const supplier = await one<any>(db, 'SELECT name FROM suppliers WHERE id=$1', [r.supplier_id]);
  if (r.certificate_id) {
    const c = await one<any>(db, 'SELECT * FROM payment_certificates WHERE id=$1', [r.certificate_id]);
    const [prev] = await q<any>(db, 'SELECT * FROM payment_certificates WHERE contract_id=$1 AND issued_on <= $2 AND id < $3 ORDER BY id DESC LIMIT 1', [c.contract_id, c.issued_on, c.id]);
    const grossInc = c.gross_to_date - (prev?.gross_to_date ?? 0), retInc = c.retention_to_date - (prev?.retention_to_date ?? 0);
    if (grossInc - retInc !== c.due) throw conflict(`Certificate ${c.id} does not reconcile with the previous certificate.`);
    await postTxn(db, { projectId: r.project_id, kind: 'payment_out', sourceType: 'request', sourceId: id, date: today(), actor, memo: `${r.title} — ${supplier.name}`,
      lines: [{ account: 'PROJECT_COST', debit: grossInc }, { account: 'BANK', credit: c.due }, { account: 'RETENTION', credit: retInc }] });
  } else {
    await postTxn(db, { projectId: r.project_id, kind: 'payment_out', sourceType: 'request', sourceId: id, date: today(), actor, memo: `${r.title} — ${supplier.name}`,
      lines: [{ account: 'PROJECT_COST', debit: r.amount }, { account: 'BANK', credit: r.amount }] });
  }
  await db.query(`UPDATE payment_requests SET status='paid', released_by=$2, released_on=$3 WHERE id=$1`, [id, actor.userId, today()]);
  await audit(db, actor, 'Released payment', id, `${supplier.name} ${fmt(r.amount)}`);
}

export async function listRequests(db: Db | any, actor: Actor) {
  if (!['fin.view', 'req.create', 'req.approve'].some((x) => perms(actor).has(x))) throw forbid('Your role cannot view payment requests.');
  const rows = await q<any>(db, `SELECT r.*, s.name payee, u.display_name requested_by_name,
      coalesce(json_agg(json_build_object('user', du.display_name, 'decision', d.decision, 'at', d.decided_at)) FILTER (WHERE d.user_id IS NOT NULL), '[]') decisions
    FROM payment_requests r JOIN suppliers s ON s.id=r.supplier_id JOIN users u ON u.id=r.requested_by
    LEFT JOIN request_decisions d ON d.request_id=r.id LEFT JOIN users du ON du.id=d.user_id
    GROUP BY r.id, s.name, u.display_name ORDER BY r.created_at DESC`);
  const certificates = await q<any>(db, `SELECT c.*, (SELECT status FROM payment_requests WHERE certificate_id=c.id) request_status FROM payment_certificates c ORDER BY id`);
  const [con] = await q<any>(db, `SELECT c.id, s.name FROM contracts c JOIN suppliers s ON s.id=c.supplier_id ORDER BY c.signed_on DESC LIMIT 1`);
  return { requests: rows, certificates, contractId: con?.id ?? null, contractor: con?.name ?? null };
}

/* ───────── dashboard figures — all derived from the ledger, pledges and approvals */
export async function dashboard(db: Db | any) {
  const cashReceived = (await balance(db, 'INC_MEMBER')) + (await balance(db, 'INC_DONOR'));
  const [pl] = await q<any>(db, `SELECT coalesce(sum(amount),0) pledged FROM pledges WHERE status='active'`);
  const [os] = await q<any>(db, `SELECT coalesce(sum(greatest(0, pl.amount - coalesce(pd.paid,0))),0) outstanding FROM
      (SELECT member_id, sum(amount) amount FROM pledges WHERE status='active' GROUP BY member_id) pl
      LEFT JOIN (SELECT member_id, sum(amount_ghs) paid FROM payments WHERE status='verified' AND category='member' GROUP BY member_id) pd USING (member_id)`);
  const bank = await balance(db, 'BANK'), clearing = await balance(db, 'CLEARING'), retention = await balance(db, 'RETENTION');
  const spent = await balance(db, 'PROJECT_COST'), fees = await balance(db, 'EXP_FEES');
  const [c] = await q<any>(db, `SELECT coalesce(sum(value),0) v FROM contracts WHERE project_id=$1`, [PROJECT]);
  const [va] = await q<any>(db, `SELECT coalesce(sum(amount),0) v FROM variations WHERE project_id=$1 AND status='approved'`, [PROJECT]);
  const [cp] = await q<any>(db, `SELECT coalesce(sum(e.debit),0) v FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.txn_id
      JOIN payment_requests r ON t.source_type='request' AND t.source_id=r.id WHERE r.certificate_id IS NOT NULL AND e.account='PROJECT_COST'`);
  const [au] = await q<any>(db, `SELECT coalesce(sum(amount),0) v, coalesce(sum(amount) FILTER (WHERE certificate_id IS NULL),0) nc FROM payment_requests WHERE status='approved'`);
  const [bv] = await q<any>(db, `SELECT * FROM budget_versions WHERE project_id=$1 ORDER BY version DESC LIMIT 1`, [PROJECT]);
  const commitments = c.v + va.v - cp.v + retention + au.nc;
  return {
    cashReceived, pledged: pl.pledged, outstandingPledges: os.outstanding, bank, clearing, retention, spent, fees,
    commitments, approvedNotReleased: au.v, availableNow: bank - au.v,
    budget: bv?.total ?? 0, budgetVersion: bv?.version ?? 0,
    stillToRaise: Math.max(0, (bv?.total ?? 0) - cashReceived - os.outstanding),
    definitions: {
      cashReceived: 'Verified contributions and donations, net of reversals.',
      commitments: 'Remaining contract value incl. approved variations, retention owed, and approved non-contract payments not yet released.',
      availableNow: 'Reconciled bank balance less fully approved payments not yet released.',
    },
  };
}

export async function financeReport(db: Db | any, actor: Actor) {
  need(actor, 'reports', 'view finance reports');
  const d = await dashboard(db);
  const byChannel = await q<any>(db, `SELECT coalesce(network, channel) channel, count(*)::int n, sum(amount_ghs) total FROM payments WHERE status='verified' GROUP BY 1 ORDER BY 3 DESC`);
  return {
    receipts: { members: await balance(db, 'INC_MEMBER'), donors: await balance(db, 'INC_DONOR') },
    payments: { projectCostsPaid: d.spent - d.retention, fees: d.fees },
    closing: { bank: d.bank, clearing: d.clearing, suspense: await balance(db, 'SUSPENSE') },
    byChannel,
  };
}
