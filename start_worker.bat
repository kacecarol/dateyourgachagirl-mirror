@echo off
chcp 65001 >nul
cd /d %~dp0

echo ============================================
echo  统一出图程序（同时服务 Render 镜像 + Cloudflare 原站）
echo ============================================
echo  要求：本机已运行 ComfyUI（默认 127.0.0.1:8189）
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 node。请先安装 Node.js（https://nodejs.org，选 LTS 版，需 22 或更高）。
  pause
  exit /b 1
)

if not exist worker.env (
  echo [提示] 未找到 worker.env。正在从示例复制一份，请打开它填入你的密钥后再运行。
  copy /y worker.env.example worker.env >nul
  echo.
  echo 已生成 worker.env —— 用记事本打开它，填入 RENDER_TOKEN，保存后重新双击本文件。
  pause
  exit /b 1
)

REM 旧版出图程序（worker.py）会占用 8790，与本程序冲突，先提醒用户关闭
netstat -ano | findstr ":8790" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo [提示] 检测到旧的出图程序仍在运行（占用了 8790）。
  echo        请先关闭那个旧的命令行窗口（或在其中按 Ctrl+C），
  echo        否则 Cloudflare 原站的取图通道会与它冲突。
  echo.
  echo        如果你确定只用 Render 镜像、不需要原站，也可以直接继续。
  echo.
  pause
)

echo [启动] 正在连出到云端，并把画图请求交给本机 ComfyUI...
echo 保持此窗口开着；关闭它 = 停止出图。
echo.
node worker/worker.js
pause
