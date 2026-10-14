import { Link } from 'react-router-dom';
import { ghs, pct } from '../api';
import { Bar, Gate, House, Tile, useLoad, useSession } from '../ui';

export function TriBars({ p }: { p: { reported: number; verified: number; accepted: number } }) {
  return <div>{([['Contractor reported', p.reported, 'var(--muted)'], ['Verified on site', p.verified, 'var(--info)'], ['Inspected & accepted', p.accepted, 'var(--brand)']] as const).map(([l, v, c]) =>
    <div className="tri-row" key={l}><span>{l}</span><Bar v={v / 100} color={c} /><b className="num">{v.toFixed(0)}%</b></div>)}</div>;
}

export default function Home() {
  const { me, can } = useSession();
  const d = useLoad<any>('/dashboard'), s = useLoad<any>('/standings'), v = useLoad<any[]>('/proposals');
  if (!d.data) return <Gate error={d.error}><p className="muted">Loading…</p></Gate>;
  const x = d.data;
  const open = !can('vote') ? [] : (v.data ?? []).filter((p) => p.status === 'open' && !p.i_voted);
  return <div className="stack">
    <div><div className="eyebrow">{new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</div><h1>Welcome, {me!.name.split(' ')[0]}</h1></div>
    <div className="grid-2">
      <div className="card hero stack">
        <div className="eyebrow" style={{ color: 'inherit', opacity: .8 }}>Verified cash received</div>
        <div className="bigfig">{ghs(x.cashReceived)}</div>
        <Bar v={x.cashReceived / Math.max(1, x.budget)} />
        <div className="small">{pct(x.cashReceived / Math.max(1, x.budget))} of the {ghs(x.budget)} approved budget (v{x.budgetVersion})</div>
        <p className="def">{x.definitions.cashReceived} Pledges are shown separately.</p>
      </div>
      <div className="card stack"><div className="card-h" style={{ margin: 0 }}><h2>Building progress</h2></div><TriBars p={x.progress} />
        <p className="def">Payment follows the quantity surveyor’s certificate, not these percentages.</p><Link className="btn sm" to="/project">Open project</Link></div>
    </div>
    {open.length > 0 && <div className="card"><div className="card-h"><h2>Votes waiting for you</h2></div>{open.map((p) => <div className="li" key={p.id}><div className="grow"><b>{p.id}</b> · {p.title}<div className="muted small">Closes {p.closes_on}</div></div><Link className="btn sm" to="/votes">Vote</Link></div>)}</div>}
    <div className="grid">
      <Tile l="Total pledged" v={ghs(x.pledged)} d="Active pledges. Not cash." />
      <Tile l="Unpaid pledges" v={ghs(x.outstandingPledges)} d="Promised but not yet received." />
      <Tile l="Spent on the project" v={ghs(x.spent)} d="Posted costs, including retention owed." />
      <Tile l="Approved commitments" v={ghs(x.commitments)} d={x.definitions.commitments} />
      <Tile l="Available now" v={ghs(x.availableNow)} d={x.definitions.availableNow} />
      <Tile l="Still to raise" v={ghs(x.stillToRaise)} d="Budget less cash received and unpaid pledges." />
    </div>
    {s.data?.rows?.length > 0 && <div className="card"><div className="card-h"><h2>House standings</h2><Link to="/houses" className="small">Full table</Link></div>
      {s.data.rows.map((r: any) => <div className="li" key={r.houseId} style={{ alignItems: 'center' }}><b style={{ width: 24, fontFamily: 'var(--f-display)', fontSize: '1.2rem' }}>{r.rank}</b><div className="grow"><House id={r.houseId} /><div className="muted small">{pct(r.achievement)} of target · {pct(r.participation)} taking part</div></div><b className="num">{r.score.toFixed(1)}</b></div>)}</div>}
  </div>;
}
