import { Component, ReactNode, StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { api, ApiError, HOUSE_NAME } from './api';
import { SessionProvider, ToastProvider, useSession } from './ui';
import Home from './pages/Home';
import Money from './pages/Money';
import Houses from './pages/Houses';
import Project from './pages/Project';
import Votes from './pages/Votes';
import Members from './pages/Members';
import { Audit, Legacy, Notifications } from './pages/Other';
import { Give, PayReturn, SetPassword } from './pages/Public';
import Profile from './pages/Profile';
import Community from './pages/Community';
import Admin from './pages/Admin';
import Pledges from './pages/Pledges';
import Person from './pages/Person';
import { Link, useLocation } from 'react-router-dom';

/** Administrators: everything, starting at the administration dashboard. */
const ADMIN_NAV: [string, string, string?][] = [
  ['/admin', 'Administration'], ['/', 'Home'], ['/money', 'Money'], ['/pledges', 'Pledges'], ['/houses', 'Houses'], ['/project', 'Classroom project'], ['/votes', 'Votes'],
  ['/members', 'Year group'], ['/community', 'News & events'], ['/legacy', 'Legacy archive'], ['/notifications', 'Notifications'],
  ['/audit', 'Audit trail'], ['/give', 'Public page'],
];
/** Members: view-only, plus pledging and paying their own contributions. */
const MEMBER_NAV: [string, string, string?][] = [
  ['/', 'Home'], ['/money', 'My giving'], ['/pledges', 'Pledges'], ['/houses', 'Houses'], ['/project', 'Project progress'], ['/votes', 'Votes', 'vote'],
  ['/members', 'Year group'], ['/community', 'News & events'], ['/legacy', 'Legacy archive'], ['/notifications', 'Notifications'], ['/give', 'Public page'],
];
const ADMIN_TABS = [['/admin', 'Admin'], ['/', 'Home'], ['/money', 'Money'], ['/houses', 'Houses'], ['/project', 'Project']];
const MEMBER_TABS = [['/', 'Home'], ['/money', 'Give'], ['/pledges', 'Pledges'], ['/houses', 'Houses'], ['/project', 'Project']];

function FirstAdmin({ onDone, recover = false, onCancel }: { onDone: () => void; recover?: boolean; onCancel?: () => void }) {
  const [f, setF] = useState({ name: '', email: '', password: '', password2: '', code: '' });
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (f.password !== f.password2) return setErr('The two passwords do not match.');
    setBusy(true);
    try { await api.post(recover ? '/setup/recover-admin' : '/setup/first-admin', { name: f.name, email: f.email, password: f.password, code: f.code }); onDone(); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return <div className="login"><form className="card stack" onSubmit={submit}>
    <div className="row"><div className="seal">03</div><div><h1 style={{ fontSize: '1.25rem' }}>{recover ? 'Reset the administrator account' : 'Set up Class of 2003 Legacy'}</h1><p className="muted small">{recover ? 'Available only while the platform has a single account' : 'Create the first administrator account'}</p></div></div>
    <p className="small">{recover ? 'Use this if the first administrator account was created with a password you no longer have. It replaces that account’s name, email and password.' : 'This appears only once, while the platform has no accounts. The person who sets it up becomes the platform administrator and invites everyone else.'}</p>
    <label className="f" htmlFor="sn">Your full name<input id="sn" required autoComplete="name" value={f.name} onChange={set('name')} /></label>
    <label className="f" htmlFor="se">Email<input id="se" type="email" required autoComplete="username" value={f.email} onChange={set('email')} /></label>
    <label className="f" htmlFor="sp">Password<input id="sp" type="password" required minLength={12} autoComplete="new-password" value={f.password} onChange={set('password')} /><span className="def">At least 12 characters. A short sentence is easy to remember.</span></label>
    <label className="f" htmlFor="sp2">Repeat password<input id="sp2" type="password" required autoComplete="new-password" value={f.password2} onChange={set('password2')} /></label>
    <label className="f" htmlFor="sc">Set-up code<input id="sc" required autoComplete="off" value={f.code} onChange={set('code')} /><span className="def">The CRON_SECRET value from Vercel → Settings → Environment Variables.</span></label>
    {err && <div className="callout bad">{err}</div>}
    <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : recover ? 'Reset administrator account' : 'Create administrator account'}</button>
    {onCancel && <button type="button" className="btn" onClick={onCancel}>Back to sign in</button>}
  </form></div>;
}

const HOUSE_CHOICES = Object.entries(HOUSE_NAME) as [string, string][];
/** Request access: the classmate chooses their own password; an administrator approves before they can sign in. */
function Signup({ onDone, onCancel }: { onDone: (email: string) => void; onCancel: () => void }) {
  const [f, setF] = useState({ fullName: '', email: '', phone: '', houseId: '', city: '', profession: '', note: '', password: '', password2: '' });
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (f.password !== f.password2) return setErr('The two passwords do not match.');
    if (!f.houseId) return setErr('Choose your house.');
    setBusy(true);
    try { const { password2, ...body } = f; await api.post('/signup', body); onDone(f.email.trim()); }
    catch (x) { setErr((x as Error).message.replace(/^\w+: /, '').replace(/; \w+: /g, ' ')); } finally { setBusy(false); }
  };
  return <div className="login"><form className="card stack" onSubmit={submit} style={{ maxWidth: 520 }}>
    <div className="row"><div className="seal">03</div><div><h1 style={{ fontSize: '1.25rem' }}>Request access</h1><p className="muted small">For the PRESEC Legon Ɔdadeɛ 2003 year group</p></div></div>
    <p className="small" style={{ margin: 0 }}>Fill this in and an administrator will approve your account, usually after checking with your house. You choose your password now and use it once approved.</p>
    <div className="fgrid">
      <label className="f" htmlFor="su1">Full name<input id="su1" required autoComplete="name" value={f.fullName} onChange={set('fullName')} /></label>
      <label className="f" htmlFor="su2">Email<input id="su2" type="email" required autoComplete="email" value={f.email} onChange={set('email')} /></label>
      <label className="f" htmlFor="su3">Your house at PRESEC<select id="su3" required value={f.houseId} onChange={set('houseId')}><option value="">Choose…</option>{HOUSE_CHOICES.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></label>
      <label className="f" htmlFor="su4">Phone (optional)<input id="su4" type="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} /></label>
      <label className="f" htmlFor="su5">City / country (optional)<input id="su5" value={f.city} onChange={set('city')} /></label>
      <label className="f" htmlFor="su6">Profession (optional)<input id="su6" value={f.profession} onChange={set('profession')} /></label>
      <label className="f" htmlFor="su7" style={{ gridColumn: '1 / -1' }}>Anything that helps us confirm you (optional)<textarea id="su7" rows={2} placeholder="e.g. form class, nickname, housemaster" value={f.note} onChange={set('note')} /></label>
      <label className="f" htmlFor="su8">Choose a password<input id="su8" type="password" required minLength={10} autoComplete="new-password" value={f.password} onChange={set('password')} /><span className="def">At least 10 characters.</span></label>
      <label className="f" htmlFor="su9">Repeat password<input id="su9" type="password" required autoComplete="new-password" value={f.password2} onChange={set('password2')} /></label>
    </div>
    {err && <div className="callout bad">{err}</div>}
    <button className="btn primary" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
    <button type="button" className="btn" onClick={onCancel}>Back to sign in</button>
  </form></div>;
}

/** Set on a successful sign-in so the layout can send the person to their own area once. */
let justSignedIn = false;

function Login() {
  const [setup, setSetup] = useState<{ database: string; needsSetup: boolean; canRecover?: boolean } | null>(null);
  const [created, setCreated] = useState(false), [recovering, setRecovering] = useState(false), [signingUp, setSigningUp] = useState(false), [requested, setRequested] = useState(false);
  useEffect(() => { api.get('/setup/status').then(setSetup).catch(() => setSetup({ database: 'unreachable', needsSetup: false })); }, []);
  const { reload } = useSession();
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false), [err, setErr] = useState(''), [busy, setBusy] = useState(false), [sent, setSent] = useState(false);
  const forgot = async () => { if (!email) return setErr('Enter your email first.'); await api.post('/auth/forgot', { email }).catch(() => {}); setSent(true); setErr(''); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await api.post('/auth/login', { email, password, ...(code ? { code } : {}) });
      // Send each person to their own area: administrators to Administration, members to Home.
      justSignedIn = true;
      await reload();
    }
    catch (x) { const a = x as ApiError; if (a.code === 'mfa_required') setNeedCode(true); setErr(a.message); }
    finally { setBusy(false); }
  };
  if (setup?.needsSetup && !created) return <FirstAdmin onDone={() => { setCreated(true); setErr(''); }} />;
  if (signingUp) return <Signup onDone={(e) => { setSigningUp(false); setEmail(e); setRequested(true); setErr(''); }} onCancel={() => setSigningUp(false)} />;
  if (recovering) return <FirstAdmin recover onDone={() => { setRecovering(false); setCreated(true); setErr(''); }} onCancel={() => setRecovering(false)} />;
  return <div className="login"><form className="card stack" onSubmit={submit}>
    {created && <div className="callout ok">Administrator account saved. Sign in with that email and password.</div>}
    {requested && <div className="callout ok"><b>Request sent.</b> An administrator will check you are in the 2003 year group and approve your account. Once approved, sign in here with your email and the password you chose.</div>}
    {setup && setup.database !== 'ready' && <div className="callout bad">{setup.database === 'not_migrated' ? 'The database tables have not been created yet. In Vercel, redeploy the latest deployment and check the build log for “applied 003_platform.sql”.' : 'The app cannot reach its database. In Vercel, check that DATABASE_URL is set (Storage → Neon) and redeploy.'}</div>}
    <div className="row"><div className="seal">03</div><div><h1 style={{ fontSize: '1.25rem' }}>Class of 2003 Legacy</h1><p className="muted small">PRESEC Legon · Ɔdadeɛ 2003 year group</p></div></div>
    <label className="f" htmlFor="em">Email<input id="em" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
    <label className="f" htmlFor="pw">Password<input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
    {needCode && <label className="f" htmlFor="cd">Authenticator code<input id="cd" inputMode="numeric" pattern="\d{6}" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>}
    {err && <div className="callout bad">{err}</div>}
    <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    {!setup?.needsSetup && <div className="join-yeargroup"><span className="small muted">Ɔdadeɛ 2003 and not signed up yet?</span><button type="button" className="btn" onClick={() => setSigningUp(true)}>Request access</button></div>}
    <div className="row between"><button type="button" className="btn sm" onClick={forgot}>Forgot password?</button><Link to="/give" className="small">Public page</Link></div>
    {sent && <div className="callout ok">If that email is registered, a reset link is on its way by email and SMS.</div>}
    {setup?.canRecover && <button type="button" className="btn sm" onClick={() => setRecovering(true)}>Locked out during set-up? Reset the administrator account</button>}
    {location.hostname === 'localhost' && <p className="def">Development sample accounts: ama, kofi, efua, yaw, nana, abena, kwame, akosua, gifty @presec2003.test · password Legacy-demo-2026</p>}
  </form></div>;
}

function Shell() {
  const { me, can, signOut } = useSession();
  const loc = useLocation();
  if (loc.pathname === '/give') return <Give />;
  if (loc.pathname === '/pay/return') return <PayReturn />;
  if (loc.pathname === '/set-password') return <SetPassword />;
  if (!me) return <Login />;
  const isAdmin = me.access !== 'member';
  if (justSignedIn) { justSignedIn = false; const home = isAdmin ? '/admin' : '/'; if (loc.pathname !== home && (loc.pathname === '/' || loc.pathname === '/admin')) return <Navigate to={home} replace />; }
  const items = (isAdmin ? ADMIN_NAV : MEMBER_NAV).filter(([, , p]) => !p || can(p));
  const memberOnly = (el: ReactNode) => isAdmin ? el : <Navigate to="/" replace />;
  return <div className="app">
    <aside className="rail" aria-label="Main navigation">
      <div className="brandmark"><div className="seal">03</div><div><b>Class of 2003 Legacy</b><span>PRESEC Legon · Ɔdadeɛ 2003</span></div></div>
      <nav className="nav">{items.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}</nav>
    </aside>
    <main className="main">
      <div className="topbar">
        <Link to="/profile" style={{ color: 'inherit', textDecoration: 'none' }}><b>{me.name}</b> <span className={'pill ' + (isAdmin ? 'ok' : '')} style={{ marginLeft: 6 }}>{me.access === 'superadmin' ? 'Super admin' : isAdmin ? 'Admin' : 'Member'}</span> <span className="muted small">{''}{me.member ? ' · ' + me.member.member_no : ''}</span></Link>
        <div className="row">{me.mfaRequired && !me.mfaPassed && me.roles.some((r) => r !== 'member') && <Link className="pill warn" to="/profile">Set up two-factor sign-in</Link>}<button className="btn sm" onClick={signOut}>Sign out</button></div>
      </div>
      <Routes>
        <Route path="/" element={<Home />} /><Route path="/money" element={<Money />} /><Route path="/houses" element={<Houses />} /><Route path="/pledges" element={<Pledges />} /><Route path="/people/:no" element={<Person />} />
        <Route path="/project" element={<Project />} /><Route path="/votes" element={isAdmin || can('vote') ? <Votes /> : <Navigate to="/" replace />} /><Route path="/members" element={<Members />} />
        <Route path="/profile" element={<Profile />} /><Route path="/community" element={<Community />} /><Route path="/admin" element={memberOnly(<Admin />)} />
        <Route path="/legacy" element={<Legacy />} /><Route path="/notifications" element={<Notifications />} /><Route path="/audit" element={memberOnly(<Audit />)} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </main>
    <nav className="tabbar" aria-label="Main navigation">{(isAdmin ? ADMIN_TABS : MEMBER_TABS).map(([to, l]) => <NavLink key={to} to={to} end={to === '/'}>{l}</NavLink>)}</nav>
  </div>;
}

/** Shows a readable message instead of a blank page if something fails while drawing a screen. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="login"><div className="card stack" style={{ maxWidth: 520 }}><h1 style={{ fontSize: '1.2rem' }}>Something went wrong on this page</h1>
      <p className="small">Reload the page. If it happens again, send a screenshot of this message to the administrator.</p>
      <pre className="mono small" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2)', padding: 10, borderRadius: 8 }}>{String(this.state.error?.message ?? this.state.error)}</pre>
      <button className="btn primary" onClick={() => location.reload()}>Reload</button></div></div>;
  }
}

createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><ToastProvider><SessionProvider><BrowserRouter><Shell /></BrowserRouter></SessionProvider></ToastProvider></ErrorBoundary></StrictMode>);
// Remove the offline cache from earlier versions (it could show a stale, blank page).
if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
