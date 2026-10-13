/** Files, announcements, events and CSV exports. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Actor, Db, q, one, need, audit, notify, forbid, invalid, perms } from '../lib.js';
import { standings } from './competition.js';

/* ───────── private files (stored in PostgreSQL, so they are backed up with the ledger) */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 4).toString() === '%PDF',
};
const UPLOAD_PERM: Record<string, string> = { payment_evidence: 'pay', site_photo: 'proj.edit', inspection: 'proj.edit', handover: 'proj.edit', defect: 'proj.edit', general: 'gov.manage' };
export const UploadInput = z.object({ kind: z.enum(['payment_evidence', 'site_photo', 'inspection', 'handover', 'defect', 'general']), fileName: z.string().min(1).max(120),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']), dataBase64: z.string().min(8), linkedType: z.string().optional(), linkedId: z.string().optional() });
export async function upload(db: Db, actor: Actor, input: z.infer<typeof UploadInput>) {
  need(actor, UPLOAD_PERM[input.kind], 'upload this kind of file');
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (bytes.length > 3_000_000) throw invalid('Files must be 3 MB or smaller. Photos are shrunk automatically in the app.');
  if (!MAGIC[input.mime](bytes)) throw invalid('The file does not match its type. Upload a JPEG, PNG, WebP or PDF.');
  const [f] = await q<any>(db, `INSERT INTO files (kind, linked_type, linked_id, file_name, mime, size_bytes, sha256, bytes, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [input.kind, input.linkedType ?? null, input.linkedId ?? null, input.fileName.replace(/[^\w.\- ]/g, '_'), input.mime, bytes.length, createHash('sha256').update(bytes).digest('hex'), bytes, actor.userId]);
  await audit(db, actor, 'Uploaded file', f.id, `${input.kind} · ${input.fileName}`);
  return { id: f.id };
}
export async function download(db: Db | any, actor: Actor, id: string) {
  const f = await one<any>(db, 'SELECT * FROM files WHERE id=$1', [id]);
  const p = perms(actor);
  const ok = f.kind === 'payment_evidence' ? (f.uploaded_by === actor.userId || p.has('fin.view')) : f.kind === 'general' ? true : p.has('proj.view');
  if (!ok) throw forbid('You cannot open this file.');
  return f;
}

/* ───────── announcements */
export const AnnouncementInput = z.object({ title: z.string().min(3).max(140), body: z.string().min(3).max(4000), sendEmail: z.boolean().default(true) });
export async function postAnnouncement(db: Db, actor: Actor, input: z.infer<typeof AnnouncementInput>) {
  need(actor, 'gov.manage', 'post announcements');
  const [a] = await q<any>(db, 'INSERT INTO announcements (title, body, posted_by) VALUES ($1,$2,$3) RETURNING id', [input.title, input.body, actor.userId]);
  await notify(db, 'all', input.sendEmail ? ['in_app', 'email'] : ['in_app'], `${input.title}: ${input.body.slice(0, 300)}`, 'general');
  await audit(db, actor, 'Posted announcement', String(a.id), input.title);
  return { id: a.id };
}
export const listAnnouncements = (db: Db | any) => q(db, `SELECT a.id, a.title, a.body, a.posted_at, u.display_name posted_by FROM announcements a JOIN users u ON u.id=a.posted_by ORDER BY posted_at DESC LIMIT 30`);

/* ───────── events & RSVPs (reunions, meetings, the dedication ceremony) */
export const EventInput = z.object({ title: z.string().min(3), startsAt: z.string(), venue: z.string().min(2), details: z.string().max(2000).default('') });
export async function createEvent(db: Db, actor: Actor, input: z.infer<typeof EventInput>) {
  need(actor, 'gov.manage', 'create events');
  const [e] = await q<any>(db, 'INSERT INTO events (title, starts_at, venue, details, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [input.title, input.startsAt, input.venue, input.details, actor.userId]);
  await notify(db, 'all', ['in_app', 'email', 'sms'], `Ɔdadeɛ 2003 event: ${input.title}, ${new Date(input.startsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} at ${input.venue}. RSVP in the app.`, 'general');
  await audit(db, actor, 'Created event', String(e.id), input.title);
  return { id: e.id };
}
export const RsvpInput = z.object({ response: z.enum(['yes', 'no', 'maybe']), guests: z.number().int().min(0).max(5).default(0) });
export async function rsvp(db: Db, actor: Actor, eventId: number, input: z.infer<typeof RsvpInput>) {
  need(actor, 'own', 'reply to events');
  if (!actor.memberId) throw forbid('Only members can RSVP.');
  await one(db, 'SELECT id FROM events WHERE id=$1', [eventId]);
  await db.query(`INSERT INTO event_rsvps (event_id, member_id, response, guests) VALUES ($1,$2,$3,$4)
    ON CONFLICT (event_id, member_id) DO UPDATE SET response=EXCLUDED.response, guests=EXCLUDED.guests, updated_at=now()`, [eventId, actor.memberId, input.response, input.guests]);
}
export const listEvents = (db: Db | any, memberId: string | null) => q(db, `SELECT e.*, (SELECT count(*)::int FROM event_rsvps r WHERE r.event_id=e.id AND r.response='yes') going,
    (SELECT coalesce(sum(guests),0)::int FROM event_rsvps r WHERE r.event_id=e.id AND r.response='yes') guests,
    (SELECT response FROM event_rsvps r WHERE r.event_id=e.id AND r.member_id=$1) my_response FROM events e ORDER BY starts_at`, [memberId]);

/* ───────── CSV exports (for committee meetings and the independent reviewer) */
const csv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => { const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
};
export async function exportCsv(db: Db | any, actor: Actor, name: string) {
  const ghs = (col: string) => `round(${col}/100.0, 2)`;
  switch (name) {
    case 'my-statement':
      need(actor, 'own', 'export a statement');
      return csv(await q(db, `SELECT paid_on, external_ref, channel, currency, round(amount_original/100.0,2) amount_original, ${ghs('amount_ghs')} amount_ghs, status, receipt_no FROM payments WHERE member_id=$1 AND category='member' ORDER BY paid_on`, [actor.memberId]));
    case 'payments':
      need(actor, 'reports', 'export payments');
      return csv(await q(db, `SELECT p.paid_on, p.external_ref, m.member_no, p.category, p.channel, p.network, p.currency, ${ghs('p.amount_ghs')} amount_ghs, ${ghs('p.fee_ghs')} fee_ghs, p.status, p.receipt_no, ru.display_name recorded_by, vu.display_name verified_by
        FROM payments p LEFT JOIN members m ON m.id=p.member_id LEFT JOIN users ru ON ru.id=p.recorded_by LEFT JOIN users vu ON vu.id=p.verified_by ORDER BY p.paid_on, p.created_at`));
    case 'ledger':
      need(actor, 'reports', 'export the ledger');
      return csv(await q(db, `SELECT t.effective_date, t.kind, t.source_type, t.source_id, e.account, ${ghs('e.debit')} debit, ${ghs('e.credit')} credit, t.memo, t.reversal_of FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.txn_id ORDER BY e.id`));
    case 'standings': {
      const s = await standings(db);
      return csv(s.rows.map((r) => ({ rank: r.rank, house: r.name, eligible: r.eligible, target_ghs: r.target / 100, raised_ghs: r.raised / 100, achievement: (r.achievement * 100).toFixed(1) + '%', participation: (r.participation * 100).toFixed(1) + '%', score: r.score })));
    }
    case 'members':
      need(actor, 'admin.members', 'export the register');
      return csv(await q(db, `SELECT m.member_no, m.full_name, hm.house_id, coalesce(m.email,u.email) email, m.phone, m.city, m.verified_at IS NOT NULL verified FROM members m LEFT JOIN users u ON u.id=m.user_id JOIN house_memberships hm ON hm.member_id=m.id AND hm.valid_to IS NULL ORDER BY m.member_no`));
    default: throw invalid('Unknown export.');
  }
}
