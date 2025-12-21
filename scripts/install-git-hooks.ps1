param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$GitDir = Join-Path $ProjectRoot '.git'
if (-not (Test-Path $GitDir)) {
  throw "Not a git repository: $ProjectRoot"
}

$HooksDir = Join-Path $GitDir 'hooks'
New-Item -ItemType Directory -Force -Path $HooksDir | Out-Null

$SourceHook = Join-Path $ProjectRoot 'githooks\pre-commit'
if (-not (Test-Path $SourceHook)) {
  throw "Missing hook template: $SourceHook"
}

$DestHook = Join-Path $HooksDir 'pre-commit'
if ((Test-Path $DestHook) -and (-not $Force)) {
  throw "Hook already exists: $DestHook (use -Force to overwrite)"
}

Copy-Item -Force $SourceHook $DestHook

Write-Host "Installed git hook: $DestHook" -ForegroundColor Green
Write-Host "It will run: node scripts/export_db_artifacts.js" -ForegroundColor Green
