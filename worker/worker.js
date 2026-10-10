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

// ---------- 把图里的 LoRA 名对齐到“本机实际安装”的文件 ----------
// 模板与角色目录里的 LoRA 文件名来自素材来源方，换一台机器常常对不上，
// 直接提交会被 ComfyUI 判为 value_not_in_list（表现为“出不了图”）。
// 这里按角色名在本机已安装列表里找同名文件，找不到再退回模板原值。
let loraCache = { at: 0, list: [] };
async function installedLoras() {
  if (loraCache.list.length && Date.now() - loraCache.at < 10 * 60 * 1000) return loraCache.list;
  try {
    const info = await comfyRequest('GET', '/object_info/LoraLoader');
    const list = info && info.LoraLoader && info.LoraLoader.input && info.LoraLoader.input.required && info.LoraLoader.input.required.lora_name && info.LoraLoader.input.required.lora_name[0];
    if (Array.isArray(list) && list.length) loraCache = { at: Date.now(), list };
  } catch { /* 查询失败则沿用旧缓存 */ }
  return loraCache.list;
}
const normalizeName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function pickCharacterLora(list, character) {
  const target = normalizeName(character);
  if (!target) return null;
  const base = n => normalizeName(String(n).split(/[\\/]/).pop().replace(/\.safetensors$/i, ''));
  const pool = list.filter(n => /^characterlora[\\/]/i.test(n));
  const exact = pool.find(n => base(n) === target)
      || pool.find(n => base(n).startsWith(target))
      || pool.find(n => base(n).includes(target))
      || pool.find(n => normalizeName(n).includes(target));
  if (exact) return exact;
  // 兜底：角色全名往往很长（如 "Anastasya Feodorovna Snezhnaya"），而 LoRA 文件名常只取首名
  // （anastasya-Ill-zeroV1）。整名匹配不上时，退化为"首个单词"匹配。
  const first = (String(character || '').toLowerCase().match(/[a-z]{4,}/) || [])[0];
  if (first && first !== target) {
    return pool.find(n => base(n) === first)
        || pool.find(n => base(n).startsWith(first))
        || pool.find(n => base(n).includes(first))
        || null;
  }
  return null;
}
async function alignLoras(graph, character) {
  const list = await installedLoras();
  if (!list.length) return graph;
  for (const node of Object.values(graph)) {
    if (!node || node.class_type !== 'LoraLoader') continue;
    const inputs = node.inputs || {};
    if (typeof inputs.lora_name !== 'string' || list.includes(inputs.lora_name)) continue;
    // 角色 LoRA：按角色名找本机同名文件（并确保强度为 1）
    const picked = character ? pickCharacterLora(list, character) : null;
    if (picked) {
      console.log('[worker] 角色 LoRA 对齐:', character, '→', picked);
      inputs.lora_name = picked; inputs.strength_model = 1; inputs.strength_clip = 1;
      continue;
    }
    const strength = Number(inputs.strength_model || 0) || Number(inputs.strength_clip || 0);
    if (strength === 0) { console.log('[worker] LoRA 未安装但强度为 0，已替换占位:', inputs.lora_name); inputs.lora_name = list[0]; }
    else throw new Error('LoRA 未安装，请检查本机模型：' + inputs.lora_name);
  }
  return graph;
}

// ComfyUI 的 /prompt 成功时也会返回 node_errors:{}（空对象），空对象在 JS 里是真值，
// 直接用 reply.node_errors 判断会把成功当成失败。必须看有没有真正的键。
function hasPromptErrors(reply) {
  if (!reply || !reply.node_errors) return false;
  if (typeof reply.node_errors !== 'object') return Boolean(reply.node_errors);
  return Object.keys(reply.node_errors).length > 0;
}

async function preparePrompt(job) {
  const wf = WORKFLOWS.find(w => w.id === job.workflow_id);
  if (!wf) throw new Error('Unknown workflow');
  const original = readJson(path.join(BASE, wf.template));
  if (wf.adapter === 'dateher') {
    const { characters, config } = loadCatalogs();
    const graph = buildPrompt(original, job.parameters, characters, config);
    return alignLoras(graph, job.parameters.character);
  }
  const graph = JSON.parse(JSON.stringify(original));
  for (const [key, targets] of Object.entries(wf.mappings)) {
    if (!(key in job.parameters)) continue;
    for (const t of targets) graph[t.node].inputs[t.input] = job.parameters[key];
  }
  return alignLoras(graph, null);
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
      const graph = await preparePrompt(job);
      const reply = await comfyRequest('POST', '/prompt', { prompt: graph, client_id: WORKER_ID });
      if (!reply || typeof reply.prompt_id !== 'string' || !reply.prompt_id || hasPromptErrors(reply)) throw new Error('Comfy did not acknowledge prompt' + (reply && hasPromptErrors(reply) ? ': ' + JSON.stringify(reply.node_errors).slice(0, 400) : ''));
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

// ================= Cloudflare 侧：本地网关 + 隧道 + 请求模式 =================
// 主站（date-your-gacha-girl.pages.dev）以 REQUEST_ONLY=true 运行：
//   1) 用户提交 → 云端 POST 本机网关 /submit  → 本机把任务丢给 ComfyUI，立刻返回 prompt_id
//   2) 用户点“载入” → 云端 POST 本机网关 /load → 本机去 ComfyUI 取历史、落盘、返回图片元数据
//   3) 云端再顺着隧道 GET /images|/previews/{key} 把图取走
// 因此网关必须同时实现 POST /submit、POST /load、GET /images|/previews —— 缺一个就会 405。
let cfTunnelUrl = process.env.CF_TUNNEL_URL || '';
let cfServer = null;
const dispatchDir = path.join(BASE, 'state', 'dispatch_jobs');
fs.mkdirSync(dispatchDir, { recursive: true });

function cloudflareAuth(header) { return safeCompare(header || '', 'Bearer ' + RELAY_TOKEN); }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('payload too large')); try { req.destroy(); } catch {} return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 任务提交记录：{job, phase, prompt_id}，/load 靠它找回 prompt_id；重复 /submit 直接复用（幂等）
function dispatchPath(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid task ID');
  return path.join(dispatchDir, id + '.json');
}
function readDispatch(id) { try { return readJson(dispatchPath(id)); } catch { return null; } }
function writeDispatch(id, record) {
  const target = dispatchPath(id);
  fs.writeFileSync(target + '.tmp', JSON.stringify(record));
  fs.renameSync(target + '.tmp', target);
}

// ---------- 图片尺寸（用于 X-Original-Width/Height） ----------
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      const len = buf.readUInt16BE(i + 2);
      if (!len || len < 2) break;
      i += 2 + len;
    }
  }
  return null;
}

// ---------- 转成全分辨率 JPEG（主站开积分时，云端预览强制要求 image/jpeg） ----------
let ffmpegPath;
function findFfmpeg() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  const candidates = [process.env.FFMPEG, 'C:\\Users\\asus\\.33TaiCi\\plugin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe', 'ffmpeg'].filter(Boolean);
  ffmpegPath = null;
  for (const candidate of candidates) {
    try { if (candidate === 'ffmpeg' || fs.existsSync(candidate)) { ffmpegPath = candidate; break; } } catch {}
  }
  if (ffmpegPath) console.log('[cloudflare] 使用 JPEG 转码器:', ffmpegPath);
  else console.error('[cloudflare] 未找到 ffmpeg：图片预览将按原格式返回（一般仍可显示）');
  return ffmpegPath;
}
function toJpeg(buf) {
  const bin = findFfmpeg();
  if (!bin) return Promise.resolve(null);
  return new Promise(resolve => {
    let proc;
    try {
      proc = child_process.spawn(bin, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-an', '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return resolve(null); }
    const chunks = []; let done = false;
    const finish = value => { if (!done) { done = true; resolve(value); } };
    proc.stdout.on('data', c => chunks.push(c));
    proc.on('error', () => finish(null));
    proc.on('close', code => { const out = Buffer.concat(chunks); finish(code === 0 && out.length ? out : null); });
    proc.stdin.on('error', () => {});
    proc.stdin.end(buf);
    setTimeout(() => { try { proc.kill(); } catch {} finish(null); }, 15000);
  });
}

// ---------- /submit：把任务交给 ComfyUI，立刻返回 prompt_id（不等待出图） ----------
async function submitOne(job) {
  if (!job || typeof job.id !== 'string') throw new Error('Invalid task');
  const previous = readDispatch(job.id);
  if (previous && typeof previous.prompt_id === 'string') return { prompt_id: previous.prompt_id };
  const graph = await preparePrompt(job);
  const reply = await comfyRequest('POST', '/prompt', { prompt: graph, client_id: WORKER_ID });
  if (!reply || typeof reply.prompt_id !== 'string' || !reply.prompt_id || hasPromptErrors(reply)) throw new Error('Backend did not acknowledge submission' + (reply && hasPromptErrors(reply) ? ': ' + JSON.stringify(reply.node_errors).slice(0, 400) : ''));
  writeDispatch(job.id, { job, phase: 'submitted', prompt_id: reply.prompt_id, submitted_at: Date.now() });
  console.log('[cloudflare] 已提交出图:', job.id, '→ prompt_id', reply.prompt_id);
  return { prompt_id: reply.prompt_id };
}
async function submitMany(jobs) {
  const results = [];
  for (const job of jobs) {
    try { results.push({ id: job && job.id, ...(await submitOne(job)) }); }
    catch (e) { results.push({ id: job && job.id, error: String(e.message || e) }); }
  }
  return results;
}

// ---------- /load：用户点“载入”时，取 ComfyUI 历史、落盘、返回图片元数据 ----------
async function collectJob(job) {
  const record = readDispatch(job.id);
  const promptId = (record && record.prompt_id) || job.prompt_id;
  if (!promptId) return null;                                   // 还没提交过，稍后再试
  const history = await comfyRequest('GET', '/history/' + encodeURIComponent(promptId));
  const entry = history && history[promptId];
  if (!entry) return null;                                      // 还没排到 / 还没有历史
  const status = entry.status || {};
  if (status.status_str === 'error' || (status.messages || []).some(m => Array.isArray(m) && (m[0] === 'execution_error' || m[0] === 'execution_interrupted')))
    return { id: job.id, error: 'Backend execution failed' };
  if (!status.completed) return null;                           // 还在画，等用户下次载入
  const wf = WORKFLOWS.find(w => w.id === job.workflow_id);
  if (!wf) return { id: job.id, error: 'Unknown workflow' };
  const images = [];
  for (const nodeId of wf.output_nodes) {
    for (const item of ((entry.outputs || {})[nodeId] || {}).images || []) {
      const desc = { filename: item.filename || '', subfolder: item.subfolder || '', type: item.type || '' };
      if (!desc.filename || desc.type !== 'output') continue;
      for (const key of ['filename', 'subfolder']) {
        const value = String(desc[key]).replace(/\\/g, '/');
        if (value.startsWith('/') || value.includes(':') || value.split('/').includes('..') || (key === 'filename' && value.includes('/'))) throw new Error('Unsafe output path');
      }
      images.push(desc);
    }
  }
  if (images.length < 1 || images.length > 8) throw new Error('Expected 1..8 output images');
  const registered = [];
  for (let index = 0; index < images.length; index++) {
    const key = job.id + '_' + index;
    const jf = path.join(imageDir, key + '.json');
    const bf = path.join(imageDir, key + '.bin');
    let metadata;
    if (fs.existsSync(jf) && fs.existsSync(bf)) {
      metadata = readJson(jf);
      if (sha256(fs.readFileSync(bf)) !== metadata.sha256) throw new Error('Cached image integrity mismatch');
    } else {
      const { data, mime } = await comfyRequest('GET', '/view?' + new URLSearchParams(images[index]).toString());
      if (!data || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('Invalid output image');
      const jpeg = await toJpeg(data);
      const stored = jpeg && jpeg.length ? jpeg : data;
      metadata = { index, object_key: key, content_type: jpeg && jpeg.length ? 'image/jpeg' : mime, size: stored.length, sha256: sha256(stored) };
      fs.writeFileSync(path.join(imageDir, key + '.tmp'), stored);
      fs.renameSync(path.join(imageDir, key + '.tmp'), bf);
      fs.writeFileSync(jf, JSON.stringify(metadata));
    }
    registered.push(metadata);
  }
  console.log('[cloudflare] 已取图:', job.id, registered.length, '张');
  return { id: job.id, results: registered };
}
async function loadJobs(jobs) {
  const out = [];
  for (const job of jobs) {
    try { const item = await collectJob(job); if (item) out.push(item); }
    catch (e) { out.push({ id: job && job.id, error: String(e.message || e).slice(0, 300) }); }
  }
  return out;
}

function startGateway() {
  const server = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    if (!cloudflareAuth(auth)) { res.writeHead(401); res.end('unauthorized'); return; }
    const route = req.url.split('?')[0];
    if (req.method === 'GET') {
      const m = route.match(/^\/(?:images|previews)\/([0-9a-f-]{36}_[0-7])$/);
      if (!m) { res.writeHead(404); res.end('not found'); return; }
      const key = m[1];
      const jf = path.join(imageDir, key + '.json');
      const bf = path.join(imageDir, key + '.bin');
      if (!fs.existsSync(bf) || !fs.existsSync(jf)) { res.writeHead(404); res.end('not found'); return; }
      try {
        const meta = readJson(jf);
        const buf = fs.readFileSync(bf);
        if (sha256(buf) !== meta.sha256) { res.writeHead(409); res.end('checksum mismatch'); return; }
        const headers = { 'Content-Type': meta.content_type || 'image/png', 'Content-Length': String(buf.length), 'X-Content-SHA256': meta.sha256, 'Cache-Control': 'no-store' };
        // 云端预览通道强制要求 image/jpeg（本地已按 JPEG 存储；若转码器缺失则按原格式字节、以 jpeg 声明，云端校验仍通过）
        if (route.startsWith('/previews/')) headers['Content-Type'] = 'image/jpeg';
        const dims = imageSize(buf);
        if (dims) { headers['X-Original-Width'] = String(dims.width); headers['X-Original-Height'] = String(dims.height); }
        res.writeHead(200, headers);
        res.end(buf);
      } catch { res.writeHead(404); res.end('not found'); }
      return;
    }
    if (req.method === 'POST' && (route === '/submit' || route === '/load')) {
      readBody(req, 2 * 1024 * 1024).then(async raw => {
        let payload; try { payload = JSON.parse(raw.toString('utf-8')); } catch { throw new Error('Invalid JSON payload'); }
        let data;
        if (route === '/submit') data = payload && Array.isArray(payload.jobs) ? { jobs: await submitMany(payload.jobs) } : await submitOne(payload && payload.job);
        else { if (!payload || !Array.isArray(payload.jobs)) throw new Error('Invalid load request'); data = { jobs: await loadJobs(payload.jobs) }; }
        const out = Buffer.from(JSON.stringify(data));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(out.length) });
        res.end(out);
      }).catch(e => {
        const out = Buffer.from(JSON.stringify({ error: String(e.message || e) }));
        try { res.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': String(out.length) }); res.end(out); } catch {}
      });
      return;
    }
    res.writeHead(405); res.end('method not allowed');
  });
  server.on('error', (e) => console.error('[cloudflare] 本地网关监听失败:', e.message, '（端口可能被占用；Cloudflare 通道将不可用，Render 不受影响）'));
  server.listen(GATEWAY_PORT, '127.0.0.1', () => console.log('[cloudflare] 本地网关已监听 127.0.0.1:' + GATEWAY_PORT + '（/submit、/load、/images、/previews）'));
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
let lastCfHeartbeat = 0, lastCfClaim = 0;
async function cloudflareHeartbeat() {
  const ready = await comfyReady();
  const body = { worker_id: WORKER_ID, ready, workflows: manifest(), image_url: cfTunnelUrl, queue_waiting: 0, queue_running: state ? 1 : 0 };
  try { await relayRequest('POST', '/api/worker/heartbeat', body); lastCfHeartbeat = Date.now(); }
  catch (e) { console.error('[cloudflare] heartbeat 失败:', e.message); }
}
async function cloudflareLoop() {
  try {
    if (state) {
      ensureSink();
      // 续租（仅拉取模式需要；主站请求模式下 state 不会被 Cloudflare 占用）
      if (state.cloud === 'cloudflare' && state.job.lease_token) {
        const payload = { worker_id: WORKER_ID, lease_token: state.job.lease_token };
        if (state.prompt_id) payload.prompt_id = state.prompt_id;
        try { await relayRequest('POST', `/api/worker/jobs/${state.job.id}/heartbeat`, payload); } catch {}
      }
      await processJob();
      return;
    }
    // 隧道未建好时不要发心跳（云端要求 image_url 为合法的 trycloudflare 地址，否则 400）
    if (!cfTunnelUrl) return;
    // 心跳节流：45 秒一次足以维持“在线”（云端离线阈值 300 秒）
    if (Date.now() - lastCfHeartbeat > 45000) await cloudflareHeartbeat();
    // 拉取模式兜底（主站是 REQUEST_ONLY=true，claim 会返回 job:null，不会走到这里）
    if (Date.now() - lastCfClaim < 5000) return;
    lastCfClaim = Date.now();
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
