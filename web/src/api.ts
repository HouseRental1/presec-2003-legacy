/** Thin API client. Session cookie is httpOnly; the custom header is the CSRF guard for writes. */
export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + url, {
    method, credentials: 'include',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'class-legacy' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? 'Something went wrong.');
  return data as T;
}
export const api = {
  get: <T = any>(url: string) => call<T>('GET', url),
  post: <T = any>(url: string, body: unknown = {}) => call<T>('POST', url, body),
};

export const ghs = (pesewas: number, dp = 0) => 'GH₵ ' + (Number(pesewas || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const pct = (x: number, dp = 0) => (x * 100).toFixed(dp) + '%';
export const date = (iso?: string | null) => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
export const today = () => new Date().toISOString().slice(0, 10);
export const HOUSE_COLOR: Record<string, string> = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ['H' + n, `var(--h${n})`]));
/** PRESEC Legon's eight original houses. */
/** The original eight PRESEC Legon houses, by house number. */
export const HOUSE_BASE: Record<string, string> = { H1: 'Kwansa', H2: 'Clerk', H3: 'Engmann', H4: 'Akro', H5: 'Riis', H6: 'Labone', H7: 'Ako-Adjei', H8: 'Owusu-Parry' };
/** Display name with the house number, e.g. "Kwansa (House 1)". */
export const HOUSE_NAME: Record<string, string> = Object.fromEntries(Object.entries(HOUSE_BASE).map(([id, n]) => [id, `${n} (House ${id.slice(1)})`]));
/** Accepts "Kwansa", "Kwansa (House 1)", "House 1", "1" or "H1" and returns the house id. */
export const houseIdFrom = (v: string) => { const t = v.trim().toLowerCase(); if (/^h[1-8]$/.test(t)) return t.toUpperCase(); const n = t.match(/^(?:house\s*)?([1-8])$/); if (n) return 'H' + n[1];
  const hit = Object.entries(HOUSE_BASE).find(([id, b]) => t === b.toLowerCase() || t === HOUSE_NAME[id].toLowerCase()); return hit ? hit[0] : v.trim(); };
