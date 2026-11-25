RECON - Rust companion app
==========================

Live map, teammates, raid alarms, node heatmaps, raid planner, vending
search, crafting calculator and more, for the game Rust. Windows only.


1) INSTALL (about 2 minutes)
----------------------------
- Unzip this folder somewhere permanent, for example Documents\Recon.
  (Don't run it from inside the zip, and don't move the folder later.)
- Double-click "Install Recon.cmd".
  - If Node.js isn't installed, it installs it for you. Click Yes if Windows asks.
  - When it's done, Recon opens and a Recon shortcut is on your Desktop.
- Optional: right-click the Desktop shortcut > Show more options > Pin to taskbar.


2) CONNECT YOUR RUST SERVER
---------------------------
- Start Rust and join your server.
- In Recon, click the + at the bottom left.
- A Facepunch sign-in window opens. Read the notice, press "Login with Steam"
  and sign in. The window closes by itself.
- In Rust: press ESC > Rust+ > "Pair with server".
- Recon connects and shows your real map and team.
- Your Rust+ sign-in lasts 14 days. When it expires, Recon tells you:
  click + and sign in again.

Windows may ask about Node.js and network access at some point. That's Recon:
choose Allow (Private networks).


3) RAID ALARMS ON YOUR PHONE (optional)
---------------------------------------
- Install the free "ntfy" app (iPhone or Android) and allow notifications.
- Tap + and subscribe to the channel name your team uses
  (ask whoever set up Recon first).
- In Recon: bell icon > turn on "Also alert my phone".


4) RECON ON YOUR PHONE (optional)
---------------------------------
- In Recon: bell icon > Phone app > turn on, then follow the steps shown there
  (Safari > address > code > Share > Add to Home Screen).
- For use away from home, install the free Tailscale app on your PC and phone.


GOOD TO KNOW
------------
- Your login and settings are stored in %APPDATA%\Recon on your own PC.
  Nothing is shared with whoever gave you this folder.
- Recon isn't made by or affiliated with Facepunch Studios.
- Preview without a server: run "Start Recon.cmd", then open
  http://127.0.0.1:3170/?demo in a browser.
