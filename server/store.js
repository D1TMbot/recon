// Persistent config: push credentials, Steam auth token and paired servers.
// Saved as JSON in %APPDATA%\Recon\config.json.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const DATA_DIR = path.join(process.env.APPDATA ?? path.join(os.homedir(), ".config"), "Recon");
const FILE = path.join(DATA_DIR, "config.json");

const DEFAULTS = { fcm: null, expoToken: null, authToken: null, steamId: null, servers: [], lastServer: null };

export function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function save(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, FILE);
}
