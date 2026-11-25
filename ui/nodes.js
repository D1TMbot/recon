// Node heatmap: where stone / metal / sulfur nodes are likely to spawn on this
// map, predicted from the terrain in the map image, plus any finds your team
// logs (in-game "!sulfur" etc., Recon logs, right-clicking the map).
(() => {
  const TYPES = [
    { id: "stone", name: "Stone", color: "#c4b5fd", lo: [124, 58, 237], hi: [233, 226, 255] },
    { id: "metal", name: "Metal", color: "#60a5fa", lo: [37, 99, 235], hi: [165, 243, 252] },
    { id: "sulfur", name: "Sulfur", color: "#facc15", lo: [202, 138, 4], hi: [254, 249, 195] },
  ];
  const TY = Object.fromEntries(TYPES.map((t) => [t.id, t]));
  const KEY = "recon.nodes.view";
  const view = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
  const N = {
    nodes: [],
    on: view.on || { stone: false, metal: false, sulfur: false },
    mode: view.mode || "heat",
    heat: null, // cached { key, canvas }
  };
  const saveView = () => localStorage.setItem(KEY, JSON.stringify({ on: N.on, mode: N.mode }));
  const fmtAgo = (ts) => { const s = (Date.now() - ts) / 1000; return s < 60 ? "now" : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };

  function setNodes(list) { N.nodes = list || []; N.heat = null; render(); draw(); }

  // ---------------------------------------------------- terrain prediction
  // Rust+ doesn't share where nodes spawn, so Recon estimates it from the map
  // image itself: the biome from its colour (snow, desert, grass, forest, rock),
  // mountains from the hill shading, and no nodes on water, beaches or
  // monuments. Logged finds are added on top and count for a lot more.
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
  const TIDX = { stone: 0, metal: 1, sulfur: 2 };
  let pred = null; // { img, W, H, maps: [Float32Array x3] }

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

    // 4) per-type density, smoothed and normalised so the top areas glow
    const maps = [0, 1, 2].map((t) => {
      const d = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const w = BIOME_W[cls[i]];
        if (!w || blocked[i]) continue;
        d[i] = w[t] * (0.55 + RUGGED_K[t] * rug[i]);
      }
      boxBlur(d, W, H, 3, 2);
      // relative scale: an average spot on this map = 0, the best ~2% = 1,
      // so the heatmap shows where it's notably better rather than everywhere
      const sorted = Array.from(d).filter((v) => v > 0.02).sort((a, b) => a - b);
      const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] || 0;
      const lo = at(0.55), hi = Math.max(lo + 1e-6, at(0.985));
      for (let i = 0; i < n; i++) { const v = Math.min(1, Math.max(0, (d[i] - lo) / (hi - lo))); d[i] = Math.pow(v, 1.4); }
      return d;
    });
    pred = { img: S.map.img, W, H, maps };
    return pred;
  }

  // ------------------------------------------------------------ farm route
  let route = null; // { type, start, stops: [{x, y, v}], km }
  function planRoute(type) {
    const p = predict();
    if (!p) return null;
    const d = p.maps[TIDX[type]], { W, H } = p, sx = W / S.map.width;
    // local maxima of the predicted map
    const peaks = [];
    for (let y = 3; y < H - 3; y += 2) for (let x = 3; x < W - 3; x += 2) {
      const v = d[y * W + x];
      if (v < 0.55) continue;
      let top = true;
      for (let dy = -4; dy <= 4 && top; dy++) for (let dx = -4; dx <= 4; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < H && xx >= 0 && xx < W && d[yy * W + xx] > v) { top = false; break; }
      }
      if (!top) continue;
      const [wx, wy] = imgToWorld(x / sx, y / sx);
      peaks.push({ x: wx, y: wy, v });
    }
    peaks.sort((a, b) => b.v - a.v);
    const picked = [];
    for (const pk of peaks) { if (picked.every((q) => Math.hypot(q.x - pk.x, q.y - pk.y) > 260)) picked.push(pk); if (picked.length >= 14) break; }
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
  function toggleRoute(type) {
    if (route && route.type === type) { route = null; renderQuick(); draw(); return; }
    route = planRoute(type);
    if (!route) { toast("No route yet", "The map is still loading, or there are no strong spots for this type."); return; }
    if (!N.on[type]) toggleType(type);
    toast(`${TY[type].name} route planned`, `${route.stops.length} stops, about ${route.km.toFixed(1)} km. Follow the numbers on the map.`, "ok");
    renderQuick(); draw();
  }
  window.drawRoute = () => {
    if (!route || !S.map) return;
    const col = TY[route.type].color;
    const pts = [route.start, ...route.stops].map((p) => toScreen(p.x, p.y));
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
  const RADIUS_M = 70; // how far one logged find spreads
  function heatCanvas() {
    const p = predict();
    if (!p) return null;
    const key = `${S.map.width}|${N.nodes.length}|${N.nodes.at(-1)?.ts}|${JSON.stringify(N.on)}`;
    if (N.heat?.key === key) return N.heat.canvas;
    const { W, H } = p, sx = W / S.map.width;
    const out = document.createElement("canvas"); out.width = W; out.height = H;
    const octx = out.getContext("2d");
    const r = Math.max(2, RADIUS_M * ((S.map.width - 2 * S.map.oceanMargin) / mapSize()) * sx);
    const smooth = (e0, e1, v) => { const q = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return q * q * (3 - 2 * q); };
    for (const t of TYPES) {
      if (!N.on[t.id]) continue;
      const d = Float32Array.from(p.maps[TIDX[t.id]]);
      // logged finds: real evidence, weighted heavily
      for (const nd of N.nodes) {
        if (nd.t !== t.id) continue;
        const [ix, iy] = worldToImg(nd.x, nd.y), cx = ix * sx, cy = iy * sx;
        for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, cy + r); y++)
          for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, cx + r); x++) {
            const q = 1 - Math.hypot(x - cx, y - cy) / r;
            if (q > 0) d[y * W + x] += 0.45 * q * q;
          }
      }
      const img = octx.createImageData(W, H), o = img.data;
      for (let i = 0; i < d.length; i++) {
        const v = Math.min(1, d[i]);
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
    if (!S.layers.nodes || !S.map || !TYPES.some((t) => N.on[t.id])) return;
    if (N.mode === "heat") {
      const hc = heatCanvas();
      if (hc) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(hc, 0, 0, S.map.width, S.map.height); }
    }
    // logged finds as dots: always in dots mode, and once zoomed in on the heatmap
    if (N.mode === "dots" || S.view.scale > 1.6) {
      for (const n of N.nodes) {
        if (!N.on[n.t]) continue;
        const [x, y] = worldToImg(n.x, n.y);
        ctx.fillStyle = TY[n.t].color; ctx.strokeStyle = "rgba(8,12,19,.9)"; ctx.lineWidth = 1.5 * px;
        ctx.beginPath(); ctx.arc(x, y, 3.6 * px, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  };

  // ------------------------------------------------------------ logging
  async function logNode(type, x, y) {
    if (S.demo) {
      const [mx, my] = x == null ? [S.team.members[0].x, S.team.members[0].y] : [x, y];
      setNodes([...N.nodes, { t: type, x: Math.round(mx), y: Math.round(my), ts: Date.now(), by: "you" }]);
      toast(`${TY[type].name} node logged`, `at ${gridLabel(mx, my)}`, "ok");
      return;
    }
    try {
      setNodes(await invoke("log_node", { type, x, y }));
      toast(`${TY[type].name} node logged`, "Shared with your team", "ok");
    } catch (e) { toast("Couldn't log node", String(e), "bad"); }
  }
  async function removeNode(ts) {
    if (S.demo) return setNodes(N.nodes.filter((n) => n.ts !== ts));
    try { setNodes(await invoke("remove_node", { ts })); } catch (e) { toast("Couldn't remove node", String(e), "bad"); }
  }

  // right-click the map: log a node at that spot
  const menu = document.createElement("div");
  menu.className = "ctx-menu float"; menu.hidden = true;
  document.body.appendChild(menu);
  const closeMenu = () => (menu.hidden = true);
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!S.map || !S.connected) return;
    const r = canvas.getBoundingClientRect();
    const [wx, wy] = imgToWorld((e.clientX - r.left - S.view.x) / S.view.scale, (e.clientY - r.top - S.view.y) / S.view.scale);
    const near = N.nodes.filter((n) => Math.hypot(n.x - wx, n.y - wy) < 25).sort((a, b) => Math.hypot(a.x - wx, a.y - wy) - Math.hypot(b.x - wx, b.y - wy))[0];
    menu.innerHTML = `<div class="ctx-head">Log node at ${gridLabel(wx, wy)}</div>` +
      TYPES.map((t) => `<button data-t="${t.id}"><i style="background:${t.color}"></i>${t.name}</button>`).join("") +
      (near ? `<div class="ctx-sep"></div><button data-rm="${near.ts}" class="danger">Remove ${TY[near.t].name.toLowerCase()} node</button>` : "") +
      (window.Pins ? `<div class="ctx-sep"></div><div class="ctx-head">Add marker</div>` +
        Object.entries(Pins.kinds).map(([k, v]) => `<button data-pin="${k}"><i style="background:${v.color}"></i>${v.name}</button>`).join("") +
        (Pins.near(wx, wy) ? `<button data-unpin class="danger">Remove marker</button>` : "") : "");
    menu.style.left = `${Math.min(e.clientX, innerWidth - 200)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - 340)}px`;
    menu.hidden = false;
    menu.onclick = (ev) => {
      const b = ev.target.closest("button"); if (!b) return;
      if (b.dataset.t) logNode(b.dataset.t, wx, wy);
      if (b.dataset.rm) removeNode(+b.dataset.rm);
      if (b.dataset.pin) Pins.add(b.dataset.pin, wx, wy);
      if ("unpin" in b.dataset) { const p = Pins.near(wx, wy); if (p) Pins.remove(p); }
      closeMenu();
    };
  });

  // ------------------------------------------------------------- panel
  // floating toggles on the map's right edge
  function renderQuick() {
    const counts = Object.fromEntries(TYPES.map((t) => [t.id, N.nodes.filter((n) => n.t === t.id).length]));
    $("#node-quick").innerHTML = `<div class="nq-title">Node heatmap</div>` + TYPES.map((t) => `
      <button data-type="${t.id}" class="${N.on[t.id] && S.layers.nodes ? "on" : ""}" style="--c:${t.color}" title="Where ${t.name.toLowerCase()} nodes likely spawn (from the terrain)${counts[t.id] ? `, plus ${counts[t.id]} logged finds` : ""}">
        <i></i><span>${t.name}</span><b>${counts[t.id] || ""}</b>
      </button>`).join("") +
      `<div class="nq-sep"></div><button class="nq-route ${route ? "on" : ""}" data-route title="Plan a farming route through the best spots">${route ? "Clear route" : "Plan route"}</button>`;
  }
  function toggleType(type) {
    const turningOn = !(N.on[type] && S.layers.nodes);
    N.on[type] = turningOn;
    if (turningOn && !S.layers.nodes) { S.layers.nodes = true; document.querySelector('[data-layer="nodes"]').checked = true; }
    saveView(); N.heat = null; render(); draw();
  }

  function render() {
    renderQuick();
    const counts = Object.fromEntries(TYPES.map((t) => [t.id, N.nodes.filter((n) => n.t === t.id).length]));
    $("#node-types").innerHTML = TYPES.map((t) => `
      <button data-type="${t.id}" class="${N.on[t.id] ? "on" : ""}" style="--c:${t.color}">
        <i></i><span>${t.name}</span><b>${counts[t.id]}</b>
      </button>`).join("");
    document.querySelectorAll("#node-mode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === N.mode));

    // hotspots: grid squares with the most finds of the visible types
    const cells = new Map();
    for (const n of N.nodes) {
      if (!N.on[n.t]) continue;
      const g = gridLabel(n.x, n.y), c = cells.get(g) || { g, x: 0, y: 0, n: 0, by: {} };
      c.x += n.x; c.y += n.y; c.n++; c.by[n.t] = (c.by[n.t] || 0) + 1;
      cells.set(g, c);
    }
    const hot = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 6);
    const max = hot[0]?.n || 1;
    $("#node-hot").innerHTML = hot.length ? hot.map((c) => `
      <button class="hot-row" data-x="${c.x / c.n}" data-y="${c.y / c.n}">
        <b>${c.g}</b>
        <span class="hot-bar"><span style="width:${(c.n / max) * 100}%;background:${TY[Object.entries(c.by).sort((a, b) => b[1] - a[1])[0][0]].color}"></span></span>
        <span class="hot-n">${TYPES.filter((t) => c.by[t.id]).map((t) => `<em style="color:${t.color}">${c.by[t.id]}</em>`).join(" ")}</span>
      </button>`).join("") : `<div class="raid-empty">No nodes logged on this map yet.</div>`;

    const recent = [...N.nodes].sort((a, b) => b.ts - a.ts).slice(0, 8);
    $("#node-recent").innerHTML = recent.map((n) => `
      <div class="recent-row">
        <i style="background:${TY[n.t].color}"></i>
        <span class="rn">${TY[n.t].name} · ${gridLabel(n.x, n.y)}</span>
        <span class="muted small">${esc(n.by || "")} · ${fmtAgo(n.ts)}</span>
        <button data-rm="${n.ts}" title="Remove">✕</button>
      </div>`).join("");
    $("#node-recent-label").hidden = !recent.length;
  }

  $("#node-types").onclick = (e) => { const b = e.target.closest("[data-type]"); if (b) toggleType(b.dataset.type); };
  $("#node-quick").onclick = (e) => {
    if (e.target.closest("[data-route]")) {
      if (route) { route = null; renderQuick(); draw(); return; }
      const t = TYPES.find((x) => N.on[x.id])?.id ?? "sulfur"; // the shown heatmap, else sulfur
      return toggleRoute(t);
    }
    const b = e.target.closest("[data-type]"); if (b) toggleType(b.dataset.type);
  };
  // keep the quick bar in sync when the "Nodes" layer chip is switched
  document.querySelector('[data-layer="nodes"]').addEventListener("change", () => setTimeout(renderQuick));
  $("#node-mode").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (!b) return; N.mode = b.dataset.mode; saveView(); render(); draw(); };
  $("#node-log").onclick = (e) => { const b = e.target.closest("[data-log]"); if (b) logNode(b.dataset.log); };
  $("#node-hot").onclick = (e) => { const b = e.target.closest(".hot-row"); if (b) centerOn(+b.dataset.x, +b.dataset.y, Math.max(S.view.scale, 1.8)); };
  $("#node-recent").onclick = (e) => { const b = e.target.closest("[data-rm]"); if (b) removeNode(+b.dataset.rm); };
  $("#node-clear").onclick = async () => {
    if (!N.nodes.length || !confirm("Clear every logged node for this map? This can't be undone.")) return;
    if (S.demo) return setNodes([]);
    try { setNodes(await invoke("clear_nodes")); } catch (e) { toast("Couldn't clear nodes", String(e), "bad"); }
  };

  listen("nodes-changed", ({ payload }) => setNodes(payload));

  window.Nodes = {
    async load() { try { setNodes(await invoke("get_nodes")); } catch { setNodes([]); } },
    set: setNodes,
    reset: () => { route = null; setNodes([]); },
    planRoute: toggleRoute,
    _stats() { const p = predict(); if (!p) return null; return ["stone", "metal", "sulfur"].map((t, k) => { const d = p.maps[k]; let a = 0, b = 0, land = 0; for (const v of d) { if (v > 0) land++; if (v > 0.08) a++; if (v > 0.5) b++; } return { t, tinted: (a / d.length * 100).toFixed(1) + "%", hot: (b / d.length * 100).toFixed(2) + "%" }; }); },
  };
  render();
})();
