const fs=require('fs');
const path=require('path');

const OVERLAY_HTML=fs.readFileSync(path.join(__dirname,'qss-overlay.html'),'utf8');
const CONTROL_HTML=fs.readFileSync(path.join(__dirname,'qss-control.html'),'utf8');
const CONTROL_SECRET=process.env.QSS_CONTROL_SECRET||'';
const DATA_FILE=process.env.QSS_DATA_FILE||'/data/qss-overlay.json';
const clients=new Set();

const DEFAULT_STATE={
  topicLabel:"TODAY'S TOPIC",
  topic:"RAVENS OFFENSE HAS A PROBLEM",
  subsCurrent:8742,
  subsTarget:10000,
  showSupporters:true,
  showGoal:true,
  showTicker:true,
  accent:"#a566ff",
  tickerItems:["QUIET STORM SPORTS","ANALYSIS","RAVENS COVERAGE","PLAYER BREAKDOWNS","A REAL CONVERSATION ABOUT FOOTBALL","LIKE","SUBSCRIBE","SUPPORT"],
  supporters:[
    {id:1,name:"DWASS6721",type:"SUPERCHAT",value:"$1.99",createdAt:Date.now()-600000},
    {id:2,name:"DWASS6721",type:"SUPERCHAT",value:"$1.99",createdAt:Date.now()-420000},
    {id:3,name:"ZACHWHITE8256",type:"SUPERCHAT",value:"$2.00",createdAt:Date.now()-180000}
  ],
  updatedAt:""
};
let loaded=false,state={...DEFAULT_STATE};

function json(res,code,obj){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
function html(res,code,body){res.writeHead(code,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(body);}
function readBody(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>500000)reject(new Error('Body too large'));});req.on('end',()=>{try{resolve(s?JSON.parse(s):{});}catch{reject(new Error('Invalid JSON'));}});req.on('error',reject);});}
function authorized(url,req){if(!CONTROL_SECRET)return true;return (url.searchParams.get('key')||'')===CONTROL_SECRET||String(req.headers['x-control-key']||'')===CONTROL_SECRET;}
function clean(v,max=200){return String(v??'').trim().slice(0,max);}
function normalize(raw={}){
  const supporters=Array.isArray(raw.supporters)?raw.supporters.map((s,i)=>({
    id:Number(s.id)||Date.now()+i,
    name:clean(s.name,40),
    type:clean(s.type,24)||'SUPPORT',
    value:clean(s.value,20),
    createdAt:Number(s.createdAt)||Date.now()
  })).filter(s=>s.name).slice(0,20):DEFAULT_STATE.supporters;
  const tickerItems=Array.isArray(raw.tickerItems)?raw.tickerItems.map(x=>clean(x,80)).filter(Boolean).slice(0,30):DEFAULT_STATE.tickerItems;
  return {
    topicLabel:clean(raw.topicLabel,40)||"TODAY'S TOPIC",
    topic:clean(raw.topic,140)||'RAVENS OFFENSE HAS A PROBLEM',
    subsCurrent:Math.max(0,Number(raw.subsCurrent)||0),
    subsTarget:Math.max(1,Number(raw.subsTarget)||10000),
    showSupporters:raw.showSupporters!==false,
    showGoal:raw.showGoal!==false,
    showTicker:raw.showTicker!==false,
    accent:/^#[0-9a-fA-F]{6}$/.test(String(raw.accent||''))?String(raw.accent):'#a566ff',
    tickerItems,
    supporters,
    updatedAt:new Date().toISOString()
  };
}
function ensureLoaded(){
  if(loaded)return;loaded=true;
  try{
    fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
    if(fs.existsSync(DATA_FILE))state=normalize({...DEFAULT_STATE,...JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))});
    else{state=normalize(DEFAULT_STATE);save();}
  }catch(e){console.error('QSS state load:',e);state=normalize(DEFAULT_STATE);}
}
function save(){fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});const tmp=DATA_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,DATA_FILE);}
function broadcast(){const body='data: '+JSON.stringify({ok:true,state})+'\n\n';for(const res of clients){try{res.write(body);}catch{clients.delete(res);}}}
function commit(next){state=normalize({...state,...next});save();broadcast();return state;}

async function action(body={}){
  ensureLoaded();
  const a=String(body.action||'');
  if(a==='saveGeneral')return commit({
    topicLabel:body.topicLabel,topic:body.topic,subsCurrent:body.subsCurrent,subsTarget:body.subsTarget,
    showSupporters:body.showSupporters,showGoal:body.showGoal,showTicker:body.showTicker,accent:body.accent
  });
  if(a==='saveTicker')return commit({tickerItems:Array.isArray(body.tickerItems)?body.tickerItems:[]});
  if(a==='addSupporter'){
    const name=clean(body.name,40);if(!name)throw new Error('Supporter name is required');
    const item={id:Date.now(),name,type:clean(body.type,24)||'SUPPORT',value:clean(body.value,20),createdAt:Date.now()};
    return commit({supporters:[item,...state.supporters].slice(0,20)});
  }
  if(a==='removeSupporter')return commit({supporters:state.supporters.filter(s=>Number(s.id)!==Number(body.id))});
  if(a==='clearSupporters')return commit({supporters:[]});
  if(a==='reset')return commit(DEFAULT_STATE);
  throw new Error('Unknown QSS action');
}

async function handle(req,res,url){
  const routes=['/qss-overlay','/qss-control','/api/qss-state','/api/qss-events','/api/qss-control'];
  if(!routes.includes(url.pathname))return false;
  ensureLoaded();
  if(url.pathname==='/qss-overlay'){html(res,200,OVERLAY_HTML);return true;}
  if(url.pathname==='/qss-control'){if(!authorized(url,req)){html(res,403,'<h1>Forbidden</h1>');return true;}html(res,200,CONTROL_HTML);return true;}
  if(url.pathname==='/api/qss-state'){json(res,200,{ok:true,state});return true;}
  if(url.pathname==='/api/qss-events'){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-store','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
    res.write('data: '+JSON.stringify({ok:true,state})+'\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return true;
  }
  if(url.pathname==='/api/qss-control'){
    if(!authorized(url,req)){json(res,403,{ok:false,error:'Forbidden'});return true;}
    if(req.method!=='POST'){json(res,405,{ok:false,error:'POST required'});return true;}
    try{const body=await readBody(req);json(res,200,{ok:true,state:await action(body)});}catch(e){json(res,400,{ok:false,error:e.message||'QSS action failed',state});}
    return true;
  }
  return false;
}
module.exports={handle};
