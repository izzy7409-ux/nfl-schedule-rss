 'use strict';
function safePhoto(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&['googleusercontent.com','ggpht.com','ytimg.com','youtube.com','cdn.streamlabs.com'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h))?u.href.slice(0,1200):''}catch{return ''}}
const cache=new Map();
async function resolvePhoto(channelId,key,fetchImpl=fetch){
 if(!/^UC[\w-]{22}$/.test(channelId||'')||!key)return '';
 const cached=cache.get(channelId);if(cached&&cached.until>Date.now())return cached.url;
 let url='';try{const q=new URLSearchParams({part:'snippet',id:channelId,key});const r=await fetchImpl('https://www.googleapis.com/youtube/v3/channels?'+q,{signal:AbortSignal.timeout(2500)});if(r.ok){const data=await r.json();const t=data.items?.[0]?.snippet?.thumbnails;url=safePhoto(t?.medium?.url||t?.default?.url)}}catch{}
 if(cache.size>500)cache.clear();cache.set(channelId,{url,until:Date.now()+(url?86400000:600000)});return url;
}
module.exports={safePhoto,resolvePhoto};
