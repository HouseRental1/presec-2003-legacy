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
export const HOUSE_COLOR: Record<string, string> = { H1: 'var(--h1)', H2: 'var(--h2)', H3: 'var(--h3)', H4: 'var(--h4)' };
export const HOUSE_NAME: Record<string, string> = { H1: 'Aggrey', H2: 'Nkrumah', H3: 'Casely-Hayford', H4: 'Yaa Asantewaa' };
