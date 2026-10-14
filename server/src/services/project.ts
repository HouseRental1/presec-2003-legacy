import { z } from 'zod';
import { Actor, Db, q, one, need, audit, forbid, conflict, invalid, setting, fmt, today } from '../lib.js';

const PROJECT = 'P1';

/** Weighted progress (0–100) for each evidence stage. */
export async function progress(db: Db | any) {
  const wps = await q<any>(db, 'SELECT * FROM work_packages WHERE project_id=$1 ORDER BY id', [PROJECT]);
  const w = (k: string) => wps.reduce((s, x) => s + (x.weight_bp * x[k]) / 10000, 0);
  return { reported: w('reported_pct'), verified: w('verified_pct'), accepted: w('accepted_pct'), workPackages: wps };
}

const Pct = z.object({ pct: z.number().int().min(0).max(100), evidence: z.string().min(3).max(500), fileId: z.string().uuid().optional() });
export const PctInput = Pct;

/** Stage 1 — the PM records what the contractor reports, with evidence. */
export async function reportProgress(db: Db, actor: Actor, wpId: string, input: z.infer<typeof Pct>) {
  need(actor, 'proj.edit', 'record contractor reports');
  const wp = await one<any>(db, 'SELECT * FROM work_packages WHERE id=$1 FOR UPDATE', [wpId]);
  if (input.pct < wp.reported_pct) throw invalid('Reported progress cannot go backwards. Record a defect instead.');
  await db.query('UPDATE work_packages SET reported_pct=$2 WHERE id=$1', [wpId, input.pct]);
  await db.query(`INSERT INTO progress_events (wp_id, stage, pct, evidence, recorded_by, file_id) VALUES ($1,'reported',$2,$3,$4,$5)`, [wpId, input.pct, input.evidence, actor.userId, input.fileId ?? null]);
  await audit(db, actor, 'Recorded contractor progress', wpId, `${input.pct}% · ${input.evidence}`);
}
/** Stage 2 — a committee member checks on site. Must be someone other than whoever recorded the report. */
export async function verifyProgress(db: Db, actor: Actor, wpId: string, input: z.infer<typeof Pct>) {
  need(actor, 'proj.verify', 'verify progress on site');
  const wp = await one<any>(db, 'SELECT * FROM work_packages WHERE id=$1 FOR UPDATE', [wpId]);
  if (input.pct > wp.reported_pct) throw invalid('Verified progress cannot exceed what the contractor reported.');
  if (input.pct < wp.verified_pct) throw invalid('Verified progress cannot go backwards.');
  const [last] = await q<any>(db, `SELECT recorded_by FROM progress_events WHERE wp_id=$1 AND stage='reported' ORDER BY id DESC LIMIT 1`, [wpId]);
  if (last?.recorded_by === actor.userId) throw forbid('You recorded the contractor report, so someone else must verify it.');
  await db.query('UPDATE work_packages SET verified_pct=$2 WHERE id=$1', [wpId, input.pct]);
  await db.query(`INSERT INTO progress_events (wp_id, stage, pct, evidence, recorded_by, file_id) VALUES ($1,'verified',$2,$3,$4,$5)`, [wpId, input.pct, input.evidence, actor.userId, input.fileId ?? null]);
  await audit(db, actor, 'Verified progress on site', wpId, `${input.pct}%`);
}
/** Stage 3 — the PM records the inspector's acceptance. Open defects block 100%. Acceptance never authorises payment. */
export const AcceptInput = Pct.extend({ inspector: z.string().min(3) });
export async function acceptProgress(db: Db, actor: Actor, wpId: string, input: z.infer<typeof AcceptInput>) {
  need(actor, 'proj.edit', 'record inspections');
  const wp = await one<any>(db, 'SELECT * FROM work_packages WHERE id=$1 FOR UPDATE', [wpId]);
  if (input.pct > wp.verified_pct) throw invalid('Accepted progress cannot exceed verified progress.');
  if (input.pct < wp.accepted_pct) throw invalid('Accepted progress cannot go backwards.');
  const open = await q(db, `SELECT id FROM defects WHERE wp_id=$1 AND status='open'`, [wpId]);
  if (input.pct === 100 && open.length) throw conflict('This package has an open defect. Close it before final acceptance.');
  await db.query('UPDATE work_packages SET accepted_pct=$2 WHERE id=$1', [wpId, input.pct]);
  await db.query(`INSERT INTO progress_events (wp_id, stage, pct, evidence, recorded_by) VALUES ($1,'accepted',$2,$3,$4)`, [wpId, input.pct, `${input.inspector}: ${input.evidence}`, actor.userId]);
  const [{ n }] = await q<any>(db, 'SELECT count(*)::int n FROM inspections');
  await db.query(`INSERT INTO inspections (id, wp_id, inspected_on, inspector, result, note) VALUES ($1,$2,$3,$4,'passed',$5)`, [`INS-${String(n + 1).padStart(2, '0')}`, wpId, today(), input.inspector, input.evidence]);
  await audit(db, actor, 'Recorded inspection acceptance', wpId, `${input.pct}% · ${input.inspector}`);
}

export const DefectClose = z.object({ evidence: z.string().min(3) });
export async function closeDefect(db: Db, actor: Actor, id: string, input: z.infer<typeof DefectClose>) {
  need(actor, 'proj.edit', 'close defects');
  const d = await one<any>(db, 'SELECT * FROM defects WHERE id=$1 FOR UPDATE', [id]);
  if (d.status !== 'open') throw conflict('Defect is already closed.');
  await db.query(`UPDATE defects SET status='closed', closed_by=$2, closure_evidence=$3 WHERE id=$1`, [id, actor.userId, input.evidence]);
  await audit(db, actor, 'Closed defect', id, input.evidence);
}

/* ───────── variations: committee up to the threshold, member vote above it */
export const VariationInput = z.object({ title: z.string().min(3), amountGhs: z.number().positive(), reason: z.string().min(3), wpId: z.string().optional() });
export async function proposeVariation(db: Db, actor: Actor, input: z.infer<typeof VariationInput>) {
  need(actor, 'proj.edit', 'propose variations');
  const limit = await setting<number>(db, 'member_vote_above');
  const amount = Math.round(input.amountGhs * 100);
  const big = amount > limit;
  const [{ n }] = await q<any>(db, 'SELECT count(*)::int n FROM variations');
  const id = `VAR-${String(n + 1).padStart(2, '0')}`;
  await db.query(`INSERT INTO variations (id, project_id, wp_id, title, amount, reason, funded_from, route, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, PROJECT, input.wpId ?? null, input.title, amount, input.reason, big ? 'budget_revision' : 'contingency', big ? 'member_vote' : 'committee', big ? 'awaiting_vote' : 'awaiting_committee']);
  await audit(db, actor, 'Proposed variation', id, fmt(amount));
  return { id, route: big ? 'member_vote' : 'committee' };
}
export async function decideVariation(db: Db, actor: Actor, id: string, approve: boolean) {
  need(actor, 'var.approve', 'approve variations');
  const v = await one<any>(db, 'SELECT * FROM variations WHERE id=$1 FOR UPDATE', [id]);
  if (v.route !== 'committee') throw forbid(`Variations above the member-vote threshold need a member ballot.`);
  if (v.status !== 'awaiting_committee') throw conflict(`Variation is ${v.status}.`);
  if (approve) {
    const [bv] = await q<any>(db, 'SELECT * FROM budget_versions WHERE project_id=$1 ORDER BY version DESC LIMIT 1', [PROJECT]);
    const [{ used }] = await q<any>(db, `SELECT coalesce(sum(amount),0) used FROM variations WHERE status='approved' AND funded_from='contingency'`);
    if (used + v.amount > bv.lines.contingency) throw conflict('Not enough contingency left. This change needs a budget revision and member vote.');
  }
  await db.query('UPDATE variations SET status=$2, decided_by=$3 WHERE id=$1', [id, approve ? 'approved' : 'rejected', actor.userId]);
  await audit(db, actor, approve ? 'Approved variation' : 'Rejected variation', id, fmt(v.amount));
}

/** Apply a member-approved variation: new budget version; baseline untouched. */
export async function applyVotedVariation(db: Db, id: string, passed: boolean, proposalId: string) {
  const v = await one<any>(db, 'SELECT * FROM variations WHERE id=$1 FOR UPDATE', [id]);
  if (!passed) { await db.query(`UPDATE variations SET status='rejected' WHERE id=$1`, [id]); return; }
  const [bv] = await q<any>(db, 'SELECT * FROM budget_versions WHERE project_id=$1 ORDER BY version DESC LIMIT 1', [PROJECT]);
  const [{ used }] = await q<any>(db, `SELECT coalesce(sum(amount),0) used FROM variations WHERE status='approved' AND funded_from='contingency'`);
  const contingencyLeft = Math.max(0, bv.lines.contingency - used);
  const fromContingency = Math.min(contingencyLeft, v.amount);
  const lines = { ...bv.lines, contract: bv.lines.contract + v.amount, contingency: bv.lines.contingency - fromContingency };
  await db.query(`INSERT INTO budget_versions (project_id, version, total, lines, approved_by, note) VALUES ($1,$2,$3,$4,$5,$6)`,
    [PROJECT, bv.version + 1, bv.total + v.amount - fromContingency, lines, `Member vote ${proposalId}`, `${v.id}: ${v.title}; contingency balance applied first`]);
  await db.query(`UPDATE variations SET status='approved' WHERE id=$1`, [id]);
}

export async function overview(db: Db | any, actor: Actor) {
  need(actor, 'proj.view', 'view the project');
  const p = await progress(db);
  return {
    progress: { reported: p.reported, verified: p.verified, accepted: p.accepted },
    workPackages: p.workPackages,
    contract: (await q(db, `SELECT c.*, s.name supplier FROM contracts c JOIN suppliers s ON s.id=c.supplier_id`))[0] ?? null,
    budgetVersions: await q(db, 'SELECT * FROM budget_versions ORDER BY version'),
    variations: await q(db, 'SELECT * FROM variations ORDER BY id'),
    inspections: await q(db, 'SELECT * FROM inspections ORDER BY inspected_on'),
    defects: await q(db, 'SELECT * FROM defects ORDER BY id'),
    risks: await q(db, 'SELECT * FROM risks ORDER BY id'),
    photos: await q(db, `SELECT pe.wp_id, pe.stage, pe.pct, pe.recorded_at, pe.file_id FROM progress_events pe WHERE pe.file_id IS NOT NULL ORDER BY pe.id DESC LIMIT 24`),
  };
}
