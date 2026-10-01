const fs=require('fs');
const path=require('path');

const OVERLAY_HTML=fs.readFileSync(path.join(__dirname,'lower-third.html'),'utf8');
const CONTROL_HTML=fs.readFileSync(path.join(__dirname,'lower-third-control.html'),'utf8');
const CONTROL_SECRET=process.env.LOWER_THIRD_CONTROL_SECRET||process.env.CONFIDENCE_CONTROL_SECRET||'';
const DATA_FILE=process.env.LOWER_THIRD_DATA_FILE||'/data/prp-lower-third.json';
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
function cleanTopics(v){const out=(Array.isArray(v)?v:[]).map(x=>String(x||'').trim()).filter(Boolean).slice(0,40);return out.length?out:['ADD YOUR FIRST TOPIC IN THE REMOTE'];}
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
function save(){
  fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
  const tmp=DATA_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,DATA_FILE);lastError='';
}
function publicState(){
  ensureLoaded();
  const selectedTopic=state.topics[state.currentIndex]||'';
  return {...state,selectedTopic,displayTitle:(state.mode==='breaking'&&state.breakingHeadline?state.breakingHeadline:selectedTopic),displayLabel:(state.mode==='breaking'?'BREAKING NEWS':state.label),lastError};
}
function broadcast(){
  const payload='data: '+JSON.stringify({ok:true,state:publicState()})+'\n\n';
  for(const res of clients){try{res.write(payload);}catch{clients.delete(res);}}
}
function commit(next){state=normalize({...state,...next});try{save();}catch(e){lastError='Could not save lower third: '+e.message;throw e;}broadcast();return publicState();}
function moveTopic(from,to){
  const arr=[...state.topics];
  if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<0||from>=arr.length||to>=arr.length)return;
  const active=arr[state.currentIndex],[item]=arr.splice(from,1);arr.splice(to,0,item);
  state.topics=arr;state.currentIndex=Math.max(0,arr.indexOf(active));
}
async function control(body={}){
  ensureLoaded();const a=String(body.action||'');
  if(a==='saveSettings')return commit({label:body.label,logoText:body.logoText,ticker:body.ticker});
  if(a==='setTopics'){const topics=cleanTopics(body.topics),active=state.topics[state.currentIndex];let idx=topics.indexOf(active);if(idx<0)idx=0;return commit({topics,currentIndex:idx,mode:'discussion'});}
  if(a==='setCurrent')return commit({currentIndex:Math.max(0,Math.min(state.topics.length-1,Number(body.index)||0)),mode:'discussion'});
  if(a==='next')return commit({currentIndex:(state.currentIndex+1)%state.topics.length,mode:'discussion'});
  if(a==='prev')return commit({currentIndex:(state.currentIndex-1+state.topics.length)%state.topics.length,mode:'discussion'});
  if(a==='addTopic'){const topic=String(body.topic||'').trim().slice(0,150);if(!topic)throw new Error('Enter a topic first');return commit({topics:[...state.topics,topic]});}
  if(a==='removeTopic'){const i=Number(body.index);if(!Number.isInteger(i)||i<0||i>=state.topics.length)throw new Error('Invalid topic');if(state.topics.length===1)throw new Error('Keep at least one topic');const topics=state.topics.filter((_,n)=>n!==i);return commit({topics,currentIndex:Math.min(state.currentIndex,topics.length-1)});}
  if(a==='moveTopic'){moveTopic(Number(body.from),Number(body.to));return commit({topics:state.topics,currentIndex:state.currentIndex});}
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
  if(url.pathname==='/lower-third'){html(res,200,OVERLAY_HTML);return true;}
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
