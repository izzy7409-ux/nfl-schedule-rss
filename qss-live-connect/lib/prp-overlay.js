'use strict';
const state = require('./qss-state');
const storage = require('./storage');
const SETTINGS = 'prp-overlay/display.json';
const RUNDOWN = 'prp-overlay/rundown.json';
const defaults = { accent: '#9271d6', subsTarget: 10000, showSupporters: true, showGoal: true, showTicker: true };
const defaultTicker = 'WELCOME TO THE PURPLE REIGN PODCAST, YOUR #1 SOURCE FOR BALTIMORE RAVENS NEWS AND DISCUSSIONS. LIKE THE VIDEO IF YOU ENJOY THE CONTENT! ALL SUPERCHATS/SUBS/MEMBERSHIPS ANNOUNCED LIVE ON THE SHOW!';
const fallback = { displayTitle: 'PURPLE REIGN PODCAST', displayLabel: 'LIVE DISCUSSION', logoText: 'PURPLE REIGN PODCAST', ticker: defaultTicker, mode: 'discussion', visible: true };

function displaySettings(value = {}) {
  return {
    accent: /^#[0-9a-f]{6}$/i.test(value.accent || '') ? value.accent : defaults.accent,
    subsTarget: Math.max(1, Math.trunc(Number(value.subsTarget) || defaults.subsTarget)),
    showSupporters: value.showSupporters !== false,
    showGoal: value.showGoal !== false,
    showTicker: value.showTicker !== false
  };
}
async function readJson(name) {
  const result = await storage.get(name);
  return result ? JSON.parse(await new Response(result.stream).text()) : null;
}
function createPrpOverlay({ fetchImpl = fetch, upstreamOrigin = process.env.PRP_REMOTE_ORIGIN || 'https://ravens-live-tracker-production.up.railway.app', readShared = state.readState, sharedAction = state.applyAction } = {}) {
  let settings, rundown, initialized, refreshing, writes = Promise.resolve();
  async function initialize() {
    initialized ||= Promise.all([readJson(SETTINGS), readJson(RUNDOWN)]).then(([saved, cached]) => {
      settings = displaySettings(saved || defaults);
      rundown = cached || { ...fallback };
    });
    return initialized;
  }
  async function refresh() {
    await initialize();
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const response = await fetchImpl(new URL('/api/lower-third-state', upstreamOrigin), { cache: 'no-store', signal: AbortSignal.timeout(3000) });
        if (!response.ok) return;
        const data = await response.json();
        if (!data.ok || !data.state || typeof data.state !== 'object') return;
        const s = data.state;
        const next = {
          displayTitle: String(s.displayTitle || ''), displayLabel: String(s.displayLabel || s.label || 'LIVE DISCUSSION'),
          logoText: String(s.logoText || 'PURPLE REIGN PODCAST'), ticker: String(s.ticker || defaultTicker),
          mode: s.mode === 'breaking' ? 'breaking' : 'discussion', visible: s.visible !== false
        };
        if (JSON.stringify(next) !== JSON.stringify(rundown)) {
          rundown = next;
          await storage.put(RUNDOWN, JSON.stringify(rundown));
        }
      } catch { /* Keep the last saved PRP rundown when its service reconnects. */ }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function readState({ refreshRundown = true } = {}) {
    await initialize();
    if (refreshRundown) await refresh();
    const shared = await readShared();
    return {
      ...settings, show: 'prp', visible: rundown.visible, mode: rundown.mode,
      logoText: rundown.logoText, topicLabel: rundown.displayLabel, topic: rundown.displayTitle,
      tickerItems: [rundown.ticker], subsCurrent: shared.subsCurrent,
      percent: Math.max(0, Math.min(100, shared.subsCurrent / settings.subsTarget * 100)),
      supporters: shared.supporters || [], superChats: shared.superChats || [],
      automationStatus: shared.automationStatus || {}
    };
  }
  function applyAction(body = {}) {
    const run = writes.catch(() => {}).then(async () => {
      await initialize();
      if (body.action === 'saveDisplay') {
        settings = displaySettings({ ...settings, ...Object.fromEntries(['accent', 'showSupporters', 'showGoal', 'showTicker'].filter(key => key in body).map(key => [key, body[key]])) });
        await storage.put(SETTINGS, JSON.stringify(settings));
      } else if (body.action === 'saveGoal') {
        const target = Number(body.subsTarget);
        if (!Number.isSafeInteger(target) || target < 1) throw new Error('Enter a positive subscriber goal.');
        settings = displaySettings({ ...settings, subsTarget: target });
        await storage.put(SETTINGS, JSON.stringify(settings));
      } else if (['setExactSubscribers', 'subscriberDelta', 'addSupporter', 'removeSupporter', 'clearSupporters'].includes(body.action)) {
        await sharedAction(body);
      } else {
        throw new Error('Unknown PRP display action.');
      }
      return readState({ refreshRundown: false });
    });
    writes = run;
    return run;
  }
  return { readState, refresh, applyAction };
}
module.exports = { createPrpOverlay, displaySettings };
