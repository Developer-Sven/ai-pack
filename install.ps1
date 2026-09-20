# ai-pack - Windows PowerShell entry point. Needs Node.js 18+ (https://nodejs.org or: winget install OpenJS.NodeJS.LTS).
# Scripts blocked by the execution policy? Use .\install.cmd (works in PowerShell too) or: node install.mjs
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'ai-pack needs Node.js 18 or newer: https://nodejs.org  (or: winget install OpenJS.NodeJS.LTS)' -ForegroundColor Yellow
  exit 1
}
# PowerShell turns `--only a,b` into an array; hand node the single argument "a,b" that was typed
$nodeArgs = @($args | ForEach-Object { if ($_ -is [array]) { $_ -join ',' } else { "$_" } })
& node (Join-Path $PSScriptRoot 'install.mjs') @nodeArgs
exit $LASTEXITCODE
