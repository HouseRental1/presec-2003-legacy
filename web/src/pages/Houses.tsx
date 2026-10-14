import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ghs, pct, date, HOUSE_BASE, HOUSE_COLOR, HOUSE_NAME } from '../api';
import { useDialog } from '../forms';
import { Bar, Gate, House, useAction, useLoad, useSession, useToast } from '../ui';

const HOUSE_OPTS = Object.entries(HOUSE_NAME) as [string, string][];

export default function Houses() {
  const { can, me, reload: reloadMe } = useSession();
  const ov = useLoad<any>('/houses');
  const hs = { ...ov, data: ov.data?.houses as any[] | undefined };
  const s = useLoad<any>('/standings');
  const out = useLoad<any>(can('house.tools') ? '/captain/outreach' : '/me');
  const act = useAction(), toast = useToast();
  const [dialog, open] = useDialog();
  const [sel, setSel] = useState<string>('');
  const [rosterKey, setRosterKey] = useState(0);
  useEffect(() => { if (!sel && hs.data?.length) setSel(me?.member?.house_id ?? hs.data[0].id); }, [hs.data]); // eslint-disable-line
  if (ov.error) return <Gate error={ov.error}>{null}</Gate>;
  if (!hs.data) return <p className="muted">Loading…</p>;

  const admin = can('admin.members');
  const rule = s.data?.rule, rows: any[] = s.data?.rows ?? [];
  const standing = Object.fromEntries(rows.map((r) => [r.houseId, r]));
  const total = hs.data.reduce((n, h) => n + h.members, 0), accounts = hs.data.reduce((n, h) => n + h.with_accounts, 0);
  const house = hs.data.find((h) => h.id === sel);
  const seeAmounts = !!ov.data?.canSeeAmounts, maxRaised = Math.max(1, ...hs.data.map((h) => h.raised));
  const refresh = () => { ov.reload(); setRosterKey((k) => k + 1); };

  const addClassmate = (houseId = sel, isMe = false) => open({
    title: isMe ? 'Add yourself to your house' : `Add a classmate${houseId ? ' to ' + HOUSE_NAME[houseId] : ''}`, submit: isMe ? 'Add me' : 'Add classmate',
    intro: <p className="small muted">{isMe ? 'This puts you on the year-group register, so your own contributions count for your house.' : 'If you give an email address, they get an invitation (email and SMS) to set a password. Without one they are on the register but cannot sign in yet.'}</p>,
    fields: [
      { name: 'fullName', label: 'Full name', required: true, value: isMe ? me?.name : '' },
      { name: 'houseId', label: 'House', type: 'select', options: HOUSE_OPTS, value: houseId || 'H1' },
      ...(isMe ? [] : [{ name: 'email', label: 'Email', type: 'email' as const }, { name: 'phone', label: 'Phone', hint: 'For SMS reminders, e.g. 024 400 0111' }]),
      { name: 'city', label: 'City / country' }, { name: 'profession', label: 'Profession' },
      { name: 'memberNo', label: 'Member number', hint: 'Leave blank to number automatically (P03-0001, P03-0002 …).' },
    ],
    onSubmit: async (v) => { const r = await api.post<any>('/houses/members', { ...v, isMe, sendInvite: true }); toast(isMe ? `You are on the register as ${r.memberNo}.` : `Added as ${r.memberNo}${r.invited ? ' and invited' : ''}.`); refresh(); if (isMe) reloadMe(); },
  });

  return <div className="stack">
    <div className="row between" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
      <div><div className="eyebrow">Ɔdadeɛ 2003 · the eight houses</div><h1>Houses</h1>
        <p className="muted small" style={{ margin: 0 }}><b>{ghs(ov.data.totalRaised)}</b> raised by the year group · {total} classmate{total === 1 ? '' : 's'} on the register · {accounts} can sign in</p></div>
      {admin && <div className="row" style={{ flexWrap: 'wrap' }}>
        {!me?.member && <button className="btn" onClick={() => addClassmate(sel, true)}>Add me to my house</button>}
        <button className="btn primary" onClick={() => addClassmate()}>Add a classmate</button>
        <Link className="btn" to="/admin">Import the full register</Link></div>}
    </div>
    {total === 0 && <div className="callout warn">No classmates are on the register yet. {admin ? 'Add them one at a time here, or paste the whole year-group list under Administration → Year-group register.' : 'The administrator is adding the year group.'}</div>}

    <div className="house-grid">{hs.data.map((h) => {
      const r = standing[h.id];
      return <button key={h.id} className={'house-card' + (sel === h.id ? ' on' : '')} style={{ ['--hc' as any]: HOUSE_COLOR[h.id] }} onClick={() => setSel(h.id)} aria-pressed={sel === h.id}>
        <span className="row between" style={{ width: '100%' }}><span className="hno">House {h.id.slice(1)}</span>{r && <span className="rank">#{r.rank}</span>}</span>
        <b className="hn">{HOUSE_BASE[h.id] ?? h.name}</b>
        {h.motto && <span className="small muted motto">{h.motto}</span>}
        <span className="raised num">{ghs(h.raised)}</span>
        <span className="small"><b className="num">{h.contributors}</b> of {h.members} member{h.members === 1 ? '' : 's'} given{me?.member?.house_id === h.id ? ' · your house' : ''}</span>
        <span className="small muted">{h.captains.length ? 'Captain: ' + h.captains.join(', ') : 'No captain yet'}</span>
        <Bar v={r ? Math.min(r.achievement, rule.capBp / 10000) / (rule.capBp / 10000) : h.raised / maxRaised} color={HOUSE_COLOR[h.id]} />
      </button>;
    })}</div>

    {house && <div className="card stack" style={{ borderTop: `4px solid ${HOUSE_COLOR[house.id]}` }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div><h2 style={{ margin: 0 }}><House id={house.id} /></h2>{house.motto && <div className="muted small" style={{ fontStyle: 'italic' }}>{house.motto}</div>}</div>
        {admin && <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => open({ title: `${HOUSE_NAME[house.id]} profile`, submit: 'Save', fields: [{ name: 'motto', label: 'Motto or slogan', value: house.motto ?? '' }, { name: 'about', label: 'About the house', type: 'textarea', value: house.about ?? '', hint: 'Who it is named after, house colours, housemasters in our time, memories.' }],
            onSubmit: async (v) => { await api.post(`/houses/${house.id}`, v); toast('House profile saved.'); refresh(); } })}>Edit profile</button>
          <button className="btn sm" onClick={() => addClassmate(house.id)}>Add classmate</button>
          {house.members > 0 && <button className="btn sm" onClick={() => open({ title: `Appoint the ${HOUSE_NAME[house.id]} captain`, submit: 'Appoint', intro: <p className="small muted">The captain sees which housemates have not yet contributed (names only) and can send reminders. They need an account, so add their email first.</p>,
            fields: [{ name: 'memberNo', label: 'Member number', required: true, hint: 'Shown next to each name in the list below.' }],
            onSubmit: async (v) => { await api.post('/admin/captains', { houseId: house.id, memberNo: v.memberNo }); toast('Captain appointed.'); refresh(); } })}>Appoint captain</button>}
        </div>}
      </div>
      {house.about ? <p className="small" style={{ whiteSpace: 'pre-wrap', maxWidth: '70ch', margin: 0 }}>{house.about}</p>
        : admin && <p className="small muted" style={{ margin: 0 }}>No profile yet. Use “Edit profile” to add the house’s story, colours and housemasters.</p>}
      <div className="statrow">
        <div><span className="def">Raised</span><b className="num">{ghs(house.raised)}</b></div>
        <div><span className="def">Classmates who have given</span><b className="num">{house.contributors} of {house.members}</b><Bar v={house.members ? house.contributors / house.members : 0} color={HOUSE_COLOR[house.id]} /></div>
        <div><span className="def">Average per giver</span><b className="num">{house.contributors ? ghs(Math.round(house.raised / house.contributors)) : '—'}</b></div>
        <div><span className="def">Last payment</span><b>{date(house.last_paid)}</b></div>
        {standing[house.id] && <div><span className="def">This competition period</span><b className="num">{ghs(standing[house.id].raised)} of {ghs(standing[house.id].target)}</b></div>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>Captain: {house.captains.join(', ') || 'not appointed yet'} · {house.with_accounts} of {house.members} can sign in</p>
      <Roster key={house.id + rosterKey} houseId={house.id} admin={admin} />
    </div>}

    <div className="card stack"><div className="card-h"><h2>Raised by house</h2><span className="muted small">Verified contributions from classmates, all time</span></div>
      {[...hs.data].sort((a, b) => b.raised - a.raised).map((h) => <button key={h.id} className="raise-row" onClick={() => { setSel(h.id); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
        <span className="nm"><House id={h.id} /></span><Bar v={h.raised / maxRaised} color={HOUSE_COLOR[h.id]} /><b className="num">{ghs(h.raised)}</b><span className="muted small num">{h.contributors}/{h.members}</span></button>)}
      {admin && <label className="f" style={{ maxWidth: 420 }}>Who can see what each classmate gave
        <select value={ov.data.amountsVisibleTo} onChange={(e) => act(() => api.post('/houses/amounts', { visibleTo: e.target.value }), 'Saved.', refresh)}>
          <option value="finance">Finance team only (treasurer, committee, approvers, auditor)</option><option value="members">Every signed-in classmate</option></select>
        <span className="def">Everyone always sees house totals and who has given. Each classmate always sees their own amount.</span></label>}
    </div>

    <div className="card stack"><div className="card-h"><h2>House competition</h2>{rule && <span className="muted small">{rule.periodName} · rules v{rule.version} · {date(rule.start)} – {date(rule.end)}</span>}</div>
      {!rule ? <p className="small muted" style={{ margin: 0 }}>The competition has not started. Once the committee opens a period (with a target per member and dates), each house’s score appears here and on the house cards above.{can('rules.edit') ? <> Open it under <Link to="/admin">Administration → Controls &amp; rules</Link>.</> : ''}</p> : <>
        <p className="small" style={{ margin: 0 }}><b>Score = {rule.weightTarget} × target achieved (full marks at {pct(rule.capBp / 10000)}) + {rule.weightParticipation} × participation.</b> Target = {ghs(rule.perMemberTarget)} × eligible members, frozen at the start of the period. Only verified payments count. Ties go to higher participation, then to the house that reached half its target first. Approved by: {rule.approvedBy}.</p>
        {rows.map((r: any) => <div className="li" key={r.houseId} style={{ display: 'block' }}>
          <div className="row between"><div className="row"><b style={{ fontFamily: 'var(--f-display)', fontSize: '1.3rem', width: 28 }}>{r.rank}</b><House id={r.houseId} /></div><b style={{ fontFamily: 'var(--f-display)', fontSize: '1.3rem' }} className="num">{r.score.toFixed(1)}</b></div>
          <p className="muted small num" style={{ margin: '4px 0 8px' }}>{ghs(r.raised)} of {ghs(r.target)} · {r.contributors}/{r.eligible} members · pledged not yet paid {ghs(s.data.pledgedNotPaid?.[r.houseId] ?? 0)}</p>
          <div className="tri-row"><span>Target</span><Bar v={Math.min(r.achievement, rule.capBp / 10000) / (rule.capBp / 10000)} color={HOUSE_COLOR[r.houseId]} /><b className="num">{pct(r.achievement)}</b></div>
          <div className="tri-row"><span>Participation</span><Bar v={r.participation} color={HOUSE_COLOR[r.houseId]} /><b className="num">{pct(r.participation)}</b></div>
        </div>)}</>}
    </div>

    {can('house.tools') && out.data?.notYet && <div className="card"><div className="card-h"><h2>Captain’s tools · <House id={out.data.houseId} /></h2><span className="pill warn">{out.data.notYet.length} yet to contribute</span></div>
      <p className="muted small" style={{ marginBottom: 10 }}>Names only. You cannot see amounts, edit payments or change rankings.</p>
      <button className="btn primary" onClick={() => act(() => api.post('/captain/remind'), 'Reminder queued by in-app message and SMS.')}>Send a friendly reminder</button>
      <div className="tablewrap" style={{ maxHeight: 280, overflowY: 'auto', marginTop: 10 }}><table><thead><tr><th>Member</th><th>No.</th><th>City</th></tr></thead><tbody>{out.data.notYet.map((m: any) => <tr key={m.member_no}><td>{m.full_name}</td><td className="mono">{m.member_no}</td><td>{m.city}</td></tr>)}</tbody></table></div></div>}
    {dialog}
  </div>;
}

/** Classmates in one house with what each has given, 50 at a time. */
function Roster({ houseId, admin }: { houseId: string; admin: boolean }) {
  const [qs, setQs] = useState(''), [sort, setSort] = useState('name'), [rows, setRows] = useState<any[]>([]), [total, setTotal] = useState(0), [page, setPage] = useState(0), [shown, setShown] = useState(false), [err, setErr] = useState('');
  useEffect(() => {
    let stop = false;
    const t = setTimeout(async () => {
      try { const r = await api.get<any>(`/houses/${houseId}/members?q=${encodeURIComponent(qs)}&sort=${sort}&page=${page}`); if (stop) return; setRows((old) => page === 0 ? r.rows : [...old, ...r.rows]); setTotal(r.total); setShown(r.amountsShown); setErr(''); }
      catch (e) { if (!stop) setErr((e as Error).message); }
    }, qs ? 250 : 0);
    return () => { stop = true; clearTimeout(t); };
  }, [houseId, qs, sort, page]);
  if (err) return <div className="callout warn">{err}</div>;
  return <div className="stack" style={{ gap: 8 }}>
    <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}><h3 style={{ margin: 0 }}>Classmates and contributions</h3>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select aria-label="Sort" value={sort} onChange={(e) => { setSort(e.target.value); setPage(0); }} style={{ width: 'auto' }}><option value="name">A–Z</option>{shown && <option value="amount">Highest given</option>}<option value="recent">Most recent</option></select>
        <input aria-label="Search this house" placeholder="Search name, city, profession" value={qs} onChange={(e) => { setQs(e.target.value); setPage(0); }} style={{ maxWidth: 260 }} /></div></div>
    {!shown && <p className="def" style={{ margin: 0 }}>Individual amounts are visible to the finance team only. You can see who has given, and your own amount.</p>}
    {rows.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{qs ? 'No one matches.' : 'No one in this house yet.'}</p> :
      <div className="tablewrap"><table><thead><tr><th>Name</th><th className="hide-sm">No.</th><th className="hide-sm">City</th><th className="hide-sm">Profession</th><th>Given</th><th className="r">Amount</th><th className="hide-sm">Last paid</th>{admin && <th className="hide-sm">Confirmed</th>}</tr></thead>
        <tbody>{rows.map((m) => <tr key={m.member_no}><td>{m.full_name}<div className="show-sm def">{[m.member_no, m.city].filter(Boolean).join(' · ')}</div></td><td className="mono hide-sm">{m.member_no}</td><td className="hide-sm">{m.city ?? ''}</td><td className="hide-sm">{m.profession ?? ''}</td>
          <td>{m.contributed ? <span className="pill ok">Yes{m.payments > 1 ? ` · ${m.payments}×` : ''}</span> : <span className="muted">Not yet</span>}</td>
          <td className="r num">{m.given != null ? ghs(m.given) : m.contributed ? '•••' : '—'}</td><td className="hide-sm">{m.last_paid ? date(m.last_paid) : ''}</td>{admin && <td className="hide-sm">{m.verified ? 'Yes' : '—'}</td>}</tr>)}</tbody></table></div>}
    {rows.length < total && <button className="btn sm" onClick={() => setPage(page + 1)}>Show more ({total - rows.length})</button>}
  </div>;
}
