const fs = require('fs');
const path = require('path');

const CONFIDENCE_HTML = fs.readFileSync(path.join(__dirname, 'confidence.html'), 'utf8');
const CONTROL_HTML = fs.readFileSync(path.join(__dirname, 'confidence-control.html'), 'utf8');
const YT_BASE = 'https://www.googleapis.com/youtube/v3';
const ESPN_SCHEDULE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/33/schedule';
const CONTROL_SECRET = process.env.CONFIDENCE_CONTROL_SECRET || '';

const clients = new Set();
const state = {
  apiKey: process.env.YOUTUBE_API_KEY || '',
  videoId: '',
  videoTitle: '',
  liveChatId: '',
  connected: false,
  connectionMode: '',
  votingOpen: false,
  activeMode: 'preview',
  lastError: '',
  nextPageToken: '',
  pollTimer: null,
  pollingIntervalMs: 5000,
  armedVideoId: '',
  armedVideoTitle: '',
  armedAt: '',
  armTimer: null,
  armPollingIntervalMs: 30000,
  votesByMode: {
    preview: new Map(),
    performance: new Map(),
  },
  matchup: null,
  performance: null,
  ravensContextUpdatedAt: 0,
};

function json(res, code, obj, extra = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control':'no-store', ...extra });
  res.end(JSON.stringify(obj));
}
function html(res, code, body) {
  res.writeHead(code, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
  res.end(body);
}
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 200000) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function authorized(url, req) {
  if (!CONTROL_SECRET) return true;
  return (url.searchParams.get('key') || '') === CONTROL_SECRET || String(req.headers['x-control-key'] || '') === CONTROL_SECRET;
}
function extractVideoId(input = '') {
  const s = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.includes('youtu.be')) return u.pathname.split('/').filter(Boolean)[0] || '';
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const parts = u.pathname.split('/').filter(Boolean);
    const live = parts.indexOf('live');
    if (live >= 0 && parts[live + 1]) return parts[live + 1];
    const shorts = parts.indexOf('shorts');
    if (shorts >= 0 && parts[shorts + 1]) return parts[shorts + 1];
  } catch {}
  return '';
}
function footballSeasonYear(d = new Date()) {
  const y = d.getUTCFullYear();
  return d.getUTCMonth() <= 1 ? y - 1 : y;
}
function logoFor(abbr) {
  return `https://a.espncdn.com/i/teamlogos/nfl/500/${String(abbr || '').toLowerCase()}.png`;
}
function normalizeScheduleTeam(c = {}) {
  const t = c.team || c;
  const abbr = String(t.abbreviation || c.abbreviation || '').toUpperCase();
  return {
    id: String(t.id || c.id || ''),
    name: t.shortDisplayName || t.displayName || t.name || abbr || 'Opponent',
    fullName: t.displayName || t.name || abbr || 'Opponent',
    abbr,
    logo: t.logo || t.logos?.[0]?.href || logoFor(abbr),
    homeAway: c.homeAway || '',
    score: Number(c.score ?? 0),
  };
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent':'Mozilla/5.0 (Purple Reign Confidence Meter)' } });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
function scheduleCandidate(e = {}) {
  const comp = e.competitions?.[0] || {};
  const teams = comp.competitors || [];
  const rav = normalizeScheduleTeam(teams.find(c => String(c.team?.abbreviation || c.abbreviation || '').toUpperCase() === 'BAL') || {});
  const opp = normalizeScheduleTeam(teams.find(c => String(c.team?.abbreviation || c.abbreviation || '').toUpperCase() !== 'BAL') || {});
  const date = new Date(e.date || comp.date || 0).getTime();
  const status = comp.status || e.status || {};
  return { e, comp, rav, opp, date, state: status.type?.state || 'pre', statusText: status.type?.shortDetail || status.type?.description || '' };
}
function weekLabelFor(c) {
  return String(c?.e?.week?.text || c?.e?.week?.number || c?.e?.seasonType?.name || '');
}
function compactGame(c) {
  return {
    ravens: { name:'Ravens', fullName:c.rav.fullName || 'Baltimore Ravens', abbr:'BAL', logo:c.rav.logo || logoFor('BAL'), score:c.rav.score, homeAway:c.rav.homeAway },
    opponent: { name:c.opp.name, fullName:c.opp.fullName, abbr:c.opp.abbr, logo:c.opp.logo || logoFor(c.opp.abbr), score:c.opp.score, homeAway:c.opp.homeAway },
    date: Number.isFinite(c.date) ? new Date(c.date).toISOString() : '',
    week: weekLabelFor(c),
    statusText: c.statusText,
  };
}
async function refreshRavensContext(force = false) {
  if (!force && state.matchup && state.performance && Date.now() - state.ravensContextUpdatedAt < 5 * 60 * 1000) return { matchup:state.matchup, performance:state.performance };
  const season = footballSeasonYear();
  const data = await fetchJson(`${ESPN_SCHEDULE}?season=${season}`);
  const candidates = (Array.isArray(data.events) ? data.events : []).map(scheduleCandidate).filter(x => x.rav.abbr === 'BAL' && x.opp.abbr && Number.isFinite(x.date));
  if (!candidates.length) throw new Error('No Ravens schedule data found');

  const now = Date.now();
  let upcoming = candidates.find(x => x.state === 'in');
  if (!upcoming) upcoming = candidates.filter(x => x.state !== 'post' && x.date >= now - 3 * 60 * 60 * 1000).sort((a,b) => a.date - b.date)[0];
  if (!upcoming) upcoming = candidates.filter(x => x.date >= now).sort((a,b) => a.date - b.date)[0];
  if (!upcoming) upcoming = [...candidates].sort((a,b) => b.date - a.date)[0];

  const completed = candidates.filter(x => x.state === 'post' || (x.date < now - 4 * 60 * 60 * 1000 && (x.rav.score || x.opp.score))).sort((a,b) => b.date - a.date)[0] || null;

  state.matchup = compactGame(upcoming);
  if (completed) {
    const base = compactGame(completed);
    const rs = completed.rav.score, os = completed.opp.score;
    const result = rs > os ? 'W' : rs < os ? 'L' : 'T';
    state.performance = { ...base, result, resultText:`${result} ${rs}-${os}`, finalScore:`${rs}-${os}` };
  } else state.performance = null;
  state.ravensContextUpdatedAt = Date.now();
  broadcast();
  return { matchup:state.matchup, performance:state.performance };
}
function voteSummary(mode = state.activeMode) {
  const map = state.votesByMode[mode] || new Map();
  const counts = {1:0,2:0,3:0,4:0,5:0};
  for (const v of map.values()) if (counts[v] !== undefined) counts[v]++;
  const total = map.size;
  let avg = 0;
  if (total) {
    let sum = 0;
    for (const [k,n] of Object.entries(counts)) sum += Number(k) * n;
    avg = sum / total;
  }
  const percent = total ? Math.round(((avg - 1) / 4) * 100) : null;
  let topBucket = null;
  if (total) topBucket = Number(Object.entries(counts).sort((a,b) => b[1] - a[1] || Number(b[0]) - Number(a[0]))[0][0]);
  return { counts, total, average: total ? Number(avg.toFixed(2)) : null, percent, topBucket };
}
function modeMeta(mode = state.activeMode) {
  if (mode === 'performance') return { key:'performance', eyebrow:'Reign Gang Performance Rating', headline:'Rate The Ravens', accent:'Last Performance', centerType:'rating', labels:['Awful','Poor','Average','Good','Dominant'] };
  return { key:'preview', eyebrow:'Reign Gang Confidence Meter', headline:'How Confident', accent:'Are You?', centerType:'percent', labels:['No confidence','Nervous','Toss-up','Confident','Very confident'] };
}
function publicState() {
  return {
    connected:state.connected,
    connectionMode:state.connectionMode,
    votingOpen:state.votingOpen,
    activeMode:state.activeMode,
    modeMeta:modeMeta(),
    videoId:state.videoId,
    videoTitle:state.videoTitle,
    liveChatId:state.liveChatId ? 'connected' : '',
    armed:Boolean(state.armedVideoId),
    armedVideoId:state.armedVideoId,
    armedVideoTitle:state.armedVideoTitle,
    armedAt:state.armedAt,
    armPollingIntervalMs:state.armPollingIntervalMs,
    lastError:state.lastError,
    matchup:state.matchup,
    performance:state.performance,
    votes:voteSummary(),
    polls:{ preview:voteSummary('preview'), performance:voteSummary('performance') },
    apiKeyConfigured:Boolean(state.apiKey),
    updatedAt:new Date().toISOString(),
  };
}
function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch { clients.delete(res); } }
}
async function ytVideo(videoId) {
  if (!state.apiKey) throw new Error('YouTube API key is not configured');
  const u = `${YT_BASE}/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(state.apiKey)}`;
  const data = await fetchJson(u);
  const item = data.items?.[0];
  if (!item) throw new Error('YouTube video not found');
  return item;
}
async function listChat(pageToken = '') {
  if (!state.liveChatId) throw new Error('No live chat connected');
  const q = new URLSearchParams({ liveChatId:state.liveChatId, part:'id,snippet,authorDetails', maxResults:'200', key:state.apiKey });
  if (pageToken) q.set('pageToken', pageToken);
  return fetchJson(`${YT_BASE}/liveChat/messages?${q.toString()}`);
}
async function primeCursor() {
  const data = await listChat('');
  state.nextPageToken = data.nextPageToken || '';
  state.pollingIntervalMs = Math.max(2500, Number(data.pollingIntervalMillis || 5000));
}
function processMessages(items = []) {
  if (!state.votingOpen) return;
  const voteMap = state.votesByMode[state.activeMode];
  let changed = false;
  for (const item of items) {
    const text = String(item.snippet?.displayMessage || item.snippet?.textMessageDetails?.messageText || '').trim();
    const m = text.match(/^!([1-5])$/);
    if (!m) continue;
    const voter = String(item.authorDetails?.channelId || item.authorDetails?.displayName || item.id || '');
    if (!voter) continue;
    const bucket = Number(m[1]);
    if (voteMap.get(voter) !== bucket) { voteMap.set(voter, bucket); changed = true; }
  }
  if (changed) broadcast();
}
async function pollOnce() {
  clearTimeout(state.pollTimer);
  if (!state.connected || !state.liveChatId || !state.apiKey) return;
  try {
    const data = await listChat(state.nextPageToken || '');
    state.nextPageToken = data.nextPageToken || state.nextPageToken;
    state.pollingIntervalMs = Math.max(2500, Number(data.pollingIntervalMillis || state.pollingIntervalMs || 5000));
    state.lastError = '';
    processMessages(data.items || []);
  } catch (e) {
    state.lastError = e.message || 'YouTube polling failed';
    broadcast();
  }
  state.pollTimer = setTimeout(pollOnce, state.pollingIntervalMs);
  state.pollTimer.unref?.();
}
function clearArmTimer(){ clearTimeout(state.armTimer); state.armTimer = null; }
function clearArmedTarget(){ clearArmTimer(); state.armedVideoId=''; state.armedVideoTitle=''; state.armedAt=''; }
function clearAllVotes(){ state.votesByMode.preview.clear(); state.votesByMode.performance.clear(); }
async function activateChat(item, videoId, mode='manual') {
  const chatId = item.liveStreamingDetails?.activeLiveChatId || '';
  if (!chatId) throw new Error('This video does not currently have an active live chat');
  clearArmTimer();
  state.videoId=videoId;
  state.videoTitle=item.snippet?.title || state.armedVideoTitle || '';
  state.liveChatId=chatId;
  state.connected=true;
  state.connectionMode=mode;
  state.votingOpen=false;
  state.lastError='';
  state.nextPageToken='';
  clearArmedTarget();
  await primeCursor();
  broadcast();
  pollOnce();
}
function scheduleArmPoll(delay=state.armPollingIntervalMs) {
  clearArmTimer();
  if (!state.armedVideoId || state.connected) return;
  state.armTimer=setTimeout(async()=>{ await tryAutoConnectArmed(); if(state.armedVideoId && !state.connected) scheduleArmPoll(); }, Math.max(5000, Number(delay || state.armPollingIntervalMs)));
  state.armTimer.unref?.();
}
async function tryAutoConnectArmed() {
  if (!state.armedVideoId || state.connected || !state.apiKey) return false;
  try {
    const item = await ytVideo(state.armedVideoId);
    state.armedVideoTitle = item.snippet?.title || state.armedVideoTitle || '';
    if (!item.liveStreamingDetails?.activeLiveChatId) { state.lastError=''; broadcast(); return false; }
    await activateChat(item, state.armedVideoId, 'auto');
    return true;
  } catch (e) {
    state.lastError = `Armed stream check: ${e.message || 'YouTube check failed'}`;
    broadcast();
    return false;
  }
}
async function armYouTube(input) {
  const videoId = extractVideoId(input);
  if (!videoId) throw new Error('Paste a valid YouTube scheduled/live URL or 11-character video ID');
  if (!state.apiKey) throw new Error('Save your YouTube API key first');
  clearTimeout(state.pollTimer); state.pollTimer=null; state.connected=false; state.connectionMode=''; state.votingOpen=false; state.videoId=''; state.videoTitle=''; state.liveChatId=''; state.nextPageToken=''; clearAllVotes(); clearArmTimer();
  const item = await ytVideo(videoId);
  state.armedVideoId=videoId; state.armedVideoTitle=item.snippet?.title || ''; state.armedAt=new Date().toISOString(); state.lastError=''; broadcast();
  const connectedNow = await tryAutoConnectArmed();
  if (!connectedNow && state.armedVideoId) scheduleArmPoll();
}
async function connectYouTube(input) {
  const videoId = extractVideoId(input);
  if (!videoId) throw new Error('Paste a valid YouTube live URL or 11-character video ID');
  const item = await ytVideo(videoId);
  if (!item.liveStreamingDetails?.activeLiveChatId) throw new Error('This video does not currently have an active live chat. Use Arm Scheduled Stream if you are not live yet.');
  clearAllVotes();
  await activateChat(item, videoId, 'manual');
}
function disconnect() {
  clearTimeout(state.pollTimer); state.pollTimer=null; clearArmedTarget(); state.connected=false; state.connectionMode=''; state.votingOpen=false; state.videoId=''; state.videoTitle=''; state.liveChatId=''; state.nextPageToken=''; state.lastError=''; broadcast();
}
async function openVoting() {
  if (!state.connected) {
    if (state.armedVideoId) throw new Error('Scheduled stream is armed, but YouTube live chat is not active yet');
    throw new Error('Connect or arm a YouTube live video first');
  }
  await primeCursor();
  state.votingOpen=true; state.lastError=''; broadcast();
}
function closeVoting(){ state.votingOpen=false; broadcast(); }
function setMode(mode) {
  const m = String(mode || '').toLowerCase();
  if (!['preview','performance'].includes(m)) throw new Error('Mode must be preview or performance');
  state.activeMode=m; state.votingOpen=false; state.lastError=''; broadcast();
}
function cycleMode(){ setMode(state.activeMode === 'preview' ? 'performance' : 'preview'); }
function resetVotes(mode=state.activeMode){ const m=['preview','performance'].includes(mode) ? mode : state.activeMode; state.votesByMode[m].clear(); broadcast(); }
function demoVote(bucket){ const b=Number(bucket); if(b<1 || b>5) throw new Error('Demo vote must be 1-5'); state.votesByMode[state.activeMode].set(`demo-${Date.now()}-${Math.random()}`, b); broadcast(); }

async function handleAction(body={}) {
  const action = String(body.action || '');
  if (action === 'setApiKey') { state.apiKey=String(body.apiKey || '').trim(); state.lastError=''; if(state.armedVideoId && state.apiKey && !state.connected) scheduleArmPoll(1000); broadcast(); return {ok:true,apiKeyConfigured:Boolean(state.apiKey)}; }
  if (action === 'arm') { await armYouTube(body.video || body.videoId || ''); return {ok:true}; }
  if (action === 'connect') { await connectYouTube(body.video || body.videoId || ''); return {ok:true}; }
  if (action === 'disconnect' || action === 'disarm') { disconnect(); return {ok:true}; }
  if (action === 'open') { await openVoting(); return {ok:true}; }
  if (action === 'close') { closeVoting(); return {ok:true}; }
  if (action === 'setMode') { setMode(body.mode); return {ok:true}; }
  if (action === 'cycleMode') { cycleMode(); return {ok:true}; }
  if (action === 'reset') { resetVotes(state.activeMode); return {ok:true}; }
  if (action === 'resetAll') { clearAllVotes(); broadcast(); return {ok:true}; }
  if (action === 'demoVote') { demoVote(body.bucket); return {ok:true}; }
  if (action === 'refreshMatchup' || action === 'refreshRavens') { await refreshRavensContext(true); return {ok:true}; }
  throw new Error('Unknown control action');
}

async function handle(req,res,url) {
  if (url.pathname === '/confidence') { html(res,200,CONFIDENCE_HTML); return true; }
  if (url.pathname === '/confidence-control') { if(!authorized(url,req)){ html(res,403,'<h1>Forbidden</h1>'); return true; } html(res,200,CONTROL_HTML); return true; }
  if (url.pathname === '/api/confidence-state') { try{ await refreshRavensContext(false); }catch(e){ state.lastError ||= e.message; } json(res,200,publicState(),{'Access-Control-Allow-Origin':'*'}); return true; }
  if (url.pathname === '/api/confidence-stream') {
    try{ await refreshRavensContext(false); }catch{}
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
    res.write(`data: ${JSON.stringify(publicState())}\n\n`); clients.add(res); req.on('close',()=>clients.delete(res)); return true;
  }
  if (url.pathname === '/api/confidence-control' && req.method === 'POST') {
    if(!authorized(url,req)){ json(res,403,{error:'Forbidden'}); return true; }
    try { const body=await readBody(req); const result=await handleAction(body); json(res,200,{...result,state:publicState()}); }
    catch(e){ state.lastError=e.message || 'Control action failed'; broadcast(); json(res,400,{error:state.lastError,state:publicState()}); }
    return true;
  }
  return false;
}

refreshRavensContext(true).catch(e => { state.lastError = e.message || 'Ravens context unavailable'; });
setInterval(() => refreshRavensContext(true).catch(() => {}), 10 * 60 * 1000).unref?.();

module.exports = { handle };
