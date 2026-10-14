import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ghs, pct, date, HOUSE_COLOR, HOUSE_NAME } from '../api';
import { Bar, Gate, House, PersonLink, Tile, useAction, useLoad, useSession } from '../ui';

const STATE: Record<string, [string, string]> = { fulfilled: ['Paid in full', 'ok'], part_paid: ['Part paid', 'warn'], not_started: ['Not started', ''] };

/** Every active pledge with what has been paid against it. Amounts follow the year group's transparency setting. */
export default function Pledges() {
  const { can, me } = useSession();
  const [house, setHouse] = useState(''), [qs, setQs] = useState(''), [status, setStatus] = useState(''), [sort, setSort] = useState('recent');
  const [d, setD] = useState<any>(null), [err, setErr] = useState<any>(null), [rk, setRk] = useState(0);
  useEffect(() => {
    let stop = false;
    const t = setTimeout(() => api.get<any>(`/pledges?house=${house}&q=${encodeURIComponent(qs)}&status=${status}&sort=${sort}`).then((r) => { if (!stop) { setD(r); setErr(null); } }).catch((e) => !stop && setErr(e)), qs ? 250 : 0);
    return () => { stop = true; clearTimeout(t); };
  }, [house, qs, status, sort, rk]);
  const csv = () => {
    const lines = [['Member no', 'Name', 'House', 'Pledged (GHS)', 'Instalments', 'Paid (GHS)', 'Outstanding (GHS)', 'Status', 'Pledged on'].join(',')]
      .concat(d.rows.map((r: any) => [r.member_no, `"${r.full_name}"`, HOUSE_NAME[r.house_id], (r.pledged ?? 0) / 100, r.instalments, (r.paid ?? 0) / 100, (r.outstanding ?? 0) / 100, STATE[r.state][0], r.pledged_at.slice(0, 10)].join(',')));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = 'pledges.csv'; a.click();
  };
  if (err) return <Gate error={err}>{null}</Gate>;
  const s = d?.summary;
  return <div className="stack">
    <div className="row between" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
      <div><div className="eyebrow">Promises to the classroom block</div><h1>Pledges</h1></div>
      <div className="row">{can('admin.members') && d && <button className="btn" onClick={csv}>Download CSV</button>}</div>
    </div>
    {me?.member && can('pay') && <MyPledge onSaved={() => setRk((k) => k + 1)} />}
    {s && <div className="grid">
      <Tile l="Total pledged" v={ghs(s.totalPledged)} d={`${s.pledgers} of ${s.members} classmates have pledged (${pct(s.members ? s.pledgers / s.members : 0)}).`} />
      <Tile l="Paid against pledges" v={ghs(s.paidAgainst)} d={`${pct(s.totalPledged ? s.paidAgainst / s.totalPledged : 0)} of what was promised.`} />
      <Tile l="Still to come in" v={ghs(s.outstanding)} d="Pledged but not yet paid." />
      <Tile l="Paid in full" v={`${s.fulfilled} of ${s.pledgers}`} d="Pledges completely paid." />
    </div>}
    <div className="card stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select aria-label="House" value={house} onChange={(e) => setHouse(e.target.value)} style={{ width: 'auto' }}><option value="">All houses</option>{Object.entries(HOUSE_NAME).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}><option value="">Any status</option><option value="not_started">Not started</option><option value="part_paid">Part paid</option><option value="fulfilled">Paid in full</option></select>
        <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)} style={{ width: 'auto' }}><option value="recent">Newest first</option>{d?.amountsShown && <><option value="amount">Largest pledge</option><option value="outstanding">Most outstanding</option></>}<option value="progress">Least paid first</option><option value="name">A–Z</option></select>
        <input aria-label="Search" placeholder="Search name or number" value={qs} onChange={(e) => setQs(e.target.value)} style={{ maxWidth: 240 }} />
      </div>
      {!d ? <p className="muted">Loading…</p> : d.rows.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{house || status || qs ? 'No pledges match.' : 'No pledges yet. Classmates pledge from “My pledge & giving”.'}</p> :
        <div className="tablewrap"><table><thead><tr><th>Name</th><th className="hide-sm">House</th><th className="r">Pledged</th><th className="r hide-sm">Paid</th><th className="r">Outstanding</th><th className="hide-sm" style={{ minWidth: 120 }}>Progress</th><th className="hide-sm">Pledged on</th></tr></thead>
          <tbody>{d.rows.map((r: any) => <tr key={r.member_no}>
            <td><PersonLink no={r.member_no} name={r.full_name} /><div className="def">{r.member_no}<span className="show-sm"> · {HOUSE_NAME[r.house_id]}</span></div></td>
            <td className="hide-sm"><House id={r.house_id} /></td>
            <td className="r num">{r.pledged != null ? ghs(r.pledged) : '•••'}<div className="def">{r.instalments > 1 ? `${r.instalments} instalments` : 'one payment'}</div></td>
            <td className="r num hide-sm">{r.paid != null ? ghs(r.paid) : '•••'}</td>
            <td className="r num">{r.outstanding != null ? ghs(r.outstanding) : '•••'}<div className="show-sm"><span className={'pill ' + STATE[r.state][1]}>{STATE[r.state][0]}</span></div></td>
            <td className="hide-sm"><Bar v={r.progress} color={HOUSE_COLOR[r.house_id]} /><span className={'pill ' + STATE[r.state][1]} style={{ marginTop: 4, display: 'inline-block' }}>{STATE[r.state][0]}</span></td>
            <td className="hide-sm">{date(r.pledged_at)}{r.adjusted && <div className="def">changed</div>}</td></tr>)}</tbody></table></div>}
      <p className="def" style={{ margin: 0 }}>“Paid” counts all verified contributions from that classmate. Pledges are promises, not cash; Home shows cash actually received.</p>
    </div>
  </div>;
}

/** The signed-in classmate's own pledge: make it, change it, and see how much is left. */
function MyPledge({ onSaved }: { onSaved: () => void }) {
  const st = useLoad<any>('/me/statement'); const act = useAction();
  const [amount, setAmount] = useState(''), [inst, setInst] = useState('5'), [editing, setEditing] = useState(false);
  if (!st.data) return null;
  const s = st.data, active = (s.pledges ?? []).find((p: any) => p.status === 'active');
  const showForm = editing || !active;
  const save = () => act(async () => {
    if (!(Number(amount) > 0)) throw new Error('Enter the total you are pledging, in GH₵.');
    await api.post('/pledges', { amountGhs: Number(amount), instalments: Number(inst) });
  }, active ? 'Pledge updated.' : 'Thank you — your pledge is saved.', () => { setEditing(false); st.reload(); onSaved(); });
  return <div className="card stack" style={{ borderTop: '4px solid var(--brand)' }}>
    <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}><h2 style={{ margin: 0 }}>My pledge</h2>{active && !editing && <button className="btn sm" onClick={() => { setAmount(String(active.amount / 100)); setInst(String(active.instalments)); setEditing(true); }}>Change my pledge</button>}</div>
    {active && <div className="statrow">
      <div><span className="def">I pledged</span><b className="num">{ghs(active.amount)}</b><span className="def">{active.instalments > 1 ? `in ${active.instalments} instalments of about ${ghs(Math.ceil(active.amount / active.instalments))}` : 'in one payment'}</span></div>
      <div><span className="def">Paid so far</span><b className="num">{ghs(Math.min(s.paid, active.amount))}</b><Bar v={active.amount ? Math.min(1, s.paid / active.amount) : 0} /></div>
      <div><span className="def">Still to pay</span><b className="num">{ghs(s.remaining)}</b>{s.remaining > 0 && <Link to="/money" className="small">Pay now →</Link>}</div>
    </div>}
    {showForm && <><p className="small muted" style={{ margin: 0 }}>{active ? 'Your new pledge replaces the old one; what you have already paid still counts.' : 'Promise what you can give to the classroom block, in one go or in instalments. Pledges are not payments — you pay from My giving whenever you are ready.'}</p>
      <div className="fgrid">
        <label className="f" htmlFor="mpa">Total pledge (GH₵)<input id="mpa" type="number" min="1" inputMode="decimal" placeholder="e.g. 2000" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="f" htmlFor="mpi">Number of instalments<input id="mpi" type="number" min="1" max="24" value={inst} onChange={(e) => setInst(e.target.value)} /><span className="def">1 to 24. {Number(amount) > 0 && Number(inst) > 0 ? `About ${ghs(Math.ceil(Number(amount) * 100 / Number(inst)))} each.` : ''}</span></label>
      </div>
      <div className="row"><button className="btn primary" onClick={save}>{active ? 'Save new pledge' : 'Make my pledge'}</button>{editing && <button className="btn" onClick={() => setEditing(false)}>Cancel</button>}</div></>}
  </div>;
}
