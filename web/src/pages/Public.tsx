import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ghs, pct } from '../api';
import { Bar, useLoad } from '../ui';

/** Public page: approved figures only, no individual amounts. Friends of the school can give here. */
export function Give() {
  const p = useLoad<any>('/public');
  const [f, setF] = useState({ name: '', email: '', amount: '200', channel: 'card' });
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const donate = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api.post('/public/donate', { name: f.name, email: f.email, amountGhs: Number(f.amount), channel: f.channel });
      if (r.checkout.url) window.location.href = r.checkout.url; else window.location.href = `/pay/return?ref=${r.reference}`;
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return <div>
    <div className="public-hero"><div className="inner stack">
      <div className="eyebrow" style={{ color: 'inherit', opacity: .8 }}>PRESEC Legon · Ɔdadeɛ 2003 year group</div>
      <h1 style={{ fontSize: 'clamp(1.8rem,5vw,2.6rem)' }}>A six-unit classroom block for PRESEC, from the Class of 2003</h1>
      {p.data && <><div className="bigfig">{ghs(p.data.raised)}</div><Bar v={p.data.raised / Math.max(1, p.data.budget)} />
        <p>{pct(p.data.raised / Math.max(1, p.data.budget))} of {ghs(p.data.budget)} raised · building {p.data.acceptedProgress.toFixed(0)}% complete (inspected and signed off)</p></>}
    </div></div>
    <div className="public-body stack">
      <div className="grid-2">
        <form className="card stack" onSubmit={donate}><h2>Give to the classroom block</h2>
          <p className="small muted">Your gift goes to the year group’s project account and is receipted. Gifts from friends of the school count toward the building, not the house competition.</p>
          <div className="fgrid">
            <label className="f" htmlFor="dn">Your name<input id="dn" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label className="f" htmlFor="de">Email (for your receipt)<input id="de" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
            <label className="f" htmlFor="da">Amount (GH₵)<input id="da" type="number" min="5" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
            <label className="f" htmlFor="dc">Pay with<select id="dc" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="card">Card</option><option value="momo">Mobile money</option></select></label>
          </div>
          {err && <div className="callout bad">{err}</div>}
          <button className="btn primary" disabled={busy}>{busy ? 'Opening checkout…' : 'Continue to secure payment'}</button>
        </form>
        <div className="card"><h2 style={{ marginBottom: 8 }}>Where the money goes</h2>{p.data && <dl className="kv"><dt>Spent to date</dt><dd>{ghs(p.data.spent)}</dd><dt>Approved budget</dt><dd>{ghs(p.data.budget)}</dd></dl>}
          <p className="def" style={{ marginTop: 10 }}>Every payment out needs two approvers, is made only against the quantity surveyor’s certificate, and is recorded in an audit trail checked by an independent reviewer.</p>
          <p style={{ marginTop: 12 }}><Link to="/">Classmates: sign in</Link></p></div>
      </div>
      {p.data && <div className="card"><div className="card-h"><h2>Classmates who have given</h2><span className="muted small">{p.data.wall.length} names · no amounts</span></div><p className="small" style={{ lineHeight: 1.9 }}>{p.data.wall.join(' · ')}</p></div>}
    </div>
  </div>;
}

/** Paystack returns here. The webhook is the proof of payment; this page just shows the outcome. */
export function PayReturn() {
  const [sp] = useSearchParams(); const ref = sp.get('ref') ?? sp.get('reference') ?? '';
  const [s, setS] = useState<any>(null), [tries, setTries] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = async (n: number) => {
      try { const r = n === 3 ? await api.post(`/payments/check/${encodeURIComponent(ref)}`) : await api.get(`/payments/status/${encodeURIComponent(ref)}`); if (stop) return; setS(r); if (r.status === 'pending' && n < 12) setTimeout(() => { setTries(n + 1); tick(n + 1); }, 2500); }
      catch { if (!stop) setS({ status: 'unknown' }); }
    };
    if (ref) tick(0);
    return () => { stop = true; };
  }, [ref]);
  return <div className="login"><div className="card stack" style={{ maxWidth: 460 }}>
    <h1 style={{ fontSize: '1.3rem' }}>{s?.status === 'verified' ? 'Thank you — payment received' : s?.status === 'pending' ? 'Confirming your payment…' : s?.status === 'rejected' ? 'Payment not completed' : 'Checking…'}</h1>
    {s?.status === 'verified' && <p>{ghs(s.amount, 2)} is confirmed. Receipt <b className="mono">{s.receipt}</b>.{s.category === 'member' ? ' Your house has been credited.' : ''}</p>}
    {s?.status === 'pending' && <p className="muted">Waiting for the provider’s confirmation ({tries + 1}). If you approved the prompt, this usually takes a few seconds.</p>}
    {s?.status === 'rejected' && <p className="muted">No money was taken, or the provider reported a failure. You can try again.</p>}
    <p className="def">Reference <span className="mono">{ref}</span></p>
    <div className="row"><Link className="btn primary" to="/money">Back to my contributions</Link><Link className="btn" to="/give">Public page</Link></div>
  </div></div>;
}

export function SetPassword() {
  const [sp] = useSearchParams(); const token = sp.get('token') ?? '';
  const [pw, setPw] = useState(''), [pw2, setPw2] = useState(''), [msg, setMsg] = useState(''), [done, setDone] = useState(false);
  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) return setMsg('The two passwords do not match.');
    try { await api.post('/auth/set-password', { token, password: pw }); setDone(true); } catch (x) { setMsg((x as Error).message); }
  };
  return <div className="login"><form className="card stack" onSubmit={go} style={{ maxWidth: 420 }}>
    <h1 style={{ fontSize: '1.3rem' }}>Set your password</h1>
    {done ? <><p>Your password is set. You can now sign in.</p><Link className="btn primary" to="/">Sign in</Link></> : <>
      <label className="f" htmlFor="p1">New password<input id="p1" type="password" autoComplete="new-password" minLength={10} required value={pw} onChange={(e) => setPw(e.target.value)} /><span className="def">At least 10 characters. A short sentence is easy to remember.</span></label>
      <label className="f" htmlFor="p2">Repeat it<input id="p2" type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
      {msg && <div className="callout bad">{msg}</div>}<button className="btn primary">Save password</button></>}
  </form></div>;
}
