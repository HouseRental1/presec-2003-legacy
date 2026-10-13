import { useState } from 'react';
import { api } from '../api';
import { Gate, House, Pill, useAction, useLoad, useSession } from '../ui';

export default function Members() {
  const { can } = useSession();
  const [q, setQ] = useState(''), [house, setHouse] = useState(''), [page, setPage] = useState(0);
  const d = useLoad<any>(`/members?q=${encodeURIComponent(q)}&house=${house}&page=${page}`);
  const act = useAction();
  const admin = can('admin.members');
  return <div className="stack">
    <div><div className="eyebrow">Directory</div><h1>Members</h1></div>
    <div className="row">
      <label className="f" style={{ flex: 1, minWidth: 200 }} htmlFor="q">Search<input id="q" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Name, number, city or profession" /></label>
      <label className="f" htmlFor="h">House<select id="h" value={house} onChange={(e) => { setHouse(e.target.value); setPage(0); }}><option value="">All</option><option value="H1">Aggrey</option><option value="H2">Nkrumah</option><option value="H3">Casely-Hayford</option><option value="H4">Yaa Asantewaa</option></select></label>
    </div>
    <Gate error={d.error}>{d.data && <div className="card"><div className="tablewrap"><table><thead><tr><th>Name</th><th>No.</th><th>House</th><th>City</th><th>Profession</th>{admin && <><th>Status</th><th /></>}</tr></thead><tbody>
      {d.data.rows.map((m: any) => <tr key={m.member_no}><td><b>{m.full_name}</b></td><td className="mono">{m.member_no}</td><td><House id={m.house_id} /></td><td>{m.city}</td><td className="small">{m.profession}</td>
        {admin && <><td>{m.verified ? <Pill k="ok">Verified</Pill> : <button className="btn sm" onClick={() => act(() => api.post(`/members/${m.member_no}/verify`), 'Member confirmed.', d.reload)}>Confirm</button>}</td>
          <td><button className="btn sm" onClick={() => { const h = window.prompt?.('Correct house (H1–H4)', m.house_id === 'H1' ? 'H2' : 'H1'); const f = h && window.prompt?.('Effective from (YYYY-MM-DD)', new Date().toISOString().slice(0, 10)); if (h && f) act(() => api.post(`/members/${m.member_no}/house`, { houseId: h, validFrom: f, reason: 'School register shows a different house' }), 'House corrected from ' + f + '.', d.reload); }}>Correct house</button></td></>}</tr>)}
    </tbody></table></div>
      <div className="row between" style={{ marginTop: 10 }}><span className="muted small">{d.data.total} found · page {page + 1}</span><div className="row"><button className="btn sm" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button><button className="btn sm" disabled={(page + 1) * 30 >= d.data.total} onClick={() => setPage(page + 1)}>Next</button></div></div>
      <p className="def" style={{ marginTop: 8 }}>Phone numbers and contribution amounts are never shown in the directory.</p></div>}</Gate>
  </div>;
}
