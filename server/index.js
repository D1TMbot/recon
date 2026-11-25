// Recon backend: serves the UI on http://127.0.0.1:3170, exposes a
// small JSON API (POST /api/<command>) and pushes live events to the UI over
// a websocket (/events). Run with --open to also open the app window.

import http from "node:http";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import * as store from "./store.js";
import * as fcm from "./fcm.js";
import { RustPlusClient } from "./rustplus.js";
import { openAppWindow, openSteamLogin, closeSteamLogin } from "./browser.js";
import { spawn } from "node:child_process";
const spawnNode = (args) => spawn(process.execPath, args, { cwd: process.cwd(), detached: true, stdio: "ignore", windowsHide: true });
import { checkForUpdate, applyUpdate, currentVersion } from "./updater.js";
import { newTopic, phonePush, PIN_KINDS, parsePinMessage, pinMessage, unpinMessage, upsertPin, removePinAt, upkeepLeft } from "./extras.js";

const PORT = Number(process.env.RC_PORT ?? 3170);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
const OPEN_WINDOW = process.argv.includes("--open");

const cfg = store.load();
const save = () => store.save(cfg);
// user settings (alerts etc.); a private ntfy topic is created on first run
cfg.settings = { ntfyEnabled: false, ntfyTopic: "", siren: true, upkeepWarnHours: 6, wipePeriod: "auto", phoneAccess: false, autoUpdate: true, ...(cfg.settings ?? {}) };
cfg.phones ??= []; // [{ token, name, created, lastSeen }]
if (!cfg.settings.ntfyTopic) { cfg.settings.ntfyTopic = newTopic(); save(); }
let client = null;       // active RustPlusClient
let listener = null;     // PushListener
let active = null;       // { server, mapKey, mapSize } for the connected server

// ------------------------------------------------------------------ events
const sockets = new Set();
function emit(event, payload) {
  const msg = JSON.stringify({ event, payload });
  for (const ws of sockets) if (ws.readyState === 1) ws.send(msg);
}

// ----------------------------------------------------------------- helpers
const str = (v) => (v === undefined || v === null ? undefined : String(v));
function activeClient() {
  if (!client) throw new Error("Not connected to a server");
  return client;
}

async function ensurePushCredentials() {
  if (!cfg.fcm) {
    cfg.fcm = await fcm.register();
    save();
  }
  if (!cfg.expoToken) {
    cfg.expoToken = await fcm.expoPushToken(cfg.fcm.fcmToken);
    save();
  }
}

function startListener() {
  if (listener || !cfg.fcm) return;
  listener = new fcm.PushListener(cfg.fcm, {
    onStatus: (s) => emit("push-status", s),
    onPush: handlePush,
  }).start();
}

/** Rust+ auth token = base64(json {steamId, iss, exp}).signature; returns exp (unix seconds) or null. */
function tokenExpiry(token) {
  try { return Number(JSON.parse(Buffer.from(String(token).split(".")[0], "base64").toString("utf8")).exp) || null; } catch { return null; }
}


function handlePush(data) {
  const title = data.title ?? "";
  const message = data.message ?? "";
  const channel = data.channelId ?? "";

  // Pairing/alarm details are a JSON string, normally under "body".
  let body = null;
  try { body = JSON.parse(data.body); } catch {}
  if (!body || typeof body !== "object") {
    for (const v of Object.values(data)) {
      try { const j = JSON.parse(v); if (j && j.ip) { body = j; break; } } catch {}
    }
  }
  if (!body) return emit("notification", { title, message, channel });

  // address fields: "ip"/"port" historically; accept likely alternatives too
  const ip = str(body.ip ?? body.address ?? body.host ?? body.serverIp ?? body.server_ip) ?? "";
  const port = Number(body.port ?? body.appPort ?? body.app_port ?? body.rustPlusPort ?? body.serverPort) || 0;
  const relayId = str(body.id) ?? "";
  // new-style pairing (Nov 2026+) has no ip/port, only the relay server id
  const serverId = ip && port ? `${ip}:${port}` : relayId ? `relay-${relayId}` : "";
  const kind = str(body.type) ?? "";

  if (channel === "alarm" || (kind !== "server" && kind !== "entity")) {
    return raiseAlarm({ title, message, serverId, key: `push:${title}` });
  }

  const playerId = str(body.playerId);
  const playerToken = Number(body.playerToken);
  if (!playerId || !Number.isFinite(playerToken)) return;
  if (!serverId) {
    emit("pair-error", { message: "Pairing message had no server address or id. Try pairing again." });
    return;
  }

  let server = cfg.servers.find((s) => s.id === serverId || (relayId && s.relayId === relayId));
  if (!server) {
    server = {
      id: serverId, name: str(body.name) ?? serverId, ip, port, relayId, playerId, playerToken,
      img: str(body.img) ?? "", logo: str(body.logo) ?? "", desc: str(body.desc) ?? "", url: str(body.url) ?? "",
      entities: [],
    };
    cfg.servers.push(server);
  }
  server.playerId = playerId;
  server.playerToken = playerToken;
  if (relayId) server.relayId = relayId;

  if (kind === "server") {
    if (body.name) server.name = str(body.name);
    if (body.img) server.img = str(body.img);
    save();
    emit("server-paired", server);
  } else {
    const entityId = str(body.entityId); // can exceed 32 bits; keep as a string
    if (!entityId || !/^\d+$/.test(entityId)) return;
    const entity = { entityId, entityType: Number(body.entityType) || 0, name: str(body.entityName) ?? title };
    server.entities = server.entities.filter((e) => e.entityId !== entityId).concat(entity);
    save();
    emit("entity-paired", { serverId: server.id, entity });
  }
}

// ------------------------------------------------------------------ alarms
const recentAlarms = new Map();
/** One alarm event can arrive twice (push + live broadcast); alert once per 30 s. */
function raiseAlarm({ title, message, serverId, key, entityId }) {
  const now = Date.now();
  if (recentAlarms.get(key) > now - 30000) return;
  recentAlarms.set(key, now);
  // push alarms only carry the alarm's name; match it to a paired alarm
  const srv = cfg.servers.find((s) => s.id === serverId) ?? active?.server;
  const alarmId = entityId ?? srv?.entities?.find((e) => Number(e.entityType) === 2 && e.name && e.name === title)?.entityId;
  runAutomations(srv, (t) => t.type === "alarm" && (t.entityId === "any" || String(t.entityId) === String(alarmId)));
  const serverName = cfg.servers.find((s) => s.id === serverId)?.name ?? active?.server.name ?? "";
  emit("alarm", { title: title || "Smart Alarm", message, serverId });
  phonePush(cfg.settings, {
    title: `RAID ALARM: ${title || "Smart Alarm"}`,
    message: [message, serverName].filter(Boolean).join(" · ") || "Your Smart Alarm went off",
    priority: 5, tags: ["rotating_light"],
  }).catch((e) => emit("notification", { title: "Phone alert failed", message: String(e.message ?? e) }));
}

// ------------------------------------------------------------------ upkeep
// Storage Monitors on a tool cupboard report when upkeep runs out. Poll them
// while connected, push a warning to the phone when it gets low.
let upkeepTimer = null;
const upkeep = new Map(); // entityId -> { entityId, name, left, at, warned }
function updateUpkeep(ent, payload) {
  const left = upkeepLeft(payload);
  if (left == null) return;
  const prev = upkeep.get(String(ent.entityId));
  const u = { entityId: String(ent.entityId), name: ent.name || "Tool cupboard", left, at: Date.now(), warned: prev?.warned ?? false };
  const warnAt = (cfg.settings.upkeepWarnHours || 6) * 3600;
  if (left < warnAt && !u.warned) {
    u.warned = true;
    const h = Math.floor(left / 3600), m = Math.round((left % 3600) / 60);
    const text = left <= 0 ? "Upkeep has run out, your base is decaying" : `Upkeep runs out in ${h}h ${m}m`;
    emit("upkeep-warning", { name: u.name, left });
    phonePush(cfg.settings, { title: `Low upkeep: ${u.name}`, message: `${text} · ${active?.server.name ?? ""}`, priority: 4, tags: ["warning"] }).catch(() => {});
  }
  if (left > warnAt + 3600) u.warned = false;
  upkeep.set(u.entityId, u);
  emit("upkeep", [...upkeep.values()]);
}
async function pollUpkeep() {
  const c = client;
  if (!c || !active) return;
  for (const ent of active.server.entities ?? []) {
    if (Number(ent.entityType) !== 3) continue;
    try { updateUpkeep(ent, (await c.getEntityInfo(String(ent.entityId))).payload); } catch {}
  }
}
function startUpkeep() {
  clearInterval(upkeepTimer); upkeep.clear();
  pollUpkeep();
  upkeepTimer = setInterval(pollUpkeep, 120000);
}

// ------------------------------------------------------------ automations
function runAutomations(srv, match) {
  if (!srv) return;
  for (const rule of srv.automations ?? []) {
    if (!rule.enabled || !match(rule.trigger)) continue;
    const c = client;
    if (!c || c.serverId !== srv.id) { emit("automation-ran", { rule, ok: false, error: "Not connected to the server" }); continue; }
    for (const a of rule.actions ?? []) {
      c.setEntityValue(String(a.entityId), !!a.value)
        .then(() => emit("automation-ran", { rule, ok: true }))
        .catch((e) => emit("automation-ran", { rule, ok: false, error: String(e.message ?? e) }));
    }
  }
}
// in-game day/night changes (polled while connected)
let timeTimer = null, wasNight = null;
async function pollTime() {
  const c = client;
  if (!c || !active) return;
  try {
    const t = await c.getTime();
    emit("rp-time", t);
    const night = t.time >= t.sunset || t.time < t.sunrise;
    if (wasNight !== null && night !== wasNight) runAutomations(active.server, (tr) => tr.type === (night ? "night" : "day"));
    wasNight = night;
  } catch {}
}
function startTime() { clearInterval(timeTimer); wasNight = null; pollTime(); timeTimer = setInterval(pollTime, 60000); }

// -------------------------------------------------------- population tracker
const POP_FILE = path.join(store.DATA_DIR, "population.json");
const POP_KEEP_MS = 14 * 86400000;
let pop = (() => { try { return JSON.parse(fs.readFileSync(POP_FILE, "utf8")); } catch { return {}; } })();
let popTimer = null;
function recordPopulation(serverId, info) {
  if (!info || !Number.isFinite(Number(info.players))) return;
  const now = Date.now();
  const list = (pop[serverId] ??= []);
  const last = list.at(-1);
  if (last && now - last.t < 4 * 60000) return; // at most one sample per ~5 min
  list.push({ t: now, p: Number(info.players), q: Number(info.queuedPlayers) || 0, m: Number(info.maxPlayers) || 0 });
  while (list.length && list[0].t < now - POP_KEEP_MS) list.shift();
  try { fs.writeFileSync(POP_FILE + ".tmp", JSON.stringify(pop)); fs.renameSync(POP_FILE + ".tmp", POP_FILE); } catch {}
  emit("population", { serverId, point: list.at(-1) });
}
function startPopulation(serverId, info) {
  clearInterval(popTimer);
  recordPopulation(serverId, info);
  popTimer = setInterval(async () => {
    const c = client;
    if (!c || c.serverId !== serverId) return;
    try { recordPopulation(serverId, await c.getInfo()); } catch {}
  }, 5 * 60000);
}

// --------------------------------------------------------------- map pins
function currentPins() {
  if (!active) return [];
  return (active.server.pins ?? []).filter((p) => p.map === active.mapKey);
}
function applyPin(op, by) {
  if (!active) return;
  active.server.pins ??= [];
  const changed = op.op === "add"
    ? upsertPin(active.server.pins, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind: op.kind, label: op.label ?? "", x: Math.round(op.x), y: Math.round(op.y), by, ts: Date.now(), map: active.mapKey })
    : removePinAt(active.server.pins, active.mapKey, op.x, op.y);
  if (changed) { save(); emit("pins-changed", currentPins()); }
}

// ---------------------------------------------------------------- commands
const commands = {
  // ---- settings and alerts
  get_settings: () => cfg.settings,
  set_settings(patch = {}) {
    const allowed = ["ntfyEnabled", "siren", "upkeepWarnHours", "wipePeriod", "watchPlayers", "autoUpdate"];
    for (const k of allowed) if (k in patch) cfg.settings[k] = patch[k];
    if (patch.newTopic) cfg.settings.ntfyTopic = newTopic();
    save();
    return cfg.settings;
  },
  async test_phone_alert() {
    if (!cfg.settings.ntfyEnabled) throw new Error("Turn on phone alerts first");
    await phonePush(cfg.settings, { title: "Recon test alert", message: "If you can read this, raid alarms will reach your phone.", priority: 5, tags: ["white_check_mark"] });
    return true;
  },
  get_upkeep: () => [...upkeep.values()],
  get_automations: () => active?.server.automations ?? [],
  save_automations({ list }) {
    if (!active) throw new Error("Not connected to a server");
    active.server.automations = (Array.isArray(list) ? list : []).slice(0, 50).map((r) => ({
      id: String(r.id ?? Date.now()), enabled: r.enabled !== false,
      trigger: { type: ["alarm", "night", "day"].includes(r.trigger?.type) ? r.trigger.type : "alarm", entityId: r.trigger?.entityId ?? "any" },
      actions: (r.actions ?? []).slice(0, 5).map((a) => ({ entityId: String(a.entityId), value: !!a.value })),
    }));
    save();
    return active.server.automations;
  },
  get_population: ({ id } = {}) => pop[id ?? client?.serverId] ?? [],

  // ---- shared map pins (base markers)
  get_pins: () => currentPins(),
  async add_pin({ kind, label, x, y }) {
    if (!PIN_KINDS.includes(kind)) throw new Error("Unknown marker type");
    const pin = { op: "add", kind, label: String(label ?? "").replace(/[\r\n]/g, " ").slice(0, 40), x, y };
    applyPin(pin, "you");
    client?.sendTeamMessage(pinMessage(pin, active.mapSize)).catch(() => {});
    return currentPins();
  },
  async remove_pin({ x, y }) {
    applyPin({ op: "remove", x, y }, "you");
    client?.sendTeamMessage(unpinMessage({ x, y })).catch(() => {});
    return currentPins();
  },

  async get_state() {
    return {
      version: currentVersion(),
      loggedIn: !!(cfg.authToken && cfg.fcm),
      tokenExpiresAt: tokenExpiry(cfg.authToken),
      steamId: cfg.steamId,
      servers: cfg.servers,
      lastServer: cfg.lastServer,
      connectedServer: client?.serverId ?? null,
    };
  },

  async start_pairing({ forceLogin } = {}) {
    await ensurePushCredentials();
    if (cfg.authToken && !forceLogin) {
      startListener();
      return "listening";
    }
    await openSteamLogin("https://companion-rust.facepunch.com/login", async (payload) => {
      try { await commands.login_callback({ data: payload }); }
      catch (e) { emit("login-status", { ok: false, error: String(e.message ?? e) }); }
    });
    return "login";
  },

  async login_callback({ data }) {
    const v = JSON.parse(data);
    if (!v.Token) throw new Error("Steam sign-in returned no token");
    await fcm.facepunchRegister(v.Token, cfg.expoToken);
    cfg.authToken = v.Token;
    cfg.steamId = str(v.SteamId) ?? null;
    save();
    startListener();
    emit("login-status", { ok: true });
    setTimeout(closeSteamLogin, 1500);
    return true;
  },

  async remove_server({ id }) {
    if (client?.serverId === id) { client.close(); client = null; }
    cfg.servers = cfg.servers.filter((s) => s.id !== id);
    if (cfg.lastServer === id) cfg.lastServer = null;
    save();
  },

  async sign_out() {
    listener?.stop();
    listener = null;
    cfg.authToken = null;
    cfg.steamId = null;
    save();
  },

  async connect_server({ id }) {
    const server = cfg.servers.find((s) => s.id === id);
    if (!server) throw new Error("Unknown server");
    if (client) { client.close(); client = null; }
    const exp = tokenExpiry(cfg.authToken);
    if (server.relayId && exp && exp * 1000 < Date.now()) throw new Error("Your Rust+ sign-in expired (it lasts 14 days). Click + and sign in with Steam again.");
    const c = new RustPlusClient(server, {
      authToken: cfg.authToken,
      onBroadcast: (b) => {
        if (b.teamChanged) emit("rp-team", b.teamChanged.teamInfo);
        if (b.teamMessage) { emit("rp-team-message", b.teamMessage.message); onTeamMessage(c, b.teamMessage.message); }
        if (b.entityChanged) {
          emit("rp-entity-changed", b.entityChanged);
          const ent = server.entities?.find((e) => String(e.entityId) === String(b.entityChanged.entityId));
          if (ent && Number(ent.entityType) === 2 && b.entityChanged.payload?.value) raiseAlarm({ title: ent.name || "Smart Alarm", message: "", serverId: server.id, key: `ent:${ent.entityId}`, entityId: ent.entityId });
          if (ent && Number(ent.entityType) === 3) updateUpkeep(ent, b.entityChanged.payload);
        }
      },
      onClose: () => {
        if (client === c) client = null;
        emit("rp-disconnected", id);
      },
    });
    await c.connect();
    const info = await c.getInfo();
    client = c;
    active = { server, mapKey: `${info.seed}:${info.mapSize}`, mapSize: info.mapSize };
    server.pins ??= [];
    cfg.lastServer = id;
    save();
    startUpkeep();
    startPopulation(id, info);
    startTime();
    return info;
  },

  async disconnect() { client?.close(); client = null; active = null; clearInterval(upkeepTimer); clearInterval(popTimer); clearInterval(timeTimer); },

  async get_map() {
    const c = activeClient();
    const key = active ? `${active.server.id}|${active.mapKey}`.replace(/[^\w.-]+/g, "_") : null;
    const file = key && path.join(store.DATA_DIR, "maps", `${key}.json`);
    if (file) { try { return { ...JSON.parse(fs.readFileSync(file, "utf8")), cached: true }; } catch {} }
    const m = await c.getMap();
    const { jpgImage, ...rest } = m;
    const out = { ...rest, jpgBase64: jpgImage }; // bytes already base64 from protobufjs
    if (file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // keep only the newest few maps
        const dir = path.dirname(file), olds = fs.readdirSync(dir).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
        for (const o of olds.slice(8)) fs.rmSync(path.join(dir, o.f), { force: true });
        fs.writeFileSync(file, JSON.stringify(out));
      } catch {}
    }
    return out;
  },
  get_team: () => activeClient().getTeamInfo(),
  get_markers: () => activeClient().getMapMarkers(),
  get_time: () => activeClient().getTime(),
  get_info: () => activeClient().getInfo(),
  get_team_chat: () => activeClient().getTeamChat(),
  send_team_message: ({ message }) => activeClient().sendTeamMessage(String(message).slice(0, 128)),
  get_entity_info: ({ entityId }) => activeClient().getEntityInfo(String(entityId)),
  set_entity_value: ({ entityId, value }) => activeClient().setEntityValue(String(entityId), !!value),

};

// --------------------------------------------------------------- team chat
// Recon only listens to team chat for shared map markers ("[Recon] pin ...").
function onTeamMessage(c, msg) {
  const pin = parsePinMessage(msg.message);
  if (pin && client === c) applyPin(pin, msg.name);
}

// ------------------------------------------------------------ phone access
// Off by default: Recon only listens on this PC. When on, it also listens on
// the network (home Wi-Fi / Tailscale) and every request from another device
// must carry a token that was handed out for a one-time pairing code.
const HOST = cfg.settings.phoneAccess ? "0.0.0.0" : "127.0.0.1";
let pairCode = null; // { code, expires }
const LOCAL_ONLY = new Set(["check_update", "install_update", "start_pairing", "login_callback", "sign_out", "remove_server", "get_phone_access", "new_phone_code", "revoke_phone", "set_phone_access", "quit"]);
const isLocal = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
function cookieToken(req) {
  const m = String(req.headers.cookie ?? "").match(/(?:^|;\s*)recon_token=([a-f0-9]{64})/);
  return m ? m[1] : null;
}
function phoneFor(req) {
  const t = cookieToken(req);
  const p = t && cfg.phones.find((x) => x.token === t);
  if (p) p.lastSeen = Date.now();
  return p ?? null;
}
function networkAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list ?? []) {
    if (a.family !== "IPv4" || a.internal) continue;
    const [x, y] = a.address.split(".").map(Number);
    const tailscale = x === 100 && y >= 64 && y <= 127;
    out.push({ address: a.address, kind: tailscale ? "tailscale" : "lan", name });
  }
  return out;
}
// ---------------------------------------------------------------- updates
let update = { info: null, status: "", checkedAt: 0 };
async function doUpdateCheck({ install } = {}) {
  try {
    update.status = "Checking…"; emit("update", update);
    update.info = await checkForUpdate(); update.checkedAt = Date.now();
    update.status = update.info.available ? `Version ${update.info.latest} is available` : "Recon is up to date";
    emit("update", update);
    if (update.info.available && install) await doInstall();
  } catch (e) { update.status = `Couldn't check for updates (${e.message})`; emit("update", update); }
}
async function doInstall() {
  const v = await applyUpdate(update.info, { onStatus: (s) => { update.status = s; emit("update", update); } });
  update.status = `Updated to ${v}. Restarting…`;
  emit("updated", { version: v });
  setTimeout(() => restartSelf(), 800);
}

Object.assign(commands, {
  get_update: () => ({ current: currentVersion(), autoUpdate: cfg.settings.autoUpdate, ...update }),
  async check_update() { await doUpdateCheck(); return commands.get_update(); },
  async install_update() { if (!update.info?.available) await doUpdateCheck(); if (!update.info?.available) throw new Error("No update available"); await doInstall(); return true; },
  get_phone_access: () => ({
    enabled: !!cfg.settings.phoneAccess,
    listening: HOST !== "127.0.0.1",
    port: PORT,
    addresses: networkAddresses(),
    code: pairCode && pairCode.expires > Date.now() ? pairCode.code : null,
    codeExpires: pairCode?.expires ?? null,
    phones: cfg.phones.map((p) => ({ id: p.token.slice(0, 8), name: p.name, created: p.created, lastSeen: p.lastSeen })),
  }),
  new_phone_code() {
    pairCode = { code: String(crypto.randomInt(0, 1e6)).padStart(6, "0"), expires: Date.now() + 10 * 60000 };
    return commands.get_phone_access();
  },
  revoke_phone({ id }) { cfg.phones = cfg.phones.filter((p) => p.token.slice(0, 8) !== id); save(); return commands.get_phone_access(); },
  set_phone_access({ enabled }) {
    cfg.settings.phoneAccess = !!enabled; save();
    // switching between this-PC-only and network needs a restart of the server
    setTimeout(() => restartSelf(), 300);
    return { restarting: true };
  },
  quit() { setTimeout(() => process.exit(0), 200); return true; },
});
function restartSelf() {
  server.close();
  for (const ws of sockets) try { ws.close(); } catch {}
  const child = spawnNode([process.argv[1], ...process.argv.slice(2).filter((a) => a !== "--restarted"), "--restarted"]);
  child.unref();
  setTimeout(() => process.exit(0), 200);
}

// ------------------------------------------------------------------ server
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };

function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  if (o === ORIGIN || o === `http://localhost:${PORT}`) return true;
  // pages loaded from this server over the network (phone) use the address they reached us on
  return cfg.settings.phoneAccess && o === `http://${req.headers.host}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);

  if (url.pathname.startsWith("/api/")) {
    // Only our own pages may call the API (blocks other websites on this PC).
    if (req.method !== "POST" || !sameOrigin(req) || !String(req.headers["content-type"]).startsWith("application/json")) {
      res.writeHead(403).end();
      return;
    }
    const name = url.pathname.slice(5);
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) break; }
    if (!isLocal(req)) {
      // another device: pairing with a code, otherwise a valid phone token is required
      if (name === "phone_login") {
        let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
        const ok = pairCode && pairCode.expires > Date.now() && String(body.code ?? "").trim() === pairCode.code;
        if (!ok) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Wrong or expired code. Make a new one in Recon on your PC." })); return; }
        pairCode = null;
        const token = crypto.randomBytes(32).toString("hex");
        cfg.phones.push({ token, name: String(body.name ?? "Phone").slice(0, 40), created: Date.now(), lastSeen: Date.now() });
        save();
        res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `recon_token=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict` });
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      if (!phoneFor(req)) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "phone_login_required" })); return; }
      if (LOCAL_ONLY.has(name) || (name === "set_settings" && /phoneAccess/.test(raw))) {
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "Do this in Recon on your PC" })); return;
      }
    }
    const fn = Object.hasOwn(commands, name) ? commands[name] : null;
    let out;
    try {
      if (!fn) throw new Error(`Unknown command ${name}`);
      const args = raw ? JSON.parse(raw) : {};
      out = { ok: true, result: (await fn(args)) ?? null };
    } catch (e) {
      out = { ok: false, error: e?.message ?? String(e) };
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(out));
    return;
  }

  // Static UI files
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.normalize(path.join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  });
});

// Live events to the UI. When launched with --open, quit once the app window
// has been closed for a while (no UI connected).
const wss = new WebSocketServer({ noServer: true });
let idleTimer = null;
server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, ORIGIN).pathname !== "/events" || !sameOrigin(req) || (!isLocal(req) && !phoneFor(req))) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.add(ws);
    clearTimeout(idleTimer);
    ws.on("close", () => {
      sockets.delete(ws);
      if (OPEN_WINDOW && sockets.size === 0 && !cfg.settings.phoneAccess) { // with phone access on, keep running in the background
        idleTimer = setTimeout(() => { console.log("App window closed, exiting."); process.exit(0); }, 20000);
      }
    });
  });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    // Already running: just open another window onto it.
    console.log(`Recon is already running on ${ORIGIN}`);
    if (OPEN_WINDOW) openAppWindow(ORIGIN);
    setTimeout(() => process.exit(0), 4000); // give Edge time to start before we exit
  } else {
    throw e;
  }
});

const RESTARTED = process.argv.includes("--restarted");
setTimeout(() => server.listen(PORT, HOST, () => {
  console.log(`Recon running at ${ORIGIN}${HOST !== "127.0.0.1" ? " (phone access on)" : ""}`);
  if (cfg.authToken && cfg.fcm) startListener();
  // look for updates a little after start (and every 6 hours while running)
  setTimeout(() => doUpdateCheck({ install: cfg.settings.autoUpdate }), 15000);
  setInterval(() => doUpdateCheck({ install: false }), 6 * 3600000);
  if (OPEN_WINDOW) {
    if (!RESTARTED) openAppWindow(ORIGIN); // after a settings restart the existing window reconnects by itself
    // if no window ever connects (it failed to open or was closed early), don't linger in the background
    setTimeout(() => { if (sockets.size === 0 && !cfg.settings.phoneAccess) { console.log("No app window connected, exiting."); process.exit(0); } }, 90000);
  }
}), RESTARTED ? 1500 : 0); // a restarted copy waits for the old one to let go of the port

