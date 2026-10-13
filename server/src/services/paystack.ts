/**
 * Paystack adapter (Ghana: MTN MoMo, Telecel Cash, AT Money and cards, in GHS).
 * Docs: https://paystack.com/docs/api/transaction/ · https://paystack.com/docs/payments/webhooks/
 * Webhook signature: x-paystack-signature = HMAC-SHA512(raw body, secret key), checked in payments.ts.
 */
import { config, AppError } from '../lib.js';

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  if (!config.paystackSecret) throw new AppError(503, 'provider_not_configured', 'Online payments are not configured yet.');
  const res = await fetch(config.paystackApi + path, {
    method, headers: { authorization: `Bearer ${config.paystackSecret}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.status === false) throw new AppError(502, 'provider_error', `Paystack: ${j.message ?? res.statusText}`);
  return j.data;
}

export async function initialize(o: { email: string; amountPesewas: number; reference: string; channel: 'momo' | 'card'; callbackUrl: string; metadata: Record<string, unknown> }) {
  const d = await call('POST', '/transaction/initialize', {
    email: o.email, amount: String(o.amountPesewas), currency: 'GHS', reference: o.reference,
    channels: o.channel === 'momo' ? ['mobile_money'] : ['card'], callback_url: o.callbackUrl, metadata: JSON.stringify(o.metadata),
  });
  return { authorizationUrl: d.authorization_url as string, accessCode: d.access_code as string, reference: d.reference as string };
}

export interface Verified { id: number; reference: string; status: string; amount: number; currency: string; fees: number | null; paid_at: string; channel: string }
export async function verify(reference: string): Promise<Verified> {
  return call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
}
