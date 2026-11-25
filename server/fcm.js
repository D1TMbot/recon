// Push-notification registration and listening, so the app receives the
// "pair with server" / smart alarm notifications Rust sends to the Rust+
// companion app. Same approach as rustplus.js + push-receiver:
//
// 1. Firebase installation  -> installation auth token
// 2. Android check-in       -> androidId + securityToken
// 3. c2dm/register3         -> FCM token
// 4. Expo push token        (Facepunch sends pushes through Expo)
// 5. Facepunch register     (ties the Expo token to the Steam account)
// 6. MCS socket to mtalk.google.com:5228 to receive the pushes.

import tls from "node:tls";
import crypto from "node:crypto";
import { P, encode, decode } from "./protos.js";

const API_KEY = "AIzaSyB5y2y-Tzqb4-I4Qnlsh_9naYv_TD8pCvY";
const PROJECT_ID = "rust-companion-app";
const GCM_SENDER_ID = "976529667804";
const GMS_APP_ID = "1:976529667804:android:d6f1ddeb4403b338fea619";
const ANDROID_PACKAGE = "com.facepunch.rust.companion";
const ANDROID_CERT = "E28D05345FB78A7A1A63D70F4A302DBF426CA5AD";
const EXPO_PROJECT_ID = "49451aca-a822-41e6-ad59-955718d0ff9c";
const FIREBASE_CLIENT = "android-min-sdk/23 fire-core/20.0.0 device-name/a21snnxx device-brand/samsung device-model/a21s android-installer/com.android.vending fire-android/30 fire-installations/17.0.0 fire-fcm/22.0.0 android-platform/ kotlin/1.9.23 android-target-sdk/34";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mustOk(res, what) {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${what} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res;
}

// ---------------------------------------------------------- registration

function generateFid() {
  const buf = crypto.randomBytes(17);
  buf[0] = 0b01110000 | (buf[0] & 0b00001111);
  return buf.toString("base64").replace(/=+$/, "");
}

async function firebaseInstallation() {
  const res = await fetch(`https://firebaseinstallations.googleapis.com/v1/projects/${PROJECT_ID}/installations`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Android-Package": ANDROID_PACKAGE,
      "X-Android-Cert": ANDROID_CERT,
      "x-firebase-client": FIREBASE_CLIENT,
      "x-firebase-client-log-type": "3",
      "x-goog-api-key": API_KEY,
      "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 11; SM-A217F Build/RP1A.200720.012)",
    },
    body: JSON.stringify({ fid: generateFid(), appId: GMS_APP_ID, authVersion: "FIS_v2", sdkVersion: "a:17.0.0" }),
  });
  await mustOk(res, "Firebase installation");
  const json = await res.json();
  const token = json?.authToken?.token;
  if (!token) throw new Error("Firebase installation returned no auth token");
  return token;
}

/** Android check-in. With existing credentials it refreshes them; without, it creates a new virtual device. */
export async function checkin(existing) {
  const body = encode(P.AndroidCheckinRequest, {
    id: existing?.androidId,
    securityToken: existing?.securityToken,
    checkin: { type: 3, chromeBuild: { platform: 2, chromeVersion: "63.0.3234.0", channel: 1 } },
    version: 3,
    userSerialNumber: 0,
  });
  const res = await fetch("https://android.clients.google.com/checkin", {
    method: "POST",
    headers: { "Content-Type": "application/x-protobuf" },
    body,
  });
  await mustOk(res, "Android check-in");
  const out = decode(P.AndroidCheckinResponse, new Uint8Array(await res.arrayBuffer()));
  if (!out.androidId || out.androidId === "0") throw new Error("check-in returned no android id");
  return { androidId: out.androidId, securityToken: out.securityToken };
}

async function gcmRegister(androidId, securityToken, installToken) {
  const form = new URLSearchParams({
    device: androidId,
    app: ANDROID_PACKAGE,
    cert: ANDROID_CERT,
    app_ver: "1",
    "X-subtype": GCM_SENDER_ID,
    "X-app_ver": "1",
    "X-osv": "29",
    "X-cliv": "fiid-21.1.1",
    "X-gmsv": "220217001",
    "X-scope": "*",
    "X-Goog-Firebase-Installations-Auth": installToken,
    "X-gms_app_id": GMS_APP_ID,
    "X-Firebase-Client": FIREBASE_CLIENT,
    "X-Firebase-Client-Log-Type": "1",
    "X-app_ver_name": "1",
    target_ver: "31",
    sender: GCM_SENDER_ID,
  });
  let last = "";
  for (let i = 0; i < 5; i++) {
    const res = await fetch("https://android.clients.google.com/c2dm/register3", {
      method: "POST",
      headers: { Authorization: `AidLogin ${androidId}:${securityToken}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const text = await res.text();
    if (!text.includes("Error") && text.includes("=")) return text.split("=")[1].trim();
    last = text;
    await sleep(1000);
  }
  throw new Error(`FCM register failed: ${last}`);
}

/** Creates a brand-new set of push credentials. */
export async function register() {
  const installToken = await firebaseInstallation();
  const { androidId, securityToken } = await checkin();
  const fcmToken = await gcmRegister(androidId, securityToken, installToken);
  return { androidId, securityToken, fcmToken };
}

export async function expoPushToken(fcmToken) {
  const res = await fetch("https://exp.host/--/api/v2/push/getExpoPushToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "fcm",
      deviceId: crypto.randomUUID(),
      development: false,
      appId: ANDROID_PACKAGE,
      deviceToken: fcmToken,
      projectId: EXPO_PROJECT_ID,
    }),
  });
  await mustOk(res, "Expo push token");
  const json = await res.json();
  const token = json?.data?.data?.expoPushToken ?? json?.data?.expoPushToken;
  if (!token) throw new Error(`Expo returned no push token: ${JSON.stringify(json).slice(0, 200)}`);
  return token;
}

/** Links our Expo push token to the Steam account behind authToken. */
export async function facepunchRegister(authToken, expoToken) {
  const res = await fetch("https://companion-rust.facepunch.com:443/api/push/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ AuthToken: authToken, DeviceId: "recon-desktop", PushKind: 3, PushToken: expoToken }),
  });
  await mustOk(res, "Facepunch register");
}

// ------------------------------------------------------------- listening

const MCS_VERSION = 41;
const TAG = { HeartbeatPing: 0, HeartbeatAck: 1, LoginRequest: 2, LoginResponse: 3, Close: 4, DataMessage: 8 };

function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}
function frame(tag, body) {
  return Buffer.concat([Buffer.from([tag]), varint(body.length), Buffer.from(body)]);
}

/**
 * Keeps an MCS connection open forever (check-in, connect, reconnect with
 * backoff). Calls onPush(appDataMap) for every notification.
 */
export class PushListener {
  constructor(creds, { onPush, onStatus }) {
    this.creds = creds;
    this.onPush = onPush;
    this.onStatus = onStatus;
    this.pendingAcks = [];
    this.seen = new Set();
    this.stopped = false;
    this.backoff = 2000;
  }

  start() { this.#loop(); return this; }

  stop() {
    this.stopped = true;
    this.socket?.destroy();
    clearInterval(this.keepalive);
  }

  async #loop() {
    while (!this.stopped) {
      const started = Date.now();
      try {
        await checkin(this.creds);
        await this.#connectOnce();
      } catch (e) {
        if (!this.stopped) this.onStatus(`reconnecting: ${e.message}`);
      }
      if (this.stopped) return;
      if (Date.now() - started > 60000) this.backoff = 2000;
      if (this.seen.size > 5000) this.seen.clear();
      await sleep(this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60000);
    }
  }

  #connectOnce() {
    return new Promise((resolve, reject) => {
      const { androidId, securityToken } = this.creds;
      const socket = tls.connect({ host: "mtalk.google.com", port: 5228, servername: "mtalk.google.com" });
      this.socket = socket;
      socket.setKeepAlive(true);
      let buf = Buffer.alloc(0);
      let gotVersion = false;
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearInterval(this.keepalive);
        socket.destroy();
        err ? reject(err) : resolve();
      };

      socket.on("secureConnect", () => {
        const login = encode(P.LoginRequest, {
          id: "chrome-63.0.3234.0",
          domain: "mcs.android.com",
          user: androidId,
          resource: androidId,
          authToken: securityToken,
          deviceId: `android-${BigInt(androidId).toString(16)}`,
          setting: [{ name: "new_vc", value: "1" }],
          receivedPersistentId: this.pendingAcks,
          adaptiveHeartbeat: false,
          useRmq2: true,
          authService: 2,
          networkType: 1,
        });
        socket.write(Buffer.concat([Buffer.from([MCS_VERSION]), frame(TAG.LoginRequest, login)]));
        // Our own keep-alive so idle NATs/firewalls don't drop the socket.
        this.keepalive = setInterval(() => socket.write(frame(TAG.HeartbeatPing, encode(P.Heartbeat, {}))), 240000);
      });

      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        try {
          for (;;) {
            if (!gotVersion) {
              if (buf.length < 1) return;
              const v = buf[0];
              if (v < MCS_VERSION && v !== 38) throw new Error(`unsupported MCS version ${v}`);
              gotVersion = true;
              buf = buf.subarray(1);
              continue;
            }
            if (buf.length < 2) return;
            const tag = buf[0];
            let size = 0, shift = 0, i = 1, complete = false;
            while (i < buf.length && i < 6) {
              const b = buf[i++];
              size |= (b & 0x7f) << shift;
              shift += 7;
              if (!(b & 0x80)) { complete = true; break; }
            }
            if (!complete || buf.length < i + size) return;
            const body = buf.subarray(i, i + size);
            buf = buf.subarray(i + size);
            this.#handle(tag, body, socket);
          }
        } catch (e) {
          finish(e);
        }
      });

      socket.on("error", (e) => finish(e));
      socket.on("close", () => finish(new Error("connection closed")));
    });
  }

  #handle(tag, body, socket) {
    switch (tag) {
      case TAG.LoginResponse: {
        const res = decode(P.LoginResponse, body);
        if (res.error) throw new Error(`MCS login error ${res.error.code}: ${res.error.message ?? ""}`);
        this.pendingAcks = []; // server has acknowledged what we reported
        this.onStatus("connected");
        break;
      }
      case TAG.HeartbeatPing:
        socket.write(frame(TAG.HeartbeatAck, encode(P.Heartbeat, {})));
        break;
      case TAG.Close:
        throw new Error("MCS server closed the connection");
      case TAG.DataMessage: {
        const msg = decode(P.DataMessageStanza, body);
        const pid = msg.persistentId;
        if (pid) {
          if (this.seen.has(pid)) return;
          this.seen.add(pid);
          this.pendingAcks.push(pid);
        }
        const data = {};
        for (const d of msg.appData ?? []) if (d.key) data[d.key] = d.value ?? "";
        try { this.onPush(data); } catch (e) { console.error("push handler failed:", e); }
        break;
      }
      default:
        break; // IqStanza, HeartbeatAck etc. are not needed
    }
  }
}
