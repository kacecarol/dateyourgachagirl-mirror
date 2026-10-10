// 集成测试：用真实 worker.js + 模拟 ComfyUI，验证真实 worker 能否连云端、接任务、出图、回传
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:4100';
const COMFY_PORT = 8190;
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');

// 1) 模拟 ComfyUI
const comfy = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/system_stats') { res.setHeader('Content-Type','application/json'); return res.end('{}'); }
  if (req.method === 'POST' && url.pathname === '/prompt') {
    let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ prompt_id: 'mock-prompt-1' })); });
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/history/')) { res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({ 'mock-prompt-1': { status: { status_str: 'success', completed: true }, outputs: { '18': { images: [ { filename: 'out.png', subfolder: '', type: 'output' } ] } } } })); }
  if (req.method === 'GET' && url.pathname === '/view') { res.setHeader('Content-Type','image/png'); return res.end(PNG); }
  res.statusCode = 404; res.end('nf');
});
comfy.listen(COMFY_PORT, () => console.log('[mock comfy] on', COMFY_PORT));

// 2) 启动真实 worker.js
import fs from 'node:fs';
const workerLog = fs.createWriteStream('/tmp/worker.log');
const worker = spawn('C:/Users/asus/.workbuddy/binaries/node/versions/22.22.2-6/node.exe', ['worker/worker.js'], {
  env: { ...process.env, CLOUD_WS: 'ws://127.0.0.1:4100/ws', WORKER_TOKEN: 'testworkertoken', COMFY_URL: 'http://127.0.0.1:' + COMFY_PORT, WORKER_ID: 'local-studio-1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
worker.stdout.pipe(workerLog); worker.stderr.pipe(workerLog);

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, json: j };
}
const uuid = () => crypto.randomUUID();

setTimeout(async () => {
  try {
    let r = await req('POST', '/api/auth/login', { username: 'asus', password: 'asus1234' });
    const token = r.json.token;
    console.log('LOGIN', r.status, !!token);
    await new Promise(s=>setTimeout(s,1500)); // 等 worker 完成首次心跳并上报 ready
    r = await req('GET', '/api/workflows', null, token);
    console.log('WORKFLOWS online=', r.json.worker_online, 'count=', r.json.workflows.length);
    const request_id = uuid();
    r = await req('POST', '/api/jobs', { request_id, workflow_id: 'dateher', parameters: { positive: 'a girl', negative: '', width: 768, height: 1024, steps: 20, cfg: 7, seed: 1 } }, token);
    console.log('SUBMIT', r.status, 'balance=', r.json.balance);
    const jobId = r.json.job?.id;
    let status='queued';
    for (let i=0;i<80;i++){ await new Promise(s=>setTimeout(s,500)); const jr=await req('GET','/api/jobs/'+jobId,null,token); status=jr.json.job?.status; if(status==='succeeded'||status==='failed')break; }
    console.log('JOB STATUS ->', status);
    if (status==='succeeded') {
      const fr = await req('GET', `/api/jobs/${jobId}/results/0`, null, token);
      console.log('FETCH preview HTTP', fr.status, '(200=真图已回传)');
    }
    r = await req('GET','/api/auth/me',null,token);
    console.log('BALANCE after gen =', r.json.balance);
  } catch (e) { console.log('ERR', e.message); }
  console.log('--- worker.log ---'); 
  try { console.log(fs.readFileSync('/tmp/worker.log','utf-8').slice(0,1500)); } catch {}
  worker.kill(); comfy.close(); process.exit(0);
}, 1200);
