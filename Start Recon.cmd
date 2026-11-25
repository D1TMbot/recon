@echo off
rem Starts the Recon backend and opens the app window.
rem The backend quits by itself ~20 seconds after you close the app window.
cd /d "%~dp0"
if not exist node_modules (
  echo First run: installing packages...
  call npm install --no-fund --no-audit
)
title Recon (keep open while using the app)
node server\index.js --open
