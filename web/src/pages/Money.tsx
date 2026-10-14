import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ghs, date, today, HOUSE_NAME } from '../api';
import { Gate, Pill, STATUS, Tile, useAction, useLoad, useSession, useToast } from '../ui';
import { useDialog, uploadFile, MemberPicker } from '../forms';

export default function Money() {
  const { can } = useSession();
  const tabs = ([['overview', 'Overview', can('fin.view')], ['mine', can('fin.view') ? 'My payments' : 'Pay & statement', can('own')], ['verify', 'Verification', can('fin.view')], ['payout', 'Payments out', can('fin.view') || can('req.create') || can('req.approve')], ['ledger', 'Ledger & reports', can('fin.view')]] as const).filter((t) => t[2]);
  const [tab, setTab] = useState<string>(tabs[0]?.[0] ?? 'mine');
  if (!tabs.length) return <div className="callout warn">Money is available to members and finance roles.</div>;
  return <div className="stack"><div><div className="eyebrow">Actual cash in and out · promises are on the Pledges page</div><h1>{can('fin.view') ? 'Money' : 'My giving'}</h1></div>
    {tabs.length > 1 && <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>}
    {tab === 'overview' && <Overview />}{tab === 'mine' && <Mine />}{tab === 'verify' && <Verify />}{tab === 'payout' && <Payout />}{tab === 'ledger' && <Ledger />}</div>;
}

function Mine() {
  const st = useLoad<any>('/me/statement');
  const act = useAction();
  const [amount, setAmount] = useState('500'), [currency, setCurrency] = useState('GHS'), [channel, setChannel] = useState('momo'), [onBehalf, setOnBehalf] = useState('');
  const [ev, setEv] = useState({ amount: '', ref: '', paidOn: today(), note: '' });
  const [file, setFile] = useState<File | null>(null);
  if (!st.data) return <Gate error={st.error}><p className="muted">Loading…</p></Gate>;
  const s = st.data;
  const pay = () => act(async () => {
    const r = await api.post('/payments/initiate', { amount: Number(amount), currency, channel, network: channel === 'momo' ? 'MTN MoMo' : undefined, onBehalfOfNo: onBehalf || undefined });
    // Development: the sandbox plays the provider and sends the signed callback.
    // Production: the provider's prompt/checkout runs and the signed webhook confirms the payment.
    if (r.checkout.url) { window.location.href = r.checkout.url; return; }
    if (r.checkout.provider === 'sandbox') await api.post(`/sandbox/complete/${r.paymentId}`);
  }, 'Payment sent. It is credited as soon as the provider confirms it.', st.reload);
  return <div className="stack">
    <div className="grid"><Tile l="You have given" v={ghs(s.paid)} d="Verified payments credited to you and your house." /><Tile l="Payments" v={String(s.payments.filter((p: any) => p.status === 'verified').length)} d="Confirmed payments on your statement." />
      <Link to="/pledges" className="card stat" style={{ textDecoration: 'none', color: 'inherit' }}><div className="l">Your pledge</div><div className="v">{s.pledged ? ghs(s.pledged) : 'None yet'}</div><div className="def">{s.pledged ? `${ghs(s.remaining)} still to pay · ` : ''}Make or change it on Pledges →</div></Link></div>
    <div className="grid-2">
      <div className="card stack"><h2>Contribute</h2>
        <div className="fgrid">
          <label className="f" htmlFor="am">Amount<input id="am" type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <label className="f" htmlFor="cu">Currency<select id="cu" value={currency} onChange={(e) => setCurrency(e.target.value)}><option>GHS</option><option>USD</option><option>GBP</option></select><span className="def">With Paystack, cards abroad pay in cedis and your bank converts.</span></label>
          <label className="f" htmlFor="ch">Pay with<select id="ch" value={channel} onChange={(e) => setChannel(e.target.value)}><option value="momo">Mobile money</option><option value="card">Card</option></select></label>
          <label className="f" htmlFor="ob">On behalf of (optional)<MemberPicker id="ob" value={onBehalf} onChange={(no) => setOnBehalf(no)} placeholder="Leave empty if it is for you" /></label>
        </div>
        <button className="btn primary" onClick={pay}>Pay now</button>
        <p className="def">Your PIN is entered on your phone or the provider’s page, never in this app. Your house is credited the full amount; fees are a project cost.</p>
      </div>
      <div className="card stack"><h2>Paid by bank transfer?</h2>
        <div className="fgrid">
          <label className="f" htmlFor="ea">Amount (GH₵)<input id="ea" type="number" value={ev.amount} onChange={(e) => setEv({ ...ev, amount: e.target.value })} /></label>
          <label className="f" htmlFor="er">Bank reference<input id="er" value={ev.ref} onChange={(e) => setEv({ ...ev, ref: e.target.value })} /></label>
          <label className="f" htmlFor="ed">Date paid<input id="ed" type="date" value={ev.paidOn} onChange={(e) => setEv({ ...ev, paidOn: e.target.value })} /></label>
          <label className="f" htmlFor="ef">Slip or screenshot (optional)<input id="ef" type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        </div>
        <button className="btn" onClick={() => act(async () => { const fileId = file ? await uploadFile(file, 'payment_evidence') : undefined; await api.post('/payments/evidence', { amountGhs: Number(ev.amount), ref: ev.ref, paidOn: ev.paidOn, note: ev.note, fileId }); }, 'Evidence submitted. The treasury team will verify it.', st.reload)}>Submit evidence</button>
      </div>
    </div>
    <div className="card"><div className="card-h"><h2>Statement</h2></div><div className="tablewrap"><table><thead><tr><th>Date</th><th>Reference</th><th>Channel</th><th>Status</th><th>Receipt</th><th className="r">Amount</th></tr></thead><tbody>
      {s.payments.map((p: any) => <tr key={p.id}><td>{date(p.paid_on)}</td><td className="mono">{p.external_ref}</td><td>{p.network ?? p.channel}{p.currency !== 'GHS' && <span className="muted small"> {p.currency} {(p.amount_original / 100).toFixed(2)} @ {p.fx_rate}</span>}</td><td><Pill k={STATUS[p.status]?.[1]}>{STATUS[p.status]?.[0] ?? p.status}</Pill></td><td className="mono">{p.receipt_no ?? '—'}</td><td className="r">{ghs(p.amount_ghs, 2)}</td></tr>)}
      {!s.payments.length && <tr><td colSpan={6} className="muted">No payments yet.</td></tr>}
    </tbody></table></div></div>
  </div>;
}

function Verify() {
  const { can } = useSession();
  const qs = useLoad<any>('/finance/queues');
  const act = useAction(); const toast = useToast(); const [dialog, open] = useDialog();
  const [rec, setRec] = useState({ memberNo: '', amountGhs: '', channel: 'bank', ref: '', paidOn: today(), note: '' });
  if (!qs.data) return <Gate error={qs.error}><p className="muted">Loading…</p></Gate>;
  const row = (p: any) => <div className="li" key={p.id}><div className="grow">
    <div className="row"><b>{ghs(p.amount_ghs, 2)}</b><Pill k={STATUS[p.status]?.[1]}>{STATUS[p.status]?.[0]}</Pill><span className="mono muted">{p.external_ref}</span></div>
    <div className="small">{p.full_name ? `${p.full_name} · ${p.member_no}` : p.payer_name} · {p.channel} · {date(p.paid_on)}</div>
    <div className="muted small">Recorded by {p.recorded_by_name ?? 'provider'}{p.evidence_note ? ' · ' + p.evidence_note : ''}</div>
    {p.exception_reason && <div className="small" style={{ color: 'var(--bad)' }}>{p.exception_reason}</div>}
    {p.reversal_reason && <div className="small" style={{ color: 'var(--warn)' }}>Reversal reason: {p.reversal_reason}</div>}</div>
    <div className="row">
      {p.status === 'pending' && can('fin.verify') && <><button className="btn sm primary" onClick={() => act(() => api.post(`/finance/payments/${p.id}/verify`), 'Verified and posted.', qs.reload)}>Verify</button><button className="btn sm danger" onClick={() => act(() => api.post(`/finance/payments/${p.id}/reject`, { reason: 'Not found on the statement' }), 'Rejected.', qs.reload)}>Reject</button></>}
      {p.status === 'exception' && !p.member_id && <button className="btn sm" onClick={() => open({ title: 'Assign this credit to a classmate', submit: 'Assign', fields: [{ name: 'memberNo', label: 'Classmate', type: 'member', required: true }], onSubmit: (v) => api.post(`/finance/payments/${p.id}/assign`, v).then(() => { toast('Assigned. Someone else must verify it.'); qs.reload(); }) })}>Assign</button>}
      {p.evidence_file && <a className="btn sm" href={`/api/files/${p.evidence_file}`} target="_blank" rel="noreferrer">View slip</a>}
      {p.status === 'exception' && <button className="btn sm danger" onClick={() => act(() => api.post(`/finance/payments/${p.id}/reject`, { reason: 'Closed after investigation' }), 'Closed.', qs.reload)}>Close</button>}
      {p.status === 'reversal_requested' && <><button className="btn sm primary" onClick={() => act(() => api.post(`/finance/payments/${p.id}/reversal-confirm`), 'Reversed. Original kept.', qs.reload)}>Confirm reversal</button><button className="btn sm" onClick={() => act(() => api.post(`/finance/payments/${p.id}/reversal-decline`), 'Declined.', qs.reload)}>Decline</button></>}
    </div></div>;
  return <div className="stack">{dialog}
    {!can('fin.verify') && <div className="callout">Only a <b>super admin</b> can verify or reject payments. You can record cash and bank payments here; they wait below until a super admin checks them.</div>}
    <div className="callout">One person records a manual payment; a different person verifies it against the bank or MoMo statement. The server enforces this.</div>
    {can('fin.record') && <div className="card stack"><h2>Record a payment</h2><div className="fgrid">
      <label className="f" htmlFor="rn" style={{ gridColumn: '1 / -1' }}>Classmate<MemberPicker id="rn" value={rec.memberNo} onChange={(no) => setRec((r) => ({ ...r, memberNo: no }))} /></label>
      <label className="f" htmlFor="ra">Amount (GH₵)<input id="ra" type="number" value={rec.amountGhs} onChange={(e) => setRec({ ...rec, amountGhs: e.target.value })} /></label>
      <label className="f" htmlFor="rc">Channel<select id="rc" value={rec.channel} onChange={(e) => setRec({ ...rec, channel: e.target.value })}><option value="bank">Bank</option><option value="cash">Cash</option></select></label>
      <label className="f" htmlFor="rr">Reference<input id="rr" value={rec.ref} onChange={(e) => setRec({ ...rec, ref: e.target.value })} /></label>
      <label className="f" htmlFor="rd">Date<input id="rd" type="date" value={rec.paidOn} onChange={(e) => setRec({ ...rec, paidOn: e.target.value })} /></label></div>
      <button className="btn primary" onClick={() => act(async () => { if (!rec.memberNo) throw new Error('Choose the classmate who paid.'); await api.post('/finance/payments', { ...rec, amountGhs: Number(rec.amountGhs) }); }, 'Recorded. A super admin will verify it.', () => { setRec({ ...rec, memberNo: '', amountGhs: '', ref: '' }); qs.reload(); })}>Record</button></div>}
    <div className="card"><div className="card-h"><h2>Awaiting verification</h2><span className="muted small">{qs.data.pending.length}</span></div>{qs.data.pending.map(row)}{!qs.data.pending.length && <p className="muted">Nothing waiting.</p>}</div>
    <div className="card"><div className="card-h"><h2>Exceptions</h2></div>{qs.data.exceptions.map(row)}{!qs.data.exceptions.length && <p className="muted">No exceptions.</p>}</div>
    {qs.data.reversals.length > 0 && <div className="card"><div className="card-h"><h2>Reversals to confirm</h2></div>{qs.data.reversals.map(row)}</div>}
    <div className="card row between"><div><b>In provider clearing:</b> {ghs(qs.data.clearing, 2)}</div>{can('fin.reconcile') && <button className="btn" onClick={() => open({ title: 'Record a provider settlement', submit: 'Record', fields: [{ name: 'provider', label: 'Provider', type: 'select', options: [['paystack', 'Paystack'], ['sandbox', 'Sandbox (development)']], value: 'paystack' }, { name: 'statementGhs', label: 'Amount on the settlement statement (GH₵)', type: 'number', value: (qs.data.clearing / 100).toFixed(2) }], onSubmit: (v) => api.post('/finance/settlements', v).then(() => { toast('Settlement recorded.'); qs.reload(); }) })}>Record settlement</button>}</div>
  </div>;
}

function Payout() {
  const { can } = useSession();
  const r = useLoad<any>('/requests');
  const act = useAction(); const toast = useToast(); const [dialog, open] = useDialog();
  if (!r.data) return <Gate error={r.error}><p className="muted">Loading…</p></Gate>;
  const label: Record<string, [string, string]> = { awaiting: ['Awaiting approval', 'warn'], approved: ['Approved — ready to release', 'info'], paid: ['Paid', 'ok'], rejected: ['Rejected', 'bad'] };
  const contract = r.data.contractId;
  return <div className="stack">{dialog}
    {can('req.create') && <div className="row">
      <button className="btn primary" onClick={() => open({ title: 'New payment request', submit: 'Submit for approval', fields: [{ name: 'title', label: 'What is it for?', required: true }, { name: 'payee', label: 'Payee', required: true }, { name: 'amountGhs', label: 'Amount (GH₵)', type: 'number', required: true }, { name: 'category', label: 'Category', type: 'select', options: [['Professional fees', 'Professional fees'], ['Site costs', 'Site costs'], ['Permits', 'Permits'], ['Other', 'Other']], value: 'Professional fees' }], onSubmit: (v) => api.post('/requests', v).then(() => { toast('Submitted for approval.'); r.reload(); }) })}>New payment request</button>
      <button className="btn" onClick={() => open({ title: 'Record a QS payment certificate', submit: 'Record and request payment', intro: <p className="small muted">Enter the value of work certified to date. Retention and the amount already paid are deducted automatically.</p>, fields: [{ name: 'contractId', label: 'Contract', value: contract ?? 'CON-01' }, { name: 'grossToDateGhs', label: 'Work certified to date (GH₵)', type: 'number', required: true }, { name: 'issuedOn', label: 'Certificate date', type: 'date', required: true }, { name: 'issuedBy', label: 'Issued by (QS firm)', required: true }], onSubmit: async (v) => { const c = await api.post('/certificates', v); await api.post('/requests', { title: 'Interim payment certificate ' + c.id, payee: r.data.contractor ?? 'Contractor', category: 'Construction contract', certificateId: c.id }); toast(`${c.id} recorded; GH₵ ${(c.due / 100).toLocaleString('en-GB')} sent for approval.`); r.reload(); } })}>Record QS certificate</button></div>}
    <div className="callout">Above the threshold, two different approvers are needed. Nobody can approve their own request or a payee they declared an interest in, and the person who releases funds cannot be an approver.</div>
    <div className="card"><div className="card-h"><h2>Requests</h2></div>{r.data.requests.map((q: any) => {
      const ap = q.decisions.filter((d: any) => d.decision === 'approved');
      return <div className="li" key={q.id}><div className="grow">
        <div className="row"><b>{q.id}</b><Pill k={label[q.status][1]}>{label[q.status][0]}{q.status === 'awaiting' ? ` ${ap.length}/${q.required_approvals}` : ''}</Pill><b className="num">{ghs(q.amount)}</b></div>
        <div className="small">{q.title} · {q.payee}</div>
        <div className="muted small">Requested by {q.requested_by_name}{ap.length ? ' · approved by ' + ap.map((d: any) => d.user).join(', ') : ''}{q.released_on ? ' · released ' + date(q.released_on) : ''}</div></div>
        <div className="row">
          {q.status === 'awaiting' && can('req.approve') && <><button className="btn sm primary" onClick={() => act(() => api.post(`/requests/${q.id}/decision`, { decision: 'approved' }), 'Approval recorded.', r.reload)}>Approve</button><button className="btn sm danger" onClick={() => act(() => api.post(`/requests/${q.id}/decision`, { decision: 'rejected' }), 'Rejected.', r.reload)}>Reject</button></>}
          {q.status === 'approved' && can('fin.release') && <button className="btn sm primary" onClick={() => act(() => api.post(`/requests/${q.id}/release`), 'Released and posted to the ledger.', r.reload)}>Release payment</button>}
        </div></div>;
    })}</div>
    <div className="card"><div className="card-h"><h2>Contractor payment certificates</h2></div><div className="tablewrap"><table><thead><tr><th>Certificate</th><th>Issued</th><th className="r">Certified to date</th><th className="r">Retention</th><th className="r">Paid before</th><th className="r">Due</th><th>Request</th></tr></thead><tbody>
      {r.data.certificates.map((c: any) => <tr key={c.id}><td className="mono">{c.id}</td><td>{date(c.issued_on)}</td><td className="r">{ghs(c.gross_to_date)}</td><td className="r">−{ghs(c.retention_to_date)}</td><td className="r">−{ghs(c.previous_paid)}</td><td className="r"><b>{ghs(c.due)}</b></td><td>{c.request_status ?? '—'}</td></tr>)}
    </tbody></table></div></div>
  </div>;
}

function Ledger() {
  const l = useLoad<any>('/finance/ledger'), rep = useLoad<any>('/finance/report');
  if (!l.data) return <Gate error={l.error}><p className="muted">Loading…</p></Gate>;
  const t = l.data.trial;
  return <div className="stack">
    <div className={'callout ' + (t.balanced ? 'ok' : 'bad')}><b>{t.balanced ? 'Ledger balanced.' : 'Ledger out of balance.'}</b> Debits {ghs(t.totalDr, 2)} = credits {ghs(t.totalCr, 2)}. Posted entries cannot be edited; corrections are linked reversing entries.</div>
    <div className="card"><div className="card-h"><h2>Trial balance</h2></div><div className="tablewrap"><table><thead><tr><th>Account</th><th className="r">Debits</th><th className="r">Credits</th><th className="r">Balance</th></tr></thead><tbody>
      {t.rows.map((r: any) => <tr key={r.code}><td>{r.name}</td><td className="r">{ghs(r.debits, 2)}</td><td className="r">{ghs(r.credits, 2)}</td><td className="r"><b>{ghs(r.balance, 2)}</b></td></tr>)}</tbody></table></div></div>
    {rep.data && <div className="card"><div className="card-h"><h2>Receipts and payments</h2></div><dl className="kv">
      <dt>Member contributions</dt><dd>{ghs(rep.data.receipts.members, 2)}</dd><dt>Donations</dt><dd>{ghs(rep.data.receipts.donors, 2)}</dd>
      <dt>Project costs paid</dt><dd>−{ghs(rep.data.payments.projectCostsPaid, 2)}</dd><dt>Transaction fees</dt><dd>−{ghs(rep.data.payments.fees, 2)}</dd>
      <dt>Bank</dt><dd>{ghs(rep.data.closing.bank, 2)}</dd><dt>Provider clearing</dt><dd>{ghs(rep.data.closing.clearing, 2)}</dd><dt>Settlement differences</dt><dd>{ghs(rep.data.closing.suspense, 2)}</dd></dl></div>}
    <div className="card"><div className="card-h"><h2>Latest ledger lines</h2></div><div className="tablewrap"><table><thead><tr><th>Date</th><th>Kind</th><th>Account</th><th>Memo</th><th className="r">Debit</th><th className="r">Credit</th></tr></thead><tbody>
      {l.data.recent.map((e: any, i: number) => <tr key={i}><td>{date(e.effective_date)}</td><td>{e.kind}{e.reversal_of ? ' ↺' : ''}</td><td className="small">{e.account}</td><td className="small">{e.memo}</td><td className="r">{e.debit ? ghs(e.debit, 2) : ''}</td><td className="r">{e.credit ? ghs(e.credit, 2) : ''}</td></tr>)}</tbody></table></div></div>
  </div>;
}

/** Admin overview: where the cash stands and the latest payments in. */
function Overview() {
  const d = useLoad<any>('/dashboard'), r = useLoad<any[]>('/finance/recent?limit=50');
  const [q, setQ] = useState('');
  if (!d.data) return <Gate error={d.error}><p className="muted">Loading…</p></Gate>;
  const x = d.data;
  const rows = (r.data ?? []).filter((p) => !q || `${p.full_name ?? ''} ${p.member_no ?? ''} ${p.payer_name ?? ''} ${p.external_ref}`.toLowerCase().includes(q.toLowerCase()));
  return <div className="stack">
    <div className="grid">
      <Tile l="Cash received" v={ghs(x.cashReceived)} d="Verified contributions and donations." />
      <Tile l="Spent on the project" v={ghs(x.spent)} d="Posted costs, including retention owed." />
      <Tile l="Available now" v={ghs(x.availableNow)} d={x.definitions?.availableNow} />
      <Tile l="Approved commitments" v={ghs(x.commitments)} d="Contract still to pay and approved payments not yet released." />
    </div>
    <div className="card"><div className="card-h"><h2>Latest payments in</h2><input aria-label="Search payments" placeholder="Search name, number or reference" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} /></div>
      <Gate error={r.error}>{!rows.length ? <p className="muted small" style={{ margin: 0 }}>{q ? 'No payment matches.' : 'No payments yet.'}</p> :
        <div className="tablewrap"><table><thead><tr><th>Date</th><th>From</th><th className="hide-sm">How</th><th>Status</th><th className="hide-sm">Checked by</th><th className="r">Amount</th></tr></thead><tbody>
          {rows.map((p) => <tr key={p.id}><td>{date(p.paid_on)}</td>
            <td>{p.full_name ?? p.payer_name ?? 'Unmatched'}<div className="def">{p.member_no ?? ''}{p.house_id ? ' · ' + HOUSE_NAME[p.house_id] : ''}{p.category === 'donor' ? ' · friend of the school' : ''}</div></td>
            <td className="hide-sm">{p.source === 'gateway' ? 'Paystack' : p.source === 'self' ? 'Reported transfer' : 'Recorded'} · {p.network ?? p.channel}<div className="def mono">{p.external_ref}</div></td>
            <td><Pill k={STATUS[p.status]?.[1] ?? ''}>{STATUS[p.status]?.[0] ?? p.status}</Pill></td>
            <td className="hide-sm small">{p.source === 'gateway' ? 'Automatic' : p.verified_by_name ?? '—'}{p.recorded_by_name && <div className="def">recorded by {p.recorded_by_name}</div>}</td>
            <td className="r num">{ghs(p.amount_ghs, 2)}</td></tr>)}</tbody></table></div>}</Gate>
    </div>
  </div>;
}
