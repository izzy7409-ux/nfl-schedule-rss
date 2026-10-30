'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function encryptedConfig(value, controlKey) {
  const key = crypto.createHash('sha256').update(controlKey).digest(), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
async function start(directory, seedCount = 4321) {
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: '0', QSS_DATA_DIR: directory, QSS_DISABLE_AUTOMATION: '1', QSS_CONTROL_SECRET: 'test-control', QSS_BRIDGE_SECRET: 'test-bridge', QSS_STREAMLABS_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'), QSS_INITIAL_STATE_JSON: JSON.stringify({ topic: 'Migration topic', subsCurrent: seedCount, supporters: [] }), QSS_INITIAL_CONFIG_JSON: JSON.stringify(encryptedConfig({ streamlabsToken: 'test-socket-token', youtubeApiKey: 'test-youtube-key', youtubeChannelId: 'test-channel', liveKey: 'test-live', automationEnabled: true, youtubeSyncEnabled: true }, 'test-control')) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const address = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('QSS did not start')); }, 10000);
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/listening on (\d+)/); if (match) { clearTimeout(timeout); resolve('http://127.0.0.1:' + match[1]); } });
    child.once('exit', code => { clearTimeout(timeout); if (!output.includes('listening on ')) reject(new Error('QSS exited before listening: ' + code)); });
  });
  return { child, address, stop: () => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill('SIGTERM'); }) };
}

test('Railway migration preserves encrypted settings and state across restarts and pushes changes live', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qss-railway-'));
  let app, controller;
  try {
    app = await start(directory);
    const health = await (await fetch(app.address + '/health')).json();
    assert.equal(health.storage, 'railway');
    assert.equal((await fetch(app.address + '/api/automation-config')).status, 403);
    assert.equal((await fetch(app.address + '/lib/qss-state.js')).status, 404);
    const config = await (await fetch(app.address + '/api/automation-config?key=test-control')).json();
    assert.equal(config.streamlabsConfigured, true); assert.equal(config.youtubeConfigured, true);
    assert.ok(!JSON.stringify(config).includes('test-socket-token'));
    const legacyConfig = await (await fetch(app.address + '/api/stream-config?liveKey=test-live')).json();
    assert.equal(legacyConfig.serverManaged, true); assert.equal(legacyConfig.streamlabsToken, '');
    const before = await (await fetch(app.address + '/api/state')).json();
    assert.equal(before.state.subsCurrent, 4321);
    controller = new AbortController();
    const stream = await fetch(app.address + '/api/events', { signal: controller.signal });
    const reader = stream.body.getReader(), decoder = new TextDecoder();
    assert.match(decoder.decode((await reader.read()).value), /Migration topic/);
    const saved = await (await fetch(app.address + '/api/control?key=test-control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'addSupporter', name: 'Test Gifter', type: 'GIFTED MEMBERS', value: '5 GIFTS' }) })).json();
    assert.equal(saved.state.supporters[0].value, '5 GIFTS');
    assert.match(decoder.decode((await reader.read()).value), /Test Gifter/);
    controller.abort();
    const settings = await fs.readFile(path.join(directory, 'qss-overlay/config.enc.json'), 'utf8');
    assert.ok(!settings.includes('test-socket-token')); assert.ok(!settings.includes('test-youtube-key'));
    assert.equal((await fs.stat(path.join(directory, 'qss-overlay/config.enc.json'))).mode & 0o777, 0o600);
    await app.stop();
    app = await start(directory, 9999);
    const after = await (await fetch(app.address + '/api/state')).json();
    assert.equal(after.state.subsCurrent, 4321); assert.equal(after.state.supporters[0].name, 'Test Gifter');
    assert.equal(await fs.readFile(path.join(directory, 'qss-overlay/config.enc.json'), 'utf8'), settings);
  } finally { controller?.abort(); await app?.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('the server listens for Streamlabs events without a browser and reconnects only when settings change', async () => {
  const source = await fs.readFile(path.join(root, 'lib/automation.js'), 'utf8');
  const exported = { exports: {} }, received = [], sockets = [], intervals = [], cancelled = [];
  let settings = { streamlabsToken: 'test-first-token', automationEnabled: true, youtubeApiKey: 'test-youtube-key', youtubeSyncEnabled: true }, youtubeSyncs = 0;
  const fakeState = { readConfig: async () => settings, ingestEvent: async item => received.push(item), syncYoutube: async () => { youtubeSyncs++; } };
  vm.runInNewContext(source, { module: exported, require: name => name === './qss-state' ? fakeState : require(path.resolve(root, 'streamlabs-events.js')), setInterval, clearInterval });
  const automation = exported.exports.startAutomation({
    connect: (url, options) => { const socket = new EventEmitter(); socket.disconnect = () => { socket.closed = true; }; sockets.push({ url, options, socket }); return socket; },
    interval: fn => { intervals.push(fn); return intervals.length; }, cancel: id => cancelled.push(id)
  });
  await automation.ready;
  assert.equal(sockets.length, 1); assert.equal(youtubeSyncs, 1);
  sockets[0].socket.emit('connect');
  sockets[0].socket.emit('event', { for: 'youtube_account', type: 'membershipGift', message: [{ name: 'Gifter', amount: 5, _id: 'gift-event' }] });
  await new Promise(setImmediate);
  assert.equal(received.find(item => item.name === 'Gifter').value, '5 GIFTS');
  assert.equal(received.find(item => item.kind === 'connection').status, 'connected');
  await automation.refresh(); assert.equal(sockets.length, 1);
  settings = { ...settings, streamlabsToken: 'test-second-token' };
  await automation.refresh();
  assert.equal(sockets[0].socket.closed, true); assert.equal(sockets.length, 2);
  assert.equal(sockets[1].options.query.token, 'test-second-token');
  automation.stop(); assert.equal(sockets[1].socket.closed, true); assert.deepEqual(cancelled, [1, 2]);
});
