// Extras: raid alarm siren, alerts settings (phone push via ntfy, upkeep),
// wipe countdown, upkeep badge, teammate trails, and shared base markers.
(() => {
  const fmtLeft = (sec) => {
    if (sec <= 0) return "now";
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };
  let settings = {};

  // ================================================================ siren
  let audio = null, sirenTimer = null, titleTimer = null;
  function startSiren() {
    if (settings.siren === false) return;
    stopSirenSound();
    try {
      audio = new AudioContext();
      const gain = audio.createGain(); gain.gain.value = 0.22; gain.connect(audio.destination);
      const osc = audio.createOscillator(); osc.type = "sawtooth"; osc.connect(gain); osc.start();
      const sweep = () => {
        const t = audio.currentTime;
        osc.frequency.cancelScheduledValues(t);
        osc.frequency.setValueAtTime(620, t);
        osc.frequency.linearRampToValueAtTime(1250, t + 0.45);
        osc.frequency.linearRampToValueAtTime(620, t + 0.9);
      };
      sweep(); sirenTimer = setInterval(sweep, 900);
    } catch {}
  }
  function stopSirenSound() { clearInterval(sirenTimer); sirenTimer = null; try { audio?.close(); } catch {} audio = null; }

  function showAlarm({ title, message, serverId }) {
    const srv = S.servers.find((s) => s.id === serverId);
    $("#alarm-title").textContent = title || "Smart Alarm";
    $("#alarm-sub").textContent = [message, srv?.name, new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })].filter(Boolean).join(" · ");
    $("#alarm-overlay").hidden = false;
    startSiren();
    const base = "Recon";
    clearInterval(titleTimer);
    let on = false; titleTimer = setInterval(() => { document.title = (on = !on) ? "🚨 RAID ALARM" : base; }, 700);
  }
  function dismissAlarm() {
    $("#alarm-overlay").hidden = true;
    stopSirenSound();
    clearInterval(titleTimer); document.title = "Recon";
  }
  $("#alarm-dismiss").onclick = dismissAlarm;
  listen("alarm", ({ payload }) => showAlarm(payload));

  // ======================================================= alerts panel
  async function loadSettings() {
    try { settings = await invoke("get_settings"); } catch { settings = {}; }
    renderAlerts();
    renderPill();
  }
  async function saveSettings(patch) {
    try { settings = await invoke("set_settings", patch); } catch (e) { toast("Couldn't save", String(e), "bad"); }
    renderAlerts(); renderPill();
  }
  function renderAlerts() {
    const s = settings;
    $("#al-phone").checked = !!s.ntfyEnabled;
    $("#al-siren").checked = s.siren !== false;
    $("#al-topic").textContent = s.ntfyTopic || "…";
    $("#al-phone-setup").hidden = !s.ntfyEnabled;
    $("#al-upkeep").value = String(s.upkeepWarnHours ?? 6);
    $("#al-wipe").value = s.wipePeriod || "auto";
    const list = [...upkeepList.values()];
    $("#al-upkeep-list").innerHTML = list.length
      ? list.map((u) => `<div class="cmp-row"><span>${esc(u.name)}</span><b class="${u.left < (s.upkeepWarnHours ?? 6) * 3600 ? "warn" : ""}">${u.left <= 0 ? "Decaying" : fmtLeft(u.left - (Date.now() - u.at) / 1000)}</b></div>`).join("")
      : `<div class="muted small">No Storage Monitor on a tool cupboard yet. In game, place one on your TC, hold E on it and choose Pair.</div>`;
  }
  $("#al-phone").onchange = (e) => saveSettings({ ntfyEnabled: e.target.checked });
  $("#al-siren").onchange = (e) => saveSettings({ siren: e.target.checked });
  $("#al-upkeep").onchange = (e) => saveSettings({ upkeepWarnHours: Number(e.target.value) });
  $("#al-wipe").onchange = (e) => saveSettings({ wipePeriod: e.target.value });
  $("#al-copy").onclick = () => { navigator.clipboard?.writeText(settings.ntfyTopic || ""); toast("Copied", "Paste it into the ntfy app."); };
  $("#al-test-phone").onclick = async () => {
    try { await invoke("test_phone_alert"); toast("Test sent", "Check your phone.", "ok"); } catch (e) { toast("Test failed", String(e), "bad"); }
  };
  $("#al-test-siren").onclick = () => showAlarm({ title: "Test alarm", message: "This is what a raid alarm looks like" });
  $("#al-new-topic").onclick = () => { if (confirm("Make a new private channel name? You'll need to subscribe to the new one in the ntfy app.")) saveSettings({ newTopic: true }); };

  // ============================================================== upkeep
  const upkeepList = new Map();
  listen("upkeep", ({ payload }) => { upkeepList.clear(); for (const u of payload) upkeepList.set(u.entityId, u); renderPill(); renderAlerts(); });
  listen("upkeep-warning", ({ payload }) => toast(`Low upkeep: ${payload.name}`, payload.left <= 0 ? "Your base is decaying." : `Runs out in ${fmtLeft(payload.left)}.`, "bad"));

  // ======================================================= wipe countdown
  // Next wipe = whichever comes first: the server's own schedule (period from
  // its description, counted from the last wipe) or the monthly forced wipe
  // (first Thursday of the month, 19:00 London time).
  function londonOffsetMin(date) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(date).map((x) => [x.type, x.value]));
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
    return Math.round((asUTC - date.getTime()) / 60000);
  }
  function forcedWipeAfter(now) {
    for (let k = 0; k < 3; k++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1, 19, 0));
      while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1); // first Thursday
      const t = d.getTime() - londonOffsetMin(d) * 60000; // 19:00 London -> UTC
      if (t > now.getTime()) return t;
    }
    return null;
  }
  function wipePeriodDays() {
    const p = settings.wipePeriod || "auto";
    if (p !== "auto") return { weekly: 7, biweekly: 14, monthly: 0 }[p] ?? 0;
    const desc = (S.servers.find((s) => s.id === S.active)?.desc || S.info?.name || "").toLowerCase();
    if (/bi-?weekly|every (two|2) weeks|twice (a|per) month|fortnight/.test(desc)) return 14;
    if (/twice (a|per) week|2x ?week|semi-?weekly/.test(desc)) return 3.5;
    if (/weekly|every week|1x ?week|wipes? (every )?(mon|tue|wed|thu|fri|sat|sun)/.test(desc)) return 7;
    if (/monthly/.test(desc)) return 0;
    return 7; // most community servers wipe weekly
  }
  function nextWipe() {
    if (!S.info?.wipeTime) return null;
    const now = Date.now(), last = S.info.wipeTime * 1000, days = wipePeriodDays();
    let sched = null;
    if (days) { sched = last; while (sched <= now) sched += days * 86400000; }
    const forced = forcedWipeAfter(new Date(now));
    const next = [sched, forced].filter(Boolean).sort((a, b) => a - b)[0];
    return { next, forced, sched, last, isForced: next === forced };
  }

  function renderPill() {
    const w = nextWipe(), wEl = $("#srv-wipe");
    if (w?.next) {
      wEl.hidden = false;
      wEl.textContent = `Wipe ${fmtLeft((w.next - Date.now()) / 1000)}`;
      const when = (t) => new Date(t).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      wEl.title = [`Last wipe ${fmtLeft((Date.now() - w.last) / 1000)} ago`, w.sched ? `Next scheduled wipe: ${when(w.sched)}` : null, w.forced ? `Forced wipe: ${when(w.forced)}` : null].filter(Boolean).join("\n");
    } else wEl.hidden = true;

    const uEl = $("#srv-upkeep"), list = [...upkeepList.values()];
    if (list.length) {
      const u = list.reduce((a, b) => (a.left < b.left ? a : b));
      const left = u.left - (Date.now() - u.at) / 1000;
      uEl.hidden = false;
      uEl.textContent = left <= 0 ? "TC decaying" : `TC ${fmtLeft(left)}`;
      uEl.classList.toggle("warn", left < (settings.upkeepWarnHours ?? 6) * 3600);
      uEl.title = list.map((x) => `${x.name}: ${fmtLeft(x.left - (Date.now() - x.at) / 1000)} of upkeep`).join("\n");
    } else uEl.hidden = true;
  }
  setInterval(renderPill, 30000);

  // ============================================================== trails
  const TRAIL_MS = 5 * 60 * 1000;
  const trails = new Map(); // steamId -> [{t, x, y}]
  setInterval(() => {
    const now = Date.now();
    for (const m of S.team?.members ?? []) {
      if (!m.isOnline || !m.isAlive) { trails.delete(m.steamId); continue; }
      const tr = trails.get(m.steamId) ?? [];
      const last = tr.at(-1);
      if (!last || Math.hypot(last.x - m.x, last.y - m.y) > 2) tr.push({ t: now, x: m.x, y: m.y });
      while (tr.length && tr[0].t < now - TRAIL_MS) tr.shift();
      trails.set(m.steamId, tr);
    }
  }, 2000);
  window.drawTrails = () => {
    if (!S.map) return;
    const now = Date.now();
    (S.team?.members ?? []).forEach((m, i) => {
      const tr = trails.get(m.steamId);
      if (!tr || tr.length < 2) return;
      const color = MATE_COLORS[i % MATE_COLORS.length];
      ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = 3.5;
      for (let k = 1; k < tr.length; k++) {
        const age = (now - tr[k].t) / TRAIL_MS; // 0 new .. 1 old
        const [x0, y0] = toScreen(tr[k - 1].x, tr[k - 1].y), [x1, y1] = toScreen(tr[k].x, tr[k].y);
        ctx.strokeStyle = color; ctx.globalAlpha = Math.max(0.08, 0.7 * (1 - age));
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  };
  // keep trails flowing on screen between team updates
  setInterval(() => { if (trails.size) draw(); }, 5000);

  // ============================================================ map pins
  const PIN_STYLE = {
    base: { color: "#3fd0ff", name: "Our base", glyph: (x, y) => { ctx.beginPath(); ctx.moveTo(x - 6, y + 1); ctx.lineTo(x, y - 6); ctx.lineTo(x + 6, y + 1); ctx.lineTo(x + 4, y + 1); ctx.lineTo(x + 4, y + 6); ctx.lineTo(x - 4, y + 6); ctx.lineTo(x - 4, y + 1); ctx.closePath(); ctx.fill(); } },
    enemy: { color: "#e879f9", name: "Enemy base", glyph: (x, y) => { ctx.lineWidth = 2.2; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.moveTo(x - 8, y); ctx.lineTo(x - 2.5, y); ctx.moveTo(x + 2.5, y); ctx.lineTo(x + 8, y); ctx.moveTo(x, y - 8); ctx.lineTo(x, y - 2.5); ctx.moveTo(x, y + 2.5); ctx.lineTo(x, y + 8); ctx.stroke(); } },
    loot: { color: "#f2cf63", name: "Loot", glyph: (x, y) => { ctx.beginPath(); ctx.roundRect(x - 6, y - 4.5, 12, 9, 1.5); ctx.fill(); ctx.fillStyle = "#0d1520"; ctx.fillRect(x - 6, y - 1, 12, 1.6); } },
    note: { color: "#cbd5e1", name: "Note", glyph: (x, y) => { ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); } },
  };
  let pins = [];
  const setPins = (list) => { pins = list || []; draw(); };
  listen("pins-changed", ({ payload }) => setPins(payload));
  window.drawPins = () => {
    for (const p of pins) {
      const st = PIN_STYLE[p.kind] ?? PIN_STYLE.note, [x, y] = toScreen(p.x, p.y);
      badge(x, y, 13, st.color);
      ctx.fillStyle = st.color; ctx.strokeStyle = st.color; st.glyph(x, y);
      labelBoxes.push({ x: x - 13, y: y - 13, w: 26, h: 26 });
      const b = reserveLabel(p.label || st.name, x, y + 25, 10.5, true); // below the icon, always shown
      pill(b, st.color);
    }
  };
  window.Pins = {
    kinds: PIN_STYLE,
    near: (wx, wy, r = 40) => pins.filter((p) => Math.hypot(p.x - wx, p.y - wy) < r).sort((a, b) => Math.hypot(a.x - wx, a.y - wy) - Math.hypot(b.x - wx, b.y - wy))[0],
    async add(kind, wx, wy) {
      const label = prompt(`Label for this ${PIN_STYLE[kind].name.toLowerCase()} marker (optional):`, "") ?? null;
      if (label === null) return;
      if (S.demo) return setPins([...pins, { kind, label, x: Math.round(wx), y: Math.round(wy), by: "you", ts: Date.now() }]);
      try { setPins(await invoke("add_pin", { kind, label, x: wx, y: wy })); toast("Marker added", "Shared with your team"); }
      catch (e) { toast("Couldn't add marker", String(e), "bad"); }
    },
    async remove(p) {
      if (S.demo) return setPins(pins.filter((q) => q !== p));
      try { setPins(await invoke("remove_pin", { x: p.x, y: p.y })); } catch (e) { toast("Couldn't remove marker", String(e), "bad"); }
    },
    async load() { try { setPins(await invoke("get_pins")); } catch { setPins([]); } },
    reset: () => { setPins([]); trails.clear(); upkeepList.clear(); renderPill(); },
    onConnect() { this.load(); invoke("get_upkeep").then((l) => { upkeepList.clear(); for (const u of l) upkeepList.set(u.entityId, u); renderPill(); renderAlerts(); }).catch(() => {}); renderPill(); },
    renderPill,
  };

  // ============================================================= updates
  function renderUpdate(u) {
    if (!u) return;
    $("#up-version").textContent = u.current ?? "–";
    $("#up-auto").checked = u.autoUpdate !== false;
    $("#up-status").textContent = u.status || "";
    $("#up-install").hidden = !u.info?.available;
    if (u.info?.available) $("#up-install").textContent = `Install ${u.info.latest}`;
  }
  async function loadUpdate() { try { renderUpdate(await invoke("get_update")); } catch {} }
  $("#up-check").onclick = async () => { try { renderUpdate(await invoke("check_update")); } catch (e) { toast("Update check failed", String(e), "bad"); } };
  $("#up-install").onclick = async () => { try { await invoke("install_update"); } catch (e) { toast("Update failed", String(e), "bad"); } };
  $("#up-auto").onchange = async (e) => { await saveSettings({ autoUpdate: e.target.checked }); loadUpdate(); };
  listen("update", ({ payload }) => renderUpdate({ ...payload, current: $("#up-version").textContent, autoUpdate: $("#up-auto").checked }));
  listen("updated", ({ payload }) => {
    toast(`Recon updated to ${payload.version}`, "Reloading in a moment…", "ok");
    setTimeout(() => location.reload(), 5000);
  });
  loadUpdate();

  loadSettings();
})();
