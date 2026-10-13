import { useState } from 'react';
import { api, HOUSE_NAME } from '../api';
import { Gate, House, Pill, useAction, useLoad, useSession, useToast } from '../ui';
import { useDialog } from '../forms';

export default function Members() {
  const { can } = useSession();
  const [q, setQ] = useState(''), [house, setHouse] = useState(''), [page, setPage] = useState(0);
  const d = useLoad<any>(`/members?q=${encodeURIComponent(q)}&house=${house}&page=${page}`);
  const act = useAction(); const toast = useToast(); const [dialog, open] = useDialog();
  const admin = can('admin.members');
  return <div className="stack">{dialog}
    <div><div className="eyebrow">Ɔdadeɛ 2003 · directory</div><h1>Our year group</h1></div>
    <div className="row">
      <label className="f" style={{ flex: 1, minWidth: 200 }} htmlFor="q">Search<input id="q" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Name, number, city or profession" /></label>
      <label className="f" htmlFor="h">House<select id="h" value={house} onChange={(e) => { setHouse(e.target.value); setPage(0); }}><option value="">All</option>{Object.entries(HOUSE_NAME).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></label>
    </div>
    <Gate error={d.error}>{d.data && <div className="card"><div className="tablewrap"><table><thead><tr><th>Name</th><th>No.</th><th>House</th><th>City</th><th>Profession</th>{admin && <><th>Status</th><th /></>}</tr></thead><tbody>
      {d.data.rows.map((m: any) => <tr key={m.member_no}><td><b>{m.full_name}</b></td><td className="mono">{m.member_no}</td><td><House id={m.house_id} /></td><td>{m.city}</td><td className="small">{m.profession}</td>
        {admin && <><td>{m.verified ? <Pill k="ok">Verified</Pill> : <button className="btn sm" onClick={() => act(() => api.post(`/members/${m.member_no}/verify`), 'Member confirmed.', d.reload)}>Confirm</button>}</td>
          <td><div className="row" style={{ flexWrap: 'nowrap' }}><button className="btn sm" onClick={() => open({ title: 'Correct house · ' + m.full_name, submit: 'Save correction', intro: <p className="small muted">Payments before the effective date stay with the current house. This competition’s eligible counts stay frozen.</p>, fields: [{ name: 'houseId', label: 'Correct house', type: 'select', options: Object.entries(HOUSE_NAME).filter(([i]) => i !== m.house_id) as [string, string][] }, { name: 'validFrom', label: 'Effective from', type: 'date', value: new Date().toISOString().slice(0, 10) }, { name: 'reason', label: 'Reason', value: 'School register shows a different house' }], onSubmit: (v) => api.post(`/members/${m.member_no}/house`, { houseId: v.houseId ?? Object.keys(HOUSE_NAME).find((i) => i !== m.house_id), validFrom: v.validFrom, reason: v.reason }).then(() => { toast('House corrected.'); d.reload(); }) })}>Correct house</button><button className="btn sm" onClick={() => act(() => api.post(`/admin/members/${m.member_no}/invite`), 'Invitation sent.')}>Invite</button></div></td></>}</tr>)}
    </tbody></table></div>
      <div className="row between" style={{ marginTop: 10 }}><span className="muted small">{d.data.total} found · page {page + 1}</span><div className="row"><button className="btn sm" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button><button className="btn sm" disabled={(page + 1) * 30 >= d.data.total} onClick={() => setPage(page + 1)}>Next</button></div></div>
      <p className="def" style={{ marginTop: 8 }}>Phone numbers and contribution amounts are never shown in the directory.</p></div>}</Gate>
  </div>;
}
