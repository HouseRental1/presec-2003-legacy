import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ghs, date, HOUSE_COLOR, HOUSE_NAME } from '../api';
import { useDialog } from '../forms';
import { Bar, Gate, House, Pill, STATUS, Tile, useAction, useLoad, useToast } from '../ui';

const ACCESS: Record<string, [string, string]> = { superadmin: ['Super admin', 'ok'], admin: ['Admin', 'ok'], member: ['Member', ''], none: ['No sign-in yet', 'warn'] };
const HOUSES = Object.entries(HOUSE_NAME) as [string, string][];

/** A classmate's own page: who they are, what they have given and pledged. Super admins can edit or remove. */
export default function Person() {
  const { no = '' } = useParams();
  const d = useLoad<any>(`/people/${encodeURIComponent(no)}`, [no]);
  const [dialog, open] = useDialog(); const toast = useToast(); const act = useAction(); const nav = useNavigate();
  if (!d.data) return <Gate error={d.error}><p className="muted">Loading…</p></Gate>;
  const p = d.data, g = p.giving;
  const edit = () => open({
    title: `Edit ${p.full_name}`, submit: 'Save changes',
    fields: [
      { name: 'fullName', label: 'Full name', required: true, value: p.full_name },
      { name: 'email', label: 'Email', type: 'email', value: p.contact?.email ?? '', hint: p.contact?.account !== 'none' ? 'Changing it signs them out; they then sign in with the new email.' : 'Needed before they can be invited to sign in.' },
      { name: 'phone', label: 'Phone', value: p.contact?.phone ?? '' },
      { name: 'city', label: 'City / country', value: p.city ?? '' },
      { name: 'profession', label: 'Profession', value: p.profession ?? '' },
      { name: 'houseId', label: 'House', type: 'select', options: HOUSES, value: p.house_id },
      { name: 'houseReason', label: 'If you changed the house: why?', hint: 'Treated as a correction — all their giving moves to the new house.' },
    ],
    onSubmit: async (v) => { const r = await api.post<any>(`/people/${p.member_no}`, v); toast(r.changed.length ? 'Saved: ' + r.changed.join(', ') + '.' : 'No changes.'); d.reload(); },
  });
  const remove = () => open({
    title: `Remove ${p.full_name}?`, submit: 'Remove',
    intro: <div className="callout warn small">If they have never signed in and have no payments or pledges, they are <b>deleted completely</b>. Otherwise they are <b>removed</b>: sign-in is blocked and they disappear from houses, lists and counts, but past payments stay in the books so totals remain correct. You can restore a removed classmate later.</div>,
    fields: [{ name: 'reason', label: 'Reason (kept in the audit trail)', required: true }],
    onSubmit: async (v) => { const r = await api.post<any>(`/people/${p.member_no}/remove`, v); toast(r.outcome === 'deleted' ? `${p.full_name} was deleted.` : `${p.full_name} was removed. Their history is kept.`); if (r.outcome === 'deleted') nav('/houses'); else d.reload(); },
  });
  return <div className="stack">{dialog}
    <div><Link to="/houses" className="small">← Houses</Link></div>
    {p.removed && <div className="callout bad">Removed on {date(p.removed.at)}: {p.removed.reason}. {p.can.edit && <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => act(() => api.post(`/people/${p.member_no}/restore`), 'Restored.', d.reload)}>Restore</button>}</div>}
    <div className="card stack" style={{ borderTop: `5px solid ${HOUSE_COLOR[p.house_id] ?? 'var(--line)'}` }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ margin: 0 }}>{p.full_name}</h1>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}><span className="mono small">{p.member_no}</span>{p.house_id && <House id={p.house_id} />}
            <Pill k={ACCESS[p.access][1]}>{ACCESS[p.access][0]}</Pill>{p.captain_of.map((h: string) => <Pill key={h}>Captain · {HOUSE_NAME[h]}</Pill>)}</div>
        </div>
        {(p.can.edit || p.can.remove) && !p.removed && <div className="row">{p.can.edit && <button className="btn primary" onClick={edit}>Edit details</button>}{p.can.remove && <button className="btn danger" onClick={remove}>Remove</button>}</div>}
      </div>
      <dl className="kv">
        <dt>City / country</dt><dd>{p.city || '—'}</dd><dt>Profession</dt><dd>{p.profession || '—'}</dd><dt>On the register since</dt><dd>{date(p.joined)}</dd>
        {p.contact && <><dt>Email</dt><dd>{p.contact.email || '—'}</dd><dt>Phone</dt><dd>{p.contact.phone || '—'}</dd><dt>Sign-in</dt><dd>{p.contact.account === 'active' ? 'Active' : p.contact.account === 'suspended' ? 'Blocked' : 'No account yet'}</dd></>}
      </dl>
    </div>
    <div className="grid">
      <Tile l="Given so far" v={g.paid != null ? ghs(g.paid) : '•••'} d={`${g.payments} verified payment${g.payments === 1 ? '' : 's'}${g.last_paid ? ' · last ' + date(g.last_paid) : ''}`} />
      <Tile l="Pledge" v={g.pledge ? (g.pledge.amount != null ? ghs(g.pledge.amount) : '•••') : 'None'} d={g.pledge ? `${g.pledge.instalments > 1 ? g.pledge.instalments + ' instalments' : 'one payment'} · since ${date(g.pledge.since)}` : 'No active pledge.'} />
      <Tile l="Still to pay on pledge" v={g.pledge ? (g.pledge.outstanding != null ? ghs(g.pledge.outstanding) : '•••') : '—'} d={g.pledge && g.pledge.amount ? '' : ''} />
    </div>
    {g.pledge && g.pledge.amount != null && <div className="card"><div className="tri-row"><span>Pledge paid</span><Bar v={g.pledge.amount ? Math.min(1, (g.paid ?? 0) / g.pledge.amount) : 0} color={HOUSE_COLOR[p.house_id]} /><b className="num">{g.pledge.amount ? Math.min(100, Math.round(100 * (g.paid ?? 0) / g.pledge.amount)) : 0}%</b></div></div>}
    {p.amountsShown && <div className="card"><div className="card-h"><h2>Payments</h2></div>{!p.payments.length ? <p className="muted small" style={{ margin: 0 }}>No payments yet.</p> :
      <div className="tablewrap"><table><thead><tr><th>Date</th><th>How</th><th>Status</th><th className="hide-sm">Receipt</th><th className="r">Amount</th></tr></thead><tbody>
        {p.payments.map((x: any, i: number) => <tr key={i}><td>{date(x.paid_on)}</td><td>{x.source === 'gateway' ? 'Paystack' : x.source === 'self' ? 'Bank transfer' : 'Recorded'} · {x.network ?? x.channel}</td><td><Pill k={STATUS[x.status]?.[1] ?? ''}>{STATUS[x.status]?.[0] ?? x.status}</Pill></td><td className="mono small hide-sm">{x.receipt_no ?? ''}</td><td className="r num">{ghs(x.amount_ghs, 2)}</td></tr>)}</tbody></table></div>}</div>}
  </div>;
}
