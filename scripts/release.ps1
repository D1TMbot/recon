# Publishes a new Recon version to GitHub so everyone's Recon updates itself.
#   powershell -File scripts\release.ps1 -Version 1.0.1 -Notes "What changed"
# Steps: set the version in package.json, build dist\Recon-v<version>.zip
# (without node_modules / git / scripts), commit + tag + push, and create the
# GitHub release with the zip attached.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = "Bug fixes and improvements."
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 1.2.3" }

# 1) version
node -e "const f=require('fs');const p=JSON.parse(f.readFileSync('package.json','utf8'));p.version=process.argv[1];f.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')" $Version
if ($LASTEXITCODE -ne 0) { throw "Couldn't update package.json" }

# 2) zip
$dist = Join-Path $root "dist"; New-Item -ItemType Directory -Force $dist | Out-Null
$stage = Join-Path $env:TEMP "recon-release\Recon"
Remove-Item (Split-Path $stage) -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null
Get-ChildItem $root -Force | Where-Object { $_.Name -notin @(".git", "dist", "scripts", ".gitignore", "runtime") } |
  Copy-Item -Destination $stage -Recurse -Force
$zip = Join-Path $dist "Recon-v$Version.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path $stage -DestinationPath $zip
Write-Host "Built $zip"

# 2b) Windows installer (Recon-Setup.exe) with Node.js bundled, if Inno Setup is installed
$iscc = @((Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"), (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe")) | Where-Object { Test-Path $_ } | Select-Object -First 1
$setup = $null
if ($iscc) {
  $inst = Join-Path $env:TEMP "recon-installer\Recon"
  Remove-Item (Split-Path $inst) -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $inst | Out-Null
  Copy-Item (Join-Path $stage "*") $inst -Recurse -Force
  $nodeDir = Split-Path (Get-Command node).Source
  New-Item -ItemType Directory -Force (Join-Path $inst "runtime") | Out-Null
  Copy-Item (Join-Path $nodeDir "node.exe") (Join-Path $inst "runtime") -Force
  if (Test-Path (Join-Path $nodeDir "LICENSE")) { Copy-Item (Join-Path $nodeDir "LICENSE") (Join-Path $inst "runtime\NODE-LICENSE.txt") -Force }
  & $iscc /Q "/DAppVersion=$Version" "/DSourceDir=$inst" "/DOutDir=$dist" (Join-Path $root "scripts\recon.iss")
  if ($LASTEXITCODE -ne 0) { throw "Installer build failed" }
  $setup = Join-Path $dist "Recon-Setup.exe"
  Write-Host "Built $setup"
} else { Write-Host "Inno Setup not found: skipping the installer" }

# 3) git + GitHub release
git add -A
git commit -m "Recon v$Version`n`n$Notes`n`nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" | Out-Null
git tag "v$Version"
git push origin HEAD --tags
$assets = @($zip) + @($setup | Where-Object { $_ })
gh release create "v$Version" @assets --title "Recon v$Version" --notes $Notes
Write-Host "Published Recon v$Version"
