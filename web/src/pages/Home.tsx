import { Link } from 'react-router-dom';
import { ghs, pct, HOUSE_NAME } from '../api';
import { Bar, Gate, House, Tile, useLoad, useSession } from '../ui';
import { AdminTodo } from './Todo';

export function TriBars({ p }: { p: { reported: number; verified: number; accepted: number } }) {
  return <div>{([['Contractor reported', p.reported, 'var(--muted)'], ['Verified on site', p.verified, 'var(--info)'], ['Inspected & accepted', p.accepted, 'var(--brand)']] as const).map(([l, v, c]) =>
    <div className="tri-row" key={l}><span>{l}</span><Bar v={v / 100} color={c} /><b className="num">{v.toFixed(0)}%</b></div>)}</div>;
}

/** The six classrooms, drawn as an elevation. Each room fills with gold as the cash for its share of the budget comes in. */
export function BlockProgress({ raised, budget }: { raised: number; budget: number }) {
  const share = budget > 0 ? budget / 6 : 0;
  const fills = [0, 1, 2, 3, 4, 5].map((i) => (share ? Math.max(0, Math.min(1, (raised - i * share) / share)) : 0));
  const done = fills.filter((f) => f >= 1).length;
  return <figure className="blockprog" aria-label={budget ? `${done} of 6 classrooms paid for` : 'Budget not yet approved'}>
    <svg viewBox="0 0 360 132" role="img" aria-hidden="true">
      <path d="M10 44 L180 14 L350 44" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M20 44 H340 V116 H20 Z" fill="none" stroke="currentColor" strokeWidth="1.6" />
      {fills.map((f, i) => { const x = 22 + i * 53; const h = 70 * f; return <g key={i}>
        <rect x={x} y={46} width={50} height={70} fill="rgb(255 255 255 / .06)" />
        {f > 0 && <rect x={x} y={116 - h} width={50} height={h} fill="var(--gold-mark)" opacity={f >= 1 ? 1 : .75} />}
        <rect x={x + 8} y={56} width={16} height={18} fill="none" stroke="currentColor" strokeWidth=".9" />
        <rect x={x + 30} y={76} width={12} height={40} fill="none" stroke="currentColor" strokeWidth=".9" />
        {i > 0 && <path d={`M${x - 1.5} 44 V116`} stroke="currentColor" strokeWidth="1" />}
        <text x={x + 25} y={128} textAnchor="middle" fontSize="8.5" fill="currentColor" opacity=".8">Room {i + 1}</text>
      </g>; })}
      <path d="M6 116 H354" stroke="currentColor" strokeWidth="1.6" />
    </svg>
    <figcaption>{budget ? <><b>{done} of 6 classrooms</b> paid for · each room is about {ghs(share)}</> : 'Rooms fill in as money comes in, once the budget is approved.'}</figcaption>
  </figure>;
}

export default function Home() {
  const { me, can } = useSession();
  const d = useLoad<any>('/dashboard'), s = useLoad<any>('/standings'), v = useLoad<any[]>('/proposals');
  const st = useLoad<any>(me?.member ? '/me/statement' : '/me');
  if (!d.data) return <Gate error={d.error}><p className="muted">Loading…</p></Gate>;
  const x = d.data, admin = me?.access !== 'member';
  const open = !can('vote') ? [] : (v.data ?? []).filter((p) => p.status === 'open' && !p.i_voted);
  const mine = me?.member && st.data?.payments ? st.data : null;
  const myRank = me?.member ? (s.data?.rows ?? []).find((r: any) => r.houseId === me.member!.house_id) : null;
  const firstName = me!.name.split(' ')[0];
  return <div className="stack">
    <div><div className="eyebrow">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div><h1>Welcome, {firstName}</h1></div>
    {admin && <AdminTodo compact />}
    <div className="card hero home-hero">
      <div className="stack" style={{ gap: 10 }}>
        <div className="eyebrow" style={{ color: 'inherit', opacity: .8 }}>Cash received for the classroom block</div>
        <div className="bigfig">{ghs(x.cashReceived)}</div>
        <Bar v={x.cashReceived / Math.max(1, x.budget)} />
        <div className="small">{x.budget > 0 ? `${pct(x.cashReceived / x.budget)} of the ${ghs(x.budget)} budget · ${ghs(Math.max(0, x.budget - x.cashReceived))} to go` : 'The budget will show here once it is approved.'}</div>
        <p className="def">Verified contributions and donations only. Pledges are promises and are counted separately.</p>
      </div>
      <BlockProgress raised={x.cashReceived} budget={x.budget} />
    </div>
    {mine && <div className="card stack my-part">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}><h2 style={{ margin: 0 }}>Your part</h2>{me?.member && <House id={me.member.house_id} />}</div>
      <div className="statrow">
        <div><span className="def">You have given</span><b className="num">{ghs(mine.paid)}</b></div>
        <div><span className="def">Your pledge</span><b className="num">{mine.pledged ? ghs(mine.pledged) : 'None yet'}</b>{mine.pledged > 0 && <Bar v={Math.min(1, mine.paid / mine.pledged)} />}</div>
        <div><span className="def">Still to pay</span><b className="num">{mine.pledged ? ghs(mine.remaining) : '—'}</b></div>
        {myRank && <div><span className="def">{HOUSE_NAME[myRank.houseId]}</span><b>Ranked {myRank.rank} of 8</b></div>}
      </div>
      <div className="row"><Link className="btn primary" to="/money">{can('fin.view') ? 'My payments' : 'Give now'}</Link><Link className="btn" to="/pledges">{mine.pledged ? 'My pledge' : 'Make a pledge'}</Link></div>
    </div>}
    {open.length > 0 && <div className="card"><div className="card-h"><h2>Votes waiting for you</h2></div>{open.map((p) => <div className="li" key={p.id}><div className="grow"><b>{p.id}</b> · {p.title}<div className="muted small">Closes {p.closes_on}</div></div><Link className="btn sm" to="/votes">Vote</Link></div>)}</div>}
    <div className="grid-2">
      <div className="card stack"><div className="card-h" style={{ margin: 0 }}><h2>Building progress</h2><Link to="/project" className="small">Open project</Link></div><TriBars p={x.progress} />
        <p className="def">Payment follows the quantity surveyor’s certificate, not these percentages.</p></div>
      {s.data?.rows?.length > 0 ? <div className="card"><div className="card-h"><h2>House standings</h2><Link to="/houses" className="small">All houses</Link></div>
        {s.data.rows.slice(0, 4).map((r: any) => <div className="li" key={r.houseId} style={{ alignItems: 'center' }}><b style={{ width: 24, fontFamily: 'var(--f-display)', fontSize: '1.2rem' }}>{r.rank}</b><div className="grow"><House id={r.houseId} /><div className="muted small">{pct(r.achievement)} of target · {pct(r.participation)} taking part</div></div><b className="num">{r.score.toFixed(1)}</b></div>)}</div>
        : <div className="card stack"><h2>Houses</h2><p className="small muted" style={{ margin: 0 }}>The house competition has not started yet. See how much each house has raised so far.</p><Link className="btn" to="/houses">Open houses</Link></div>}
    </div>
    <div className="grid">
      <Tile l="Total pledged" v={ghs(x.pledged)} d="Promises from classmates. Not cash yet." />
      <Tile l="Spent on the project" v={ghs(x.spent)} d="Posted costs, including retention owed." />
      <Tile l="Still to raise" v={ghs(x.stillToRaise)} d="Budget less cash received and unpaid pledges." />
      {admin && <><Tile l="Unpaid pledges" v={ghs(x.outstandingPledges)} d="Promised but not yet received." />
        <Tile l="Approved commitments" v={ghs(x.commitments)} d={x.definitions.commitments} />
        <Tile l="Available now" v={ghs(x.availableNow)} d={x.definitions.availableNow} /></>}
    </div>
  </div>;
}
