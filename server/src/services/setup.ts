/** Committee and project set-up: settings, contract, budget baseline, work packages, risks, inspections, defects, competition periods. */
import { z } from 'zod';
import { Actor, Db, q, one, need, audit, conflict, invalid, setting, fmt, today } from '../lib.js';
import { freezeEligible } from './competition.js';

const PROJECT = 'P1';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ───────── control settings (committee); every change is audited with old and new values */
export const SettingsInput = z.object({ dualApprovalAboveGhs: z.number().positive().optional(), memberVoteAboveGhs: z.number().positive().optional(), quorumPct: z.number().min(0).max(100).optional(),
  momoFeePct: z.number().min(0).max(10).optional(), cardFeePct: z.number().min(0).max(10).optional(), fxUSD: z.number().positive().optional(), fxGBP: z.number().positive().optional() });
export async function updateSettings(db: Db, actor: Actor, input: z.infer<typeof SettingsInput>) {
  need(actor, 'rules.edit', 'change control settings');
  const set = async (key: string, value: unknown) => {
    const old = await setting(db, key);
    await db.query('UPDATE settings SET value=$2 WHERE key=$1', [key, JSON.stringify(value)]);
    await audit(db, actor, 'Changed setting', key, `${JSON.stringify(old)} → ${JSON.stringify(value)}`);
  };
  if (input.dualApprovalAboveGhs) await set('dual_approval_above', Math.round(input.dualApprovalAboveGhs * 100));
  if (input.memberVoteAboveGhs) await set('member_vote_above', Math.round(input.memberVoteAboveGhs * 100));
  if (input.quorumPct !== undefined) await set('quorum_bp', Math.round(input.quorumPct * 100));
  if (input.momoFeePct !== undefined || input.cardFeePct !== undefined) {
    const f = await setting<any>(db, 'fees');
    await set('fees', { momo_bp: input.momoFeePct !== undefined ? Math.round(input.momoFeePct * 100) : f.momo_bp, card_bp: input.cardFeePct !== undefined ? Math.round(input.cardFeePct * 100) : f.card_bp });
  }
  if (input.fxUSD || input.fxGBP) { const fx = await setting<any>(db, 'fx_indicative'); await set('fx_indicative', { ...fx, USD: input.fxUSD ?? fx.USD, GBP: input.fxGBP ?? fx.GBP }); }
}
export async function getSettings(db: Db | any) {
  const rows = await q<any>(db, 'SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/* ───────── contract and budget baseline (committee, after the member vote that approves them) */
export const ContractInput = z.object({ id: z.string().min(2).max(20), supplier: z.string().min(2), valueGhs: z.number().positive(), retentionPct: z.number().min(0).max(20).default(10), signedOn: date, startOn: date, endOn: date });
export async function createContract(db: Db, actor: Actor, input: z.infer<typeof ContractInput>) {
  need(actor, 'rules.edit', 'record contracts');
  let [s] = await q<any>(db, 'SELECT id FROM suppliers WHERE name=$1', [input.supplier]);
  if (!s) s = await one<any>(db, 'INSERT INTO suppliers (name) VALUES ($1) RETURNING id', [input.supplier]);
  await db.query('INSERT INTO contracts VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [input.id, PROJECT, s.id, Math.round(input.valueGhs * 100), Math.round(input.retentionPct * 100), input.signedOn, input.startOn, input.endOn]);
  await audit(db, actor, 'Recorded contract', input.id, `${input.supplier} ${fmt(Math.round(input.valueGhs * 100))}`);
}
export const BaselineInput = z.object({ contractGhs: z.number().nonnegative(), feesGhs: z.number().nonnegative(), contingencyGhs: z.number().nonnegative(), approvedBy: z.string().min(3) });
export async function setBaseline(db: Db, actor: Actor, input: z.infer<typeof BaselineInput>) {
  need(actor, 'rules.edit', 'set the budget baseline');
  if ((await q(db, 'SELECT 1 FROM budget_versions WHERE project_id=$1', [PROJECT])).length) throw conflict('A baseline already exists. Later changes go through variations and, above the threshold, a member vote.');
  const lines = { contract: Math.round(input.contractGhs * 100), fees: Math.round(input.feesGhs * 100), contingency: Math.round(input.contingencyGhs * 100) };
  await db.query(`INSERT INTO budget_versions (project_id, version, total, lines, approved_by, note) VALUES ($1,1,$2,$3,$4,'Baseline')`, [PROJECT, lines.contract + lines.fees + lines.contingency, lines, input.approvedBy]);
  await audit(db, actor, 'Set budget baseline', 'v1', fmt(lines.contract + lines.fees + lines.contingency));
}

/* ───────── work packages (PM; weights must total 100%; weights freeze once progress is recorded) */
export const WorkPackageInput = z.object({ id: z.string().regex(/^WP\d{2}$/), name: z.string().min(3), weightPct: z.number().min(0).max(100), budgetGhs: z.number().nonnegative() });
export async function upsertWorkPackage(db: Db, actor: Actor, input: z.infer<typeof WorkPackageInput>) {
  need(actor, 'proj.edit', 'set up work packages');
  const [existing] = await q<any>(db, 'SELECT * FROM work_packages WHERE id=$1', [input.id]);
  if (existing && (existing.reported_pct > 0) && Math.round(input.weightPct * 100) !== existing.weight_bp) throw conflict('Weights are frozen once progress has been recorded.');
  const [{ total }] = await q<any>(db, 'SELECT coalesce(sum(weight_bp),0)::int total FROM work_packages WHERE id<>$1', [input.id]);
  if (total + Math.round(input.weightPct * 100) > 10000) throw invalid(`Weights would total more than 100% (others already total ${total / 100}%).`);
  await db.query(`INSERT INTO work_packages (id, project_id, name, weight_bp, budget) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, weight_bp=EXCLUDED.weight_bp, budget=EXCLUDED.budget`, [input.id, PROJECT, input.name, Math.round(input.weightPct * 100), Math.round(input.budgetGhs * 100)]);
  await audit(db, actor, existing ? 'Updated work package' : 'Created work package', input.id, `${input.weightPct}% · ${fmt(Math.round(input.budgetGhs * 100))}`);
}

/* ───────── risks, inspections, defects (PM) */
export const RiskInput = z.object({ id: z.string().optional(), title: z.string().min(3), level: z.enum(['Low', 'Medium', 'High']), owner: z.string().min(2), action: z.string().min(3) });
export async function upsertRisk(db: Db, actor: Actor, input: z.infer<typeof RiskInput>) {
  need(actor, 'proj.edit', 'manage risks');
  const id = input.id ?? `R${(await one<any>(db, 'SELECT count(*)::int n FROM risks')).n + 1}`;
  await db.query(`INSERT INTO risks VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, level=EXCLUDED.level, owner=EXCLUDED.owner, action=EXCLUDED.action`, [id, input.title, input.level, input.owner, input.action]);
  await audit(db, actor, input.id ? 'Updated risk' : 'Added risk', id, input.level);
  return { id };
}
export const InspectionInput = z.object({ wpId: z.string(), inspectedOn: date, inspector: z.string().min(3), result: z.enum(['passed', 'passed_with_defect', 'failed']), note: z.string().min(3),
  defect: z.object({ title: z.string().min(3), action: z.string().min(3), dueOn: date }).optional() });
export async function recordInspection(db: Db, actor: Actor, input: z.infer<typeof InspectionInput>) {
  need(actor, 'proj.edit', 'record inspections');
  await one(db, 'SELECT id FROM work_packages WHERE id=$1', [input.wpId]);
  if (input.result !== 'passed' && !input.defect) throw invalid('Describe the defect the inspector found.');
  const id = `INS-${String((await one<any>(db, 'SELECT count(*)::int n FROM inspections')).n + 1).padStart(2, '0')}`;
  await db.query('INSERT INTO inspections VALUES ($1,$2,$3,$4,$5,$6)', [id, input.wpId, input.inspectedOn, input.inspector, input.result, input.note]);
  let defectId: string | null = null;
  if (input.defect) {
    defectId = `DEF-${String((await one<any>(db, 'SELECT count(*)::int n FROM defects')).n + 1).padStart(2, '0')}`;
    await db.query(`INSERT INTO defects VALUES ($1,$2,$3,$4,$5,'open',NULL,NULL)`, [defectId, input.wpId, input.defect.title, input.defect.action, input.defect.dueOn]);
  }
  await audit(db, actor, 'Recorded inspection', id, `${input.result}${defectId ? ' · ' + defectId : ''}`);
  return { id, defectId };
}

/* ───────── the first competition period (committee resolution); later versions go to a member vote */
export const PeriodInput = z.object({ version: z.string().min(1), periodName: z.string().min(3), start: date, end: date, perMemberTargetGhs: z.number().positive(), weightTarget: z.number().int().min(0).max(100), approvedBy: z.string().min(3) });
export async function openFirstPeriod(db: Db, actor: Actor, input: z.infer<typeof PeriodInput>) {
  need(actor, 'rules.edit', 'open a competition period');
  if ((await q(db, `SELECT 1 FROM competition_rules WHERE status='in_force'`)).length) throw conflict('A period is already in force. Draft the next version and put it to a member vote.');
  await db.query(`INSERT INTO competition_rules (version, status, period_name, period_start, period_end, per_member_target, weight_target, weight_participation, approved_by)
    VALUES ($1,'in_force',$2,$3,$4,$5,$6,$7,$8)`, [input.version, input.periodName, input.start, input.end, Math.round(input.perMemberTargetGhs * 100), input.weightTarget, 100 - input.weightTarget, input.approvedBy]);
  if (input.start <= today()) await freezeEligible(db, input.version);
  await audit(db, actor, 'Opened competition period', 'rules-' + input.version, `${input.start} – ${input.end}`);
}
/** Run by cron: freeze eligible counts for any in-force period that has started. */
export async function freezeDuePeriods(db: Db) {
  const due = await q<any>(db, `SELECT version FROM competition_rules WHERE status='in_force' AND eligible_snapshot IS NULL AND period_start <= current_date`);
  for (const r of due) await freezeEligible(db, r.version);
  return due.length;
}
