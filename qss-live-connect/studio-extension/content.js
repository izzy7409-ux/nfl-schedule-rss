 'use strict';
let lastKey='',lastSent=0,busy=false,lastStatus='',statusAt=0,pickedPath=null;
chrome.runtime.sendMessage({type:'reader-settings'}).then(r=>{pickedPath=r?.path||null}).catch(()=>{});
async function report(status){if(status===lastStatus&&Date.now()-statusAt<15000)return;lastStatus=status;statusAt=Date.now();try{await chrome.runtime.sendMessage({type:'reader-status',status})}catch{}}
async function check(){if(busy)return;const channelId=QSSStudioReader.channel(location.href);if(!channelId)return;let sample;try{if(pickedPath&&QSSStudioReader.isReport(document,location.href)){const el=QSSStudioReader.resolve(document,pickedPath);const count=el?QSSStudioReader.value(el):null;if(count!==null)sample={channelId,count}}if(!sample)sample=QSSStudioReader.read(document,location.href)}catch{await report('Studio layout could not be read. Refresh the live-count page.');return}
 if(!sample){const live=new URL(location.href).searchParams.get('explore_type')==='SUBSCRIBERS'||/live subscriber count/i.test(document.body?.innerText||'');await report(live?'Live-count page found, waiting for the large exact number.':'Open Analytics, then See live count under Subscribers.');return}
 await report('Exact count detected: '+sample.count.toLocaleString());const key=sample.channelId+':'+sample.count;if(key===lastKey&&Date.now()-lastSent<15000)return;busy=true;try{const r=await chrome.runtime.sendMessage({type:'sample',...sample,observedAt:Date.now()});if(r?.ok){lastKey=key;lastSent=Date.now()}}catch{}finally{busy=false}}
setInterval(check,2000);check();

chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(message.type!=='pick-count'||sender.id!==chrome.runtime.id)return;
 if(!QSSStudioReader.isReport(document,location.href)){reply({ok:false,error:'Open your Studio live subscriber-count page first.'});return}
 const banner=document.createElement('div');banner.textContent='QSS: Click the large subscriber number once. Press Escape to cancel.';banner.style.cssText='position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#492c6b;color:white;padding:15px 22px;border:1px solid #bd91ff;border-radius:12px;font:16px Arial;box-shadow:0 5px 30px #0008;pointer-events:none';document.body.appendChild(banner);
 function cleanup(){document.removeEventListener('click',pick,true);document.removeEventListener('keydown',cancel,true);banner.remove()}
 function cancel(e){if(e.key==='Escape')cleanup()}
 function pick(e){e.preventDefault();e.stopImmediatePropagation();let node=e.composedPath().find(x=>x?.nodeType===1),best=null;for(let i=0;node&&i<7;i++,node=node.parentElement||node.getRootNode()?.host){const count=QSSStudioReader.value(node);if(count!==null&&(!best||String(count).length>String(best.count).length))best={node,count}}
 if(!best){banner.textContent='No exact number found there. Click directly on the subscriber count.';return}
 pickedPath=QSSStudioReader.pathFor(best.node);chrome.runtime.sendMessage({type:'save-reader-path',path:pickedPath}).then(()=>{lastKey='';lastSent=0;check()}).catch(()=>{});cleanup()}
 document.addEventListener('click',pick,true);document.addEventListener('keydown',cancel,true);reply({ok:true});
});
