'use strict';
const ORIGIN='https://quiet-storm-sports-production.up.railway.app';
chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 (async()=>{
  if(sender.id!==chrome.runtime.id)return {ok:false};
  if(message.type==='configure'){
   if(sender.tab||!sender.url?.startsWith(chrome.runtime.getURL('')))return {ok:false};
   const code=String(message.code||'').trim();if(!/^[A-Za-z0-9_-]{50,5000}$/.test(code))return{ok:false,error:'Paste the Studio connection code from your QSS remote.'};
   // Store only the purpose-limited code. Google cookies and passwords are never read.
   await chrome.storage.local.set({code,status:'Connected. Open your Studio live subscriber count.',lastSync:0});return{ok:true};
  }
  if(message.type==='disconnect'){
   if(sender.tab)return{ok:false};await chrome.storage.local.remove('code');await chrome.storage.local.set({status:'Disconnected',lastSync:0});return{ok:true};
  }
  if(message.type!=='sample'||!sender.tab?.url)return{ok:false};
  const u=new URL(sender.tab.url);const id=(u.pathname.match(/^\/channel\/(UC[\w-]{22})\/analytics\//)||[])[1];
  if(u.origin!=='https://studio.youtube.com'||u.searchParams.get('explore_type')!=='SUBSCRIBERS'||id!==message.channelId||!Number.isSafeInteger(message.count)||message.count<0)return{ok:false};
  const {code}=await chrome.storage.local.get('code');if(!code)return{ok:false};
  try{const response=await fetch(ORIGIN+'/api/studio-count',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+code},body:JSON.stringify({channelId:id,count:message.count,observedAt:message.observedAt}),credentials:'omit',signal:AbortSignal.timeout(8000)});const data=await response.json();if(!response.ok)throw Error(data.error||'Connection failed');await chrome.storage.local.set({status:'Studio exact sync',lastCount:message.count,lastSync:Date.now()});return{ok:true}}
  catch(error){await chrome.storage.local.set({status:error.message});return{ok:false,error:error.message}}
 })().then(reply).catch(()=>reply({ok:false,error:'Could not connect. Open your QSS remote to generate a new code.'}));return true;
});
