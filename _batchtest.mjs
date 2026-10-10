// 本地回归：验证镜像站与「原站中转契约」（cloudflare/docs/project_manual.md §3）一致。
// 契约要点：
//   ① POST /api/session 返回的 session_id 必须等于本次申请的（前端 drawing.js:1307 判据）
//   ② POST /api/credits/quote 预检
//   ③ POST /api/jobs/batch → 云端**一次**把整批发给本机（msg.jobs 长度＝批大小），不等出图
//   ④ 本机回 prompt_id → 云端把**全部**任务置为 running（不是只转第一条）
//   ⑤ GET /api/session?load=1 → 云端调本机 /load → 本机从 ComfyUI /history 取图并回元数据 → succeeded
// 用法：node _batchtest.mjs （需在 render-mirror 目录，node_modules 里有 ws）
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import WebSocket from 'ws';

const PORT = 4199;
const TOKEN = 'test-worker-token-0123456789abcdef';
const PASS = 'testpass123';
const DB = './_bt.sqlite3';
const N = 5;                                  // 批大小：必须 >1，才能验证「整批一次发出」
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

for (const f of [DB, DB + '-shm', DB + '-wal']) { try { fs.unlinkSync(f); } catch {} }

const srv = spawn(process.execPath, ['--experimental-sqlite', 'server.js'], {
  env: { ...process.env, PORT: String(PORT), DATEHER_DB: DB, ADMIN_PASSWORD: PASS, WORKER_TOKEN: TOKEN, CREDITS_ENABLED: 'true', REQUEST_ONLY: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));
srv.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));

await sleep(500);
const base = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 60; i++) { try { const rr = await fetch(base + '/'); if (rr.ok) { up = true; break; } } catch {} await sleep(250); }
console.log('server up:', up);
if (!up) { console.log('RESULT: FAIL (server not up)'); srv.kill(); process.exit(1); }

let r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'asus', password: PASS }) });
const login = await r.json();
const TK = login.token;
console.log('login:', r.status, login.ok);

// ---- mock 本机程序：严格按契约回答（一次收整批、立刻回全部 prompt_id；load 时才「出图」） ----
const submitBatches = [];        // 每次 submit 收到的 job 数量
const loadCalls = [];            // 每次 load 收到的 job 数量
const promptOf = new Map();      // job_id -> prompt_id
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise(res => ws.on('open', res));
ws.send(JSON.stringify({
  type: 'hello', worker_id: 'local-studio-1', ready: true, queue_waiting: 0, queue_running: 0,
  workflows: [{ id: 'dateher_full', name: 'Drawing', parameters: ['positive', 'negative', 'width', 'height', 'steps', 'cfg', 'seed', 'character', 'art_style', 'shot', 'personality_tags', 'session_id', 'page_index', 'session_config'] }],
}));
ws.on('message', raw => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'hello_ack') return;
  if (msg.type === 'submit') {
    const list = Array.isArray(msg.jobs) ? msg.jobs : (msg.job ? [msg.job] : []);
    submitBatches.push(list.length);
    // 契约④：不等出图，整批立刻回 prompt_id
    const results = list.map(j => { const pid = 'pid-' + j.id.slice(0, 8); promptOf.set(j.id, pid); return { id: j.id, prompt_id: pid }; });
    ws.send(JSON.stringify({ msg_id: msg.msg_id, type: 'submit_ack', results }));
    return;
  }
  if (msg.type === 'load') {
    const list = msg.jobs || [];
    loadCalls.push(list.length);
    // 契约⑤：本机读 ComfyUI /history，这里模拟「全部已画完」
    const jobs = list.map(j => ({ id: j.id, results: [{ index: 0, object_key: j.id + '_0', content_type: 'image/jpeg', size: 1000, sha256: 'a'.repeat(64) }] }));
    ws.send(JSON.stringify({ msg_id: msg.msg_id, type: 'load_result', jobs }));
    return;
  }
});
await sleep(300);

// ---- 前端完整提交流程：① 建会话 ② 积分预检 ③ 批量提交 ----
const SID = crypto.randomUUID();
const reqs = Array.from({ length: N }, (_, k) => {
  const i = k + 1;
  return {
    request_id: crypto.randomUUID(), workflow_id: 'dateher_full',
    parameters: { positive: '1girl test ' + i, negative: '', width: 832, height: 1216, steps: 20, cfg: 7, seed: 1000 + i, character: 'Aglaea', art_style: 'anime_special', shot: 'full body', personality_tags: '', page_index: i, session_id: SID, session_config: {} },
  };
});

r = await fetch(base + '/api/session', { headers: { Authorization: 'Bearer ' + TK } });
const active = await r.json();
r = await fetch(base + '/api/session', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TK },
  body: JSON.stringify({ session_id: SID, config: {}, replace: !!active.session_id, request_id: crypto.randomUUID() }),
});
const sess = await r.json();
const sessionOk = r.status === 200 && sess.session_id === SID;
console.log('① session:', r.status, 'session_id=' + JSON.stringify(sess.session_id), sessionOk ? 'OK' : '!! 前端会抛 Batch was replaced elsewhere');

r = await fetch(base + '/api/credits/quote', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TK }, body: JSON.stringify({ request_ids: reqs.map(q => q.request_id) }) });
console.log('② quote:', r.status, JSON.stringify(await r.json()));
const quoteOk = r.status === 200;

r = await fetch(base + '/api/jobs/batch', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TK }, body: JSON.stringify({ requests: reqs }) });
const batch = await r.json();
console.log('③ batch:', r.status, 'jobs=' + (batch.jobs ? batch.jobs.length : batch.error));

await sleep(1200);
r = await fetch(base + '/api/jobs', { headers: { Authorization: 'Bearer ' + TK } });
let jobs = (await r.json()).jobs.sort((a, b) => a.parameters.page_index - b.parameters.page_index);
const statusesAfterSubmit = jobs.map(j => 'p' + j.parameters.page_index + ':' + j.status).join(' ');
console.log('④ 提交后状态:', statusesAfterSubmit);
// 契约③：云端只应发一次 submit，且这条消息里带了整批 N 条
const oneBatchMsg = submitBatches.length === 1 && submitBatches[0] === N;
// 契约④：全部立即 running（不等出图）
const allRunning = jobs.length === N && jobs.every(j => j.status === 'running');

// 契约⑤：手动载入 → 全部 succeeded
r = await fetch(base + '/api/session?load=1', { headers: { Authorization: 'Bearer ' + TK } });
const loaded = await r.json();
await sleep(300);
jobs = (loaded.jobs || []).sort((a, b) => a.parameters.page_index - b.parameters.page_index);
const statusesAfterLoad = jobs.map(j => 'p' + j.parameters.page_index + ':' + j.status).join(' ');
console.log('⑤ 载入后状态:', statusesAfterLoad);
const allSucceeded = jobs.length === N && jobs.every(j => j.status === 'succeeded');

console.log('--- 判定 ---');
console.log('  一次整批发送(1×' + N + '):', oneBatchMsg, JSON.stringify(submitBatches));
console.log('  全部立即 running     :', allRunning);
console.log('  load 分组一次调用     :', loadCalls.length === 1 && loadCalls[0] === N, JSON.stringify(loadCalls));
console.log('  全部 succeeded        :', allSucceeded);

const pass = sessionOk && quoteOk && r.status === 200 && oneBatchMsg && allRunning && allSucceeded;
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');

ws.close();
srv.kill();
setTimeout(() => process.exit(pass ? 0 : 1), 300);
