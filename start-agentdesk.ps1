$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "未找到 Node.js，请先安装 Node.js 20 或更高版本。"
}

if (-not (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)) {
    throw "未找到 pnpm，请先运行：npm install -g pnpm"
}

if (-not (Test-Path "node_modules")) {
    pnpm.cmd install
}

if (-not (Test-Path "apps\web\dist\index.html") -or -not (Test-Path "apps\server\dist\index.js")) {
    pnpm.cmd build
}

Write-Host ""
Write-Host "AgentDesk 已启动：" -ForegroundColor Green
Write-Host "http://127.0.0.1:4310" -ForegroundColor Cyan
Write-Host "按 Ctrl+C 停止。"
Write-Host ""

node apps/server/dist/index.js
