import { api, date } from '../api';
import { Gate, Pill, useLoad, useSession, useToast } from '../ui';
import { useDialog, uploadFile } from '../forms';

export function Audit() {
  const a = useLoad<any[]>('/audit'), v = useLoad<any>('/audit/verify');
  return <div className="stack"><div><div className="eyebrow">Append-only · hash-chained</div><h1>Audit trail</h1></div>
    <Gate error={a.error}>
      {v.data && <div className={'callout ' + (v.data.ok ? 'ok' : 'bad')}>{v.data.ok ? <><b>Chain intact.</b> All {v.data.count} entries match their hashes.</> : <><b>Chain broken at entry {v.data.brokenAt}.</b> History has been altered.</>}</div>}
      {a.data && <div className="card"><div className="tablewrap"><table><thead><tr><th>#</th><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Hash</th></tr></thead><tbody>
        {a.data.map((e) => <tr key={e.seq}><td className="num">{e.seq}</td><td className="small">{new Date(e.at).toLocaleString('en-GB')}</td><td className="small">{e.actor_label}</td><td>{e.action}{e.detail && <div className="muted small">{e.detail}</div>}</td><td className="mono">{e.target}</td><td className="mono muted">{e.hash.slice(0, 10)}</td></tr>)}
      </tbody></table></div></div>}
    </Gate></div>;
}

export function Notifications() {
  const n = useLoad<any[]>('/notifications');
  const { me } = useSession();
  const staff = me!.roles.some((r) => r !== 'member');
  return <div className="stack"><div><div className="eyebrow">In-app · SMS · email</div><h1>Notifications</h1></div>
    {me!.mfaRequired && staff && !me!.mfaPassed && <div className="callout warn">Staff actions need two-factor sign-in. Set it up on <a href="/profile">your profile</a>.</div>}
    <Gate error={n.error}><div className="card">{(n.data ?? []).map((x) => <div className="li" key={x.id}><div className="grow"><div>{x.body}</div><div className="row" style={{ marginTop: 4 }}>{x.channels.map((c: string) => <Pill key={c} k={c === 'sms' ? 'gold' : ''}>{c.replace('_', '-')}</Pill>)}<span className="muted small">{date(x.created_at)}</span></div></div></div>)}{n.data && !n.data.length && <p className="muted">No notifications.</p>}</div></Gate></div>;
}

export function Legacy() {
  const { can } = useSession();
  const l = useLoad<any>('/legacy');
  const toast = useToast(); const [dialog, open] = useDialog();
  return <div className="stack">{dialog}<div><div className="eyebrow">What the 2003 year group leaves to PRESEC</div><h1>Legacy archive</h1></div>
    <Gate error={l.error}>{l.data && <div className="grid-2">
      <div className="card"><div className="card-h"><h2>Handover checklist</h2></div>{l.data.handover.map((h: any) => <div className="li" key={h.id}><div className="grow">{h.title}{h.document_ref && <div className="muted small mono">{h.document_ref} · {date(h.received_on)}</div>}</div>
        {h.status === 'received' ? <Pill k="ok">Received</Pill> : can('proj.edit') ? <button className="btn sm" onClick={() => open({ title: 'Received · ' + h.title, submit: 'Record', fields: [{ name: 'documentRef', label: 'Document reference', required: true }, { name: 'file', label: 'Scan or photo (optional)', type: 'file', accept: 'image/*,application/pdf' }], onSubmit: async (v) => { if (v.file) await uploadFile(v.file, 'handover', { type: 'handover', id: h.id }); await api.post(`/legacy/handover/${h.id}`, { documentRef: v.documentRef }); toast('Recorded.'); l.reload(); } })}>Mark received</button> : <Pill>Pending</Pill>}</div>)}</div>
      <div className="card"><div className="card-h"><h2>Maintenance plan</h2></div>{l.data.maintenance.map((m: any) => <div className="li" key={m.id}><div className="grow"><b>{m.item}</b><div className="muted small">{m.frequency} · {m.owner}</div>{(m.log ?? []).slice(0, 2).map((x: any) => <div key={x.id} className="small">✓ {date(x.done_on)} — {x.note}</div>)}</div></div>)}</div>
    </div>}</Gate></div>;
}
