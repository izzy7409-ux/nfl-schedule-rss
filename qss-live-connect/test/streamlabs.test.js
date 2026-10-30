'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createAuth, encrypt, decrypt } = require('../lib/streamlabs-auth');
const { makeControlHandler, makeCallbackHandler } = require('../lib/streamlabs-http');
const { items } = require('../streamlabs-events');

function fixture(overrides = {}) {
  let saved = {}, clock = 1800000000000, randomCount = 0;
  const requests = [], activated = [], deactivated = [];
  const store = { read: async () => structuredClone(saved), write: async value => { saved = structuredClone(value); } };
  const auth = createAuth({ store, origin: 'https://qss.example', now: () => clock,
    random: size => Buffer.alloc(size, ++randomCount),
    activate: async value => activated.push(value), deactivate: async () => deactivated.push(true),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => url.endsWith('/token') && !url.endsWith('/socket/token') ? { access_token: 'test-access-token', refresh_token: 'test-refresh-token' } : { socket_token: 'test-socket-token' } };
    }, ...overrides
  });
  return { auth, requests, activated, deactivated, get: () => saved, setClock: value => { clock = value; } };
}
async function registered(f) { await f.auth.configure({ clientId: 'test-client', clientSecret: 'test-client-secret' }); }
function callback(begin) { return { query: { state: new URL(begin.authorizationUrl).searchParams.get('state'), code: 'test-code' }, cookie: begin.cookie.split(';')[0] }; }
function response() {
  return { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; }, redirect(code, url) { this.statusCode = code; this.location = url; return this; }, end() { return this; } };
}

test('saved credentials are authenticated encrypted data', () => {
  const key = crypto.randomBytes(32).toString('base64'), secret = { clientSecret: 'test-secret', accessToken: 'test-token' };
  const sealed = encrypt(secret, key);
  assert.deepEqual(decrypt(sealed, key), secret);
  assert.ok(!JSON.stringify(sealed).includes(secret.clientSecret));
  const damaged = { ...sealed, data: Buffer.from('tampered').toString('base64') };
  assert.throws(() => decrypt(damaged, key));
  assert.throws(() => encrypt(secret, 'missing-key'));
});

test('OAuth requests only live-event access and exchanges one bound code', async () => {
  const f = fixture(); await registered(f);
  const begin = await f.auth.begin(), url = new URL(begin.authorizationUrl), cb = callback(begin);
  assert.equal(url.origin, 'https://streamlabs.com');
  assert.equal(url.searchParams.get('scope'), 'socket.token');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://qss.example/api/streamlabs-callback');
  assert.match(begin.cookie, /Secure; HttpOnly; SameSite=Lax/);
  assert.ok(!begin.authorizationUrl.includes('test-client-secret'));
  const result = await f.auth.complete(cb.query, cb.cookie);
  assert.deepEqual(f.activated, ['test-socket-token']);
  assert.equal(f.requests.length, 2);
  assert.equal(new URLSearchParams(f.requests[0].options.body).get('code'), 'test-code');
  assert.equal(f.requests[1].options.headers.Authorization, 'Bearer test-access-token');
  assert.match(result.cookie, /Max-Age=0/);
  const status = await f.auth.status();
  assert.equal(status.authorized, true);
  assert.equal(status.includeFreeSubscribers, true);
  assert.ok(!JSON.stringify(status).includes('test-access-token'));
  assert.ok(!JSON.stringify(status).includes('test-client-secret'));
  await assert.rejects(f.auth.complete(cb.query, cb.cookie), /expired|another browser/);
  assert.equal(f.requests.length, 2);
});

test('invalid state and a different browser never exchange a token', async () => {
  const f = fixture(); await registered(f);
  const begin = await f.auth.begin(), cb = callback(begin);
  await assert.rejects(f.auth.complete({ ...cb.query, state: 'wrong-state' }, cb.cookie));
  await assert.rejects(f.auth.complete(cb.query, '__Host-qss_streamlabs_oauth=wrong-browser'));
  assert.equal(f.requests.length, 0);
  f.setClock(1800000000000 + 600001);
  await assert.rejects(f.auth.complete(cb.query, cb.cookie));
  assert.equal(f.requests.length, 0);
});

test('declining OAuth does not activate or retain the pending link', async () => {
  const f = fixture(); await registered(f);
  const cb = callback(await f.auth.begin());
  await assert.rejects(f.auth.complete({ ...cb.query, error: 'access_denied' }, cb.cookie), /not approved/);
  assert.equal(f.get().pending, undefined);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.auth.status()).authorized, false);
});

test('saving settings keeps the hidden secret and replacing credentials disconnects', async () => {
  const f = fixture(); await registered(f);
  const cb = callback(await f.auth.begin()); await f.auth.complete(cb.query, cb.cookie);
  await f.auth.configure({ clientId: 'test-client', clientSecret: '' });
  assert.equal((await f.auth.status()).authorized, true);
  await f.auth.configure({ clientId: 'different-client', clientSecret: 'different-test-secret' });
  assert.equal((await f.auth.status()).authorized, false);
  assert.equal(f.deactivated.length, 1);
});

test('disconnect clears account tokens while preserving the registered app', async () => {
  const f = fixture(); await registered(f);
  const cb = callback(await f.auth.begin()); await f.auth.complete(cb.query, cb.cookie);
  const status = await f.auth.disconnect();
  assert.equal(status.authorized, false); assert.equal(status.applicationConfigured, true);
  assert.equal(f.get().accessToken, undefined); assert.equal(f.get().refreshToken, undefined);
  assert.equal(f.deactivated.length, 1);
});

test('provider failures do not expose the returned body or credentials', async () => {
  const f = fixture({ fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'secret-provider-response' }) });
  await registered(f); const cb = callback(await f.auth.begin());
  await assert.rejects(f.auth.complete(cb.query, cb.cookie), error => !error.message.includes('secret-provider-response') && /did not approve/.test(error.message));
  assert.equal(f.activated.length, 0);
});

test('private controls reject missing authorization and cross-origin writes', async () => {
  const original = process.env.QSS_CONTROL_SECRET; process.env.QSS_CONTROL_SECRET = 'test-admin-key';
  try {
    const f = fixture(), handle = makeControlHandler(f.auth);
    const anonymous = response(); await handle({ method: 'GET', headers: {}, query: {} }, anonymous);
    assert.equal(anonymous.statusCode, 403);
    const crossOrigin = response();
    await handle({ method: 'POST', headers: { 'x-control-key': 'test-admin-key', origin: 'https://other.example' }, query: {}, body: { action: 'configure', clientId: 'test-client', clientSecret: 'test-secret' } }, crossOrigin);
    assert.equal(crossOrigin.statusCode, 403); assert.deepEqual(f.get(), {});
    const allowed = response();
    await handle({ method: 'POST', headers: { 'x-control-key': 'test-admin-key', origin: 'https://qss.example' }, query: {}, body: { action: 'configure', clientId: 'test-client', clientSecret: 'test-secret' } }, allowed);
    assert.equal(allowed.statusCode, 200); assert.equal(allowed.body.applicationConfigured, true);
    assert.equal(allowed.headers['Cache-Control'], 'no-store');
  } finally { if (original === undefined) delete process.env.QSS_CONTROL_SECRET; else process.env.QSS_CONTROL_SECRET = original; }
});

test('callback responses remove authorization codes from the final URL', async () => {
  const f = fixture(); await registered(f); const cb = callback(await f.auth.begin());
  const res = response(); await makeCallbackHandler(f.auth)({ method: 'GET', headers: { cookie: cb.cookie }, query: cb.query }, res);
  assert.equal(res.statusCode, 303); assert.equal(res.location, '/streamlabs-result.html?status=connected');
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
  const invalid = response(); await makeCallbackHandler(f.auth)({ method: 'GET', headers: {}, query: cb.query }, invalid);
  assert.equal(invalid.location, '/streamlabs-result.html?status=error');
});

test('the sign-in form authenticates through its body without putting the control key in the URL', async () => {
  const original = process.env.QSS_CONTROL_SECRET; process.env.QSS_CONTROL_SECRET = 'test-admin-key';
  try {
    const f = fixture(); await registered(f);
    const res = response();
    await makeControlHandler(f.auth)({ method: 'POST', query: { action: 'connect' }, headers: { origin: 'https://qss.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'controlKey=test-admin-key' }, res);
    assert.equal(res.statusCode, 303);
    assert.equal(new URL(res.location).origin, 'https://streamlabs.com');
    assert.ok(!res.location.includes('test-admin-key'));
    assert.match(res.headers['Set-Cookie'], /HttpOnly/);
  } finally { if (original === undefined) delete process.env.QSS_CONTROL_SECRET; else process.env.QSS_CONTROL_SECRET = original; }
});

test('free YouTube subscribers and members have distinct labels', () => {
  const free = items({ for: 'youtube_account', type: 'follow', event_id: 'subscriber-event', message: [{ name: 'Rain Gang Viewer' }] });
  assert.equal(free[0].kind, 'subscriber'); assert.equal(free[0].label, 'NEW SUB');
  const member = items({ for: 'youtube_account', type: 'subscription', message: [{ name: 'Member', months: 3, _id: 'member-event' }] });
  assert.equal(member[0].label, 'NEW MEMBER'); assert.equal(member[0].value, '3 MONTHS');
});

test('Super Chats use micros while tips use decimal currency', () => {
  const superchat = items({ for: 'youtube_account', type: 'superchat', message: [{ name: 'Viewer', amount: '2000000', currency: 'USD' }] });
  assert.equal(superchat[0].value, '$2.00');
  const donation = items({ type: 'donation', message: [{ name: 'Tipper', amount: '13.37', currency: 'USD' }] });
  assert.equal(donation[0].value, '$13.37');
  const formatted = items({ for: 'youtube_account', type: 'superchat', message: [{ name: 'Viewer', displayString: '£5.00', amount: '5000000' }] });
  assert.equal(formatted[0].value, '£5.00');
});

test('batched event IDs are distinct and repeated deliveries stay stable', () => {
  const ev = { for: 'youtube_account', type: 'follow', event_id: 'batch', message: [{ name: 'One' }, { name: 'Two' }] };
  const first = items(ev), second = items(ev);
  assert.equal(first.length, 2); assert.notEqual(first[0].eventId, first[1].eventId);
  assert.deepEqual(first.map(x => x.eventId), second.map(x => x.eventId));
  assert.deepEqual(items({ for: 'twitch_account', type: 'follow', message: [{ name: 'Twitch Viewer' }] }), []);
  assert.deepEqual(items({ for: 'youtube_account', type: 'follow', message: [{}] }), []);
});
