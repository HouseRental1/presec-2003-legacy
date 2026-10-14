import { useState } from 'react';
import { api, date, today } from '../api';
import { Bar, Pill, useSession, useToast } from '../ui';
import { useDialog, uploadFile } from '../forms';

const STATUS_LABEL: Record<string, [string, string]> = {
  not_started: ['Not started', ''], in_progress: ['In progress', 'info'], complete: ['Signed off', 'ok'],
};
const ITEM_LABEL: Record<string, [string, string]> = {
  todo: ['To do', ''], in_progress: ['In progress', 'info'], done: ['Done', 'ok'], not_applicable: ['Not applicable', ''],
};

/** The five phases as a stepper; reused on the overview. */
export function PhaseStepper({ phases, selected, onSelect }: { phases: any[]; selected?: string; onSelect?: (k: string) => void }) {
  return <div className="phases" role="list">{phases.map((p) =>
    <button key={p.key} role="listitem" type="button" className={'phase ' + p.status} aria-pressed={selected === p.key} onClick={() => onSelect?.(p.key)}>
      <span className="st">{p.seq}. {STATUS_LABEL[p.status][0]}</span>
      <span className="nm">{p.name}</span>
      <Bar v={p.total ? p.closed / p.total : 0} />
      <span className="st">{p.closed}/{p.total} items{p.overdue ? ` · ${p.overdue} overdue` : ''}</span>
    </button>)}</div>;
}

export function LifecycleTab({ lc, reload }: { lc: any; reload: () => void }) {
  const { can } = useSession();
  const toast = useToast(); const [dialog, open] = useDialog();
  const [sel, setSel] = useState<string>(lc.currentPhase ?? 'initiation');
  const ph = lc.phases.find((p: any) => p.key === sel) ?? lc.phases[0];
  if (!ph) return <div className="callout warn">The project phases have not been set up yet. Redeploy so the latest database update runs.</div>;
  const editable = can('proj.edit') && ph.status !== 'complete';
  const done = (m: string) => () => { toast(m); reload(); };

  const editItem = (d: any) => open({
    title: d.title, submit: 'Save',
    intro: <p className="small muted">Mark it done with a note of what shows it, e.g. “Permit BP/123 issued 4 Nov 2026”. You can attach the document.</p>,
    fields: [
      { name: 'status', label: 'Status', type: 'select', options: [['todo', 'To do'], ['in_progress', 'In progress'], ['done', 'Done'], ['not_applicable', 'Not applicable']], value: d.status },
      { name: 'owner', label: 'Who is responsible', value: d.owner ?? '' },
      { name: 'dueOn', label: 'Due date', type: 'date', value: d.due_on ?? '' },
      { name: 'evidence', label: 'Evidence or note', type: 'textarea', value: d.evidence ?? '' },
      { name: 'file', label: 'Attach a document or photo (optional)', type: 'file', accept: 'image/*,application/pdf' },
    ],
    onSubmit: async (v) => {
      const fileId = v.file ? await uploadFile(v.file, 'general', { type: 'deliverable', id: String(d.id) }) : undefined;
      await api.post(`/project/deliverables/${d.id}`, { status: v.status, owner: v.owner ?? '', dueOn: v.dueOn ?? '', evidence: v.evidence ?? '', fileId });
      done('Saved.')();
    },
  });

  return <div className="stack">{dialog}
    <PhaseStepper phases={lc.phases} selected={ph.key} onSelect={setSel} />
    <div className="card stack">
      <div className="card-h" style={{ margin: 0 }}>
        <div><h2>{ph.seq}. {ph.name}</h2><p className="small muted" style={{ maxWidth: '62ch' }}>{ph.purpose}</p></div>
        <Pill k={STATUS_LABEL[ph.status][1]}>{STATUS_LABEL[ph.status][0]}</Pill>
      </div>
      <dl className="kv">
        <dt>Planned</dt><dd>{ph.planned_start ? `${date(ph.planned_start)} – ${date(ph.planned_end)}` : 'Not planned yet'}</dd>
        <dt>Actual</dt><dd>{ph.actual_start ? `${date(ph.actual_start)} – ${ph.actual_end ? date(ph.actual_end) : 'ongoing'}` : '—'}</dd>
        {ph.gate_approved_at && <><dt>Signed off</dt><dd>{date(ph.gate_approved_at)} by {ph.gate_approved_by_name} — {ph.gate_note}</dd></>}
      </dl>
      <div><div className="row between small"><span>{ph.closed} of {ph.total} items closed</span>{ph.overdue > 0 && <span className="overdue">{ph.overdue} overdue</span>}</div><Bar v={ph.total ? ph.closed / ph.total : 0} /></div>
      <div className="row">
        {can('proj.edit') && <button className="btn sm" onClick={() => open({ title: 'Plan ' + ph.name, submit: 'Save dates', fields: [{ name: 'plannedStart', label: 'Planned start', type: 'date', value: ph.planned_start ?? '' }, { name: 'plannedEnd', label: 'Planned end', type: 'date', value: ph.planned_end ?? '' }], onSubmit: (v) => api.post(`/project/phases/${ph.key}/dates`, { plannedStart: v.plannedStart ?? '', plannedEnd: v.plannedEnd ?? '' }).then(done('Dates saved.')) })}>Plan dates</button>}
        {editable && <button className="btn sm" onClick={() => open({ title: 'Add to ' + ph.name, submit: 'Add item', fields: [{ name: 'title', label: 'What needs to be done or produced', required: true }, { name: 'owner', label: 'Who is responsible' }, { name: 'dueOn', label: 'Due date', type: 'date' }], onSubmit: (v) => api.post('/project/deliverables', { phaseKey: ph.key, title: v.title, owner: v.owner, dueOn: v.dueOn ?? '' }).then(done('Item added.')) })}>Add item</button>}
        {ph.status === 'in_progress' && can('proj.verify') && <button className={'btn sm' + (ph.readyForGate ? ' primary' : '')} title={ph.readyForGate ? '' : 'Every item must be done or not applicable first'} onClick={() => open({ title: 'Sign off ' + ph.name, submit: 'Sign off phase', intro: <div className={'callout ' + (ph.readyForGate ? 'ok' : 'warn')}>{ph.readyForGate ? 'Every item is closed. Signing off locks this checklist and opens the next phase. The year group is notified.' : `${ph.total - ph.closed} item(s) are still open, so sign-off will be refused.`}</div>, fields: [{ name: 'note', label: 'Approval reference (meeting, resolution or vote)', required: true }], onSubmit: (v) => api.post(`/project/phases/${ph.key}/gate`, v).then((r: any) => { toast(r.opened ? 'Phase signed off. The next phase is open.' : 'Final phase signed off. The project is closed.'); reload(); if (r.opened) setSel(r.opened); }) })}>Sign off phase</button>}
        {ph.status === 'complete' && can('proj.verify') && <button className="btn sm" onClick={() => open({ title: 'Reopen ' + ph.name, submit: 'Reopen', intro: <p className="small muted">Reopening unlocks the checklist and puts the next phase back to “not started”.</p>, fields: [{ name: 'reason', label: 'Reason', required: true }], onSubmit: (v) => api.post(`/project/phases/${ph.key}/reopen`, v).then(done('Phase reopened.')) })}>Reopen</button>}
      </div>
    </div>
    <div className="card"><div className="card-h"><h2>Checklist</h2><span className="muted small">{ph.status === 'complete' ? 'Locked — signed off' : can('proj.edit') ? 'Tap an item to update it' : 'Read only'}</span></div>
      {ph.deliverables.map((d: any) => {
        const late = d.due_on && d.due_on < today() && !['done', 'not_applicable'].includes(d.status);
        return <div className="check" key={d.id}>
          <span className={'tick ' + d.status} aria-hidden="true">{d.status === 'done' ? '✓' : d.status === 'not_applicable' ? '–' : ''}</span>
          <div style={{ minWidth: 0 }}>
            <b style={{ fontWeight: 600 }}>{d.title}</b>
            <div className="small muted">{[d.owner, d.due_on && (late ? null : 'due ' + date(d.due_on))].filter(Boolean).join(' · ')}{late && <span className="overdue">{d.owner ? ' · ' : ''}overdue since {date(d.due_on)}</span>}</div>
            {d.evidence && <div className="small">{d.evidence}{d.file_id && <> · <a href={`/api/files/${d.file_id}`} target="_blank" rel="noreferrer">document</a></>}</div>}
            {d.updated_by_name && d.status !== 'todo' && <div className="def">Updated by {d.updated_by_name}, {date(d.updated_at)}</div>}
          </div>
          <div className="row" style={{ flexWrap: 'nowrap' }}><Pill k={ITEM_LABEL[d.status][1]}>{ITEM_LABEL[d.status][0]}</Pill>{editable && <button className="btn sm" onClick={() => editItem(d)}>Update</button>}</div>
        </div>;
      })}
      {!ph.deliverables.length && <p className="muted">No items yet.{editable ? ' Add the first one.' : ''}</p>}
    </div>
  </div>;
}

export function DetailsTab({ lc, reload }: { lc: any; reload: () => void }) {
  const { can } = useSession(); const toast = useToast(); const [dialog, open] = useDialog();
  const p = lc.project ?? {};
  const canEdit = can('proj.edit') || can('rules.edit');
  const field = (k: string) => (p[k] ? <span style={{ whiteSpace: 'pre-wrap' }}>{p[k]}</span> : <span className="muted">Not filled in yet</span>);
  return <div className="card stack">{dialog}
    <div className="card-h" style={{ margin: 0 }}><h2>Project details</h2>{canEdit && <button className="btn sm primary" onClick={() => open({ title: 'Edit project details', submit: 'Save details', fields: [
      { name: 'name', label: 'Project name', value: p.name ?? '', required: true }, { name: 'site', label: 'Site', value: p.site ?? '' },
      { name: 'sponsor', label: 'Sponsor', value: p.sponsor ?? '' }, { name: 'schoolContact', label: 'School contact', value: p.school_contact ?? '' },
      { name: 'plannedStart', label: 'Planned start', type: 'date', value: p.planned_start ?? '' }, { name: 'plannedEnd', label: 'Planned completion', type: 'date', value: p.planned_end ?? '' },
      { name: 'description', label: 'Description (shown on the public page)', type: 'textarea', value: p.description ?? '' },
      { name: 'objectives', label: 'Objectives', type: 'textarea', value: p.objectives ?? '' }, { name: 'scope', label: 'Scope: what is and is not included', type: 'textarea', value: p.scope ?? '' }],
      onSubmit: (v) => api.post('/project/details', { name: v.name, site: v.site ?? '', sponsor: v.sponsor ?? '', schoolContact: v.schoolContact ?? '', plannedStart: v.plannedStart ?? '', plannedEnd: v.plannedEnd ?? '', description: v.description ?? '', objectives: v.objectives ?? '', scope: v.scope ?? '' }).then(() => { toast('Details saved.'); reload(); }) })}>Edit details</button>}</div>
    <dl className="kv">
      <dt>Name</dt><dd>{field('name')}</dd><dt>Site</dt><dd>{field('site')}</dd><dt>Sponsor</dt><dd>{field('sponsor')}</dd><dt>School contact</dt><dd>{field('school_contact')}</dd>
      <dt>Planned</dt><dd>{p.planned_start ? `${date(p.planned_start)} – ${date(p.planned_end)}` : <span className="muted">Not set</span>}</dd>
    </dl>
    <div><h3>Description</h3><p className="small">{field('description')}</p></div>
    <div><h3>Objectives</h3><p className="small">{field('objectives')}</p></div>
    <div><h3>Scope</h3><p className="small">{field('scope')}</p></div>
  </div>;
}

export function UpdatesTab({ lc, reload }: { lc: any; reload: () => void }) {
  const { can } = useSession(); const toast = useToast(); const [dialog, open] = useDialog();
  const phaseName = (k: string) => lc.phases.find((p: any) => p.key === k)?.name ?? '';
  return <div className="stack">{dialog}
    {can('proj.edit') && <div className="row"><button className="btn primary" onClick={() => open({ title: 'Post a progress update', submit: 'Post update', fields: [
      { name: 'title', label: 'Headline', required: true }, { name: 'body', label: 'What happened, what is next, any decisions needed', type: 'textarea', required: true },
      { name: 'photo', label: 'Photo or document (optional)', type: 'file', accept: 'image/*,application/pdf' }, { name: 'public', label: 'Also show on the public page', type: 'checkbox' }, { name: 'notify', label: 'Tell the year group by email', type: 'checkbox', value: true }],
      onSubmit: async (v) => { const fileId = v.photo ? await uploadFile(v.photo, 'general', { type: 'update', id: 'P1' }) : undefined; await api.post('/project/updates', { title: v.title, body: v.body, public: !!v.public, notify: !!v.notify, fileId }); toast('Update posted.'); reload(); } })}>Post a progress update</button></div>}
    <div className="card">{lc.updates.map((u: any) => <div className="li" key={u.id}><div className="grow">
      <div className="row"><b>{u.title}</b>{u.phase_key && <Pill>{phaseName(u.phase_key)}</Pill>}{u.public && <Pill k="info">Public</Pill>}</div>
      <p className="small" style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{u.body}</p>
      {u.file_id && <a className="small" href={`/api/files/${u.file_id}`} target="_blank" rel="noreferrer">Attachment</a>}
      <div className="def">{u.posted_by_name} · {date(u.posted_at)}</div></div></div>)}
      {!lc.updates.length && <p className="muted">No updates yet. The project manager posts regular reports here for the year group.</p>}</div>
  </div>;
}

