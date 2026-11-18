# 把本项目自带的 Node / pnpm / PostgreSQL 放进当前进程的 PATH，并在数据库未运行时启动它。
# 工具目录不进 Git：.tools/node、.tools/pgsql、.tools/pgdata。
# Windows PowerShell 5.1 与 PowerShell 7（Windows、macOS）都可以运行。
# macOS 上把对应平台的 Node 与 PostgreSQL 二进制放进同样的相对目录即可。
# 用法：
#   .\scripts\with-env.ps1
#   .\scripts\with-env.ps1 pnpm dev
#   .\scripts\with-env.ps1 pnpm cli

$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tools = Join-Path $root ".tools"
$nodeHome = Join-Path $tools "node"
$pgsqlBin = Join-Path (Join-Path $tools "pgsql") "bin"
$pgData = Join-Path $tools "pgdata"

foreach ($dir in @($nodeHome, $pgsqlBin, $pgData)) {
  if (-not (Test-Path -LiteralPath $dir)) {
    throw "缺少 $dir。先装好项目内的 Node 与 PostgreSQL，再运行此脚本。"
  }
}

$separator = [System.IO.Path]::PathSeparator
$prefixes = @(
  $nodeHome,
  (Join-Path $nodeHome "bin"),
  $pgsqlBin
) | Where-Object { Test-Path -LiteralPath $_ }
$env:PATH = (@($prefixes) + @($env:PATH)) -join $separator
$env:PGDATA = $pgData
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"

& pg_ctl status -D $pgData *> $null
if ($LASTEXITCODE -ne 0) {
  $log = Join-Path $pgData "server.log"
  & pg_ctl start -D $pgData -l $log -w
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL 启动失败，日志在 $log"
  }
}

if ($args.Count -eq 0) {
  Write-Output "Node $(node -v)"
  Write-Output "pnpm $(pnpm -v)"
  Write-Output "PostgreSQL data: $pgData"
  return
}

$command = $args[0]
$commandArgs = @()
if ($args.Count -gt 1) {
  $commandArgs = $args[1..($args.Count - 1)]
}
& $command @commandArgs
if ($null -ne $LASTEXITCODE) {
  exit $LASTEXITCODE
}
