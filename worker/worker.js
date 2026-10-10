// dateyourgachagirl 镜像 —— 本机 Worker（主动连出到 Render，不再依赖任何第三方隧道）
// 移植自原 local_worker/worker.py + dateher_adapter.py。
// 运行环境：Node 20+，需要 ws 与基础依赖（npm install 后运行）。
// 启动：node worker.js  （在本机、ComfyUI :8189 运行时）

import WebSocket from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = __dirname;

// ---------- 配置 ----------
const CLOUD_WS = (process.env.CLOUD_WS || 'wss://dateyourgachagirl-mirror.onrender.com/ws').replace(/\/$/, '');
const WORKER_TOKEN = process.env.WORKER_TOKEN || 'change-me-worker-token-please-32+chars';
const COMFY_URL = (process.env.COMFY_URL || 'http://127.0.0.1:8189').replace(/\/$/, '');
const WORKER_ID = process.env.WORKER_ID || 'local-studio-1';
const HTTP_TIMEOUT = 30000;
const POLL = 2000;
const JOB_TIMEOUT = 1800 * 1000;

// 工作流配置（镜像版；模板复用原文件）
const WORKFLOWS = JSON.parse(fs.readFileSync(path.join(BASE, 'workflows', 'mirror_workflows.json'), 'utf-8'));

const PARAM_NAMES = ['positive', 'negative', 'width', 'height', 'steps', 'cfg', 'seed'];
const DATEHER_NAMES = [...PARAM_NAMES, 'character', 'art_style', 'shot', 'personality_tags', 'session_id', 'page_index', 'session_config'];

// ---------- 工具 ----------
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function isUuid(v) { return typeof v === 'string' && /^[0-9a-f]{8}-[9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v); }
function isName(v) { return typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v); }

// dateher_adapter.build_prompt 移植（仅 dateher_full 用到）
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
  const characters = JSON.parse(fs.readFileSync(path.join(dir, 'dateher_char_catalog.json'), 'utf-8-sig'));
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'dateher_prompt_config.json'), 'utf-8-sig'));
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

// ---------- ComfyUI HTTP ----------
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

// ---------- 作业处理 ----------
const journalPath = path.join(BASE, 'worker_journal.json');
let state = null; // { job, phase, prompt_id, deadline, images }
function saveState() { fs.writeFileSync(journalPath + '.tmp', JSON.stringify(state)); fs.renameSync(journalPath + '.tmp', journalPath); }
function clearState() { state = null; try { fs.unlinkSync(journalPath); } catch {} }

function preparePrompt(job) {
  const wf = WORKFLOWS.find(w => w.id === job.workflow_id);
  if (!wf) throw new Error('Unknown workflow');
  const original = JSON.parse(fs.readFileSync(path.join(BASE, wf.template), 'utf-8-sig'));
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

async function processJob(ws, msgId) {
  const job = state.job;
  if (state.phase === 'claimed' && !state.prompt_id) {
    const graph = preparePrompt(job);
    const reply = await comfyRequest('POST', '/prompt', { prompt: graph, client_id: WORKER_ID });
    if (!reply || typeof reply.prompt_id !== 'string' || !reply.prompt_id || reply.node_errors) throw new Error('Comfy did not acknowledge prompt');
    state.prompt_id = reply.prompt_id; state.phase = 'running'; state.deadline = Date.now() + JOB_TIMEOUT; saveState();
    // 通知云端已提交（回显 msg_id 让云端把任务置为 running）
    send(ws, { msg_id: msgId, type: 'submit_ack', job_id: job.id, prompt_id: reply.prompt_id });
  }
  if (state.phase === 'running') {
    const history = await comfyRequest('GET', '/history/' + encodeURIComponent(state.prompt_id));
    const entry = history[state.prompt_id];
    if (!entry) return false;
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
      if (!data || ![ 'image/png', 'image/jpeg', 'image/webp' ].includes(mime)) throw new Error('Invalid output image');
      const digest = sha256(data);
      // 存原图
      const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[mime];
      const origDir = path.join(BASE, 'state', 'originals'); fs.mkdirSync(origDir, { recursive: true });
      const origPath = path.join(origDir, job.id + '_' + index + ext);
      if (!fs.existsSync(origPath)) fs.writeFileSync(origPath, data);
      const key = job.id + '_' + index;
      const metadata = { object_key: key, content_type: mime, size: data.length, sha256: digest };
      // 通过 WS 回传图片结果元数据
      send(ws, { type: 'results', job_id: job.id, results: [metadata] });
      results.push(metadata);
    }
    state.phase = 'completing'; saveState();
    return { results };
  }
  if (state.phase === 'completing') {
    send(ws, { type: 'complete', job_id: job.id });
    clearState();
    console.log('任务已完成:', state?.job?.id);
    return true;
  }
  return false;
}

// ---------- WebSocket 通道 ----------
let ws = null, reconnectTimer = null, lastHeartbeat = 0;
function send(wsObj, msg) { if (wsObj && wsObj.readyState === 1) wsObj.send(JSON.stringify(msg)); }
function manifest() {
  return WORKFLOWS.map(w => ({ id: w.id, name: w.name, parameters: w.adapter === 'dateher' ? DATEHER_NAMES : PARAM_NAMES }));
}
function connect() {
  ws = new WebSocket(CLOUD_WS + '?token=' + encodeURIComponent(WORKER_TOKEN), { headers: { 'User-Agent': 'DateHerRelayWorker/1.0' } });
  ws.on('open', () => {
    console.log('[ws] 已连出到云端');
    heartbeat();
  });
  ws.on('message', (data) => handleMessage(data.toString()));
  ws.on('close', () => { console.log('[ws] 断开，3 秒后重连'); scheduleReconnect(); });
  ws.on('error', (e) => { console.log('[ws] 错误', e.message); });
}
function scheduleReconnect() { if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000); }

async function heartbeat() {
  let ready = false;
  try { const stats = await comfyRequest('GET', '/system_stats'); ready = !!stats && typeof stats === 'object'; } catch {}
  send(ws, { type: 'hello', worker_id: WORKER_ID, ready, workflows: manifest(), queue_waiting: 0, queue_running: state ? 1 : 0 });
  lastHeartbeat = Date.now();
}

async function handleMessage(str) {
  let msg; try { msg = JSON.parse(str); } catch { return; }
  if (msg.msg_id && msg.type === 'submit') {
    // 云端下发的提交任务
    try {
      const job = msg.job;
      const msgId = msg.msg_id;
      if (state) { send(ws, { msg_id: msgId, type: 'submit_ack', job_id: job.id, error: 'worker busy' }); return; }
      state = { job, phase: job.prompt_id ? 'running' : 'claimed', prompt_id: job.prompt_id || null, deadline: Date.now() + JOB_TIMEOUT };
      saveState();
      try { await processJob(ws, msgId); } catch (e) { reportFail(ws, e.message); }
    } catch (e) { send(ws, { msg_id: msg.msg_id, type: 'submit_ack', job_id: msg.job?.id, error: e.message }); }
    return;
  }
  if (msg.type === 'load') {
    // 云端请求刷新：把本机已有结果元数据回传
    const jobs = [];
    for (const j of msg.jobs) {
      const imgDir = path.join(BASE, 'state', 'images');
      const results = [];
      for (let i = 0; i < 8; i++) { const f = path.join(imgDir, j.id + '_' + i + '.json'); if (fs.existsSync(f)) { try { results.push(JSON.parse(fs.readFileSync(f, 'utf-8'))); } catch {} } }
      jobs.push({ id: j.id, results });
    }
    send(ws, { type: 'load_result', jobs });
    return;
  }
  if (msg.type === 'fetch_image') {
    // 云端取图：从本机原图目录读取
    const key = msg.object_key;
    const dir = path.join(BASE, 'state', 'originals');
    let buf = null, mime = 'image/png';
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) { const p = path.join(dir, key + ext); if (fs.existsSync(p)) { buf = fs.readFileSync(p); mime = ext === '.jpg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'; break; } }
    if (!buf) { send(ws, { type: 'image_error', msg_id: msg.msg_id, error: 'not found' }); return; }
    send(ws, { type: 'image', msg_id: msg.msg_id, content_type: mime, sha256: sha256(buf), size: buf.length, data: buf.toString('base64') });
    return;
  }
}

async function reportFail(wsObj, error) {
  send(wsObj, { type: 'fail', job_id: state?.job?.id, error: String(error).slice(0, 1000) });
  clearState();
}

async function tick() {
  if (!ws || ws.readyState !== 1) return;
  if (Date.now() - lastHeartbeat > 10000) heartbeat();
  if (state) {
    try { const done = await processJob(ws); if (done === true || (done && done.results)) {} }
    catch (e) { reportFail(ws, e.message); }
    return;
  }
  // 空闲时也保持心跳（云端据此判断在线）
}

// 恢复未完成日志
if (fs.existsSync(journalPath)) { try { state = JSON.parse(fs.readFileSync(journalPath, 'utf-8')); console.log('[worker] 恢复未完成任务', state?.job?.id); } catch {} }

connect();
setInterval(tick, POLL);
setInterval(() => { if (Date.now() - lastHeartbeat > 10000) heartbeat(); }, 10000);
console.log('[worker] 启动，连出至', CLOUD_WS, '，本机 ComfyUI', COMFY_URL);
