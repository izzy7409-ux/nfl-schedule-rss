'use strict';
const {readConfig,saveConfig}=require('../lib/qss-state');
const {equal}=require('../lib/streamlabs-auth');
const {issue,newGeneration}=require('../lib/studio-bridge');
module.exports=async(req,res)=>{
 if(req.method!=='POST')return res.status(405).json({ok:false});
 if(!process.env.QSS_CONTROL_SECRET||!equal(req.headers['x-control-key']||'',process.env.QSS_CONTROL_SECRET))return res.status(403).json({ok:false,error:'Open your private QSS remote.'});
 const c=await readConfig(),generation=newGeneration();await saveConfig({studioBridgeGeneration:generation});
 return res.json({ok:true,code:issue(c.youtubeChannelId,generation,process.env.QSS_STREAMLABS_ENCRYPTION_KEY),channelId:c.youtubeChannelId});
};
