// Rust item database (names, crafting recipes, recycle outputs), loaded from
// data/rust-db.json. See data/README.md for where the data comes from.
window.DB = (() => {
  const db = { items: {}, craft: {}, recycle: {} };
  const byShort = {};
  let list = [];
  const ready = fetch("data/rust-db.json").then((r) => r.json()).then((j) => {
    Object.assign(db, j);
    for (const [id, [, s]] of Object.entries(db.items)) byShort[s] = id;
    list = Object.entries(db.items).map(([id, [name, short]]) => ({ id, name, short, lower: name.toLowerCase() }));
  });

  const name = (id) => db.items[id]?.[0] ?? `Item ${id}`;
  const short = (id) => db.items[id]?.[1] ?? "";
  /** Fuzzy-ish item search: prefix matches first, then word starts, then substrings. */
  function search(q, { filter, limit = 8 } = {}) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const it of list) {
      if (filter && !filter(it.id)) continue;
      let s = -1;
      if (it.lower === q) s = 0;
      else if (it.lower.startsWith(q)) s = 1;
      else if (it.lower.split(/[\s\-.(]+/).some((w) => w.startsWith(q))) s = 2;
      else if (it.lower.includes(q) || it.short.includes(q)) s = 3;
      if (s >= 0) scored.push([s, it.name.length, it]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, limit).map((x) => x[2]);
  }
  /** <img> for an item (Rust wiki item image), falling back to a letter badge. */
  function icon(id, cls = "") {
    const s = short(id), n = name(id);
    const letter = (n.replace(/[^A-Za-z0-9]/g, "")[0] || "?").toUpperCase();
    if (!s) return `<span class="item-ic letter ${cls}">${letter}</span>`;
    return `<img class="item-ic ${cls}" src="https://wiki.rustclash.com/img/items180/${encodeURIComponent(s)}.png" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;item-ic letter ${cls}&quot;>${letter}</span>'">`;
  }
  /** picture by Rust short name (for things that aren't looked up by id) */
  function iconShort(s, label = "?", cls = "") {
    const letter = (String(label).replace(/[^A-Za-z0-9]/g, "")[0] || "?").toUpperCase();
    return `<img class="item-ic ${cls}" src="https://wiki.rustclash.com/img/items180/${encodeURIComponent(s)}.png" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;item-ic letter ${cls}&quot;>${letter}</span>'">`;
  }
  return { ready, name, short, search, icon, iconShort, byShort: (s) => byShort[s], get craft() { return db.craft; }, get recycle() { return db.recycle; } };
})();

/** Small autocomplete for an <input>: calls onPick(item) when an item is chosen. */
function itemPicker(input, { filter, onPick, placeholder }) {
  const box = document.createElement("div");
  box.className = "ac-box"; box.hidden = true;
  input.parentElement.style.position = "relative";
  input.parentElement.appendChild(box);
  if (placeholder) input.placeholder = placeholder;
  let results = [], sel = 0;
  const show = () => {
    results = DB.search(input.value, { filter: filter && ((id) => filter(id)) });
    sel = 0;
    box.innerHTML = results.map((r, i) => `<button data-i="${i}" class="${i === sel ? "on" : ""}">${DB.icon(r.id, "sm")}<span>${esc(r.name)}</span></button>`).join("");
    box.hidden = !results.length;
  };
  const pick = (i) => { const r = results[i]; if (!r) return; box.hidden = true; onPick(r); };
  input.addEventListener("input", show);
  input.addEventListener("focus", () => input.value && show());
  input.addEventListener("blur", () => setTimeout(() => (box.hidden = true), 150));
  input.addEventListener("keydown", (e) => {
    if (box.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      box.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i === sel));
    } else if (e.key === "Enter") { e.preventDefault(); pick(sel); }
    else if (e.key === "Escape") { box.hidden = true; e.stopPropagation(); }
  });
  box.addEventListener("mousedown", (e) => { const b = e.target.closest("[data-i]"); if (b) { e.preventDefault(); pick(+b.dataset.i); } });
  return { refresh: show };
}
