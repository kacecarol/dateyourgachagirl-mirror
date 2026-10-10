// 本地验证：REQUEST_ONLY 模式下 /api/jobs/batch 是否可用，且串行派发器能否把队列逐条跑完。
// 用法：node _batchtest.mjs   （需在 render-mirror 目录，node_modules 里有 ws）
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import WebSocket from 'ws';

const PORT = 4199;
const TOKEN = 'test-worker-token-0123456789abcdef';
const PASS = 'testpass123';
const DB = './_bt.sqlite3';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

for (const f of [DB, DB + '-shm', DB + '-wal']) { try { fs.unlinkSync(f); } catch {} }

const srv = spawn(process.execPath, ['--experimental-sqlite', 'server.js'], {
  env: { ...process.env, PORT: String(PORT), DATEHER_DB: DB, ADMIN_PASSWORD: PASS, WORKER_TOKEN: TOKEN, CREDITS_ENABLED: 'true', REQUEST_ONLY: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));
srv.stderr.on('data', d => process.stdout.write('[srv-err] ' + d));

await sleep(500);
const base = `http://127.0.0.1:${PORT}`;
// 等 server 就绪
let up = false;
for (let i = 0; i < 60; i++) { try { const rr = await fetch(base + '/'); if (rr.ok) { up = true; break; } } catch {} await sleep(250); }
console.log('server up:', up);
if (!up) { console.log('RESULT: FAIL (server not up)'); srv.kill(); process.exit(1); }

let r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'asus', password: PASS }) });
const login = await r.json();
console.log('login:', r.status, login.ok);
const TK = login.token;

// ---- mock worker ----
let submitCount = 0;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise(res => ws.on('open', res));
ws.send(JSON.stringify({
  type: 'hello', worker_id: 'local-studio-1', ready: true, queue_waiting: 0, queue_running: 0,
  workflows: [{ id: 'dateher_full', name: 'Drawing', parameters: ['positive', 'negative', 'width', 'height', 'steps', 'cfg', 'seed', 'character', 'art_style', 'shot', 'personality_tags', 'session_id', 'page_index', 'session_config'] }],
}));
ws.on('message', raw => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'hello_ack') { console.log('worker: hello_ack'); return; }
  if (msg.type === 'submit') {
    const job = msg.job;
    if (submitCount > 0 && false) {} // noop
    submitCount++;
    console.log('worker: submit #' + submitCount, 'page=' + job.parameters.page_index, job.id.slice(0, 8));
    ws.send(JSON.stringify({ msg_id: msg.msg_id, type: 'submit_ack', job_id: job.id, prompt_id: 'pid-' + job.id.slice(0, 8) }));
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'results', job_id: job.id, results: [{ index: 0, content_type: 'image/jpeg', size: 999, sha256: 'a'.repeat(64), object_key: job.id + '_0' }] }));
      setTimeout(() => ws.send(JSON.stringify({ type: 'complete', job_id: job.id })), 150);
    }, 700);
  }
});
await sleep(300);

// ---- batch 提交 3 条 ----
const SID = crypto.randomUUID();
const reqs = [1, 2, 3].map(i => ({
  request_id: crypto.randomUUID(), workflow_id: 'dateher_full',
  parameters: { positive: '1girl test ' + i, negative: '', width: 832, height: 1216, steps: 20, cfg: 7, seed: 1000 + i, character: 'Aglaea', art_style: 'anime_special', shot: 'full body', personality_tags: '', page_index: i, session_id: SID, session_config: {} },
}));

// ---- 前端的完整提交流程：① 建会话 → ② 积分预检 → ③ 批量提交 ----
r = await fetch(base + '/api/session', { headers: { Authorization: 'Bearer ' + TK } });
const active = await r.json();
console.log('active session before:', JSON.stringify(active.session_id));

r = await fetch(base + '/api/session', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TK },
  body: JSON.stringify({ session_id: SID, config: {}, replace: !!active.session_id, request_id: crypto.randomUUID() }),
});
const sess = await r.json();
console.log('session POST:', r.status, 'session_id=' + JSON.stringify(sess.session_id));
// 前端在 drawing.js:1307 的判据：服务端返回的 session_id 必须等于本次请求的 session
const sessionOk = r.status === 200 && sess.session_id === SID;
if (!sessionOk) console.log('!! 前端会在此处抛 "Batch was replaced elsewhere. Reload before submitting."');

r = await fetch(base + '/api/credits/quote', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TK }, body: JSON.stringify({ request_ids: reqs.map(q => q.request_id) }) });
const quote = await r.json();
console.log('quote:', r.status, JSON.stringify(quote));
const quoteOk = r.status === 200;

r = await fetch(base + '/api/jobs/batch', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TK }, body: JSON.stringify({ requests: reqs }) });
const batch = await r.json();
console.log('batch:', r.status, 'jobs:', batch.jobs ? batch.jobs.length : batch.error, batch.jobs ? batch.jobs.map(j => j.status).join(',') : '');

await sleep(6000);

r = await fetch(base + '/api/jobs', { headers: { Authorization: 'Bearer ' + TK } });
const jobs = (await r.json()).jobs;
console.log('final:', jobs.map(j => 'p' + j.parameters.page_index + ':' + j.status).join(' | '));
console.log('worker received submits:', submitCount);

const pass = sessionOk && quoteOk && r.status === 200 && submitCount === 3 && jobs.length === 3 && jobs.every(j => j.status === 'succeeded');
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');

ws.close();
srv.kill();
setTimeout(() => process.exit(pass ? 0 : 1), 300);
