'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const state = require('./lib/qss-state');
const storage = require('./lib/storage');
const { startAutomation } = require('./lib/automation');
const { createRemote } = require('./lib/prp-remote');
const staticFiles = new Map([
  ['/qss-overlay', ['qss-overlay.html', 'text/html']],
  ['/qss-overlay.html', ['qss-overlay.html', 'text/html']],
  ['/qss-control', ['qss-control.html', 'text/html']],
  ['/qss-control.html', ['qss-control.html', 'text/html']],
  ['/streamlabs-events.js', ['streamlabs-events.js', 'text/javascript']],
  ['/streamlabs-result.html', ['streamlabs-result.html', 'text/html']]
]);
const handlers = new Map(['automation-config', 'automation-sync', 'bridge', 'control', 'ingest', 'state', 'stream-config', 'streamlabs', 'streamlabs-callback', 'sync-youtube'].map(name => ['/api/' + name, require('./api/' + name)]));

function responseHelpers(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); return res; };
  res.redirect = (code, target) => { res.statusCode = code; res.setHeader('Location', target); res.end(); return res; };
}
async function body(req) {
  let content = '';
  for await (const part of req) {
    content += part;
    if (Buffer.byteLength(content) > 64000) throw new Error('Request too large.');
  }
  if (!content) return {};
  if (String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(content));
  return JSON.parse(content);
}
async function main() {
  if (!process.env.QSS_CONTROL_SECRET || !process.env.QSS_STREAMLABS_ENCRYPTION_KEY) throw new Error('Private QSS settings are required.');
  await storage.seed();
  await state.readState();
  const clients = new Set();
  const prpRemote = createRemote();
  const broadcast = async name => {
    if (name !== 'qss-overlay/state.json') return;
    try {
      const data = 'data: ' + JSON.stringify({ ok: true, state: state.publicState(await state.readState()) }) + '\n\n';
      for (const client of clients) client.write(data);
    } catch {}
  };
  storage.events.on('change', broadcast);
  const automation = process.env.QSS_DISABLE_AUTOMATION === '1' ? null : startAutomation();
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 15000);
  const server = http.createServer(async (req, res) => {
    responseHelpers(res);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Keep private URL paths and keys out of referrers while preserving the
    // browser's Origin header for same-origin form submissions.
    res.setHeader('Referrer-Policy', 'strict-origin');
    try {
      const url = new URL(req.url, 'http://localhost');
      req.query = Object.fromEntries(url.searchParams);
      if (await prpRemote.handle(req, res, url, body)) return;
      if (url.pathname === '/health') return res.json({ ok: true, service: 'Quiet Storm Sports', storage: 'railway' });
      if (url.pathname === '/') return res.redirect(302, '/qss-overlay');
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        clients.add(res);
        req.on('close', () => clients.delete(res));
        res.write('data: ' + JSON.stringify({ ok: true, state: state.publicState(await state.readState()) }) + '\n\n');
        return;
      }
      if (staticFiles.has(url.pathname) && ['GET', 'HEAD'].includes(req.method)) {
        const [file, type] = staticFiles.get(url.pathname);
        res.setHeader('Content-Type', type + '; charset=utf-8');
        return res.end(req.method === 'HEAD' ? '' : await fs.readFile(path.join(__dirname, file)));
      }
      const handler = handlers.get(url.pathname);
      if (!handler) return res.status(404).json({ ok: false, error: 'Not found' });
      req.body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await body(req) : {};
      return await handler(req, res);
    } catch {
      if (!res.headersSent) return res.status(400).json({ ok: false, error: 'The request could not be completed.' });
      res.end();
    }
  });
  await new Promise(resolve => server.listen(Number(process.env.PORT || 3000), '0.0.0.0', resolve));
  console.log('Quiet Storm Sports listening on ' + server.address().port);
  async function stop() {
    automation?.stop(); clearInterval(heartbeat); storage.events.off('change', broadcast);
    for (const client of clients) client.end();
    server.close();
  }
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return { server, stop };
}
if (require.main === module) main().catch(() => { console.error('QSS could not start. Check the service configuration.'); process.exitCode = 1; });
module.exports = { main };
