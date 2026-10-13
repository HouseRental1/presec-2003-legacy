// Vercel entrypoint (zero-config Fastify). Vercel detects the framework from this file's import of
// 'fastify'. The compiled API lives in server/dist; the built web app is served from /public by
// Vercel's CDN, and vercel.json sends app routes to index.html.
import 'fastify';
import { buildApp } from './server/dist/app.js';

const app = await buildApp();
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
