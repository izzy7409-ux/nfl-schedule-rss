'use strict';
importScripts('reader.js');
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
  if(message.type==='pick-count'){if(sender.tab)return{ok:false};const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id)return{ok:false,error:'Open the Studio live-count tab first.'};try{return await chrome.tabs.sendMessage(tab.id,{type:'pick-count'})}catch{return{ok:false,error:'Refresh your Studio live-count tab, then try again.'}}}
  if(message.type==='disconnect'){
   if(sender.tab)return{ok:false};await chrome.storage.local.remove('code');await chrome.storage.local.set({status:'Disconnected',lastSync:0});return{ok:true};
  }
  if(!sender.tab)return{ok:false};
  const id=QSSStudioReader.channel(sender.url||sender.tab.url||'');if(!id)return{ok:false,error:'Open the Studio live subscriber-count page.'};
  if(message.type==='reader-settings'){const s=await chrome.storage.local.get('readerPaths');return{ok:true,path:s.readerPaths?.[id]||null}}
  if(message.type==='save-reader-path'){if(!Array.isArray(message.path)||message.path.length>8||message.path.some(x=>typeof x!=='string'||x.length>6000))return{ok:false};const s=await chrome.storage.local.get('readerPaths');await chrome.storage.local.set({readerPaths:{...s.readerPaths,[id]:message.path},readerStatus:'Subscriber number selected',readerSeenAt:Date.now()});return{ok:true}}
  if(message.type==='reader-status'){await chrome.storage.local.set({readerStatus:String(message.status||'').slice(0,160),readerSeenAt:Date.now()});return{ok:true}}
  if(message.type!=='sample'||id!==message.channelId||!Number.isSafeInteger(message.count)||message.count<0)return{ok:false,error:'Could not read a valid count from this Studio channel.'};
  const {code}=await chrome.storage.local.get('code');if(!code){await chrome.storage.local.set({status:'Not paired. Paste your Studio connection code and click Connect.'});return{ok:false}};
  try{const response=await fetch(ORIGIN+'/api/studio-count',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+code},body:JSON.stringify({channelId:id,count:message.count,observedAt:message.observedAt}),credentials:'omit',signal:AbortSignal.timeout(8000)});const data=await response.json();if(!response.ok)throw Error(data.error||'Connection failed');await chrome.storage.local.set({status:'Studio exact sync',readerStatus:'Exact count detected',readerSeenAt:Date.now(),lastCount:message.count,lastSync:Date.now()});return{ok:true}}
  catch(error){await chrome.storage.local.set({status:error.message});return{ok:false,error:error.message}}
 })().then(reply).catch(()=>reply({ok:false,error:'Could not connect. Open your QSS remote to generate a new code.'}));return true;
});
