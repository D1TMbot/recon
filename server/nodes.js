// Node logging for the heatmap.
//
// Two ways a node gets logged, both through Rust+ team chat so the whole team
// (and every Recon user in it) builds the same map:
//   1. In-game: a teammate types !stone, !metal or !sulfur in team chat. We log
//      a node at that player's current position.
//   2. From Recon: logging a node posts a coded message like
//      "[Recon] sulfur node @ K12 (1520,2210)", which other Recon users parse.

export const NODE_TYPES = ["stone", "metal", "sulfur"];

const COMMANDS = { stone: "stone", st: "stone", metal: "metal", mt: "metal", sulfur: "sulfur", sulf: "sulfur", sf: "sulfur" };
const CMD_RE = /^!([a-z]+)\b/i;
const CODED_RE = /^\[Recon\] (stone|metal|sulfur) node @ \S+ \((-?\d+),\s*(-?\d+)\)/;

/** @returns {{type:string, x?:number, y?:number} | null} */
export function parseNodeMessage(text) {
  const s = String(text ?? "").trim();
  const coded = s.match(CODED_RE);
  if (coded) return { type: coded[1], x: Number(coded[2]), y: Number(coded[3]) };
  const cmd = s.match(CMD_RE);
  if (cmd && COMMANDS[cmd[1].toLowerCase()]) return { type: COMMANDS[cmd[1].toLowerCase()] };
  return null;
}

const GRID = 146.3;
function colName(i) {
  let s = "";
  i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}
export function gridLabel(x, y, mapSize) {
  const n = Math.max(1, Math.floor(mapSize / GRID)), cs = mapSize / n;
  const c = Math.floor(x / cs), r = Math.floor((mapSize - y) / cs);
  if (c < 0 || r < 0 || c >= n || r >= n) return "Ocean";
  return `${colName(c)}${r}`;
}

export const codedMessage = (type, x, y, mapSize) =>
  `[Recon] ${type} node @ ${gridLabel(x, y, mapSize)} (${Math.round(x)},${Math.round(y)})`;

/** Add a node unless the same type was logged within 5 m in the last 20 s (echoes, double posts). */
export function addNode(list, node, max = 5000) {
  const dupe = list.some((n) => n.t === node.t && n.map === node.map && Math.abs(n.ts - node.ts) < 20000 && Math.hypot(n.x - node.x, n.y - node.y) < 5);
  if (dupe) return false;
  list.push(node);
  if (list.length > max) list.splice(0, list.length - max);
  return true;
}
