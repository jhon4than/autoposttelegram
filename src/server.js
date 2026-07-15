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
import { Api, TelegramClient, sessions, utils } from 'teleproto';

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
CREATE TABLE IF NOT EXISTS telegram_accounts (id INTEGER PRIMARY KEY CHECK(id=1), phone TEXT, session_encrypted TEXT NOT NULL, connected_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sources (id INTEGER PRIMARY KEY, peer_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, enabled INTEGER DEFAULT 1, history_limit INTEGER DEFAULT 100, initial_import_done INTEGER DEFAULT 0, last_message_id INTEGER DEFAULT 0, last_checked_at TEXT, last_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS source_imports (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, message_id INTEGER NOT NULL, media_id INTEGER, imported_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(source_id,message_id), FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE, FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS source_failures (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, message_id INTEGER NOT NULL, attempts INTEGER DEFAULT 1, next_retry_at TEXT NOT NULL, last_error TEXT, UNIQUE(source_id,message_id), FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS source_logs (id INTEGER PRIMARY KEY, source_id INTEGER, level TEXT NOT NULL DEFAULT 'info', event TEXT NOT NULL, message TEXT NOT NULL, message_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE SET NULL);
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
const telegramApiId = Number(process.env.TELEGRAM_API_ID || 0);
const telegramApiHash = process.env.TELEGRAM_API_HASH || '';
const cipherKey = crypto.createHash('sha256').update(process.env.SESSION_SECRET || adminPassword).digest();
const pendingTelegramLogins = new Map();
const SOURCE_DOWNLOAD_DELAY_SECONDS=Math.max(10,Number(process.env.SOURCE_DOWNLOAD_DELAY_SECONDS)||30);
const SOURCE_RETRY_SAFETY_SECONDS=Math.max(10,Number(process.env.SOURCE_RETRY_SAFETY_SECONDS)||20);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function sourceLog(sourceId,level,event,message,messageId=null){db.prepare('INSERT INTO source_logs(source_id,level,event,message,message_id) VALUES(?,?,?,?,?)').run(sourceId||null,level,event,String(message).slice(0,1000),messageId);db.prepare('DELETE FROM source_logs WHERE id NOT IN (SELECT id FROM source_logs ORDER BY id DESC LIMIT 2000)').run();}
function encrypt(value){const iv=crypto.randomBytes(12);const c=crypto.createCipheriv('aes-256-gcm',cipherKey,iv);const encrypted=Buffer.concat([c.update(value,'utf8'),c.final()]);return [iv,c.getAuthTag(),encrypted].map(x=>x.toString('base64url')).join('.');}
function decrypt(value){const [a,b,c]=value.split('.').map(x=>Buffer.from(x,'base64url'));const d=crypto.createDecipheriv('aes-256-gcm',cipherKey,a);d.setAuthTag(b);return Buffer.concat([d.update(c),d.final()]).toString('utf8');}
async function accountClient(){const row=db.prepare('SELECT session_encrypted FROM telegram_accounts WHERE id=1').get();if(!row)throw new Error('Conta do Telegram ainda não conectada');const client=new TelegramClient(new sessions.StringSession(decrypt(row.session_encrypted)),telegramApiId,telegramApiHash,{connectionRetries:5});client.floodSleepThreshold=300;client.maxConcurrentDownloads=1;await client.connect();return client;}
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
app.get('/api/telegram/account',auth,(_req,res)=>{const row=db.prepare('SELECT phone,connected_at FROM telegram_accounts WHERE id=1').get();res.json({connected:!!row,...row});});
app.post('/api/telegram/login/start',auth,async(req,res)=>{if(!telegramApiId||!telegramApiHash)return res.status(503).json({error:'API ID/Hash não configurados'});const phone=String(req.body.phone||'').replace(/[^+\d]/g,'');if(phone.length<10)return res.status(400).json({error:'Informe o número com DDI, exemplo +5511999999999'});try{const client=new TelegramClient(new sessions.StringSession(''),telegramApiId,telegramApiHash,{connectionRetries:5});await client.connect();const sent=await client.sendCode({apiId:telegramApiId,apiHash:telegramApiHash},phone);pendingTelegramLogins.set(req.userId,{client,phone,phoneCodeHash:sent.phoneCodeHash,expires:Date.now()+10*60e3});res.json({ok:true,viaApp:sent.isCodeViaApp});}catch(e){res.status(400).json({error:e.message||'Não foi possível enviar o código'});}});
app.post('/api/telegram/login/confirm',auth,async(req,res)=>{const pending=pendingTelegramLogins.get(req.userId);if(!pending||pending.expires<Date.now())return res.status(400).json({error:'Código expirado. Solicite outro.'});try{await pending.client.invoke(new Api.auth.SignIn({phoneNumber:pending.phone,phoneCodeHash:pending.phoneCodeHash,phoneCode:String(req.body.code||'').replace(/\D/g,'')}));const saved=pending.client.session.save();db.prepare('INSERT INTO telegram_accounts(id,phone,session_encrypted) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET phone=excluded.phone,session_encrypted=excluded.session_encrypted,connected_at=CURRENT_TIMESTAMP').run(pending.phone,encrypt(saved));pendingTelegramLogins.delete(req.userId);await pending.client.disconnect();res.json({ok:true});}catch(e){if(String(e.errorMessage||e.message).includes('SESSION_PASSWORD_NEEDED'))return res.json({ok:false,passwordRequired:true});res.status(400).json({error:e.message||'Código inválido'});}});
app.post('/api/telegram/login/password',auth,async(req,res)=>{const pending=pendingTelegramLogins.get(req.userId);if(!pending)return res.status(400).json({error:'Sessão de login expirada'});try{await pending.client.signInWithPassword({apiId:telegramApiId,apiHash:telegramApiHash},{password:async()=>String(req.body.password||''),onError:async e=>{throw e}});const saved=pending.client.session.save();db.prepare('INSERT INTO telegram_accounts(id,phone,session_encrypted) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET phone=excluded.phone,session_encrypted=excluded.session_encrypted,connected_at=CURRENT_TIMESTAMP').run(pending.phone,encrypt(saved));pendingTelegramLogins.delete(req.userId);await pending.client.disconnect();res.json({ok:true});}catch(e){res.status(400).json({error:e.message||'Senha de duas etapas inválida'});}});
app.get('/api/telegram/dialogs',auth,async(_req,res)=>{let client;try{client=await accountClient();const dialogs=await client.getDialogs({limit:500});const items=dialogs.filter(d=>d.isGroup||d.isChannel).map(d=>({name:d.name||'Sem nome',chatId:String(utils.getPeerId(d.entity)),type:d.isChannel?'Canal / supergrupo':'Grupo',protected:!!d.entity?.noforwards})).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));res.json({items});}catch(e){res.status(400).json({error:e.message||'Não foi possível listar os grupos'});}finally{if(client)await client.disconnect();}});
app.delete('/api/telegram/account',auth,async(_req,res)=>{db.prepare('DELETE FROM telegram_accounts WHERE id=1').run();res.json({ok:true});});
app.get('/api/sources',auth,(_req,res)=>{const items=db.prepare(`SELECT s.*,(SELECT COUNT(*) FROM source_imports i WHERE i.source_id=s.id AND i.media_id IS NOT NULL) imported_count FROM sources s ORDER BY s.id DESC`).all();const logs=db.prepare(`SELECT l.*,COALESCE(s.name,'Sistema') source_name FROM source_logs l LEFT JOIN sources s ON s.id=l.source_id ORDER BY l.id DESC LIMIT 100`).all();res.json({items,logs,running:sourceWorkerRunning,downloadDelaySeconds:SOURCE_DOWNLOAD_DELAY_SECONDS});});
app.post('/api/sources',auth,async(req,res)=>{const peerId=String(req.body.peerId||''),name=String(req.body.name||'').trim(),historyLimit=Number(req.body.historyLimit);if(!peerId||!name)return res.status(400).json({error:'Fonte inválida'});if(![-1,0,50,100,500,1000].includes(historyLimit))return res.status(400).json({error:'Quantidade de histórico inválida'});let client;try{client=await accountClient();const entity=await client.getEntity(peerId);if(entity?.noforwards)return res.status(400).json({error:'Este canal protege o conteúdo e não pode ser importado'});let last=0,done=0;if(historyLimit===0){const messages=await client.getMessages(peerId,{limit:1});last=messages[0]?.id||0;done=1;}const id=db.prepare('INSERT INTO sources(peer_id,name,history_limit,initial_import_done,last_message_id) VALUES(?,?,?,?,?) ON CONFLICT(peer_id) DO UPDATE SET name=excluded.name,history_limit=excluded.history_limit,enabled=1 RETURNING id').get(peerId,name,historyLimit,done,last).id;res.json({ok:true,id});setTimeout(runSourceWorker,100);}catch(e){res.status(400).json({error:e.message||'Não foi possível adicionar a fonte'});}finally{if(client)await client.disconnect();}});
app.post('/api/sources/:id/toggle',auth,(req,res)=>{db.prepare('UPDATE sources SET enabled=CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?').run(req.params.id);res.json({ok:true});setTimeout(runSourceWorker,100);});
app.post('/api/sources/run',auth,(_req,res)=>{if(sourceWorkerRunning)return res.json({ok:true,alreadyRunning:true});setTimeout(runSourceWorker,50);res.json({ok:true});});
app.delete('/api/sources/:id',auth,(req,res)=>{db.prepare('DELETE FROM sources WHERE id=?').run(req.params.id);res.json({ok:true});});
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
let sourceWorkerRunning=false;
async function runSourceWorker(){
  if(sourceWorkerRunning)return;const sourcesToRun=db.prepare('SELECT * FROM sources WHERE enabled=1 ORDER BY id').all();if(!sourcesToRun.length)return;sourceWorkerRunning=true;let client;
  try{
    client=await accountClient();
    sourceLog(null,'info','worker_started',`Verificação iniciada para ${sourcesToRun.length} fonte(s). Intervalo entre downloads: ${SOURCE_DOWNLOAD_DELAY_SECONDS}s.`);
    for(const source of sourcesToRun){
      let highest=source.last_message_id||0;
      try{
        sourceLog(source.id,'info','source_check',`Verificando ${source.name}.`);
        const limit=source.initial_import_done?undefined:(source.history_limit===-1?undefined:source.history_limit);
        const params=source.initial_import_done?{minId:source.last_message_id,reverse:true,limit:undefined}:{limit};
        for await(const message of client.iterMessages(source.peer_id,params)){
          highest=Math.max(highest,Number(message.id)||0);
          if(message.noforwards){sourceLog(source.id,'warning','protected_skipped','Mensagem protegida ignorada.',message.id);continue;}
          if(!message.video)continue;
          if(db.prepare('SELECT 1 FROM source_imports WHERE source_id=? AND message_id=?').get(source.id,message.id))continue;
          const failure=db.prepare("SELECT * FROM source_failures WHERE source_id=? AND message_id=? AND next_retry_at > CURRENT_TIMESTAMP").get(source.id,message.id);if(failure)continue;
          const size=Number(message.file?.size||message.document?.size||0);if(size>MAX_FILE_MB*1024*1024){db.prepare('INSERT OR IGNORE INTO source_imports(source_id,message_id) VALUES(?,?)').run(source.id,message.id);sourceLog(source.id,'warning','oversize_skipped',`Vídeo maior que ${MAX_FILE_MB} MB ignorado.`,message.id);continue;}
          const original=(message.file?.name||`${source.name}-${message.id}.mp4`).replace(/[\\/:*?"<>|]/g,'_');
          const stored=`telegram-${source.id}-${message.id}${path.extname(original)||'.mp4'}`;const target=path.join(UPLOAD_DIR,stored);
          try{
            sourceLog(source.id,'info','download_started',`Baixando ${original}${size?` (${Math.round(size/1048576)} MB)`:''}.`,message.id);
            if(!fs.existsSync(target)||fs.statSync(target).size===0){
              let downloaded=false,lastDownloadError;
              for(let attempt=1;attempt<=4&&!downloaded;attempt++){
                try{await client.downloadMedia(message,{outputFile:target});downloaded=true;}
                catch(e){lastDownloadError=e;const text=String(e.errorMessage||e.message||e);const match=text.match(/(?:FLOOD_WAIT_|wait\s+)(\d+)/i);if(match){const waitSeconds=Number(match[1])+SOURCE_RETRY_SAFETY_SECONDS;sourceLog(source.id,'warning','flood_wait',`Telegram pediu ${match[1]}s de pausa; aguardando ${waitSeconds}s antes de tentar novamente.`,message.id);await sleep(waitSeconds*1000);}else if(attempt<4){const waitSeconds=SOURCE_DOWNLOAD_DELAY_SECONDS*attempt;sourceLog(source.id,'warning','download_retry',`Tentativa ${attempt} falhou; nova tentativa em ${waitSeconds}s.`,message.id);await sleep(waitSeconds*1000);}}
              }
              if(!downloaded)throw lastDownloadError||new Error('Download não concluído');
            }
            const stat=fs.statSync(target);if(!stat.size)throw new Error('Arquivo baixado vazio');
            db.transaction(()=>{const existing=db.prepare('SELECT id FROM media WHERE stored_name=?').get(stored);const mediaId=existing?.id||db.prepare('INSERT INTO media(original_name,stored_name,mime_type,size,caption) VALUES(?,?,?,?,?)').run(original,stored,message.document?.mimeType||'video/mp4',stat.size,String(message.message||'').slice(0,1024)).lastInsertRowid;db.prepare('INSERT OR IGNORE INTO source_imports(source_id,message_id,media_id) VALUES(?,?,?)').run(source.id,message.id,mediaId);db.prepare('DELETE FROM source_failures WHERE source_id=? AND message_id=?').run(source.id,message.id);})();
            sourceLog(source.id,'success','download_completed',`${original} salvo na biblioteca.`,message.id);
          }catch(e){
            try{if(fs.existsSync(target)&&fs.statSync(target).size===0)fs.unlinkSync(target)}catch{}
            const error=String(e.errorMessage||e.message||e).slice(0,500);db.prepare("INSERT INTO source_failures(source_id,message_id,attempts,next_retry_at,last_error) VALUES(?,?,1,datetime('now','+15 minutes'),?) ON CONFLICT(source_id,message_id) DO UPDATE SET attempts=attempts+1,next_retry_at=datetime('now',CASE WHEN attempts>=3 THEN '+60 minutes' ELSE '+15 minutes' END),last_error=excluded.last_error").run(source.id,message.id,error);sourceLog(source.id,'error','download_failed',`Falha após as tentativas: ${error}. Nova tentativa será feita depois.`,message.id);
          }
          await sleep(SOURCE_DOWNLOAD_DELAY_SECONDS*1000);
        }
        db.prepare('UPDATE sources SET initial_import_done=1,last_message_id=?,last_checked_at=CURRENT_TIMESTAMP,last_error=NULL WHERE id=?').run(highest,source.id);
        sourceLog(source.id,'success','source_complete',`Verificação concluída até a mensagem ${highest}.`);
      }catch(e){const error=String(e.errorMessage||e.message||e).slice(0,500);db.prepare('UPDATE sources SET last_checked_at=CURRENT_TIMESTAMP,last_error=? WHERE id=?').run(error,source.id);sourceLog(source.id,'error','source_failed',error);}
    }
  }catch(e){console.error('Source worker:',e.message);sourceLog(null,'error','worker_failed',e.message);}finally{if(client)await client.disconnect();sourceWorkerRunning=false;sourceLog(null,'info','worker_stopped','Verificação finalizada.');}
}
setInterval(runSourceWorker,60000);setTimeout(runSourceWorker,5000);
app.use((err,_req,res,_next)=>{console.error(err);res.status(err.code==='LIMIT_FILE_SIZE'?413:500).json({error:err.code==='LIMIT_FILE_SIZE'?`Arquivo maior que ${MAX_FILE_MB} MB`:err.message||'Erro interno'});});
app.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('AutoPost Telegram online'));
