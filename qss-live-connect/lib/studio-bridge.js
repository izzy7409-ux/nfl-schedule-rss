'use strict';
const crypto=require('node:crypto');
const {encrypt,decrypt,equal}=require('./streamlabs-auth');
function issue(channelId,generation,encryptionKey,now=Date.now()) {return Buffer.from(JSON.stringify(encrypt({purpose:'studio-count',channelId,generation,expiresAt:now+31536000000},encryptionKey))).toString('base64url')}
function verify(token,channelId,generation,encryptionKey,now=Date.now()) {try{const envelope=JSON.parse(Buffer.from(token,'base64url').toString());if(Buffer.from(JSON.stringify(envelope)).toString('base64url')!==token)return false;const data=decrypt(envelope,encryptionKey);return data.purpose==='studio-count'&&data.channelId===channelId&&equal(data.generation,generation)&&data.expiresAt>now}catch{return false}}
function sample(body,channelId,now=Date.now()){return body.channelId===channelId&&Number.isSafeInteger(body.count)&&body.count>=0&&body.count<=2000000000&&Number.isFinite(body.observedAt)&&Math.abs(now-body.observedAt)<60000}
module.exports={issue,verify,sample,newGeneration:()=>crypto.randomBytes(24).toString('base64url')};
