import { z } from 'zod';
import { Actor, Db, q, one, need, audit, conflict } from '../lib.js';

export async function archive(db: Db | any, actor: Actor) {
  need(actor, 'proj.view', 'view the legacy archive');
  return {
    handover: await q(db, 'SELECT * FROM handover_items ORDER BY id'),
    maintenance: await q(db, `SELECT i.*, (SELECT json_agg(l ORDER BY l.done_on DESC) FROM maintenance_log l WHERE l.item_id=i.id) log FROM maintenance_items i ORDER BY i.id`),
  };
}
export const ReceiveInput = z.object({ documentRef: z.string().min(2) });
export async function receiveHandoverItem(db: Db, actor: Actor, id: string, input: z.infer<typeof ReceiveInput>) {
  need(actor, 'proj.edit', 'record handover documents');
  const h = await one<any>(db, 'SELECT * FROM handover_items WHERE id=$1 FOR UPDATE', [id]);
  if (h.status === 'received') throw conflict('Already received.');
  await db.query(`UPDATE handover_items SET status='received', document_ref=$2, received_by=$3, received_on=current_date WHERE id=$1`, [id, input.documentRef, actor.userId]);
  await audit(db, actor, 'Received handover document', id, input.documentRef);
}
export const LogInput = z.object({ doneOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().min(3), costGhs: z.number().nonnegative().default(0) });
export async function logMaintenance(db: Db, actor: Actor, itemId: number, input: z.infer<typeof LogInput>) {
  need(actor, 'proj.edit', 'log maintenance');
  await one(db, 'SELECT id FROM maintenance_items WHERE id=$1', [itemId]);
  await db.query('INSERT INTO maintenance_log (item_id, done_on, note, cost, recorded_by) VALUES ($1,$2,$3,$4,$5)', [itemId, input.doneOn, input.note, Math.round(input.costGhs * 100), actor.userId]);
  await audit(db, actor, 'Logged maintenance', String(itemId), input.note);
}
