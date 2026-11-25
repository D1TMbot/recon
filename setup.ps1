# Recon setup: installs Node.js if needed, installs Recon's libraries, and adds
# a Recon shortcut to the Desktop and Start menu. Run via "Install Recon.cmd".
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Say($msg, $color = "Cyan") { Write-Host $msg -ForegroundColor $color }
Say "`n  Recon setup`n" "White"

# 1) Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Say "Node.js isn't installed. Installing it with winget (Microsoft's app installer)..."
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Say "winget isn't available on this PC. Install Node.js LTS from https://nodejs.org, then run Install Recon.cmd again." "Yellow"
    Read-Host "Press Enter to close"; exit 1
  }
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  # pick up the new PATH without restarting
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Say "Node.js was installed, but this window can't see it yet. Close this window and run Install Recon.cmd again." "Yellow"
    Read-Host "Press Enter to close"; exit 1
  }
}
Say ("Node.js " + (node --version) + " found.") "Green"

# 2) Recon's libraries
Say "Installing Recon's libraries..."
npm install --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { Say "npm install failed. Check your internet connection and try again." "Red"; Read-Host "Press Enter to close"; exit 1 }
Say "Libraries installed." "Green"

# 3) Shortcuts (hidden PowerShell starts the Recon server, which opens the app window)
$icon = Join-Path $root "recon-logo.ico"
$ps = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$lnkArgs = "-NoProfile -WindowStyle Hidden -Command `"Set-Location -LiteralPath '$root'; if (-not (Test-Path node_modules)) { npm install --no-audit --no-fund }; node server\index.js --open`""
$ws = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "Recon.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Programs")) "Recon.lnk")
)
foreach ($t in $targets) {
  $l = $ws.CreateShortcut($t)
  $l.TargetPath = $ps; $l.Arguments = $lnkArgs; $l.WorkingDirectory = $root
  $l.IconLocation = "$icon,0"; $l.WindowStyle = 7; $l.Description = "Recon - Rust companion"
  $l.Save()
}
Say "Added a Recon shortcut to your Desktop and Start menu." "Green"

Say "`nAll done! Opening Recon now..." "White"
Say "Tip: to pin it, right-click the Desktop shortcut > Show more options > Pin to taskbar.`n"
Start-Process $targets[0]
Start-Sleep 3
