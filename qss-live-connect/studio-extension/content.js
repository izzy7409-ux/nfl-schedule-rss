'use strict';
let lastKey='',lastSent=0,busy=false;
async function check(){if(busy)return;const sample=QSSStudioReader.read(document,location.href);if(!sample)return;const key=sample.channelId+':'+sample.count;if(key===lastKey&&Date.now()-lastSent<15000)return;busy=true;try{const r=await chrome.runtime.sendMessage({type:'sample',...sample,observedAt:Date.now()});if(r?.ok){lastKey=key;lastSent=Date.now()}}catch{}finally{busy=false}}
setInterval(check,2000);check();
