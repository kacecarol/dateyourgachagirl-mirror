// dateyourgachagirl 统一本机出图程序
// 一个程序同时连接两个云端，共用你本机的同一个 ComfyUI：
//   1) Render 镜像（反向 WebSocket，云端主动下发任务）—— 默认开启
//   2) Cloudflare 原站（本地网关 + cloudflared 隧道，云端顺着隧道来取图）—— 配置了 RELAY_URL + RELAY_TOKEN 才开启
// 两个云端共享单一作业状态（同一时刻只处理一个任务），画图引擎只有一个 ComfyUI。
//
// 启动：node worker.js   （需本机 ComfyUI 在运行，默认 127.0.0.1:8189）
// 所有密钥通过环境变量 / worker.env 提供，不要写死在代码里。

// 本机出图程序零依赖：使用 Node 22+ 内置的全局 WebSocket（无需 npm install）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import child_process from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = __dirname;

// ---------- 读取 worker.env（不入库的本机密钥文件；不存在就用纯环境变量） ----------
(function loadEnvFile() {
  try {
    // worker.env 放在项目根目录（worker.js 在 worker/ 子目录里）
    const candidates = [path.join(BASE, '..', 'worker.env'), path.join(process.cwd(), 'worker.env'), path.join(BASE, 'worker.env')];
    const envPath = candidates.find(p => fs.existsSync(p));
    if (!envPath) return;
    const text = fs.readFileSync(envPath, 'utf-8').replace(/^\uFEFF/, '');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) val = val.slice(1, -1);
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch (e) { /* 读不到就忽略，交给环境变量 */ }
})();

// ---------- 配置（来自环境变量 / worker.env） ----------
const RENDER_WS = (process.env.RENDER_WS || 'wss://dateyourgachagirl-mirror.onrender.com/ws').replace(/\/$/, '');
const RENDER_TOKEN = process.env.RENDER_TOKEN || '';
const RELAY_URL = (process.env.RELAY_URL || 'https://date-your-gacha-girl.pages.dev').replace(/\/$/, '');
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const COMFY_URL = (process.env.COMFY_URL || 'http://127.0.0.1:8189').replace(/\/$/, '');
const WORKER_ID = process.env.WORKER_ID || 'local-studio-1';
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || '8790', 10);
const CLOUDFLARED = process.env.CLOUDFLARED || 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
const HTTP_TIMEOUT = 30000;
const POLL = 2000;
const JOB_TIMEOUT = 1800 * 1000;
const ENABLE_RENDER = RENDER_TOKEN.length >= 32;
const ENABLE_CLOUDFLARE = RELAY_URL.length > 0 && RELAY_TOKEN.length >= 32;

// 工作流配置（镜像版；模板复用原文件）
const WORKFLOWS = JSON.parse(fs.readFileSync(path.join(BASE, 'workflows', 'mirror_workflows.json'), 'utf-8'));

const PARAM_NAMES = ['positive', 'negative', 'width', 'height', 'steps', 'cfg', 'seed'];
const DATEHER_NAMES = [...PARAM_NAMES, 'character', 'art_style', 'shot', 'personality_tags', 'session_id', 'page_index', 'session_config'];

// ---------- 工具 ----------
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function isUuid(v) { return typeof v === 'string' && /^[0-9a-f]{8}-[9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v); }
// Node 不支持 'utf-8-sig' 编码，这里等价实现：读 utf8 并去掉 BOM
function readJson(p) { let s = fs.readFileSync(p, 'utf8'); if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); return JSON.parse(s); }
function safeCompare(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

// dateher_adapter.build_prompt 移植（仅 dateher / dateher_full 用到）
function dedupPrompt(text) {
  const groups = {};
  for (const part of text.split(',').map(p => p.trim())) {
    if (!part) continue;
    const m = part.match(/^\((.+?):[\d.]+$/);
    const base = (m ? m[1] : part).toLowerCase().replace(/\s+/g, '_');
    if (!(base in groups) || (m && !/^\(.+:[\d.]+$/.test(groups[base]))) groups[base] = part;
  }
  const result = Object.values(groups).join(',');
  return result + (result && text.trim().endsWith(',') ? ',' : '');
}
const GAME_SUFFIXES = { genshin: 'genshin_impact', hsr: 'honkai_star_rail', zzz: 'zenless_zone_zero', wuwa: 'wuthering_waves', endfield: 'arknights_endfield', NevernessToEverness: 'neverness_to_everness', ananta: 'ananta' };
function loadCatalogs() {
  const dir = path.join(BASE, 'workflows');
  const characters = readJson(path.join(dir, 'dateher_char_catalog.json'));
  const config = readJson(path.join(dir, 'dateher_prompt_config.json'));
  return { characters, config };
}
function buildPrompt(original, values, characters, config) {
  const graph = JSON.parse(JSON.stringify(original));
  const character = values.character;
  const char = characters[character];
  if (!char) throw new Error('Unknown character');
  const style = values.art_style || 'anime_special';
  const lora = char.currentLora;
  if (lora) graph['3'].inputs.lora_name = lora;
  for (const field of ['strength_model', 'strength_clip']) { graph['3'].inputs[field] = lora ? 1 : 0; graph['5'].inputs[field] = config.lora?.style?.[style] ?? 0; }
  for (const key of ['width', 'height']) if (key in values) graph['6'].inputs[key] = values[key];
  let body = config.bodyTypeTags?.[String(char.bodyType)] || '';
  let tags = char.charTags || '';
  if (!tags) { const name = char.character.replace(/\s+/g, '_').toLowerCase(); const suffix = GAME_SUFFIXES[char.gameId] || ''; tags = name + (suffix ? '_(' + suffix + ')' : '') + ',1girl,'; body = ''; }
  const headwear = char.headwear || '';
  const seen = new Set(); const uniq = [];
  for (const t of tags.split(',').map(s => s.trim())) if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); uniq.push(t); }
  tags = uniq.join(', ') + (uniq.length ? ',' : '');
  let shot = values.shot || config.shotDefault || 'full body';
  if (shot === 'none' || values.session_config?.promptLang === 'nl') shot = '';
  const base = config.textA?.[style] || config.textA?.anime_normal || '';
  graph['13'].inputs.text_a = dedupPrompt(base + body + tags + (headwear ? ',' + headwear : '') + (shot ? ',' + shot : ''));
  graph['13'].inputs.text_b = values.positive;
  const personality = (values.personality_tags || '').trim();
  graph['13'].inputs.text_c = personality + (personality && !personality.endsWith(',') ? ',' : '');
  if ('seed' in values) for (const n of ['7', '9', '10']) graph[n].inputs.seed = values.seed;
  graph['21'].inputs.Text = character;
  graph['20'].inputs.Text = 'relay/dateher/' + values.session_id.toLowerCase() + '/' + String(values.page_index).padStart(2, '0');
  return graph;
}

// ---------- 共享 ComfyUI HTTP ----------
function comfyRequest(method, p, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(COMFY_URL + p);
    const data = payload ? JSON.stringify(payload) : null;
    const req = http.request(url, { method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      const chunks = []; let total = 0;
      res.on('data', c => { total += c.length; if (total > 32 * 1024 * 1024) { res.destroy(); reject(new Error('response too large')); } chunks.push(c); });
      res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error('comfy http ' + res.statusCode)); return; }
        const buf = Buffer.concat(chunks);
        if (method === 'GET' && p.startsWith('/view')) resolve({ data: buf, mime: res.headers['content-type'] || 'image/png' });
        else { try { resolve(JSON.parse(buf.toString('utf-8'))); } catch { reject(new Error('comfy invalid json')); } }
      });
    });
    req.on('error', reject); req.setTimeout(HTTP_TIMEOUT, () => { req.destroy(); reject(new Error('comfy timeout')); });
    if (data) req.write(data); req.end();
  });
}
async function comfyReady() {
  try { const s = await comfyRequest('GET', '/system_stats'); return !!s && typeof s === 'object'; } catch { return false; }
}

// ---------- 共享作业状态机 ----------
const journalPath = path.join(BASE, 'worker_journal.json');
const imageDir = path.join(BASE, 'state', 'images');
let state = null; // { job, phase, prompt_id, deadline, cloud, msgId, sink }
function saveState() { try { fs.writeFileSync(journalPath + '.tmp', JSON.stringify(state)); fs.renameSync(journalPath + '.tmp', journalPath); } catch {} }
function clearState() { state = null; try { fs.unlinkSync(journalPath); } catch {} }
fs.mkdirSync(imageDir, { recursive: true });

function preparePrompt(job) {
  const wf = WORKFLOWS.find(w => w.id === job.workflow_id);
  if (!wf) throw new Error('Unknown workflow');
  const original = readJson(path.join(BASE, wf.template));
  if (wf.adapter === 'dateher') {
    const { characters, config } = loadCatalogs();
    return buildPrompt(original, job.parameters, characters, config);
  }
  const graph = JSON.parse(JSON.stringify(original));
  for (const [key, targets] of Object.entries(wf.mappings)) {
    if (!(key in job.parameters)) continue;
    for (const t of targets) graph[t.node].inputs[t.input] = job.parameters[key];
  }
  return graph;
}

// sink：不同云端用不同的"回传/确认"实现
function makeRenderSink(job, msgId) {
  return {
    cloud: 'render',
    onSubmitAck(promptId) { if (msgId && ws && ws.readyState === 1) send(ws, { msg_id: msgId, type: 'submit_ack', job_id: job.id, prompt_id: promptId }); },
    onResults(results) { if (ws && ws.readyState === 1) send(ws, { type: 'results', job_id: job.id, results }); },
    onComplete() { if (ws && ws.readyState === 1) send(ws, { type: 'complete', job_id: job.id }); },
    onFail(error) { if (ws && ws.readyState === 1) send(ws, { type: 'fail', job_id: job.id, error: String(error).slice(0, 1000) }); },
  };
}
function makeCloudflareSink(job, leaseToken) {
  return {
    cloud: 'cloudflare',
    onSubmitAck() { /* Cloudflare 不需要 submit_ack */ },
    async onResults(results) {
      for (const r of results) {
        await relayRequest('PUT', `/api/worker/jobs/${job.id}/results/${r.index}`, { worker_id: WORKER_ID, lease_token: leaseToken, ...r });
      }
    },
    async onComplete() { await relayRequest('POST', `/api/worker/jobs/${job.id}/complete`, { worker_id: WORKER_ID, lease_token: leaseToken }); },
    async onFail(error) { try { await relayRequest('POST', `/api/worker/jobs/${job.id}/fail`, { worker_id: WORKER_ID, lease_token: leaseToken, error: String(error).slice(0, 1000) }); } catch {} },
  };
}

// 核心：处理当前 state 指向的作业（共用 ComfyUI）
async function processJob() {
  if (!state || !state.sink) return false;
  const job = state.job;
  const sink = state.sink;
  try {
    if (state.phase === 'claimed' && !state.prompt_id) {
      const graph = preparePrompt(job);
      const reply = await comfyRequest('POST', '/prompt', { prompt: graph, client_id: WORKER_ID });
      if (!reply || typeof reply.prompt_id !== 'string' || !reply.prompt_id || reply.node_errors) throw new Error('Comfy did not acknowledge prompt');
      state.prompt_id = reply.prompt_id; state.phase = 'running'; state.deadline = Date.now() + JOB_TIMEOUT; saveState();
      sink.onSubmitAck(reply.prompt_id);
    }
    if (state.phase === 'running') {
      const history = await comfyRequest('GET', '/history/' + encodeURIComponent(state.prompt_id));
      const entry = history[state.prompt_id];
      if (!entry) return false; // 还没出完，等下一轮
      const status = entry.status || {};
      if (status.status_str === 'error' || (status.messages || []).some(m => Array.isArray(m) && (m[0] === 'execution_error' || m[0] === 'execution_interrupted'))) throw new Error('Comfy execution failed');
      if (!status.completed) return false;
      const wf = WORKFLOWS.find(w => w.id === job.workflow_id);
      const images = [];
      for (const nodeId of wf.output_nodes) {
        const out = entry.outputs?.[nodeId];
        for (const item of (out?.images || [])) {
          const desc = { filename: item.filename || '', subfolder: item.subfolder || '', type: item.type || '' };
          if (!desc.filename || desc.type !== 'output') continue;
          images.push(desc);
        }
      }
      if (images.length < 1 || images.length > 8) throw new Error('Expected 1..8 output images');
      state.images = images; state.phase = 'uploading'; saveState();
    }
    if (state.phase === 'uploading') {
      const results = [];
      for (let index = 0; index < state.images.length; index++) {
        const desc = state.images[index];
        const q = new URLSearchParams(desc).toString();
        const { data, mime } = await comfyRequest('GET', '/view?' + q);
        if (!data || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('Invalid output image');
        const digest = sha256(data);
        const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[mime];
        const key = job.id + '_' + index;
        // 统一存储：state/images/{key}.bin + {key}.json（Render 取图与 Cloudflare 隧道取图共用）
        fs.writeFileSync(path.join(imageDir, key + '.bin'), data);
        const metadata = { index, object_key: key, content_type: mime, size: data.length, sha256: digest };
        fs.writeFileSync(path.join(imageDir, key + '.json'), JSON.stringify(metadata));
        results.push(metadata);
      }
      state.phase = 'completing'; saveState();
      await sink.onResults(results);
      // onResults 是异步的（Cloudflare 需要等网络回写），await 完成再 complete
      if (sink.cloud !== 'cloudflare') { /* render 同步发送完毕 */ }
    }
    if (state.phase === 'completing') {
      await sink.onComplete();
      clearState();
      console.log('[ok] 任务已完成:', job.id, '（云端:', sink.cloud, '）');
      return true;
    }
    return false;
  } catch (e) {
    console.error('[err] 处理失败:', job.id, e.message);
    try { await sink.onFail(e.message); } catch {}
    clearState();
    return true;
  }
}

function ensureSink() {
  if (state && !state.sink) {
    if (state.cloud === 'cloudflare') state.sink = makeCloudflareSink(state.job, state.job.lease_token);
    else state.sink = makeRenderSink(state.job, state.msgId);
  }
}

// ================= Render 侧：反向 WebSocket =================
let ws = null, reconnectTimer = null, lastHeartbeat = 0, lastAck = 0, connStartAt = 0;
function send(wsObj, msg) { if (wsObj && wsObj.readyState === 1) wsObj.send(JSON.stringify(msg)); }
function manifest() {
  return WORKFLOWS.map(w => ({ id: w.id, name: w.name, parameters: w.adapter === 'dateher' ? DATEHER_NAMES : PARAM_NAMES }));
}
function connectRender() {
  connStartAt = Date.now();
  ws = new WebSocket(RENDER_WS + '?token=' + encodeURIComponent(RENDER_TOKEN));
  ws.addEventListener('open', () => { console.log('[render] 已连出到云端', RENDER_WS); lastAck = Date.now(); heartbeatRender(); });
  ws.addEventListener('message', (ev) => { const d = ev.data; handleRenderMessage(typeof d === 'string' ? d : Buffer.from(d).toString('utf-8')); });
  ws.addEventListener('close', () => { console.log('[render] 断开，3 秒后重连'); scheduleReconnect(); });
  ws.addEventListener('error', () => { console.log('[render] 连接错误'); scheduleReconnect(); });
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  if (ws && ws.readyState === 1) return;   // 已连上就不重复连
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectRender(); }, 3000);
}
function forceReconnect(reason) {
  console.log('[render] ' + reason + '，强制重连');
  try { if (ws) ws.close(); } catch {}
  ws = null;
  reconnectTimer = null;
  scheduleReconnect();
}
// 心跳保活 + 僵尸连接自愈：
//  - 云端每次 hello 都会回 hello_ack，长时间收不到应答说明这条 TCP 已经死了（例如云端重新部署）
//  - 连接长时间停在“连接中”也说明链路卡死
// 两种情况都必须强制重连，否则会永远卡住（这是之前“重部署后云端显示离线”的根因）。
function watchdog() {
  const st = ws ? ws.readyState : -1;
  const now = Date.now();
  if (st === 1) {
    if (lastAck && now - lastAck > 45000) { forceReconnect('心跳超时（45 秒无应答）'); return; }
    if (now - lastHeartbeat > 10000) heartbeatRender();
    return;
  }
  if (st === 0 && now - connStartAt < 15000) return;   // 还在连接中，再等等
  forceReconnect(st === 0 ? '连接长时间无进展' : '连接已断开');
}
async function heartbeatRender() {
  const ready = await comfyReady();
  send(ws, { type: 'hello', worker_id: WORKER_ID, ready, workflows: manifest(), queue_waiting: 0, queue_running: state ? 1 : 0 });
  lastHeartbeat = Date.now();
}
async function handleRenderMessage(str) {
  let msg; try { msg = JSON.parse(str); } catch { return; }
  if (msg.type === 'hello_ack') { lastAck = Date.now(); return; }
  if (msg.msg_id && msg.type === 'submit') {
    try {
      const job = msg.job;
      if (state) { send(ws, { msg_id: msg.msg_id, type: 'submit_ack', job_id: job.id, error: 'worker busy' }); return; }
      state = { job, phase: job.prompt_id ? 'running' : 'claimed', prompt_id: job.prompt_id || null, deadline: Date.now() + JOB_TIMEOUT, cloud: 'render', msgId: msg.msg_id };
      state.sink = makeRenderSink(job, msg.msg_id);
      saveState();
      try { await processJob(); } catch (e) { try { send(ws, { type: 'fail', job_id: job.id, error: String(e.message).slice(0, 1000) }); } catch {} clearState(); }
    } catch (e) { send(ws, { msg_id: msg.msg_id, type: 'submit_ack', job_id: msg.job?.id, error: e.message }); }
    return;
  }
  if (msg.type === 'load') {
    const jobs = [];
    for (const j of (msg.jobs || [])) {
      const results = [];
      for (let i = 0; i < 8; i++) { const f = path.join(imageDir, j.id + '_' + i + '.json'); if (fs.existsSync(f)) { try { results.push(JSON.parse(fs.readFileSync(f, 'utf-8'))); } catch {} } }
      jobs.push({ id: j.id, results });
    }
    send(ws, { type: 'load_result', jobs });
    return;
  }
  if (msg.type === 'fetch_image') {
    const key = msg.object_key;
    const jf = path.join(imageDir, key + '.json');
    const bf = path.join(imageDir, key + '.bin');
    if (!fs.existsSync(bf) || !fs.existsSync(jf)) { send(ws, { type: 'image_error', msg_id: msg.msg_id, error: 'not found' }); return; }
    const meta = JSON.parse(fs.readFileSync(jf, 'utf-8'));
    const buf = fs.readFileSync(bf);
    send(ws, { type: 'image', msg_id: msg.msg_id, content_type: meta.content_type || 'image/png', sha256: sha256(buf), size: buf.length, data: buf.toString('base64') });
    return;
  }
}

// ================= Cloudflare 侧：本地网关 + 隧道 + 拉取 =================
let cfTunnelUrl = process.env.CF_TUNNEL_URL || '';
let cfServer = null;
function cloudflareAuth(header) { return safeCompare(header || '', 'Bearer ' + RELAY_TOKEN); }
function startGateway() {
  const server = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    if (!cloudflareAuth(auth)) { res.writeHead(401); res.end('unauthorized'); return; }
    if (req.method === 'GET') {
      const m = req.url.match(/^\/(?:images|previews)\/([0-9a-f-]{36}_[0-7])$/);
      if (!m) { res.writeHead(404); res.end('not found'); return; }
      const key = m[1];
      const jf = path.join(imageDir, key + '.json');
      const bf = path.join(imageDir, key + '.bin');
      if (!fs.existsSync(bf) || !fs.existsSync(jf)) { res.writeHead(404); res.end('not found'); return; }
      try {
        const meta = JSON.parse(fs.readFileSync(jf, 'utf-8'));
        const buf = fs.readFileSync(bf);
        if (sha256(buf) !== meta.sha256) { res.writeHead(409); res.end('checksum mismatch'); return; }
        res.writeHead(200, { 'Content-Type': meta.content_type || 'image/png', 'Content-Length': String(buf.length), 'X-Content-SHA256': meta.sha256, 'Cache-Control': 'no-store' });
        res.end(buf);
      } catch { res.writeHead(404); res.end('not found'); }
      return;
    }
    res.writeHead(405); res.end('method not allowed');
  });
  server.on('error', (e) => console.error('[cloudflare] 本地取图网关监听失败:', e.message, '（端口可能被占用；Cloudflare 取图通道将不可用，Render 不受影响）'));
  server.listen(GATEWAY_PORT, '127.0.0.1', () => console.log('[cloudflare] 本地取图网关已监听 127.0.0.1:' + GATEWAY_PORT));
  return server;
}
function startTunnel() {
  let proc;
  try {
    proc = child_process.spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:' + GATEWAY_PORT], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) { console.error('[cloudflare] 无法启动 cloudflared:', e.message); return; }
  let buf = '';
  proc.stderr.on('data', d => {
    buf += d.toString();
    const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !cfTunnelUrl) { cfTunnelUrl = m[0]; console.log('[cloudflare] 取图隧道已建立:', cfTunnelUrl); }
  });
  proc.on('exit', (code) => { console.error('[cloudflare] cloudflared 退出，代码', code, '—— Cloudflare 取图通道断开'); cfTunnelUrl = ''; setTimeout(startTunnel, 5000); });
}
function relayRequest(method, p, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(RELAY_URL + p);
    const mod = url.protocol === 'https:' ? https : http;
    const data = payload ? JSON.stringify(payload) : null;
    const req = mod.request(url, { method, headers: { 'Authorization': 'Bearer ' + RELAY_TOKEN, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error('relay http ' + res.statusCode)); return; }
        const s = Buffer.concat(chunks).toString('utf-8');
        try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('relay invalid json')); }
      });
    });
    req.on('error', reject); req.setTimeout(HTTP_TIMEOUT, () => { req.destroy(); reject(new Error('relay timeout')); });
    if (data) req.write(data); req.end();
  });
}
async function cloudflareHeartbeat() {
  const ready = await comfyReady();
  const body = { worker_id: WORKER_ID, ready, workflows: manifest(), image_url: cfTunnelUrl, queue_waiting: 0, queue_running: state ? 1 : 0 };
  try { await relayRequest('POST', '/api/worker/heartbeat', body); }
  catch (e) { console.error('[cloudflare] heartbeat 失败:', e.message); }
}
async function cloudflareLoop() {
  try {
    if (state) {
      ensureSink();
      // 续租
      if (state.cloud === 'cloudflare' && state.job.lease_token) {
        const payload = { worker_id: WORKER_ID, lease_token: state.job.lease_token };
        if (state.prompt_id) payload.prompt_id = state.prompt_id;
        try { await relayRequest('POST', `/api/worker/jobs/${state.job.id}/heartbeat`, payload); } catch {}
      }
      await processJob();
      return;
    }
    // 空闲：先 heartbeat（需要隧道已建好），再 claim
    if (!cfTunnelUrl) { await cloudflareHeartbeat().catch(() => {}); return; }
    await cloudflareHeartbeat();
    const ready = await comfyReady();
    if (!ready) { console.log('[cloudflare] ComfyUI 离线，暂停领取'); return; }
    const reply = await relayRequest('POST', '/api/worker/claim', { worker_id: WORKER_ID, workflow_ids: WORKFLOWS.map(w => w.id) });
    if (reply && reply.job) {
      const j = reply.job;
      state = { job: j, phase: j.prompt_id ? 'running' : 'claimed', prompt_id: j.prompt_id || null, deadline: Date.now() + JOB_TIMEOUT, cloud: 'cloudflare' };
      state.sink = makeCloudflareSink(j, j.lease_token);
      saveState();
      await processJob();
    }
  } catch (e) { console.error('[cloudflare] loop 错误:', e.message); }
}

// ================= 启动 =================
// 恢复未完成日志
if (fs.existsSync(journalPath)) { try { state = JSON.parse(fs.readFileSync(journalPath, 'utf-8')); console.log('[worker] 恢复未完成任务', state?.job?.id, '（云端:', state?.cloud, '）'); } catch {} }

if (ENABLE_RENDER) {
  connectRender();
  setInterval(watchdog, 10000);
  setInterval(async () => { if (state && state.cloud === 'render') { ensureSink(); await processJob().catch(e => console.error('[render] processJob', e.message)); } }, POLL);
  console.log('[render] 模块已启用，连出至', RENDER_WS);
} else {
  console.log('[render] 未配置 RENDER_TOKEN，跳过 Render 连接');
}

if (ENABLE_CLOUDFLARE) {
  cfServer = startGateway();
  if (cfTunnelUrl) console.log('[cloudflare] 使用预置隧道地址:', cfTunnelUrl);
  else startTunnel();
  setInterval(cloudflareLoop, POLL);
  console.log('[cloudflare] 模块已启用，云端', RELAY_URL);
} else {
  console.log('[cloudflare] 未配置 RELAY_URL + RELAY_TOKEN，跳过 Cloudflare 连接（仅 Render 生效）');
}

console.log('[worker] 启动，本机 ComfyUI', COMFY_URL, '| 统一出图程序就绪');
