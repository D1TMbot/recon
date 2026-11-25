// Recon UI. Talks to the local Node backend: commands go to
// POST /api/<name>, live events arrive over the /events websocket.
async function invoke(cmd, args = {}) {
  const res = await fetch(`/api/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const j = await res.json();
  if (!j.ok) throw j.error;
  return j.result;
}

const eventHandlers = {};
function listen(event, cb) { (eventHandlers[event] ??= []).push(cb); }
(function connectEvents() {
  const ws = new WebSocket(`ws://${location.host}/events`);
  ws.onmessage = (m) => {
    const { event, payload } = JSON.parse(m.data);
    (eventHandlers[event] ?? []).forEach((cb) => cb({ payload }));
  };
  ws.onclose = () => setTimeout(connectEvents, 1500);
})();

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const S = {
  servers: [],
  active: null,        // server id we're viewing / connected to
  connected: false,
  info: null,
  map: null,           // { width, height, oceanMargin, monuments, img }
  team: null,
  markers: [],
  chat: [],
  layers: { grid: true, monuments: true, events: true, shops: true, nodes: true },
  view: { scale: 1, x: 0, y: 0 },
  timers: [],
  knownEvents: new Map(), // marker id -> type, for spawn alerts
  firstMarkers: true,
};

const MATE_COLORS = ["#3fd0ff", "#5ee0b5", "#a5b4fc", "#f2cf63", "#c084fc", "#7dd3fc", "#e879f9", "#bef264"];
const GRID = 146.3;

// --------------------------------------------------------------- toasts
function toast(title, body = "", kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b>${esc(body)}`;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ------------------------------------------------------------- servers
function renderServers() {
  const ul = $("#server-list");
  ul.innerHTML = "";
  $("#no-servers").hidden = S.servers.length > 0;
  for (const s of S.servers) {
    const li = document.createElement("li");
    if (s.id === S.active) li.classList.add("active");
    li.innerHTML = `
      ${s.img ? `<img src="${esc(s.img)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph'}))">` : `<div class="ph"></div>`}
      <div class="meta"><div class="nm">${esc(s.name)}</div><div class="sub">${esc(s.id)}</div></div>
      <button class="rm" title="Remove server">✕</button>`;
    li.onclick = () => { closeServerMenu(); if (s.id !== S.active || !S.connected) selectServer(s.id); };
    li.querySelector(".rm").onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove ${s.name}? You can pair it again any time.`)) return;
      await invoke("remove_server", { id: s.id });
      if (S.active === s.id) resetView();
      await refreshState();
    };
    ul.appendChild(li);
  }
}

function setConn(kind, text) {
  $("#conn-pill").className = `conn ${kind}`;
  $("#conn-text").textContent = text;
}

function resetView() {
  stopTimers();
  S.active = null; S.connected = false; S.info = null; S.map = null; S.team = null; S.markers = []; S.chat = [];
  window.Nodes?.reset();
  window.Pins?.reset();
  window.Events?.reset();
  window.Stash?.reset();
  $("#srv-name").textContent = "No server selected";
  $("#srv-stats").innerHTML = "";
  $("#srv-mini").textContent = "";
  setConn("", "Offline");
  renderAll();
}

function stopTimers() {
  S.timers.forEach(clearInterval);
  S.timers = [];
}

async function selectServer(id, { reconnect = false } = {}) {
  stopTimers();
  const keep = reconnect && S.active === id && S.map; // reconnecting: keep what's on screen
  S.active = id; S.connected = false;
  if (!keep) { S.map = null; S.team = null; S.markers = []; S.chat = []; S.knownEvents.clear(); S.firstMarkers = true; }
  const srv = S.servers.find((s) => s.id === id);
  $("#srv-name").textContent = srv?.name ?? id;
  $("#srv-stats").innerHTML = "";
  renderServers(); renderAll();
  setConn("busy", "Connecting…");
  $("#map-empty").textContent = `Connecting to ${srv?.name ?? "server"}…`;
  try {
    S.info = await invoke("connect_server", { id });
    S.connected = true;
    setConn("ok", "Connected");
    renderStats();
    reconnectTries = 0;
    await Promise.allSettled([keep ? Promise.resolve() : loadMap(), loadTeam(), loadMarkers(), loadChat()]);
    window.Nodes?.load();
    window.Pins?.onConnect();
    window.Events?.onConnect();
    window.Stash?.refresh();
    S.timers.push(setInterval(loadTeam, 4000));
    S.timers.push(setInterval(loadMarkers, 8000));
    S.timers.push(setInterval(async () => { try { S.info = await invoke("get_info"); renderStats(); } catch {} }, 60000));
    loadDevices();
  } catch (e) {
    setConn("bad", "Failed");
    if (keep) { // lost connection earlier: keep trying quietly
      const wait = Math.min(60, 5 * 2 ** reconnectTries++);
      setConn("bad", `Couldn't reconnect. Trying again in ${wait}s…`);
      setTimeout(() => { if (S.active === id && !S.connected) selectServer(id, { reconnect: true }); }, wait * 1000);
      return;
    }
    toast("Couldn't connect", String(e), "bad");
    $("#map-empty").innerHTML = `<div style="text-align:center"><p>Couldn't connect to ${esc(srv?.name ?? id)}.</p><p class="muted small">${esc(String(e))}</p><button class="btn" id="cta-retry">Try again</button></div>`;
    $("#cta-retry").onclick = () => selectServer(id);
  }
}

function renderStats() {
  const i = S.info;
  if (!i) return;
  const days = Math.max(0, (Date.now() / 1000 - i.wipeTime) / 86400);
  $("#srv-name").textContent = i.name;
  $("#srv-mini").textContent = `${i.players}/${i.maxPlayers}`;
  window.Pins?.renderPill();
  $("#srv-stats").innerHTML = `
    <span>Players<b>${i.players}/${i.maxPlayers}</b>${i.queuedPlayers ? ` (+${i.queuedPlayers} queue)` : ""}</span>
    <span>Map<b>${esc(i.map)} · ${i.mapSize}</b></span>
    <span>Wiped<b>${days < 1 ? Math.round(days * 24) + "h" : days.toFixed(1) + "d"} ago</b></span>
    ${i.seed ? `<span>Seed<b>${i.seed}</b></span>` : ""}`;
}

// -------------------------------------------------------------- loaders
async function loadMap() {
  const m = await invoke("get_map");
  const img = new Image();
  img.src = `data:image/jpeg;base64,${m.jpgBase64}`;
  await img.decode();
  S.map = { ...m, img };
  delete S.map.jpgBase64;
  fitMap();
}

async function loadTeam() {
  try { S.team = await invoke("get_team"); renderTeam(); draw(); } catch (e) { handleRequestError(e); }
}

async function loadMarkers() {
  try {
    const res = await invoke("get_markers");
    S.markers = res.markers;
    detectEvents();
    window.Vending?.update();
    window.Events?.update();
    draw();
  } catch (e) { handleRequestError(e); }
}

async function loadChat() {
  try { S.chat = (await invoke("get_team_chat")).messages; renderChat(); } catch {}
}

function handleRequestError(e) {
  const msg = String(e);
  if (msg.includes("Not connected")) return;
  if (msg.includes("not in a team")) return; // solo players: no team panel
  console.warn(msg);
}

// ------------------------------------------------------------- events
const EVENT_NAMES = { 4: "Chinook (CH47)", 5: "Cargo Ship", 6: "Locked crate", 8: "Patrol Helicopter" };
function detectEvents() {
  const now = new Map();
  for (const m of S.markers) if (EVENT_NAMES[m.type]) now.set(m.id, m.type);
  if (!S.firstMarkers) {
    for (const [id, type] of now) {
      if (!S.knownEvents.has(id)) {
        const m = S.markers.find((x) => x.id === id);
        toast(`${EVENT_NAMES[type]} spawned`, `at ${gridLabel(m.x, m.y)}`);
      }
    }
    for (const [id, type] of S.knownEvents) {
      if (!now.has(id) && type !== 6) toast(`${EVENT_NAMES[type]} left`, "");
    }
  }
  S.knownEvents = now;
  S.firstMarkers = false;
}

// ---------------------------------------------------------- coordinates
function mapSize() { return S.info?.mapSize ?? 4000; }
function worldToImg(x, y) {
  const { width: W, height: H, oceanMargin: m } = S.map;
  const ms = mapSize();
  return [ (x / ms) * (W - 2 * m) + m, H - ((y / ms) * (H - 2 * m) + m) ];
}
function imgToWorld(px, py) {
  const { width: W, height: H, oceanMargin: m } = S.map;
  const ms = mapSize();
  return [ ((px - m) / (W - 2 * m)) * ms, ((H - py - m) / (H - 2 * m)) * ms ];
}
function colName(i) {
  let s = "";
  i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}
function gridCells() { return Math.max(1, Math.floor(mapSize() / GRID)); }
function gridLabel(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "—";
  const n = gridCells(), cs = mapSize() / n;
  const c = Math.floor(x / cs), r = Math.floor((mapSize() - y) / cs);
  if (c < 0 || r < 0 || c >= n || r >= n) return "Ocean";
  return `${colName(c)}${r}`;
}

// ------------------------------------------------------------------ map
const canvas = $("#map-canvas");
const ctx = canvas.getContext("2d");

let fittedAtSize = 0;
function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  // if the map was fitted while the window had no real size (opened minimized
  // or hidden), fit it again now that it does
  if (S.map && r.width > 200 && fittedAtSize < 200) fitMap();
  draw();
}
new ResizeObserver(resizeCanvas).observe(canvas);

// The map image (which already includes the ocean out to the edge of the
// world) always fills the window: you can't zoom out past it or drag it away.
function minScale() {
  const r = canvas.getBoundingClientRect();
  return Math.max(r.width / S.map.width, r.height / S.map.height);
}
function clampView() {
  if (!S.map) return;
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const v = S.view;
  v.scale = Math.min(8, Math.max(minScale(), v.scale));
  const w = S.map.width * v.scale, h = S.map.height * v.scale;
  v.x = Math.min(0, Math.max(r.width - w, v.x));
  v.y = Math.min(0, Math.max(r.height - h, v.y));
}
function fitMap() {
  if (!S.map) return;
  const r = canvas.getBoundingClientRect();
  fittedAtSize = r.width;
  const s = minScale();
  S.view = { scale: s, x: (r.width - S.map.width * s) / 2, y: (r.height - S.map.height * s) / 2 };
  draw();
}

function zoomAt(factor, cx, cy) {
  const v = S.view;
  const ns = Math.min(8, Math.max(0.1, v.scale * factor));
  const f = ns / v.scale;
  v.x = cx - (cx - v.x) * f;
  v.y = cy - (cy - v.y) * f;
  v.scale = ns;
  draw();
}

function centerOn(wx, wy, scale) {
  if (!S.map) return;
  const r = canvas.getBoundingClientRect();
  const [px, py] = worldToImg(wx, wy);
  if (scale) S.view.scale = scale;
  S.view.x = r.width / 2 - px * S.view.scale;
  S.view.y = r.height / 2 - py * S.view.scale;
  draw();
}

const MONUMENT_NAMES = {
  airfield_display_name: "Airfield", bandit_camp: "Bandit Camp", dome_monument_name: "The Dome",
  excavator: "Giant Excavator", fishing_village_display_name: "Fishing Village", gas_station: "Oxum's Gas Station",
  harbor_display_name: "Harbor", harbor_2_display_name: "Harbor", junkyard_display_name: "Junkyard",
  large_fishing_village_display_name: "Large Fishing Village", large_oil_rig: "Large Oil Rig",
  launchsite: "Launch Site", lighthouse_display_name: "Lighthouse", military_tunnels_display_name: "Military Tunnels",
  mining_outpost_display_name: "Mining Outpost", mining_quarry_hqm_display_name: "HQM Quarry",
  mining_quarry_stone_display_name: "Stone Quarry", mining_quarry_sulfur_display_name: "Sulfur Quarry",
  oil_rig_small: "Oil Rig", outpost: "Outpost", power_plant_display_name: "Power Plant",
  satellite_dish_display_name: "Satellite Dish", sewer_display_name: "Sewer Branch",
  stables_a: "Ranch", stables_b: "Large Barn", supermarket: "Abandoned Supermarket",
  swamp_c: "Abandoned Cabins", train_yard_display_name: "Train Yard", water_treatment_plant_display_name: "Water Treatment",
  underwater_lab: "Underwater Lab", AbandonedMilitaryBase: "Abandoned Military Base", arctic_base_a: "Arctic Research Base",
  missile_silo_monument: "Missile Silo", ferryterminal: "Ferry Terminal",
  radtown: "Radtown", jungle_ziggurat: "Jungle Ziggurat", apartmentcomplex: "Apartment Complex",
  arctic_base_b: "Arctic Research Base", jungle_swamp_a: "Jungle Ruins", desert_military_base_a: "Desert Military Base",
  nuclear_missile_silo: "Missile Silo", OilrigAI: "Oil Rig", OilrigAI2: "Large Oil Rig",
};
function monumentName(token) {
  if (MONUMENT_NAMES[token]) return MONUMENT_NAMES[token];
  return token.replace(/_display_name|_monument_name|_name$/g, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Map rendering. The map image (and the node heatmap) are drawn in image space;
// everything on top (grid labels, monuments, events, players) is drawn in
// screen space so it stays crisp and the same size at any zoom.
const BIG_MONUMENTS = /launch|airfield|power_plant|train_yard|water_treatment|military_tunnel|outpost|bandit|swamp_c|harbor|dome|satellite|oil_rig|excavator|silo|arctic|ferry|AbandonedMilitary|radtown|ziggurat|apartment|junkyard|underwater_lab/;
let labelBoxes = [];

function toScreen(wx, wy) {
  const [ix, iy] = worldToImg(wx, wy);
  return [ix * S.view.scale + S.view.x, iy * S.view.scale + S.view.y];
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $("#map-empty").hidden = !!S.map;
  if (!S.map) return;
  clampView(); // covers zoom, drag, pinch and "jump to" alike
  const v = S.view;

  // --- image space
  ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.x, dpr * v.y);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(S.map.img, 0, 0);
  window.drawNodes?.(ctx, 1 / v.scale);

  // --- screen space
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  labelBoxes = [];
  if (S.layers.grid) drawGrid();

  // reserve space for players first so other labels avoid them
  const mates = (S.team?.members ?? []).filter((m) => Number.isFinite(m.x) && Number.isFinite(m.y)); // offline players may have no position
  const reserveIcon = (x, y, r) => labelBoxes.push({ x: x - r, y: y - r, w: r * 2, h: r * 2 });
  const mateLabels = mates.map((m, i) => {
    const [x, y] = toScreen(m.x, m.y);
    reserveIcon(x, y, 12);
    return { m, i, x, y, box: reserveLabel(m.name, x, y - 22, 12, true) };
  });
  const events = S.layers.events ? S.markers.filter((mk) => EVENT_ICONS[mk.type]).map((mk) => {
    const [x, y] = toScreen(mk.x, mk.y);
    reserveIcon(x, y, 16);
    return { mk, x, y, box: reserveLabel(EVENT_ICONS[mk.type].name, x, y + 26, 10.5, true) };
  }) : [];

  if (S.layers.events) for (const mk of S.markers) if (mk.type === 7) drawEventZone(mk);
  window.drawPins?.(); // markers before monument names, so their labels win
  if (S.layers.monuments) drawMonuments();
  for (const mk of S.markers) if (mk.type === 3 && (S.layers.shops || S.shopMatch?.has(mk.id))) drawShop(mk);
  for (const e of events) drawEvent(e);
  for (const n of S.team?.mapNotes ?? []) drawPin(...toScreen(n.x, n.y));
  window.drawTrails?.();
  window.drawRoute?.();
  window.drawDeaths?.();
  for (const p of mateLabels) drawMate(p);
}

// ------------------------------------------------------------------ labels
function measure(text, size, bold) {
  ctx.font = `${bold ? 600 : 500} ${size}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
  return ctx.measureText(text).width;
}
function overlaps(b) {
  return labelBoxes.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
}
/** Reserve a label box centred on (x, y); returns it, or null if it would overlap (unless force). */
function reserveLabel(text, x, y, size, force) {
  const w = measure(text, size, true) + 12, h = size + 8;
  const b = { x: x - w / 2, y: y - h / 2, w, h, text, size };
  if (!force && overlaps(b)) return null;
  labelBoxes.push(b);
  return b;
}
function pill(b, color, bg = "rgba(8,12,19,.78)") {
  if (!b) return;
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, b.h / 2); ctx.fill();
  ctx.font = `600 ${b.size}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(b.text, b.x + b.w / 2, b.y + b.h / 2 + 0.5);
}

// -------------------------------------------------------------------- grid
function drawGrid() {
  const n = gridCells(), cs = mapSize() / n;
  const cellPx = (S.map.width - 2 * S.map.oceanMargin) / n * S.view.scale;
  const [x0, y0] = toScreen(0, mapSize()), [x1, y1] = toScreen(mapSize(), 0);
  ctx.strokeStyle = "rgba(10,16,24,.22)"; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + (x1 - x0) * (i / n)) + 0.5, y = Math.round(y0 + (y1 - y0) * (i / n)) + 0.5;
    ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.moveTo(x0, y); ctx.lineTo(x1, y);
  }
  ctx.stroke();

  // column letters / row numbers along the map edge, kept on screen
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const top = Math.min(Math.max(y0 + 10, 70), y1 - 10), left = Math.min(Math.max(x0 + 12, 88), x1 - 12);
  const every = cellPx < 16 ? 4 : cellPx < 26 ? 2 : 1;
  ctx.font = `600 10px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let c = 0; c < n; c += every) {
    const x = x0 + (c + 0.5) * cellPx;
    if (x < left + 10 || x > W - 10) continue;
    edgeTag(colName(c), x, top);
  }
  for (let r = 0; r < n; r += every) {
    const y = y0 + (r + 0.5) * cellPx;
    if (y < top + 12 || y > H - 10) continue;
    edgeTag(String(r), left, y);
  }
  // full cell labels only once zoomed in
  if (cellPx > 70) {
    ctx.font = `500 10px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 3;
    for (let c = 0; c < n; c++) for (let r = 0; r < n; r++) {
      const x = x0 + c * cellPx, y = y0 + r * cellPx;
      if (x > W || y > H || x + cellPx < 0 || y + cellPx < 0) continue;
      ctx.fillText(`${colName(c)}${r}`, x + 4, y + 3);
    }
    ctx.shadowBlur = 0;
  }
}
function edgeTag(text, x, y) {
  const w = Math.max(16, ctx.measureText(text).width + 8);
  ctx.fillStyle = "rgba(8,12,19,.62)";
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - 8, w, 16, 5); ctx.fill();
  ctx.fillStyle = "rgba(220,232,245,.8)";
  ctx.fillText(text, x, y + 0.5);
}

// --------------------------------------------------------------- monuments
const HIDDEN_MONUMENTS = /train_tunnel|DungeonBase|^Monument$/;
function drawMonuments() {
  const list = S.map.monuments
    .filter((m) => !HIDDEN_MONUMENTS.test(m.token))
    .map((m) => ({ m, big: BIG_MONUMENTS.test(m.token), xy: toScreen(m.x, m.y) }))
    .sort((a, b) => b.big - a.big);
  // every monument gets a small marker; labels are added where they fit (big ones first)
  for (const { xy: [x, y], big } of list) {
    ctx.fillStyle = "rgba(8,12,19,.75)"; ctx.beginPath(); ctx.arc(x, y, big ? 4.5 : 3.5, 0, 7); ctx.fill();
    ctx.fillStyle = big ? "#e6f1fb" : "#b8c6d8"; ctx.beginPath(); ctx.arc(x, y, big ? 2.5 : 2, 0, 7); ctx.fill();
  }
  // small screens: only the big monuments get names until you zoom in
  const cramped = canvas.clientWidth <= 720 && S.view.scale * (S.map.width / gridCells()) < 34;
  for (const { m, big, xy: [x, y] } of list) {
    if (cramped && !big) continue;
    const text = monumentName(m.token), size = big ? 11.5 : 10.5;
    const w = measure(text, size, true) + 12;
    // try above, below, right, left, the diagonals, then a bit further out
    const spots = [[x, y - 13], [x, y + 13], [x + w / 2 + 7, y], [x - w / 2 - 7, y],
      [x + w / 2 + 4, y - 13], [x - w / 2 - 4, y - 13], [x + w / 2 + 4, y + 13], [x - w / 2 - 4, y + 13], [x, y - 28], [x, y + 28]];
    let b = null;
    for (const [lx, ly] of spots) if ((b = reserveLabel(text, lx, ly, size))) break;
    if (!b) continue;
    pill(b, big ? "rgba(236,243,250,.95)" : "rgba(210,222,235,.88)", "rgba(8,12,19,.66)");
  }
}

// ------------------------------------------------------------------ events
const EVENT_ICONS = {
  2: { color: "#f2cf63", name: "Explosion", draw: (s) => { star(0, 0, 8 * s, 4 * s, 8); ctx.fill(); } },
  4: { color: "#a5b4fc", name: "Chinook", draw: (s) => {
    ctx.beginPath(); ctx.roundRect(-7 * s, -2.5 * s, 14 * s, 5 * s, 2.5 * s); ctx.fill();
    ctx.lineWidth = 1.6 * s; ctx.beginPath(); ctx.arc(-6 * s, 0, 4.5 * s, 0, 7); ctx.moveTo(10.5 * s, 0); ctx.arc(6 * s, 0, 4.5 * s, 0, 7); ctx.stroke();
  } },
  5: { color: "#3fd0ff", name: "Cargo Ship", draw: (s) => {
    ctx.beginPath(); ctx.moveTo(-9 * s, -1 * s); ctx.lineTo(9 * s, -1 * s); ctx.lineTo(6 * s, 4.5 * s); ctx.lineTo(-7 * s, 4.5 * s); ctx.closePath(); ctx.fill();
    ctx.fillRect(-6 * s, -5 * s, 4 * s, 4 * s); ctx.fillRect(-1 * s, -4 * s, 4 * s, 3 * s); ctx.fillRect(4 * s, -6 * s, 2.5 * s, 5 * s);
  } },
  6: { color: "#5ee0b5", name: "Locked Crate", draw: (s) => {
    ctx.beginPath(); ctx.roundRect(-7 * s, -5 * s, 14 * s, 10 * s, 1.5 * s); ctx.fill();
    ctx.fillStyle = "#0b1119"; ctx.fillRect(-7 * s, -1.6 * s, 14 * s, 1.4 * s); ctx.fillRect(-1.5 * s, -1.6 * s, 3 * s, 4 * s);
  } },
  8: { color: "#e879f9", name: "Patrol Heli", draw: (s) => {
    ctx.beginPath(); ctx.ellipse(-1.5 * s, 1.5 * s, 5 * s, 3.5 * s, 0, 0, 7); ctx.fill();
    ctx.fillRect(2 * s, 0.6 * s, 8 * s, 1.8 * s);
    ctx.lineWidth = 1.6 * s; ctx.beginPath(); ctx.moveTo(-9 * s, -3.5 * s); ctx.lineTo(7 * s, -3.5 * s); ctx.moveTo(-1.5 * s, -3.5 * s); ctx.lineTo(-1.5 * s, -1 * s); ctx.stroke();
  } },
};
function star(cx, cy, ro, ri, n) {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) { const r = i % 2 ? ri : ro, a = (i * Math.PI) / n - Math.PI / 2; ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
  ctx.closePath();
}
function badge(x, y, r, ring) {
  ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.arc(x, y + 1.5, r + 1, 0, 7); ctx.fill();
  ctx.fillStyle = "#0d1520"; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  ctx.strokeStyle = ring; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r - 1, 0, 7); ctx.stroke();
}
function drawEvent({ mk, x, y, box }) {
  const ev = EVENT_ICONS[mk.type];
  badge(x, y, 15, ev.color);
  ctx.save(); ctx.translate(x, y); ctx.fillStyle = ev.color; ctx.strokeStyle = ev.color; ev.draw(1); ctx.restore();
  pill(box, ev.color);
}
function drawEventZone(mk) {
  if (!mk.radius) return;
  const c = mk.color1 ?? {}, [x, y] = toScreen(mk.x, mk.y);
  const r = (mk.radius / mapSize()) * (S.map.width - 2 * S.map.oceanMargin) * S.view.scale;
  const rgb = `${Math.round((c.x ?? 1) * 255)},${Math.round((c.y ?? 0) * 255)},${Math.round((c.z ?? 0) * 255)}`;
  ctx.fillStyle = `rgba(${rgb},${(mk.alpha ?? 0.3) * 0.45})`; ctx.strokeStyle = `rgba(${rgb},.7)`; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.stroke();
}
function drawShop(mk) {
  const [x, y] = toScreen(mk.x, mk.y), col = mk.outOfStock ? "#5b6779" : "#5ee0b5";
  if (S.shopMatch && !S.shopMatch.has(mk.id)) { ctx.fillStyle = "rgba(91,103,121,.55)"; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill(); return; }
  if (S.shopMatch || S.shopFocus === mk.id) {
    if (S.shopFocus === mk.id) { ctx.strokeStyle = "rgba(63,208,255,.5)"; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(x, y, 18, 0, 7); ctx.stroke(); }
    badge(x, y, 11, S.shopFocus === mk.id ? "#3fd0ff" : col);
    ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(x - 4, y - 4, 8, 8, 2); ctx.fill();
    return;
  }
  ctx.fillStyle = "#0d1520"; ctx.beginPath(); ctx.roundRect(x - 6, y - 6, 12, 12, 3.5); ctx.fill();
  ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(x - 3.5, y - 3.5, 7, 7, 2); ctx.fill();
}
function drawPin(x, y) {
  ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.beginPath(); ctx.ellipse(x, y + 1, 4, 1.8, 0, 0, 7); ctx.fill();
  ctx.fillStyle = "#3fd0ff";
  ctx.beginPath(); ctx.moveTo(x, y); ctx.bezierCurveTo(x - 3, y - 7, x - 8, y - 10, x - 8, y - 16); ctx.arc(x, y - 16, 8, Math.PI, 0); ctx.bezierCurveTo(x + 8, y - 10, x + 3, y - 7, x, y); ctx.fill();
  ctx.fillStyle = "#0b1119"; ctx.beginPath(); ctx.arc(x, y - 16, 3, 0, 7); ctx.fill();
}

// ----------------------------------------------------------------- players
function drawMate({ m, i, x, y, box }) {
  const color = MATE_COLORS[i % MATE_COLORS.length];
  ctx.globalAlpha = m.isOnline || !m.isAlive ? 1 : 0.5;
  if (m.steamId === S.selfSteamId && m.isAlive) {
    ctx.fillStyle = color + "33"; ctx.beginPath(); ctx.arc(x, y, 17, 0, 7); ctx.fill();
  }
  ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.beginPath(); ctx.arc(x, y + 1.5, 11, 0, 7); ctx.fill();
  ctx.fillStyle = m.isAlive ? color : "#2a3442";
  ctx.beginPath(); ctx.arc(x, y, 10, 0, 7); ctx.fill();
  ctx.strokeStyle = m.isAlive ? "#e6f1fb" : "#e879f9"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 10, 0, 7); ctx.stroke();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  if (m.isAlive) {
    ctx.font = `700 10px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
    ctx.fillStyle = "#06101a"; ctx.fillText((m.name || "?").trim().charAt(0).toUpperCase(), x, y + 0.5);
  } else {
    ctx.strokeStyle = "#e879f9"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
  }
  pill(box, m.isAlive ? (m.isOnline ? color : "#9aa7b8") : "#e879f9");
  ctx.globalAlpha = 1;
}

// pan / zoom / hover
let drag = null;
canvas.addEventListener("mousedown", (e) => { drag = { x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y }; canvas.classList.add("dragging"); });
window.addEventListener("mouseup", () => { drag = null; canvas.classList.remove("dragging"); });
window.addEventListener("mousemove", (e) => {
  if (drag) {
    S.view.x = drag.vx + e.clientX - drag.x;
    S.view.y = drag.vy + e.clientY - drag.y;
    draw();
  }
});
canvas.addEventListener("mousemove", (e) => {
  if (!S.map) return;
  const r = canvas.getBoundingClientRect();
  const ix = (e.clientX - r.left - S.view.x) / S.view.scale, iy = (e.clientY - r.top - S.view.y) / S.view.scale;
  const [wx, wy] = imgToWorld(ix, iy);
  $("#map-hover").textContent = `${gridLabel(wx, wy)}  ·  ${Math.round(wx)}, ${Math.round(wy)}`;
});
canvas.addEventListener("mouseleave", () => ($("#map-hover").textContent = ""));
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
$("#zoom-in").onclick = () => { const r = canvas.getBoundingClientRect(); zoomAt(1.3, r.width / 2, r.height / 2); };
$("#zoom-out").onclick = () => { const r = canvas.getBoundingClientRect(); zoomAt(1 / 1.3, r.width / 2, r.height / 2); };
$("#zoom-fit").onclick = fitMap;
document.querySelectorAll("[data-layer]").forEach((cb) => {
  cb.onchange = () => { S.layers[cb.dataset.layer] = cb.checked; draw(); };
});

// ------------------------------------------------------------------ team
function since(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function renderTeam() {
  const t = S.team;
  const side = $("#map-team");
  const grid = $("#team-grid");
  if (!t || !t.members.length) { side.innerHTML = ""; grid.innerHTML = `<p class="muted">No team info (are you in a team?).</p>`; return; }
  side.innerHTML = `<h3>Team · ${t.members.filter((m) => m.isOnline).length}/${t.members.length} online</h3>` +
    t.members.map((m, i) => `
      <div class="mate ${m.isOnline ? "" : "off"} ${m.isAlive ? "" : "dead"}" data-i="${i}">
        <span class="sw" style="background:${MATE_COLORS[i % MATE_COLORS.length]}"></span>
        <span class="nm">${esc(m.name)}</span>
        <span class="gr">${gridLabel(m.x, m.y)}</span>
      </div>`).join("");
  side.querySelectorAll(".mate").forEach((el) => {
    el.onclick = () => { const m = t.members[+el.dataset.i]; centerOn(m.x, m.y, Math.max(S.view.scale, 1.2)); };
  });

  grid.innerHTML = t.members.map((m, i) => `
    <div class="card">
      <h3><span class="mate"><span class="sw" style="background:${MATE_COLORS[i % MATE_COLORS.length]}"></span></span>${esc(m.name)}
        ${m.steamId === t.leaderSteamId ? `<span class="tag lead">Leader</span>` : ""}</h3>
      <div class="row"><span>Status</span><b>${m.isOnline ? `<span class="tag ok">Online</span>` : `<span class="tag">Offline</span>`} ${m.isAlive ? "" : `<span class="tag bad">Dead</span>`}</b></div>
      <div class="row"><span>Grid</span><b>${gridLabel(m.x, m.y)}</b></div>
      <div class="row"><span>${m.isAlive ? "Alive for" : "Dead for"}</span><b>${m.isAlive ? since(m.spawnTime) : since(m.deathTime)}</b></div>
    </div>`).join("");
}

// ------------------------------------------------------------------ chat
function renderChat() {
  const log = $("#chat-log");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.innerHTML = S.chat.map((m) => {
    const t = new Date(m.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `<div class="msg"><span class="t">${t}</span><span class="n" style="color:${esc(m.color)}">${esc(m.name)}</span>${esc(m.message)}</div>`;
  }).join("");
  if (atBottom) log.scrollTop = log.scrollHeight;
}
$("#chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const input = $("#chat-text");
  const text = input.value.trim();
  if (!text) return;
  try { await invoke("send_team_message", { message: text }); input.value = ""; }
  catch (err) { toast("Message not sent", String(err), "bad"); }
};

// --------------------------------------------------------------- devices
const ENTITY_TYPES = { 1: "Smart Switch", 2: "Smart Alarm", 3: "Storage Monitor" };
async function loadDevices() {
  const srv = S.servers.find((s) => s.id === S.active);
  const grid = $("#device-grid");
  const ents = srv?.entities ?? [];
  if (!ents.length) { grid.innerHTML = `<p class="muted">No paired devices on this server yet.</p>`; return; }
  grid.innerHTML = ents.map((e) => `
    <div class="card" id="dev-${e.entityId}">
      <h3>${esc(e.name || ENTITY_TYPES[e.entityType] || "Device")}</h3>
      <div class="row"><span>${ENTITY_TYPES[e.entityType] ?? "Unknown"}</span><b class="state">…</b></div>
    </div>`).join("");
  for (const e of ents) {
    try {
      const info = await invoke("get_entity_info", { entityId: e.entityId });
      renderDevice(e.entityId, info.type, info.payload);
    } catch (err) {
      const el = document.querySelector(`#dev-${e.entityId} .state`);
      if (el) el.textContent = String(err).includes("Not found") ? "Destroyed / not found" : "Unavailable";
    }
  }
}

function renderDevice(id, type, p) {
  const card = document.getElementById(`dev-${id}`);
  if (!card) return;
  const st = card.querySelector(".state");
  if (type === 1) {
    st.innerHTML = `<label class="switch"><input type="checkbox" ${p.value ? "checked" : ""}><span></span></label>`;
    st.querySelector("input").onchange = async (ev) => {
      try { await invoke("set_entity_value", { entityId: id, value: ev.target.checked }); }
      catch (err) { ev.target.checked = !ev.target.checked; toast("Switch failed", String(err), "bad"); }
    };
  } else if (type === 2) {
    st.innerHTML = p.value ? `<span class="tag bad">TRIGGERED</span>` : `<span class="tag ok">Quiet</span>`;
  } else if (type === 3) {
    const left = (p.protectionExpiry ?? 0) - Date.now() / 1000;
    if (p.hasProtection && left > 0) {
      st.innerHTML = `<span class="tag ok">Upkeep ${since(Date.now() / 1000 - left)} left</span>`;
    } else if (p.protectionExpiry !== undefined && p.protectionExpiry !== null && p.capacity === 24) {
      st.innerHTML = `<span class="tag bad">Decaying</span>`;
    } else {
      st.textContent = p.capacity ? `${p.items.length}/${p.capacity} slots` : "";
    }
  }
}

// ---------------------------------------------------------------- pairing
function pairStep(step, msg) {
  const order = ["creds", "login", "listen"];
  const idx = order.indexOf(step);
  document.querySelectorAll("#pair-steps li").forEach((li, i) => {
    li.className = i < idx ? "done" : i === idx ? "active" : "";
  });
  if (msg) $("#pair-msg").textContent = msg;
}

async function openPairing(forceLogin = false) {
  $("#pair-modal").hidden = false;
  $("#pair-relogin").hidden = true;
  pairStep("creds", "Registering for push notifications…");
  try {
    const r = await invoke("start_pairing", { forceLogin });
    if (r === "login") {
      pairStep("login", "A sign-in window opened. Read Facepunch's notice, press Login with Steam and sign in. It closes by itself when done.");
    } else {
      pairStep("listen", "Waiting for you to press “Pair with server” in-game…");
      $("#pair-relogin").hidden = false;
    }
  } catch (e) {
    $("#pair-msg").textContent = `Setup failed: ${e}`;
  }
}
$("#btn-pair").onclick = () => openPairing(false);
$("#btn-pair-2").onclick = () => { closeServerMenu(); openPairing(false); };
$("#pair-relogin").onclick = () => openPairing(true);
$("#pair-close").onclick = () => ($("#pair-modal").hidden = true);
$("#btn-signout").onclick = async () => {
  if (!confirm("Unlink Steam? You'll need to sign in again to pair new servers.")) return;
  await invoke("sign_out");
  await refreshState();
};

// ----------------------------------------------------------- tabs, state
const PANEL_TITLES = { team: "Team and chat", devices: "Smart devices", raid: "Raid planner", nodes: "Node heatmap", shops: "Vending search", craft: "Craft and recycle", alerts: "Alerts and settings", players: "Server population" };
function openPanel(name) {
  const show = name && name !== "map" && PANEL_TITLES[name];
  document.querySelectorAll("#dock [data-panel]").forEach((x) => x.classList.toggle("active", x.dataset.panel === (show ? name : "map")));
  $("#panel").hidden = !show;
  if (!show) return;
  $("#panel").classList.toggle("wide", name === "raid");
  $("#panel-title").textContent = PANEL_TITLES[name];
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  if (name === "devices" && S.connected) { loadDevices(); window.Automations?.load(); }
  if (name === "players") window.Population?.load();
  if (name === "raid" || name === "craft") window.Stash?.refresh();
  if (name === "alerts") window.PhoneSettings?.load();
  if (name === "shops") { window.Vending?.render(); setTimeout(() => $("#shop-q").focus(), 50); }
  if (name === "team") { const log = $("#chat-log"); log.scrollTop = log.scrollHeight; }
}
document.querySelectorAll("#dock [data-panel]").forEach((b) => {
  b.onclick = () => openPanel(b.classList.contains("active") ? "map" : b.dataset.panel);
});
$("#panel-close").onclick = () => openPanel("map");

// server switcher dropdown
function closeServerMenu() { $("#srv-menu").hidden = true; $("#srv-pill").classList.remove("open"); }
$("#srv-pill").onclick = (e) => {
  e.stopPropagation();
  const open = $("#srv-menu").hidden;
  $("#srv-menu").hidden = !open;
  $("#srv-pill").classList.toggle("open", open);
};
$("#srv-menu").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", closeServerMenu);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeServerMenu(); openPanel("map"); } });

function renderAll() { renderServers(); renderTeam(); renderChat(); draw(); }

async function refreshState() {
  const st = await invoke("get_state");
  S.servers = st.servers;
  S.selfSteamId = st.steamId;
  $("#account-line").textContent = st.loggedIn ? `Steam linked${st.steamId ? ` · ${st.steamId}` : ""}` : "Steam: not linked";
  $("#btn-signout").hidden = !st.loggedIn;
  if (!st.loggedIn) { $("#push-status").textContent = "Not signed in"; $("#push-status").className = "small muted"; }
  renderServers();
  return st;
}

// ---------------------------------------------------------- backend events
listen("push-status", ({ payload }) => {
  const el = $("#push-status");
  el.textContent = payload === "connected" ? "Listening for pairing" : payload;
  el.className = payload === "connected" ? "small ok" : "small muted";
});
listen("login-status", ({ payload }) => {
  if (payload.ok) { pairStep("listen", "Signed in. Now in Rust press ESC → Rust+ → “Pair with server”."); refreshState(); }
  else $("#pair-msg").textContent = `Sign-in failed: ${payload.error}`;
});
listen("server-paired", async ({ payload }) => {
  toast("Server paired", payload.name, "ok");
  $("#pair-modal").hidden = true;
  await refreshState();
  selectServer(payload.id);
});
listen("entity-paired", async ({ payload }) => {
  toast("Device paired", `${payload.entity.name} (${ENTITY_TYPES[payload.entity.entityType] ?? "device"})`, "ok");
  await refreshState();
  if (payload.serverId === S.active) loadDevices();
});
listen("pair-error", ({ payload }) => { toast("Pairing problem", payload.message, "bad"); $("#pair-msg").textContent = payload.message; });
listen("alarm", ({ payload }) => toast(payload.title || "Smart Alarm", payload.message, "bad"));
listen("notification", ({ payload }) => payload.title && toast(payload.title, payload.message));
listen("rp-team", ({ payload }) => { S.team = payload; renderTeam(); draw(); });
listen("rp-team-message", ({ payload }) => { S.chat.push(payload); renderChat(); });
listen("rp-entity-changed", async ({ payload }) => {
  const srv = S.servers.find((s) => s.id === S.active);
  const ent = srv?.entities.find((e) => String(e.entityId) === String(payload.entityId));
  if (!ent) return;
  renderDevice(ent.entityId, ent.entityType, payload.payload);
  if (ent.entityType === 2 && payload.payload.value) toast(`${ent.name} triggered!`, "", "bad");
});
let reconnectTries = 0;
listen("rp-disconnected", ({ payload }) => {
  if (payload !== S.active) return;
  S.connected = false;
  stopTimers();
  const wait = Math.min(60, 5 * 2 ** reconnectTries++); // 5s, 10s, 20s, 40s, 60s…
  setConn("bad", `Connection lost. Reconnecting in ${wait}s…`);
  setTimeout(() => { if (S.active === payload && !S.connected) selectServer(payload, { reconnect: true }); }, wait * 1000);
});

// ------------------------------------------------------------------ boot
(async () => {
  if (!new URLSearchParams(location.search).has("demo")) {
    try { await invoke("get_settings"); }
    catch (e) { if (String(e).includes("phone_login_required")) { window.showPhoneLogin?.(); return; } }
  }
  if (new URLSearchParams(location.search).has("demo")) {
    const s = document.createElement("script");
    s.src = "demo.js";
    document.body.appendChild(s);
    return;
  }
  const st = await refreshState();
  if (!st.servers.length) {
    $("#map-empty").innerHTML = `<div style="text-align:center"><p>No servers paired yet.</p><button class="btn primary" id="cta-pair">Pair your first server</button></div>`;
    $("#cta-pair").onclick = () => openPairing(false);
  } else if (st.lastServer && st.servers.some((s) => s.id === st.lastServer)) selectServer(st.lastServer);
})();
