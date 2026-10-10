// Date your gacha girl — Render 镜像"大脑"
// 移植自原 Cloudflare 版 relay.js：登录/会话/队列/积分/状态全部复用，数据库由 D1 换成 SQLite，
// 图片回传通道由 Cloudflare Quick Tunnel 换成"本机主动连出的 WebSocket 长连接"（不再依赖任何第三方隧道）。
// 前端 public/ 原样复用，所以用户看到的交互与原来一模一样。

import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 配置 ----------
const PORT = process.env.PORT || 3000;
const WORKER_TOKEN = process.env.WORKER_TOKEN || 'change-me-worker-token-please-32+chars';
const USER_TOKEN = process.env.USER_TOKEN || '';           // 可选：旧 admin 直登令牌
const REQUEST_ONLY = process.env.REQUEST_ONLY !== 'false';  // 默认 true：提交即转发给本机
const CREDITS_ENABLED = process.env.CREDITS_ENABLED !== 'false';
const LEASE_MS = 180_000;
const ONLINE_MS = 90_000;
const IMAGE_LIMIT = 16 * 1024 * 1024;
const DB_PATH = process.env.DATEHER_DB || path.join(__dirname, 'relay.sqlite3');
// 镜像站首个账号（asus）的密码，**必须通过环境变量 ADMIN_PASSWORD 注入**
//（本仓库是公开的，绝不能把口令写进代码）。未设置时随机生成、只在启动日志里打印一次。
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// ---------- 数据库 ----------
// 使用 Node 内置 node:sqlite，避免原生模块（better-sqlite3）在 Render 等平台编译失败。
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// 简单事务封装（node:sqlite 无内建 transaction）
function tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }

db.exec(`
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY, ready INTEGER NOT NULL DEFAULT 0, workflows TEXT NOT NULL,
  last_seen INTEGER NOT NULL, image_url TEXT, queue_waiting INTEGER, queue_running INTEGER,
  priority INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, workflow_id TEXT NOT NULL,
  parameters TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, owner_id TEXT NOT NULL DEFAULT 'legacy',
  visible INTEGER NOT NULL DEFAULT 1, worker_id TEXT, lease_token TEXT, lease_expires_at INTEGER,
  prompt_id TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS jobs_owner_status ON jobs(owner_id,status);
CREATE INDEX IF NOT EXISTS jobs_owner_visible ON jobs(owner_id,visible,created_at);
CREATE INDEX IF NOT EXISTS jobs_updated_at ON jobs(updated_at,id);
CREATE TABLE IF NOT EXISTS results (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, result_index INTEGER NOT NULL,
  object_key TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  PRIMARY KEY(job_id, result_index)
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL, password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS login_attempts (key_hash TEXT NOT NULL, attempted_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS login_attempts_key_time ON login_attempts(key_hash,attempted_at);
CREATE TABLE IF NOT EXISTS active_sessions (
  owner_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, config TEXT NOT NULL,
  frozen_parameters TEXT, workflow_id TEXT
);
CREATE TABLE IF NOT EXISTS session_requests (
  owner_id TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL, config TEXT NOT NULL,
  replace_session INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id,request_id), UNIQUE(owner_id,session_id)
);
CREATE TABLE IF NOT EXISTS session_history (owner_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(owner_id,session_id));
CREATE TABLE IF NOT EXISTS session_pages (
  owner_id TEXT NOT NULL, session_id TEXT NOT NULL, page_index INTEGER NOT NULL, parameters TEXT NOT NULL,
  PRIMARY KEY(owner_id,session_id,page_index)
);
CREATE TABLE IF NOT EXISTS credit_wallets (account_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0));
CREATE TABLE IF NOT EXISTS credit_ledger (
  account_id TEXT NOT NULL REFERENCES credit_wallets(account_id), operation TEXT NOT NULL, request_id TEXT NOT NULL,
  resource_id TEXT NOT NULL, fingerprint TEXT NOT NULL, delta INTEGER NOT NULL CHECK(delta<>0), created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,operation,request_id)
);
`);
// 兼容旧库：为已存在的 workers 表补 priority 列（新建库已含该列，重复添加会被忽略）。
try { db.exec('ALTER TABLE workers ADD COLUMN priority INTEGER NOT NULL DEFAULT 0'); } catch {}

// 首次启动：种入 asus 账号（与主站同一个账号），并授予初始积分。
// 口令来自环境变量 ADMIN_PASSWORD；没配就随机生成并打印一次（本地开发用）。
function seedAccount() {
  const existing = db.prepare('SELECT id FROM users WHERE username=?').get('asus');
  if (!existing) {
    const pwd = ADMIN_PASSWORD || crypto.randomBytes(12).toString('hex');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = derivePasswordSync(pwd, salt);
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO users(id,username,password_salt,password_hash) VALUES(?,?,?,?)').run(id, 'asus', salt, hash);
    db.prepare('INSERT INTO credit_wallets(account_id,balance) VALUES(?,1000)').run(id);
    db.prepare("INSERT INTO credit_ledger(account_id,operation,request_id,resource_id,fingerprint,delta,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, 'test_grant', 'initial_1000', 'initial_1000', 'initial_1000', 1000, Date.now());
    console.log(ADMIN_PASSWORD
      ? '[seed] 已创建账号 asus（密码取自 ADMIN_PASSWORD 环境变量）'
      : '[seed] 已创建账号 asus，临时随机口令：' + pwd + '（请设置 ADMIN_PASSWORD 环境变量固定下来）');
  }
}
seedAccount();
backfillActiveSessions();

// ---------- 工具 ----------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const isUuid = v => typeof v === 'string' && UUID.test(v);
const isName = v => typeof v === 'string' && NAME.test(v);
const PARAM_NAMES = ['positive', 'negative', 'width', 'height', 'steps', 'cfg', 'seed'];
const DATEHER_NAMES = [...PARAM_NAMES, 'character', 'art_style', 'shot', 'personality_tags', 'session_id', 'page_index', 'session_config'];
const DEFAULTS = { positive: '', negative: '', width: 768, height: 1024, steps: 25, cfg: 7, seed: 0 };

const enc = new TextEncoder();
const hex = b => Buffer.from(b).toString('hex');
function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
// PBKDF2 SHA-256 100000 迭代（与 Cloudflare 版一致）
function derivePasswordSync(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
}
function apiError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}
function ok(res, body, status = 200) { return res.status(status).json({ ok: true, ...body }); }

function equal(a, b) { let d = a.length ^ b.length; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i || 0); return d === 0; }

// ---------- 积分 ----------
const creditPolicy = () => ({ enabled: CREDITS_ENABLED, ready: true, currency: 'points',
  prices: { generation: 1, regenerate: 1, download_original: 5 }, operations: ['batch_submit', 'regenerate', 'download_original'] });
function creditBalance(userId) {
  if (!CREDITS_ENABLED) return null;
  const r = db.prepare('SELECT balance FROM credit_wallets WHERE account_id=?').get(userId);
  return r ? r.balance : 0;
}
function charge(userId, operation, requestId, resourceId, fingerprint, qty = 1) {
  if (!CREDITS_ENABLED) return { charged: false };
  const cost = (operation === 'download_original' ? 5 : 1) * qty;
  const fp = JSON.stringify([resourceId, qty, fingerprint || '']);
  const existing = db.prepare('SELECT fingerprint FROM credit_ledger WHERE account_id=? AND operation=? AND request_id=?')
    .get(userId, operation, requestId);
  if (existing && existing.fingerprint !== fp) throw { status: 409, message: 'Credit request changed' };
  try {
    tx(() => {
      db.prepare(`INSERT INTO credit_ledger(account_id,operation,request_id,resource_id,fingerprint,delta,created_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,operation,request_id) DO UPDATE SET fingerprint=excluded.fingerprint`)
        .run(userId, operation, requestId, resourceId, fp, -cost, Date.now());
      const upd = db.prepare('UPDATE credit_wallets SET balance=balance+(SELECT delta FROM credit_ledger WHERE account_id=? AND operation=? AND request_id=?) WHERE account_id=? AND balance+(SELECT delta FROM credit_ledger WHERE account_id=? AND operation=? AND request_id=?)>=0')
        .run(userId, operation, requestId, userId, userId, operation, requestId);
      if (upd.changes === 0) throw { status: 402, message: 'Insufficient points' };
    });
  } catch (e) { if (e.status) throw e; throw { status: 402, message: 'Insufficient points' }; }
  return { charged: true, balance: creditBalance(userId) };
}

// ---------- 鉴权 ----------
function authenticateWorker(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ') || auth.length > 1024) throw { status: 401, message: '请登录' };
  const tokenHash = sha256hex(auth.slice(7));
  if (equal(tokenHash, sha256hex(WORKER_TOKEN))) return true;
  throw { status: 401, message: '访问密钥不正确' };
}
function authenticateUser(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ') || auth.length > 1024) throw { status: 401, message: '请登录' };
  const tokenHash = sha256hex(auth.slice(7));
  if (USER_TOKEN && equal(tokenHash, sha256hex(USER_TOKEN))) return { id: 'legacy', admin: true, username: 'admin' };
  const s = db.prepare('SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?')
    .get(tokenHash, Date.now());
  if (!s) throw { status: 401, message: '请重新登录' };
  return { id: s.id, username: s.username };
}

// ---------- 参数校验 ----------
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function parameters(input, full = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw { status: 400, message: '参数格式错误' };
  for (const k of Object.keys(input)) if (!(full ? DATEHER_NAMES : PARAM_NAMES).includes(k)) throw { status: 400, message: `不允许的参数：${k}` };
  const r = { ...DEFAULTS, ...input };
  for (const k of ['positive', 'negative']) if (typeof r[k] !== 'string' || r[k].length > 6000) throw { status: 400, message: `${k} 最多 6000 字符` };
  if (!r.positive.trim()) throw { status: 400, message: '请填写画面描述' };
  for (const k of ['width', 'height']) if (!Number.isInteger(r[k]) || r[k] < 256 || r[k] > (full ? 2048 : 1536) || (!full && r[k] % 64 !== 0)) throw { status: 400, message: '尺寸须为 256–1536 之间的 64 倍数' };
  if (!Number.isInteger(r.steps) || r.steps < 1 || r.steps > 60) throw { status: 400, message: '步数须为 1–60' };
  if (!Number.isFinite(r.cfg) || r.cfg < 1 || r.cfg > 20) throw { status: 400, message: 'CFG 须为 1–20' };
  if (!Number.isSafeInteger(r.seed) || r.seed < 0) throw { status: 400, message: '种子须为非负安全整数' };
  if (full) {
    if ('character' in input && (typeof input.character !== 'string' || input.character.length > 100)) throw { status: 400, message: 'character 格式错误' };
    if ('personality_tags' in input && (typeof input.personality_tags !== 'string' || input.personality_tags.length > 2000)) throw { status: 400, message: 'personality_tags 格式错误' };
    if ('art_style' in input && !['anime_normal', 'anime_special', 'real'].includes(input.art_style)) throw { status: 400, message: '画风错误' };
    if ('shot' in input && !['', 'full body', 'cowboy shot', 'upper body', 'close-up', 'none'].includes(input.shot)) throw { status: 400, message: '镜头错误' };
    if ('session_id' in input && !isUuid(input.session_id)) throw { status: 400, message: 'session_id 须为 UUID' };
    if ('page_index' in input && (!Number.isInteger(input.page_index) || input.page_index < 1 || input.page_index > 20)) throw { status: 400, message: '页码须为 1–20' };
  }
  return r;
}
function manifest(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 16) throw { status: 400, message: '须配置 1–16 个工作流' };
  const seen = new Set();
  return input.map(item => {
    if (!item || !isName(item.id) || seen.has(item.id)) throw { status: 400, message: '工作流 ID 错误或重复' };
    seen.add(item.id);
    if (typeof item.name !== 'string' || !item.name || item.name.length > 80) throw { status: 400, message: '工作流名称错误' };
    if (!Array.isArray(item.parameters) || item.parameters.length < 1 || !item.parameters.every(p => (item.id === 'dateher_full' ? DATEHER_NAMES : PARAM_NAMES).includes(p)) || new Set(item.parameters).size !== item.parameters.length) throw { status: 400, message: '工作流参数错误' };
    if (!item.parameters.includes('positive')) throw { status: 400, message: '工作流必须支持画面描述' };
    return { id: item.id, name: item.name, parameters: item.parameters };
  });
}

function publicJob(row) {
  if (!row) return null;
  const { lease_token, lease_expires_at, request_id, owner_id, prompt_id, worker_id, visible, ...job } = row;
  return { ...job, parameters: JSON.parse(job.parameters), error: job.error ? (job.status === 'failed' ? '任务生成失败，请稍后重试' : null) : null };
}
function jobDetail(id, userId, missingStatus = 404) {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (!job) throw { status: missingStatus, message: '任务不存在' };
  if (userId && !(job.owner_id === userId && job.visible === 1)) throw { status: missingStatus, message: '任务不存在或会话已替换' };
  const results = db.prepare('SELECT result_index AS idx,content_type,size,sha256,object_key FROM results WHERE job_id=? ORDER BY result_index').all(id);
  const { lease_token, lease_expires_at, request_id, owner_id, prompt_id, worker_id, visible, ...rest } = job;
  return { ...rest, parameters: JSON.parse(job.parameters), error: job.error ? (job.status === 'failed' ? '任务生成失败，请稍后重试' : null) : null,
    results: results.map(r => ({ ...r, url: `/api/jobs/${id}/results/${r.idx}` })) };
}
function workflowList(now) {
  const workers = db.prepare('SELECT * FROM workers ORDER BY priority DESC,last_seen DESC').all();
  const found = new Map();
  for (const w of workers) {
    for (const wf of JSON.parse(w.workflows)) {
      const online = w.ready === 1 && w.last_seen > now - (REQUEST_ONLY ? 300_000 : ONLINE_MS);
      const old = found.get(wf.id);
      if (!old || online) found.set(wf.id, { ...wf, name: 'Drawing', online: online || old?.online || false });
    }
  }
  return { workflows: [...found.values()], worker_online: workers.some(w => w.ready === 1 && w.last_seen > now - (REQUEST_ONLY ? 300_000 : ONLINE_MS)) };
}
function localOnline() {
  // 优先 priority 大者，其次心跳最新者；过期（>300s 未心跳）的一律不选，便于后备机器顶上。
  const w = db.prepare('SELECT * FROM workers WHERE ready=1 AND last_seen>? ORDER BY priority DESC,last_seen DESC LIMIT 1')
    .get(Date.now() - 300_000);
  if (!w) throw { status: 503, message: 'Local relay is offline. Start the local relay and retry the same request.' };
  return w;
}

// ---------- WebSocket 本机通道 ----------
// 本机 worker 主动连出；cloud 通过 ws 推任务/取图，worker 回传。
const workerSockets = new Map(); // worker_id -> ws
const pendingFetch = new Map();  // msgId -> {resolve,reject,timer}
let wsMsgId = 0;

function sendToWorker(workerId, msg, timeoutMs = 25000) {
  const ws = workerSockets.get(workerId);
  if (!ws || ws.readyState !== 1) throw { status: 503, message: '本机取图通道尚未连接' };
  return new Promise((resolve, reject) => {
    const id = ++wsMsgId;
    const timer = setTimeout(() => { pendingFetch.delete(id); reject({ status: 504, message: '本机响应超时' }); }, timeoutMs);
    pendingFetch.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ ...msg, msg_id: id }));
  });
}
function handleWorkerMessage(workerId, data) {
  let msg; try { msg = JSON.parse(data); } catch { return; }
  if (msg.msg_id && pendingFetch.has(msg.msg_id)) {
    const { resolve, timer } = pendingFetch.get(msg.msg_id);
    clearTimeout(timer); pendingFetch.delete(msg.msg_id);
    if (msg.type === 'image') { resolve({ content_type: msg.content_type, sha256: msg.sha256, size: msg.size, data: Buffer.from(msg.data, 'base64') }); }
    else resolve(msg);
    return;
  }
  // 主动上报：complete / fail / results / load_result
  if (msg.type === 'complete') workerMarkComplete(workerId, msg);
  else if (msg.type === 'fail') workerMarkFail(workerId, msg);
  else if (msg.type === 'results') workerStoreResults(workerId, msg);
  else if (msg.type === 'load_result') workerLoadResult(workerId, msg);
}
function workerMarkComplete(workerId, msg) {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(msg.job_id);
  if (!job || job.status !== 'running' || job.worker_id !== workerId) return;
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM results WHERE job_id=?').get(msg.job_id).c;
  if (cnt > 0) db.prepare("UPDATE jobs SET status='succeeded',updated_at=? WHERE id=?").run(Date.now(), msg.job_id);
}
function workerMarkFail(workerId, msg) {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(msg.job_id);
  if (!job || job.status !== 'running' || job.worker_id !== workerId) return;
  db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=?").run(String(msg.error || 'generation failed').slice(0, 1000), Date.now(), msg.job_id);
}
function workerStoreResults(workerId, msg) {
  const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(msg.job_id);
  if (!job || job.status !== 'running' || job.worker_id !== workerId) return;
  tx(() => {
    for (const r of msg.results) {
      if (r.index >= 8 || !['image/png', 'image/jpeg', 'image/webp'].includes(r.content_type) || r.size <= 0 || r.size > IMAGE_LIMIT || !/^[0-9a-f]{64}$/.test(r.sha256) || r.object_key !== msg.job_id + '_' + r.index) continue;
      db.prepare(`INSERT INTO results(job_id,result_index,object_key,content_type,size,sha256) VALUES(?,?,?,?,?,?)
        ON CONFLICT(job_id,result_index) DO NOTHING`).run(msg.job_id, r.index, r.object_key, r.content_type, r.size, r.sha256);
    }
  });
}
function workerLoadResult(workerId, msg) {
  applyLoadResult(workerId, msg.jobs || []);
}
// 原站 §3.2：载入时按返回的元数据把任务置为 succeeded（没画完的不会被返回，保持 running 等下次载入），
// 后端明确报执行错误的才置为 failed。
function applyLoadResult(workerId, items) {
  for (const item of (Array.isArray(items) ? items : [])) {
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(item.id);
    if (!job || job.status !== 'running' || job.worker_id !== workerId) continue;
    if (item.error) { db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=?").run(String(item.error).slice(0, 1000), Date.now(), item.id); continue; }
    if (!Array.isArray(item.results) || item.results.length < 1 || item.results.length > 8) continue;
    tx(() => {
      for (const r of item.results) {
        if (r.index >= 8 || !['image/png', 'image/jpeg', 'image/webp'].includes(r.content_type) || r.size <= 0 || r.size > IMAGE_LIMIT || !/^[0-9a-f]{64}$/.test(r.sha256) || r.object_key !== item.id + '_' + r.index) continue;
        db.prepare(`INSERT INTO results(job_id,result_index,object_key,content_type,size,sha256) VALUES(?,?,?,?,?,?)
          ON CONFLICT(job_id,result_index) DO NOTHING`).run(item.id, r.index, r.object_key, r.content_type, r.size, r.sha256);
      }
      db.prepare("UPDATE jobs SET status='succeeded',updated_at=? WHERE id=? AND status='running'").run(Date.now(), item.id);
    });
  }
}

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '24mb' }));
// 与 Cloudflare Pages 行为一致：/DateHerGen 这类“无扩展名地址”自动映射到 DateHerGen.html
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// 兜底：把不带扩展名的页面路径也交给静态目录按 .html 解析
app.get(/^\/[A-Za-z0-9_-]+$/, (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', req.path + '.html'), err => { if (err) next(); });
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !username || username.length > 100 || typeof password !== 'string' || !password || password.length > 1000)
      return apiError(res, 400, '登录信息格式错误');
    const uname = username.trim();
    const now = Date.now();
    db.prepare('DELETE FROM login_attempts WHERE attempted_at<=?').run(now - 900000);
    const ip = req.headers['x-forwarded-for'] || 'unknown';
    const userKey = sha256hex('username:' + uname);
    const keys = [userKey, sha256hex('ip:' + ip)];
    for (const k of keys) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE key_hash=? AND attempted_at>?').get(k, now - 900000).n;
      if (n >= 5) return apiError(res, 429, '登录尝试过多，请稍后重试');
    }
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(uname);
    const salt = user ? user.password_salt : '0'.repeat(32);
    const hash = derivePasswordSync(password, salt);
    if (!user || hash !== user.password_hash) {
      db.prepare('INSERT INTO login_attempts(key_hash,attempted_at) SELECT ?,? WHERE (SELECT COUNT(*) FROM login_attempts WHERE key_hash=? AND attempted_at>?)<5')
        .run(userKey, now, userKey, now - 900000);
      return apiError(res, 401, '用户名或密码错误');
    }
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha256hex(token), user.id, now + 7 * 86400000);
    return ok(res, { token, user: { username: user.username }, credit_policy: creditPolicy(), balance: creditBalance(user.id) });
  } catch (e) { return apiError(res, e.status || 503, e.message || '服务暂时不可用'); }
});

function authUser(req) {
  try { return authenticateUser(req); } catch (e) { throw e; }
}

// 进程启动时刻：用于确认线上部署的代码版本（每次部署/重启都会变）。
const STARTED_AT = Date.now();

// 统一鉴权中间件（除 login 与只读构建标记外）
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/login')) return next();
  if (req.path === '/build') return next();
  try {
    if (req.path.startsWith('/worker/')) { authenticateWorker(req); return next(); }
    req.user = authenticateUser(req);
    next();
  } catch (e) { return apiError(res, e.status || 401, e.message || '请登录'); }
});

// 只读构建标记：确认线上运行的是哪个版本（无需登录，不含任何敏感信息）。
app.get('/api/build', (req, res) => ok(res, { features: ['worker_priority'], workers_priority_column: true, started_at: STARTED_AT, uptime_seconds: Math.round(process.uptime()) }));

// 用户相关
app.get('/api/auth/me', (req, res) => ok(res, { user: { username: req.user.username }, credit_policy: creditPolicy(), balance: creditBalance(req.user.id) }));
app.post('/api/auth/logout', (req, res) => {
  const auth = (req.headers['authorization'] || '').slice(7);
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256hex(auth));
  return ok(res, {});
});
app.get('/api/credits', (req, res) => ok(res, { policy: creditPolicy(), balance: creditBalance(req.user.id) }));
// 提交前的积分预检：前端在 batch 提交前必调，缺失会直接 404 → 前端显示“请求失败，请重试”。
app.post('/api/credits/quote', (req, res) => {
  try {
    const ids = (req.body || {}).request_ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || !ids.every(isUuid) || new Set(ids).size !== ids.length) throw { status: 400, message: 'Invalid credit quote' };
    let required = 0;
    for (const id of ids) {
      const key = req.user.id === 'legacy' ? id : req.user.id + ':' + id;
      const paid = db.prepare("SELECT request_id FROM credit_ledger WHERE account_id=? AND operation='batch_submit' AND request_id=?").get(req.user.id, key);
      if (!paid) required++;
    }
    const balance = creditBalance(req.user.id);
    if (!(balance === null || balance >= required)) throw { status: 402, message: 'Insufficient points' };
    return ok(res, { balance, required: CREDITS_ENABLED ? required : 0 });
  } catch (e) { return apiError(res, e.status || 400, e.message); }
});
app.get('/api/workflows', (req, res) => ok(res, workflowList(Date.now())));
app.get('/api/status', (req, res) => {
  const now = Date.now();
  const w = db.prepare('SELECT ready,last_seen,queue_waiting,queue_running FROM workers ORDER BY (ready=1 AND last_seen>?) DESC,priority DESC,last_seen DESC LIMIT 1').get(now - 300_000);
  const fresh = !!w && w.last_seen > now - 300_000;
  const server = { online: fresh && w.ready === 1, reported_at: w?.last_seen ?? null, waiting: fresh ? w.queue_waiting : null, running: fresh ? w.queue_running : null, report_interval_seconds: 120, offline_after_seconds: 300 };
  const wl = workflowList(now);
  const counts = db.prepare("SELECT status,COUNT(*) AS count FROM jobs WHERE visible=1 AND owner_id=? GROUP BY status").all(req.user.id);
  return ok(res, { ...wl, worker_online: server.online, server, counts });
});

// 会话
app.get('/api/session', async (req, res) => {
  if (REQUEST_ONLY && new URL(req.url, 'http://x').searchParams.get('load') === '1') { try { await loadSession(req.user); } catch { /* 本机离线或超时：保持 running */ } }
  return ok(res, sessionView(req.user));
});
app.post('/api/session', (req, res) => {
  try {
    const now = Date.now();
    const input = req.body || {};
    if (!Object.keys(input).every(k => ['session_id', 'config', 'replace', 'request_id'].includes(k))) throw { status: 400, message: '会话字段错误' };
    if (!isUuid(input.session_id) || !isUuid(input.request_id) || typeof input.replace !== 'boolean') throw { status: 400, message: '会话 ID 与 request_id 须为 UUID，replace 须为布尔值' };
    parameters({ positive: 'validation', session_config: input.config }, true);
    if (!input.config) throw { status: 400, message: 'config 必须是对象' };
    const config = JSON.stringify(canonical(input.config));
    db.prepare('INSERT INTO session_requests(owner_id,request_id,session_id,config,replace_session,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(req.user.id, input.request_id, input.session_id, config, input.replace ? 1 : 0, now);
    const stored = db.prepare('SELECT * FROM session_requests WHERE owner_id=? AND request_id=?').get(req.user.id, input.request_id);
    if (!stored || stored.session_id !== input.session_id || stored.replace_session !== (input.replace ? 1 : 0))
      throw { status: 409, message: '会话冲突，请确认替换当前批次并使用新的 request_id' };
    // 主站靠 SQLite 触发器（cloudflare/migrations/0004、0005）维护 active_sessions；
    // 这里漏了触发器，导致 sessionView 永远返回 session_id=null，
    // 前端 drawing.js:1307 就会抛 "Batch was replaced elsewhere"。
    applySession(req.user.id, input.session_id, config, now);
    return ok(res, sessionView(req.user));
  } catch (e) { return apiError(res, e.status || 400, e.message); }
});

// = 主站触发器 apply_session 的等价实现：登记会话历史、切换 active_sessions、让上一批次的可见任务失效。
function applySession(userId, sessionId, configJson, now) {
  db.prepare('INSERT INTO session_history(owner_id,session_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(userId, sessionId);
  const prev = db.prepare('SELECT session_id FROM active_sessions WHERE owner_id=?').get(userId);
  if (!prev || prev.session_id !== sessionId) {
    db.prepare(`INSERT INTO active_sessions(owner_id,session_id,config,frozen_parameters,workflow_id) VALUES(?,?,?,NULL,NULL)
      ON CONFLICT(owner_id) DO UPDATE SET session_id=excluded.session_id,config=excluded.config,frozen_parameters=NULL,workflow_id=NULL`)
      .run(userId, sessionId, configJson);
  }
  db.prepare("UPDATE jobs SET visible=0,status=IIF(status='queued','cancelled',status),updated_at=MAX(updated_at+1,?) WHERE owner_id=? AND visible=1 AND COALESCE(json_extract(parameters,'$.session_id'),'')!=?")
    .run(now, userId, sessionId);
}

// 启动时兜底：历史数据里若已提交过任务却没有 active_sessions 记录，
// 用最近一条任务所属的会话补上，避免刷新/载入失效（等价 migration 0004 的回填）。
function backfillActiveSessions() {
  const rows = db.prepare(`SELECT j.owner_id AS owner_id, json_extract(j.parameters,'$.session_id') AS sid,
      json_extract(j.parameters,'$.session_config') AS cfg
    FROM jobs j
    WHERE json_type(j.parameters,'$.session_id')='text'
      AND NOT EXISTS(SELECT 1 FROM active_sessions a WHERE a.owner_id=j.owner_id)
    ORDER BY j.created_at DESC, j.id DESC`).all();
  const done = new Set();
  for (const r of rows) {
    if (done.has(r.owner_id)) continue;
    done.add(r.owner_id);
    db.prepare('INSERT INTO active_sessions(owner_id,session_id,config,frozen_parameters,workflow_id) VALUES(?,?,?,NULL,NULL) ON CONFLICT(owner_id) DO NOTHING')
      .run(r.owner_id, r.sid, r.cfg || '{}');
    console.log('[session] 回填 active_sessions：', r.owner_id.slice(0, 8), r.sid.slice(0, 8));
  }
}

function sessionView(user) {
  const active = db.prepare('SELECT * FROM active_sessions WHERE owner_id=?').get(user.id);
  const jobs = db.prepare("SELECT * FROM jobs WHERE owner_id=? AND visible=1 ORDER BY created_at DESC,id DESC LIMIT 500").all(user.id);
  const hasImages = db.prepare(`SELECT 1 FROM results r JOIN jobs j ON j.id=r.job_id WHERE j.owner_id=? AND j.visible=1 AND j.status='succeeded' LIMIT 1`)
    .get(user.id) ? true : false;
  return { balance: creditBalance(user.id), credit_policy: creditPolicy(), ...(REQUEST_ONLY ? { request_only: true } : {}),
    session_id: active?.session_id ?? null, config: active ? JSON.parse(active.config) : null, has_images: hasImages, jobs: jobs.map(publicJob) };
}
// 原站 §3.2：用户点「载入/刷新」时，云端找出该账号当前可见且 running 的任务，**按 worker 分组调用本机 /load**。
// 本机读一次 ComfyUI /history 快照；还没画完的不会被返回，云端保持 running 等下次载入（不建立完成轮询）。
async function loadSession(user) {
  const running = db.prepare("SELECT * FROM jobs WHERE owner_id=? AND visible=1 AND status='running'").all(user.id);
  if (!running.length) return;
  const groups = new Map();
  for (const job of running) {
    if (!job.worker_id) continue;
    if (!groups.has(job.worker_id)) groups.set(job.worker_id, []);
    groups.get(job.worker_id).push(job);
  }
  for (const [workerId, pending] of groups) {
    try {
      const reply = await sendToWorker(workerId, { type: 'load', jobs: pending.map(j => ({ ...j, parameters: JSON.parse(j.parameters), owner_username: user.username })) }, 40000);
      if (reply && Array.isArray(reply.jobs)) applyLoadResult(workerId, reply.jobs);
    } catch { /* 超时或离线：保持 running，等用户下次载入 */ }
  }
}

// 任务
app.get('/api/jobs', (req, res) => {
  const jobs = db.prepare("SELECT * FROM jobs WHERE visible=1 AND owner_id=? ORDER BY created_at DESC,id DESC LIMIT 500").all(req.user.id);
  return ok(res, { jobs: jobs.map(publicJob) });
});
app.post('/api/jobs', (req, res) => createJob(req, res));
app.get('/api/jobs/:id', (req, res) => {
  try { return ok(res, { job: jobDetail(req.params.id, req.user.id) }); } catch (e) { return apiError(res, e.status || 404, e.message); }
});
app.post('/api/jobs/:id/forward', async (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
    if (!job || (job.status !== 'queued' && job.status !== 'running')) throw { status: 409, message: 'Task is no longer pending' };
    const p = JSON.parse(job.parameters);
    if (p.art_style === 'real' && req.user.username !== 'asus') throw { status: 403, message: 'Real-person style is available only to asus.' };
    if (CREDITS_ENABLED) charge(req.user.id, 'batch_submit', job.request_id, job.id, JSON.stringify([job.workflow_id, p]));
    if (job.status === 'queued') await forwardJob(job, req.user);
    return ok(res, { job: jobDetail(req.params.id, req.user.id) });
  } catch (e) { return apiError(res, e.status || 503, e.message); }
});
app.post('/api/jobs/:id/cancel', (req, res) => {
  try {
    const now = Date.now();
    const ch = db.prepare("UPDATE jobs SET status='cancelled',updated_at=? WHERE id=? AND owner_id=? AND visible=1 AND status='queued'")
      .run(now, req.params.id, req.user.id);
    if (ch.changes !== 1) throw { status: 409, message: '只能取消尚未开始的任务' };
    return ok(res, { job: jobDetail(req.params.id, req.user.id) });
  } catch (e) { return apiError(res, e.status || 409, e.message); }
});
app.delete('/api/jobs/:id', (req, res) => {
  try {
    const now = Date.now();
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
    if (!job) throw { status: 404, message: '任务不存在' };
    if (!['succeeded', 'failed', 'cancelled'].includes(job.status)) throw { status: 409, message: '请先取消排队任务，运行中的任务不能删除' };
    const ch = db.prepare(`UPDATE jobs SET visible=0,updated_at=? WHERE id=? AND owner_id=? AND visible=1 AND status IN ('succeeded','failed','cancelled')`)
      .run(now, req.params.id, req.user.id);
    if (ch.changes !== 1) throw { status: 409, message: '任务已改变，请刷新' };
    return ok(res, {});
  } catch (e) { return apiError(res, e.status || 409, e.message); }
});
// 取图（preview / download）—— 经 WS 向本机取
app.get('/api/jobs/:id/results/:index', (req, res) => fetchImage(req, res, false));
app.post('/api/jobs/:id/download/:index', (req, res) => fetchImage(req, res, true));

async function fetchImage(req, res, download) {
  try {
    const id = req.params.id, index = Number(req.params.index);
    const job = db.prepare('SELECT status FROM jobs WHERE id=?').get(id);
    if (!job || job.status !== 'succeeded') throw { status: 404, message: '图片尚未就绪' };
    const result = db.prepare('SELECT * FROM results WHERE job_id=? AND result_index=?').get(id, index);
    if (!result) throw { status: 404, message: '图片不存在' };
    const w = localOnline();
    const msg = await sendToWorker(w.id, { type: 'fetch_image', object_key: result.object_key, preview: !download });
    const size = msg.size, sha = msg.sha256;
    if (!download && !(sha === result.sha256 && size === result.size)) throw { status: 502, message: 'Image verification failed' };
    if (download && !(sha === result.sha256 && size === result.size)) throw { status: 502, message: 'Image verification failed' };
    let balance = creditBalance(req.user.id);
    if (download) { try { const c = charge(req.user.id, 'download_original', id + ':' + index, req.body?.request_id || 'x', ''); balance = c.balance ?? balance; } catch (e) { return apiError(res, e.status || 402, e.message); } }
    const contentType = (!download ? 'image/jpeg' : result.content_type);
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[contentType];
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Disposition', `attachment; filename="${id}_${index}.${ext}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-SHA256', sha);
    res.setHeader('X-Account-Balance', balance === null ? '' : String(balance));
    return res.end(msg.data);
  } catch (e) { return apiError(res, e.status || 503, e.message); }
}

// 创建任务（只登记+扣分，不转发）。转发由调用方在整批/单条提交处一次完成。
function createJobCore(input, user) {
  const now = Date.now();
  if (!isUuid(input.request_id || '')) throw { status: 400, message: 'request_id 须为 UUID' };
  if (!isName(input.workflow_id || '')) throw { status: 400, message: '工作流 ID 错误' };
  const requestKey = user.id === 'legacy' ? input.request_id : user.id + ':' + input.request_id;
  const validated = parameters(input.parameters, input.workflow_id === 'dateher_full');
  if (validated.art_style === 'real' && user.username !== 'asus') throw { status: 403, message: 'Real-person style is available only to asus.' };
  // 会话门控：替换非当前会话的可见任务
  gateSession(user.id, input);
  const existing = db.prepare('SELECT * FROM jobs WHERE request_id=?').get(requestKey);
  if (existing) {
    const stored = canonical(JSON.parse(existing.parameters));
    const retry = canonical(Object.fromEntries(Object.keys(stored).map(k => [k, validated[k]])));
    if (!(existing.visible === 1 && existing.owner_id === user.id && existing.workflow_id === input.workflow_id &&
      Object.keys(input.parameters).every(k => k in stored) && JSON.stringify(stored) === JSON.stringify(retry))) throw { status: 409, message: '重复请求的参数不同或会话已替换' };
    if (REQUEST_ONLY && existing.status === 'queued') localOnline();
    if (CREDITS_ENABLED) charge(user.id, 'batch_submit', existing.request_id, existing.id, JSON.stringify([existing.workflow_id, JSON.parse(existing.parameters)]));
    return { job: jobDetail(existing.id, user.id), status: 200 };
  }
  const catalog = workflowList(now);
  const wf = catalog.workflows.find(w => w.id === input.workflow_id);
  if (!wf) throw { status: 409, message: '工作流尚未登记，请先启动本机程序' };
  for (const k of Object.keys(input.parameters)) if (!wf.parameters.includes(k)) throw { status: 400, message: `此工作流不支持 ${k}` };
  const params = canonical(Object.fromEntries((input.workflow_id === 'dateher_full' ? DATEHER_NAMES : PARAM_NAMES)
    .filter(k => wf.parameters.includes(k) && validated[k] !== undefined).map(k => [k, validated[k]])));
  if (REQUEST_ONLY) localOnline();
  if (CREDITS_ENABLED && creditBalance(user.id) < 1) throw { status: 402, message: 'Insufficient points' };
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO jobs(id,request_id,workflow_id,parameters,status,created_at,updated_at,owner_id)
    SELECT ?,?,?,?,'queued',?,MAX(?,COALESCE((SELECT MAX(updated_at)+1 FROM jobs),0)),?
    WHERE (SELECT COUNT(*) FROM jobs WHERE owner_id=? AND status IN ('queued','running'))<100 ON CONFLICT(request_id) DO NOTHING`)
    .run(id, requestKey, input.workflow_id, JSON.stringify(params), now, now, user.id, user.id);
  const inserted = db.prepare('SELECT * FROM jobs WHERE request_id=?').get(requestKey);
  if (!inserted) throw { status: 429, message: '队列已满，请等任务完成' };
  if (!(inserted.visible === 1 && inserted.owner_id === user.id && inserted.workflow_id === input.workflow_id && inserted.parameters === JSON.stringify(params))) throw { status: 409, message: '重复请求的参数不同' };
  if (CREDITS_ENABLED) charge(user.id, 'batch_submit', inserted.request_id, inserted.id, JSON.stringify([inserted.workflow_id, params]));
  return { job: jobDetail(inserted.id, user.id), status: inserted.id === id ? 201 : 200 };
}

function createJob(req, res) {
  try {
    const { job, status } = createJobCore(req.body || {}, req.user);
    // 单条提交：登记并扣分后立刻转发这一条，不等出图。
    if (job.status === 'queued') forwardJob(job, req.user).catch(() => {});
    return ok(res, { job, balance: creditBalance(req.user.id) }, status);
  } catch (e) { return apiError(res, e.status || 400, e.message); }
}

// 批量提交（前端在 REQUEST_ONLY 模式下走这里）。对齐原站 cloudflare/lib/relay.js 的 /api/jobs/batch：
// 逐条登记并扣分 → **一次把整批待转发任务发给本机** → 本机逐项以 ≥50ms 间隔交给 ComfyUI 并立刻回 prompt_id
// → 有 prompt_id 的置为 running（可能在 Comfy 排队，也可能已画完未读取）。**不等待出图**，GPU 顺序由 Comfy 队列决定。
app.post('/api/jobs/batch', async (req, res) => {
  try {
    const input = req.body || {};
    if (!Array.isArray(input.requests) || input.requests.length < 1 || input.requests.length > 20) throw { status: 400, message: 'Invalid batch' };
    const jobs = [];
    for (const item of input.requests) jobs.push(createJobCore(item, req.user).job);
    // 待转发的＝本次新建的，或之前转发失败后仍处于 queued 的重试（原站同样只转发 queued 的）
    const pending = [];
    for (const job of jobs) {
      const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(job.id);
      if (row && row.status === 'queued') pending.push(row);
    }
    if (pending.length) await forwardJobs(pending, req.user);
    return ok(res, { jobs: jobs.map(j => { try { return jobDetail(j.id, req.user.id); } catch { return j; } }), balance: creditBalance(req.user.id) });
  } catch (e) { return apiError(res, e.status || 400, e.message); }
});

function gateSession(userId, input) {
  const active = db.prepare('SELECT * FROM active_sessions WHERE owner_id=?').get(userId);
  const sid = input.parameters?.session_id;
  if (sid && active && sid !== active.session_id) {
    db.prepare("UPDATE jobs SET visible=0,status=IIF(status='queued','cancelled',status),updated_at=? WHERE owner_id=? AND visible=1 AND COALESCE(json_extract(parameters,'$.session_id'),'')!=?")
      .run(Date.now(), userId, sid);
  }
}

// ---------- 转发给本机（对齐原站 forwardJob / 批量 /submit） ----------
function markRunning(jobId, workerId, promptId) {
  db.prepare("UPDATE jobs SET status='running',worker_id=?,prompt_id=?,lease_token=?,lease_expires_at=?,updated_at=MAX(updated_at+1,?) WHERE id=? AND status='queued'")
    .run(workerId, promptId, crypto.randomUUID(), 8640000000000000, Date.now(), jobId);
}
function markSubmitFailed(jobId, message) {
  db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=MAX(updated_at+1,?) WHERE id=? AND status='queued'")
    .run(String(message).slice(0, 1000), Date.now(), jobId);
}
// 单条转发。
async function forwardJob(job, user) {
  if (!REQUEST_ONLY || job.status !== 'queued') return;
  const w = localOnline();
  const reply = await sendToWorker(w.id, { type: 'submit', job: { ...job, parameters: JSON.parse(job.parameters), owner_username: user.username } });
  const item = reply && Array.isArray(reply.results) ? reply.results[0] : null;
  if (item && item.error) { markSubmitFailed(job.id, '本机提交失败：' + item.error); throw { status: 502, message: '本机提交失败，请检查本机程序与 ComfyUI' }; }
  const promptId = item && item.prompt_id;
  if (typeof promptId !== 'string' || !promptId || promptId.length > 128) throw { status: 502, message: 'Invalid submission acknowledgement' };
  markRunning(job.id, w.id, promptId);
}
// 整批一次转发：**一次消息发出整批**，本机自己按序提交给 ComfyUI。
async function forwardJobs(jobs, user) {
  if (!REQUEST_ONLY || !jobs.length) return;
  const w = localOnline();
  const payload = jobs.map(j => ({ ...j, parameters: JSON.parse(j.parameters), owner_username: user.username }));
  const timeout = Math.max(25000, 8000 + payload.length * 4000);
  const reply = await sendToWorker(w.id, { type: 'submit', jobs: payload }, timeout);
  const items = reply && Array.isArray(reply.results) ? reply.results : null;
  if (!items) throw { status: 502, message: 'Invalid submission acknowledgement' };
  let bad = 0;
  for (const item of items) {
    if (!jobs.some(j => j.id === item.id)) throw { status: 502, message: 'Unexpected task acknowledgement' };
    if (item.error) { bad++; markSubmitFailed(item.id, '本机提交失败：' + item.error); continue; }
    if (typeof item.prompt_id !== 'string' || !item.prompt_id || item.prompt_id.length > 128) throw { status: 502, message: 'Invalid submission acknowledgement' };
    markRunning(item.id, w.id, item.prompt_id);
  }
  if (bad || items.length !== jobs.length) throw { status: 503, message: 'Some tasks were not acknowledged; retry the same batch and check local monitor' };
}

// 本机 worker 心跳（WS 连入时也会更新；这里保留 REST 以兼容旧逻辑）
app.post('/api/worker/heartbeat', (req, res) => {
  try {
    const input = req.body || {};
    if (!isName(input.worker_id || '') || typeof input.ready !== 'boolean') throw { status: 400, message: '执行程序信息错误' };
    const workflows = manifest(input.workflows);
    const priority = Number.isSafeInteger(input.priority) && input.priority >= 0 && input.priority <= 1000000 ? input.priority : 0;
    db.prepare(`INSERT INTO workers(id,ready,workflows,last_seen,image_url,queue_waiting,queue_running,priority)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ready=excluded.ready,workflows=excluded.workflows,last_seen=excluded.last_seen,image_url=excluded.image_url,queue_waiting=excluded.queue_waiting,queue_running=excluded.queue_running,priority=excluded.priority`)
      .run(input.worker_id, input.ready ? 1 : 0, JSON.stringify(workflows), Date.now(), '', input.queue_waiting ?? null, input.queue_running ?? null, priority);
    return ok(res, {});
  } catch (e) { return apiError(res, e.status || 400, e.message); }
});
app.post('/api/worker/claim', (req, res) => {
  try {
    if (REQUEST_ONLY) return ok(res, { job: null });
    const input = req.body || {};
    if (!isName(input.worker_id || '')) throw { status: 400, message: '执行程序 ID 错误' };
    if (!Array.isArray(input.workflow_ids) || input.workflow_ids.length < 1 || input.workflow_ids.length > 16 || !input.workflow_ids.every(isName)) throw { status: 400, message: '工作流列表错误' };
    db.prepare("UPDATE jobs SET status='cancelled',error='Real-person style is available only to asus.',updated_at=? WHERE status='queued' AND json_extract(parameters,'$.art_style')='real' AND NOT EXISTS(SELECT 1 FROM users WHERE users.id=jobs.owner_id AND users.username='asus')").run(Date.now());
    const w = db.prepare('SELECT * FROM workers WHERE id=?').get(input.worker_id);
    if (!w || w.ready !== 1 || w.last_seen <= Date.now() - ONLINE_MS) throw { status: 409, message: '执行程序未就绪' };
    const supported = JSON.parse(w.workflows).map(x => x.id);
    if (!input.workflow_ids.every(x => supported.includes(x))) throw { status: 400, message: '工作流未登记' };
    const busy = db.prepare("SELECT id FROM jobs WHERE worker_id=? AND status='running'").get(input.worker_id);
    if (busy) throw { status: 409, message: '执行程序已有任务，请先恢复该任务' };
    const placeholders = input.workflow_ids.map(() => '?').join(',');
    const token = crypto.randomUUID();
    const job = db.prepare(`UPDATE jobs SET status='running',worker_id=?,lease_token=?,lease_expires_at=?,updated_at=?
      WHERE id=(SELECT id FROM jobs WHERE status='queued' AND workflow_id IN (${placeholders}) ORDER BY created_at,id LIMIT 1)
      AND status='queued' AND NOT EXISTS(SELECT 1 FROM jobs WHERE worker_id=? AND status='running') RETURNING *`)
      .get(input.worker_id, token, Date.now() + LEASE_MS, ...input.workflow_ids, input.worker_id);
    const owner = job && db.prepare('SELECT username FROM users WHERE id=?').get(job.owner_id);
    return ok(res, { job: job ? { ...job, owner_username: job.owner_id === 'legacy' ? 'admin' : owner?.username ?? null, parameters: JSON.parse(job.parameters) } : null });
  } catch (e) { return apiError(res, e.status || 409, e.message); }
});
app.post('/api/worker/jobs/:id/heartbeat', (req, res) => {
  try {
    const now = Date.now(); const { id } = req.params;
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!job || job.status !== 'running') throw { status: 409, message: '任务租约已失效' };
    const ch = db.prepare("UPDATE jobs SET lease_expires_at=?,updated_at=? WHERE id=? AND status='running' AND lease_expires_at>?")
      .run(now + LEASE_MS, now, id, now);
    if (ch.changes !== 1) throw { status: 409, message: '任务租约已失效' };
    return ok(res, { lease_expires_at: now + LEASE_MS });
  } catch (e) { return apiError(res, e.status || 409, e.message); }
});
app.post('/api/worker/jobs/:id/complete', (req, res) => workerMarkCompleteHttp(req, res));
app.post('/api/worker/jobs/:id/fail', (req, res) => {
  try { const { id } = req.params; const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!job || job.status !== 'running') throw { status: 409, message: '任务租约已失效' };
    const err = String(req.body?.error || 'generation failed').slice(0, 1000);
    db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='running'").run(err, Date.now(), id);
    return ok(res, { job: jobDetail(id, job.owner_id) });
  } catch (e) { return apiError(res, e.status || 409, e.message); }
});
function workerMarkCompleteHttp(req, res) {
  try { const { id } = req.params; const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!job || job.status !== 'running') throw { status: 409, message: '任务租约已失效' };
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM results WHERE job_id=?').get(id).c;
    if (cnt > 0) db.prepare("UPDATE jobs SET status='succeeded',updated_at=? WHERE id=? AND status='running'").run(Date.now(), id);
    return ok(res, { job: jobDetail(id, job.owner_id) });
  } catch (e) { return apiError(res, e.status || 409, e.message); }
}
app.put('/api/worker/jobs/:id/results/:index', (req, res) => {
  try {
    const { id, index } = req.params; const now = Date.now();
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!job || job.status !== 'running') throw { status: 409, message: '任务租约已失效' };
    const input = req.body || {};
    if (Number(index) >= 8 || !['image/png', 'image/jpeg', 'image/webp'].includes(input.content_type) || !(Number.isInteger(input.size) && input.size > 0 && input.size <= IMAGE_LIMIT) || !/^[0-9a-f]{64}$/.test(input.sha256 || '') || input.object_key !== id + '_' + Number(index)) throw { status: 409, message: '图片标识错误' };
    db.prepare(`INSERT INTO results(job_id,result_index,object_key,content_type,size,sha256) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id,result_index) DO NOTHING`)
      .run(id, Number(index), input.object_key, input.content_type, input.size, input.sha256);
    const stored = db.prepare('SELECT * FROM results WHERE job_id=? AND result_index=?').get(id, Number(index));
    if (!stored || stored.sha256 !== input.sha256 || stored.size !== input.size || stored.content_type !== input.content_type) throw { status: 409, message: '任务失效或图片信息冲突' };
    return ok(res, { result: { index: Number(index), size: input.size, sha256: input.sha256 } });
  } catch (e) { return apiError(res, e.status || 409, e.message); }
});

// ---------- HTTP + WS ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token') || '';
  if (sha256hex(token) !== sha256hex(WORKER_TOKEN)) { ws.close(4001, 'bad token'); return; }
  let workerId = null;
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'hello') {
      workerId = msg.worker_id;
      const workflows = manifest(msg.workflows);
      const priority = Number.isSafeInteger(msg.priority) && msg.priority >= 0 && msg.priority <= 1000000 ? msg.priority : 0;
      db.prepare(`INSERT INTO workers(id,ready,workflows,last_seen,image_url,queue_waiting,queue_running,priority)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ready=excluded.ready,workflows=excluded.workflows,last_seen=excluded.last_seen,image_url='',queue_waiting=excluded.queue_waiting,queue_running=excluded.queue_running,priority=excluded.priority`)
        .run(workerId, msg.ready ? 1 : 0, JSON.stringify(workflows), Date.now(), '', msg.queue_waiting ?? null, msg.queue_running ?? null, priority);
      workerSockets.set(workerId, ws);
      try { ws.send(JSON.stringify({ type: 'hello_ack', ts: Date.now() })); } catch {}
      console.log('[ws] worker 连入:', workerId, 'workflows:', workflows.map(w => w.id).join(','));
    } else if (workerId) {
      handleWorkerMessage(workerId, data.toString());
    }
  });
  ws.on('close', () => { if (workerId) { workerSockets.delete(workerId); console.log('[ws] worker 断开:', workerId); } });
});

server.listen(PORT, () => console.log(`[dateher-render-mirror] 监听 ${PORT}，REQUEST_ONLY=${REQUEST_ONLY}，CREDITS=${CREDITS_ENABLED}`));
