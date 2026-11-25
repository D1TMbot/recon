// Event timers (locked crate, Cargo, Heli, Chinook), death markers for
// teammates, and the in-game day/night clock.
(() => {
  const mmss = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const ago = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? "<1m" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };

  // ============================================================ events
  const EV = {
    6: { name: "Locked Crate", color: "#5ee0b5" },
    5: { name: "Cargo Ship", color: "#3fd0ff" },
    8: { name: "Patrol Heli", color: "#e879f9" },
    4: { name: "Chinook", color: "#a5b4fc" },
  };
  const CRATE_SECONDS = 15 * 60; // default hack time once someone starts the crate
  const live = new Map(); // marker id -> { type, first, x, y }
  const histKey = () => `recon.events.${S.active ?? "demo"}`;
  const history = () => { try { return JSON.parse(localStorage.getItem(histKey())) || {}; } catch { return {}; } };
  const saveHistory = (h) => localStorage.setItem(histKey(), JSON.stringify(h));

  function update() {
    const now = Date.now(), seen = new Set(), h = history();
    for (const m of S.markers) {
      if (!EV[m.type]) continue;
      seen.add(m.id);
      if (!live.has(m.id)) {
        live.set(m.id, { type: m.type, first: now, x: m.x, y: m.y });
        if (!S.firstMarkersSeen) continue; // events already up when Recon opened: start time unknown
        (h[m.type] ??= []).push(now); h[m.type] = h[m.type].slice(-12);
      }
      Object.assign(live.get(m.id), { x: m.x, y: m.y });
    }
    for (const id of [...live.keys()]) if (!seen.has(id)) live.delete(id);
    S.firstMarkersSeen = true;
    saveHistory(h);
    render();
  }

  function render() {
    const now = Date.now(), h = history(), rows = [];
    for (const [, e] of live) {
      const ev = EV[e.type], age = (now - e.first) / 1000;
      let timer = `${ago(now - e.first)} ago`;
      if (e.type === 6) timer = age < CRATE_SECONDS ? `~${mmss(CRATE_SECONDS - age)} left` : "should be open";
      rows.push(`<div class="ev-row"><i style="background:${ev.color}"></i><span>${ev.name}<small>${gridLabel(e.x, e.y)}</small></span><b>${timer}</b></div>`);
    }
    // last Cargo / Heli and a rough guess at the next one from past spawns
    for (const type of [5, 8]) {
      if ([...live.values()].some((e) => e.type === type)) continue;
      const t = h[type] ?? [];
      if (!t.length) continue;
      let next = "";
      if (t.length >= 3) {
        const gaps = t.slice(1).map((v, i) => v - t[i]).filter((g) => g > 20 * 60000).sort((a, b) => a - b);
        if (gaps.length) { const eta = t.at(-1) + gaps[Math.floor(gaps.length / 2)] - now; next = eta > 0 ? ` · next ~${ago(eta)}` : " · due any time"; }
      }
      rows.push(`<div class="ev-row past"><i style="background:${EV[type].color}"></i><span>${EV[type].name}<small>last seen</small></span><b>${ago(now - t.at(-1))} ago${next}</b></div>`);
    }
    $("#ev-card").hidden = !rows.length;
    $("#ev-card").innerHTML = `<h3>Events</h3>${rows.join("")}`;
  }
  setInterval(render, 1000);

  // ============================================================ deaths
  const DEATH_KEEP = 30 * 60000;
  const deaths = []; // { steamId, name, x, y, t }
  const lastPos = new Map(), wasAlive = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const m of S.team?.members ?? []) {
      if (m.isAlive && Number.isFinite(m.x)) lastPos.set(m.steamId, { x: m.x, y: m.y });
      if (wasAlive.get(m.steamId) === true && m.isAlive === false) {
        const p = Number.isFinite(m.x) ? { x: m.x, y: m.y } : lastPos.get(m.steamId);
        if (p) { deaths.push({ steamId: m.steamId, name: m.name, ...p, t: now }); draw(); }
      }
      wasAlive.set(m.steamId, m.isAlive);
    }
    while (deaths.length && deaths[0].t < now - DEATH_KEEP) deaths.shift();
  }, 2000);
  window.drawDeaths = () => {
    const now = Date.now();
    for (const d of deaths) {
      const [x, y] = toScreen(d.x, d.y), age = now - d.t;
      ctx.globalAlpha = Math.max(0.35, 1 - age / DEATH_KEEP);
      badge(x, y, 11, "#e879f9");
      ctx.strokeStyle = "#e879f9"; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
      labelBoxes.push({ x: x - 12, y: y - 12, w: 24, h: 24 });
      pill(reserveLabel(`${d.name} died ${ago(age)} ago`, x, y + 22, 10.5, true), "#e879f9");
      ctx.globalAlpha = 1;
    }
  };

  // ======================================================= day / night
  // Rust+ gives the in-game hour plus sunrise/sunset. Real time to the next
  // change is estimated from the day length (nights often run a bit faster).
  let time = null, timeAt = 0;
  async function pollTime() {
    if (!S.connected || S.demo) return renderClock();
    try { time = await invoke("get_time"); timeAt = Date.now(); } catch {}
    renderClock();
  }
  function renderClock() {
    const el = $("#srv-time");
    if (S.demo && !time) { time = { time: 19.4, sunrise: 7.5, sunset: 19.8, dayLengthMinutes: 60, timeScale: 1 }; timeAt = Date.now(); }
    if (!time) { el.hidden = true; return; }
    const realSecPerHour = ((time.dayLengthMinutes || 60) * 60) / 24;
    const now = (time.time + (Date.now() - timeAt) / 1000 / realSecPerHour) % 24;
    const night = now >= time.sunset || now < time.sunrise;
    const target = night ? time.sunrise : time.sunset;
    const hoursTo = (target - now + 24) % 24, realMin = Math.round((hoursTo * realSecPerHour) / 60);
    const hh = Math.floor(now), mm = Math.floor((now - hh) * 60);
    el.hidden = false;
    el.classList.toggle("night", night);
    el.textContent = `${night ? "Night" : "Day"} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    el.title = `${night ? "Light" : "Dark"} in about ${realMin} min (real time)\nSunrise ${fmtH(time.sunrise)} · Sunset ${fmtH(time.sunset)} in-game`;
  }
  const fmtH = (h) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;
  setInterval(pollTime, 60000);
  setInterval(renderClock, 10000);

  window.Events = {
    update,
    reset() { live.clear(); deaths.length = 0; S.firstMarkersSeen = false; time = null; renderClock(); render(); },
    onConnect() { pollTime(); },
  };
})();
