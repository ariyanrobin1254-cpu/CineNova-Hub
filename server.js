import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import SQLiteStoreFactory from 'connect-sqlite3';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import multer from 'multer';
import cron from 'node-cron';
import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const app=express(), PORT=Number(process.env.PORT||3000);
const dataDir=path.resolve('./data'); fs.mkdirSync(dataDir,{recursive:true});
const db=new Database(process.env.DATABASE_PATH||'./data/cinenova.sqlite');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS videos(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT DEFAULT '',category TEXT DEFAULT 'General',object_key TEXT,thumbnail_url TEXT DEFAULT '',mime_type TEXT DEFAULT '',status TEXT DEFAULT 'draft',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS delivery_tokens(token_hash TEXT PRIMARY KEY,video_id TEXT NOT NULL,chat_id TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER);
CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,video_id TEXT NOT NULL,chat_id TEXT NOT NULL,message_id INTEGER,delete_at INTEGER,status TEXT DEFAULT 'queued',error TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,action TEXT NOT NULL,details TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS telegram_users(user_id TEXT PRIMARY KEY,started_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS telegram_updates(update_id INTEGER PRIMARY KEY,received_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
// Backward-compatible schema migrations for existing Render databases.
const videoCols=db.prepare('PRAGMA table_info(videos)').all().map(x=>x.name);
for (const [name,type] of [['telegram_file_id','TEXT'],['telegram_message_id','INTEGER'],['telegram_chat_id','TEXT']]) {
 if (!videoCols.includes(name)) db.exec(`ALTER TABLE videos ADD COLUMN ${name} ${type}`);
}
const SQLiteStore=SQLiteStoreFactory(session);
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'1mb'}));
app.use(session({store:new SQLiteStore({db:'sessions.sqlite',dir:dataDir}),secret:process.env.SESSION_SECRET||'dev-only-change-this',resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:8*60*60*1000}}));
app.use(express.static('public'));
const admin=(req,res,next)=>req.session?.admin?next():res.status(401).json({error:'Admin login required'});
const audit=(action,details='')=>db.prepare('INSERT INTO audit(id,action,details) VALUES(?,?,?)').run(nanoid(),action,String(details));
const s3Ready=!!(process.env.S3_BUCKET&&process.env.S3_ACCESS_KEY_ID&&process.env.S3_SECRET_ACCESS_KEY);
const s3=s3Ready?new S3Client({region:process.env.S3_REGION||'auto',endpoint:process.env.S3_ENDPOINT||undefined,forcePathStyle:!!process.env.S3_ENDPOINT,credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY}}):null;
const botReady=!!process.env.TELEGRAM_BOT_TOKEN;
const signSecret=process.env.SIGNING_SECRET||'dev-only-change-this';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const sign=s=>crypto.createHmac('sha256',signSecret).update(s).digest('hex');
const webhookSecret=process.env.TELEGRAM_WEBHOOK_SECRET||'';
const webAppUrl=process.env.WEB_APP_URL||'';
function verifyTelegramInitData(initData){
 if(!botReady||!initData) return null;
 const params=new URLSearchParams(initData), hashValue=params.get('hash');
 if(!hashValue) return null;
 params.delete('hash');
 const dataCheck=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 const secret=crypto.createHmac('sha256','WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
 const expected=crypto.createHmac('sha256',secret).update(dataCheck).digest('hex');
 const a=Buffer.from(expected,'hex'), b=Buffer.from(hashValue,'hex');
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) return null;
 const authDate=Number(params.get('auth_date')||0);
 if(!authDate||Math.abs(Date.now()/1000-authDate)>86400) return null;
 try { return JSON.parse(params.get('user')||'null'); } catch { return null; }
}


app.get('/api/status',(req,res)=>res.json({telegram:botReady?'configured':'not_configured',webhook:webhookSecret&&webAppUrl?'ready_for_setup':'missing_environment',storage:s3Ready?'configured':'not_configured',adSeconds:Number(process.env.AD_SECONDS||10),messageTtlMinutes:Number(process.env.MESSAGE_TTL_MINUTES||60)}));
app.post('/api/admin/login',async(req,res)=>{
 const {username,password}=req.body||{};
 const expected=process.env.ADMIN_USERNAME||'admin';
 const stored=process.env.ADMIN_PASSWORD_HASH;
 if(username!==expected||!stored||!(await bcrypt.compare(password||'',stored))) return res.status(401).json({error:'Invalid credentials. Set ADMIN_PASSWORD_HASH in .env.'});
 req.session.admin=true; audit('admin_login',username); res.json({ok:true});
});
app.post('/api/admin/logout',admin,(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/admin/summary',admin,(req,res)=>res.json({
 videos:db.prepare('SELECT COUNT(*) n FROM videos').get().n,
 active:db.prepare("SELECT COUNT(*) n FROM videos WHERE status='published'").get().n,
 deliveries:db.prepare('SELECT COUNT(*) n FROM deliveries').get().n,
 pendingDeletes:db.prepare("SELECT COUNT(*) n FROM deliveries WHERE status='sent'").get().n,
 recent:db.prepare('SELECT * FROM deliveries ORDER BY created_at DESC LIMIT 8').all(),
 videosList:db.prepare('SELECT * FROM videos ORDER BY created_at DESC').all(),
 audit:db.prepare('SELECT * FROM audit ORDER BY created_at DESC LIMIT 10').all()
}));
app.get('/api/videos',(req,res)=>res.json(db.prepare("SELECT id,title,description,category,thumbnail_url FROM videos WHERE status='published' ORDER BY created_at DESC").all()));
app.post('/api/admin/videos',admin,(req,res)=>{
 const {title,description,category,thumbnail_url,object_key,mime_type,status='draft'}=req.body||{};
 if(!title?.trim()) return res.status(400).json({error:'Title is required'});
 const id=nanoid(); db.prepare('INSERT INTO videos(id,title,description,category,thumbnail_url,object_key,mime_type,status) VALUES(?,?,?,?,?,?,?,?)').run(id,title.trim(),description||'',category||'General',thumbnail_url||'',object_key||'',mime_type||'',status);
 audit('video_created',id); res.json({id});
});
app.delete('/api/admin/videos/:id',admin,(req,res)=>{db.prepare('DELETE FROM videos WHERE id=?').run(req.params.id);audit('video_deleted',req.params.id);res.json({ok:true})});
app.post('/api/admin/upload-url',admin,async(req,res)=>{
 if(!s3Ready)return res.status(503).json({error:'Object storage is not configured. Set S3_* variables.'});
 const {filename,contentType}=req.body||{};
 if(!filename||!/^video\/(mp4|webm|quicktime)$/.test(contentType||''))return res.status(400).json({error:'Supported video MIME types: mp4, webm, quicktime.'});
 const key=`videos/${nanoid()}-${path.basename(filename).replace(/[^a-zA-Z0-9._-]/g,'_')}`;
 const url=await getSignedUrl(s3,new PutObjectCommand({Bucket:process.env.S3_BUCKET,Key:key,ContentType:contentType}),{expiresIn:300});
 res.json({url,key,expiresIn:300});
});
app.get('/api/video/:id',(req,res)=>{const v=db.prepare("SELECT id,title,description,category,thumbnail_url FROM videos WHERE id=? AND status='published'").get(req.params.id);if(!v)return res.status(404).json({error:'Video not found'});res.json(v)});
// Telegram webhook: receives /start messages and new channel video posts.
app.post('/telegram/webhook',async(req,res)=>{
 if(!webhookSecret || req.get('X-Telegram-Bot-Api-Secret-Token')!==webhookSecret) return res.sendStatus(403);
 const update=req.body||{};
 try {
  if(update.update_id!=null){
   const seen=db.prepare('SELECT 1 FROM telegram_updates WHERE update_id=?').get(update.update_id);
   if(seen) return res.json({ok:true,duplicate:true});
   db.prepare('INSERT INTO telegram_updates(update_id) VALUES(?)').run(update.update_id);
  }
  const msg=update.message;
  if(msg?.text?.startsWith('/start') && msg.chat?.type==='private'){
   const uid=String(msg.from?.id||msg.chat.id);
   db.prepare('INSERT OR IGNORE INTO telegram_users(user_id) VALUES(?)').run(uid);
   const reply={chat_id:msg.chat.id,text:'স্বাগতম CineNova Hub-এ! ভিডিও দেখতে নিচের বাটনে চাপ দিন।'};
   if(webAppUrl) reply.reply_markup={inline_keyboard:[[{text:'Open CineNova Hub',web_app:{url:webAppUrl}}]]};
   await telegram('sendMessage',reply);
  }
  const post=update.channel_post;
  if(post && String(post.chat?.id)===String(process.env.TELEGRAM_CHANNEL_ID||'')){
   const media=post.video || (post.document?.mime_type?.startsWith('video/')?post.document:null);
   if(media?.file_id){
    const raw=(post.caption||'').trim();
    const lines=raw.split('\n');
    const title=(lines.shift()||'Untitled video').trim().slice(0,180);
    const description=lines.join('\n').trim().slice(0,2000);
    const id=nanoid();
    db.prepare(`INSERT INTO videos(id,title,description,category,thumbnail_url,object_key,mime_type,status,telegram_file_id,telegram_message_id,telegram_chat_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,title,description,'General','', '',media.mime_type||'video/mp4','published',media.file_id,post.message_id,String(post.chat.id));
    audit('channel_video_synced',`${id}:${post.message_id}`);
   }
  }
  res.json({ok:true});
 } catch(e){ console.error('Telegram webhook error:',e.message); res.sendStatus(500); }
});

app.post('/api/telegram/auth',(req,res)=>{
 const user=verifyTelegramInitData(req.body?.initData);
 if(!user?.id) return res.status(401).json({error:'Telegram verification failed. Open this page from the bot.'});
 const linked=db.prepare('SELECT 1 FROM telegram_users WHERE user_id=?').get(String(user.id));
 if(!linked) return res.status(403).json({error:'প্রথমে Telegram Bot-এ /start পাঠান।'});
 res.json({ok:true,user:{id:String(user.id),first_name:user.first_name||''}});
});

app.post('/api/deliver',async(req,res)=>{
 if(!botReady)return res.status(503).json({error:'Telegram bot is not configured.'});
 const user=verifyTelegramInitData(req.body?.initData);
 if(!user?.id)return res.status(401).json({error:'Telegram identity verification failed.'});
 const chatId=String(user.id);
 if(!db.prepare('SELECT 1 FROM telegram_users WHERE user_id=?').get(chatId)) return res.status(403).json({error:'প্রথমে Bot-এ /start পাঠান।'});
 const video=db.prepare("SELECT id,title,telegram_file_id FROM videos WHERE id=? AND status='published'").get(req.body?.videoId);
 if(!video)return res.status(404).json({error:'Video unavailable'});
 if(!video.telegram_file_id)return res.status(409).json({error:'এই ভিডিওর Telegram file_id নেই।'});
 try{
  const sent=await telegram('sendVideo',{chat_id:chatId,video:video.telegram_file_id,caption:video.title,protect_content:true});
  const id=nanoid(), deleteAt=Date.now()+Number(process.env.MESSAGE_TTL_MINUTES||60)*60000;
  db.prepare('INSERT INTO deliveries(id,video_id,chat_id,message_id,delete_at,status) VALUES(?,?,?,?,?,?)').run(id,video.id,chatId,sent.message_id,deleteAt,'sent');
  audit('video_delivered',`${video.id}:${chatId}`);res.json({ok:true,deleteAt});
 }catch(e){res.status(502).json({error:'Telegram delivery failed',detail:e.message});}
});

async function processDeletes(){
 if(!botReady)return;
 const due=db.prepare("SELECT * FROM deliveries WHERE status='sent' AND delete_at<=? LIMIT 50").all(Date.now());
 for(const d of due){try{await telegram('deleteMessage',{chat_id:d.chat_id,message_id:d.message_id});db.prepare("UPDATE deliveries SET status='deleted' WHERE id=?").run(d.id);}catch(e){db.prepare("UPDATE deliveries SET status='delete_failed',error=? WHERE id=?").run(e.message,d.id);}}
}
cron.schedule('* * * * *',processDeletes);
app.get('/health',(req,res)=>res.json({ok:true}));
app.listen(PORT,async()=>{
 console.log(`CineNova Hub listening on ${PORT}`);
 if(botReady && webhookSecret && process.env.WEBHOOK_URL){
  try { await telegram('setWebhook',{url:`${process.env.WEBHOOK_URL.replace(/\/$/,'')}/telegram/webhook`,secret_token:webhookSecret,allowed_updates:['message','channel_post']}); console.log('Telegram webhook registered'); }
  catch(e){ console.error('Telegram webhook setup failed:',e.message); }
 }
});
