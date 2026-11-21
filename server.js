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
`);
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

app.get('/api/status',(req,res)=>res.json({telegram:botReady?'configured':'not_configured',storage:s3Ready?'configured':'not_configured',adSeconds:Number(process.env.AD_SECONDS||10),messageTtlMinutes:Number(process.env.MESSAGE_TTL_MINUTES||60)}));
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
app.post('/api/delivery-token',(req,res)=>{
 const {videoId,chatId}=req.body||{};
 if(!videoId||!chatId)return res.status(400).json({error:'videoId and Telegram chatId are required'});
 const v=db.prepare("SELECT id FROM videos WHERE id=? AND status='published'").get(videoId);if(!v)return res.status(404).json({error:'Video unavailable'});
 const token=nanoid(40), expires=Date.now()+10*60*1000;
 db.prepare('INSERT INTO delivery_tokens(token_hash,video_id,chat_id,expires_at) VALUES(?,?,?,?)').run(hash(token),videoId,String(chatId),expires);
 res.json({token,signature:sign(`${token}.${videoId}.${chatId}`),expiresAt:expires});
});
async function telegram(method,body){const r=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!j.ok)throw new Error(j.description||'Telegram API error');return j.result;}
app.post('/api/deliver',async(req,res)=>{
 if(!botReady)return res.status(503).json({error:'Telegram bot is not configured yet.'});
 const {token,signature,videoId,chatId}=req.body||{};
 if(!token||!signature||signature!==sign(`${token}.${videoId}.${chatId}`))return res.status(403).json({error:'Invalid delivery token'});
 const row=db.prepare('SELECT * FROM delivery_tokens WHERE token_hash=?').get(hash(token));
 if(!row||row.used_at||row.expires_at<Date.now()||row.video_id!==videoId||row.chat_id!==String(chatId))return res.status(403).json({error:'Token expired or already used'});
 const video=db.prepare("SELECT * FROM videos WHERE id=? AND status='published'").get(videoId);if(!video)return res.status(404).json({error:'Video unavailable'});
 if(!video.object_key)return res.status(409).json({error:'Video file is not connected to object storage yet.'});
 // For private S3 storage, create a short-lived GET URL here before Telegram sendVideo.
 const fileUrl=process.env.S3_PUBLIC_BASE_URL?`${process.env.S3_PUBLIC_BASE_URL.replace(/\/$/,'')}/${video.object_key}`:null;
 if(!fileUrl)return res.status(503).json({error:'Configure S3_PUBLIC_BASE_URL or implement a private signed GET URL before enabling delivery.'});
 try{
  db.prepare('UPDATE delivery_tokens SET used_at=? WHERE token_hash=?').run(Date.now(),hash(token));
  const sent=await telegram('sendVideo',{chat_id:chatId,video:fileUrl,caption:video.title});
  const id=nanoid(), deleteAt=Date.now()+Number(process.env.MESSAGE_TTL_MINUTES||60)*60000;
  db.prepare('INSERT INTO deliveries(id,video_id,chat_id,message_id,delete_at,status) VALUES(?,?,?,?,?,?)').run(id,videoId,String(chatId),sent.message_id,deleteAt,'sent');
  audit('video_delivered',`${videoId}:${chatId}`);res.json({ok:true,deleteAt});
 }catch(e){res.status(502).json({error:'Telegram delivery failed',detail:e.message});}
});
async function processDeletes(){
 if(!botReady)return;
 const due=db.prepare("SELECT * FROM deliveries WHERE status='sent' AND delete_at<=? LIMIT 50").all(Date.now());
 for(const d of due){try{await telegram('deleteMessage',{chat_id:d.chat_id,message_id:d.message_id});db.prepare("UPDATE deliveries SET status='deleted' WHERE id=?").run(d.id);}catch(e){db.prepare("UPDATE deliveries SET status='delete_failed',error=? WHERE id=?").run(e.message,d.id);}}
}
cron.schedule('* * * * *',processDeletes);
app.get('/health',(req,res)=>res.json({ok:true}));
app.listen(PORT,()=>console.log(`CineNova Hub listening on ${PORT}`));
