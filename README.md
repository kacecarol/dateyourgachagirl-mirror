# dateyourgachagirl · Render 海外镜像

这是 `dateyourgachagirl`（图片/视频版）的**海外镜像备份**，部署在 Render 上，**完全不依赖 Cloudflare**。

原版（Cloudflare Pages + Functions + D1 + 隧道）在国内能访问，但如果你想在海外/被墙环境下也有一份一模一样的服务，就用这个镜像。

## 架构（一句话）

- **大脑（云端）**：`server.js`，一个 Node + SQLite 的网站服务，负责登录、排队、积分、取图调度。部署在 Render。
- **本机出图程序（你电脑上）**：`worker/worker.js`，主动连到云端，把画图请求发给本机 ComfyUI，再把图回传。
- **前端页面**：`public/`，和原版界面一模一样（已原样复制，无需改动）。

图片**永远不经过云端存储**，只在你本机生成、云端按需"转发"给正在看你页面的人，所以云端不占流量、不存你的图。

## 1. 云端部署（Render，一次性）

已通过 Render API 自动建好 Web Service。要点：
- Build Command：`npm install`
- Start Command：`npm start`
- 环境变量（在 Render 控制台 → 该服务 → Environment 设置）：
  - `WORKER_TOKEN`：本机程序连入云端的密钥（和下面本机设置一致）
  - `USER_TOKEN`：可选，给"管理员直连"用的密钥
  - `REQUEST_ONLY`：`true`（云端只转发请求，不自己出图）
  - `CREDITS_ENABLED`：`true`（开启积分）
  - `PORT`：Render 会自动注入，无需手填

> 免费版 Web Service 在 15 分钟没人用后会"休眠"，下次访问要等十几秒唤醒。付费 $7/月可常驻。

## 2. 本机运行出图程序（每次想出图时）

前提：你电脑上已经跑着 **ComfyUI**（默认 `http://127.0.0.1:8189`）。

在本项目目录打开终端，先装一次依赖（只需一次）：
```bash
npm install
```
然后启动本机程序：
```bash
WORKER_TOKEN=你的密钥 node worker/worker.js
```
或写进环境变量后直接 `npm run worker`。

程序会显示"已连出到云端"。只要它开着，你（和别人）在镜像网站上点的图就会在你本机 ComfyUI 上生成并回传。

## 3. 使用

打开 Render 给你的网址（形如 `https://dateyourgachagirl-mirror.onrender.com`），用账号 `asus` / 密码 `asus1234` 登录（**上线后请尽快改密码**），用法和原版完全一样。

## 目录说明
- `server.js`：云端大脑
- `worker/worker.js`：本机出图程序
- `worker/workflows/`：ComfyUI 工作流模板（与原版一致）
- `public/`：前端页面
