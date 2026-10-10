@echo off
chcp 65001 >nul
cd /d %~dp0

REM ===== 配置（一般无需改动）=====
set WORKER_TOKEN=1185196011f42e241c94b59b65faeb3562e617c0661293c4
set CLOUD_WS=wss://dateyourgachagirl-mirror.onrender.com/ws
set COMFY_URL=http://127.0.0.1:8189

echo ============================================
echo  dateyourgachagirl 镜像 —— 本机出图程序
echo ============================================
echo 要求：本机已运行 ComfyUI（默认 %COMFY_URL%）
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 node。请先安装 Node.js（https://nodejs.org，选 LTS 版）。
  pause
  exit /b 1
)

if not exist node_modules (
  echo [首次运行] 正在安装依赖（只需一次，可能要几分钟）...
  call npm install
  if errorlevel 1 ( echo [错误] 依赖安装失败。 pause & exit /b 1 )
)

echo [启动] 正在连出到云端镜像，并把画图请求交给本机 ComfyUI...
echo 保持此窗口开着；关闭它 = 停止出图。
echo.
node worker/worker.js
pause
