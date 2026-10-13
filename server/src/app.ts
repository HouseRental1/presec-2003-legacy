import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ZodError, z } from 'zod';
import { pool, tx, q, Actor, AppError, config, perms, verifyAuditChain, need, hmacHex, Db, one } from './lib.js';
import * as M from './services/members.js';
import * as P from './services/payments.js';
import * as F from './services/finance.js';
import * as C from './services/competition.js';
import * as J from './services/project.js';
import * as G from './services/governance.js';
import * as L from './services/legacy.js';
import { trialBalance } from './services/ledger.js';

declare module 'fastify' { interface FastifyRequest { actor: Actor | null; rawBody?: string; usedCookie?: boolean } }

export async function buildApp() {
  const app = Fastify({ logger: config.env !== 'test' ? { redact: ['req.headers.authorization', 'req.headers.cookie'] } : false, bodyLimit: 1_000_000 });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Keep the raw body: webhook signatures are computed over the exact bytes received.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch { done(new AppError(400, 'bad_json', 'Request body is not valid JSON.'), undefined); }
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', config.webOrigin);
    reply.header('Access-Control-Allow-Credentials', 'true');
    reply.header('Access-Control-Allow-Headers', 'content-type, authorization, x-requested-with');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    const cookieTok = req.cookies?.sid;
    req.usedCookie = !bearer && !!cookieTok;
    req.actor = await M.actorFromToken(pool, bearer ?? cookieTok);
    // CSRF: cookie-authenticated writes must carry the app's custom header (SameSite=Lax keeps links from WhatsApp working).
    if (req.usedCookie && req.method === 'POST' && req.headers['x-requested-with'] !== 'class-legacy') throw new AppError(403, 'csrf', 'Missing request header.');
  });
  app.options('/*', async (_req, reply) => reply.code(204).send());

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid', message: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') });
    if (err.code === '23505') return reply.code(409).send({ error: 'duplicate', message: 'That record already exists.' });
    if (err.code === 'P0001') return reply.code(409).send({ error: 'integrity', message: err.message });
    if (err.statusCode === 429) return reply.code(429).send({ error: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' });
    app.log.error(err);
    return reply.code(500).send({ error: 'server', message: 'Something went wrong on our side. The action was not saved.' });
  });

  const signedIn = (req: FastifyRequest) => { if (!req.actor) throw new AppError(401, 'signed_out', 'Please sign in.'); return req.actor; };
  /** Every write runs in one database transaction with the signed-in actor. */
  type Out<S> = S extends z.ZodTypeAny ? z.output<S> : any;
  const write = <S extends z.ZodTypeAny | null>(schema: S, fn: (db: Db, a: Actor, body: Out<S>, req: FastifyRequest) => Promise<unknown>) =>
    async (req: FastifyRequest) => { const a = signedIn(req); const body = (schema ? schema.parse(req.body ?? {}) : req.body) as Out<S>; return (await tx((db) => fn(db, a, body, req))) ?? { ok: true }; };
  const read = (fn: (a: Actor, req: FastifyRequest) => Promise<unknown>) => async (req: FastifyRequest) => fn(signedIn(req), req);
  const id = (req: FastifyRequest) => (req.params as any).id as string;

  /* auth */
  app.post('/api/auth/login', { config: { rateLimit: { max: config.loginRateMax, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(1), code: z.string().regex(/^\d{6}$/).optional() }).parse(req.body);
    const out = await tx((db) => M.login(db, b.email, b.password, b.code));
    reply.setCookie('sid', out.token, { httpOnly: true, sameSite: 'lax', secure: config.env === 'production', path: '/', maxAge: config.sessionHours * 3600 });
    return out;
  });
  app.post('/api/auth/logout', async (req, reply) => { const t = req.headers.authorization?.slice(7) ?? req.cookies.sid; if (t) await tx((db) => M.logout(db, t)); reply.clearCookie('sid', { path: '/' }); return { ok: true }; });
  app.post('/api/auth/mfa/start', write(null, (db, a) => M.startMfaEnrolment(db, a)));
  app.post('/api/auth/mfa/confirm', write(z.object({ code: z.string().regex(/^\d{6}$/) }), (db, a, b) => M.confirmMfaEnrolment(db, a, b.code)));
  app.get('/api/me', read(async (a) => {
    const member = a.memberId ? await one(pool, `SELECT m.member_no, m.full_name, m.show_on_wall, hm.house_id FROM members m JOIN house_memberships hm ON hm.member_id=m.id AND hm.valid_to IS NULL WHERE m.id=$1`, [a.memberId]) : null;
    return { ...a, perms: [...perms(a)], member, mfaRequired: config.requireMfa };
  }));

  /* public page — only approved figures, no individual amounts */
  app.get('/api/public', async () => {
    const d = await F.dashboard(pool); const p = await J.progress(pool);
    const wall = await q(pool, `SELECT DISTINCT m.full_name FROM members m JOIN payments p ON p.member_id=m.id AND p.status='verified' WHERE m.show_on_wall ORDER BY 1`);
    return { raised: d.cashReceived, budget: d.budget, spent: d.spent, acceptedProgress: p.accepted, wall: wall.map((w: any) => w.full_name) };
  });

  /* dashboard & competition */
  app.get('/api/dashboard', read(async () => ({ ...(await F.dashboard(pool)), progress: await J.progress(pool).then((p) => ({ reported: p.reported, verified: p.verified, accepted: p.accepted })) })));
  app.get('/api/standings', read(async (_a, req) => C.standings(pool, (req.query as any).asOf)));
  app.get('/api/rules', read(async () => C.ruleVersions(pool)));
  app.get('/api/captain/outreach', read((a) => C.captainOutreach(pool, a)));
  app.post('/api/captain/remind', write(null, (db, a) => C.sendReminder(db, a)));

  /* member money */
  app.get('/api/me/statement', read((a) => P.statement(pool, a)));
  app.post('/api/pledges', write(P.PledgeInput, (db, a, b) => P.setPledge(db, a, b)));
  app.post('/api/payments/initiate', write(P.InitiateInput, (db, a, b) => P.initiate(db, a, b)));
  app.post('/api/payments/evidence', write(P.EvidenceInput, (db, a, b) => P.submitEvidence(db, a, b)));
  app.post('/api/me/privacy', write(z.object({ showOnWall: z.boolean() }), async (db, a, b) => { if (!a.memberId) throw new AppError(403, 'forbidden', 'Members only.'); await db.query('UPDATE members SET show_on_wall=$2 WHERE id=$1', [a.memberId, b.showOnWall]); }));

  /* provider webhook (signed) + development sandbox that plays the provider */
  app.post('/api/webhooks/payments/:provider', async (req) => tx((db) => P.handleWebhook(db, req.rawBody ?? '', req.headers['x-signature'] as string | undefined, (req.params as any).provider)));
  if (config.env !== 'production') {
    app.post('/api/sandbox/complete/:id', async (req) => {
      const a = signedIn(req);
      const p = await one<any>(pool, 'SELECT * FROM payments WHERE id=$1 AND source=$2', [id(req), 'gateway']);
      if (p.member_id !== a.memberId && p.payer_name !== a.name) throw new AppError(403, 'forbidden', 'Not your payment.');
      const fx: Record<string, number> = { GHS: 1, USD: 15.6, GBP: 20.4 };
      const body = JSON.stringify({ eventId: 'evt_' + p.id, reference: p.external_ref, status: 'success', currency: p.currency, amount: p.amount_original, settlementRate: fx[p.currency] });
      return tx((db) => P.handleWebhook(db, body, hmacHex(config.webhookSecret, body), 'sandbox'));
    });
  }

  /* finance desk */
  app.get('/api/finance/queues', read((a) => P.queues(pool, a)));
  app.post('/api/finance/payments', write(P.ManualInput, (db, a, b) => P.recordManual(db, a, b)));
  app.post('/api/finance/payments/:id/verify', write(null, (db, a, _b, r) => P.verify(db, a, id(r))));
  app.post('/api/finance/payments/:id/reject', write(z.object({ reason: z.string().min(3) }), (db, a, b, r) => P.reject(db, a, id(r), b.reason)));
  app.post('/api/finance/payments/:id/assign', write(z.object({ memberNo: z.string() }), (db, a, b, r) => P.assignUnmatched(db, a, id(r), b.memberNo)));
  app.post('/api/finance/payments/:id/reversal-request', write(z.object({ reason: z.string().min(3) }), (db, a, b, r) => P.requestReversal(db, a, id(r), b.reason)));
  app.post('/api/finance/payments/:id/reversal-confirm', write(null, (db, a, _b, r) => P.confirmReversal(db, a, id(r))));
  app.post('/api/finance/payments/:id/reversal-decline', write(null, (db, a, _b, r) => P.declineReversal(db, a, id(r))));
  app.post('/api/finance/import', write(P.ImportInput, (db, a, b) => P.importOpening(db, a, b)));
  app.post('/api/finance/settlements', write(z.object({ provider: z.string().default('sandbox'), statementGhs: z.number().nonnegative() }), (db, a, b) => P.recordSettlement(db, a, b.provider, b.statementGhs)));
  app.get('/api/finance/ledger', read(async (a) => {
    need(a, 'fin.view', 'view the ledger');
    const recent = await q(pool, `SELECT t.effective_date, t.kind, t.memo, t.reversal_of, e.account, e.debit, e.credit FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.txn_id ORDER BY e.id DESC LIMIT 60`);
    return { trial: await trialBalance(pool), recent };
  }));
  app.get('/api/finance/report', read((a) => F.financeReport(pool, a)));
  app.get('/api/finance/settlements', read(async (a) => { need(a, 'fin.view', 'view settlements'); return q(pool, 'SELECT * FROM settlements ORDER BY created_at DESC'); }));

  /* payments out */
  app.get('/api/requests', read((a) => F.listRequests(pool, a)));
  app.post('/api/requests', write(F.RequestInput, (db, a, b) => F.createRequest(db, a, b)));
  app.post('/api/requests/:id/decision', write(z.object({ decision: z.enum(['approved', 'rejected']) }), (db, a, b, r) => F.decideRequest(db, a, id(r), b.decision)));
  app.post('/api/requests/:id/release', write(null, (db, a, _b, r) => F.releaseRequest(db, a, id(r))));
  app.post('/api/certificates', write(F.CertInput, (db, a, b) => F.createCertificate(db, a, b)));

  /* project */
  app.get('/api/project', read((a) => J.overview(pool, a)));
  app.post('/api/project/wp/:id/report', write(J.PctInput, (db, a, b, r) => J.reportProgress(db, a, id(r), b)));
  app.post('/api/project/wp/:id/verify', write(J.PctInput, (db, a, b, r) => J.verifyProgress(db, a, id(r), b)));
  app.post('/api/project/wp/:id/accept', write(J.AcceptInput, (db, a, b, r) => J.acceptProgress(db, a, id(r), b)));
  app.post('/api/project/defects/:id/close', write(J.DefectClose, (db, a, b, r) => J.closeDefect(db, a, id(r), b)));
  app.post('/api/project/variations', write(J.VariationInput, (db, a, b) => J.proposeVariation(db, a, b)));
  app.post('/api/project/variations/:id/decision', write(z.object({ approve: z.boolean() }), (db, a, b, r) => J.decideVariation(db, a, id(r), b.approve)));

  /* governance */
  app.get('/api/proposals', read((a) => G.listProposals(pool, a)));
  app.post('/api/proposals', write(G.ProposalInput, (db, a, b) => G.createProposal(db, a, b)));
  app.post('/api/proposals/:id/vote', write(z.object({ choice: z.enum(['yes', 'no', 'abstain']) }), (db, a, b, r) => G.castVote(db, a, id(r), b.choice)));
  app.post('/api/proposals/:id/close', write(null, (db, a, _b, r) => G.closeBallot(db, a, id(r))));

  /* legacy archive */
  app.get('/api/legacy', read((a) => L.archive(pool, a)));
  app.post('/api/legacy/handover/:id', write(L.ReceiveInput, (db, a, b, r) => L.receiveHandoverItem(db, a, id(r), b)));
  app.post('/api/legacy/maintenance/:id/log', write(L.LogInput, (db, a, b, r) => L.logMaintenance(db, a, Number(id(r)), b)));

  /* members */
  app.get('/api/members', read((a, req) => { const x = req.query as any; return M.directory(pool, a, x.q ?? '', x.house ?? '', Number(x.page ?? 0)); }));
  app.post('/api/members', write(M.RegisterInput, (db, a, b) => M.registerMember(db, a, b)));
  app.post('/api/members/:id/verify', write(null, (db, a, _b, r) => M.verifyMember(db, a, id(r))));
  app.post('/api/members/:id/house', write(M.HouseFix, (db, a, b, r) => M.correctHouse(db, a, id(r), b)));

  /* notifications & audit */
  app.get('/api/notifications', read(async (a) => {
    const house = a.memberId ? (await q<any>(pool, 'SELECT house_id FROM house_memberships WHERE member_id=$1 AND valid_to IS NULL', [a.memberId]))[0]?.house_id : null;
    return q(pool, `SELECT * FROM notifications WHERE audience = ANY($1) ORDER BY created_at DESC LIMIT 50`,
      [[...(a.memberId ? ['all', 'member:' + a.memberId] : []), ...(house ? ['house:' + house] : []), ...[...perms(a)].map((p) => 'perm:' + p)]]);
  }));
  app.get('/api/audit', read(async (a) => { need(a, 'audit.view', 'view the audit trail'); return q(pool, 'SELECT seq, at, actor_label, action, target, detail, hash FROM audit_events ORDER BY seq DESC LIMIT 200'); }));
  app.get('/api/audit/verify', read(async (a) => { need(a, 'audit.view', 'check the audit trail'); return verifyAuditChain(pool); }));

  app.get('/api/health', async () => { await pool.query('SELECT 1'); return { ok: true }; });

  // Serve the built web app (one deployable service). Unknown non-API paths fall back to index.html.
  const webDist = process.env.WEB_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not_found', message: 'No such endpoint.' }) : reply.sendFile('index.html'));
  }
  return app;
}
export type App = Awaited<ReturnType<typeof buildApp>>;
export type Reply = FastifyReply;
