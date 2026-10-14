/**
 * Project lifecycle: Initiation → Planning & design → Procurement → Execution → Closing & handover.
 * The project manager keeps each phase's checklist with evidence; the committee signs off the
 * stage gate, which is only possible when every deliverable is done or marked not applicable.
 * Signing a gate closes that phase and opens the next. Everything is audited.
 */
import { z } from 'zod';
import { Actor, Db, q, one, need, audit, notify, conflict, invalid, forbid, today, perms } from '../lib.js';

const PROJECT = 'P1';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optDate = date.optional().or(z.literal('')).transform((v) => v || null);

export async function lifecycle(db: Db | any, actor: Actor) {
  need(actor, 'proj.view', 'view the project');
  const [project] = await q<any>(db, 'SELECT * FROM projects WHERE id=$1', [PROJECT]);
  const phases = await q<any>(db, `SELECT ph.*, u.display_name gate_approved_by_name FROM project_phases ph LEFT JOIN users u ON u.id=ph.gate_approved_by WHERE project_id=$1 ORDER BY seq`, [PROJECT]);
  const items = await q<any>(db, `SELECT d.*, u.display_name updated_by_name FROM phase_deliverables d LEFT JOIN users u ON u.id=d.updated_by WHERE project_id=$1 ORDER BY phase_key, seq, id`, [PROJECT]);
  const updates = await q<any>(db, `SELECT pu.*, u.display_name posted_by_name FROM project_updates pu JOIN users u ON u.id=pu.posted_by WHERE project_id=$1 ORDER BY posted_at DESC LIMIT 50`, [PROJECT]);
  const byPhase = phases.map((ph) => {
    const list = items.filter((d) => d.phase_key === ph.key);
    const closed = list.filter((d) => d.status === 'done' || d.status === 'not_applicable').length;
    const overdue = list.filter((d) => d.due_on && d.due_on < today() && !['done', 'not_applicable'].includes(d.status)).length;
    return { ...ph, deliverables: list, total: list.length, closed, overdue, readyForGate: ph.status === 'in_progress' && list.length > 0 && closed === list.length };
  });
  const current = byPhase.find((p) => p.status === 'in_progress') ?? byPhase.filter((p) => p.status === 'complete').at(-1) ?? null;
  return { project, phases: byPhase, currentPhase: current?.key ?? null, updates };
}

/* ───────── project details (charter) */
export const DetailsInput = z.object({
  name: z.string().trim().min(3).max(160), description: z.string().max(4000).default(''), site: z.string().max(300).default(''),
  objectives: z.string().max(4000).default(''), scope: z.string().max(4000).default(''), sponsor: z.string().max(200).default(''),
  schoolContact: z.string().max(300).default(''), plannedStart: optDate, plannedEnd: optDate,
});
export async function updateDetails(db: Db, actor: Actor, input: z.infer<typeof DetailsInput>) {
  // The project manager or the committee may edit the charter.
  if (!perms(actor).has('rules.edit')) need(actor, 'proj.edit', 'edit the project details');
  if (input.plannedStart && input.plannedEnd && input.plannedEnd < input.plannedStart) throw invalid('The planned end must be after the planned start.');
  await db.query(`UPDATE projects SET name=$2, description=$3, site=$4, objectives=$5, scope=$6, sponsor=$7, school_contact=$8, planned_start=$9, planned_end=$10 WHERE id=$1`,
    [PROJECT, input.name, input.description, input.site, input.objectives, input.scope, input.sponsor, input.schoolContact, input.plannedStart, input.plannedEnd]);
  await audit(db, actor, 'Updated project details', PROJECT, input.name);
}

/* ───────── phases */
export const PhaseDatesInput = z.object({ plannedStart: optDate, plannedEnd: optDate });
export async function setPhaseDates(db: Db, actor: Actor, key: string, input: z.infer<typeof PhaseDatesInput>) {
  need(actor, 'proj.edit', 'plan phases');
  if (input.plannedStart && input.plannedEnd && input.plannedEnd < input.plannedStart) throw invalid('The planned end must be after the planned start.');
  const r = await db.query('UPDATE project_phases SET planned_start=$3, planned_end=$4 WHERE project_id=$1 AND key=$2', [PROJECT, key, input.plannedStart, input.plannedEnd]);
  if (!r.rowCount) throw invalid('Unknown phase.');
  await audit(db, actor, 'Planned phase dates', key, `${input.plannedStart ?? '—'} → ${input.plannedEnd ?? '—'}`);
}

/** Stage gate: committee sign-off. Requires every deliverable in the phase to be closed. */
export const GateInput = z.object({ note: z.string().trim().min(3, 'Add a short note, e.g. the meeting or resolution that approved it.').max(1000) });
export async function approveGate(db: Db, actor: Actor, key: string, input: z.infer<typeof GateInput>) {
  need(actor, 'proj.verify', 'sign off a phase');
  const ph = await one<any>(db, 'SELECT * FROM project_phases WHERE project_id=$1 AND key=$2 FOR UPDATE', [PROJECT, key]);
  if (ph.status !== 'in_progress') throw conflict(`This phase is ${ph.status.replace('_', ' ')}, so it cannot be signed off.`);
  const open = await q<any>(db, `SELECT title FROM phase_deliverables WHERE project_id=$1 AND phase_key=$2 AND status NOT IN ('done','not_applicable') ORDER BY seq`, [PROJECT, key]);
  if (open.length) throw conflict(`${open.length} item${open.length > 1 ? 's are' : ' is'} still open: ${open.slice(0, 3).map((o) => o.title).join('; ')}${open.length > 3 ? '…' : ''}`);
  const [{ n }] = await q<any>(db, `SELECT count(*)::int n FROM phase_deliverables WHERE project_id=$1 AND phase_key=$2`, [PROJECT, key]);
  if (!n) throw conflict('Add at least one deliverable before signing off this phase.');
  await db.query(`UPDATE project_phases SET status='complete', actual_end=current_date, gate_approved_by=$3, gate_approved_at=now(), gate_note=$4 WHERE project_id=$1 AND key=$2`, [PROJECT, key, actor.userId, input.note]);
  const [next] = await q<any>(db, `SELECT key, name FROM project_phases WHERE project_id=$1 AND seq=$2`, [PROJECT, ph.seq + 1]);
  if (next) await db.query(`UPDATE project_phases SET status='in_progress', actual_start=current_date WHERE project_id=$1 AND key=$2`, [PROJECT, next.key]);
  await notify(db, 'all', ['in_app', 'email'], `Classroom block: the ${ph.name} phase is complete${next ? `. Next: ${next.name}.` : ' — the project is closed and handed over to PRESEC.'}`, 'general');
  await audit(db, actor, 'Signed off phase', key, input.note);
  return { closed: key, opened: next?.key ?? null };
}

/** Reopen a completed phase (e.g. a missed deliverable). Only the latest completed phase, by the committee. */
export async function reopenPhase(db: Db, actor: Actor, key: string, reason: string) {
  need(actor, 'proj.verify', 'reopen a phase');
  const ph = await one<any>(db, 'SELECT * FROM project_phases WHERE project_id=$1 AND key=$2 FOR UPDATE', [PROJECT, key]);
  if (ph.status !== 'complete') throw conflict('Only a completed phase can be reopened.');
  const [later] = await q<any>(db, `SELECT key FROM project_phases WHERE project_id=$1 AND seq=$2 AND status='complete'`, [PROJECT, ph.seq + 1]);
  if (later) throw conflict('Reopen the later phase first.');
  await db.query(`UPDATE project_phases SET status='not_started', actual_start=NULL WHERE project_id=$1 AND seq=$2`, [PROJECT, ph.seq + 1]);
  await db.query(`UPDATE project_phases SET status='in_progress', actual_end=NULL, gate_approved_by=NULL, gate_approved_at=NULL, gate_note=NULL WHERE project_id=$1 AND key=$2`, [PROJECT, key]);
  await audit(db, actor, 'Reopened phase', key, reason);
}

/* ───────── deliverables (the checklist) */
export const DeliverableInput = z.object({
  phaseKey: z.enum(['initiation', 'planning', 'procurement', 'execution', 'closing']), title: z.string().trim().min(3).max(300),
  owner: z.string().max(120).optional(), dueOn: optDate,
});
export async function addDeliverable(db: Db, actor: Actor, input: z.infer<typeof DeliverableInput>) {
  need(actor, 'proj.edit', 'add checklist items');
  const ph = await one<any>(db, 'SELECT status FROM project_phases WHERE project_id=$1 AND key=$2', [PROJECT, input.phaseKey]);
  if (ph.status === 'complete') throw conflict('That phase is signed off. Reopen it first.');
  const [d] = await q<any>(db, `INSERT INTO phase_deliverables (project_id, phase_key, seq, title, owner, due_on, updated_by, updated_at) VALUES ($1,$2,(SELECT coalesce(max(seq),0)+1 FROM phase_deliverables WHERE project_id=$1 AND phase_key=$2),$3,$4,$5,$6,now()) RETURNING id`,
    [PROJECT, input.phaseKey, input.title, input.owner || null, input.dueOn, actor.userId]);
  await audit(db, actor, 'Added checklist item', String(d.id), `${input.phaseKey}: ${input.title}`);
  return { id: d.id };
}
export const DeliverableUpdate = z.object({
  status: z.enum(['todo', 'in_progress', 'done', 'not_applicable']).optional(), owner: z.string().max(120).optional(), dueOn: optDate,
  evidence: z.string().max(2000).optional(), fileId: z.string().uuid().optional(),
});
export async function updateDeliverable(db: Db, actor: Actor, id: number, input: z.infer<typeof DeliverableUpdate>) {
  need(actor, 'proj.edit', 'update checklist items');
  const d = await one<any>(db, 'SELECT d.*, ph.status phase_status FROM phase_deliverables d JOIN project_phases ph ON ph.project_id=d.project_id AND ph.key=d.phase_key WHERE d.id=$1 FOR UPDATE OF d', [id]);
  if (d.phase_status === 'complete') throw conflict('That phase is signed off. Reopen it before changing its checklist.');
  const status = input.status ?? d.status;
  const evidence = input.evidence !== undefined ? input.evidence.trim() : d.evidence;
  if ((status === 'done' || status === 'not_applicable') && (!evidence || evidence.length < 3))
    throw invalid(status === 'done' ? 'Say what shows this is done, e.g. “Permit no. 123 issued 4 Nov”, or attach the document.' : 'Say why this item does not apply.');
  await db.query(`UPDATE phase_deliverables SET status=$2, owner=coalesce($3, owner), due_on=CASE WHEN $4::boolean THEN $5::date ELSE due_on END, evidence=$6, file_id=coalesce($7, file_id), updated_by=$8, updated_at=now() WHERE id=$1`,
    [id, status, input.owner ?? null, input.dueOn !== undefined, input.dueOn ?? null, evidence, input.fileId ?? null, actor.userId]);
  await audit(db, actor, status !== d.status ? `Checklist item ${status.replace('_', ' ')}` : 'Updated checklist item', String(id), d.title + (evidence ? ` — ${evidence}` : ''));
}

/* ───────── progress updates (reports to the year group) */
export const UpdateInput = z.object({ title: z.string().trim().min(3).max(160), body: z.string().trim().min(3).max(6000), public: z.boolean().default(false), fileId: z.string().uuid().optional(), notify: z.boolean().default(true) });
export async function postUpdate(db: Db, actor: Actor, input: z.infer<typeof UpdateInput>) {
  need(actor, 'proj.edit', 'post project updates');
  const [cur] = await q<any>(db, `SELECT key FROM project_phases WHERE project_id=$1 AND status='in_progress' ORDER BY seq LIMIT 1`, [PROJECT]);
  const [u] = await q<any>(db, `INSERT INTO project_updates (project_id, phase_key, title, body, file_id, public, posted_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [PROJECT, cur?.key ?? null, input.title, input.body, input.fileId ?? null, input.public, actor.userId]);
  if (input.notify) await notify(db, 'all', ['in_app', 'email'], `Classroom block update: ${input.title}`, 'general');
  await audit(db, actor, 'Posted project update', String(u.id), input.title);
  return { id: u.id };
}

/** Public summary: phases and approved description only. */
export async function publicLifecycle(db: Db | any) {
  const [p] = await q<any>(db, 'SELECT name, description, site, planned_start, planned_end FROM projects WHERE id=$1', [PROJECT]);
  const phases = await q<any>(db, 'SELECT key, name, status, actual_start, actual_end FROM project_phases WHERE project_id=$1 ORDER BY seq', [PROJECT]);
  const updates = await q<any>(db, 'SELECT title, body, posted_at FROM project_updates WHERE project_id=$1 AND public ORDER BY posted_at DESC LIMIT 5', [PROJECT]);
  return { project: p ?? null, phases, updates };
}
void forbid;
