// Opens Microsoft Edge (or Chrome) windows: the app window itself, and the
// Steam sign-in window used for Rust+ pairing. Both browsers are signed, so
// Windows Smart App Control allows them.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { DATA_DIR } from "./store.js";

function findBrowser() {
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error("Microsoft Edge or Google Chrome is required but was not found");
  return found;
}

/** The app window: a chromeless browser window with its own profile. */
export function openAppWindow(url) {
  const profile = path.join(DATA_DIR, "app-profile");
  const child = spawn(findBrowser(), [
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    "--window-size=1320,840",
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
  ], { stdio: "ignore", detached: true, windowsHide: false });
  child.unref(); // the window must outlive this process
  return child;
}

let loginProc = null;
let loginWs = null;

/**
 * Steam sign-in for Rust+ pairing.
 *
 * Facepunch's sign-in pages (companion-rust.facepunch.com/login) hand the auth
 * token to the Rust+ app by calling window.ReactNativeWebView.postMessage(json)
 * as soon as the final page loads. We open those pages, unchanged, in a
 * throwaway Edge profile and use Edge's DevTools protocol to define that object
 * *before* every page loads, so the hand-off can't be missed. The player sees
 * and presses Facepunch's third-party warning and the Steam login themselves.
 */
export async function openSteamLogin(url, onMessage) {
  closeSteamLogin();
  // a fresh throwaway profile each time, so an old sign-in window can never take over
  for (const d of fs.readdirSync(DATA_DIR)) {
    if (d.startsWith("login-profile")) try { fs.rmSync(path.join(DATA_DIR, d), { recursive: true, force: true }); } catch {}
  }
  const profile = path.join(DATA_DIR, `login-profile-${Date.now()}`);
  const portFile = path.join(profile, "DevToolsActivePort");
  loginProc = spawn(findBrowser(), [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=560,820",
    "--window-position=380,60",
    "about:blank",
  ], { stdio: "ignore", detached: true, windowsHide: false });
  loginProc.unref();
  const proc = loginProc;
  proc.on("exit", () => { if (loginProc === proc) loginProc = null; });

  // Edge writes the chosen debugging port to DevToolsActivePort
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try { port = parseInt(fs.readFileSync(portFile, "utf8"), 10) || null; } catch {}
  }
  if (!port) throw new Error("Couldn't open the sign-in window");

  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
    if (!page) await new Promise((r) => setTimeout(r, 150));
  }
  if (!page) throw new Error("Couldn't attach to the sign-in window");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  loginWs = ws;
  let id = 0;
  const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
  ws.on("open", () => {
    send("Runtime.enable");
    send("Page.enable");
    send("Runtime.addBinding", { name: "__reconLogin" });
    send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.ReactNativeWebView = { postMessage: function (m) { window.__reconLogin(String(m)); } };",
    });
    send("Page.navigate", { url });
    send("Page.bringToFront");
  });
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.method === "Page.loadEventFired") send("Page.bringToFront");
    if (m.method === "Runtime.bindingCalled" && m.params?.name === "__reconLogin") onMessage(m.params.payload);
  });
  ws.on("error", () => {});
}

export function closeSteamLogin() {
  try { loginWs?.close(); } catch {}
  loginWs = null;
  if (loginProc?.pid) {
    // end the whole Edge process tree for the throwaway profile
    try { spawn("taskkill", ["/pid", String(loginProc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
  }
  loginProc = null;
}
