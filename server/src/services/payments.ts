import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { Actor, Db, q, one, need, audit, notify, forbid, conflict, invalid, setting, ofBp, fmt, today, config, hmacHex, safeEqualHex, sha256, AppError } from '../lib.js';
import { postTxn, reverseTxn, balance } from './ledger.js';

const PROJECT = 'P1';
type Payment = any;

async function memberByNo(db: Db, no: string) {
  const r = await q<any>(db, 'SELECT * FROM members WHERE lower(member_no)=lower($1)', [no.trim()]);
  if (!r.length) throw invalid(`No member with number ${no}.`);
  return r[0];
}
async function lock(db: Db, id: string): Promise<Payment> {
  return one(db, 'SELECT * FROM payments WHERE id=$1 FOR UPDATE', [id]);
}
async function feeFor(db: Db, channel: string, gross: number) {
  const fees = await setting<{ momo_bp: number; card_bp: number }>(db, 'fees');
  return channel === 'momo' ? ofBp(gross, fees.momo_bp) : channel === 'card' ? ofBp(gross, fees.card_bp) : 0;
}

/** Post a verified contribution: Dr bank/clearing gross, Cr income gross; fee as a separate cost. */
async function postContribution(db: Db, p: Payment, actor: Actor | null) {
  const cash = p.channel === 'momo' || p.channel === 'card' ? 'CLEARING' : 'BANK';
  const income = p.category === 'donor' ? 'INC_DONOR' : 'INC_MEMBER';
  await postTxn(db, {
    projectId: p.project_id, kind: 'contribution', sourceType: 'payment', sourceId: p.id, date: p.paid_on, actor,
    memo: `${p.category === 'donor' ? 'Donation' : 'Contribution'} ${p.external_ref} via ${p.channel}${p.currency !== 'GHS' ? ` (${p.currency} ${(p.amount_original / 100).toFixed(2)} @ ${p.fx_rate})` : ''}`,
    lines: [
      { account: cash, debit: p.amount_ghs }, { account: income, credit: p.amount_ghs },
      { account: 'EXP_FEES', debit: p.fee_ghs }, { account: cash, credit: p.fee_ghs },
    ],
  });
  const receipt = 'RCT-' + sha256(p.id).slice(0, 8).toUpperCase();
  await db.query('UPDATE payments SET receipt_no=$2 WHERE id=$1', [p.id, receipt]);
  if (p.member_id) await notify(db, 'member:' + p.member_id, ['in_app', 'sms'], `Payment received: ${fmt(p.amount_ghs)}. Receipt ${receipt}. Thank you.`);
  return receipt;
}

/* ───────── manual channel: maker records, a different checker verifies */
export const ManualInput = z.object({
  memberNo: z.string().min(1), amountGhs: z.number().positive().max(10_000_000), channel: z.enum(['bank', 'cash']),
  ref: z.string().min(3).max(80), paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().max(500).default(''),
  category: z.enum(['member', 'donor']).default('member'), payerName: z.string().max(200).optional(),
});
export async function recordManual(db: Db, actor: Actor, input: z.infer<typeof ManualInput>) {
  need(actor, 'fin.record', 'record payments');
  const m = await memberByNo(db, input.memberNo);
  const amount = Math.round(input.amountGhs * 100);
  try {
    const [p] = await q<Payment>(db,
      `INSERT INTO payments (project_id, member_id, payer_name, category, channel, source, currency, amount_original, amount_ghs, external_ref, paid_on, status, evidence_note, recorded_by)
       VALUES ($1,$2,$3,$4,$5,'manual','GHS',$6,$6,$7,$8,'pending',$9,$10) RETURNING *`,
      [PROJECT, m.id, input.payerName ?? null, input.category, input.channel, amount, input.ref.trim(), input.paidOn, input.note, actor.userId]);
    await audit(db, actor, 'Recorded manual payment', p.id, `${fmt(amount)} · ${input.ref}`);
    return p;
  } catch (e: any) {
    if (e.code === '23505') throw conflict(`Reference ${input.ref} is already recorded. Duplicates are blocked.`);
    throw e;
  }
}

/* member uploads transfer evidence; treasury verifies */
export const EvidenceInput = z.object({ amountGhs: z.number().positive().max(10_000_000), ref: z.string().min(3).max(80), paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().max(500).default('') });
export async function submitEvidence(db: Db, actor: Actor, input: z.infer<typeof EvidenceInput>) {
  need(actor, 'pay', 'submit payments');
  if (!actor.memberId) throw forbid('Only members can submit payment evidence.');
  const amount = Math.round(input.amountGhs * 100);
  try {
    const [p] = await q<Payment>(db,
      `INSERT INTO payments (project_id, member_id, channel, source, currency, amount_original, amount_ghs, external_ref, paid_on, status, evidence_note, recorded_by)
       VALUES ($1,$2,'bank','self','GHS',$3,$3,$4,$5,'pending',$6,$7) RETURNING *`,
      [PROJECT, actor.memberId, amount, input.ref.trim(), input.paidOn, input.note, actor.userId]);
    await audit(db, actor, 'Submitted bank transfer evidence', p.id, fmt(amount));
    return p;
  } catch (e: any) { if (e.code === '23505') throw conflict('That bank reference has already been submitted.'); throw e; }
}

export async function verify(db: Db, actor: Actor, id: string) {
  need(actor, 'fin.verify', 'verify payments');
  const p = await lock(db, id);
  if (p.status !== 'pending') throw conflict(`Payment is ${p.status}, not awaiting verification.`);
  if (!p.member_id) throw conflict('Assign the payment to a member before verifying.');
  if (p.recorded_by === actor.userId) throw forbid('You recorded this payment, so a different person must verify it.');
  await db.query(`UPDATE payments SET status='verified', verified_by=$2, verified_at=now(), fee_ghs=$3 WHERE id=$1`, [id, actor.userId, await feeFor(db, p.channel, p.amount_ghs)]);
  const receipt = await postContribution(db, await one(db, 'SELECT * FROM payments WHERE id=$1', [id]), actor);
  await audit(db, actor, 'Verified payment', id, `${fmt(p.amount_ghs)} · ${p.external_ref}`);
  return { id, receipt };
}

export async function reject(db: Db, actor: Actor, id: string, reason: string) {
  need(actor, 'fin.verify', 'reject payments');
  const p = await lock(db, id);
  if (!['pending', 'exception'].includes(p.status)) throw conflict(`Payment is ${p.status}.`);
  await db.query(`UPDATE payments SET status='rejected', exception_reason=$2 WHERE id=$1`, [id, reason]);
  if (p.member_id) await notify(db, 'member:' + p.member_id, ['in_app'], `We could not confirm a payment of ${fmt(p.amount_ghs)}: ${reason}`);
  await audit(db, actor, 'Rejected payment', id, reason);
}

export async function assignUnmatched(db: Db, actor: Actor, id: string, memberNo: string) {
  need(actor, 'fin.record', 'assign payments');
  const p = await lock(db, id);
  if (p.status !== 'exception' || p.member_id) throw conflict('Only unmatched exceptions can be assigned.');
  const m = await memberByNo(db, memberNo);
  await db.query(`UPDATE payments SET member_id=$2, status='pending', exception_reason=NULL, recorded_by=$3 WHERE id=$1`, [id, m.id, actor.userId]);
  await audit(db, actor, 'Assigned unmatched payment', id, m.member_no);
}

/* ───────── reversals: requested by one person, confirmed by another; original kept */
export async function requestReversal(db: Db, actor: Actor, id: string, reason: string) {
  need(actor, 'fin.record', 'request reversals');
  const p = await lock(db, id);
  if (p.status !== 'verified') throw conflict('Only verified payments can be reversed.');
  await db.query(`UPDATE payments SET status='reversal_requested', reversal_reason=$2, reversal_requested_by=$3 WHERE id=$1`, [id, reason, actor.userId]);
  await audit(db, actor, 'Requested reversal', id, reason);
}
export async function confirmReversal(db: Db, actor: Actor, id: string) {
  need(actor, 'fin.verify', 'confirm reversals');
  const p = await lock(db, id);
  if (p.status !== 'reversal_requested') throw conflict('No reversal is pending for this payment.');
  if (p.reversal_requested_by === actor.userId) throw forbid('You requested this reversal, so someone else must confirm it.');
  const [t] = await q<any>(db, `SELECT id FROM ledger_transactions WHERE source_type='payment' AND source_id=$1 AND kind='contribution'`, [id]);
  await reverseTxn(db, t.id, `Reversal of ${p.external_ref}: ${p.reversal_reason}`, actor, p.settlement_id ? { CLEARING: 'BANK' } : {});
  await db.query(`UPDATE payments SET status='reversed' WHERE id=$1`, [id]);
  await audit(db, actor, 'Confirmed reversal', id, p.reversal_reason);
}
export async function declineReversal(db: Db, actor: Actor, id: string) {
  need(actor, 'fin.verify', 'decline reversals');
  const p = await lock(db, id);
  if (p.status !== 'reversal_requested') throw conflict('No reversal is pending.');
  await db.query(`UPDATE payments SET status='verified', reversal_reason=NULL, reversal_requested_by=NULL WHERE id=$1`, [id]);
  await audit(db, actor, 'Declined reversal', id);
}

/* ───────── opening balances from the old spreadsheet */
export const ImportInput = z.object({ rows: z.array(z.object({ memberNo: z.string(), amountGhs: z.number().positive(), paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ref: z.string().min(2) })).max(2000) });
export async function importOpening(db: Db, actor: Actor, input: z.infer<typeof ImportInput>) {
  need(actor, 'fin.record', 'import balances');
  const done: string[] = [], skipped: { ref: string; reason: string }[] = [];
  for (const r of input.rows) {
    const m = (await q<any>(db, 'SELECT id FROM members WHERE lower(member_no)=lower($1)', [r.memberNo]))[0];
    if (!m) { skipped.push({ ref: r.ref, reason: 'unknown member' }); continue; }
    const res = await q<any>(db,
      `INSERT INTO payments (project_id, member_id, channel, source, currency, amount_original, amount_ghs, external_ref, paid_on, status, evidence_note, recorded_by)
       VALUES ($1,$2,'bank','import','GHS',$3,$3,$4,$5,'pending','Opening balance import',$6) ON CONFLICT DO NOTHING RETURNING id`,
      [PROJECT, m.id, Math.round(r.amountGhs * 100), r.ref, r.paidOn, actor.userId]);
    if (res.length) done.push(res[0].id); else skipped.push({ ref: r.ref, reason: 'duplicate reference' });
  }
  await audit(db, actor, 'Imported opening balances', `${done.length} rows`, `${skipped.length} skipped`);
  return { imported: done.length, skipped };
}

/* ───────── payment gateway (provider-agnostic) */
export const InitiateInput = z.object({
  amount: z.number().positive().max(1_000_000), currency: z.enum(['GHS', 'USD', 'GBP']),
  channel: z.enum(['momo', 'card']), network: z.string().optional(), onBehalfOfNo: z.string().optional(),
});
export async function initiate(db: Db, actor: Actor, input: z.infer<typeof InitiateInput>) {
  need(actor, 'pay', 'make contributions');
  if (!actor.memberId) throw forbid('Only members can contribute through the app.');
  if (input.channel === 'momo' && input.currency !== 'GHS') throw invalid('Mobile money payments are in cedis. Choose GHS or pay by card.');
  let memberId = actor.memberId, payer: string | null = null;
  if (input.onBehalfOfNo) { const t = await memberByNo(db, input.onBehalfOfNo); memberId = t.id; payer = actor.name; }
  const fx = await setting<Record<string, number>>(db, 'fx_indicative');
  const original = Math.round(input.amount * 100);
  const ref = 'CYL-' + randomBytes(6).toString('hex').toUpperCase();
  const [p] = await q<Payment>(db,
    `INSERT INTO payments (project_id, member_id, payer_name, channel, network, source, currency, amount_original, fx_rate, amount_ghs, external_ref, paid_on, status, evidence_note)
     VALUES ($1,$2,$3,$4,$5,'gateway',$6,$7,$8,$9,$10,$11,'pending','Awaiting provider confirmation') RETURNING *`,
    [PROJECT, memberId, payer, input.channel, input.network ?? null, input.currency, original, fx[input.currency] ?? 1, Math.round(original * (fx[input.currency] ?? 1)), ref, today()]);
  await audit(db, actor, 'Started gateway payment', p.id, `${input.currency} ${input.amount} · ${ref}`);
  // A real adapter returns the provider's checkout URL / USSD prompt. The PIN is entered on the
  // member's phone or the provider's page; this system never sees it.
  return { paymentId: p.id, reference: ref, checkout: { provider: 'sandbox', instruction: input.channel === 'momo' ? 'Approve the prompt on your phone.' : 'Complete the card check on the provider page.' } };
}

export const WebhookEvent = z.object({
  eventId: z.string().min(1), reference: z.string().min(1), status: z.enum(['success', 'failed']),
  currency: z.enum(['GHS', 'USD', 'GBP']), amount: z.number().int().positive(),       // minor units, original currency
  settlementRate: z.number().positive().optional(), feeGhs: z.number().int().nonnegative().optional(), paidAt: z.string().optional(),
});
/**
 * Provider callback. Signature is HMAC-SHA256 of the raw body with the shared secret.
 * Replays are ignored (UNIQUE provider,event_id). Amount and currency must match the intent.
 * A browser redirect is never treated as proof of payment — only this signed callback.
 */
export async function handleWebhook(db: Db, rawBody: string, signature: string | undefined, provider = 'sandbox') {
  if (!signature || !safeEqualHex(hmacHex(config.webhookSecret, rawBody), signature)) throw new AppError(401, 'bad_signature', 'Invalid webhook signature.');
  const ev = WebhookEvent.parse(JSON.parse(rawBody));
  const ins = await q(db, `INSERT INTO provider_events (provider, event_id, payload, outcome) VALUES ($1,$2,$3,'received') ON CONFLICT DO NOTHING RETURNING id`, [provider, ev.eventId, ev]);
  if (!ins.length) return { outcome: 'duplicate_event_ignored' };
  const rows = await q<Payment>(db, `SELECT * FROM payments WHERE external_ref=$1 AND source='gateway' FOR UPDATE`, [ev.reference]);
  const setOutcome = (o: string) => db.query('UPDATE provider_events SET outcome=$3 WHERE provider=$1 AND event_id=$2', [provider, ev.eventId, o]);
  // provider_events is not append-only: outcome is processing metadata, payload is preserved.
  if (!rows.length) { await setOutcome('unknown_reference'); return { outcome: 'unknown_reference' }; }
  const p = rows[0];
  if (p.status !== 'pending') { await setOutcome('already_' + p.status); return { outcome: 'already_' + p.status }; }
  if (ev.status === 'failed') {
    await db.query(`UPDATE payments SET status='rejected', exception_reason='Provider reported failure' WHERE id=$1`, [p.id]);
    await audit(db, null, 'Provider reported failed payment', p.id, ev.eventId); await setOutcome('failed'); return { outcome: 'failed' };
  }
  if (ev.currency !== p.currency || ev.amount !== p.amount_original) {
    await db.query(`UPDATE payments SET status='exception', exception_reason=$2 WHERE id=$1`, [p.id, `Provider amount ${ev.currency} ${ev.amount / 100} does not match the request ${p.currency} ${p.amount_original / 100}.`]);
    await audit(db, null, 'Provider amount mismatch', p.id, ev.eventId); await setOutcome('mismatch'); return { outcome: 'mismatch' };
  }
  const rate = p.currency === 'GHS' ? 1 : (ev.settlementRate ?? p.fx_rate);
  const gross = Math.round(p.amount_original * rate);
  const fee = ev.feeGhs ?? (await feeFor(db, p.channel, gross));
  await db.query(`UPDATE payments SET status='verified', verified_at=now(), fx_rate=$2, amount_ghs=$3, fee_ghs=$4, paid_on=$5, evidence_note='Confirmed by signed provider callback' WHERE id=$1`,
    [p.id, rate, gross, fee, (ev.paidAt ?? today()).slice(0, 10)]);
  const receipt = await postContribution(db, await one(db, 'SELECT * FROM payments WHERE id=$1', [p.id]), null);
  await audit(db, null, 'Payment confirmed by provider callback', p.id, `${fmt(gross)} · ${p.external_ref}`);
  await setOutcome('verified');
  return { outcome: 'verified', receipt };
}

/* ───────── provider settlement → bank */
export async function recordSettlement(db: Db, actor: Actor, provider: string, statementGhs: number, upTo?: string) {
  need(actor, 'fin.reconcile', 'record settlements');
  const items = await q<Payment>(db, `SELECT * FROM payments WHERE status='verified' AND source='gateway' AND settlement_id IS NULL AND ($1::date IS NULL OR paid_on <= $1) FOR UPDATE`, [upTo ?? null]);
  if (!items.length) throw conflict('No unsettled gateway payments.');
  const expected = items.reduce((s, p) => s + p.amount_ghs - p.fee_ghs, 0);
  const statement = Math.round(statementGhs * 100);
  const diff = expected - statement;
  const [s] = await q<any>(db, `INSERT INTO settlements (provider, settled_on, expected, statement, status, recorded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [provider, today(), expected, statement, diff === 0 ? 'matched' : 'difference', actor.userId]);
  await db.query('UPDATE payments SET settlement_id=$1 WHERE id = ANY($2)', [s.id, items.map((p) => p.id)]);
  await postTxn(db, {
    projectId: PROJECT, kind: 'settlement', sourceType: 'settlement', sourceId: s.id, date: today(), actor, memo: `Provider settlement ${provider}`,
    lines: diff >= 0
      ? [{ account: 'BANK', debit: statement }, { account: 'SUSPENSE', debit: diff }, { account: 'CLEARING', credit: expected }]
      : [{ account: 'BANK', debit: statement }, { account: 'CLEARING', credit: expected }, { account: 'SUSPENSE', credit: -diff }],
  });
  await audit(db, actor, 'Recorded provider settlement', s.id, diff === 0 ? `Matched ${fmt(statement)}` : `Difference ${fmt(-diff)}`);
  return { ...s, items: items.length };
}

/* ───────── pledges */
export const PledgeInput = z.object({ amountGhs: z.number().positive().max(10_000_000), instalments: z.number().int().min(1).max(24) });
export async function setPledge(db: Db, actor: Actor, input: z.infer<typeof PledgeInput>) {
  need(actor, 'pay', 'make pledges');
  if (!actor.memberId) throw forbid('Only members can pledge.');
  const prev = (await q<any>(db, `SELECT id FROM pledges WHERE member_id=$1 AND status='active' FOR UPDATE`, [actor.memberId]))[0];
  if (prev) await db.query(`UPDATE pledges SET status='adjusted' WHERE id=$1`, [prev.id]);
  const [p] = await q<any>(db, `INSERT INTO pledges (member_id, project_id, amount, instalments, status, replaces) VALUES ($1,$2,$3,$4,'active',$5) RETURNING *`,
    [actor.memberId, PROJECT, Math.round(input.amountGhs * 100), input.instalments, prev?.id ?? null]);
  await audit(db, actor, prev ? 'Adjusted pledge' : 'Made pledge', p.id, fmt(p.amount));
  return p;
}

export async function statement(db: Db | any, actor: Actor) {
  need(actor, 'own', 'view statements');
  if (!actor.memberId) throw forbid('Statements are for members.');
  const payments = await q<any>(db, `SELECT id, external_ref, channel, network, currency, amount_original, fx_rate, amount_ghs, paid_on, status, receipt_no, payer_name
    FROM payments WHERE member_id=$1 AND category='member' ORDER BY paid_on DESC, created_at DESC`, [actor.memberId]);
  const pledges = await q<any>(db, `SELECT * FROM pledges WHERE member_id=$1 ORDER BY created_at DESC`, [actor.memberId]);
  const paid = payments.filter((p) => p.status === 'verified').reduce((s, p) => s + p.amount_ghs, 0);
  const pledged = pledges.filter((p) => p.status === 'active').reduce((s, p) => s + p.amount, 0);
  return { payments, pledges, paid, pledged, remaining: Math.max(0, pledged - paid) };
}

export async function queues(db: Db | any, actor: Actor) {
  need(actor, 'fin.view', 'view payment queues');
  const sel = `SELECT p.*, m.member_no, m.full_name, u.display_name AS recorded_by_name FROM payments p
    LEFT JOIN members m ON m.id=p.member_id LEFT JOIN users u ON u.id=p.recorded_by`;
  return {
    pending: await q(db, sel + ` WHERE p.status='pending' AND p.source<>'gateway' ORDER BY p.paid_on`),
    exceptions: await q(db, sel + ` WHERE p.status='exception' ORDER BY p.paid_on`),
    reversals: await q(db, sel + ` WHERE p.status='reversal_requested' ORDER BY p.paid_on`),
    clearing: await balance(db, 'CLEARING'),
  };
}
