const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const ENC_KEY_RAW = process.env.DATA_ENCRYPTION_KEY || '';
const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'fitjess-inquiries.json');
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 160000;
const submissionRate = new Map();
const loginRate = new Map();

if (!ADMIN_PASSWORD || !SESSION_SECRET || !ENC_KEY_RAW) {
  console.warn('Missing one or more security environment variables.');
}

function encKey() {
  try { const b = Buffer.from(ENC_KEY_RAW, 'base64'); if (b.length === 32) return b; } catch {}
  return crypto.createHash('sha256').update(ENC_KEY_RAW).digest();
}

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({version:1,records:[]}, null, 2));
}
function readStore() { ensureStore(); return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
function writeStore(store) {
  ensureStore(); const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2)); fs.renameSync(tmp, DATA_FILE);
}
function encrypt(obj) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return {iv:iv.toString('base64'), tag:cipher.getAuthTag().toString('base64'), data:encrypted.toString('base64')};
}
function decrypt(rec) {
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(rec.iv,'base64'));
  d.setAuthTag(Buffer.from(rec.tag,'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(rec.data,'base64')), d.final()]).toString('utf8'));
}
function json(res, code, obj, headers={}) { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}); res.end(JSON.stringify(obj)); }
function text(res, code, body, type='text/plain; charset=utf-8') { res.writeHead(code, {'Content-Type':type,'Cache-Control':'no-store'}); res.end(body); }
function serve(res, file, type) { try { const b=fs.readFileSync(path.join(PUBLIC,file)); res.writeHead(200, {'Content-Type':type,'Cache-Control':file==='logo.png'?'public,max-age=86400':'no-store'}); res.end(b); } catch { text(res,404,'Not found'); } }
function body(req) { return new Promise((resolve,reject)=>{ let s=''; req.on('data',c=>{s+=c;if(s.length>MAX_BODY) reject(new Error('Request too large'));}); req.on('end',()=>{try{resolve(s?JSON.parse(s):{});}catch{reject(new Error('Invalid request'));}}); req.on('error',reject); }); }
function ip(req){ return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim(); }
function withinLimit(map,key,max,windowMs){ const now=Date.now(); const arr=(map.get(key)||[]).filter(t=>now-t<windowMs); if(arr.length>=max){map.set(key,arr);return false;} arr.push(now);map.set(key,arr);return true; }
function clean(v,max=500){ return String(v??'').trim().slice(0,max); }
function arr(v,maxItems=20){ return Array.isArray(v)?v.map(x=>clean(x,120)).filter(Boolean).slice(0,maxItems):[]; }
function cookies(req){ return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),decodeURIComponent(x.slice(i+1))]})); }
function signSession() { const payload=Buffer.from(JSON.stringify({exp:Date.now()+7*24*3600e3,n:crypto.randomBytes(8).toString('hex')})).toString('base64url'); const sig=crypto.createHmac('sha256',SESSION_SECRET).update(payload).digest('base64url'); return payload+'.'+sig; }
function validSession(req){ try{const token=cookies(req).fitjess_session||'';const [p,s]=token.split('.');if(!p||!s)return false;const expect=crypto.createHmac('sha256',SESSION_SECRET).update(p).digest('base64url');if(!crypto.timingSafeEqual(Buffer.from(s),Buffer.from(expect)))return false;const d=JSON.parse(Buffer.from(p,'base64url').toString());return d.exp>Date.now();}catch{return false;} }
function requireAdmin(req,res){ if(!validSession(req)){json(res,401,{ok:false,error:'Unauthorized'});return false;} return true; }
function csvEscape(v){ const s=Array.isArray(v)?v.join('; '):String(v??''); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }

function normalizeInquiry(x){
  const age=Number(x.age)||0;
  return {
    name:clean(x.name,100), age, email:clean(x.email,160), phone:clean(x.phone,40), preferredContact:clean(x.preferredContact,40),
    height:clean(x.height,50), weight:clean(x.weight,50), goalWeight:clean(x.goalWeight,50),
    services:arr(x.services), trainingFormat:arr(x.trainingFormat), currentActivity:clean(x.currentActivity,1200), trainingExperience:clean(x.trainingExperience,1200),
    goals:arr(x.goals), goalsOther:clean(x.goalsOther,1200), motivation:clean(x.motivation,1200), barriers:clean(x.barriers,1200), weeklyFrequency:clean(x.weeklyFrequency,80),
    availability:clean(x.availability,1500), equipment:clean(x.equipment,700), startTimeline:clean(x.startTimeline,80),
    currentDiet:clean(x.currentDiet,1800), mealPrepInterest:clean(x.mealPrepInterest,30), dietaryRestrictions:clean(x.dietaryRestrictions,1200), foodDislikes:clean(x.foodDislikes,900), mealPrepDetails:clean(x.mealPrepDetails,900),
    healthConditions:clean(x.healthConditions,1800), injuriesLimitations:clean(x.injuriesLimitations,1800), surgeries:clean(x.surgeries,1200), medications:clean(x.medications,1200), physicianRestrictions:clean(x.physicianRestrictions,1200),
    pregnantPostpartum:clean(x.pregnantPostpartum,80), painSymptoms:clean(x.painSymptoms,1200),
    aboutMe:clean(x.aboutMe,1800), occupationSchedule:clean(x.occupationSchedule,1200), sleepStress:clean(x.sleepStress,1200), kidsCaregiving:clean(x.kidsCaregiving,1000),
    consultationType:clean(x.consultationType,60), consultationDate:clean(x.consultationDate,30), consultationTime:clean(x.consultationTime,60), consultationAlt:clean(x.consultationAlt,120), timezone:clean(x.timezone,80),
    referral:clean(x.referral,100), additionalNotes:clean(x.additionalNotes,1400), guardianName:age<18?clean(x.guardianName,100):'', guardianPhone:age<18?clean(x.guardianPhone,40):'',
    consent:!!x.consent
  };
}
function validate(d){
  const errors=[];
  if(!d.name)errors.push('Name is required'); if(!d.email||!/^\S+@\S+\.\S+$/.test(d.email))errors.push('Valid email is required');
  if(!d.phone)errors.push('Phone is required'); if(!d.age||d.age<14||d.age>100)errors.push('Age must be between 14 and 100');
  if(d.age<18&&(!d.guardianName||!d.guardianPhone))errors.push('Guardian information is required for clients under 18');
  if(!d.goals.length&&!d.goalsOther)errors.push('Please tell us at least one fitness goal'); if(!d.availability)errors.push('Training availability is required');
  if(!d.consultationDate||!d.consultationTime)errors.push('Please request a consultation date and time'); if(!d.consent)errors.push('Consent is required');
  return errors;
}

const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(req.method==='GET'&&u.pathname==='/health')return json(res,200,{ok:true,app:'FitJess4U Inquiry'});
  if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/inquire'))return serve(res,'index.html','text/html; charset=utf-8');
  if(req.method==='GET'&&u.pathname==='/admin')return serve(res,'admin.html','text/html; charset=utf-8');
  if(req.method==='GET'&&u.pathname==='/logo.png')return serve(res,'logo.png','image/png');

  if(req.method==='POST'&&u.pathname==='/api/inquiries'){
    if(!withinLimit(submissionRate,ip(req),5,60*60e3))return json(res,429,{ok:false,error:'Too many submissions. Please try again later.'});
    try{
      const raw=await body(req); if(clean(raw.website,200))return json(res,200,{ok:true});
      const d=normalizeInquiry(raw); const errors=validate(d); if(errors.length)return json(res,400,{ok:false,errors});
      const now=new Date().toISOString(); const id=crypto.randomUUID();
      const full={id,createdAt:now,updatedAt:now,status:'new',adminNotes:'',...d};
      const store=readStore(); store.records.unshift({id,createdAt:now,...encrypt(full)}); writeStore(store);
      return json(res,201,{ok:true,id,message:'Inquiry received. We’ll follow up soon to confirm your consultation request.'});
    }catch(e){console.error(e);return json(res,500,{ok:false,error:'Unable to submit right now. Please try again.'});}
  }

  if(req.method==='POST'&&u.pathname==='/api/admin/login'){
    if(!withinLimit(loginRate,ip(req),8,15*60e3))return json(res,429,{ok:false,error:'Too many login attempts. Try again later.'});
    try{const b=await body(req);const a=Buffer.from(String(b.password||'')),c=Buffer.from(ADMIN_PASSWORD);const ok=a.length===c.length&&crypto.timingSafeEqual(a,c);if(!ok)return json(res,401,{ok:false,error:'Incorrect password'});const token=signSession();return json(res,200,{ok:true},{'Set-Cookie':`fitjess_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`});}catch{return json(res,400,{ok:false,error:'Login failed'});}
  }
  if(req.method==='POST'&&u.pathname==='/api/admin/logout')return json(res,200,{ok:true},{'Set-Cookie':'fitjess_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'});
  if(req.method==='GET'&&u.pathname==='/api/admin/me')return validSession(req)?json(res,200,{ok:true}):json(res,401,{ok:false});
  if(u.pathname.startsWith('/api/admin/')&&!requireAdmin(req,res))return;

  if(req.method==='GET'&&u.pathname==='/api/admin/inquiries'){
    try{const records=readStore().records.map(r=>{const d=decrypt(r);return {id:d.id,createdAt:d.createdAt,updatedAt:d.updatedAt,status:d.status,name:d.name,email:d.email,phone:d.phone,goals:d.goals,services:d.services,consultationDate:d.consultationDate,consultationTime:d.consultationTime,adminNotes:d.adminNotes};});return json(res,200,{ok:true,records});}catch(e){console.error(e);return json(res,500,{ok:false,error:'Could not load inquiries'});}
  }
  if(req.method==='GET'&&/^\/api\/admin\/inquiries\/[\w-]+$/.test(u.pathname)){
    const id=u.pathname.split('/').pop();try{const rec=readStore().records.find(r=>r.id===id);if(!rec)return json(res,404,{ok:false,error:'Not found'});return json(res,200,{ok:true,record:decrypt(rec)});}catch{return json(res,500,{ok:false,error:'Could not load inquiry'});}
  }
  if(req.method==='PATCH'&&/^\/api\/admin\/inquiries\/[\w-]+$/.test(u.pathname)){
    const id=u.pathname.split('/').pop();try{const b=await body(req),store=readStore(),i=store.records.findIndex(r=>r.id===id);if(i<0)return json(res,404,{ok:false,error:'Not found'});const d=decrypt(store.records[i]);d.status=['new','contacted','consultation-booked','client','closed'].includes(b.status)?b.status:d.status;d.adminNotes=clean(b.adminNotes??d.adminNotes,3000);d.updatedAt=new Date().toISOString();store.records[i]={id:d.id,createdAt:d.createdAt,...encrypt(d)};writeStore(store);return json(res,200,{ok:true,record:d});}catch{return json(res,500,{ok:false,error:'Could not update inquiry'});}
  }
  if(req.method==='GET'&&u.pathname==='/api/admin/export.csv'){
    try{const rows=readStore().records.map(r=>decrypt(r));const cols=['createdAt','status','name','age','email','phone','preferredContact','height','weight','goalWeight','services','trainingFormat','goals','goalsOther','motivation','barriers','weeklyFrequency','availability','currentActivity','trainingExperience','currentDiet','mealPrepInterest','dietaryRestrictions','foodDislikes','healthConditions','injuriesLimitations','surgeries','medications','physicianRestrictions','painSymptoms','pregnantPostpartum','aboutMe','occupationSchedule','sleepStress','kidsCaregiving','consultationType','consultationDate','consultationTime','consultationAlt','timezone','referral','additionalNotes','adminNotes'];const csv=[cols.join(','),...rows.map(r=>cols.map(k=>csvEscape(r[k])).join(','))].join('\n');res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="fitjess4u-inquiries.csv"','Cache-Control':'no-store'});return res.end(csv);}catch{return json(res,500,{ok:false,error:'Export failed'});}
  }
  return text(res,404,'Not found');
});
server.listen(PORT,()=>{ensureStore();console.log('FitJess4U inquiry app listening on',PORT);});