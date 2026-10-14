import { Link } from 'react-router-dom';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError, HOUSE_COLOR, HOUSE_NAME } from './api';

export interface Me { userId: string; name: string; roles: string[]; perms: string[]; memberId: string | null; mfaPassed: boolean; mfaRequired: boolean; access: 'superadmin' | 'admin' | 'member'; memberParticipation: boolean; member: { member_no: string; house_id: string; show_on_wall: boolean } | null }

/* session */
const SessionCtx = createContext<{ me: Me | null; reload: () => Promise<void>; can: (p: string) => boolean; signOut: () => Promise<void> }>(null as any);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const reload = useCallback(async () => { try { setMe(await api.get<Me>('/me')); } catch { setMe(null); } }, []);
  useEffect(() => { reload(); }, [reload]);
  const signOut = async () => { await api.post('/auth/logout').catch(() => {}); setMe(null); };
  if (me === undefined) return <div className="login"><p className="muted">Loading…</p></div>;
  return <SessionCtx.Provider value={{ me, reload, signOut, can: (p) => !!me?.perms.includes(p) }}>{children}</SessionCtx.Provider>;
}
export const useSession = () => useContext(SessionCtx);

/* toasts */
const ToastCtx = createContext<(msg: string, bad?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; bad?: boolean } | null>(null);
  const show = useCallback((msg: string, bad?: boolean) => { setT({ msg, bad }); setTimeout(() => setT(null), bad ? 4500 : 3000); }, []);
  return <ToastCtx.Provider value={show}>{children}{t && <div role="status" className={'toast' + (t.bad ? ' bad' : '')}>{t.msg}</div>}</ToastCtx.Provider>;
}
export const useToast = () => useContext(ToastCtx);

/** Load data and expose a refresh; errors show as a callout (e.g. a role without access). */
export function useLoad<T>(url: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(async () => { try { setData(await api.get<T>(url)); setError(null); } catch (e) { setError(e as ApiError); } }, [url]);
  useEffect(() => { load(); }, [load, ...deps]); // eslint-disable-line
  return { data, error, reload: load };
}
/** Run a write; show the server's own message on failure (permission rules live on the server). */
export function useAction() {
  const toast = useToast();
  return async (fn: () => Promise<unknown>, ok: string, after?: () => void) => {
    try { await fn(); toast(ok); after?.(); } catch (e) { toast((e as Error).message, true); }
  };
}

export const Pill = ({ k = '', children }: { k?: string; children: ReactNode }) => <span className={'pill ' + k}>{children}</span>;
export const Bar = ({ v, color }: { v: number; color?: string }) => <div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, v * 100))}%`, background: color }} /></div>;
/** A classmate's name that opens their page. */
export const PersonLink = ({ no, name }: { no?: string | null; name: string }) => no ? <Link to={`/people/${no}`} className="person-link">{name}</Link> : <>{name}</>;
/** The PRESEC badge (web/public/badge.png). Until that file exists, a neat "03" seal stands in. */
export function Crest({ size = 40 }: { size?: number }) {
  const [ok, setOk] = useState(true);
  return ok ? <img className="crest" src="/badge.png" width={size} height={size} alt="PRESEC badge" onError={() => setOk(false)} />
    : <span className="seal" style={{ width: size, height: size, fontSize: size * .36 }} aria-hidden="true">03</span>;
}
/** Line drawing of the six-unit classroom block, in the style of an architect's elevation. */
export function BlockDrawing() {
  const bays = [0, 1, 2, 3, 4, 5];
  return <svg viewBox="0 0 360 150" className="block-drawing" role="img" aria-label="Elevation drawing of a six-unit classroom block">
    <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M14 52 L180 22 L346 52" /><path d="M24 52 H336 V118 H24 Z" /><path d="M14 118 H346" />
      {bays.map((i) => { const x = 30 + i * 51; return <g key={i}><rect x={x + 6} y="64" width="18" height="22" /><path d={`M${x + 15} 64 V86 M${x + 6} 75 H${x + 24}`} strokeWidth=".8" /><rect x={x + 30} y="80" width="13" height="38" /></g>; })}
      <path d="M24 132 H336 M24 128 V136 M336 128 V136" strokeWidth=".8" strokeDasharray="0" />
    </g>
    <text x="180" y="146" textAnchor="middle" fontSize="9" fill="currentColor" style={{ fontFamily: 'var(--f-body)' }}>Six classrooms · PRESEC Legon</text>
  </svg>;
}
/** Sign-in, sign-up and set-up screens: the plan on one side, the form on the other. */
export function AuthShell({ children }: { children: ReactNode }) {
  return <div className="auth">
    <aside className="auth-plan" aria-hidden="false">
      <div className="auth-crest"><Crest size={92} /></div>
      <h1 className="auth-title">Ɔdadeɛ 2003</h1>
      <p className="auth-sub">The Class of 2003 is building a six-unit classroom block for PRESEC Legon. Every cedi, pledge and brick is tracked here, in the open.</p>
      <BlockDrawing />
    </aside>
    <main className="auth-form">{children}</main>
  </div>;
}
export const House = ({ id }: { id: string }) => <span className="row" style={{ gap: 6, display: 'inline-flex' }}><span className="dot" style={{ background: HOUSE_COLOR[id] }} />{HOUSE_NAME[id] ?? id}</span>;
export const Tile = ({ l, v, d }: { l: string; v: ReactNode; d?: string }) => <div className="card stat"><div className="l">{l}</div><div className="v">{v}</div>{d && <div className="def">{d}</div>}</div>;
export function Gate({ error, children }: { error: ApiError | null; children: ReactNode }) {
  if (error) return <div className="callout warn"><b>{error.status === 403 ? 'Restricted. ' : ''}</b>{error.message}</div>;
  return <>{children}</>;
}
export const STATUS: Record<string, [string, string]> = {
  verified: ['Verified', 'ok'], pending: ['Awaiting verification', 'warn'], exception: ['Exception', 'bad'], rejected: ['Rejected', 'bad'],
  reversal_requested: ['Reversal requested', 'warn'], reversed: ['Reversed', 'bad'],
};
