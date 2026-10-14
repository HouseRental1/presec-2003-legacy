import { useState } from 'react';
import { api, ghs, HOUSE_NAME, houseIdFrom, today } from '../api';
import { useDialog, downloadCsv } from '../forms';
import { Gate, Pill, useAction, useLoad, useSession, useToast } from '../ui';

const HOUSE_OPTS = Object.entries(HOUSE_NAME) as [string, string][];
const ROLES: [string, string][] = [['committee', 'Executive committee'], ['treasurer', 'Treasurer'], ['approver', 'Finance approver'], ['auditor', 'Independent reviewer'], ['pm', 'Project manager'], ['school', 'School representative'], ['admin', 'Platform administrator']];

export default function Admin() {
  const { can } = useSession();
  const tabs = ([['register', 'Year-group register', can('admin.members')], ['staff', 'Access & captains', can('admin.members')], ['controls', 'Controls & rules', can('rules.edit')], ['ballots', 'Ballots', can('gov.manage')], ['project', 'Project set-up', can('rules.edit') || can('proj.edit')], ['exports', 'Exports', can('reports') || can('admin.members')]] as const).filter((t) => t[2]);
  const [tab, setTab] = useState<string>(tabs[0]?.[0] ?? '');
  if (!tabs.length) return <div className="callout warn">Administration is for the committee, the administrator and finance roles.</div>;
  return <div className="stack"><div><div className="eyebrow">Run by the committee for the year group</div><h1>Administration</h1></div>
    <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
    {tab === 'register' && <Register />}{tab === 'staff' && <Staff />}{tab === 'controls' && <Controls />}{tab === 'ballots' && <Ballots />}{tab === 'project' && <ProjectSetup />}{tab === 'exports' && <Exports />}</div>;
}

function Register() {
  const [text, setText] = useState('member_no,full_name,house,email,phone,city\nP03-0381,Kwesi Mensah,H2,kwesi@example.org,0244000111,Accra');
  const [res, setRes] = useState<any>(null);
  const act = useAction();
  const parse = () => {
    const [head, ...lines] = text.trim().split(/\r?\n/); const cols = head.split(',').map((c) => c.trim().toLowerCase());
    return lines.filter(Boolean).map((l) => { const c = l.split(',').map((x) => x.trim()); const g = (k: string) => c[cols.indexOf(k)] ?? '';
      const house = g('house'); return { memberNo: g('member_no'), fullName: g('full_name'), houseId: houseIdFrom(house), email: g('email') || undefined, phone: g('phone') || undefined, city: g('city') || undefined }; });
  };
  return <div className="stack"><div className="card stack"><h2>Import the year-group register</h2>
    <p className="small muted">Paste CSV with columns member_no, full_name, house (name or house number 1–8), email, phone, city. Each classmate with an email gets an invitation link by email and SMS to set their password.</p>
    <textarea className="mono" rows={8} value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 8, padding: 10, background: 'var(--surface-2)' }} />
    <div className="row"><button className="btn primary" onClick={() => act(async () => setRes(await api.post('/admin/import-members', { rows: parse(), sendInvites: true })), 'Import finished.')}>Import and send invitations</button></div>
    {res && <div className={'callout ' + (res.skipped.length ? 'warn' : 'ok')}>{res.created} imported. {res.skipped.length ? 'Skipped: ' + res.skipped.map((s: any) => `${s.memberNo} (${s.reason})`).join(', ') : ''}</div>}
    {res?.invites?.length > 0 && !(res.delivery?.email || res.delivery?.sms) && <div className="card stack" style={{ background: 'var(--surface-2)', boxShadow: 'none' }}>
      <b>Invitation links to share</b><p className="small muted" style={{ margin: 0 }}>Email and SMS are not connected yet, so share each link yourself (each works once, for 14 days).</p>
      <textarea readOnly rows={Math.min(10, res.invites.length + 1)} className="mono" style={{ width: '100%' }} value={res.invites.map((i: any) => `${i.name}: ${i.link}`).join('\n')} onFocus={(e) => e.target.select()} /></div>}
    <p className="def">Houses: {HOUSE_OPTS.map(([, n]) => n).join(' · ')}</p></div></div>;
}

function Staff() {
  const s = useLoad<any[]>('/admin/staff'); const act = useAction(); const toast = useToast(); const [dialog, open] = useDialog();
  const { me, reload } = useSession();
  const admins = (s.data ?? []).filter((u) => u.roles.includes('admin'));
  const captains = (s.data ?? []).filter((u) => u.captain_of?.length);
  const setAccess = (who: string, access: 'admin' | 'member', after = s.reload) => api.post('/admin/access', { who, access }).then((r: any) => { toast(`${r.name} is now ${access === 'admin' ? 'an administrator' : 'a member (view-only)'}.`); after(); });
  return <div className="stack">{dialog}
    <div className="card stack"><div className="card-h"><h2>Who can do what</h2></div>
      <div className="grid-2">
        <div><b>Admin</b><p className="small muted" style={{ margin: '4px 0 0' }}>Everything: the register, money in and out, the project, votes, news and settings. Opens on the Administration page after sign-in. Payments out still need two different admins to approve.</p></div>
        <div><b>Member</b> (everyone else)<p className="small muted" style={{ margin: '4px 0 0' }}>View-only: home, houses and contributions, project progress and photos, year group, news. The only things a member can do are make a pledge and pay their own contributions.</p></div>
      </div>
      <label className="row" style={{ gap: 8, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!me?.memberParticipation}
        onChange={(e) => act(() => api.post('/admin/participation', { on: e.target.checked }), e.target.checked ? 'Members can now vote and reply to events.' : 'Voting and event replies are now admin-only.', reload)} />
        <span className="small">Also let members vote on ballots and reply to events <span className="muted">(off by default)</span></span></label>
    </div>
    <div className="card stack"><div className="card-h"><h2>Administrators</h2>
      <button className="btn primary" onClick={() => open({ title: 'Make a classmate an administrator', submit: 'Make admin', intro: <p className="small muted">They need an account first (added with an email address). The change applies at their next sign-in.</p>,
        fields: [{ name: 'who', label: 'Member number or email', required: true }], onSubmit: (v) => setAccess(v.who, 'admin') })}>Make someone admin</button></div>
      <Gate error={s.error}><div className="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Two-factor</th><th /></tr></thead><tbody>
        {admins.map((u) => <tr key={u.id}><td><b>{u.display_name}</b>{u.id === me?.userId && <span className="muted small"> (you)</span>}{u.status === 'suspended' && <> <Pill k="bad">Suspended</Pill></>}</td><td className="small">{u.email}</td>
          <td>{u.mfa ? <Pill k="ok">On</Pill> : <Pill k="warn">Not set</Pill>}</td>
          <td>{u.id !== me?.userId && <div className="row"><button className="btn sm" onClick={() => act(() => setAccess(u.email, 'member'), 'Done.')}>Change to member</button>
            <button className="btn sm danger" onClick={() => act(() => api.post(`/admin/users/${u.id}/suspend`, { suspended: u.status !== 'suspended' }), 'Updated.', s.reload)}>{u.status === 'suspended' ? 'Restore' : 'Suspend'}</button></div>}</td></tr>)}
      </tbody></table></div>
      <p className="def" style={{ marginTop: 8 }}>Up to 3 administrators. You cannot change your own access, and the last administrator cannot be removed.</p></Gate>
    </div>
    <div className="card stack"><div className="card-h"><h2>House captains</h2>
      <button className="btn" onClick={() => open({ title: 'Appoint a house captain', submit: 'Appoint', fields: [{ name: 'houseId', label: 'House', type: 'select', options: HOUSE_OPTS, value: 'H1' }, { name: 'memberNo', label: 'Member number', required: true }], onSubmit: (v) => api.post('/admin/captains', v).then(() => { toast('Captain appointed.'); s.reload(); }) })}>Appoint a captain</button></div>
      {captains.length ? captains.map((u) => <div className="li" key={u.id}><div className="grow"><b>{u.display_name}</b> · {u.captain_of.map((h: string) => HOUSE_NAME[h]).join(', ')}</div></div>) : <p className="small muted" style={{ margin: 0 }}>No captains yet.</p>}
      <p className="def">Captains are members with one extra: they see which housemates have not yet given and can send them a friendly reminder.</p>
    </div></div>;
}

function Controls() {
  const st = useLoad<any>('/settings'), rules = useLoad<any[]>('/rules'); const toast = useToast(); const [dialog, open] = useDialog();
  if (!st.data) return <Gate error={st.error}><p className="muted">Loading…</p></Gate>;
  const s = st.data; const inForce = (rules.data ?? []).some((r) => r.status === 'in_force');
  return <div className="stack">{dialog}<div className="grid-2">
    <div className="card stack"><h2>Financial controls</h2><dl className="kv"><dt>Second approver above</dt><dd>{ghs(s.dual_approval_above)}</dd><dt>Member vote above</dt><dd>{ghs(s.member_vote_above)}</dd><dt>Voting quorum</dt><dd>{s.quorum_bp / 100}%</dd><dt>MoMo fee</dt><dd>{s.fees.momo_bp / 100}%</dd><dt>Card fee</dt><dd>{s.fees.card_bp / 100}%</dd></dl>
      <button className="btn" onClick={() => open({ title: 'Change financial controls', submit: 'Save (audited)', intro: <div className="callout warn">Changes are recorded in the audit trail with the old and new values.</div>, fields: [
        { name: 'dualApprovalAboveGhs', label: 'Second approver above (GH₵)', type: 'number', value: s.dual_approval_above / 100 }, { name: 'memberVoteAboveGhs', label: 'Member vote above (GH₵)', type: 'number', value: s.member_vote_above / 100 },
        { name: 'quorumPct', label: 'Quorum (%)', type: 'number', value: s.quorum_bp / 100 }, { name: 'momoFeePct', label: 'MoMo fee (%)', type: 'number', value: s.fees.momo_bp / 100 }, { name: 'cardFeePct', label: 'Card fee (%)', type: 'number', value: s.fees.card_bp / 100 }],
        onSubmit: (v) => api.post('/settings', v).then(() => { toast('Saved.'); st.reload(); }) })}>Change</button></div>
    <div className="card stack"><h2>House competition periods</h2>{(rules.data ?? []).map((r) => <div className="li" key={r.version}><div className="grow"><b>v{r.version} · {r.period_name}</b><div className="muted small">{r.period_start} – {r.period_end} · {ghs(r.per_member_target)} per member · {r.weight_target}/{r.weight_participation}</div></div><Pill k={r.status === 'in_force' ? 'ok' : r.status === 'draft' ? 'warn' : ''}>{r.status.replace('_', ' ')}</Pill></div>)}
      <div className="row">{!inForce && <button className="btn primary" onClick={() => open({ title: 'Open the first competition period', submit: 'Open period', fields: [{ name: 'version', label: 'Rule version', value: '1.0' }, { name: 'periodName', label: 'Name', value: 'Founders’ Drive' }, { name: 'start', label: 'Start', type: 'date', value: today() }, { name: 'end', label: 'End', type: 'date', required: true }, { name: 'perMemberTargetGhs', label: 'Per-member target (GH₵)', type: 'number', value: 1500 }, { name: 'weightTarget', label: 'Weight for target achieved (rest is participation)', type: 'number', value: 60 }, { name: 'approvedBy', label: 'Approved by (resolution)', required: true }], onSubmit: (v) => api.post('/setup/first-period', v).then(() => { toast('Period opened.'); rules.reload(); }) })}>Open first period</button>}
        {inForce && <button className="btn" onClick={() => open({ title: 'Draft the next rule version', submit: 'Save draft', intro: <p className="small muted">Drafts apply only to a future period and come into force only if members pass the linked ballot.</p>, fields: [{ name: 'version', label: 'Version', value: '1.1' }, { name: 'periodName', label: 'Name', required: true }, { name: 'start', label: 'Start (after the current period ends)', type: 'date', required: true }, { name: 'end', label: 'End', type: 'date', required: true }, { name: 'perMemberTargetGhs', label: 'Per-member target (GH₵)', type: 'number', value: 1200 }, { name: 'weightTarget', label: 'Weight for target achieved', type: 'number', value: 55 }], onSubmit: (v) => api.post('/rules/draft', v).then(() => { toast('Draft saved. Open a ballot to adopt it.'); rules.reload(); }) })}>Draft next version</button>}</div></div>
  </div></div>;
}

function Ballots() {
  const p = useLoad<any>('/project'); const rules = useLoad<any[]>('/rules'); const toast = useToast(); const [dialog, open] = useDialog();
  const links: [string, string][] = [['', 'No linked change'], ...((p.data?.variations ?? []).filter((v: any) => v.status === 'awaiting_vote').map((v: any) => ['variation:' + v.id, `Variation ${v.id}: ${v.title}`])), ...((rules.data ?? []).filter((r) => r.status === 'draft').map((r) => ['rules:' + r.version, `Rules v${r.version}`]))];
  return <div className="stack">{dialog}<div className="card stack"><h2>Open a ballot</h2><p className="small muted">Every verified classmate is eligible. The count is frozen when the ballot opens, results stay hidden until it closes, and a linked change is applied automatically only if the ballot passes.</p>
    <button className="btn primary" onClick={() => open({ title: 'Open a ballot', submit: 'Open ballot', fields: [{ name: 'title', label: 'Question', required: true }, { name: 'description', label: 'What members need to know', type: 'textarea', required: true },
      { name: 'threshold', label: 'Needed to pass', type: 'select', options: [['simple', 'More yes than no'], ['two_thirds', 'Two-thirds of yes/no']], value: 'simple' }, { name: 'quorumPct', label: 'Quorum (%)', type: 'number', value: 30 },
      { name: 'opensOn', label: 'Opens', type: 'date', value: today() }, { name: 'closesOn', label: 'Closes', type: 'date', required: true }, { name: 'link', label: 'Linked change', type: 'select', options: links, value: '' }],
      onSubmit: (v) => { const [lt, li] = (v.link ?? '').split(':'); return api.post('/proposals', { title: v.title, description: v.description, threshold: v.threshold, quorumPct: v.quorumPct, opensOn: v.opensOn, closesOn: v.closesOn, linkedType: lt || undefined, linkedId: li || undefined }).then(() => toast('Ballot opened. Classmates have been notified.')); } })}>Open a ballot</button></div></div>;
}

function ProjectSetup() {
  const { can } = useSession(); const p = useLoad<any>('/project'); const toast = useToast(); const [dialog, open] = useDialog();
  if (!p.data) return <Gate error={p.error}><p className="muted">Loading…</p></Gate>;
  const hasBaseline = p.data.budgetVersions.length > 0;
  const totalW = p.data.workPackages.reduce((s: number, w: any) => s + w.weight_bp, 0) / 100;
  return <div className="stack">{dialog}<div className="grid-2">
    {can('rules.edit') && <div className="card stack"><h2>Contract and baseline</h2><p className="small muted">Record these after the member vote that approves the contractor and budget.</p><div className="row">
      <button className="btn" onClick={() => open({ title: 'Record the contract', submit: 'Save', fields: [{ name: 'id', label: 'Contract ID', value: 'CON-0' + (p.data.contract ? 2 : 1) }, { name: 'supplier', label: 'Contractor', required: true }, { name: 'valueGhs', label: 'Contract sum (GH₵)', type: 'number', required: true }, { name: 'retentionPct', label: 'Retention (%)', type: 'number', value: 10 }, { name: 'signedOn', label: 'Signed', type: 'date', required: true }, { name: 'startOn', label: 'Start', type: 'date', required: true }, { name: 'endOn', label: 'Completion', type: 'date', required: true }], onSubmit: (v) => api.post('/setup/contract', v).then(() => { toast('Contract recorded.'); p.reload(); }) })}>Record contract</button>
      <button className="btn" disabled={hasBaseline} onClick={() => open({ title: 'Set the budget baseline', submit: 'Set baseline', intro: <div className="callout warn">The baseline can be set once. Later changes go through variations.</div>, fields: [{ name: 'contractGhs', label: 'Contract (GH₵)', type: 'number', required: true }, { name: 'feesGhs', label: 'Professional fees and permits (GH₵)', type: 'number', required: true }, { name: 'contingencyGhs', label: 'Contingency (GH₵)', type: 'number', required: true }, { name: 'approvedBy', label: 'Approved by (ballot / resolution)', required: true }], onSubmit: (v) => api.post('/setup/baseline', v).then(() => { toast('Baseline set.'); p.reload(); }) })}>{hasBaseline ? 'Baseline set' : 'Set baseline'}</button></div></div>}
    {can('proj.edit') && <div className="card stack"><h2>Work packages</h2><p className="small muted">Weights total {totalW}% (must reach exactly 100%). Weights freeze once progress is reported.</p><div className="row">
      <button className="btn" onClick={() => open({ title: 'Add or edit a work package', submit: 'Save', fields: [{ name: 'id', label: 'ID (WP01–WP99)', value: 'WP' + String(p.data.workPackages.length + 1).padStart(2, '0') }, { name: 'name', label: 'Name', required: true }, { name: 'weightPct', label: 'Weight (%)', type: 'number', required: true }, { name: 'budgetGhs', label: 'Budget (GH₵)', type: 'number', required: true }], onSubmit: (v) => api.post('/setup/work-packages', v).then(() => { toast('Saved.'); p.reload(); }) })}>Add / edit package</button>
      <button className="btn" onClick={() => open({ title: 'Add a risk', submit: 'Add', fields: [{ name: 'title', label: 'Risk', required: true }, { name: 'level', label: 'Level', type: 'select', options: [['Low', 'Low'], ['Medium', 'Medium'], ['High', 'High']], value: 'Medium' }, { name: 'owner', label: 'Owner', required: true }, { name: 'action', label: 'What we are doing about it', required: true }], onSubmit: (v) => api.post('/setup/risks', v).then(() => { toast('Risk added.'); p.reload(); }) })}>Add risk</button></div></div>}
  </div></div>;
}

function Exports() {
  const { can } = useSession(); const act = useAction();
  const list = ([['payments', 'All payments', 'reports'], ['ledger', 'Ledger lines', 'reports'], ['standings', 'House standings', 'reports'], ['members', 'Year-group register', 'admin.members']] as const).filter((x) => can(x[2]));
  return <div className="card stack"><h2>Exports for meetings and review</h2><p className="small muted">CSV files open in Excel or Google Sheets. Cells that look like formulas are neutralised.</p>
    <div className="row">{list.map(([k, l]) => <button key={k} className="btn" onClick={() => act(() => downloadCsv(k), 'Downloaded.')}>{l}</button>)}</div></div>;
}
