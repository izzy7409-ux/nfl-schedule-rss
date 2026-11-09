const fs=require('fs');
const path=require('path');
const {createHash}=require('node:crypto');

const OVERLAY_HTML=fs.readFileSync(path.join(__dirname,'lower-third.html'),'utf8');
const CONTROL_HTML=fs.readFileSync(path.join(__dirname,'lower-third-control.html'),'utf8');
const CONTROL_SECRET=process.env.LOWER_THIRD_CONTROL_SECRET||process.env.CONFIDENCE_CONTROL_SECRET||'';
const DATA_FILE=process.env.LOWER_THIRD_DATA_FILE||'/data/prp-lower-third.json';
const MAX_TOPICS=40;
const DEFAULT_TICKER='WELCOME TO THE PURPLE REIGN PODCAST, YOUR #1 SOURCE FOR BALTIMORE RAVENS NEWS AND DISCUSSIONS. LIKE THE VIDEO IF YOU ENJOY THE CONTENT! ALL SUPERCHATS/SUBS/MEMBERSHIPS ANNOUNCED LIVE ON THE SHOW!';
const clients=new Set();
let loaded=false,lastError='';
let state={
  topics:['RAVENS VS COWBOYS KEYS TO VICTORY','3 BIGGEST MATCHUPS TO WATCH','LATEST RAVENS NEWS AND INJURY UPDATES','WHAT THE RAVENS MUST FIX THIS WEEK','REIGN GANG MAILBAG'],
  currentIndex:0,label:'LIVE DISCUSSION',logoText:'PURPLE REIGN PODCAST',ticker:DEFAULT_TICKER,
  mode:'discussion',breakingHeadline:'',visible:true,updatedAt:''
};

function json(res,code,obj){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
function html(res,code,body){res.writeHead(code,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(body);}
function readBody(req){return new Promise((resolve,reject)=>{let data='';req.on('data',c=>{data+=c;if(data.length>500000)reject(new Error('Body too large'));});req.on('end',()=>{try{resolve(data?JSON.parse(data):{});}catch{reject(new Error('Invalid JSON'));}});req.on('error',reject);});}
function authorized(url,req){if(!CONTROL_SECRET)return true;return (url.searchParams.get('key')||'')===CONTROL_SECRET||String(req.headers['x-control-key']||'')===CONTROL_SECRET;}
function parseTopics(value) {
  return (Array.isArray(value) ? value : []).map(topic => String(topic || '').trim()).filter(Boolean);
}
function cleanTopics(value) {
  const topics = parseTopics(value).slice(0, MAX_TOPICS);
  return topics.length ? topics : ['ADD YOUR FIRST TOPIC IN THE REMOTE'];
}
function rundownRevision() {
  return createHash('sha256').update(JSON.stringify(state.topics)).digest('hex');
}
function topicIndex(value) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= state.topics.length) throw new Error('Invalid topic');
  return index;
}
function normalize(raw={}){
  const topics=cleanTopics(raw.topics||state.topics);
  let idx=Number.isFinite(Number(raw.currentIndex))?Math.trunc(Number(raw.currentIndex)):0;
  idx=Math.max(0,Math.min(idx,topics.length-1));
  return {
    topics,currentIndex:idx,
    label:(String(raw.label||'LIVE DISCUSSION').trim().slice(0,40)||'LIVE DISCUSSION'),
    logoText:(String(raw.logoText||'PURPLE REIGN PODCAST').trim().slice(0,50)||'PURPLE REIGN PODCAST'),
    ticker:(String(raw.ticker||DEFAULT_TICKER).trim().slice(0,800)||DEFAULT_TICKER),
    mode:raw.mode==='breaking'?'breaking':'discussion',
    breakingHeadline:String(raw.breakingHeadline||'').trim().slice(0,150),
    visible:raw.visible!==false,updatedAt:new Date().toISOString()
  };
}
function ensureLoaded(){
  if(loaded)return;loaded=true;
  try{
    fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
    if(fs.existsSync(DATA_FILE))state=normalize({...state,...JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))});
    else{state=normalize(state);save();}
  }catch(e){lastError='Storage warning: '+e.message;state=normalize(state);}
}
function save(next=state){
  fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
  const tmp=DATA_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(next,null,2));fs.renameSync(tmp,DATA_FILE);lastError='';
}
function publicState(){
  ensureLoaded();
  const selectedTopic=state.topics[state.currentIndex]||'';
  return {...state,rundownRevision:rundownRevision(),topicLimit:MAX_TOPICS,selectedTopic,displayTitle:(state.mode==='breaking'&&state.breakingHeadline?state.breakingHeadline:selectedTopic),displayLabel:(state.mode==='breaking'?'BREAKING NEWS':state.label),lastError};
}
function broadcast(){
  const payload='data: '+JSON.stringify({ok:true,state:publicState()})+'\n\n';
  for(const res of clients){try{res.write(payload);}catch{clients.delete(res);}}
}
function commit(update) {
  const next = normalize({...state, ...update});
  try { save(next); }
  catch (error) { lastError = 'Could not save lower third: ' + error.message; throw error; }
  state = next;
  broadcast();
  return publicState();
}
function moveTopic(from,to) {
  const topics = [...state.topics];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= topics.length || to >= topics.length) return {};
  const [topic] = topics.splice(from, 1);
  topics.splice(to, 0, topic);
  let {currentIndex} = state;
  if (currentIndex === from) currentIndex = to;
  else if (from < currentIndex && currentIndex <= to) currentIndex--;
  else if (to <= currentIndex && currentIndex < from) currentIndex++;
  return {topics, currentIndex};
}
async function control(body={}){
  ensureLoaded();const a=String(body.action||'');
  if (body.rundownRevision !== undefined && body.rundownRevision !== rundownRevision()) {
    throw new Error('The rundown changed. Review the latest topics and try again.');
  }
  if(a==='saveSettings')return commit({label:body.label,logoText:body.logoText,ticker:body.ticker});
  if (a === 'setTopics' || a === 'replaceTopics') {
    const replacing = a === 'replaceTopics';
    const topics = replacing ? parseTopics(body.topics) : cleanTopics(body.topics);
    if (!topics.length || topics.length > MAX_TOPICS) throw new Error(`Enter between 1 and ${MAX_TOPICS} topics.`);
    const active = state.topics[state.currentIndex];
    const currentIndex = replacing && topics[state.currentIndex] === active ? state.currentIndex : Math.max(0, topics.indexOf(active));
    return commit({topics, currentIndex, mode: replacing ? state.mode : 'discussion'});
  }
  if(a==='setCurrent')return commit({currentIndex:Math.max(0,Math.min(state.topics.length-1,Number(body.index)||0)),mode:'discussion'});
  if(a==='next')return commit({currentIndex:(state.currentIndex+1)%state.topics.length,mode:'discussion'});
  if(a==='prev')return commit({currentIndex:(state.currentIndex-1+state.topics.length)%state.topics.length,mode:'discussion'});
  if (a === 'addTopic' || a === 'appendTopics') {
    const values = a === 'addTopic' ? [String(body.topic || '').trim().slice(0, 150)] : body.topics;
    const topics = parseTopics(values);
    if (!topics.length) throw new Error('Enter a topic first');
    if (state.topics.length + topics.length > MAX_TOPICS) throw new Error(`The rundown can hold up to ${MAX_TOPICS} topics.`);
    return commit({topics: [...state.topics, ...topics]});
  }
  if (a === 'editTopic') {
    const index = topicIndex(body.index);
    const topic = String(body.topic || '').trim();
    if (!topic) throw new Error('Enter a topic first');
    const topics = [...state.topics];
    topics[index] = topic;
    return commit({topics});
  }
  if (a === 'removeTopic') {
    const index = topicIndex(body.index);
    if (state.topics.length === 1) throw new Error('Keep at least one topic');
    const topics = state.topics.filter((_, position) => position !== index);
    const currentIndex = Math.min(state.currentIndex - (index < state.currentIndex ? 1 : 0), topics.length - 1);
    return commit({topics, currentIndex});
  }
  if(a==='moveTopic')return commit(moveTopic(Number(body.from),Number(body.to)));
  if(a==='breaking'){const headline=String(body.headline||'').trim().slice(0,150);if(!headline)throw new Error('Enter a breaking-news headline');return commit({mode:'breaking',breakingHeadline:headline,visible:true});}
  if(a==='discussion')return commit({mode:'discussion'});
  if(a==='toggleVisible')return commit({visible:!state.visible});
  if(a==='show')return commit({visible:true});
  if(a==='hide')return commit({visible:false});
  if(a==='resetTicker')return commit({ticker:DEFAULT_TICKER});
  throw new Error('Unknown lower-third action');
}
async function handle(req,res,url){
  const routes=['/lower-third','/lower-third-control','/api/lower-third-state','/api/lower-third-stream','/api/lower-third-control'];
  if(!routes.includes(url.pathname))return false;ensureLoaded();
  if(url.pathname==='/lower-third'){res.writeHead(302,{'Location':'https://quiet-storm-sports-production.up.railway.app/prp-overlay','Cache-Control':'no-store'});res.end();return true;}
  if(url.pathname==='/lower-third-control'){if(!authorized(url,req)){html(res,403,'<h1>Forbidden</h1>');return true;}html(res,200,CONTROL_HTML);return true;}
  if(url.pathname==='/api/lower-third-state'){json(res,200,{ok:true,state:publicState()});return true;}
  if(url.pathname==='/api/lower-third-stream'){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-store','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
    res.write('data: '+JSON.stringify({ok:true,state:publicState()})+'\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return true;
  }
  if(url.pathname==='/api/lower-third-control'){
    if(!authorized(url,req)){json(res,403,{ok:false,error:'Forbidden'});return true;}
    if(req.method!=='POST'){json(res,405,{ok:false,error:'POST required'});return true;}
    try{const body=await readBody(req);json(res,200,{ok:true,state:await control(body)});}catch(e){json(res,400,{ok:false,error:e.message||'Lower-third action failed',state:publicState()});}
    return true;
  }
  return false;
}
module.exports={handle};
