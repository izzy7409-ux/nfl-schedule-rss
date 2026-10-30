'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {color,active}=require('../superchat');
const {items}=require('../streamlabs-events');
test('USD boundaries map to all seven YouTube colors and provider tier overrides currency',()=>{
const amounts=[1,1.99,2,4.99,5,9.99,10,19.99,20,49.99,50,99.99,100,500];
const expected=['#1565c0','#1565c0','#00e5ff','#00e5ff','#0f9d58','#0f9d58','#ffca28','#ffca28','#f57c00','#f57c00','#e91e63','#e91e63','#e62117','#e62117'];
amounts.forEach((amount,i)=>assert.equal(color({amount,currency:'USD'}),expected[i]));
assert.equal(color({amount:1000,currency:'JPY',tier:2}),'#00e5ff');
assert.equal(color({color:'#123abc',tier:3}),'#123abc');
assert.equal(color({amount:1000,currency:'JPY'}),'#303846');
});
test('Super Chat ingestion preserves comment, amount and tier',()=>{
const [e]=items({for:'youtube_account',type:'superchat',message:[{name:'Fan',amount:25000000,currency:'USD',message:'Go Ravens <3',tier:5,_id:'chat-1'}]});
assert.equal(e.message,'Go Ravens <3');assert.equal(e.amount,25);assert.equal(e.value,'$25.00');assert.equal(e.tier,5);
});
test('queued cards switch at ten seconds and return to goal after last card',()=>{
const events=[{startsAt:1000,endsAt:11000,eventId:'a'},{startsAt:11000,endsAt:21000,eventId:'b'}];
assert.equal(active(events,999),null);assert.equal(active(events,1000).eventId,'a');assert.equal(active(events,10999).eventId,'a');assert.equal(active(events,11000).eventId,'b');assert.equal(active(events,21000),null);
});
test('persisted queue survives reload and duplicate delivery does not add another card',async()=>{
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
process.env.QSS_DATA_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'qss-super-test-'));
const state=require('../lib/qss-state');
try{const e={kind:'superchat',label:'SUPERCHAT',name:'Fan',value:'$25.00',message:'Go Ravens!',amount:25,currency:'USD',eventId:'one'};
await state.ingestEvent(e);await state.ingestEvent(e);await state.ingestEvent({...e,eventId:'two'});
const s=await state.readState();assert.equal(s.superChats.length,2);assert.equal(s.superChats[0].message,'Go Ravens!');assert.equal(s.superChats[1].startsAt,s.superChats[0].endsAt);assert.equal(s.superChats[0].endsAt-s.superChats[0].startsAt,10000);
}finally{await fs.rm(process.env.QSS_DATA_DIR,{recursive:true,force:true})}
});

test('gift recipients retain their own welcome identity rather than the gifter',()=>{
 const [e]=items({for:'youtube_account',type:'subscription',message:[{name:'New Member',gifter:'Generous Fan',channelId:'UC1234567890123456789012',profileImageUrl:'https://yt3.ggpht.com/member',_id:'gift-recipient'}]});
 assert.equal(e.name,'Generous Fan');assert.equal(e.memberName,'New Member');assert.equal(e.memberChannelId,'UC1234567890123456789012');assert.equal(e.memberAvatarUrl,'https://yt3.ggpht.com/member');assert.equal(e.giftBatch,false);
});
test('new and gifted memberships share the ten-second queue with Super Chats without duplicate alerts',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 process.env.QSS_DATA_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'qss-member-test-'));const state=require('../lib/qss-state');
 try{
  const e={kind:'membership',label:'NEW MEMBER',name:'Member',memberName:'Member',memberAvatarUrl:'https://yt3.ggpht.com/member',value:'MEMBER',eventId:'member-1'};
  await state.ingestEvent(e);await state.ingestEvent(e);await state.ingestEvent({...e,eventId:'gift-1',label:'GIFTED MEMBERS',giftBatch:true,value:'5 GIFTS'});await state.ingestEvent({kind:'superchat',label:'SUPERCHAT',name:'Donor',value:'$5.00',eventId:'chat-1'});
  const s=await state.readState();assert.equal(s.superChats.length,3);assert.equal(s.superChats[0].kind,'membership');assert.equal(s.superChats[0].avatarUrl,'https://yt3.ggpht.com/member');assert.equal(s.superChats[1].giftBatch,true);assert.equal(s.superChats[2].kind,'superchat');
  s.superChats.forEach((card,i)=>{assert.equal(card.endsAt-card.startsAt,10000);if(i)assert.equal(card.startsAt,s.superChats[i-1].endsAt)});
 }finally{await fs.rm(process.env.QSS_DATA_DIR,{recursive:true,force:true})}
});
