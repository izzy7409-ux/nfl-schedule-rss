'use strict';
const $=id=>document.getElementById(id);
async function render(){const s=await chrome.storage.local.get(['status','lastCount','lastSync']);$('status').textContent=s.status||'Not connected';$('last').textContent=s.lastSync?'Last count: '+Number(s.lastCount).toLocaleString()+' · '+new Date(s.lastSync).toLocaleTimeString():''}
$('connect').onclick=async()=>{const r=await chrome.runtime.sendMessage({type:'configure',code:$('code').value});$('code').value='';if(!r.ok)$('status').textContent=r.error;else render()};
$('disconnect').onclick=async()=>{await chrome.runtime.sendMessage({type:'disconnect'});render()};render();setInterval(render,2000);
