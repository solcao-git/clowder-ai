# Clowder AI 一键恢复脚本
# 用法：把 clowder-ai-migrate.zip 解压到 clowder-ai/ 根目录同级，
#       然后在 clowder-ai/ 根目录下运行此脚本：
#       powershell -File scripts/restore-migrate.ps1

$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot | Split-Path -Parent
$migrateDir = Join-Path $projectRoot "clowder-ai-migrate"

if (-not (Test-Path $migrateDir)) {
    Write-Host "❌ 找不到迁移目录: $migrateDir" -ForegroundColor Red
    Write-Host "   请把 clowder-ai-migrate.zip 解压到项目根目录下，得到 clowder-ai-migrate/ 文件夹" -ForegroundColor Yellow
    exit 1
}

Write-Host "=== Clowder AI 一键恢复 ===" -ForegroundColor Cyan
Write-Host "项目根目录: $projectRoot" -ForegroundColor Gray
Write-Host "迁移目录:   $migrateDir" -ForegroundColor Gray
Write-Host ""

# 1. .env
$src = Join-Path $migrateDir ".env"
$dst = Join-Path $projectRoot ".env"
if (Test-Path $src) {
    Copy-Item $src $dst -Force
    Write-Host "✅ .env → 项目根目录" -ForegroundColor Green
} else {
    Write-Host "⚠️  跳过 .env (文件不存在)" -ForegroundColor Yellow
}

# 2. .cat-cafe/ 目录下的文件
$catCafeDir = Join-Path $projectRoot ".cat-cafe"
if (-not (Test-Path $catCafeDir)) {
    New-Item -ItemType Directory -Path $catCafeDir -Force | Out-Null
    Write-Host "📁 创建 .cat-cafe/ 目录" -ForegroundColor Gray
}

$catCafeFiles = @(
    "accounts.json",
    "credentials.json",
    "cat-catalog.json",
    "governance-registry.json",
    "capabilities.json",
    "services.json",
    "mcp-resolved.json"
)

foreach ($file in $catCafeFiles) {
    $src = Join-Path $migrateDir $file
    $dst = Join-Path $catCafeDir $file
    if (Test-Path $src) {
        Copy-Item $src $dst -Force
        Write-Host "✅ $file → .cat-cafe/" -ForegroundColor Green
    } else {
        Write-Host "⚠️  跳过 $file (文件不存在)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "=== 恢复完成 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步:" -ForegroundColor White
Write-Host "  1. pnpm install"
Write-Host "  2. pnpm -C packages/shared build"
Write-Host "  3. pnpm -C packages/api build"
Write-Host "  4. 安装 Redis (端口 6399) 或修改 .env 里的 REDIS_PORT"
Write-Host "  5. 启动 API + 前端"
