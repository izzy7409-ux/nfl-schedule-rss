'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRemote } = require('../lib/prp-remote');

function response() {
  return { statusCode: 200, headers: {}, output: '', headersSent: false,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers); this.headersSent = true; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.output = JSON.stringify(value); return this; },
    redirect(code, target) { this.statusCode = code; this.headers.Location = target; },
    write(chunk) { this.output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(); },
    end(chunk = '') { this.output += chunk; this.ended = true; }
  };
}
function fixture() {
  const requests = [];
  let clock = 1800000000000;
  const remote = createRemote({ origin: 'https://qss.example', upstreamOrigin: 'https://prp.example', prpKey: 'private-prp-test-key', qssKey: 'private-qss-test-key', encryptionKey: Buffer.alloc(32, 4).toString('base64'), now: () => clock,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      const pathname = new URL(url).pathname;
      if (pathname === '/lower-third-control') return new Response('<h1>PRP Remote</h1>');
      if (pathname === '/api/lower-third-stream') return new Response('data: {"ok":true,"state":{"displayTitle":"Live PRP topic"}}\n\n');
      return new Response(JSON.stringify({ ok: true, state: { displayTitle: 'Live PRP topic' } }), { headers: { 'Content-Type': 'application/json' } });
    }
  });
  async function request(path, { method = 'GET', headers = {}, body = {} } = {}) {
    const req = Object.assign(new EventEmitter(), { method, headers, body }), res = response();
    await remote.handle(req, res, new URL(path, 'https://qss.example'), async () => body);
    return res;
  }
  return { request, requests, setClock: value => { clock = value; } };
}
async function unlock(f) {
  const res = await f.request('/lower-third-control?key=private-qss-test-key');
  return res.headers['Set-Cookie'].split(';')[0];
}

test('the combined remote protects both tabs and never exposes the PRP service credential', async () => {
  const f = fixture();
  const anonymous = await f.request('/lower-third-control');
  assert.match(anonymous.output, /existing private PRP or QSS remote link/);
  assert.ok(!anonymous.output.includes('private-qss-test-key'));
  assert.ok(!anonymous.output.includes('qss-remote-frame'));
  assert.equal(f.requests.length, 0);
  const cookie = await unlock(f);
  const authenticated = await f.request('/lower-third-control', { headers: { cookie } });
  assert.match(authenticated.output, /role="tablist"/);
  assert.match(authenticated.output, /PRP Lower Third/);
  assert.match(authenticated.output, /id="qss-tab"/);
  assert.match(authenticated.output, /https:\/\/qss.example\/qss-control\?key=private-qss-test-key/);
  assert.ok(!authenticated.output.includes('private-prp-test-key'));
  assert.match(cookie, /^__Host-prp_remote=/);
});

test('login removes the private link from the browser URL and sessions expire', async () => {
  const f = fixture();
  const login = await f.request('/lower-third-control/login', { method: 'POST', headers: { origin: 'https://qss.example' }, body: { remoteLink: 'https://prp.example/lower-third-control?key=private-prp-test-key' } });
  assert.equal(login.statusCode, 303); assert.equal(login.headers.Location, '/lower-third-control');
  assert.match(login.headers['Set-Cookie'], /Secure; HttpOnly; SameSite=Lax/);
  assert.ok(!login.headers['Set-Cookie'].includes('private-prp-test-key'));
  const cookie = login.headers['Set-Cookie'].split(';')[0];
  f.setClock(1800000000000 + 43200001);
  const expired = await f.request('/lower-third-control', { headers: { cookie } });
  assert.ok(!expired.output.includes('qss-remote-frame'));
});

test('login refuses cross-origin and opaque-origin form submissions', async () => {
  const f = fixture();
  for (const origin of ['https://other.example', 'null']) {
    const denied = await f.request('/lower-third-control/login', { method: 'POST', headers: { origin }, body: { remoteLink: 'private-qss-test-key' } });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.headers['Set-Cookie'], undefined);
  }
  assert.equal(f.requests.length, 0);
});

test('PRP actions keep using the existing backend and require the authenticated remote', async () => {
  const f = fixture(), cookie = await unlock(f);
  const denied = await f.request('/api/lower-third-control', { method: 'POST', body: { action: 'next' } });
  assert.equal(denied.statusCode, 403);
  const before = f.requests.length;
  const crossOrigin = await f.request('/api/lower-third-control', { method: 'POST', headers: { cookie, origin: 'https://other.example' }, body: { action: 'next' } });
  assert.equal(crossOrigin.statusCode, 403); assert.equal(f.requests.length, before);
  const allowed = await f.request('/api/lower-third-control', { method: 'POST', headers: { cookie, origin: 'https://qss.example' }, body: { action: 'setCurrent', index: 6 } });
  assert.equal(allowed.statusCode, 200);
  const forwarded = f.requests.at(-1);
  assert.equal(forwarded.url, 'https://prp.example/api/lower-third-control');
  assert.equal(forwarded.options.headers['x-control-key'], 'private-prp-test-key');
  assert.deepEqual(JSON.parse(forwarded.options.body), { action: 'setCurrent', index: 6 });
  assert.ok(!allowed.output.includes('private-prp-test-key'));
});

test('PRP state and live updates reach the combined remote without changing its data', async () => {
  const f = fixture(), cookie = await unlock(f);
  const state = await f.request('/api/lower-third-state', { headers: { cookie } });
  assert.equal(JSON.parse(state.output).state.displayTitle, 'Live PRP topic');
  const stream = await f.request('/api/lower-third-stream', { headers: { cookie } });
  assert.equal(stream.headers['Content-Type'], 'text/event-stream');
  assert.match(stream.output, /Live PRP topic/); assert.equal(stream.ended, true);
});
