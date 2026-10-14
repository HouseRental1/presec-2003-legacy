// Vercel entrypoint (zero-config Fastify). Vercel detects the framework from this file's import of
// 'fastify'. We export a plain (req, res) handler: Vercel calls it for every request, and Fastify
// serves both the API and the built web app (web/dist). Do not call app.listen() here — on Vercel
// listen() is intercepted and never resolves, which would hang every request.
import 'fastify';
import { buildApp } from './server/dist/app.js';

const app = await buildApp();
await app.ready();

export default function handler(req, res) {
  app.server.emit('request', req, res);
}
