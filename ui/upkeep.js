// Upkeep calculator (Craft and recycle → Upkeep). Count your building blocks by
// tier; Recon works out the daily upkeep and how long your tool cupboard lasts.
//
// Rust charges a share of each block's build cost per 24 hours, rising with base
// size: blocks 1-15 at 10%, 16-65 at 15%, 66-190 at 20%, 190+ at 33.3%.
// Build costs from the Rust wiki (stone wall 300 stone, floor 150, doorway 210...).
(() => {
  const TIERS = [
    { id: "wood", name: "Wood", res: "wood", label: "wood" },
    { id: "stone", name: "Stone", res: "stones", label: "stone" },
    { id: "metal", name: "Sheet metal", res: "metal.fragments", label: "metal frags" },
    { id: "hqm", name: "Armored", res: "metal.refined", label: "HQM" },
  ];
  const KINDS = [
    { id: "full", name: "Foundations and walls", cost: { wood: 200, stone: 300, metal: 200, hqm: 25 } },
    { id: "door", name: "Doorways and windows", cost: { wood: 140, stone: 210, metal: 140, hqm: 18 } },
    { id: "half", name: "Floors, triangles, frames", cost: { wood: 100, stone: 150, metal: 100, hqm: 13 } },
  ];
  const BRACKETS = [[15, 0.10], [50, 0.15], [125, 0.20], [Infinity, 0.333]]; // block counts per bracket
  const KEY = "recon.upkeep";
  const U = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
  U.blocks ??= {}; U.tc ??= { wood: 0, stone: 0, metal: 0, hqm: 0 };
  const save = () => localStorage.setItem(KEY, JSON.stringify(U));
  const fmt = (n) => Math.round(n).toLocaleString("en-US");

  /** average tax rate for a base of n blocks (brackets applied in order) */
  function taxRate(n) {
    let left = n, paid = 0;
    for (const [count, rate] of BRACKETS) { const k = Math.min(left, count); paid += k * rate; left -= k; if (left <= 0) break; }
    return n ? paid / n : 0;
  }
  function compute() {
    let n = 0;
    for (const t of TIERS) for (const k of KINDS) n += Number(U.blocks[`${t.id}.${k.id}`] || 0);
    const rate = taxRate(n), daily = {};
    for (const t of TIERS) {
      let cost = 0;
      for (const k of KINDS) cost += Number(U.blocks[`${t.id}.${k.id}`] || 0) * k.cost[t.id];
      daily[t.id] = cost * rate;
    }
    return { n, rate, daily };
  }
  const bracketText = (n) => (n <= 15 ? "1–15 blocks: 10%" : n <= 65 ? "16–65 blocks: up to 15%" : n <= 190 ? "66–190 blocks: up to 20%" : "190+ blocks: up to 33%");

  const dur = (h) => (h === Infinity ? "forever" : h >= 48 ? `${Math.floor(h / 24)}d ${Math.round(h % 24)}h` : `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`);

  // inputs (block counts, TC contents) render once; typing only refreshes the results
  function renderInputs() {
    $("#upkeep-grid").innerHTML = `
      <div class="ug-head"><span></span>${KINDS.map((k) => `<span>${k.name}</span>`).join("")}</div>
      ${TIERS.map((t) => `<div class="ug-row"><span class="with-ic">${DB.iconShort(t.res, t.name, "sm")}${t.name}</span>${KINDS.map((k) =>
        `<input type="number" min="0" data-b="${t.id}.${k.id}" value="${U.blocks[`${t.id}.${k.id}`] || ""}" placeholder="0">`).join("")}</div>`).join("")}`;
    const live = window.Stash?.tc();
    $("#upkeep-tc-label").innerHTML = `Your tool cupboard ${live ? `<span>live from ${esc(live.name)}</span>` : ""}`;
    $("#upkeep-tc").innerHTML = live
      ? `<div class="ug-tc live">${TIERS.map((t) => `<span>${DB.iconShort(t.res, t.name, "xs")}${fmt(live[t.id])}</span>`).join("")}</div>`
      : `<div class="ug-tc">${TIERS.map((t) => `<label title="${t.label} in your TC">${DB.iconShort(t.res, t.name, "xs")}<input type="number" min="0" data-tc="${t.id}" value="${U.tc[t.id] || ""}" placeholder="0"></label>`).join("")}</div>
         <div class="muted small ug-note">Type what's in your TC, or put a Storage Monitor on it to fill this in automatically.</div>`;
  }
  function renderResults() {
    const { n, rate, daily } = compute();
    const live = window.Stash?.tc();
    const tc = live ? live : U.tc;
    const used = TIERS.filter((t) => daily[t.id] > 0);
    const lasts = used.map((t) => ({ t, h: daily[t.id] ? (tc[t.id] / daily[t.id]) * 24 : Infinity }));
    const first = lasts.reduce((x, y) => (y.h < (x?.h ?? Infinity) ? y : x), null);
    $("#upkeep-out").innerHTML = n ? `
      <div class="craft-sum">
        <div><span class="muted small">Blocks</span><b>${n}</b></div>
        <div><span class="muted small">Upkeep tax</span><b>${Math.round(rate * 100)}%</b></div>
      </div>
      <div class="muted small ug-note">${bracketText(n)} of each block's cost, every 24 hours.</div>
      <div class="sec-label">Per day</div>
      ${used.map((t) => `<div class="cmp-row"><span class="with-ic">${DB.iconShort(t.res, t.name, "sm")}${t.label}</span><b>${fmt(daily[t.id])}</b></div>`).join("")}`
      : `<div class="raid-empty">Enter how many building blocks your base has of each tier. Foundations and walls are full blocks; floors, triangles and wall frames are half blocks.</div>`;
    $("#upkeep-lasts").innerHTML = n && used.length ? `
      <div class="ug-lasts ${first && first.h < 24 ? "warn" : ""}">Lasts <b>${dur(first.h)}</b>${first && first.h !== Infinity ? ` <span class="muted">(${first.t.label} runs out first)</span>` : ""}</div>
      <div class="muted small ug-note">For a full week, keep about ${used.map((t) => `<b>${fmt(daily[t.id] * 7)}</b> ${t.label}`).join(", ")} in the TC.</div>` : "";
  }

  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset?.b) { U.blocks[t.dataset.b] = Math.max(0, Math.floor(+t.value || 0)); save(); renderResults(); }
    if (t.dataset?.tc) { U.tc[t.dataset.tc] = Math.max(0, Math.floor(+t.value || 0)); save(); renderResults(); }
  });

  window.Upkeep = {
    render() {
      if (!$("#upkeep-box") || $("#upkeep-box").hidden) return;
      if (!document.activeElement?.closest?.("#upkeep-box")) renderInputs(); // don't rebuild under the user's cursor
      renderResults();
    },
  };
})();
