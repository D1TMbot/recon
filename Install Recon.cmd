@echo off
rem Double-click to set up Recon (installs Node.js if needed, adds shortcuts).
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
