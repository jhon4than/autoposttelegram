import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_FILE_MB = Math.max(1, Number(process.env.MAX_FILE_MB) || 2000);
const TELEGRAM_API_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const LOCAL_BOT_API = !TELEGRAM_API_BASE.includes('api.telegram.org');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'autopost.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS destinations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, chat_id TEXT NOT NULL, bot_token TEXT NOT NULL, active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS media (id INTEGER PRIMARY KEY, original_name TEXT NOT NULL, stored_name TEXT UNIQUE NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, caption TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS deliveries (id INTEGER PRIMARY KEY, media_id INTEGER NOT NULL, destination_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', telegram_message_id TEXT, error TEXT, sent_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(media_id,destination_id), FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE, FOREIGN KEY(destination_id) REFERENCES destinations(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY CHECK(id=1), destination_id INTEGER, daily_limit INTEGER DEFAULT 20, interval_minutes INTEGER DEFAULT 5, enabled INTEGER DEFAULT 0, sent_today INTEGER DEFAULT 0, day_key TEXT, next_run_at TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(destination_id) REFERENCES destinations(id));
INSERT OR IGNORE INTO schedules(id) VALUES(1);
`);

const adminEmail = (process.env.ADMIN_EMAIL || 'jhon4than1995@gmail.com').toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) throw new Error('ADMIN_PASSWORD is required');
if (!db.prepare('SELECT id FROM users WHERE email=?').get(adminEmail)) {
  db.prepare('INSERT INTO users(email,password_hash) VALUES(?,?)').run(adminEmail, bcrypt.hashSync(adminPassword, 12));
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

const upload = multer({ storage: multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
}), limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 100 }, fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/')) });

const tokenHash = t => crypto.createHash('sha256').update(t).digest('hex');
function auth(req, res, next) {
  const token = req.cookies.apt_session;
  const row = token && db.prepare("SELECT * FROM sessions WHERE token_hash=? AND expires_at > datetime('now')").get(tokenHash(token));
  if (!row) return req.path.startsWith('/api/') ? res.status(401).json({ error: 'Sessão expirada' }) : res.redirect('/login');
  req.userId = row.user_id; next();
}
function publicStats() {
  const totals = db.prepare("SELECT COUNT(*) total, COALESCE(SUM(size),0) bytes FROM media").get();
  const sent = db.prepare("SELECT COUNT(*) n FROM deliveries WHERE status='sent'").get().n;
  const pending = db.prepare("SELECT COUNT(*) n FROM deliveries WHERE status='pending'").get().n;
  return { ...totals, sent, pending };
}

app.get('/api/health', (_req,res)=>res.json({ok:true,localBotApi:LOCAL_BOT_API,maxFileMb:MAX_FILE_MB}));
app.get('/login', (req,res)=> req.cookies.apt_session ? res.redirect('/') : res.sendFile(path.join(__dirname,'public','login.html')));
app.post('/api/login', (req,res)=>{
  const user=db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body.email||'').toLowerCase());
  if(!user || !bcrypt.compareSync(String(req.body.password||''),user.password_hash)) return res.status(401).json({error:'E-mail ou senha inválidos'});
  const token=crypto.randomBytes(32).toString('hex');
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,datetime('now','+30 days'))").run(tokenHash(token),user.id);
  res.cookie('apt_session',token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',maxAge:30*864e5}).json({ok:true});
});
app.post('/api/logout',auth,(req,res)=>{db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(req.cookies.apt_session));res.clearCookie('apt_session').json({ok:true});});
app.get('/',auth,(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/api/state',auth,(_req,res)=>{
  const media=db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM deliveries d WHERE d.media_id=m.id AND d.status='sent') sent_count FROM media m ORDER BY m.id DESC LIMIT 300`).all();
  const destinations=db.prepare(`SELECT id,name,chat_id,active,created_at FROM destinations ORDER BY id DESC`).all();
  const schedule=db.prepare('SELECT * FROM schedules WHERE id=1').get();
  res.json({stats:publicStats(),media,destinations,schedule});
});
app.post('/api/media',auth,upload.array('files',100),(req,res)=>{
  const ins=db.prepare('INSERT INTO media(original_name,stored_name,mime_type,size) VALUES(?,?,?,?)');
  const tx=db.transaction(files=>files.map(f=>ins.run(f.originalname,f.filename,f.mimetype,f.size).lastInsertRowid));
  res.json({ok:true,ids:tx(req.files||[])});
});
app.get('/api/media/:id/file',auth,(req,res)=>{const m=db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id);if(!m)return res.sendStatus(404);res.type(m.mime_type).sendFile(path.join(UPLOAD_DIR,m.stored_name));});
app.delete('/api/media/:id',auth,(req,res)=>{const m=db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id);if(!m)return res.sendStatus(404);db.prepare('DELETE FROM media WHERE id=?').run(m.id);try{fs.unlinkSync(path.join(UPLOAD_DIR,m.stored_name))}catch{}res.json({ok:true});});
app.post('/api/destinations',auth,async(req,res)=>{
  const {name,chatId,botToken}=req.body;
  if(!name||!chatId||!botToken)return res.status(400).json({error:'Preencha nome, grupo e token'});
  try{const r=await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/getMe`);const j=await r.json();if(!j.ok)throw new Error(j.description);}
  catch(e){return res.status(400).json({error:`Token inválido: ${e.message}`});}
  const id=db.prepare('INSERT INTO destinations(name,chat_id,bot_token) VALUES(?,?,?)').run(name,chatId,botToken).lastInsertRowid;
  res.json({ok:true,id});
});
app.delete('/api/destinations/:id',auth,(req,res)=>{db.prepare('DELETE FROM destinations WHERE id=?').run(req.params.id);res.json({ok:true});});
app.post('/api/schedule',auth,(req,res)=>{
  const destinationId=Number(req.body.destinationId), daily=Math.max(1,Math.min(500,Number(req.body.dailyLimit)||20)), interval=Math.max(1,Math.min(1440,Number(req.body.intervalMinutes)||5));
  if(!db.prepare('SELECT id FROM destinations WHERE id=?').get(destinationId))return res.status(400).json({error:'Destino inválido'});
  db.prepare(`UPDATE schedules SET destination_id=?,daily_limit=?,interval_minutes=?,enabled=1,sent_today=0,day_key=date('now','localtime'),next_run_at=datetime('now'),updated_at=CURRENT_TIMESTAMP WHERE id=1`).run(destinationId,daily,interval);
  db.prepare(`INSERT OR IGNORE INTO deliveries(media_id,destination_id,status) SELECT id,?,'pending' FROM media`).run(destinationId);
  res.json({ok:true}); setTimeout(tick,50);
});
app.post('/api/schedule/stop',auth,(_req,res)=>{db.prepare('UPDATE schedules SET enabled=0,next_run_at=NULL WHERE id=1').run();res.json({ok:true});});
app.post('/api/destinations/:id/test',auth,async(req,res)=>{const d=db.prepare('SELECT * FROM destinations WHERE id=?').get(req.params.id);if(!d)return res.sendStatus(404);const r=await fetch(`${TELEGRAM_API_BASE}/bot${d.bot_token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:d.chat_id,text:'✅ AutoPost Telegram conectado com sucesso!'})});const j=await r.json();res.status(j.ok?200:400).json(j.ok?{ok:true}:{error:j.description});});

let ticking=false;
async function tick(){
  if(ticking)return; ticking=true;
  try{
    let s=db.prepare('SELECT * FROM schedules WHERE id=1').get();
    if(!s.enabled||!s.destination_id||!s.next_run_at||new Date(s.next_run_at+'Z')>new Date())return;
    const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
    if(s.day_key!==today){db.prepare('UPDATE schedules SET day_key=?,sent_today=0 WHERE id=1').run(today);s={...s,day_key:today,sent_today:0};}
    if(s.sent_today>=s.daily_limit){db.prepare("UPDATE schedules SET next_run_at=datetime('now','+1 day','start of day','+3 hours') WHERE id=1").run();return;}
    const d=db.prepare('SELECT * FROM destinations WHERE id=?').get(s.destination_id);
    const job=db.prepare(`SELECT d.id delivery_id,m.* FROM deliveries d JOIN media m ON m.id=d.media_id WHERE d.destination_id=? AND d.status IN ('pending','failed') ORDER BY CASE d.status WHEN 'pending' THEN 0 ELSE 1 END,d.id LIMIT 1`).get(s.destination_id);
    if(!d||!job){db.prepare('UPDATE schedules SET enabled=0,next_run_at=NULL WHERE id=1').run();return;}
    db.prepare("UPDATE deliveries SET status='sending',error=NULL WHERE id=?").run(job.delivery_id);
    try{
      const method=job.mime_type.startsWith('image/')?'sendPhoto':'sendVideo';const field=method==='sendPhoto'?'photo':'video';
      let r;
      if(LOCAL_BOT_API){
        r=await fetch(`${TELEGRAM_API_BASE}/bot${d.bot_token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:d.chat_id,[field]:`file://${path.join(UPLOAD_DIR,job.stored_name)}`,...(job.caption?{caption:job.caption}:{})})});
      }else{
        const form=new FormData();form.set('chat_id',d.chat_id);if(job.caption)form.set('caption',job.caption);
        const bytes=fs.readFileSync(path.join(UPLOAD_DIR,job.stored_name));form.set(field,new Blob([bytes],{type:job.mime_type}),job.original_name);
        r=await fetch(`${TELEGRAM_API_BASE}/bot${d.bot_token}/${method}`,{method:'POST',body:form});
      }
      const j=await r.json();if(!j.ok)throw new Error(j.description||'Falha no Telegram');
      db.prepare("UPDATE deliveries SET status='sent',telegram_message_id=?,sent_at=CURRENT_TIMESTAMP WHERE id=?").run(String(j.result.message_id),job.delivery_id);
      db.prepare("UPDATE schedules SET sent_today=sent_today+1,next_run_at=datetime('now',? || ' minutes') WHERE id=1").run(`+${s.interval_minutes}`);
    }catch(e){db.prepare("UPDATE deliveries SET status='failed',error=? WHERE id=?").run(String(e.message).slice(0,500),job.delivery_id);db.prepare("UPDATE schedules SET next_run_at=datetime('now','+5 minutes') WHERE id=1").run();}
  }finally{ticking=false;}
}
setInterval(tick,15000);setTimeout(tick,2000);
app.use((err,_req,res,_next)=>{console.error(err);res.status(err.code==='LIMIT_FILE_SIZE'?413:500).json({error:err.code==='LIMIT_FILE_SIZE'?`Arquivo maior que ${MAX_FILE_MB} MB`:err.message||'Erro interno'});});
app.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('AutoPost Telegram online'));
