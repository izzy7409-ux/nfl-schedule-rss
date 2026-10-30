 'use strict';
let lastKey='',lastSent=0,busy=false,lastStatus='',statusAt=0;
async function report(status){if(status===lastStatus&&Date.now()-statusAt<15000)return;lastStatus=status;statusAt=Date.now();try{await chrome.runtime.sendMessage({type:'reader-status',status})}catch{}}
async function check(){if(busy)return;const channelId=QSSStudioReader.channel(location.href);if(!channelId)return;let sample;try{sample=QSSStudioReader.read(document,location.href)}catch{await report('Studio layout could not be read. Refresh the live-count page.');return}
 if(!sample){const live=new URL(location.href).searchParams.get('explore_type')==='SUBSCRIBERS'||/live subscriber count/i.test(document.body?.innerText||'');await report(live?'Live-count page found, waiting for the large exact number.':'Open Analytics, then See live count under Subscribers.');return}
 await report('Exact count detected: '+sample.count.toLocaleString());const key=sample.channelId+':'+sample.count;if(key===lastKey&&Date.now()-lastSent<15000)return;busy=true;try{const r=await chrome.runtime.sendMessage({type:'sample',...sample,observedAt:Date.now()});if(r?.ok){lastKey=key;lastSent=Date.now()}}catch{}finally{busy=false}}
setInterval(check,2000);check();
