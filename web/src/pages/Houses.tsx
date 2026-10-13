import { api, ghs, pct, date, HOUSE_COLOR } from '../api';
import { Bar, Gate, House, useAction, useLoad, useSession } from '../ui';

export default function Houses() {
  const { can } = useSession();
  const s = useLoad<any>('/standings');
  const out = useLoad<any>(can('house.tools') ? '/captain/outreach' : '/me');
  const act = useAction();
  if (!s.data) return <Gate error={s.error}><p className="muted">Loading…</p></Gate>;
  const { rule, rows, pledgedNotPaid } = s.data;
  if (!rule) return <div className="callout warn">No competition period is in force.</div>;
  return <div className="stack">
    <div><div className="eyebrow">{rule.periodName} · rules v{rule.version} · {date(rule.start)} – {date(rule.end)}</div><h1>House competition</h1></div>
    <div className="card" style={{ background: 'var(--surface-2)', boxShadow: 'none', border: 0 }}>
      <p className="small"><b>Score = {rule.weightTarget} × target achieved (full marks at {pct(rule.capBp / 10000)}) + {rule.weightParticipation} × participation.</b> Target = {ghs(rule.perMemberTarget)} × eligible members, frozen at the start of the period. Only verified payments count. Ties go to higher participation, then to the house that reached half its target first. Approved by: {rule.approvedBy}.</p>
    </div>
    {rows.map((r: any) => <div className="card" key={r.houseId}>
      <div className="row between"><div className="row"><b style={{ fontFamily: 'var(--f-display)', fontSize: '1.4rem', width: 28 }}>{r.rank}</b><House id={r.houseId} /></div><b style={{ fontFamily: 'var(--f-display)', fontSize: '1.4rem' }} className="num">{r.score.toFixed(1)}</b></div>
      <p className="muted small num" style={{ margin: '4px 0 10px' }}>{ghs(r.raised)} of {ghs(r.target)} · {r.contributors}/{r.eligible} members · pledged not yet paid {ghs(pledgedNotPaid[r.houseId] ?? 0)}</p>
      <div className="tri-row"><span>Target</span><Bar v={Math.min(r.achievement, rule.capBp / 10000) / (rule.capBp / 10000)} color={HOUSE_COLOR[r.houseId]} /><b className="num">{pct(r.achievement)}</b></div>
      <div className="tri-row"><span>Participation</span><Bar v={r.participation} color={HOUSE_COLOR[r.houseId]} /><b className="num">{pct(r.participation)}</b></div>
    </div>)}
    {can('house.tools') && out.data?.notYet && <div className="card"><div className="card-h"><h2>Captain’s tools · <House id={out.data.houseId} /></h2><span className="pill warn">{out.data.notYet.length} yet to contribute</span></div>
      <p className="muted small" style={{ marginBottom: 10 }}>Names only. You cannot see amounts, edit payments or change rankings.</p>
      <button className="btn primary" onClick={() => act(() => api.post('/captain/remind'), 'Reminder queued by in-app message and SMS.')}>Send a friendly reminder</button>
      <div className="tablewrap" style={{ maxHeight: 280, overflowY: 'auto', marginTop: 10 }}><table><thead><tr><th>Member</th><th>No.</th><th>City</th></tr></thead><tbody>{out.data.notYet.map((m: any) => <tr key={m.member_no}><td>{m.full_name}</td><td className="mono">{m.member_no}</td><td>{m.city}</td></tr>)}</tbody></table></div></div>}
  </div>;
}
