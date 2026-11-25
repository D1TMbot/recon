// Node heatmap: where stone / metal / sulfur nodes are likely to spawn on this
// map, predicted from the terrain in the map image. Rust+ doesn't share node
// positions (and nodes respawn in random spots), so everything here is an
// estimate: heatmaps per type plus an "All ores" view, and when zoomed in,
// faded icons showing likely spots in the mix the terrain suggests.
(() => {
  const TYPES = [
    { id: "stone", name: "Stone", color: "#c4b5fd", lo: [124, 58, 237], hi: [233, 226, 255] },
    { id: "metal", name: "Metal", color: "#60a5fa", lo: [37, 99, 235], hi: [165, 243, 252] },
    { id: "sulfur", name: "Sulfur", color: "#facc15", lo: [202, 138, 4], hi: [254, 249, 195] },
    { id: "all", name: "All ores", color: "#5eead4", lo: [13, 148, 136], hi: [204, 251, 241] },
  ];
  const ORES = TYPES.slice(0, 3);
  const TY = Object.fromEntries(TYPES.map((t) => [t.id, t]));
  const TIDX = { stone: 0, metal: 1, sulfur: 2, all: 3 };
  const KEY = "recon.nodes.view2";
  const view = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
  const N = {
    on: view.on || { stone: false, metal: false, sulfur: false, all: false },
    icons: view.icons ?? true,
    heat: null, // cached { key, canvas }
  };
  const saveView = () => localStorage.setItem(KEY, JSON.stringify({ on: N.on, icons: N.icons }));
  const anyOn = () => TYPES.some((t) => N.on[t.id]);

  // ---------------------------------------------------- terrain prediction
  // Biome from the map colour (snow, desert, grass, forest, rock), mountains
  // from the hill shading, and no nodes on water, beaches or monuments.
  const PW = 420; // analysis resolution (pixels across the map image)
  //               stone metal sulfur
  const BIOME_W = [
    null,                 // 0 water / off-map
    [0.45, 0.30, 0.12],   // 1 grass
    [0.40, 0.25, 0.10],   // 2 forest
    [0.50, 0.45, 0.95],   // 3 desert
    [0.45, 0.85, 0.90],   // 4 snow / arctic
    [1.00, 1.00, 0.85],   // 5 rock / mountain
    null,                 // 6 beach
  ];
  const RUGGED_K = [1.3, 1.6, 1.2]; // how much cliffs / mountains boost each type
  let pred = null; // { img, W, H, raw: [Float32Array x3], maps: [Float32Array x4] }

  function boxBlur(src, W, H, r, passes) {
    let a = src, b = new Float32Array(a.length);
    for (let p = 0; p < passes; p++) {
      for (let y = 0; y < H; y++) { // horizontal
        let s = 0; const row = y * W;
        for (let x = -r; x <= r; x++) s += a[row + Math.min(W - 1, Math.max(0, x))];
        for (let x = 0; x < W; x++) {
          b[row + x] = s / (2 * r + 1);
          s += a[row + Math.min(W - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
        }
      }
      for (let x = 0; x < W; x++) { // vertical
        let s = 0;
        for (let y = -r; y <= r; y++) s += b[Math.min(H - 1, Math.max(0, y)) * W + x];
        for (let y = 0; y < H; y++) {
          a[y * W + x] = s / (2 * r + 1);
          s += b[Math.min(H - 1, y + r + 1) * W + x] - b[Math.max(0, y - r) * W + x];
        }
      }
    }
    return a;
  }
  // relative scale: an average spot on this map = 0, the best ~2% = 1
  function relative(src) {
    const d = Float32Array.from(src);
    const sorted = Array.from(d).filter((v) => v > 0.02).sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] || 0;
    const lo = at(0.55), hi = Math.max(lo + 1e-6, at(0.985));
    for (let i = 0; i < d.length; i++) { const v = Math.min(1, Math.max(0, (d[i] - lo) / (hi - lo))); d[i] = Math.pow(v, 1.4); }
    return d;
  }

  function predict() {
    if (!S.map) return null;
    if (pred?.img === S.map.img) return pred;
    const W = PW, H = Math.round((PW * S.map.height) / S.map.width), n = W * H;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(S.map.img, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data;

    // 1) classify every pixel by colour
    const cls = new Uint8Array(n), lum = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = px[i * 4], gg = px[i * 4 + 1], b = px[i * 4 + 2];
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), l = (r + gg + b) / 3, sat = mx ? (mx - mn) / mx : 0;
      lum[i] = l;
      let k;
      if (b > r + 10 && b >= gg - 14) k = 0;                 // water
      else if (l > 190 && sat < 0.16) k = 4;                // snow
      else if (sat < 0.12) k = 5;                           // rock, gravel
      else if (gg >= r - 6 && gg > b) k = l < 92 ? 2 : 1;   // forest / grass
      else if (r > b) k = 3;                                // sand / desert
      else k = 5;
      cls[i] = k;
    }
    // sand right next to water is beach (few nodes)
    const water = new Float32Array(n);
    for (let i = 0; i < n; i++) water[i] = cls[i] === 0 ? 1 : 0;
    const nearWater = boxBlur(water, W, H, 3, 1);
    for (let i = 0; i < n; i++) if (cls[i] === 3 && nearWater[i] > 0.12) cls[i] = 6;

    // 2) ruggedness from the hill shading (brightness changes a lot on slopes)
    const grad = new Float32Array(n);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, k = cls[i];
      // only shading inside one biome counts; a biome border (e.g. snow line) is not a slope
      if (!k || cls[i + 1] !== k || cls[i - 1] !== k || cls[i + W] !== k || cls[i - W] !== k) continue;
      grad[i] = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + W] - lum[i - W]);
    }
    const rug = boxBlur(grad, W, H, 4, 2);
    let rmax = 0; for (let i = 0; i < n; i++) if (cls[i] && rug[i] > rmax) rmax = rug[i];
    for (let i = 0; i < n; i++) rug[i] = rmax ? Math.min(1, rug[i] / (rmax * 0.6)) : 0;

    // 3) no nodes in or right around monuments
    const blocked = new Uint8Array(n);
    const sx = W / S.map.width, pxPerM = ((S.map.width - 2 * S.map.oceanMargin) / mapSize()) * sx;
    for (const m of S.map.monuments) {
      if (/train_tunnel|DungeonBase/.test(m.token)) continue;
      const [ix, iy] = worldToImg(m.x, m.y);
      const cx = ix * sx, cy = iy * sx, rr = (/oil_rig|underwater/.test(m.token) ? 0 : 95) * pxPerM;
      for (let y = Math.max(0, Math.floor(cy - rr)); y <= Math.min(H - 1, cy + rr); y++)
        for (let x = Math.max(0, Math.floor(cx - rr)); x <= Math.min(W - 1, cx + rr); x++)
          if ((x - cx) ** 2 + (y - cy) ** 2 <= rr * rr) blocked[y * W + x] = 1;
    }

    // 4) raw density per type (for the icons) and relative maps (for the heatmaps)
    const raw = [0, 1, 2].map((t) => {
      const d = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const w = BIOME_W[cls[i]];
        if (!w || blocked[i]) continue;
        d[i] = w[t] * (0.55 + RUGGED_K[t] * rug[i]);
      }
      return boxBlur(d, W, H, 3, 2);
    });
    const total = new Float32Array(n);
    for (let i = 0; i < n; i++) total[i] = raw[0][i] + raw[1][i] + raw[2][i];
    const maps = [...raw.map(relative), relative(total)];
    pred = { img: S.map.img, W, H, raw, total, maps, icons: null };
    return pred;
  }

  // ------------------------------------------------- predicted node icons
  // A fixed (per map) scatter of likely node spots: more of them where the
  // terrain is richer, each one stone/metal/sulfur in the mix the terrain
  // suggests. Seeded, so they don't jump around between loads.
  function predictedIcons() {
    const p = predict();
    if (!p) return [];
    if (p.icons) return p.icons;
    const { W, H, raw, total } = p, sx = W / S.map.width;
    let seed = 0; for (const ch of `${S.info?.seed ?? 0}:${mapSize()}`) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const STEP = 34; // metres between candidate spots
    const cand = [];
    for (let wy = STEP / 2; wy < mapSize(); wy += STEP) for (let wx = STEP / 2; wx < mapSize(); wx += STEP) {
      const x = wx + (rand() - 0.5) * STEP * 0.9, y = wy + (rand() - 0.5) * STEP * 0.9;
      const [ix, iy] = worldToImg(x, y), px = Math.round(ix * sx), py = Math.round(iy * sx);
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const i = py * W + px, s = total[i];
      if (s <= 0.05) continue;
      cand.push({ x, y, i, w: s * s * s, r: rand(), t: rand() }); // cubed: nodes bunch up in the rich areas
    }
    const target = Math.round((mapSize() / 1000) ** 2 * 165); // roughly Rust's ore node count for a map this size
    const sumW = cand.reduce((a, c) => a + c.w, 0) || 1, k = target / sumW;
    const out = [];
    for (const c of cand) {
      if (c.r > Math.min(0.95, c.w * k)) continue;
      // pick the type in proportion to the local mix (sharpened a little)
      const ws = [0, 1, 2].map((t) => raw[t][c.i] ** 1.6), sw = ws[0] + ws[1] + ws[2];
      let acc = 0, type = 0;
      for (let t = 0; t < 3; t++) { acc += ws[t] / sw; if (c.t <= acc) { type = t; break; } type = t; }
      out.push({ x: c.x, y: c.y, type: ORES[type].id });
    }
    p.icons = out;
    return out;
  }
  function drawIcons(ctx, px) {
    const pxPerM = ((S.map.width - 2 * S.map.oceanMargin) / mapSize()) * S.view.scale;
    if (pxPerM * 34 < 9) return; // only once zoomed in enough that they don't blur together
    const show = N.on.all ? ORES.map((t) => t.id) : ORES.filter((t) => N.on[t.id]).map((t) => t.id);
    ctx.globalAlpha = 0.78;
    for (const ic of predictedIcons()) {
      if (!show.includes(ic.type)) continue;
      const [x, y] = worldToImg(ic.x, ic.y), r = Math.min(7.5, 3.4 + pxPerM * 1.3) * px; // grow a bit as you zoom in
      ctx.fillStyle = TY[ic.type].color; ctx.strokeStyle = "rgba(8,12,19,.85)"; ctx.lineWidth = 1.3 * px;
      ctx.beginPath(); // small rock shape
      ctx.moveTo(x - r, y + r * 0.55); ctx.lineTo(x - r * 0.75, y - r * 0.5); ctx.lineTo(x - r * 0.1, y - r);
      ctx.lineTo(x + r * 0.8, y - r * 0.55); ctx.lineTo(x + r, y + r * 0.4); ctx.lineTo(x + r * 0.2, y + r * 0.85); ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------- best areas + routes
  function findPeaks(type, max = 14, minV = 0.55, spacing = 260) {
    const p = predict();
    if (!p) return [];
    const d = p.maps[TIDX[type]], { W, H } = p, sx = W / S.map.width;
    const peaks = [];
    for (let y = 3; y < H - 3; y += 2) for (let x = 3; x < W - 3; x += 2) {
      const v = d[y * W + x];
      if (v < minV) continue;
      let top = true;
      for (let dy = -4; dy <= 4 && top; dy++) for (let dx = -4; dx <= 4; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < H && xx >= 0 && xx < W && d[yy * W + xx] > v) { top = false; break; }
      }
      if (!top) continue;
      const [wx, wy] = imgToWorld(x / sx, y / sx);
      const rawMap = type === "all" ? p.total : p.raw[TIDX[type]];
      peaks.push({ x: wx, y: wy, v, rv: rawMap[y * W + x] }); // rv: uncapped richness, for ranking
    }
    peaks.sort((a, b) => b.rv - a.rv);
    const picked = [];
    for (const pk of peaks) { if (picked.every((q) => Math.hypot(q.x - pk.x, q.y - pk.y) > spacing)) picked.push(pk); if (picked.length >= max) break; }
    return picked;
  }

  let route = null; // { type, start, stops: [{x, y, v}], km }
  function planRoute(type) {
    const base = window.Pins?.base();
    if (base) return planBaseRoute(type, base);
    const picked = findPeaks(type);
    if (!picked.length) return null;
    const me = (S.team?.members ?? []).find((m) => m.steamId === S.selfSteamId && Number.isFinite(m.x)) ?? (S.team?.members ?? []).find((m) => Number.isFinite(m.x));
    const start = me ? { x: me.x, y: me.y } : { x: mapSize() / 2, y: mapSize() / 2 };
    // greedy: next stop = close by and rich, up to 6 stops
    const stops = []; let cur = start, km = 0;
    const left = [...picked];
    while (left.length && stops.length < 6) {
      let bi = 0, best = Infinity;
      left.forEach((pk, i) => { const cost = Math.hypot(pk.x - cur.x, pk.y - cur.y) / (0.4 + pk.v); if (cost < best) { best = cost; bi = i; } });
      const nx = left.splice(bi, 1)[0];
      km += Math.hypot(nx.x - cur.x, nx.y - cur.y) / 1000;
      stops.push(nx); cur = nx;
    }
    return { type, start, stops, km };
  }
  // With a base set: the best spots within about 1 km of it, as a loop that
  // ends back at the base (widens the search if the area around it is poor).
  function planBaseRoute(type, base) {
    const all = findPeaks(type, 200, 0.06, 130); // include smaller local hotspots, not just the map's best
    let near = [];
    for (const R of [600, 850, 1100]) {
      near = all.map((pk) => ({ ...pk, d: Math.hypot(pk.x - base.x, pk.y - base.y) })).filter((pk) => pk.d >= 50 && pk.d <= R);
      if (near.length >= 3) break;
    }
    if (!near.length) return null;
    // rich and close beats rich and far
    near.forEach((pk) => (pk.score = pk.rv / (1 + (pk.d / 350) ** 2)));
    near.sort((a, b) => b.score - a.score);
    const chosen = near.slice(0, 5);
    // go around the base in a circle so the path doesn't cross itself, starting with the nearest
    chosen.forEach((pk) => (pk.a = Math.atan2(pk.y - base.y, pk.x - base.x)));
    chosen.sort((a, b) => a.a - b.a);
    const first = chosen.reduce((m, pk, i) => (pk.d < chosen[m].d ? i : m), 0);
    const stops = [...chosen.slice(first), ...chosen.slice(0, first)];
    let km = 0, cur = base;
    for (const pk of stops) { km += Math.hypot(pk.x - cur.x, pk.y - cur.y) / 1000; cur = pk; }
    km += Math.hypot(cur.x - base.x, cur.y - base.y) / 1000;
    return { type, start: { x: base.x, y: base.y }, stops, km, loop: true };
  }
  function toggleRoute(type) {
    if (route && route.type === type) { route = null; render(); draw(); return; }
    route = planRoute(type);
    if (!route) { toast("No route yet", "The map is still loading, or there are no strong spots for this type."); return; }
    if (!N.on[type]) toggleType(type);
    toast(`${TY[type].name} route planned`, route.loop
      ? `${route.stops.length} stops near your base and back, about ${route.km.toFixed(1)} km.`
      : `${route.stops.length} stops, about ${route.km.toFixed(1)} km. Tip: set your base and routes will stay near it.`, "ok");
    render(); draw();
  }
  window.drawRoute = () => {
    if (!route || !S.map) return;
    const col = TY[route.type].color;
    const pts = [route.start, ...route.stops, ...(route.loop ? [route.start] : [])].map((p) => toScreen(p.x, p.y));
    ctx.setLineDash([7, 6]); ctx.lineWidth = 3; ctx.strokeStyle = "rgba(8,12,19,.7)";
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = col;
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
    ctx.setLineDash([]);
    route.stops.forEach((p, i) => {
      const [x, y] = toScreen(p.x, p.y);
      ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.beginPath(); ctx.arc(x, y + 1.5, 11, 0, 7); ctx.fill();
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 10, 0, 7); ctx.fill();
      ctx.font = "700 11px Segoe UI"; ctx.fillStyle = "#06101a"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), x, y + 0.5);
      labelBoxes.push({ x: x - 11, y: y - 11, w: 22, h: 22 });
    });
  };

  // ------------------------------------------------------------ heatmap
  function heatCanvas() {
    const p = predict();
    if (!p) return null;
    const key = `${S.map.width}|${JSON.stringify(N.on)}`;
    if (N.heat?.key === key) return N.heat.canvas;
    const { W, H } = p;
    const out = document.createElement("canvas"); out.width = W; out.height = H;
    const octx = out.getContext("2d");
    const smooth = (e0, e1, v) => { const q = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return q * q * (3 - 2 * q); };
    // "All ores" replaces the single-type layers when it's on
    const layers = N.on.all ? [TY.all] : ORES.filter((t) => N.on[t.id]);
    for (const t of layers) {
      const d = p.maps[TIDX[t.id]];
      const img = octx.createImageData(W, H), o = img.data;
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        if (v < 0.08) continue;
        o[i * 4] = t.lo[0] + (t.hi[0] - t.lo[0]) * v;
        o[i * 4 + 1] = t.lo[1] + (t.hi[1] - t.lo[1]) * v;
        o[i * 4 + 2] = t.lo[2] + (t.hi[2] - t.lo[2]) * v;
        o[i * 4 + 3] = 55 + 175 * smooth(0.08, 0.85, v); // light tint for "better than average", bright for the best
      }
      const layer = document.createElement("canvas"); layer.width = W; layer.height = H;
      layer.getContext("2d").putImageData(img, 0, 0);
      octx.drawImage(layer, 0, 0);
    }
    N.heat = { key, canvas: out };
    return out;
  }

  // called from app.js draw(), in image coordinates; px = one screen pixel
  window.drawNodes = (ctx, px) => {
    if (!S.layers.nodes || !S.map || !anyOn()) return;
    const hc = heatCanvas();
    if (hc) {
      // zoomed in, the heatmap fades back so the terrain and node spots show through
      const pxPerM = ((S.map.width - 2 * S.map.oceanMargin) / mapSize()) * S.view.scale;
      ctx.globalAlpha = N.icons ? Math.max(0.22, Math.min(1, 1.45 - pxPerM * 0.65)) : 1;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(hc, 0, 0, S.map.width, S.map.height);
      ctx.globalAlpha = 1;
    }
    if (N.icons) drawIcons(ctx, px);
  };

  // ------------------------------------------------- right-click: markers
  const menu = document.createElement("div");
  menu.className = "ctx-menu float"; menu.hidden = true;
  document.body.appendChild(menu);
  const closeMenu = () => (menu.hidden = true);
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!S.map || !window.Pins) return;
    const r = canvas.getBoundingClientRect();
    const [wx, wy] = imgToWorld((e.clientX - r.left - S.view.x) / S.view.scale, (e.clientY - r.top - S.view.y) / S.view.scale);
    menu.innerHTML = `<div class="ctx-head">Add marker at ${gridLabel(wx, wy)}</div>` +
      Object.entries(Pins.kinds).map(([k, v]) => `<button data-pin="${k}"><i style="background:${v.color}"></i>${v.name}</button>`).join("") +
      (Pins.near(wx, wy) ? `<div class="ctx-sep"></div><button data-unpin class="danger">Remove marker</button>` : "");
    menu.style.left = `${Math.min(e.clientX, innerWidth - 200)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - 220)}px`;
    menu.hidden = false;
    menu.onclick = (ev) => {
      const b = ev.target.closest("button"); if (!b) return;
      if (b.dataset.pin) Pins.add(b.dataset.pin, wx, wy);
      if ("unpin" in b.dataset) { const p = Pins.near(wx, wy); if (p) Pins.remove(p); }
      closeMenu();
    };
  });

  // ------------------------------------------------------------- panel
  function toggleType(type) {
    const turningOn = !(N.on[type] && S.layers.nodes);
    if (type === "all" && turningOn) for (const t of ORES) N.on[t.id] = false; // All ores = one combined view
    if (type !== "all" && turningOn) N.on.all = false;
    N.on[type] = turningOn;
    if (turningOn && !S.layers.nodes) { S.layers.nodes = true; document.querySelector('[data-layer="nodes"]').checked = true; }
    saveView(); N.heat = null; render(); draw();
  }
  const routeType = () => TYPES.find((x) => N.on[x.id])?.id ?? "all"; // the shown view, else all ores

  function render() {
    // floating toggles on the map's right edge
    $("#node-quick").innerHTML = `<div class="nq-title">Node heatmap</div>` + TYPES.map((t) => `
      <button data-type="${t.id}" class="${N.on[t.id] && S.layers.nodes ? "on" : ""}" style="--c:${t.color}" title="Where ${t.id === "all" ? "nodes of any kind" : t.name.toLowerCase() + " nodes"} likely spawn (predicted from the terrain)">
        <i></i><span>${t.name}</span><b></b>
      </button>`).join("") +
      `<div class="nq-sep"></div><button class="nq-route ${route ? "on" : ""}" data-route title="Plan a farming route through the best spots">${route ? "Clear route" : "Plan route"}</button>`;

    $("#node-types").innerHTML = TYPES.map((t) => `
      <button data-type="${t.id}" class="${N.on[t.id] ? "on" : ""}" style="--c:${t.color}">
        <i></i><span>${t.name}</span>
      </button>`).join("");
    $("#node-icons").checked = N.icons;
    const base = window.Pins?.base();
    $("#node-base").innerHTML = base
      ? `Base at <b>${gridLabel(base.x, base.y)}</b>. Routes stay near it and end back there.`
      : `No base set. Routes start from where you are.`;
    $("#node-setbase").textContent = base ? "Move my base" : "Set my base";
    $("#node-route").textContent = route ? "Clear route" : `Plan a ${TY[routeType()].name.toLowerCase()} route`;

    // best areas for the shown view
    const t = routeType(), peaks = S.map ? findPeaks(t, 6) : [];
    const top = peaks[0]?.rv || 1;
    $("#node-hot").innerHTML = peaks.length ? peaks.map((pk, i) => `
      <button class="hot-row" data-x="${pk.x}" data-y="${pk.y}" title="Jump there on the map">
        <b>${gridLabel(pk.x, pk.y)}</b>
        <span class="hot-bar"><span style="width:${Math.round((pk.rv / top) * 100)}%;background:${TY[t].color}"></span></span>
        <span class="hot-n"><em style="color:${TY[t].color}">#${i + 1}</em></span>
      </button>`).join("") : `<div class="muted small">Connect to a server to see its best areas.</div>`;
  }

  $("#node-types").onclick = (e) => { const b = e.target.closest("[data-type]"); if (b) toggleType(b.dataset.type); };
  $("#node-quick").onclick = (e) => {
    if (e.target.closest("[data-route]")) { if (route) { route = null; render(); draw(); return; } return toggleRoute(routeType()); }
    const b = e.target.closest("[data-type]"); if (b) toggleType(b.dataset.type);
  };
  $("#node-icons").onchange = (e) => { N.icons = e.target.checked; saveView(); draw(); };
  // "Set my base": the next click on the map places (or moves) the base marker
  let pickingBase = false;
  $("#node-setbase").onclick = () => {
    if (!S.map || !window.Pins) return toast("Map not loaded yet", "Connect to a server first.");
    pickingBase = true;
    canvas.classList.add("picking");
    openPanel("map");
    toast("Click your base on the map", "Press Esc to cancel.");
  };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pickingBase) { pickingBase = false; canvas.classList.remove("picking"); } });
  let downAt = null;
  canvas.addEventListener("mousedown", (e) => { downAt = [e.clientX, e.clientY]; });
  canvas.addEventListener("mouseup", async (e) => {
    if (!pickingBase || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return; // a drag isn't a pick
    pickingBase = false; canvas.classList.remove("picking");
    const r = canvas.getBoundingClientRect();
    const [wx, wy] = imgToWorld((e.clientX - r.left - S.view.x) / S.view.scale, (e.clientY - r.top - S.view.y) / S.view.scale);
    const old = Pins.base();
    if (old) await Pins.remove(old);
    await Pins.add("base", wx, wy, "Our base");
    route = null; render(); draw();
    toast("Base set", `At ${gridLabel(wx, wy)}. Routes will now stay near it.`, "ok");
  });
  $("#node-route").onclick = () => { if (route) { route = null; render(); draw(); } else toggleRoute(routeType()); };
  $("#node-hot").onclick = (e) => { const b = e.target.closest(".hot-row"); if (b) centerOn(+b.dataset.x, +b.dataset.y, Math.max(S.view.scale, 1.8)); };
  // keep the quick bar in sync when the "Nodes" layer chip is switched
  document.querySelector('[data-layer="nodes"]').addEventListener("change", () => setTimeout(render));

  window.Nodes = {
    load() { N.heat = null; render(); }, // predictions are computed from the map when needed
    set() {},
    reset: () => { route = null; pred = null; N.heat = null; render(); },
    planRoute: toggleRoute,
    render,
  };
  render();
})();
