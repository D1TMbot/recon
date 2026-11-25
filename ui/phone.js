// Phone support: pairing-code login for phones, touch pan/pinch-zoom and
// long-press on the map, and the "Phone app" settings on the PC.
(() => {
  const IS_REMOTE = !["127.0.0.1", "localhost"].includes(location.hostname);
  document.documentElement.classList.toggle("remote", IS_REMOTE);

  // ------------------------------------------------------- phone login
  window.showPhoneLogin = () => {
    $("#phone-login").hidden = false;
    $("#pl-code").focus();
  };
  $("#pl-form").onsubmit = async (e) => {
    e.preventDefault();
    const code = $("#pl-code").value.replace(/\D/g, "");
    if (code.length !== 6) { $("#pl-err").textContent = "Enter the 6-digit code shown in Recon on your PC."; return; }
    try {
      const r = await fetch("/api/phone_login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "Android phone" : "Phone" }) });
      const j = await r.json();
      if (!j.ok) { $("#pl-err").textContent = j.error; return; }
      location.reload();
    } catch (err) { $("#pl-err").textContent = "Couldn't reach Recon. Is it running on your PC?"; }
  };

  // ------------------------------------------------------------ touch
  let touch = null, pressTimer = null;
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    const t = e.touches;
    clearTimeout(pressTimer);
    if (t.length === 1) {
      touch = { mode: "pan", x: t[0].clientX, y: t[0].clientY, vx: S.view.x, vy: S.view.y, moved: false };
      const cx = t[0].clientX, cy = t[0].clientY;
      // long-press = right-click menu (log a node, add a marker)
      pressTimer = setTimeout(() => {
        if (touch && !touch.moved) canvas.dispatchEvent(new MouseEvent("contextmenu", { clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
      }, 550);
    } else if (t.length === 2) {
      const r = canvas.getBoundingClientRect();
      touch = { mode: "pinch", d: dist(t[0], t[1]), scale: S.view.scale, cx: (t[0].clientX + t[1].clientX) / 2 - r.left, cy: (t[0].clientY + t[1].clientY) / 2 - r.top, vx: S.view.x, vy: S.view.y };
    }
  }, { passive: false });
  canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (!touch) return;
    const t = e.touches;
    if (touch.mode === "pan" && t.length === 1) {
      const dx = t[0].clientX - touch.x, dy = t[0].clientY - touch.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) { touch.moved = true; clearTimeout(pressTimer); }
      S.view.x = touch.vx + dx; S.view.y = touch.vy + dy; draw();
    } else if (touch.mode === "pinch" && t.length === 2) {
      const ns = Math.min(8, Math.max(0.1, touch.scale * (dist(t[0], t[1]) / touch.d)));
      const f = ns / touch.scale;
      S.view.scale = ns;
      S.view.x = touch.cx - (touch.cx - touch.vx) * f;
      S.view.y = touch.cy - (touch.cy - touch.vy) * f;
      draw();
    }
  }, { passive: false });
  canvas.addEventListener("touchend", (e) => { clearTimeout(pressTimer); if (e.touches.length === 0) touch = null; });

  // ----------------------------------------------- phone app settings (PC)
  async function loadPhone(fn = "get_phone_access", args) {
    if (IS_REMOTE) return;
    let a; try { a = await invoke(fn, args); } catch (e) { return; }
    $("#ph-enable").checked = a.enabled;
    $("#ph-body").hidden = !a.enabled;
    $("#ph-restart-note").hidden = a.enabled === a.listening;
    const lan = a.addresses.filter((x) => x.kind === "lan"), ts = a.addresses.find((x) => x.kind === "tailscale");
    $("#ph-lan").innerHTML = lan.length ? lan.map((x) => `<code>http://${x.address}:${a.port}</code>`).join("") : `<span class="muted small">No Wi-Fi/network address found.</span>`;
    $("#ph-ts").innerHTML = ts ? `<code>http://${ts.address}:${a.port}</code>` : `<span class="muted small">Tailscale isn't running on this PC yet (see step 4).</span>`;
    $("#ph-code").textContent = a.code ? a.code.replace(/(\d{3})(\d{3})/, "$1 $2") : "––– –––";
    $("#ph-code-btn").textContent = a.code ? "New code" : "Get a code";
    $("#ph-code-exp").textContent = a.code ? `Works once, for 10 minutes` : "";
    $("#ph-list").innerHTML = a.phones.length ? a.phones.map((p) => `<div class="cmp-row"><span>${esc(p.name)} <span class="muted">· added ${new Date(p.created).toLocaleDateString()}</span></span><button class="link-btn" data-revoke="${p.id}">Remove</button></div>`).join("") : `<div class="muted small">No phones added yet.</div>`;
  }
  if (!IS_REMOTE) {
    $("#ph-enable").onchange = async (e) => {
      const on = e.target.checked;
      if (on && !confirm("Turn on phone access? Recon will also listen on your home network, protected by a pairing code. Windows may ask you to allow Node.js on private networks: choose Allow.")) { e.target.checked = false; return; }
      try { await invoke("set_phone_access", { enabled: on }); } catch {}
      toast("Restarting Recon", on ? "Phone access is turning on." : "Phone access is turning off.");
      setTimeout(() => loadPhone(), 3500);
    };
    $("#ph-code-btn").onclick = () => loadPhone("new_phone_code");
    $("#ph-list").onclick = (e) => { const b = e.target.closest("[data-revoke]"); if (b && confirm("Remove this phone? It will need a new code to connect again.")) loadPhone("revoke_phone", { id: b.dataset.revoke }); };
    $("#ph-quit").onclick = async () => { if (confirm("Quit Recon? Your phone won't be able to connect until you open it again.")) { try { await invoke("quit"); } catch {} window.close(); } };
  }
  window.PhoneSettings = { load: () => loadPhone() };
})();
