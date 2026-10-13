import { api, pct } from '../api';
import { Bar, Gate, Pill, useAction, useLoad, useSession } from '../ui';

export default function Votes() {
  const { can } = useSession();
  const v = useLoad<any[]>('/proposals');
  const act = useAction();
  if (!v.data) return <Gate error={v.error}><p className="muted">Loading…</p></Gate>;
  return <div className="stack">
    <div><div className="eyebrow">Committee manages · members decide major matters</div><h1>Votes</h1></div>
    <div className="callout"><b>Secret ballot.</b> The voter roll records that you voted; your choice goes into a separate ballot box with a random token and no name, time or link to you.</div>
    {v.data.map((p) => {
      const turnout = p.turnout / Math.max(1, p.eligible_count), quorum = p.quorum_bp / 10000;
      return <div className="card stack" key={p.id}>
        <div className="row between"><div className="row"><b className="mono">{p.id}</b>{p.status === 'open' ? <Pill k="info">Open until {p.closes_on}</Pill> : <Pill k={p.result === 'passed' ? 'ok' : 'bad'}>{p.result?.replace('_', ' ')}</Pill>}</div>
          <span className="muted small">Quorum {pct(quorum)} · {p.threshold === 'two_thirds' ? 'two-thirds of yes/no votes' : 'more yes than no'}</span></div>
        <h2>{p.title}</h2><p className="small muted">{p.description}</p>
        <div><div className="row between small"><span>Turnout {p.turnout} of {p.eligible_count} ({pct(turnout)})</span></div><Bar v={turnout} color={turnout >= quorum ? 'var(--ok)' : 'var(--warn)'} /></div>
        {p.status === 'closed' && <p className="small"><b>Yes {p.yes}</b> · No {p.no} · Abstain {p.abstain}</p>}
        <div className="row">
          {p.status === 'open' && !p.i_voted && can('vote') && (['yes', 'no', 'abstain'] as const).map((c) => <button key={c} className={'btn' + (c === 'yes' ? ' primary' : '')} onClick={() => act(() => api.post(`/proposals/${p.id}/vote`, { choice: c }), 'Vote recorded. Your choice is secret.', v.reload)}>{c === 'abstain' ? 'Abstain' : 'Vote ' + c}</button>)}
          {p.i_voted && p.status === 'open' && <Pill k="ok">You have voted</Pill>}
          {p.status === 'open' && can('gov.manage') && <button className="btn sm danger" onClick={() => act(() => api.post(`/proposals/${p.id}/close`), 'Ballot closed and counted.', v.reload)}>Close and count</button>}
        </div></div>;
    })}
  </div>;
}
