'use strict';
const { items } = require('../streamlabs-events');
const state = require('./qss-state');
const { safePhoto, resolvePhoto } = require('./supporter-photos');

function startAutomation({ connect, interval = setInterval, cancel = clearInterval } = {}) {
  const io = connect || require('socket.io-client');
  let socket = null, activeToken = '', refreshing = false, syncing = false, stopped = false;
  async function connection(status) { try { await state.ingestEvent({ kind: 'connection', status }); } catch {} }
  async function refresh() {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      const config = await state.readConfig();
      const token = config.automationEnabled !== false ? config.streamlabsToken || '' : '';
      if (token === activeToken && (socket || !token)) return;
      activeToken = token;
      if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
      if (!token) { await connection('disconnected'); return; }
      socket = io('https://sockets.streamlabs.com', { query: { token }, transports: ['websocket'], reconnection: true, reconnectionDelay: 1500, reconnectionDelayMax: 10000 });
      socket.on('connect', () => connection('connected'));
      socket.on('disconnect', () => connection('disconnected'));
      socket.on('connect_error', () => connection('error'));
      socket.on('event', event => {
        for (const item of items(event)) state.ingestEvent(item).then(async () => {
          if (!safePhoto(item.avatarUrl) && item.channelId) {
            const config = await state.readConfig();
            const avatarUrl = await resolvePhoto(item.channelId, config.youtubeApiKey);
            if (avatarUrl) await state.applyAction({ action: 'supporterPhoto', channelId: item.channelId, avatarUrl });
          }
        }).catch(() => {});
      });
    } catch { await connection('error'); }
    finally { refreshing = false; }
  }
  async function syncSubscribers() {
    if (syncing || stopped) return;
    syncing = true;
    try {
      const config = await state.readConfig();
      if (config.youtubeSyncEnabled !== false && config.youtubeApiKey) await state.syncYoutube();
    } catch {}
    finally { syncing = false; }
  }
  const ready = Promise.all([refresh(), syncSubscribers()]);
  const timers = [interval(refresh, 10000), interval(syncSubscribers, 30000)];
  return { ready, refresh, syncSubscribers, stop() {
    stopped = true; timers.forEach(cancel);
    if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
  } };
}
module.exports = { startAutomation };
