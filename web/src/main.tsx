import { StrictMode, useState } from 'react';
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

const NAV: [string, string, string?][] = [
  ['/', 'Home'], ['/money', 'Money'], ['/houses', 'Houses'], ['/project', 'Classroom project', 'proj.view'], ['/votes', 'Votes', 'vote'],
  ['/members', 'Members', 'dir'], ['/legacy', 'Legacy archive', 'proj.view'], ['/notifications', 'Notifications'], ['/audit', 'Audit trail', 'audit.view'],
];

function Login() {
  const { reload } = useSession();
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api.post('/auth/login', { email, password, ...(code ? { code } : {}) }); await reload(); }
    catch (x) { const a = x as ApiError; if (a.code === 'mfa_required') setNeedCode(true); setErr(a.message); }
    finally { setBusy(false); }
  };
  return <div className="login"><form className="card stack" onSubmit={submit}>
    <div className="row"><div className="seal">CY</div><div><h1 style={{ fontSize: '1.25rem' }}>Class of [Year] Legacy</h1><p className="muted small">Six-unit classroom block</p></div></div>
    <label className="f" htmlFor="em">Email<input id="em" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
    <label className="f" htmlFor="pw">Password<input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
    {needCode && <label className="f" htmlFor="cd">Authenticator code<input id="cd" inputMode="numeric" pattern="\d{6}" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></label>}
    {err && <div className="callout bad">{err}</div>}
    <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    <p className="def">Development sample accounts: ama, kofi, efua, yaw, nana, abena, kwame, akosua, gifty @classlegacy.test · password Legacy-demo-2026</p>
  </form></div>;
}

function Shell() {
  const { me, can, signOut } = useSession();
  if (!me) return <Login />;
  const items = NAV.filter(([, , p]) => !p || can(p));
  return <div className="app">
    <aside className="rail" aria-label="Main navigation">
      <div className="brandmark"><div className="seal">CY</div><div><b>Class of [Year] Legacy</b><span>Six-unit classroom block</span></div></div>
      <nav className="nav">{items.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}</nav>
    </aside>
    <main className="main">
      <div className="topbar">
        <div><b>{me.name}</b> <span className="muted small">{me.roles.join(' · ')}{me.member ? ' · ' + me.member.member_no : ''}</span></div>
        <div className="row">{me.mfaRequired && !me.mfaPassed && me.roles.some((r) => r !== 'member') && <a className="pill warn" href="/notifications">Two-factor needed for staff actions</a>}<button className="btn sm" onClick={signOut}>Sign out</button></div>
      </div>
      <Routes>
        <Route path="/" element={<Home />} /><Route path="/money" element={<Money />} /><Route path="/houses" element={<Houses />} />
        <Route path="/project" element={<Project />} /><Route path="/votes" element={<Votes />} /><Route path="/members" element={<Members />} />
        <Route path="/legacy" element={<Legacy />} /><Route path="/notifications" element={<Notifications />} /><Route path="/audit" element={<Audit />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </main>
    <nav className="tabbar" aria-label="Main navigation">{[['/', 'Home'], ['/money', 'Money'], ['/houses', 'Houses'], ['/project', 'Project'], ['/votes', 'Votes']].map(([to, l]) => <NavLink key={to} to={to} end={to === '/'}>{l}</NavLink>)}</nav>
  </div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><ToastProvider><SessionProvider><BrowserRouter><Shell /></BrowserRouter></SessionProvider></ToastProvider></StrictMode>);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
