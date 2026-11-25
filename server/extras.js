// Extras: phone alerts (ntfy), shared map pins (base markers), and helpers
// for the upkeep tracker.

import crypto from "node:crypto";
import { gridLabel } from "./nodes.js";

// ------------------------------------------------------------ phone alerts
// ntfy (https://ntfy.sh) is a free push service: the phone app subscribes to a
// topic name, and anyone who knows the name can publish to it. Recon makes a
// long random topic so it can't be guessed.
export const newTopic = () => "recon-" + crypto.randomBytes(9).toString("hex");

/** Send a push to the user's phone. priority: 5 urgent (alarm), 4 high, 3 default. */
export async function phonePush(settings, { title, message, priority = 5, tags = ["rotating_light"] }) {
  if (!settings?.ntfyEnabled || !settings.ntfyTopic) return false;
  const res = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: settings.ntfyTopic, title, message, priority, tags }),
  });
  if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
  return true;
}

// ---------------------------------------------------------------- map pins
// Shared through Rust+ team chat so teammates using Recon get them too:
//   [Recon] pin enemy @ K12 (1520,2210) big compound
//   [Recon] unpin (1520,2210)
export const PIN_KINDS = ["base", "enemy", "loot", "note"];
const PIN_RE = /^\[Recon\] pin (base|enemy|loot|note) @ \S+ \((-?\d+),\s*(-?\d+)\)\s*(.*)$/;
const UNPIN_RE = /^\[Recon\] unpin \((-?\d+),\s*(-?\d+)\)/;

export function parsePinMessage(text) {
  const s = String(text ?? "").trim();
  let m = s.match(PIN_RE);
  if (m) return { op: "add", kind: m[1], x: Number(m[2]), y: Number(m[3]), label: m[4].trim().slice(0, 40) };
  m = s.match(UNPIN_RE);
  if (m) return { op: "remove", x: Number(m[1]), y: Number(m[2]) };
  return null;
}

export function pinMessage(pin, mapSize) {
  const head = `[Recon] pin ${pin.kind} @ ${gridLabel(pin.x, pin.y, mapSize)} (${Math.round(pin.x)},${Math.round(pin.y)})`;
  return `${head} ${pin.label ?? ""}`.trim().slice(0, 128);
}
export const unpinMessage = (pin) => `[Recon] unpin (${Math.round(pin.x)},${Math.round(pin.y)})`;

/** Add or replace a pin at (about) the same spot. Returns true if something changed. */
export function upsertPin(list, pin) {
  const i = list.findIndex((p) => p.map === pin.map && Math.hypot(p.x - pin.x, p.y - pin.y) < 3);
  if (i >= 0) {
    if (list[i].kind === pin.kind && list[i].label === pin.label) return false;
    list[i] = { ...list[i], kind: pin.kind, label: pin.label };
    return true;
  }
  list.push(pin);
  if (list.length > 300) list.splice(0, list.length - 300);
  return true;
}
export function removePinAt(list, map, x, y) {
  const before = list.length;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].map === map && Math.hypot(list[i].x - x, list[i].y - y) < 3) list.splice(i, 1);
  return list.length !== before;
}

// ------------------------------------------------------------------ upkeep
/** Seconds of upkeep left from a Storage Monitor payload, or null if it isn't on a tool cupboard. */
export function upkeepLeft(payload, now = Date.now() / 1000) {
  if (!payload) return null;
  const exp = Number(payload.protectionExpiry);
  if (!exp) return payload.hasProtection === false && payload.capacity === 24 ? 0 : null;
  return Math.max(0, exp - now);
}
