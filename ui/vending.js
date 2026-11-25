// Vending search: find which vending machines sell (or buy) an item, sorted by
// price per unit, with matching shops highlighted on the map. Watched items
// raise an alert when a shop starts selling them.
(() => {
  const WKEY = "recon.watch";
  const V = {
    q: "",
    mode: "sell", // sell = shops selling the item; buy = shops paying with it
    watch: (() => { try { return JSON.parse(localStorage.getItem(WKEY)) || []; } catch { return []; } })(),
    seen: null, // Set of "shop|item" seen in stock, for watch alerts
  };
  const saveWatch = () => localStorage.setItem(WKEY, JSON.stringify(V.watch));
  const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString("en-US");
  const shops = () => S.markers.filter((m) => m.type === 3);

  function orders() {
    const out = [];
    for (const s of shops()) for (const o of s.sellOrders ?? []) out.push({ shop: s, o, item: DB.name(o.itemId), cur: DB.name(o.currencyId) });
    return out;
  }

  function render() {
    const all = orders(), q = V.q.trim().toLowerCase();
    const list = $("#shop-results");
    $("#shop-mode").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === V.mode));
    const watched = V.watch.includes(V.q.trim());
    $("#shop-watch").hidden = !q;
    $("#shop-watch").classList.toggle("on", watched);

    // connected, but the server sends no vending machines at all: say so up front
    const noShops = S.connected && !S.demo && shops().length === 0;
    $("#shop-notice").hidden = !noShops;
    $("#shop-search-area").hidden = noShops;
    if (noShops) { S.shopMatch = null; list.innerHTML = ""; draw(); return; }
    $("#shop-watch").title = watched ? "Stop alerts for this item" : "Alert me when a shop starts selling this";

    if (!q) {
      S.shopMatch = null;
      const ss = shops(), open = ss.filter((s) => !s.outOfStock).length;
      const counts = new Map();
      for (const r of all) if (r.o.amountInStock > 0) counts.set(r.item, (counts.get(r.item) || 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
      list.innerHTML = ss.length ? `
        <div class="shop-stats"><div><b>${ss.length}</b><span>vending machines</span></div><div><b>${open}</b><span>with stock</span></div><div><b>${all.length}</b><span>listings</span></div></div>
        <div class="sec-label">Most listed right now</div>
        <div class="chip-cloud">${top.map(([n, c]) => `<button data-q="${esc(n)}">${esc(n)} <small>${c}</small></button>`).join("")}</div>
        ${V.watch.length ? `<div class="sec-label">Watching</div><div class="chip-cloud">${V.watch.map((n) => `<button data-q="${esc(n)}" class="watch">${esc(n)}</button>`).join("")}</div>` : ""}`
        : `<div class="raid-empty">${S.connected ? "This server isn't showing any vending machines through Rust+ right now. Only player shops with <b>Broadcast</b> turned on appear (Outpost and Bandit Camp vendors never do), and some servers hide them completely." : "Connect to a server to search its shops."}</div>`;
      draw();
      return;
    }

    const hits = all.filter((r) => (V.mode === "sell" ? r.item : r.cur).toLowerCase().includes(q));
    S.shopMatch = new Set(hits.map((r) => r.shop.id));
    hits.sort((a, b) => (b.o.amountInStock > 0) - (a.o.amountInStock > 0) || (a.cur !== "Scrap") - (b.cur !== "Scrap") || a.cur.localeCompare(b.cur) || a.o.costPerItem / a.o.quantity - b.o.costPerItem / b.o.quantity);
    const best = new Map();
    for (const r of hits) if (r.o.amountInStock > 0 && !best.has(r.item + "|" + r.cur)) best.set(r.item + "|" + r.cur, r);
    list.innerHTML = hits.length ? `<div class="muted small shop-count">${hits.length} listing${hits.length === 1 ? "" : "s"} in ${S.shopMatch.size} shop${S.shopMatch.size === 1 ? "" : "s"}</div>` + hits.map((r) => {
      const o = r.o, out = o.amountInStock <= 0, isBest = best.get(r.item + "|" + r.cur) === r;
      const cond = o.itemConditionMax ? ` · ${Math.round((o.itemCondition / o.itemConditionMax) * 100)}%` : "";
      return `<button class="shop-row ${out ? "out" : ""}" data-shop="${r.shop.id}">
        <div class="sr-top"><span class="sr-item with-ic">${DB.icon(o.itemId, "sm")}${fmt(o.quantity)} × ${esc(r.item)}${o.itemIsBlueprint ? " <em>BP</em>" : ""}</span>${isBest ? `<span class="tag ok">Best</span>` : ""}</div>
        <div class="sr-price with-ic">${DB.icon(o.currencyId, "xs")}for <b>${fmt(o.costPerItem)} ${esc(r.cur)}</b>${o.currencyIsBlueprint ? " BP" : ""} <span class="muted">· ${fmt(o.costPerItem / o.quantity)} each</span></div>
        <div class="sr-meta"><span>${esc(r.shop.name || "Vending machine")}</span><span>${gridLabel(r.shop.x, r.shop.y)}${cond} · ${out ? "out of stock" : `${o.amountInStock} in stock`}</span></div>
      </button>`;
    }).join("") : `<div class="raid-empty">Nobody is ${V.mode === "sell" ? "selling" : "buying with"} “${esc(V.q)}” right now.${watched ? "" : " Tap the bell to get an alert when someone does."}</div>`;
    draw();
  }

  // alerts for watched items
  function checkWatch() {
    const now = new Set();
    for (const r of orders()) if (r.o.amountInStock > 0) now.add(r.shop.id + "|" + r.item);
    if (V.seen) for (const key of now) {
      if (V.seen.has(key)) continue;
      const [sid, item] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
      if (!V.watch.some((w) => item.toLowerCase().includes(w.toLowerCase()))) continue;
      const s = shops().find((x) => String(x.id) === sid);
      toast(`${item} for sale`, `${s?.name || "Vending machine"} at ${s ? gridLabel(s.x, s.y) : "?"}`, "ok");
    }
    V.seen = now;
  }

  // ------------------------------------------------------------- events
  const input = $("#shop-q");
  itemPicker(input, {
    placeholder: "Search an item, like Sulfur or AK",
    filter: (id) => orders().some((r) => String(V.mode === "sell" ? r.o.itemId : r.o.currencyId) === String(id)),
    onPick: (it) => { input.value = it.name; V.q = it.name; render(); },
  });
  input.addEventListener("input", () => { V.q = input.value; render(); });
  $("#shop-mode").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b) { V.mode = b.dataset.mode; render(); } };
  $("#shop-watch").onclick = () => {
    const n = V.q.trim(); if (!n) return;
    V.watch = V.watch.includes(n) ? V.watch.filter((w) => w !== n) : [...V.watch, n];
    saveWatch(); render();
    if (V.watch.includes(n)) toast("Watching " + n, "You'll get an alert when a shop starts selling it.");
  };
  $("#shop-results").onclick = (e) => {
    const chip = e.target.closest("[data-q]");
    if (chip) { input.value = chip.dataset.q; V.q = chip.dataset.q; render(); return; }
    const row = e.target.closest("[data-shop]");
    if (row) {
      const s = shops().find((x) => String(x.id) === row.dataset.shop);
      if (s) { S.shopFocus = s.id; centerOn(s.x, s.y, Math.max(S.view.scale, 2)); setTimeout(() => { if (S.shopFocus === s.id) { S.shopFocus = null; draw(); } }, 4000); }
    }
  };

  window.Vending = {
    update() { checkWatch(); if (!$("#tab-shops").classList.contains("active") && !V.q) return; render(); },
    render,
    clear() { V.q = ""; input.value = ""; S.shopMatch = null; },
  };
  render();
})();
