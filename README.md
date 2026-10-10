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

配置密钥：本项目根目录的 `worker.env`（不入版本库）已预填好两个口令：
- `RENDER_TOKEN`：连 Render 镜像用。
- `RELAY_TOKEN`：连 Cloudflare 原站用（取自本机加密凭据 `WORKER_access.xml`）。

> 换电脑时，把 `worker.env` 一起拷过去，或参照 `worker.env.example` 自行填写。

启动：**双击 `start_worker.bat`**。窗口里出现“已连出到云端”即成功；保持窗口开着，关闭即停止。

> ⚠️ 若你原来那个出图程序（`worker.py` / `start_local_relay.cmd`）还开着，请**先关掉它**再运行本程序——两者会争抢同一个取图端口（8790）。脚本检测到冲突时会给出提示。

## 3. 使用

打开 `https://dateyourgachagirl-mirror.onrender.com`，**用户名和口令与主站相同**（用户名 `asus`；口令见 `../local-runtime/test_accounts.txt`）。用法与原版一致。

> 口令由云端环境变量 `ADMIN_PASSWORD` 提供（本仓库公开，代码里不写口令）。改口令：在 Render 后台改 `ADMIN_PASSWORD` 的值即可，下次部署生效。

## 目录说明
- `server.js`：云端大脑
- `worker/worker.js`：统一出图程序（Render + Cloudflare）
- `worker/workflows/`：ComfyUI 工作流模板
- `public/`：前端页面
- `worker.env`：本机密钥（不入库）
- `start_worker.bat`：Windows 一键启动
