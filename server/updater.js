// Auto-updates from GitHub Releases. Each release has a tag like v1.2.0 and a
// zip asset of the app. Recon checks on startup; when a newer version exists
// it downloads the zip, copies the new files over the app folder (keeping
// node_modules), runs npm install if dependencies changed, and restarts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = () => JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8"));
export const currentVersion = () => pkg().version;
const repo = () => pkg().recon?.updateRepo; // "owner/name"

const parse = (v) => String(v).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
export function newer(a, b) { // is a newer than b?
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 24, ...opts }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out))));

/** { current, latest, available, notes, url, asset } */
export async function checkForUpdate() {
  const r = repo();
  if (!r) return { current: currentVersion(), available: false, error: "No update source set" };
  const res = await fetch(`https://api.github.com/repos/${r}/releases/latest`, { headers: { "User-Agent": "Recon-updater", Accept: "application/vnd.github+json" } });
  if (res.status === 404) return { current: currentVersion(), available: false, latest: null };
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const rel = await res.json();
  const asset = (rel.assets ?? []).find((a) => /\.zip$/i.test(a.name));
  const latest = String(rel.tag_name ?? "").replace(/^v/, "");
  return { current: currentVersion(), latest, available: !!asset && newer(latest, currentVersion()), notes: rel.body ?? "", url: rel.html_url, asset: asset?.browser_download_url ?? null };
}

/** Download and install a release zip, then call onDone() (which restarts Recon). */
export async function applyUpdate(info, { onStatus } = {}) {
  if (!info?.asset) throw new Error("No update to install");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "recon-update-"));
  try {
    onStatus?.("Downloading…");
    const res = await fetch(info.asset, { headers: { "User-Agent": "Recon-updater" }, redirect: "follow" });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const zip = path.join(work, "update.zip");
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

    onStatus?.("Unpacking…");
    const out = path.join(work, "x");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`]);
    // the zip holds a "Recon" folder; find the one with package.json
    const find = (dir, depth = 0) => {
      if (fs.existsSync(path.join(dir, "package.json"))) return dir;
      if (depth > 2) return null;
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) { const f = find(path.join(dir, d.name), depth + 1); if (f) return f; }
      return null;
    };
    const src = find(out);
    if (!src) throw new Error("Update package looks wrong (no package.json)");
    const newPkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
    if (!newer(newPkg.version, currentVersion())) throw new Error("Downloaded version isn't newer");
    const depsChanged = JSON.stringify(newPkg.dependencies) !== JSON.stringify(pkg().dependencies);

    onStatus?.("Installing…");
    fs.cpSync(src, APP_DIR, { recursive: true, force: true, filter: (p) => !p.split(path.sep).includes("node_modules") });
    if (depsChanged) {
      onStatus?.("Updating libraries…");
      await run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: APP_DIR, shell: true });
    }
    return newPkg.version;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
}
