const http = require('http');
const { URL } = require('url');
const confidence = require('./confidence');
const pickem = require('./pickem');
const pickTracker = require('./pick-tracker');

const originalCreateServer = http.createServer;

function wrapListener(listener) {
  return async function liveToolsAwareListener(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (await pickTracker.handle(req, res, url)) return;
      if (await pickem.handle(req, res, url)) return;
      if (await confidence.handle(req, res, url)) return;
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: err?.message || 'PRP live tools error' }));
        return;
      }
    }
    return listener(req, res);
  };
}

http.createServer = function patchedCreateServer(optionsOrListener, maybeListener) {
  if (typeof optionsOrListener === 'function') {
    return originalCreateServer.call(http, wrapListener(optionsOrListener));
  }
  if (typeof maybeListener === 'function') {
    return originalCreateServer.call(http, optionsOrListener, wrapListener(maybeListener));
  }
  return originalCreateServer.call(http, optionsOrListener, maybeListener);
};
