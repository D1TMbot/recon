// Demo mode (open the app with ?demo): a procedurally generated, Rust-style
// island plus a fake team, events and chat, so the UI can be previewed
// without a paired server. Real servers send their own map image instead.
(() => {
  const SIZE = 1400, MARGIN = 120, MAPSIZE = 4250;

  // ------------------------------------------------------------ noise
  let seed = 1337;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const perm = new Uint16Array(512);
  const p = [...Array(256).keys()].sort(() => rand() - 0.5);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = (h, x, y) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  function noise(x, y) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const a = perm[X] + Y, b = perm[X + 1] + Y;
    const l1 = grad(perm[a], x, y) + u * (grad(perm[b], x - 1, y) - grad(perm[a], x, y));
    const l2 = grad(perm[a + 1], x, y - 1) + u * (grad(perm[b + 1], x - 1, y - 1) - grad(perm[a + 1], x, y - 1));
    return l1 + v * (l2 - l1);
  }
  function fbm(x, y, oct = 6) {
    let s = 0, a = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { s += a * noise(x * f, y * f); a *= 0.5; f *= 2.03; }
    return s;
  }

  // ---------------------------------------------------------- terrain
  const N = SIZE, inner = N - 2 * MARGIN;
  const H = new Float32Array(N * N);
  const R = new Float32Array(N * N); // river field
  const F = new Float32Array(N * N); // forest/detail field
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const nx = (x - MARGIN) / inner, ny = (y - MARGIN) / inner;
    const wx = nx + 0.18 * fbm(nx * 2 + 9, ny * 2 + 3, 3), wy = ny + 0.18 * fbm(nx * 2 + 1, ny * 2 + 7, 3);
    const dx = wx - 0.5, dy = wy - 0.5;
    const d = Math.sqrt(dx * dx * 1.05 + dy * dy) * 2;
    let h = 0.42 - d * 0.62 + fbm(wx * 3.2, wy * 3.2) * 0.55 + Math.max(0, fbm(wx * 1.6 + 20, wy * 1.6) ) * 0.35;
    H[y * N + x] = h;
    R[y * N + x] = Math.abs(fbm(nx * 3.4 + 40, ny * 3.4 + 40, 4));
    F[y * N + x] = fbm(nx * 18 + 70, ny * 18, 3);
  }

  // ----------------------------------------------------------- colours
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const C = {
    deep: [22, 52, 66], ocean: [38, 82, 96], shallow: [74, 130, 136], foam: [118, 160, 154],
    sand: [205, 189, 146], grass: [104, 122, 66], grass2: [88, 108, 55], forest: [62, 84, 42],
    rock: [128, 124, 108], snow: [226, 231, 233], snowRock: [168, 172, 172],
    desert: [204, 174, 118], desert2: [186, 152, 98], river: [58, 108, 120],
  };

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const g = canvas.getContext("2d");
  const img = g.createImageData(N, N);
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x, h = H[i];
    let c;
    if (h < 0) {
      const t = Math.min(1, -h / 0.35);
      c = t < 0.08 ? mix(C.foam, C.shallow, t / 0.08) : t < 0.35 ? mix(C.shallow, C.ocean, (t - 0.08) / 0.27) : mix(C.ocean, C.deep, (t - 0.35) / 0.65);
    } else {
      const lat = (y - MARGIN) / inner + fbm(x / 180, y / 180, 3) * 0.08; // 0 = north
      const f = F[i];
      if (h < 0.025) c = C.sand;
      else if (lat < 0.27) c = h > 0.32 ? C.snowRock : mix(C.snow, [210, 216, 214], Math.max(0, f + 0.2));
      else if (lat > 0.74) c = h > 0.36 ? C.rock : mix(C.desert, C.desert2, Math.max(0, Math.min(1, f + 0.5)));
      else {
        c = f > 0.08 ? C.forest : f > -0.06 ? C.grass2 : C.grass;
        if (h > 0.34) c = mix(c, C.rock, Math.min(1, (h - 0.34) / 0.08));
      }
      if (lat > 0.27 && lat < 0.74 && h < 0.06 && h >= 0.025) c = mix(C.sand, c, (h - 0.025) / 0.035);
      // rivers: thin noise ridges through low/mid land
      if (h > 0.02 && h < 0.3 && R[i] < 0.009 + h * 0.01) c = C.river;
      // hill shading, light from the north-west
      const sx = H[i + 1] - H[i - 1], sy = H[i + N] - H[i - N];
      const shade = Math.max(0.72, Math.min(1.22, 1 - (sx + sy) * 9));
      c = c.map((v) => v * shade);
    }
    img.data.set([c[0], c[1], c[2], 255], i * 4);
  }
  g.putImageData(img, 0, 0);

  // ------------------------------------------------------------ helpers
  const toWorld = (px, py) => [((px - MARGIN) / inner) * MAPSIZE, ((N - py - MARGIN) / inner) * MAPSIZE];
  const hAt = (x, y) => {
    const xi = Math.round(x), yi = Math.round(y);
    return xi < 1 || yi < 1 || xi >= N - 1 || yi >= N - 1 ? -1 : H[yi * N + xi];
  };
  const isRiver = (x, y) => { const i = Math.round(y) * N + Math.round(x), h = H[i]; return h > 0.02 && h < 0.3 && R[i] < 0.012 + h * 0.01; };
  const CX = N / 2, CY = N / 2;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  // walk out from the island centre until we hit open water
  function coastAt(deg) {
    const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    // the coast is the last land before a long stretch of open sea (skips lakes)
    let r = 40, lastLand = 40, water = 0;
    for (; r < N / 2; r++) {
      if (hAt(CX + c * r, CY + s * r) > 0) { lastLand = r; water = 0; }
      else if (++water > 60) break;
    }
    r = lastLand - 2;
    return { x: CX + c * r, y: CY + s * r, ang: t, r };
  }

  // wandering path between two points (roads follow the land loosely)
  function wander(a, b, amp, k) {
    const len = dist(a, b), steps = Math.max(10, Math.round(len / 5));
    const px = -(b[1] - a[1]) / len, py = (b[0] - a[0]) / len, pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, o = fbm(t * 2.4 + k * 3.1, k * 1.7, 3) * amp * 2.2 * Math.sin(Math.PI * t);
      pts.push([a[0] + (b[0] - a[0]) * t + px * o, a[1] + (b[1] - a[1]) * t + py * o]);
    }
    return pts;
  }
  const smooth = (pts, closed) => pts.map((pt, i) => {
    const n = pts.length;
    const q = (k) => closed ? pts[(i + k + n) % n] : pts[Math.min(n - 1, Math.max(0, i + k))];
    return [(q(-2)[0] + q(-1)[0] + pt[0] + q(1)[0] + q(2)[0]) / 5, (q(-2)[1] + q(-1)[1] + pt[1] + q(1)[1] + q(2)[1]) / 5];
  });

  // ---------------------------------------------------------- monuments
  const placed = [];
  function findSpot(fx, fy, minGap) {
    const x0 = MARGIN + fx * inner, y0 = MARGIN + fy * inner;
    for (let r = 0; r < 260; r += 6) for (let a = 0; a < 360; a += 30) {
      const x = x0 + Math.cos(a) * r, y = y0 + Math.sin(a) * r, h = hAt(x, y);
      if (h < 0.08 || h > 0.3 || isRiver(x, y)) continue;
      let ok = true;
      for (let dy = -22; dy <= 22 && ok; dy += 11) for (let dx = -22; dx <= 22; dx += 11) if (hAt(x + dx, y + dy) < 0.05) ok = false;
      if (ok && placed.every((m) => dist([x, y], [m.x, m.y]) > minGap)) return [x, y];
    }
    return null;
  }
  const mons = [];
  const addMon = (token, x, y, ang, kind) => { const m = { token, x, y, ang, kind }; mons.push(m); placed.push(m); return m; };
  const inland = [
    ["launchsite", 0.30, 0.44, "big"], ["airfield_display_name", 0.62, 0.36, "big"], ["power_plant_display_name", 0.70, 0.58, "big"],
    ["train_yard_display_name", 0.56, 0.70, "big"], ["water_treatment_plant_display_name", 0.28, 0.64, "big"],
    ["military_tunnels_display_name", 0.44, 0.60, "mid"], ["outpost", 0.50, 0.46, "mid"], ["bandit_camp", 0.38, 0.32, "mid"],
    ["dome_monument_name", 0.46, 0.80, "mid"], ["satellite_dish_display_name", 0.62, 0.22, "mid"],
    ["gas_station", 0.40, 0.50, "small"], ["supermarket", 0.60, 0.54, "small"],
  ];
  for (const [token, fx, fy, kind] of inland) {
    const s = findSpot(fx, fy, kind === "big" ? 130 : 90);
    if (s) addMon(token, s[0], s[1], (rand() - 0.5) * 0.7, kind);
  }
  // coastal ones sit on the shoreline, facing the sea
  const coastal = [["harbor_display_name", 8], ["lighthouse_display_name", 203], ["fishing_village_display_name", 162], ["fishing_village_display_name", 318]];
  for (const [token, deg] of coastal) {
    const c = coastAt(deg);
    addMon(token, c.x, c.y, c.ang, "coast");
  }
  // oil rigs out at sea
  for (const [token, deg, off] of [["oil_rig_small", 62, 95], ["large_oil_rig", 245, 120]]) {
    const c = coastAt(deg);
    let x = c.x + Math.cos(c.ang) * off, y = c.y + Math.sin(c.ang) * off;
    x = Math.min(N - 40, Math.max(40, x)); y = Math.min(N - 40, Math.max(40, y));
    addMon(token, x, y, 0.2, "sea");
  }

  // ground under monuments: flattened gravel / dirt
  function clearing(x, y, rx, ry, ang, col, a = 0.9) {
    g.save(); g.translate(x, y); g.rotate(ang); g.scale(1, ry / rx);
    const gr = g.createRadialGradient(0, 0, rx * 0.5, 0, 0, rx);
    gr.addColorStop(0, `rgba(${col},${a})`); gr.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, rx, 0, 7); g.fill(); g.restore();
  }
  const CLEAR = { big: [80, 58], mid: [46, 40], small: [26, 22] };
  for (const m of mons) {
    if (m.kind === "sea") continue;
    if (m.token === "bandit_camp") { clearing(m.x, m.y, 44, 38, m.ang, "72,86,62", 0.95); continue; }
    if (m.kind === "coast") { clearing(m.x - Math.cos(m.ang) * 18, m.y - Math.sin(m.ang) * 18, 38, 30, m.ang, "160,150,124", 0.8); continue; }
    const [rx, ry] = CLEAR[m.kind];
    clearing(m.x, m.y, rx, ry, m.ang, "150,143,122");
  }

  // -------------------------------------------------------------- roads
  const roads = [];
  const ring = [];
  for (let a = 0; a < 360; a += 2) {
    const c = coastAt(a), r = c.r - (58 + 26 * noise(a / 35, 5.5));
    ring.push([CX + Math.cos(c.ang) * r, CY + Math.sin(c.ang) * r]);
  }
  const ringS = smooth(smooth(smooth(ring, true), true), true);
  roads.push({ pts: ringS, style: "asphalt", closed: true });
  const nearestRing = (x, y) => ringS.reduce((b, p) => (dist(p, [x, y]) < dist(b, [x, y]) ? p : b));
  let k = 1;
  for (const m of mons) {
    if (m.kind === "sea") continue;
    const end = nearestRing(m.x, m.y);
    if (dist(end, [m.x, m.y]) < 12) continue;
    const style = m.kind === "big" || m.token.startsWith("harbor") || m.token === "outpost" ? "asphalt" : "trail";
    roads.push({ pts: smooth(wander([m.x, m.y], end, 26, k++)), style });
  }
  // a couple of main roads across the island between big monuments
  const bigs = mons.filter((m) => m.kind === "big");
  for (let i = 0; i + 1 < bigs.length; i += 2) roads.push({ pts: smooth(wander([bigs[i].x, bigs[i].y], [bigs[i + 1].x, bigs[i + 1].y], 40, k++)), style: "asphalt" });

  const STYLES = {
    asphalt: [[10.5, "rgba(48,42,32,.42)"], [7.5, "#86837a"], [5.6, "#a3a094"]],
    trail: [[6, "rgba(58,46,30,.32)"], [3.2, "#a2906b"]],
    rail: [[6.5, "rgba(32,30,26,.55)"], [3.4, "#55524c"], [3.4, "#9b958a", [1.2, 3]]],
  };
  function landSegments(pts, closed) {
    const all = closed ? [...pts, pts[0]] : pts, segs = [];
    let cur = [];
    for (const p of all) {
      if (hAt(p[0], p[1]) > 0.004) cur.push(p);
      else { if (cur.length > 1) segs.push(cur); cur = []; }
    }
    if (cur.length > 1) segs.push(cur);
    return segs;
  }
  function drawStyle(style, list) {
    for (const [w, col, dash] of STYLES[style]) for (const r of list) for (const sg of landSegments(r.pts, r.closed)) {
      g.beginPath(); sg.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
      g.lineWidth = w; g.strokeStyle = col; g.lineJoin = g.lineCap = "round"; g.setLineDash(dash || []); g.stroke();
    }
    g.setLineDash([]);
  }
  drawStyle("trail", roads.filter((r) => r.style === "trail"));
  drawStyle("asphalt", roads.filter((r) => r.style === "asphalt"));
  // railway: coast to coast through the train yard
  const ty = mons.find((m) => m.token.startsWith("train"));
  if (ty) {
    const inset = (deg) => { const c = coastAt(deg), r = c.r - 34; return [CX + Math.cos(c.ang) * r, CY + Math.sin(c.ang) * r]; };
    const railPts = smooth([...wander(inset(150), [ty.x, ty.y], 30, 40), ...wander([ty.x, ty.y], inset(20), 30, 41).slice(1)]);
    drawStyle("rail", [{ pts: railPts }]);
  }

  // --------------------------------------------------- monument drawing
  const SH = "rgba(18,16,12,.45)";
  const rect = (x, y, w, h, c, r = 1.2) => { g.fillStyle = c; g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); };
  const bld = (x, y, w, h, c) => { rect(x + 1.8, y + 1.8, w, h, SH); rect(x, y, w, h, c); rect(x, y, w, h * 0.45, "rgba(255,255,255,.07)"); };
  const circ = (x, y, r, c) => { g.fillStyle = c; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); };
  const circS = (x, y, r, c) => { circ(x + 1.6, y + 1.6, r, SH); circ(x, y, r, c); };
  const pad = (x, y, w, h, c = "#8f8c84") => { rect(x, y, w, h, c, 2); g.strokeStyle = "rgba(60,58,52,.6)"; g.lineWidth = 0.8; g.strokeRect(x, y, w, h); };
  const line = (x0, y0, x1, y1, w, c, dash) => { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineWidth = w; g.strokeStyle = c; g.setLineDash(dash || []); g.stroke(); g.setLineDash([]); };
  const ROOF = "#5d6062", ROOF2 = "#727578", ROOF3 = "#868780", WOOD = "#7c6448", DARK = "#3c3d3b", WATER = "#4a6e7a";
  const CONT = ["#4c6878", "#57725a", "#6b6f75", "#3f5878", "#7c7b6b", "#5b6a72"];
  const containers = (x, y, cols, rows) => { for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) bld(x + i * 6.5, y + j * 3.6, 6, 3, CONT[Math.floor(rand() * CONT.length)]); };

  const DRAW = {
    launchsite() {
      pad(-56, -28, 112, 56);
      pad(-50, -22, 40, 44, "#7f7c75");
      bld(-46, -18, 30, 12, ROOF); bld(-46, 2, 18, 14, ROOF2); bld(-24, 2, 10, 14, ROOF);
      circS(26, -6, 9, "#6a6b68"); circ(26, -6, 4.5, DARK); bld(22, -26, 8, 8, DARK);
      bld(4, 8, 40, 12, ROOF3); bld(40, -22, 12, 10, ROOF);
      line(-56, 24, 56, 24, 1.6, "#5c5952");
    },
    airfield() {
      pad(-50, 6, 100, 24, "#8a877f");
      rect(-60, -8, 120, 12, "#565754", 1); line(-55, -2, 55, -2, 1, "#c9c6bc", [5, 4]);
      for (let i = 0; i < 3; i++) bld(-42 + i * 22, 12, 18, 13, i === 1 ? ROOF3 : ROOF2);
      bld(28, 12, 12, 8, ROOF); bld(30, 22, 16, 6, ROOF);
      rect(-60, -24, 40, 8, "#5d5e5a", 1);
    },
    power_plant() {
      pad(-42, -32, 84, 64);
      for (const [x, y] of [[-24, -14], [-24, 12]]) { circS(x, y, 11, "#a19d94"); circ(x, y, 7, "#6c6a64"); }
      bld(-4, -28, 34, 16, ROOF); bld(-4, -8, 22, 22, ROOF2); bld(22, -6, 14, 30, ROOF);
      for (let i = 0; i < 3; i++) circS(-2 + i * 8, 22, 3.2, "#9b9890");
    },
    train_yard() {
      pad(-54, -30, 108, 60);
      for (let i = 0; i < 5; i++) line(-54, -14 + i * 6, 54, -14 + i * 6, 1.2, "#4f4d48");
      bld(-48, -27, 34, 11, ROOF2); bld(-8, -27, 22, 10, ROOF); bld(10, 14, 38, 13, ROOF);
      bld(-40, 16, 20, 10, ROOF3); containers(24, -26, 4, 2);
    },
    water_treatment_plant() {
      pad(-44, -36, 88, 72);
      for (const [x, y] of [[-26, -18], [-6, -18], [-26, 4], [-6, 4]]) { circS(x, y, 8.5, "#7d838a"); circ(x, y, 6, WATER); }
      rect(10, -30, 28, 14, WATER, 1); rect(10, -12, 28, 14, WATER, 1);
      bld(10, 8, 26, 14, ROOF); bld(-38, 18, 22, 12, ROOF2);
    },
    military_tunnels() {
      clearing(0, 0, 30, 24, 0, "128,124,110", 0.9);
      pad(-16, -11, 32, 22, "#7d7a72"); bld(-10, -7, 14, 10, DARK); bld(6, -6, 7, 9, ROOF); line(-16, 8, 16, 8, 1.4, "#555");
    },
    outpost() {
      pad(-30, -30, 60, 60, "#87847c");
      g.strokeStyle = "#5b574e"; g.lineWidth = 2; g.strokeRect(-30, -30, 60, 60);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) bld(-24 + i * 17, -22 + j * 24, 13, 14, j ? ROOF : ROOF2);
      circS(0, 22, 4, "#9b9890");
    },
    bandit_camp() {
      for (const [x, y, w, h] of [[-26, -16, 18, 14], [4, -22, 20, 14], [-10, 6, 16, 16], [14, 4, 16, 12]]) bld(x, y, w, h, WOOD);
      line(-8, -9, 4, -15, 2, "#6a553d"); line(-2, 8, 4, -8, 2, "#6a553d"); line(6, 14, 14, 10, 2, "#6a553d");
    },
    dome() { circS(0, 0, 14, "#aaa69c"); circ(-3, -3, 6, "rgba(255,255,255,.18)"); g.strokeStyle = "#6c6a63"; g.lineWidth = 1; g.beginPath(); g.arc(0, 0, 14, 0, 7); g.stroke(); bld(16, -6, 8, 10, ROOF); },
    satellite_dish() {
      for (const [x, y, r] of [[-14, -6, 10], [10, -12, 7], [8, 12, 7]]) { circS(x, y, r, "#bdbab1"); circ(x, y, r * 0.55, "#8b887f"); }
      bld(-6, 14, 12, 8, ROOF);
    },
    gas_station() { pad(-16, -11, 32, 22, "#86837b"); bld(-12, -8, 14, 9, ROOF2); bld(5, -7, 8, 14, ROOF); line(-12, 6, 0, 6, 1, "#c9c6bc", [2, 2]); },
    supermarket() { pad(-18, -13, 36, 26, "#86837b"); bld(-12, -10, 24, 12, ROOF2); for (let i = 0; i < 5; i++) line(-14 + i * 6, 5, -14 + i * 6, 11, 0.8, "#c9c6bc"); },
    // coastal: local x axis points out to sea
    harbor() {
      pad(-52, -36, 52, 72);
      rect(-2, -30, 40, 8, "#7a776f", 1); rect(-2, -4, 50, 8, "#7a776f", 1); rect(-2, 22, 36, 8, "#7a776f", 1);
      containers(-46, -30, 5, 4); containers(-46, 8, 4, 5);
      bld(-18, -12, 14, 10, ROOF); bld(30, -18, 5, 14, DARK);
      rect(10, 7, 34, 11, "#3a4954", 4); rect(14, 9, 9, 7, "#566672", 2);
    },
    lighthouse() {
      rect(-8, -2.5, 22, 5, WOOD, 1); pad(-18, -9, 12, 18, "#8a877f");
      circS(-12, 0, 5, "#e9e7e0"); circ(-12, 0, 2.2, "#6d6b66");
    },
    fishing_village() {
      rect(-4, -16, 26, 4, WOOD, 1); rect(-4, 2, 30, 4, WOOD, 1); rect(-4, 14, 20, 4, WOOD, 1);
      bld(-22, -16, 10, 8, "#7f6b51"); bld(-20, -2, 11, 9, "#6f5c45"); bld(-22, 12, 9, 8, "#7f6b51");
      g.fillStyle = "#5c4a36"; for (const [x, y] of [[10, -8], [22, 9]]) { g.beginPath(); g.ellipse(x, y, 6, 2.2, 0, 0, 7); g.fill(); }
    },
    oil_rig_small() {
      for (const [x, y] of [[-12, -12], [12, -12], [-12, 12], [12, 12]]) circ(x, y, 2.4, "#2d3a40");
      bld(-14, -14, 28, 28, "#6c6d6a"); bld(-10, -10, 12, 12, "#7f807c"); circ(6, 6, 6, "#8d8e8a"); line(-14, 14, -26, 22, 1.5, "#4a4b48");
    },
    large_oil_rig() {
      for (const [x, y] of [[-20, -16], [20, -16], [-20, 16], [20, 16]]) circ(x, y, 3, "#2d3a40");
      bld(-24, -20, 48, 40, "#686966"); bld(-18, -14, 20, 16, "#7d7e7a"); bld(6, -14, 12, 10, ROOF);
      circ(10, 10, 7, "#8d8e8a"); line(-24, 20, -38, 30, 1.8, "#4a4b48");
    },
  };
  const drawKey = (t) => t.replace(/_display_name|_monument_name/, "");
  for (const m of mons) {
    const fn = DRAW[drawKey(m.token)];
    if (!fn) continue;
    g.save(); g.translate(m.x, m.y); g.rotate(m.ang); fn(); g.restore();
  }
  const monuments = mons.map((m) => {
    // coastal labels sit a bit inland so the text lands on the island
    const lx = m.kind === "coast" ? m.x - Math.cos(m.ang) * 20 : m.x, ly = m.kind === "coast" ? m.y - Math.sin(m.ang) * 20 : m.y;
    const [x, y] = toWorld(lx, ly);
    return { token: m.token, x, y };
  });


  // ------------------------------------------------- hand it to the app
  const image = new Image();
  image.src = canvas.toDataURL("image/jpeg", 0.92);
  image.decode().then(() => {
    const now = Date.now() / 1000;
    const at = (fx, fy) => toWorld(MARGIN + fx * inner, MARGIN + fy * inner);
    const [ax, ay] = at(0.45, 0.5), [bx, by] = at(0.5, 0.44), [cx, cy] = at(0.66, 0.6), [dx, dy] = at(0.3, 0.36);
    S.servers = [{ id: "demo:28015", name: "Demo · EU Main" }, { id: "demo2:28015", name: "Demo · US Monthly" }];
    S.active = "demo:28015";
    S.info = { name: "Demo · EU Main", players: 142, maxPlayers: 200, queuedPlayers: 0, map: "Procedural Map", mapSize: MAPSIZE, wipeTime: now - 86400 * 2.3, seed: 1337 };
    S.connected = true;
    S.map = { width: N, height: N, oceanMargin: MARGIN, monuments, img: image };
    S.team = {
      leaderSteamId: "1",
      members: [
        { steamId: "1", name: "You", x: ax, y: ay, isOnline: true, isAlive: true, spawnTime: now - 900 },
        { steamId: "2", name: "Mike", x: bx, y: by, isOnline: true, isAlive: true, spawnTime: now - 300 },
        { steamId: "3", name: "Sam", x: cx, y: cy, isOnline: true, isAlive: false, deathTime: now - 60 },
        { steamId: "4", name: "Jules", x: dx, y: dy, isOnline: false, isAlive: true },
      ],
      mapNotes: [{ x: (ax + cx) / 2, y: (ay + cy) / 2 }],
    };
    const [ex, ey] = at(0.9, 0.15), [hx, hy] = at(0.55, 0.3), [kx, ky] = at(0.52, 0.47);
    S.markers = [{ id: 1, type: 5, x: ex, y: ey }, { id: 2, type: 8, x: hx, y: hy }, { id: 3, type: 6, x: kx, y: ky }];
    S.chat = [
      { time: now - 300, name: "Mike", color: "#5ee0b5", message: "farming sulfur by the quarry" },
      { time: now - 120, name: "Sam", color: "#a5b4fc", message: "got killed near power plant" },
      { time: now - 30, name: "You", color: "#3fd0ff", message: "cargo just spawned, going?" },
    ];
    setConn("ok", "Connected (demo)");
    S.demo = true; S.selfSteamId = "1";
    renderStats(); renderServers(); renderTeam(); renderChat(); fitMap();

    // fake team-logged nodes, clustered the way they spawn: sulfur on rocky
    // snow/desert ground, metal on hills, stone almost anywhere
    const demoNodes = [], who = ["You", "Mike", "Sam", "Jules"];
    let ts = Date.now() - 3 * 86400e3;
    const rules = {
      stone: [16, (h) => h > 0.05 && h < 0.3],
      metal: [11, (h) => h > 0.15],
      sulfur: [11, (h, lat) => h > 0.1 && (lat < 0.3 || lat > 0.7 || h > 0.24)],
    };
    for (const [t, [clusters, ok]] of Object.entries(rules)) {
      for (let made = 0, tries = 0; made < clusters && tries < 5000; tries++) {
        const px = MARGIN + rand() * inner, py = MARGIN + rand() * inner;
        if (!ok(hAt(px, py), (py - MARGIN) / inner) || isRiver(px, py)) continue;
        if (placed.some((m) => dist([px, py], [m.x, m.y]) < 60)) continue;
        made++;
        const count = 4 + Math.floor(rand() * 13);
        for (let j = 0; j < count; j++) {
          const a = rand() * 6.283, r = rand() * 30, qx = px + Math.cos(a) * r, qy = py + Math.sin(a) * r;
          if (hAt(qx, qy) < 0.03) continue;
          const [wx, wy] = toWorld(qx, qy);
          demoNodes.push({ t, x: Math.round(wx), y: Math.round(wy), ts: (ts += rand() * 6e5), by: who[Math.floor(rand() * 4)] });
        }
      }
    }
    void demoNodes; // (logged finds were removed; heatmaps are predicted from the terrain)

    // fake vending machines: clusters at Outpost and Bandit Camp plus a few player shops
    DB.ready.then(() => {
      const id = (s) => Number(DB.byShort(s));
      const scrap = id("scrap");
      const catalog = [
        ["sulfur", 500, scrap, 40], ["sulfur.ore", 1000, scrap, 50], ["metal.fragments", 1000, scrap, 30], ["metal.refined", 50, scrap, 60],
        ["gunpowder", 200, scrap, 70], ["explosives", 5, scrap, 100], ["lowgradefuel", 100, scrap, 15], ["wood", 1000, scrap, 10],
        ["stones", 1000, scrap, 12], ["cloth", 100, scrap, 20], ["syringe.medical", 2, scrap, 15], ["ammo.rifle", 64, scrap, 60],
        ["rifle.ak", 1, scrap, 500], ["smg.mp5", 1, scrap, 300], ["metal.facemask", 1, scrap, 250], ["metal.plate.torso", 1, scrap, 300],
        ["ammo.rocket.basic", 1, scrap, 400], ["explosive.timed", 1, scrap, 1000], ["techparts", 5, scrap, 80], ["gears", 5, scrap, 60],
        ["sulfur", 1000, id("metal.fragments"), 2000], ["metal.refined", 100, id("sulfur"), 1500], ["rifle.ak", 1, id("metal.refined"), 400],
      ].filter((c) => c[0] && id(c[0]));
      const names = ["Outpost trader", "Ammo shop", "Big Mike's", "Sulfur king", "Cheap farm", "Comps 4 sale", "Raid supplies", "The Bunker", "Fishing Co.", "Gun store"];
      const around = (tok, n) => { const m = mons.find((x) => x.token === tok); return m ? Array.from({ length: n }, () => [m.x + (rand() - 0.5) * 40, m.y + (rand() - 0.5) * 32]) : []; };
      const spots = [...around("outpost", 8), ...around("bandit_camp", 5)];
      for (let k = 0; spots.length < 19 && k < 500; k++) { const x = MARGIN + rand() * inner, y = MARGIN + rand() * inner; if (hAt(x, y) > 0.06) spots.push([x, y]); }
      let mid = 1000;
      const vend = spots.map(([px, py], i) => {
        const [x, y] = toWorld(px, py);
        const n = 2 + Math.floor(rand() * 4), sellOrders = [];
        for (let j = 0; j < n; j++) {
          const [s, qty, cur, cost] = catalog[Math.floor(rand() * catalog.length)];
          const price = Math.max(1, Math.round(cost * (0.7 + rand() * 0.7)));
          sellOrders.push({ itemId: id(s), quantity: qty, currencyId: cur, costPerItem: price, amountInStock: rand() < 0.15 ? 0 : 1 + Math.floor(rand() * 20), itemIsBlueprint: false, currencyIsBlueprint: false });
        }
        return { id: mid++, type: 3, x, y, name: names[i % names.length], outOfStock: sellOrders.every((o) => !o.amountInStock), sellOrders };
      });
      S.markers = [...S.markers, ...vend];
      window.Vending?.update(); window.Events?.update(); window.Events?.onConnect(); draw();
    });
  });
})();
