import { api, HOUSE_NAME } from '../api';
import { useDialog, downloadCsv } from '../forms';
import { Gate, House, useAction, useLoad, useSession, useToast } from '../ui';

export default function Profile() {
  const { me, reload } = useSession();
  const p = useLoad<any>('/me/profile');
  const act = useAction(); const toast = useToast();
  const [dialog, open] = useDialog();
  const staff = me!.roles.some((r) => r !== 'member');
  return <div className="stack"><div><div className="eyebrow">Ɔdadeɛ 2003</div><h1>My profile</h1></div>{dialog}
    <Gate error={p.error}>{p.data && <div className="grid-2">
      <div className="card stack"><div className="card-h" style={{ margin: 0 }}><h2>{p.data.full_name}</h2><House id={p.data.house_id} /></div>
        <dl className="kv"><dt>Member no.</dt><dd className="mono">{p.data.member_no}</dd><dt>Email</dt><dd>{p.data.email ?? '—'}</dd><dt>Phone</dt><dd>{p.data.phone ?? '—'}</dd><dt>City</dt><dd>{p.data.city ?? '—'}</dd><dt>Profession</dt><dd>{p.data.profession ?? '—'}</dd></dl>
        <div className="row"><button className="btn" onClick={() => open({ title: 'Edit my details', submit: 'Save', fields: [
          { name: 'phone', label: 'Phone (with country code if abroad)', value: p.data.phone ?? '' }, { name: 'city', label: 'City', value: p.data.city ?? '' }, { name: 'profession', label: 'Profession', value: p.data.profession ?? '' }],
          onSubmit: async (v) => { await api.post('/me/profile', v); toast('Details saved.'); p.reload(); } })}>Edit details</button>
          <button className="btn" onClick={() => act(() => downloadCsv('my-statement'), 'Statement downloaded.')}>Download my statement (CSV)</button></div>
        <p className="def">Your house is {HOUSE_NAME[p.data.house_id]}. If that is wrong, ask the membership administrator to correct it.</p>
      </div>
      <div className="card stack"><h2>Privacy and messages</h2>
        {([['show_on_wall', 'showOnWall', 'Show my name on the contributors’ wall (never amounts)'], ['sms_reminders', 'smsReminders', 'Send me reminders by SMS'], ['email_updates', 'emailUpdates', 'Send me updates by email']] as const).map(([col, key, label]) =>
          <label key={key} className="row" style={{ cursor: 'pointer' }}><input type="checkbox" checked={!!p.data[col]} onChange={(e) => act(() => api.post('/me/profile', { [key]: e.target.checked }), 'Saved.', p.reload)} />{label}</label>)}
        <p className="def">Payment confirmations, voting notices and security messages always reach you.</p>
        <h3>Security</h3>
        <div className="row"><button className="btn" onClick={() => open({ title: 'Change password', submit: 'Change password', fields: [{ name: 'current', label: 'Current password', type: 'password', required: true }, { name: 'next', label: 'New password (10+ characters)', type: 'password', required: true }], onSubmit: (v) => api.post('/me/password', v).then(() => toast('Password changed.')) })}>Change password</button>
          {staff && <button className="btn" onClick={() => act(async () => { const r = await api.post('/auth/mfa/start'); open({ title: 'Set up two-factor sign-in', submit: 'Confirm', intro: <div className="callout">Add this secret to an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password): <b className="mono">{r.secret}</b></div>, fields: [{ name: 'code', label: '6-digit code from the app', required: true }], onSubmit: (v) => api.post('/auth/mfa/confirm', v).then(() => { toast('Two-factor set up. Sign in again with your code.'); reload(); }) }); }, 'Secret created.')}>Set up two-factor sign-in</button>}</div>
      </div></div>}</Gate>
    {!me!.memberId && <div className="callout">This account is not linked to a member record.</div>}
  </div>;
}
