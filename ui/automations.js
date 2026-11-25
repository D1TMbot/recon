// Device automations UI (Devices panel): simple "when X, turn switch Y on/off" rules.
(() => {
  let rules = [];
  const ents = () => S.servers.find((s) => s.id === S.active)?.entities ?? [];
  const nameOf = (id) => ents().find((e) => String(e.entityId) === String(id))?.name || "a device";

  function describe(r) {
    const when = r.trigger.type === "night" ? "it gets dark" : r.trigger.type === "day" ? "it gets light"
      : r.trigger.entityId === "any" ? "any Smart Alarm goes off" : `<b>${esc(nameOf(r.trigger.entityId))}</b> goes off`;
    const then = r.actions.map((a) => `turn <b>${esc(nameOf(a.entityId))}</b> ${a.value ? "on" : "off"}`).join(", ");
    return `When ${when}, ${then}`;
  }

  function render() {
    const alarms = ents().filter((e) => Number(e.entityType) === 2), switches = ents().filter((e) => Number(e.entityType) === 1);
    $("#auto-list").innerHTML = rules.length ? rules.map((r, i) => `
      <div class="auto-rule ${r.enabled ? "" : "off"}" data-i="${i}">
        <label class="switch"><input type="checkbox" ${r.enabled ? "checked" : ""} data-act="toggle"><span></span></label>
        <div class="txt">${describe(r)}</div>
        <button class="raid-rm" data-act="rm" title="Delete rule">✕</button>
      </div>`).join("") : `<div class="muted small">No rules yet.</div>`;
    $("#auto-when").innerHTML = [
      ...alarms.map((a) => `<option value="alarm:${a.entityId}">${esc(a.name || "Smart Alarm")} goes off</option>`),
      `<option value="alarm:any">any Smart Alarm goes off</option>`,
      `<option value="night">it gets dark (in-game)</option>`,
      `<option value="day">it gets light (in-game)</option>`,
    ].join("");
    $("#auto-switch").innerHTML = switches.length ? switches.map((s) => `<option value="${s.entityId}">${esc(s.name || "Smart Switch")}</option>`).join("") : `<option value="">No Smart Switch paired</option>`;
    $("#auto-add").disabled = !switches.length;
  }

  async function save() {
    if (S.demo) return render();
    try { rules = await invoke("save_automations", { list: rules }); } catch (e) { toast("Couldn't save rules", String(e), "bad"); }
    render();
  }

  $("#auto-add").onclick = () => {
    const w = $("#auto-when").value, sw = $("#auto-switch").value;
    if (!sw) return;
    const [type, entityId] = w.split(":");
    rules.push({ id: String(Date.now()), enabled: true, trigger: { type, entityId: entityId ?? "any" }, actions: [{ entityId: sw, value: $("#auto-value").value === "1" }] });
    save();
  };
  $("#auto-list").onclick = (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const i = +b.closest(".auto-rule").dataset.i;
    if (b.dataset.act === "rm") { rules.splice(i, 1); save(); }
  };
  $("#auto-list").onchange = (e) => {
    if (e.target.dataset.act !== "toggle") return;
    rules[+e.target.closest(".auto-rule").dataset.i].enabled = e.target.checked; save();
  };
  listen("automation-ran", ({ payload }) => payload.ok
    ? toast("Automation ran", describe(payload.rule).replace(/<[^>]+>/g, ""), "ok")
    : toast("Automation failed", payload.error, "bad"));

  window.Automations = {
    async load() { try { rules = S.demo ? rules : await invoke("get_automations"); } catch { rules = []; } render(); },
  };
})();
