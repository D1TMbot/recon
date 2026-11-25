// Storage Monitors: reads what's in each monitored box. Monitors on a tool
// cupboard give the TC's contents (used by the upkeep calculator); every other
// monitor counts as your stash, shown against the raid plan as sulfur.
(() => {
  // sulfur that went into each item (crafting chain: 2 sulfur per gunpowder, etc.)
  const SULFUR_PER = {
    "sulfur.ore": 1, "sulfur": 1, "gunpowder": 2, "explosives": 110,
    "ammo.rocket.basic": 1400, "explosive.timed": 2200, "explosive.satchel": 480, "ammo.rifle.explosive": 25,
    "grenade.beancan": 120, "ammo.rocket.hv": 200, "catapult.ammo.explosive": 900,
  };
  const ST = { boxes: new Map() }; // entityId -> { name, items, isTc, at }
  const ents = () => (S.servers.find((s) => s.id === S.active)?.entities ?? []).filter((e) => Number(e.entityType) === 3);
  // a monitor on a TC reports upkeep protection; plain boxes don't
  const isTcPayload = (p) => !!(p && (p.protectionExpiry || p.hasProtection));

  function setBox(ent, payload) {
    if (!payload) return;
    ST.boxes.set(String(ent.entityId), { name: ent.name || "Storage", items: payload.items ?? [], isTc: isTcPayload(payload), at: Date.now() });
  }
  async function refresh() {
    if (S.demo) { demo(); return changed(); }
    if (!S.connected) return;
    for (const e of ents()) {
      try { setBox(e, (await invoke("get_entity_info", { entityId: e.entityId })).payload); } catch {}
    }
    changed();
  }
  function changed() { window.Raid?.render(); window.Upkeep?.render(); }

  /** stash totals: sulfur equivalent and a per-item breakdown (non-TC monitors) */
  function stash() {
    const by = new Map(); let sulfur = 0, boxes = 0;
    for (const b of ST.boxes.values()) {
      if (b.isTc) continue;
      boxes++;
      for (const it of b.items) {
        const s = DB.short(it.itemId), per = SULFUR_PER[s];
        if (!per || it.itemIsBlueprint) continue;
        by.set(s, (by.get(s) ?? 0) + it.quantity);
        sulfur += per * it.quantity;
      }
    }
    return { sulfur, boxes, items: [...by.entries()].sort((a, b) => SULFUR_PER[b[0]] * b[1] - SULFUR_PER[a[0]] * a[1]) };
  }
  /** resources in the TC (first TC monitor), or null */
  function tc() {
    const b = [...ST.boxes.values()].find((x) => x.isTc);
    if (!b) return null;
    const sum = (s) => b.items.filter((it) => DB.short(it.itemId) === s).reduce((a, it) => a + it.quantity, 0);
    return { name: b.name, wood: sum("wood"), stone: sum("stones"), metal: sum("metal.fragments"), hqm: sum("metal.refined") };
  }

  function demo() {
    const id = (s) => DB.byShort(s);
    ST.boxes.set("demo-boom", { name: "Boom box", isTc: false, at: Date.now(), items: [
      { itemId: id("sulfur"), quantity: 4200 }, { itemId: id("gunpowder"), quantity: 900 }, { itemId: id("explosive.timed"), quantity: 1 }, { itemId: id("ammo.rifle.explosive"), quantity: 64 },
    ] });
    ST.boxes.set("demo-tc", { name: "Main TC", isTc: true, at: Date.now(), items: [
      { itemId: id("wood"), quantity: 6000 }, { itemId: id("stones"), quantity: 9000 }, { itemId: id("metal.fragments"), quantity: 2500 }, { itemId: id("metal.refined"), quantity: 40 },
    ] });
  }

  listen("rp-entity-changed", ({ payload }) => {
    const e = ents().find((x) => String(x.entityId) === String(payload.entityId));
    if (e) { setBox(e, payload.payload); changed(); }
  });
  setInterval(refresh, 120000);

  window.Stash = { refresh, stash, tc, SULFUR_PER, reset: () => { ST.boxes.clear(); changed(); } };
})();
