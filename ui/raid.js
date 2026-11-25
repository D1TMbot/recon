// Raid planner: build a raid path (walls, doors, deployables), pick which
// explosives you're willing to use, and get the cheapest-sulfur mix.
//
// Data: HP and per-hit damage (hard side) from the Rust wiki (wiki.rustclash.com),
// read 2026-11-24. Mixes are solved exactly from damage vs HP, so they match
// in-game combos like "1 rocket + 2 C4" rather than just picking one explosive.
(() => {
  const EXPLOSIVES = [
    { id: "rocket", name: "Rocket", short: "rocket", sulfur: 1400 },
    { id: "c4", name: "C4", short: "C4", sulfur: 2200 },
    { id: "satchel", name: "Satchel", short: "satchel", sulfur: 480 },
    { id: "explo", name: "Explo ammo", short: "explo", sulfur: 25 },
    { id: "beancan", name: "Beancan", short: "beancan", sulfur: 120 },
    { id: "hv", name: "HV rocket", short: "HV rocket", sulfur: 200 },
    { id: "propane", name: "Propane bomb", short: "propane bomb", sulfur: 900 },
  ];
  const EX = Object.fromEntries(EXPLOSIVES.map((e, i) => [e.id, { ...e, i }]));

  // damage per hit: [rocket, c4, satchel, explo, beancan, hv, propane]; null = can't damage
  const D = {
    wood: [247.65, 495, 91.5, 5.7072, 19.5, 31.5, 144.15],
    stone: [137.65, 275, 51.5, 2.904, 11, 16.5, 80.15],
    metal: [137.575, 275, 43.5, 2.508, 9, 15.0075, 80.075],
    door: [220.375, 440, 70, 4.0064, 14.5, 24, 128.375],
    woodDoor: [550.375, 1100, 170, 11.016, 35, 63.75, 320.375],
    woodBars: [247.65, 495, 91.5, 5.1072, 19.5, 29.25, 144.15],
    metalBars: [137.575, 275, 43.5, 2.506, 9, 15.0075, 80.075],
    hesw: [137.65, 275, 51.5, 2.704, 11, 15.75, 80.15],
  };
  const TARGETS = [
    { id: "wood_wall", cat: "Building", name: "Wood wall / floor", hp: 250, d: D.wood },
    { id: "stone_wall", cat: "Building", name: "Stone wall / floor", hp: 500, d: D.stone },
    { id: "metal_wall", cat: "Building", name: "Sheet metal wall / floor", hp: 1000, d: D.metal },
    { id: "armored_wall", cat: "Building", name: "Armored wall / floor", hp: 2000, d: D.metal },

    { id: "wood_door", cat: "Doors", name: "Wooden door", hp: 200, d: D.woodDoor },
    { id: "metal_door", cat: "Doors", name: "Sheet metal door", hp: 250, d: D.door },
    { id: "metal_double", cat: "Doors", name: "Double sheet metal door", hp: 250, d: D.door },
    { id: "ladder_hatch", cat: "Doors", name: "Ladder hatch", hp: 250, d: D.door },
    { id: "garage_door", cat: "Doors", name: "Garage door", hp: 600, d: D.door },
    { id: "armored_door", cat: "Doors", name: "Armored door", hp: 1000, d: D.door },
    { id: "armored_double", cat: "Doors", name: "Double armored door", hp: 1000, d: D.door },
    { id: "cell_gate", cat: "Doors", name: "Prison cell gate", hp: 300, d: D.door },
    { id: "chainlink_gate", cat: "Doors", name: "Chainlink fence gate", hp: 75, d: [275.375, 550, 85, 5.008, 17.5, 30, 160.375] },
    { id: "shop_front", cat: "Doors", name: "Metal shop front", hp: 750, d: [137.575, 275, 43.5, 2.506, null, 15.0075, 80.075] },

    { id: "wood_bars", cat: "Windows", name: "Wooden window bars", hp: 250, d: D.woodBars },
    { id: "metal_bars", cat: "Windows", name: "Metal window bars", hp: 500, d: D.metalBars },
    { id: "reinforced_window", cat: "Windows", name: "Reinforced glass window", hp: 500, d: D.metalBars },
    { id: "strengthened_window", cat: "Windows", name: "Strengthened glass window", hp: 350, d: D.metalBars },
    { id: "embrasure", cat: "Windows", name: "Metal embrasure", hp: 500, d: [138.25, 275, 41.5, 2.904, 8.5, 16.5, 80.75] },
    { id: "wood_shutters", cat: "Windows", name: "Wood shutters", hp: 200, d: [312.5, 550, 275, 9.008, 65, 195, 197.5] },

    { id: "hew", cat: "External", name: "High external wood wall", hp: 500, d: D.woodBars },
    { id: "hew_gate", cat: "External", name: "High external wood gate", hp: 500, d: D.woodBars },
    { id: "hesw", cat: "External", name: "High external stone wall", hp: 500, d: D.hesw },
    { id: "hesw_gate", cat: "External", name: "High external stone gate", hp: 500, d: D.hesw },

    { id: "tc", cat: "Deployables", name: "Tool cupboard", hp: 100, d: [550.375, 2200, 322, 11.016, null, 63.75, 320.375] },
    { id: "turret", cat: "Deployables", name: "Auto turret", hp: 1000, d: [312.5, 1100, 550, 9.008, null, 345, 197.5] },
    { id: "sam", cat: "Deployables", name: "SAM site", hp: 1000, d: [312.5, 1100, 550, 5.008, null, 30, 197.5] },
    { id: "vending", cat: "Deployables", name: "Vending machine", hp: 1250, d: [138.25, 275, 43.5, 2.508, null, 15.015, 80.75] },
  ];
  const T = Object.fromEntries(TARGETS.map((t) => [t.id, t]));
  const CATS = [...new Set(TARGETS.map((t) => t.cat))];

  // ---------------------------------------------------------------- solver
  // Unbounded knapsack: cheapest sulfur so that total damage >= HP.
  // Damage is in thousandths of a hit point so the counts match the wiki exactly.
  // Ties go to the plan with fewer explosives.
  const memo = new Map();
  function solve(target, allowed) {
    const key = target.id + "|" + allowed.join(",");
    if (memo.has(key)) return memo.get(key);
    const items = allowed.map((id) => EX[id]).filter((e) => target.d[e.i]).map((e) => ({ id: e.id, dmg: Math.floor(target.d[e.i] * 1000), cost: e.sulfur * 1000 + 1 }));
    let result = null;
    if (items.length) {
      const H = Math.ceil(target.hp * 1000);
      const dp = new Float64Array(H + 1), pick = new Int8Array(H + 1);
      for (let h = 1; h <= H; h++) {
        let best = Infinity, bi = 0;
        for (let i = 0; i < items.length; i++) {
          const c = items[i].cost + dp[Math.max(0, h - items[i].dmg)];
          if (c < best) { best = c; bi = i; }
        }
        dp[h] = best; pick[h] = bi;
      }
      const mix = {};
      for (let h = H; h > 0; h = Math.max(0, h - items[pick[h]].dmg)) mix[items[pick[h]].id] = (mix[items[pick[h]].id] || 0) + 1;
      result = { mix, sulfur: Object.entries(mix).reduce((s, [id, n]) => s + n * EX[id].sulfur, 0) };
    }
    memo.set(key, result);
    return result;
  }

  // ----------------------------------------------------------------- state
  const KEY = "recon.raid";
  const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
  const R = {
    path: (saved.path || []).filter((p) => T[p.id]),
    allowed: saved.allowed || ["rocket", "c4", "satchel", "explo"],
    cat: CATS[0],
  };
  const save = () => localStorage.setItem(KEY, JSON.stringify({ path: R.path, allowed: R.allowed }));
  const fmt = (n) => n.toLocaleString("en-US");
  const mixText = (mix) => EXPLOSIVES.filter((e) => mix[e.id]).map((e) => `${mix[e.id]} ${e.short}${mix[e.id] > 1 && !/[o4]$/.test(e.short) ? "s" : ""}`).join(" + ");
  const plural = (e, n) => (n === 1 || e.id === "explo" || e.id === "c4" ? e.name : e.name + "s");

  // ---------------------------------------------------------------- render
  function render() {
    const total = {}; let sulfur = 0, impossible = false;
    $("#raid-path").innerHTML = R.path.length ? R.path.map((p, idx) => {
      const t = T[p.id], s = solve(t, R.allowed);
      if (!s) impossible = true;
      else { for (const [id, n] of Object.entries(s.mix)) total[id] = (total[id] || 0) + n * p.qty; sulfur += s.sulfur * p.qty; }
      return `<div class="raid-row" data-i="${idx}">
        <div class="raid-qty"><button data-act="dec">−</button><span>${p.qty}</span><button data-act="inc">+</button></div>
        <div class="raid-main"><div class="raid-name">${esc(t.name)}</div>
          <div class="raid-mix ${s ? "" : "bad"}">${s ? `${mixText(s.mix)} each` : "Can't be broken with the selected explosives"}</div></div>
        <div class="raid-cost">${s ? fmt(s.sulfur * p.qty) : "—"}</div>
        <button class="raid-rm" data-act="rm" title="Remove">✕</button>
      </div>`;
    }).join("") : `<div class="raid-empty">Add what's between you and their loot, like doors, walls and the TC.</div>`;

    $("#raid-sulfur").textContent = fmt(sulfur);
    $("#raid-items").innerHTML = EXPLOSIVES.filter((e) => total[e.id]).map((e) => `<div class="raid-pill"><b>${fmt(total[e.id])}</b> ${plural(e, total[e.id])}</div>`).join("")
      || `<div class="muted small">Nothing added yet</div>`;
    $("#raid-warn").hidden = !impossible;
    $("#raid-share").disabled = !sulfur;

    $("#raid-cats").innerHTML = CATS.map((c) => `<button data-cat="${c}" class="${c === R.cat ? "on" : ""}">${c}</button>`).join("");
    $("#raid-targets").innerHTML = TARGETS.filter((t) => t.cat === R.cat).map((t) => `<button data-add="${t.id}"><span>${esc(t.name)}</span><small>${fmt(t.hp)} HP</small></button>`).join("");
    $("#raid-explosives").innerHTML = EXPLOSIVES.map((e) => `<label><input type="checkbox" data-ex="${e.id}" ${R.allowed.includes(e.id) ? "checked" : ""}><span>${e.name}<small>${fmt(e.sulfur)}</small></span></label>`).join("");

    // what the whole path would cost using a single explosive type
    const rows = R.path.length ? EXPLOSIVES.map((e) => {
      let n = 0, s = 0;
      for (const p of R.path) {
        const r = solve(T[p.id], [e.id]);
        if (!r) return null;
        n += r.mix[e.id] * p.qty; s += r.sulfur * p.qty;
      }
      return { e, n, s };
    }).filter(Boolean).sort((a, b) => a.s - b.s) : [];
    $("#raid-compare").innerHTML = rows.map((r, i) => `<div class="cmp-row ${i === 0 ? "best" : ""}"><span>${fmt(r.n)} ${plural(r.e, r.n)}</span><b>${fmt(r.s)}</b></div>`).join("")
      || `<div class="muted small">Add targets to compare.</div>`;
  }

  // ----------------------------------------------------------------- events
  $("#raid-cats").onclick = (e) => { const b = e.target.closest("[data-cat]"); if (b) { R.cat = b.dataset.cat; render(); } };
  $("#raid-targets").onclick = (e) => {
    const b = e.target.closest("[data-add]"); if (!b) return;
    const ex = R.path.find((p) => p.id === b.dataset.add);
    if (ex) ex.qty++; else R.path.push({ id: b.dataset.add, qty: 1 });
    save(); render();
  };
  $("#raid-path").onclick = (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const i = +b.closest(".raid-row").dataset.i, p = R.path[i];
    if (b.dataset.act === "inc") p.qty++;
    if (b.dataset.act === "dec") p.qty--;
    if (b.dataset.act === "rm" || p.qty < 1) R.path.splice(i, 1);
    save(); render();
  };
  $("#raid-explosives").onchange = (e) => {
    const id = e.target.dataset.ex; if (!id) return;
    R.allowed = e.target.checked ? [...new Set([...R.allowed, id])] : R.allowed.filter((x) => x !== id);
    R.allowed.sort((a, b) => EX[a].i - EX[b].i);
    save(); render();
  };
  $("#raid-clear").onclick = () => { R.path = []; save(); render(); };
  $("#raid-share").onclick = async () => {
    const total = {}; let sulfur = 0;
    for (const p of R.path) { const s = solve(T[p.id], R.allowed); if (!s) continue; sulfur += s.sulfur * p.qty; for (const [id, n] of Object.entries(s.mix)) total[id] = (total[id] || 0) + n * p.qty; }
    const msg = `[Recon] Raid: ${EXPLOSIVES.filter((e) => total[e.id]).map((e) => `${total[e.id]} ${e.short}`).join(", ")} = ${fmt(sulfur)} sulfur`.slice(0, 128);
    try { await invoke("send_team_message", { message: msg }); toast("Sent to team chat", msg, "ok"); }
    catch (err) { navigator.clipboard?.writeText(msg); toast("Not connected", "Copied the plan to your clipboard instead.", ""); }
  };

  render();
  window.Raid = { solve, TARGETS, EXPLOSIVES, render };
})();
