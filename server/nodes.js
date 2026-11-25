// Map grid helper (shared by the backend).

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
