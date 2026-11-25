// Rust+ client. Since the Nov 5 2026 Rust update, game servers no longer accept
// direct companion connections; clients go through Facepunch's relay:
//   wss://companion-rust.facepunch.com/socket/<server id>
//   subprotocols ["rustplus.auth.v1", base64url(<Steam-login Rust+ token>)], origin https://app.playrust.com
// (<server id> is the "id" from the in-game pairing notification.) Servers
// paired the old way (ip/port) still try the direct/proxy route.
// Requests are matched to responses by `seq`; broadcasts (team changes,
// team chat, smart device changes) go to onBroadcast.

import WebSocket from "ws";
import { R, encode, decode } from "./protos.js";

const FRIENDLY = {
  not_found: "Not found (the device may have been destroyed)",
  rate_limit: "Rate limited by the server, slow down a bit",
  no_player: "Access denied: re-pair this server in-game",
  access_denied: "Access denied: re-pair this server in-game",
  no_team: "You're not in a team",
  banned: "You are banned from this server",
};

const b64url = (s) => Buffer.from(s, "utf8").toString("base64url"); // URL-safe, no padding

function openSocket(url, timeoutMs, protocols, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols ?? [], { handshakeTimeout: timeoutMs, ...(origin ? { origin } : {}) });
    ws.once("unexpected-response", (_req, res) => { clearTimeout(t); ws.terminate(); reject(new Error(`HTTP ${res.statusCode}`)); });
    const t = setTimeout(() => { ws.terminate(); reject(new Error("timeout")); }, timeoutMs + 500);
    ws.once("open", () => { clearTimeout(t); resolve(ws); });
    ws.once("error", (e) => { clearTimeout(t); reject(e); });
  });
}

export class RustPlusClient {
  constructor(server, { onBroadcast, onClose, authToken }) {
    this.server = server;
    this.authToken = authToken;
    this.serverId = server.id;
    this.onBroadcast = onBroadcast;
    this.onClose = onClose;
    this.seq = 1;
    this.pending = new Map();
    this.closedByUs = false;
  }

  async connect() {
    const { ip, port, relayId } = this.server;
    if (relayId) {
      if (!this.authToken) throw new Error("Sign in with Steam again (click + in Recon)");
      try {
        this.ws = await openSocket(
          `wss://companion-rust.facepunch.com/socket/${encodeURIComponent(relayId)}?v=${Date.now()}`,
          12000, ["rustplus.auth.v1", b64url(this.authToken)], "https://app.playrust.com");
      } catch (e) {
        if (/HTTP 40[13]/.test(e.message)) throw new Error("Your Rust+ sign-in was rejected or expired. Click + and sign in with Steam again.");
        throw new Error(`Could not reach the Rust+ relay (${e.message})`);
      }
      return this.#wire();
    }
    try {
      this.ws = await openSocket(`ws://${ip}:${port}`, 6000);
    } catch {
      try {
        this.ws = await openSocket(`wss://companion-rust.facepunch.com/game/${ip}/${port}`, 10000);
      } catch (e) {
        throw new Error(`Could not reach ${ip}:${port} (${e.message})`);
      }
    }
    return this.#wire();
  }

  #wire() {
    // the relay may also send text frames; only binary frames are protobuf messages
    this.frames = [];
    this.ws.on("message", (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (this.frames.length < 20) this.frames.push({ at: Date.now(), binary: isBinary, len: buf.length, head: isBinary ? buf.subarray(0, 24).toString("hex") : buf.toString("utf8").slice(0, 300) });
      if (isBinary !== false) this.#onMessage(buf);
    });
    this.ws.on("close", (code, reason) => { this.closeInfo = { code, reason: String(reason) }; });
    this.ws.on("close", () => {
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error("connection closed")); }
      this.pending.clear();
      if (!this.closedByUs) this.onClose?.();
    });
    this.ws.on("error", () => {}); // 'close' follows
    return this;
  }

  close() {
    this.closedByUs = true;
    this.ws?.close();
  }

  #onMessage(data) {
    let msg;
    try { msg = decode(R.AppMessage, data); }
    catch (e) { (this.decodeErrors ??= []).length < 10 && this.decodeErrors.push(String(e.message)); return; }
    if (msg.response) {
      const p = this.pending.get(msg.response.seq);
      if (p) {
        this.pending.delete(msg.response.seq);
        clearTimeout(p.timer);
        const err = msg.response.error?.error;
        err ? p.reject(new Error(FRIENDLY[err] ?? `Server error: ${err}`)) : p.resolve(msg.response);
      }
    }
    if (msg.broadcast) this.onBroadcast?.(msg.broadcast);
  }

  debug() { return { readyState: this.ws?.readyState, protocol: this.ws?.protocol, frames: this.frames, closeInfo: this.closeInfo, sent: this.sent, decodeErrors: this.decodeErrors }; }

  request(fields) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Not connected to a server"));
    const seq = this.seq++;
    const buf = encode(R.AppRequest, {
      seq,
      playerId: this.server.playerId,
      playerToken: this.server.playerToken,
      ...fields,
    });
    (this.sent ??= []).length < 10 && this.sent.push({ at: Date.now(), seq, len: buf.length, keys: Object.keys(fields) });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error("Server did not answer in time"));
      }, 15000);
      this.pending.set(seq, { resolve, reject, timer });
      this.ws.send(buf);
    });
  }

  async getInfo() { return (await this.request({ getInfo: {} })).info; }
  async getTime() { return (await this.request({ getTime: {} })).time; }
  async getMap() { return (await this.request({ getMap: {} })).map; }
  async getTeamInfo() { return (await this.request({ getTeamInfo: {} })).teamInfo; }
  async getMapMarkers() { return (await this.request({ getMapMarkers: {} })).mapMarkers; }
  async getTeamChat() { return (await this.request({ getTeamChat: {} })).teamChat; }
  async sendTeamMessage(message) { await this.request({ sendTeamMessage: { message } }); }
  async getEntityInfo(entityId) { return (await this.request({ entityId, getEntityInfo: {} })).entityInfo; }
  async setEntityValue(entityId, value) { await this.request({ entityId, setEntityValue: { value } }); }
}
