import { buildApp, App } from '../src/app.js';
import { seed, DEMO_PASSWORD } from '../src/seed.js';
import { pool, q, hmacHex, config } from '../src/lib.js';

export { pool, q, config };
export async function fresh(members = 380) {
  config.requireMfa = false;
  await seed({ members, quiet: true });
  return buildApp();
}
export async function token(app: App, key: string, code?: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${key}@presec2003.test`, password: DEMO_PASSWORD, ...(code ? { code } : {}) } });
  if (r.statusCode !== 200) throw new Error(`login ${key}: ${r.statusCode} ${r.body}`);
  return r.json().token as string;
}
export async function as(app: App, key: string) {
  const t = await token(app, key);
  const h = { authorization: 'Bearer ' + t };
  return {
    get: (url: string) => app.inject({ method: 'GET', url, headers: h }),
    post: (url: string, payload: object = {}) => app.inject({ method: 'POST', url, payload, headers: h }),
  };
}
export function signed(body: object) {
  const raw = JSON.stringify(body);
  return { raw, sig: hmacHex(config.webhookSecret, raw) };
}
export const memberNo = async (key: string) => (await q<any>(pool, `SELECT m.member_no FROM members m JOIN users u ON u.id=m.user_id WHERE u.email=$1`, [`${key}@presec2003.test`]))[0].member_no as string;
