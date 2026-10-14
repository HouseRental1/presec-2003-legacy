import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { api, ApiError } from './api';
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
import { Link, useLocation } from 'react-router-dom';

const NAV: [string, string, string?][] = [
  ['/', 'Home'], ['/money', 'Money'], ['/houses', 'Houses'], ['/project', 'Classroom project', 'proj.view'], ['/votes', 'Votes', 'vote'],
  ['/members', 'Year group', 'dir'], ['/community', 'News & events', 'own'], ['/legacy', 'Legacy archive', 'proj.view'], ['/notifications', 'Notifications'],
  ['/audit', 'Audit trail', 'audit.view'], ['/admin', 'Administration', 'admin'], ['/give', 'Public page'],
];

function FirstAdmin({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ name: '', email: '', password: '', password2: '', code: '' });
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (f.password !== f.password2) return setErr('The two passwords do not match.');
    setBusy(true);
    try { await api.post('/setup/first-admin', { name: f.name, email: f.email, password: f.password, code: f.code }); onDone(); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return <div className="login"><form className="card stack" onSubmit={submit}>
    <div className="row"><div className="seal">03</div><div><h1 style={{ fontSize: '1.25rem' }}>Set up Class of 2003 Legacy</h1><p className="muted small">Create the first administrator account</p></div></div>
    <p className="small">This appears only once, while the platform has no accounts. The person who sets it up becomes the platform administrator and invites everyone else.</p>
    <label className="f" htmlFor="sn">Your full name<input id="sn" required autoComplete="name" value={f.name} onChange={set('name')} /></label>
    <label className="f" htmlFor="se">Email<input id="se" type="email" required autoComplete="username" value={f.email} onChange={set('email')} /></label>
    <label className="f" htmlFor="sp">Password<input id="sp" type="password" required minLength={12} autoComplete="new-password" value={f.password} onChange={set('password')} /><span className="def">At least 12 characters. A short sentence is easy to remember.</span></label>
    <label className="f" htmlFor="sp2">Repeat password<input id="sp2" type="password" required autoComplete="new-password" value={f.password2} onChange={set('password2')} /></label>
    <label className="f" htmlFor="sc">Set-up code<input id="sc" required autoComplete="off" value={f.code} onChange={set('code')} /><span className="def">The CRON_SECRET value from Vercel → Settings → Environment Variables.</span></label>
    {err && <div className="callout bad">{err}</div>}
    <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create administrator account'}</button>
  </form></div>;
}

function Login() {
  const [setup, setSetup] = useState<{ database: string; needsSetup: boolean } | null>(null);
  const [created, setCreated] = useState(false);
  useEffect(() => { api.get('/setup/status').then(setSetup).catch(() => setSetup({ database: 'unreachable', needsSetup: false })); }, []);
  const { reload } = useSession();
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false), [err, setErr] = useState(''), [busy, setBusy] = useState(false), [sent, setSent] = useState(false);
  const forgot = async () => { if (!email) return setErr('Enter your email first.'); await api.post('/auth/forgot', { email }).catch(() => {}); setSent(true); setErr(''); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api.post('/auth/login', { email, password, ...(code ? { code } : {}) }); await reload(); }
    catch (x) { const a = x as ApiError; if (a.code === 'mfa_required') setNeedCode(true); setErr(a.message); }
    finally { setBusy(false); }
  };
  if (setup?.needsSetup && !created) return <FirstAdmin onDone={() => { setCreated(true); setErr(''); }} />;
  return <div className="login"><form className="card stack" onSubmit={submit}>
    {created && <div className="callout ok">Administrator account created. Sign in with that email and password.</div>}
    {setup && setup.database !== 'ready' && <div className="callout bad">{setup.database === 'not_migrated' ? 'The database tables have not been created yet. In Vercel, redeploy the latest deployment and check the build log for “applied 003_platform.sql”.' : 'The app cannot reach its database. In Vercel, check that DATABASE_URL is set (Storage → Neon) and redeploy.'}</div>}
    <div className="row"><div className="seal">03</div><div><h1 style={{ fontSize: '1.25rem' }}>Class of 2003 Legacy</h1><p className="muted small">PRESEC Legon · Ɔdadeɛ 2003 year group</p></div></div>
    <label className="f" htmlFor="em">Email<input id="em" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
    <label className="f" htmlFor="pw">Password<input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
    {needCode && <label className="f" htmlFor="cd">Authenticator code<input id="cd" inputMode="numeric" pattern="\d{6}" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>}
    {err && <div className="callout bad">{err}</div>}
    <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    <div className="row between"><button type="button" className="btn sm" onClick={forgot}>Forgot password?</button><Link to="/give" className="small">Public page</Link></div>
    {sent && <div className="callout ok">If that email is registered, a reset link is on its way by email and SMS.</div>}
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
  const isAdmin = can('admin.members') || can('rules.edit') || can('gov.manage') || can('reports');
  const items = NAV.filter(([, , p]) => !p || (p === 'admin' ? isAdmin : can(p)));
  return <div className="app">
    <aside className="rail" aria-label="Main navigation">
      <div className="brandmark"><div className="seal">03</div><div><b>Class of 2003 Legacy</b><span>PRESEC Legon · Ɔdadeɛ 2003</span></div></div>
      <nav className="nav">{items.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}</nav>
    </aside>
    <main className="main">
      <div className="topbar">
        <Link to="/profile" style={{ color: 'inherit', textDecoration: 'none' }}><b>{me.name}</b> <span className="muted small">{me.roles.join(' · ')}{me.member ? ' · ' + me.member.member_no : ''}</span></Link>
        <div className="row">{me.mfaRequired && !me.mfaPassed && me.roles.some((r) => r !== 'member') && <Link className="pill warn" to="/profile">Set up two-factor sign-in</Link>}<button className="btn sm" onClick={signOut}>Sign out</button></div>
      </div>
      <Routes>
        <Route path="/" element={<Home />} /><Route path="/money" element={<Money />} /><Route path="/houses" element={<Houses />} />
        <Route path="/project" element={<Project />} /><Route path="/votes" element={<Votes />} /><Route path="/members" element={<Members />} />
        <Route path="/profile" element={<Profile />} /><Route path="/community" element={<Community />} /><Route path="/admin" element={<Admin />} />
        <Route path="/legacy" element={<Legacy />} /><Route path="/notifications" element={<Notifications />} /><Route path="/audit" element={<Audit />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </main>
    <nav className="tabbar" aria-label="Main navigation">{[['/', 'Home'], ['/money', 'Money'], ['/houses', 'Houses'], ['/project', 'Project'], ['/votes', 'Votes']].map(([to, l]) => <NavLink key={to} to={to} end={to === '/'}>{l}</NavLink>)}</nav>
  </div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><ToastProvider><SessionProvider><BrowserRouter><Shell /></BrowserRouter></SessionProvider></ToastProvider></StrictMode>);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
