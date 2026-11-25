// Crafting and recycling calculator.
//  Craft:   add items and amounts, get total ingredients, crafting time and the
//           workbench level needed. "Raw materials" also breaks gunpowder and
//           explosives down into sulfur, charcoal and so on.
//  Recycle: add items and amounts, get the expected scrap and materials out
//           (normal recycler, or the 40% safe-zone recyclers at Outpost/Bandit).
(() => {
  const KEY = "recon.craft";
  const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
  const C = {
    mode: saved.mode || "craft",
    craft: saved.craft || [],
    recycle: saved.recycle || [],
    raw: saved.raw ?? true,
    safe: saved.safe ?? false,
  };
  const save = () => localStorage.setItem(KEY, JSON.stringify(C));
  const EXPAND = new Set(["gunpowder", "explosives"]); // intermediates worth breaking down
  const fmt = (n) => (Number.isInteger(n) ? n : Math.round(n * 10) / 10).toLocaleString("en-US");
  const fmtTime = (s) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`);
  const list = () => C[C.mode];

  function computeCraft() {
    const totals = new Map(), steps = [];
    let time = 0, wb = 0;
    const add = (id, n) => totals.set(id, (totals.get(id) || 0) + n);
    for (const { id, qty } of C.craft) {
      const r = DB.craft[id]; if (!r || qty <= 0) continue;
      const crafts = Math.ceil(qty / r.y);
      for (const [ing, q] of r.i) add(ing, q * crafts);
      time += crafts * r.t; wb = Math.max(wb, r.wb || 0);
    }
    // break intermediates down, using the combined amount so batches aren't wasted
    if (C.raw) {
      for (let guard = 0; guard < 10; guard++) {
        const ready = [...totals.keys()].filter((k) => EXPAND.has(DB.short(k)) && DB.craft[k]);
        const id = ready.find((k) => DB.short(k) !== "gunpowder") ?? ready[0]; // explosives first: they need gunpowder
        if (!id) break;
        const need = totals.get(id), r = DB.craft[id], crafts = Math.ceil(need / r.y);
        totals.delete(id);
        for (const [ing, q] of r.i) add(ing, q * crafts);
        time += crafts * r.t; wb = Math.max(wb, r.wb || 0);
        steps.push({ id, made: crafts * r.y, crafts });
      }
    }
    return { totals, steps, time, wb };
  }

  function computeRecycle() {
    const totals = new Map();
    for (const { id, qty } of C.recycle) {
      const r = DB.recycle[id]; if (!r || qty <= 0) continue;
      for (const [out, q, p] of C.safe ? r.s : r.r) totals.set(out, (totals.get(out) || 0) + qty * q * p);
    }
    return { totals };
  }

  function render() {
    $("#craft-mode").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === C.mode));
    $("#craft-q").placeholder = C.mode === "craft" ? "Add something to craft" : "Add something to recycle";
    $("#craft-opt").innerHTML = C.mode === "craft"
      ? `<label class="toggle"><input type="checkbox" id="opt-raw" ${C.raw ? "checked" : ""}><span></span>Break gunpowder and explosives down to raw materials</label>`
      : `<label class="toggle"><input type="checkbox" id="opt-safe" ${C.safe ? "checked" : ""}><span></span>Safe-zone recycler (Outpost, Bandit Camp: 40% instead of 60%)</label>`;

    const rows = list();
    $("#craft-list").innerHTML = rows.length ? rows.map((r, i) => {
      const rc = DB.craft[r.id];
      const note = C.mode === "craft" && rc
        ? [rc.y > 1 ? `${Math.ceil(r.qty / rc.y)} crafts of ${rc.y}` : "", rc.wb ? `WB ${rc.wb}` : "no workbench"].filter(Boolean).join(" · ")
        : "";
      return `<div class="craft-row" data-i="${i}">
        <input type="number" min="1" value="${r.qty}" class="craft-qty" />
        ${DB.icon(r.id)}
        <div class="raid-main"><div class="raid-name">${esc(DB.name(r.id))}</div>${note ? `<div class="muted small">${note}</div>` : ""}</div>
        <button class="raid-rm" data-rm title="Remove">✕</button>
      </div>`;
    }).join("") : `<div class="raid-empty">${C.mode === "craft" ? "Search an item above, like Rocket, AK-47 or Large Wood Box." : "Search an item above, like Gears, Tech Trash or Road Signs."}</div>`;

    if (!rows.length) { $("#craft-out").innerHTML = ""; return; }
    if (C.mode === "craft") {
      const { totals, steps, time, wb } = computeCraft();
      const mats = [...totals.entries()].sort((a, b) => b[1] - a[1]);
      $("#craft-out").innerHTML = `
        <div class="craft-sum">
          <div><span class="muted small">Craft time</span><b>${fmtTime(time)}</b></div>
          <div><span class="muted small">Workbench</span><b>${wb ? "Level " + wb : "None"}</b></div>
        </div>
        <div class="sec-label">You need</div>
        ${mats.map(([id, n]) => `<div class="cmp-row"><span class="with-ic">${DB.icon(id, "sm")}${esc(DB.name(id))}</span><b>${fmt(n)}</b></div>`).join("")}
        ${steps.length ? `<div class="sec-label">Crafted along the way</div>${steps.map((s) => `<div class="cmp-row"><span class="with-ic">${DB.icon(s.id, "sm")}${esc(DB.name(s.id))}</span><b>${fmt(s.made)}</b></div>`).join("")}` : ""}`;
    } else {
      const { totals } = computeRecycle();
      const scrapId = DB.byShort("scrap");
      const scrap = totals.get(scrapId) || 0;
      totals.delete(scrapId);
      const mats = [...totals.entries()].sort((a, b) => b[1] - a[1]);
      $("#craft-out").innerHTML = `
        <div class="craft-sum single"><div class="scrap-sum">${DB.icon(scrapId, "lg")}<div><span class="muted small">Scrap</span><b class="accent">${fmt(scrap)}</b></div></div></div>
        <div class="sec-label">You get</div>
        ${mats.length ? mats.map(([id, n]) => `<div class="cmp-row"><span class="with-ic">${DB.icon(id, "sm")}${esc(DB.name(id))}</span><b>${fmt(n)}</b></div>`).join("") : `<div class="muted small">Only scrap.</div>`}
        <p class="muted small raid-note">Average amounts. Items with a random chance show the expected value.</p>`;
    }
  }

  DB.ready.then(() => {
    const input = $("#craft-q");
    itemPicker(input, {
      filter: (id) => (C.mode === "craft" ? DB.craft[id] : DB.recycle[id]),
      onPick: (it) => {
        const ex = list().find((r) => r.id === it.id);
        if (ex) ex.qty += 1; else list().push({ id: it.id, qty: 1 });
        input.value = ""; save(); render();
      },
    });
    $("#craft-mode").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b) { C.mode = b.dataset.mode; save(); render(); } };
    $("#craft-opt").onchange = (e) => {
      if (e.target.id === "opt-raw") C.raw = e.target.checked;
      if (e.target.id === "opt-safe") C.safe = e.target.checked;
      save(); render();
    };
    $("#craft-list").addEventListener("change", (e) => {
      if (!e.target.classList.contains("craft-qty")) return;
      const i = +e.target.closest(".craft-row").dataset.i;
      list()[i].qty = Math.max(1, Math.floor(+e.target.value || 1));
      save(); render();
    });
    $("#craft-list").addEventListener("click", (e) => {
      if (!e.target.closest("[data-rm]")) return;
      list().splice(+e.target.closest(".craft-row").dataset.i, 1);
      save(); render();
    });
    $("#craft-clear").onclick = () => { C[C.mode] = []; save(); render(); };
    render();
  });
})();
