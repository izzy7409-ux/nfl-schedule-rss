'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {issue,verify,sample}=require('../lib/studio-bridge');
const {exactNumber,channel,choose}=require('../studio-extension/reader');
const id='UCH_KLDuTD-lMnGY1b89kghA',key=Buffer.alloc(32,5).toString('base64');
test('Studio connection token is channel scoped, encrypted, expiring and revocable',()=>{
const token=issue(id,'generation-one',key,1000);assert.equal(verify(token,id,'generation-one',key,2000),true);assert.equal(verify(token,id,'new-generation',key,2000),false);assert.equal(verify(token,'other-channel','generation-one',key,2000),false);assert.equal(verify(token,id,'generation-one',key,31536002000),false);assert.equal(verify(token+'x',id,'generation-one',key,2000),false);
});
test('exact reader rejects rounded numbers, decimals and ambiguous large counts',()=>{
assert.equal(exactNumber('8,752'),8752);assert.equal(exactNumber('8\u202f752'),8752);assert.equal(exactNumber('8752'),8752);for(const s of ['8.75K','8.752','+438','8,75','$8,752',''])assert.equal(exactNumber(s),null);
assert.equal(choose([{count:8752,size:120},{count:438,size:16}]),8752);assert.equal(choose([{count:8752,size:120},{count:4951,size:120}]),null);
assert.equal(channel('https://studio.youtube.com/channel/'+id+'/analytics/tab-overview/period-default/explore?explore_type=SUBSCRIBERS'),id);assert.equal(channel('https://studio.youtube.com/channel/'+id+'/analytics'), '');
});
test('receiver accepts only fresh exact samples from the paired channel',()=>{
const body={channelId:id,count:8752,observedAt:10000};assert.equal(sample(body,id,11000),true);assert.equal(sample({...body,count:8751},id,11000),true);for(const change of [{count:-1},{count:8.75},{channelId:'wrong'},{observedAt:0}])assert.equal(sample({...body,...change},id,90000),false);
});
