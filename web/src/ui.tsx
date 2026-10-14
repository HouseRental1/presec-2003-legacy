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
