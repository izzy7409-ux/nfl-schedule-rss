'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {safePhoto,resolvePhoto}=require('../lib/supporter-photos');
const {items}=require('../streamlabs-events');
test('profile URLs accept image providers and reject unsafe URLs',()=>{
assert.equal(safePhoto('https://yt3.ggpht.com/face=s88'),'https://yt3.ggpht.com/face=s88');
for(const value of ['javascript:alert(1)','http://yt3.ggpht.com/a','https://evil.test/a','https://ggpht.com.evil.test/a'])assert.equal(safePhoto(value),'');
});
test('stream events retain the actual sender channel and picture',()=>{
const [event]=items({for:'youtube_account',type:'superchat',message:[{name:'Fan',channelId:'UC1234567890123456789012',profileImageUrl:'https://yt3.ggpht.com/face',amount:2000000}]});
assert.equal(event.channelId,'UC1234567890123456789012');assert.equal(event.avatarUrl,'https://yt3.ggpht.com/face');
});
test('YouTube photo lookup uses channel identity, caches results and fails quietly',async()=>{
let calls=0;const fetchImpl=async url=>{calls++;assert.equal(new URL(url).searchParams.get('id'),'UC1234567890123456789012');return {ok:true,json:async()=>({items:[{snippet:{thumbnails:{medium:{url:'https://yt3.ggpht.com/face'}}}}]})}};
assert.equal(await resolvePhoto('UC1234567890123456789012','test-key',fetchImpl),'https://yt3.ggpht.com/face');
await resolvePhoto('UC1234567890123456789012','test-key',fetchImpl);assert.equal(calls,1);
assert.equal(await resolvePhoto('UCabcdefghijklmnopqrstuv','test-key',async()=>{throw Error('network')}),'');
assert.equal(await resolvePhoto('Display name','test-key',fetchImpl),'');
});
