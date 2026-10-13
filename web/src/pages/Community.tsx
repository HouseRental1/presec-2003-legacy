import { api, date } from '../api';
import { useDialog } from '../forms';
import { Pill, useAction, useLoad, useSession, useToast } from '../ui';

export default function Community() {
  const { can } = useSession();
  const a = useLoad<any[]>('/announcements'), e = useLoad<any[]>('/events');
  const act = useAction(); const toast = useToast(); const [dialog, open] = useDialog();
  return <div className="stack"><div><div className="eyebrow">Ɔdadeɛ 2003</div><h1>Year group news and events</h1></div>{dialog}
    {can('gov.manage') && <div className="row">
      <button className="btn primary" onClick={() => open({ title: 'Post an announcement', submit: 'Post', fields: [{ name: 'title', label: 'Title', required: true }, { name: 'body', label: 'Message', type: 'textarea', required: true }, { name: 'sendEmail', label: 'Also send by email', type: 'checkbox', value: true }], onSubmit: (v) => api.post('/announcements', v).then(() => { toast('Posted.'); a.reload(); }) })}>Post an announcement</button>
      <button className="btn" onClick={() => open({ title: 'Create an event', submit: 'Create', fields: [{ name: 'title', label: 'Event', required: true }, { name: 'startsAt', label: 'Date and time', type: 'datetime-local', required: true }, { name: 'venue', label: 'Venue', required: true, value: 'PRESEC Legon' }, { name: 'details', label: 'Details', type: 'textarea' }], onSubmit: (v) => api.post('/events', { ...v, startsAt: new Date(v.startsAt).toISOString() }).then(() => { toast('Event created; classmates will be told.'); e.reload(); }) })}>Create an event</button></div>}
    <div className="grid-2">
      <div className="card"><div className="card-h"><h2>Events</h2></div>{(e.data ?? []).map((x) => <div className="li" key={x.id}><div className="grow"><b>{x.title}</b><div className="small">{new Date(x.starts_at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {x.venue}</div>{x.details && <div className="muted small">{x.details}</div>}<div className="muted small">{x.going} going{x.guests ? ` + ${x.guests} guests` : ''}</div></div>
        <div className="row">{(['yes', 'maybe', 'no'] as const).map((r) => <button key={r} className={'btn sm' + (x.my_response === r ? ' primary' : '')} onClick={() => act(() => api.post(`/events/${x.id}/rsvp`, { response: r }), 'Reply saved.', e.reload)}>{r === 'yes' ? 'Going' : r === 'maybe' ? 'Maybe' : 'Can’t make it'}</button>)}</div></div>)}
        {e.data && !e.data.length && <p className="muted">No events yet.</p>}</div>
      <div className="card"><div className="card-h"><h2>Announcements</h2></div>{(a.data ?? []).map((x) => <div className="li" key={x.id}><div className="grow"><b>{x.title}</b><p className="small" style={{ whiteSpace: 'pre-wrap' }}>{x.body}</p><div className="muted small">{x.posted_by} · {date(x.posted_at)}</div></div></div>)}
        {a.data && !a.data.length && <p className="muted">No announcements yet.</p>}<Pill k="info">Also sent by email to classmates who receive updates</Pill></div>
    </div></div>;
}
