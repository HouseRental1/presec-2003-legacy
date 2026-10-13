import { useState } from 'react';
import { api, ghs, date } from '../api';
import { Bar, Gate, Pill, useAction, useLoad, useSession } from '../ui';
import { TriBars } from './Home';

export default function Project() {
  const { can } = useSession();
  const p = useLoad<any>('/project');
  const act = useAction();
  const [tab, setTab] = useState('works');
  if (!p.data) return <Gate error={p.error}><p className="muted">Loading…</p></Gate>;
  const d = p.data;
  const ask = (q: string, def: string) => (window.prompt?.(q, def) ?? '').trim();
  return <div className="stack">
    <div><div className="eyebrow">Contract {d.contract?.id} · {d.contract?.supplier}</div><h1>Classroom project</h1></div>
    <div className="grid-2"><div className="card"><h2 style={{ marginBottom: 10 }}>Progress by evidence</h2><TriBars p={d.progress} /></div>
      <div className="card"><dl className="kv"><dt>Contract sum</dt><dd>{ghs(d.contract?.value)}</dd><dt>Programme</dt><dd>{date(d.contract?.start_on)} – {date(d.contract?.end_on)}</dd><dt>Retention</dt><dd>{(d.contract?.retention_bp ?? 0) / 100}% of each certificate</dd><dt>Budget</dt><dd>v{d.budgetVersions.at(-1)?.version} · {ghs(d.budgetVersions.at(-1)?.total)}</dd></dl></div></div>
    <div className="tabs" role="tablist">{[['works', 'Work packages'], ['budget', 'Budget & variations'], ['quality', 'Inspections, defects, risks'], ['coi', 'Conflicts of interest']].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
    {tab === 'works' && <div className="card"><div className="tablewrap"><table><thead><tr><th>Package</th><th className="r">Weight</th><th className="r">Budget</th><th>Reported</th><th>Verified</th><th>Accepted</th><th /></tr></thead><tbody>
      {d.workPackages.map((w: any) => <tr key={w.id}><td><b>{w.name}</b><div className="mono muted">{w.id}</div></td><td className="r">{w.weight_bp / 100}%</td><td className="r">{ghs(w.budget)}</td>
        {(['reported_pct', 'verified_pct', 'accepted_pct'] as const).map((k) => <td key={k} style={{ minWidth: 90 }}><div className="small num">{w[k]}%</div><Bar v={w[k] / 100} /></td>)}
        <td><div className="row" style={{ flexWrap: 'nowrap' }}>
          {can('proj.edit') && w.reported_pct < 100 && <button className="btn sm" onClick={() => { const v = ask('Contractor-reported %', String(Math.min(100, w.reported_pct + 20))); if (v) act(() => api.post(`/project/wp/${w.id}/report`, { pct: Number(v), evidence: 'Site photos and daily log' }), 'Report recorded.', p.reload); }}>Report</button>}
          {can('proj.verify') && w.verified_pct < w.reported_pct && <button className="btn sm" onClick={() => act(() => api.post(`/project/wp/${w.id}/verify`, { pct: w.reported_pct, evidence: 'Site visit' }), 'Verified on site.', p.reload)}>Verify</button>}
          {can('proj.edit') && w.accepted_pct < w.verified_pct && <button className="btn sm" onClick={() => { const i = ask('Inspector name', 'Ing. Comfort Agyei'); if (i) act(() => api.post(`/project/wp/${w.id}/accept`, { pct: w.verified_pct, evidence: 'Inspection passed', inspector: i }), 'Acceptance recorded.', p.reload); }}>Accept</button>}
        </div></td></tr>)}
    </tbody></table></div><p className="def" style={{ marginTop: 8 }}>Different people record each stage. Accepting work never authorises payment.</p></div>}
    {tab === 'budget' && <div className="stack">
      <div className="card"><div className="card-h"><h2>Budget versions</h2><span className="muted small">Baselines are never overwritten</span></div><div className="tablewrap"><table><thead><tr><th>Version</th><th className="r">Total</th><th>Approved by</th><th>Note</th></tr></thead><tbody>{d.budgetVersions.map((b: any) => <tr key={b.version}><td>v{b.version}</td><td className="r">{ghs(b.total)}</td><td className="small">{b.approved_by}</td><td className="small">{b.note}</td></tr>)}</tbody></table></div></div>
      <div className="card"><div className="card-h"><h2>Variations</h2>{can('proj.edit') && <button className="btn sm" onClick={() => { const t = ask('What is the change?', ''); const a = t && ask('Cost (GH₵)', ''); if (t && a) act(() => api.post('/project/variations', { title: t, amountGhs: Number(a), reason: 'Requested by the school' }), 'Variation proposed.', p.reload); }}>Propose a variation</button>}</div>
        {d.variations.map((v: any) => <div className="li" key={v.id}><div className="grow"><div className="row"><b className="mono">{v.id}</b><Pill k={v.status === 'approved' ? 'ok' : v.status === 'rejected' ? 'bad' : 'warn'}>{v.status.replace('_', ' ')}</Pill><b className="num">{ghs(v.amount)}</b></div><div>{v.title}</div><div className="muted small">{v.reason} · route: {v.route.replace('_', ' ')}</div></div>
          {v.status === 'awaiting_committee' && can('var.approve') && <button className="btn sm primary" onClick={() => act(() => api.post(`/project/variations/${v.id}/decision`, { approve: true }), 'Variation approved.', p.reload)}>Approve</button>}</div>)}</div></div>}
    {tab === 'quality' && <div className="stack">
      <div className="card"><div className="card-h"><h2>Defects</h2></div>{d.defects.map((x: any) => <div className="li" key={x.id}><Pill k={x.status === 'open' ? 'bad' : 'ok'}>{x.status}</Pill><div className="grow"><b>{x.title}</b><div className="small">{x.action} · due {date(x.due_on)}</div></div>{x.status === 'open' && can('proj.edit') && <button className="btn sm" onClick={() => act(() => api.post(`/project/defects/${x.id}/close`, { evidence: 'Re-inspection photos' }), 'Defect closed.', p.reload)}>Close with evidence</button>}</div>)}</div>
      <div className="card"><div className="card-h"><h2>Inspections</h2></div>{d.inspections.map((x: any) => <div className="li" key={x.id}><Pill k={x.result === 'passed' ? 'ok' : 'warn'}>{x.result.replace(/_/g, ' ')}</Pill><div className="grow"><b>{x.wp_id}</b> · {x.note}<div className="muted small">{date(x.inspected_on)} · {x.inspector}</div></div></div>)}</div>
      <div className="card"><div className="card-h"><h2>Risks</h2></div>{d.risks.map((x: any) => <div className="li" key={x.id}><Pill k={x.level === 'High' ? 'bad' : x.level === 'Medium' ? 'warn' : ''}>{x.level}</Pill><div className="grow"><b>{x.title}</b><div className="small">{x.action} · {x.owner}</div></div></div>)}</div></div>}
    {tab === 'coi' && <div className="card"><div className="card-h"><h2>Conflict-of-interest register</h2></div>{d.coi.map((c: any) => <div className="li" key={c.id}><Pill k="warn">{c.id}</Pill><div className="grow"><b>{c.person}</b> — {c.supplier}<div className="small">{c.interest}</div><div className="muted small">{c.action} · declared {date(c.declared_at)}</div></div></div>)}<p className="def" style={{ marginTop: 8 }}>The server blocks a declared person from approving payments to the linked firm.</p></div>}
  </div>;
}
