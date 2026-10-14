import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, App } from '../src/app.js';
import { config } from '../src/lib.js';

let app: App;
beforeAll(async () => { config.canonicalHost = 'presec-2003-legacy.vercel.app'; app = await buildApp(); });
afterAll(async () => { config.canonicalHost = ''; await app.close(); });

describe('one address for everyone', () => {
  it('sends page visits on a one-off deployment address to the main site, keeping the path', async () => {
    const r = await app.inject({ method: 'GET', url: '/houses?x=1', headers: { host: 'presec-2003-legacy-hc5rfnzlf-house-rental-app.vercel.app' } });
    expect(r.statusCode).toBe(308);
    expect(r.headers.location).toBe('https://presec-2003-legacy.vercel.app/houses?x=1');
  });
  it('leaves the main site, API calls and webhooks alone', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'presec-2003-legacy-abc-house-rental-app.vercel.app' } })).statusCode).toBe(200);
    const main = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'presec-2003-legacy.vercel.app' } });
    expect(main.statusCode).toBe(200);
    const page = await app.inject({ method: 'GET', url: '/', headers: { host: 'presec-2003-legacy.vercel.app' } });
    expect(page.statusCode).not.toBe(308);
  });
});
