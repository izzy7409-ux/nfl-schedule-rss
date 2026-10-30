'use strict';
const {readConfig,applyAction}=require('../lib/qss-state');
const {verify,sample}=require('../lib/studio-bridge');
module.exports=async(req,res)=>{
 if(req.method!=='POST')return res.status(405).json({ok:false});
 const c=await readConfig(),token=String(req.headers.authorization||'').replace(/^Bearer /,'');
 if(!verify(token,c.youtubeChannelId,c.studioBridgeGeneration,process.env.QSS_STREAMLABS_ENCRYPTION_KEY))return res.status(403).json({ok:false,error:'Generate a new Studio connection code in your QSS remote.'});
 if(!sample(req.body||{},c.youtubeChannelId))return res.status(400).json({ok:false,error:'Open the correct channel’s live subscriber-count page.'});
 await applyAction({action:'setExactSubscribers',subsCurrent:req.body.count});return res.json({ok:true,count:req.body.count});
};
