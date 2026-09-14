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
  videoId: '', videoTitle: '', liveChatId: '', connected: false, connectionMode: '',
  votingOpen: false, lastError: '', nextPageToken: '', pollTimer: null, pollingIntervalMs: 5000,
  armedVideoId: '', armedVideoTitle: '', armedAt: '', armTimer: null,
  armPollingIntervalMs: 120000,
  activeMode: 'preview',
  polls: { preview: new Map(), performance: new Map() },
  matchup: null, performance: null, ravensDataUpdatedAt: 0,
};

function json(res, code, obj, extra={}) { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra}); res.end(JSON.stringify(obj)); }
function html(res, code, body) { res.writeHead(code, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); res.end(body); }
async function readBody(req){ return new Promise((resolve,reject)=>{ let data=''; req.on('data',c=>{data+=c;if(data.length>200000)reject(new Error('Body too large'));}); req.on('end',()=>{try{resolve(data?JSON.parse(data):{})}catch{reject(new Error('Invalid JSON'))}}); req.on('error',reject); }); }
function authorized(url,req){ if(!CONTROL_SECRET)return true; return (url.searchParams.get('key')||'')===CONTROL_SECRET || String(req.headers['x-control-key']||'')===CONTROL_SECRET; }
function extractVideoId(input=''){ const s=String(input).trim(); if(/^[A-Za-z0-9_-]{11}$/.test(s))return s; try{const u=new URL(s); if(u.hostname.includes('youtu.be'))return u.pathname.split('/').filter(Boolean)[0]||''; if(u.searchParams.get('v'))return u.searchParams.get('v'); const p=u.pathname.split('/').filter(Boolean); for(const seg of ['live','shorts']){const i=p.indexOf(seg);if(i>=0&&p[i+1])return p[i+1];}}catch{} return ''; }
function footballSeasonYear(d=new Date()){ const y=d.getUTCFullYear(),m=d.getUTCMonth(); return m<=1?y-1:y; }
function logoFor(abbr){ return `https://a.espncdn.com/i/teamlogos/nfl/500/${String(abbr||'').toLowerCase()}.png`; }
function normalizeTeam(c={}){ const t=c.team||c; const abbr=String(t.abbreviation||c.abbreviation||'').toUpperCase(); return {id:String(t.id||c.id||''),name:t.shortDisplayName||t.displayName||t.name||abbr||'Opponent',fullName:t.displayName||t.name||abbr||'Opponent',abbr,logo:t.logo||t.logos?.[0]?.href||logoFor(abbr),homeAway:c.homeAway||''}; }
async function fetchJson(url){ const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (Purple Reign Reign Gang Meter)'}}); const text=await r.text(); if(!r.ok){ let msg=text.slice(0,350); try{const j=JSON.parse(text);msg=j?.error?.message||msg;}catch{} const e=new Error(`HTTP ${r.status}: ${msg}`); e.status=r.status; e.body=text; throw e;} return JSON.parse(text); }
function friendlyYTError(e){ const raw=String(e?.body||e?.message||''); if(/quotaExceeded|exceeded your.*quota/i.test(raw)) return 'YouTube API quota is exhausted for this Google Cloud project. Use a fresh API key/project for today, or wait for the daily quota reset. The tracker has been optimized so chat polling now runs only while voting is OPEN.'; return e?.message||'YouTube API request failed'; }

function eventInfo(e){ const comp=e.competitions?.[0]||{}; const teams=comp.competitors||[]; const rav=normalizeTeam(teams.find(c=>String(c.team?.abbreviation||'').toUpperCase()==='BAL')||{}); const opp=normalizeTeam(teams.find(c=>String(c.team?.abbreviation||'').toUpperCase()!=='BAL')||{}); const date=new Date(e.date||comp.date||0).getTime(); const status=comp.status?.type||e.status?.type||{}; const st=status.state||'pre'; const ravComp=teams.find(c=>String(c.team?.abbreviation||'').toUpperCase()==='BAL')||{}; const oppComp=teams.find(c=>String(c.team?.abbreviation||'').toUpperCase()!=='BAL')||{}; const rs=Number(ravComp.score??0), os=Number(oppComp.score??0); const week=String(e.week?.text||e.week?.number||e.seasonType?.name||''); return {e,comp,rav,opp,date,state:st,week,ravensScore:rs,opponentScore:os}; }
async function refreshRavensData(force=false){
  if(!force && state.matchup && state.performance && Date.now()-state.ravensDataUpdatedAt<5*60*1000) return;
  const season=footballSeasonYear(); const data=await fetchJson(`${ESPN_SCHEDULE}?season=${season}`); const events=(Array.isArray(data.events)?data.events:[]).map(eventInfo).filter(x=>x.rav.abbr==='BAL'&&x.opp.abbr);
  const now=Date.now();
  let upcoming=events.find(x=>x.state==='in');
  if(!upcoming) upcoming=events.filter(x=>x.state!=='post'&&x.date>=now-3*60*60*1000).sort((a,b)=>a.date-b.date)[0];
  if(!upcoming) upcoming=events.slice().sort((a,b)=>b.date-a.date)[0];
  if(upcoming) state.matchup={ravens:{name:'Ravens',fullName:upcoming.rav.fullName||'Baltimore Ravens',abbr:'BAL',logo:upcoming.rav.logo||logoFor('BAL')},opponent:{name:upcoming.opp.name,fullName:upcoming.opp.fullName,abbr:upcoming.opp.abbr,logo:upcoming.opp.logo||logoFor(upcoming.opp.abbr)},date:new Date(upcoming.date).toISOString(),week:upcoming.week};
  const completed=events.filter(x=>x.state==='post'&&x.date<=now+60*60*1000).sort((a,b)=>b.date-a.date)[0];
  if(completed){ const result=completed.ravensScore>completed.opponentScore?'W':completed.ravensScore<completed.opponentScore?'L':'T'; state.performance={ravens:{name:'Ravens',fullName:'Baltimore Ravens',abbr:'BAL',logo:logoFor('BAL')},opponent:{name:completed.opp.name,fullName:completed.opp.fullName,abbr:completed.opp.abbr,logo:completed.opp.logo||logoFor(completed.opp.abbr)},date:new Date(completed.date).toISOString(),week:completed.week,ravensScore:completed.ravensScore,opponentScore:completed.opponentScore,result,resultText:`${result} ${completed.ravensScore}-${completed.opponentScore}`}; }
  state.ravensDataUpdatedAt=Date.now(); broadcast();
}

function summarize(map){ const counts={1:0,2:0,3:0,4:0,5:0}; for(const v of map.values())if(counts[v]!==undefined)counts[v]++; const total=map.size; let avg=null,percent=null,topBucket=null; if(total){let sum=0;for(const [k,n] of Object.entries(counts))sum+=Number(k)*n; avg=sum/total; percent=Math.round(((avg-1)/4)*100); topBucket=Number(Object.entries(counts).sort((a,b)=>b[1]-a[1]||Number(b[0])-Number(a[0]))[0][0]);} return {counts,total,average:avg==null?null:Number(avg.toFixed(2)),percent,topBucket}; }
function modeMeta(mode=state.activeMode){ return mode==='performance' ? {eyebrow:'Reign Gang Performance Meter',headline:'Rate The Ravens',accent:'Last Performance',labels:['Awful','Poor','Average','Good','Dominant']} : {eyebrow:'Reign Gang Confidence Meter',headline:'How Confident',accent:'Are You?',labels:['No confidence','Nervous','Toss-up','Confident','Very confident']}; }
function publicState(){ const polls={preview:summarize(state.polls.preview),performance:summarize(state.polls.performance)}; return {activeMode:state.activeMode,modeMeta:modeMeta(),polls,votes:polls[state.activeMode],matchup:state.matchup,performance:state.performance,connected:state.connected,connectionMode:state.connectionMode,votingOpen:state.votingOpen,videoId:state.videoId,videoTitle:state.videoTitle,liveChatId:state.liveChatId?'connected':'',armed:Boolean(state.armedVideoId),armedVideoId:state.armedVideoId,armedVideoTitle:state.armedVideoTitle,armedAt:state.armedAt,armPollingIntervalMs:state.armPollingIntervalMs,lastError:state.lastError,apiKeyConfigured:Boolean(state.apiKey),updatedAt:new Date().toISOString()}; }
function broadcast(){ const payload=`data: ${JSON.stringify(publicState())}\n\n`; for(const res of clients){try{res.write(payload)}catch{clients.delete(res)}} }

async function ytVideo(videoId){ if(!state.apiKey)throw new Error('YouTube API key is not configured'); try{return (await fetchJson(`${YT_BASE}/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(state.apiKey)}`)).items?.[0]||(()=>{throw new Error('YouTube video not found')})();}catch(e){throw new Error(friendlyYTError(e));} }
async function listChat(pageToken=''){ if(!state.liveChatId)throw new Error('No live chat connected'); const q=new URLSearchParams({liveChatId:state.liveChatId,part:'id,snippet,authorDetails',maxResults:'200',key:state.apiKey}); if(pageToken)q.set('pageToken',pageToken); try{return await fetchJson(`${YT_BASE}/liveChat/messages?${q.toString()}`)}catch(e){throw new Error(friendlyYTError(e));} }
async function primeCursor(){ const data=await listChat(''); state.nextPageToken=data.nextPageToken||''; state.pollingIntervalMs=Math.max(2500,Number(data.pollingIntervalMillis||5000)); }
function processMessages(items=[]){ if(!state.votingOpen)return; const map=state.polls[state.activeMode]; let changed=false; for(const item of items){ const text=String(item.snippet?.displayMessage||item.snippet?.textMessageDetails?.messageText||'').trim(); const m=text.match(/^!([1-5])$/); if(!m)continue; const voter=String(item.authorDetails?.channelId||item.authorDetails?.displayName||item.id||''); if(!voter)continue; const b=Number(m[1]); if(map.get(voter)!==b){map.set(voter,b);changed=true;} } if(changed)broadcast(); }
async function pollOnce(){ clearTimeout(state.pollTimer); state.pollTimer=null; if(!state.votingOpen||!state.connected||!state.liveChatId||!state.apiKey)return; try{const data=await listChat(state.nextPageToken||''); state.nextPageToken=data.nextPageToken||state.nextPageToken; state.pollingIntervalMs=Math.max(2500,Number(data.pollingIntervalMillis||state.pollingIntervalMs||5000)); state.lastError=''; processMessages(data.items||[]);}catch(e){state.lastError=e.message||'YouTube polling failed';broadcast(); if(/quota is exhausted/i.test(state.lastError)){state.votingOpen=false;return;}} if(state.votingOpen)state.pollTimer=setTimeout(pollOnce,state.pollingIntervalMs); }
function stopChatPolling(){ clearTimeout(state.pollTimer); state.pollTimer=null; }
function clearArmTimer(){clearTimeout(state.armTimer);state.armTimer=null;}
function clearArmedTarget(){clearArmTimer();state.armedVideoId='';state.armedVideoTitle='';state.armedAt='';}
async function activateChat(item,videoId,mode='manual'){ const chatId=item.liveStreamingDetails?.activeLiveChatId||''; if(!chatId)throw new Error('This video does not currently have an active live chat'); stopChatPolling(); state.videoId=videoId;state.videoTitle=item.snippet?.title||state.armedVideoTitle||'';state.liveChatId=chatId;state.connected=true;state.connectionMode=mode;state.votingOpen=false;state.lastError='';state.nextPageToken='';clearArmedTarget();broadcast(); }
function scheduleArmPoll(delay=state.armPollingIntervalMs){clearArmTimer();if(!state.armedVideoId||state.connected)return;state.armTimer=setTimeout(async()=>{await tryAutoConnectArmed();if(state.armedVideoId&&!state.connected)scheduleArmPoll();},Math.max(30000,Number(delay||state.armPollingIntervalMs)));state.armTimer.unref?.();}
async function tryAutoConnectArmed(){if(!state.armedVideoId||state.connected||!state.apiKey)return false;try{const item=await ytVideo(state.armedVideoId);state.armedVideoTitle=item.snippet?.title||state.armedVideoTitle||'';if(!item.liveStreamingDetails?.activeLiveChatId){state.lastError='';broadcast();return false;}await activateChat(item,state.armedVideoId,'auto');return true;}catch(e){state.lastError=`Armed stream check: ${e.message||'YouTube check failed'}`;broadcast();return false;}}
async function armYouTube(input){const videoId=extractVideoId(input);if(!videoId)throw new Error('Paste a valid YouTube scheduled/live URL or 11-character video ID');if(!state.apiKey)throw new Error('Save your YouTube API key first');stopChatPolling();state.connected=false;state.connectionMode='';state.votingOpen=false;state.videoId='';state.videoTitle='';state.liveChatId='';state.nextPageToken='';clearArmTimer();const item=await ytVideo(videoId);state.armedVideoId=videoId;state.armedVideoTitle=item.snippet?.title||'';state.armedAt=new Date().toISOString();state.lastError='';broadcast();const ok=await tryAutoConnectArmed();if(!ok&&state.armedVideoId)scheduleArmPoll();}
async function connectYouTube(input){const videoId=extractVideoId(input);if(!videoId)throw new Error('Paste a valid YouTube live URL or 11-character video ID');const item=await ytVideo(videoId);if(!item.liveStreamingDetails?.activeLiveChatId)throw new Error('This video does not currently have an active live chat. Use Arm Scheduled Stream if you are not live yet.');await activateChat(item,videoId,'manual');}
function disconnect(){stopChatPolling();clearArmedTarget();state.connected=false;state.connectionMode='';state.votingOpen=false;state.videoId='';state.videoTitle='';state.liveChatId='';state.nextPageToken='';state.lastError='';broadcast();}
async function openVoting(){if(!state.connected){if(state.armedVideoId)throw new Error('Scheduled stream is armed, but YouTube live chat is not active yet');throw new Error('Connect or arm a YouTube live video first');} stopChatPolling(); await primeCursor(); state.votingOpen=true;state.lastError='';broadcast(); pollOnce();}
function closeVoting(){state.votingOpen=false;stopChatPolling();broadcast();}
function setMode(mode){if(!['preview','performance'].includes(mode))throw new Error('Unknown meter mode');closeVoting();state.activeMode=mode;state.lastError='';broadcast();}
function cycleMode(){setMode(state.activeMode==='preview'?'performance':'preview');}
function resetVotes(){state.polls[state.activeMode].clear();broadcast();}
function resetAll(){state.polls.preview.clear();state.polls.performance.clear();broadcast();}
function demoVote(bucket){const b=Number(bucket);if(b<1||b>5)throw new Error('Demo vote must be 1-5');state.polls[state.activeMode].set(`demo-${Date.now()}-${Math.random()}`,b);broadcast();}

async function handleAction(body){const a=body.action;if(a==='setApiKey'){state.apiKey=String(body.apiKey||'').trim();state.lastError='';if(state.armedVideoId&&state.apiKey&&!state.connected)scheduleArmPoll(1000);broadcast();return{ok:true,apiKeyConfigured:Boolean(state.apiKey)}} if(a==='arm'){await armYouTube(body.video||body.videoId||'');return{ok:true}} if(a==='connect'){await connectYouTube(body.video||body.videoId||'');return{ok:true}} if(a==='disconnect'||a==='disarm'){disconnect();return{ok:true}} if(a==='open'){await openVoting();return{ok:true}} if(a==='close'){closeVoting();return{ok:true}} if(a==='setMode'){setMode(String(body.mode||''));return{ok:true}} if(a==='cycleMode'){cycleMode();return{ok:true}} if(a==='reset'){resetVotes();return{ok:true}} if(a==='resetAll'){resetAll();return{ok:true}} if(a==='demoVote'){demoVote(body.bucket);return{ok:true}} if(a==='refreshRavens'||a==='refreshMatchup'){await refreshRavensData(true);return{ok:true}} throw new Error('Unknown control action');}

async function handle(req,res,url){
  if(url.pathname==='/confidence'){html(res,200,CONFIDENCE_HTML);return true;}
  if(url.pathname==='/confidence-control'){if(!authorized(url,req)){html(res,403,'<h1>Forbidden</h1>');return true;}html(res,200,CONTROL_HTML);return true;}
  if(url.pathname==='/api/confidence-state'){try{await refreshRavensData(false)}catch(e){state.lastError ||= e.message;}json(res,200,publicState(),{'Access-Control-Allow-Origin':'*'});return true;}
  if(url.pathname==='/api/confidence-stream'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});res.write(`data: ${JSON.stringify(publicState())}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return true;}
  if(url.pathname==='/api/confidence-control'&&req.method==='POST'){if(!authorized(url,req)){json(res,403,{error:'Forbidden'});return true;}try{const body=await readBody(req);const result=await handleAction(body);json(res,200,{...result,state:publicState()});}catch(e){state.lastError=e.message||'Control action failed';broadcast();json(res,400,{error:state.lastError,state:publicState()});}return true;}
  return false;
}

refreshRavensData(true).catch(e=>{state.lastError=e.message||'Ravens data unavailable';});
setInterval(()=>refreshRavensData(true).catch(()=>{}),10*60*1000).unref?.();
module.exports={handle};
