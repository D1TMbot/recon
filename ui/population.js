// Players panel: server population over time (players and queue, sampled every
// 5 minutes by the backend while Recon is open) and the server's usual busy and
// quiet hours.
(() => {
  const P = { points: [], range: 24 }; // range in hours
  const fmtHour = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });

  async function load() {
    if (S.demo) P.points = demoPoints();
    else { try { P.points = await invoke("get_population"); } catch { P.points = []; } }
    render();
  }

  function render() {
    const pts = P.points, now = Date.now();
    const cur = S.info ? { p: S.info.players, m: S.info.maxPlayers, q: S.info.queuedPlayers || 0 } : pts.at(-1);
    const since = now - P.range * 3600000, shown = pts.filter((x) => x.t >= since);
    const peak = shown.reduce((a, b) => (b.p > (a?.p ?? -1) ? b : a), null);
    $("#pop-now").textContent = cur ? `${cur.p}/${cur.m}` : "–";
    $("#pop-queue").textContent = cur ? String(cur.q ?? 0) : "–";
    $("#pop-peak").textContent = peak ? String(peak.p) : "–";
    $("#pop-peak-when").textContent = peak ? new Date(peak.t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
    document.querySelectorAll("#pop-range button").forEach((b) => b.classList.toggle("on", Number(b.dataset.h) === P.range));
    drawChart(shown, since, now);
    renderPattern();
  }

  function drawChart(pts, t0, t1) {
    const c = $("#pop-chart"), dpr = devicePixelRatio || 1;
    const W = c.clientWidth || 340, H = 170;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    const L = 30, R = 8, T = 10, B = 22, cw = W - L - R, ch = H - T - B;
    const max = Math.max(10, ...pts.map((p) => Math.max(p.m || 0, p.p + p.q)));
    const step = [5, 10, 20, 25, 50, 100, 200, 250, 500].find((st) => max / st <= 4) ?? 1000; // round axis steps
    const yMax = Math.ceil(max / step) * step;
    const X = (t) => L + ((t - t0) / (t1 - t0)) * cw, Y = (v) => T + ch - (v / yMax) * ch;
    g.font = "10px Segoe UI"; g.fillStyle = "#7d8fa6"; g.strokeStyle = "rgba(125,143,166,.15)"; g.lineWidth = 1;
    for (let v = 0; v <= yMax; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
      g.textAlign = "right"; g.textBaseline = "middle"; g.fillText(String(v), L - 6, y);
    }
    const ticks = P.range <= 24 ? 6 : 7;
    g.textAlign = "center"; g.textBaseline = "top";
    for (let i = 0; i <= ticks; i++) {
      const t = t0 + ((t1 - t0) / ticks) * i;
      const lbl = P.range <= 24 ? new Date(t).toLocaleTimeString([], { hour: "numeric" }) : new Date(t).toLocaleDateString([], { weekday: "short" });
      g.fillText(lbl, X(t), H - B + 6);
    }
    if (pts.length < 2) {
      g.fillStyle = "#7d8fa6"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(pts.length ? "Collecting data. Check back in a little while." : "No data yet. Recon records this while it's open.", L + cw / 2, T + ch / 2);
      return;
    }
    // players area + line (break the line across gaps when Recon wasn't open)
    const segs = [[]];
    pts.forEach((p, i) => { if (i && p.t - pts[i - 1].t > 20 * 60000) segs.push([]); segs.at(-1).push(p); });
    for (const seg of segs) {
      if (seg.length < 2) continue;
      const grad = g.createLinearGradient(0, T, 0, T + ch);
      grad.addColorStop(0, "rgba(63,208,255,.35)"); grad.addColorStop(1, "rgba(63,208,255,0)");
      g.beginPath(); g.moveTo(X(seg[0].t), Y(0));
      for (const p of seg) g.lineTo(X(p.t), Y(p.p));
      g.lineTo(X(seg.at(-1).t), Y(0)); g.closePath(); g.fillStyle = grad; g.fill();
      g.beginPath(); seg.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.p)) : g.moveTo(X(p.t), Y(p.p))));
      g.strokeStyle = "#3fd0ff"; g.lineWidth = 2; g.stroke();
      // queue: only where there is one
      g.strokeStyle = "#e879f9"; g.setLineDash([4, 3]); g.lineWidth = 1.5; g.beginPath();
      let pen = false;
      for (const p of seg) {
        if (p.q > 0) { pen ? g.lineTo(X(p.t), Y(p.p + p.q)) : g.moveTo(X(p.t), Y(p.p + p.q)); pen = true; } else pen = false;
      }
      g.stroke(); g.setLineDash([]);
    }
    // max players line
    const m = pts.at(-1).m;
    if (m) { g.strokeStyle = "rgba(242,207,99,.5)"; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(L, Y(m) + 0.5); g.lineTo(W - R, Y(m) + 0.5); g.stroke(); g.setLineDash([]); }
  }

  // average players by hour of day (local time)
  function renderPattern() {
    const pts = P.points, el = $("#pop-pattern");
    const span = pts.length ? pts.at(-1).t - pts[0].t : 0;
    if (span < 6 * 3600000) {
      el.innerHTML = `<div class="muted small">Busy and quiet times show up once Recon has been open for a few hours. The more it runs, the more accurate they get.</div>`;
      return;
    }
    const sum = Array(24).fill(0), cnt = Array(24).fill(0);
    for (const p of pts) { const h = new Date(p.t).getHours(); sum[h] += p.p; cnt[h]++; }
    const avg = sum.map((s, h) => (cnt[h] ? s / cnt[h] : null));
    const known = avg.map((v, h) => [v, h]).filter(([v]) => v != null);
    const busiest = known.reduce((a, b) => (b[0] > a[0] ? b : a)), quietest = known.reduce((a, b) => (b[0] < a[0] ? b : a));
    const top = Math.max(...known.map(([v]) => v), 1);
    el.innerHTML = `
      <div class="pop-tips">
        <div><span class="muted small">Usually busiest</span><b>${fmtHour(busiest[1])}</b><span class="muted small">~${Math.round(busiest[0])} players</span></div>
        <div><span class="muted small">Usually quietest</span><b>${fmtHour(quietest[1])}</b><span class="muted small">~${Math.round(quietest[0])} players</span></div>
      </div>
      <div class="pop-bars">${avg.map((v, h) => `<div title="${fmtHour(h)}: ${v == null ? "no data" : "~" + Math.round(v) + " players"}" class="${v == null ? "none" : ""}" style="height:${v == null ? 4 : Math.max(6, (v / top) * 100)}%"></div>`).join("")}</div>
      <div class="pop-bar-axis"><span>${fmtHour(0)}</span><span>${fmtHour(6)}</span><span>${fmtHour(12)}</span><span>${fmtHour(18)}</span><span>${fmtHour(23)}</span></div>`;
  }

  function demoPoints() {
    const out = [], now = Date.now();
    for (let t = now - 7 * 86400000; t <= now; t += 5 * 60000) {
      const h = new Date(t).getHours() + new Date(t).getMinutes() / 60;
      const p = Math.round(110 + 75 * Math.sin(((h - 14) / 24) * Math.PI * 2) + (Math.random() - 0.5) * 14);
      out.push({ t, p: Math.min(200, Math.max(20, p)), q: p > 180 ? Math.round((p - 180) * 1.5) : 0, m: 200 });
    }
    return out;
  }

  $("#pop-range").onclick = (e) => { const b = e.target.closest("[data-h]"); if (b) { P.range = Number(b.dataset.h); render(); } };
  listen("population", ({ payload }) => { if (payload.serverId === S.active) { P.points.push(payload.point); if ($("#tab-players").classList.contains("active")) render(); } });
  window.Population = { load, render };
})();
