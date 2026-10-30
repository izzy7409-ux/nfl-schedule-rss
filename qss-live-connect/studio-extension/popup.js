'use strict';
const $=id=>document.getElementById(id);
async function render(){const s=await chrome.storage.local.get(['status','lastCount','lastSync','readerStatus','readerSeenAt']);$('status').textContent=s.status||'Not connected';$('reader').textContent=s.readerSeenAt&&Date.now()-s.readerSeenAt<45000?'Studio reader: '+s.readerStatus:'Studio reader not detected. Refresh the Studio live-count tab after reloading the extension.';$('last').textContent=s.lastSync?'Last count: '+Number(s.lastCount).toLocaleString()+' · '+new Date(s.lastSync).toLocaleTimeString():''}
$('connect').onclick=async()=>{const r=await chrome.runtime.sendMessage({type:'configure',code:$('code').value});$('code').value='';if(!r.ok)$('status').textContent=r.error;else render()};
$('disconnect').onclick=async()=>{await chrome.runtime.sendMessage({type:'disconnect'});render()};render();setInterval(render,2000);

$('pick').onclick=async()=>{const r=await chrome.runtime.sendMessage({type:'pick-count'});if(r?.ok)window.close();else $('status').textContent=r?.error||'Open Studio and refresh it first.'};
