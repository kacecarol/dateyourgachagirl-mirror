# dateyourgachagirl · Render 海外镜像

这是 `dateyourgachagirl` 的**海外镜像备份**，部署在 Render 上，**完全不依赖 Cloudflare**。
原版在 Cloudflare Pages 上照常运行；本镜像用于在被墙 / Cloudflare 不可用时仍能访问。

## 架构（一句话）

- **大脑（云端）**：`server.js`，Node + SQLite 的网站服务，负责登录、排队、积分、取图调度。部署在 Render。
- **统一出图程序（你电脑上）**：`worker/worker.js`，**一个进程同时连接两个云端**，共用本机同一个 ComfyUI：
  - Render 镜像：反向 WebSocket（云端主动下发任务）—— 默认开启
  - Cloudflare 原站：本地网关 + cloudflared 隧道（云端顺着隧道来取图）—— 配置了 `RELAY_TOKEN` 才开启
- **前端页面**：`public/`，与原版界面一致（原样复制，无需改动）。

图片**永远不经过云端存储**，只在本机生成、云端按需转发给正在看页面的人。

## 1. 云端（Render）

已通过 API 建好 Web Service：
- Build Command：`npm install`
- Start Command：`node --experimental-sqlite server.js`
- 环境变量：`WORKER_TOKEN`、`REQUEST_ONLY=true`、`CREDITS_ENABLED=true`（`PORT` 由 Render 自动注入）

> 免费版 Web Service 15 分钟无人访问会休眠，下次访问需十几秒唤醒。

## 2. 本机出图程序（每次想出图时）

前提：本机已运行 **ComfyUI**（默认 `http://127.0.0.1:8189`）。

**零依赖**：使用 Node 22+ 内置的 WebSocket，**不需要 `npm install`**。

配置密钥（只需一次）：编辑项目根目录的 `worker.env`（不入版本库），至少填入：
```
RENDER_TOKEN=你的Render服务WORKER_TOKEN
```
想让 Cloudflare 原站也能出图，再填 `RELAY_TOKEN`（与 Cloudflare 项目里的 `RELAY_WORKER_TOKEN` 一致）。
模板见 `worker.env.example`。

启动：**双击 `start_worker.bat`**。窗口里出现“已连出到云端”即成功；保持窗口开着，关闭即停止。

## 3. 使用

打开 `https://dateyourgachagirl-mirror.onrender.com`，账号 `asus` / 密码 `asus1234`（**上线后请尽快改密码**），用法与原版一致。

## 目录说明
- `server.js`：云端大脑
- `worker/worker.js`：统一出图程序（Render + Cloudflare）
- `worker/workflows/`：ComfyUI 工作流模板
- `public/`：前端页面
- `worker.env`：本机密钥（不入库）
- `start_worker.bat`：Windows 一键启动
