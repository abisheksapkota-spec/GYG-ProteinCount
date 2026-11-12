// Manager app: see every cook's closing reports, manage cooks and PINs, and set weights.
"use strict";

const MKEY = "npc.manager.v1";
let token = store.get(MKEY)?.token || null;
let tab = "reports";
let cooks = [];
const R = { cook: "", days: "7", rows: [], more: false, detail: null };
let W = null, wDirty = false;   // weights being edited

const saveToken = t => { token = t; store.set(MKEY, { token: t }); };
const call = (path, opts = {}) => api(path, { ...opts, token }).catch(e => {
  if (e.status === 401) { saveToken(null); render(); }
  throw e;
});

$("nav").addEventListener("click", async e => {
  const b = e.target.closest("button[data-tab]"); if (!b) return;
  if (tab === "weights" && wDirty && b.dataset.tab !== "weights" && !(await ask("You changed weights but didn't save. Leave without saving?", { ok: "Leave" }))) return;
  if (b.dataset.tab !== "weights") { W = null; wDirty = false; }
  tab = b.dataset.tab; R.detail = null; render();
});

function render() {
  hideToast();
  $("nav").hidden = !token;
  document.querySelectorAll("#nav button").forEach(x => x.classList.toggle("active", x.dataset.tab === tab));
  if (!token) return renderLogin();
  if (tab === "cooks") return renderCooks();
  if (tab === "weights") return renderWeights();
  return R.detail ? renderDetail() : renderReports();
}

// ---------- LOGIN ----------
async function renderLogin() {
  setBar("");
  let setup = false;
  try { setup = (await api("/api/manager/status")).setup_needed; } catch {}
  $("view").innerHTML = `
    <form class="card stack login" id="loginForm">
      <p class="eyebrow">Manager</p>
      <h2>${setup ? "Create manager password" : "Manager log in"}</h2>
      ${setup ? `<p class="muted">First time here. Choose a password (at least 8 characters). Only people with this password can see reports and change weights.</p>` : ""}
      <label>Password<input id="mpw" type="password" autocomplete="${setup ? "new-password" : "current-password"}" required></label>
      <p class="err" id="loginErr" hidden></p>
      <button class="btn primary block" type="submit">${setup ? "Create and log in" : "Log in"}</button>
    </form>`;
  $("mpw").focus();
  $("loginForm").onsubmit = async ev => {
    ev.preventDefault();
    try {
      const r = await api(setup ? "/api/manager/setup" : "/api/manager/login", { method: "POST", body: { password: $("mpw").value } });
      saveToken(r.token); render();
    } catch (e) { const el = $("loginErr"); el.hidden = false; el.textContent = e.status === 0 ? "No connection" : e.message; }
  };
}

// ---------- REPORTS ----------
function dateFrom() {
  if (R.days === "all") return "";
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (Number(R.days) - 1));
  return d.toISOString().slice(0, 19) + "Z";
}
async function loadReports(append = false) {
  const q = new URLSearchParams({ limit: "30", offset: append ? String(R.rows.length) : "0" });
  if (R.cook) q.set("cook_id", R.cook);
  const from = dateFrom(); if (from) q.set("date_from", from);
  const rows = await call("/api/reports?" + q);
  R.rows = append ? R.rows.concat(rows) : rows; R.more = rows.length === 30;
}
async function renderReports() {
  setBar(`<button class="btn" data-act="refresh">↻ Refresh</button><button class="btn shrink" data-act="csv">Export CSV</button>`);
  $("view").innerHTML = `
    <div class="card stack">
      <p class="eyebrow">Closing reports</p>
      <div class="filters">
        <label>Cook<select id="fCook"><option value="">All cooks</option>${cooks.map(c => `<option value="${esc(c.id)}"${R.cook === c.id ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
        <label>Period<select id="fDays">${[["7", "Last 7 days"], ["30", "Last 30 days"], ["all", "All time"]].map(([v, l]) => `<option value="${v}"${R.days === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
    </div>
    <div id="repList" class="stack"><p class="empty">Loading…</p></div>`;
  try {
    if (!cooks.length) { cooks = await call("/api/manager/cooks"); if (cooks.length) return renderReports(); }
    await loadReports();
  } catch (e) { $("repList").innerHTML = `<p class="empty">${esc(e.status === 0 ? "No connection. Pull down or tap Refresh when you're back online." : e.message)}</p>`; return; }
  drawReportList();
}
function drawReportList() {
  if (!R.rows.length) { $("repList").innerHTML = `<p class="empty">No reports in this period yet.</p>`; return; }
  let html = "", lastDay = "";
  R.rows.forEach((r, i) => {
    const day = relDay(r.submitted_at);
    if (day !== lastDay) { html += `<p class="day-h">${esc(day)}</p>`; lastDay = day; }
    const prev = R.rows[i + 1];
    const d = prev && !R.cook ? r2(r.total - prev.total) : null;
    html += `<button class="rep" data-act="openRep" data-id="${esc(r.id)}">
      <b>${esc(r.cook_name)} · ${esc(timeFmt(r.submitted_at))}</b>
      <span class="r-sub">${r.missing ? `<span class="down" style="font-weight:700">${r.missing} not counted</span>` : "All counted"}${d !== null ? ` · <span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "▲ +" : "▼ "}${f2(d)} kg</span> vs previous` : ""}</span>
      <span class="r-kg num">${f2(r.total)}<small> kg</small></span></button>`;
  });
  if (R.more) html += `<button class="btn block" data-act="more">Show older reports</button>`;
  $("repList").innerHTML = html;
}
async function renderDetail() {
  const rep = R.detail, prev = rep.previous;
  const pItem = pid => prev?.items.find(i => i.pid === pid);
  const delta = (a, b) => { const d = r2(a - b); return `<span class="${d >= 0 ? "up" : "down"}">${d === 0 ? "±0" : (d > 0 ? "▲ +" : "▼ ") + f2(d)}</span>`; };
  $("view").innerHTML = `
    <div class="back"><button class="btn small ghost" data-act="backList">‹ All reports</button></div>
    <div class="card stack">
      <p class="eyebrow">${esc(relDay(rep.submitted_at))} · ${esc(timeFmt(rep.submitted_at))}</p>
      <div class="p-title"><h2>${esc(rep.cook_name)}</h2><span class="p-total num">${f2(rep.total)}<small>kg</small></span></div>
      <p class="muted">${rep.missing ? `<span class="down" style="font-weight:700">${rep.missing} protein${rep.missing === 1 ? "" : "s"} not counted</span>` : "✅ All proteins counted"}${prev ? ` · ${delta(rep.total, prev.total)} kg vs previous count (${esc(prev.cook_name)}, ${esc(shortFmt(prev.submitted_at))})` : ""}</p>
      <div class="scroll-x"><table class="rtable">
        <thead><tr><th>Protein</th><th>Prepared</th><th>Unopened</th><th>Total kg</th>${prev ? "<th>Change</th>" : ""}</tr></thead>
        <tbody>${rep.items.map(i => `<tr class="${i.counted ? "" : "missing"}">
          <td>${esc(i.name)}<br><span class="muted" style="font-size:12px">${esc(i.units.filter(u => u.qty > 0).map(u => `${u.qty} ${unitWord(unitOf(u.k), u.qty)}`).concat(i.entries.length ? [`${i.entries.length} weighed`] : []).join(" · ") || (i.zero ? "none in stock" : ""))}</span></td>
          ${i.counted ? `<td>${f2(i.prepared)}</td><td>${f2(i.unopened)}</td><td><b>${f2(i.total)}</b></td>` : `<td colspan="3">Not counted</td>`}
          ${prev ? `<td>${i.counted && pItem(i.pid)?.counted ? delta(i.total, pItem(i.pid).total) : ""}</td>` : ""}</tr>`).join("")}</tbody>
        <tfoot><tr><td>Total</td><td>${f2(rep.items.reduce((a, i) => a + i.prepared, 0))}</td><td>${f2(rep.items.reduce((a, i) => a + i.unopened, 0))}</td><td>${f2(rep.total)}</td>${prev ? `<td>${delta(rep.total, prev.total)}</td>` : ""}</tr></tfoot>
      </table></div>
      ${rep.notes ? `<p><b>Notes:</b> ${esc(rep.notes)}</p>` : ""}
    </div>`;
  setBar(`<button class="btn shrink danger" data-act="delRep">Delete</button><button class="btn primary" data-act="copyRep">Copy report</button>`);
}

// ---------- COOKS ----------
async function renderCooks() {
  setBar("");
  $("view").innerHTML = `<div class="card stack"><p class="eyebrow">Cooks</p><div id="cookList"><p class="empty">Loading…</p></div></div>
    <form class="card stack" id="addCook">
      <p class="eyebrow">Add a cook</p>
      <div class="two"><label>Name<input id="nName" autocomplete="off" maxlength="40" required></label>
      <label>4-digit PIN<input id="nPin" class="num" inputmode="numeric" maxlength="4" pattern="\\d{4}" autocomplete="off" required></label></div>
      <p class="err" id="addErr" hidden></p>
      <button class="btn go" type="submit">+ Add cook</button>
    </form>
    <form class="card stack" id="pwForm">
      <p class="eyebrow">Manager password</p>
      <label>New password (at least 8 characters)<input id="newPw" type="password" autocomplete="new-password" minlength="8" required></label>
      <button class="btn" type="submit">Change password</button>
      <button class="btn ghost" type="button" data-act="logout">Log out</button>
    </form>`;
  $("addCook").onsubmit = async ev => {
    ev.preventDefault();
    try { await call("/api/manager/cooks", { method: "POST", body: { name: $("nName").value, pin: $("nPin").value } }); toast("Cook added"); cooks = []; renderCooks(); }
    catch (e) { const el = $("addErr"); el.hidden = false; el.textContent = e.message; }
  };
  $("pwForm").onsubmit = async ev => {
    ev.preventDefault();
    try { const r = await call("/api/manager/password", { method: "POST", body: { password: $("newPw").value } }); saveToken(r.token); toast("Password changed"); $("newPw").value = ""; }
    catch (e) { toast(e.message); }
  };
  try { cooks = await call("/api/manager/cooks"); } catch (e) { $("cookList").innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  $("cookList").innerHTML = cooks.map(c => `<div class="cook-row${c.active ? "" : " off"}" data-id="${esc(c.id)}">
      <span><b>${esc(c.name)}</b><br><span class="muted">${c.reports} report${c.reports === 1 ? "" : "s"}${c.active ? "" : " · can't log in"}</span></span>
      <span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
        <button class="btn small" data-act="pinCook">New PIN</button>
        <button class="btn small${c.active ? " danger" : ""}" data-act="toggleCook">${c.active ? "Remove" : "Bring back"}</button>
      </span></div>`).join("") || `<p class="empty">No cooks yet. Add your first cook below.</p>`;
}

// ---------- WEIGHTS ----------
async function renderWeights() {
  if (!W) {
    $("view").innerHTML = `<p class="empty">Loading…</p>`;
    try { const c = await api("/api/config"); W = { proteins: c.proteins, tares: c.tares || [] }; }
    catch { $("view").innerHTML = `<p class="empty">No connection.</p>`; return; }
  }
  $("view").innerHTML = `
    <div class="card stack">
      <h2>Weights</h2>
      <p class="muted">The weight in kg of <b>one</b> of each. Saved for every count on every phone. Change them only when a box or container size changes.</p>
    </div>
    ${W.proteins.map((p, i) => `<div class="card stack" data-pi="${i}">
      <div class="two" style="grid-template-columns:minmax(0,1fr) auto;align-items:end"><label>Protein<input data-f="name" value="${esc(p.name)}" maxlength="40"></label>
      <button class="icon del" data-act="delProtein" aria-label="Remove ${esc(p.name)}">🗑</button></div>
      <div class="kinds">${UNITS.map(u => `<label><input type="checkbox" data-f="use" data-k="${u.k}"${u.k in p.units ? " checked" : ""}> ${u.label}</label>`).join("")}</div>
      <div class="w3">${UNITS.filter(u => u.k in p.units).map(u => `<label>1 ${u.short} (kg)<input data-f="w" data-k="${u.k}" class="num" inputmode="decimal" value="${p.units[u.k] || ""}" placeholder="Not set"${p.units[u.k] > 0 ? "" : ' style="border-color:var(--chilli)"'}></label>`).join("")}</div>
    </div>`).join("")}
    <button class="btn" data-act="addProtein">+ Add protein</button>
    <div class="card stack">
      <p class="eyebrow">Empty containers (for weighing odd leftovers)</p>
      ${W.tares.map((t, i) => `<div class="edit-row" data-ti="${i}">
        <label>Container<input data-f="tname" value="${esc(t.name)}" placeholder="e.g. 1/3 pan" maxlength="40"></label>
        <label>Empty (kg)<input data-f="tkg" class="num" inputmode="decimal" value="${t.kg || ""}" placeholder="0.00"></label>
        <button class="icon del" data-act="delTare" aria-label="Remove">🗑</button></div>`).join("") || `<p class="muted">None yet.</p>`}
      <button class="btn" data-act="addTare">+ Add container</button>
    </div>`;
  setWeightsBar();
}
function setWeightsBar() {
  setBar(`<button class="btn shrink" data-act="undoW"${wDirty ? "" : " disabled"}>Undo</button><button class="btn primary" data-act="saveW"${wDirty ? "" : " disabled"}>${wDirty ? "Save weights" : "Weights saved"}</button>`);
}
const kgVal = v => { const n = Number(String(v).replace(",", ".")); return isFinite(n) && n > 0 ? r2(n) : 0; };

// ---------- events ----------
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.dataset.act;
  try {
    if (act === "refresh") { cooks = []; renderReports(); }
    else if (act === "more") { await loadReports(true); drawReportList(); }
    else if (act === "openRep") { R.detail = await call(`/api/reports/${encodeURIComponent(el.dataset.id)}`); render(); window.scrollTo(0, 0); }
    else if (act === "backList") { R.detail = null; render(); }
    else if (act === "copyRep") copyText(reportText(R.detail));
    else if (act === "delRep") {
      if (!(await ask(`Delete ${R.detail.cook_name}'s report from ${shortFmt(R.detail.submitted_at)}? This can't be undone.`, { ok: "Delete" }))) return;
      await call(`/api/reports/${encodeURIComponent(R.detail.id)}`, { method: "DELETE" }); R.detail = null; toast("Report deleted"); render();
    }
    else if (act === "csv") {
      const q = new URLSearchParams(); if (R.cook) q.set("cook_id", R.cook); const from = dateFrom(); if (from) q.set("date_from", from);
      const res = await fetch("/api/export.csv?" + q, { headers: { Authorization: "Bearer " + token } });
      if (!res.ok) throw new ApiError(res.status, "Export failed");
      const a = document.createElement("a"); a.href = URL.createObjectURL(await res.blob()); a.download = "protein-counts.csv";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    else if (act === "pinCook") {
      const id = el.closest("[data-id]").dataset.id, c = cooks.find(x => x.id === id);
      const pin = (prompt(`New 4-digit PIN for ${c.name}:`) || "").trim();
      if (!pin) return;
      await call(`/api/manager/cooks/${id}`, { method: "PATCH", body: { pin } }); toast(`PIN changed for ${c.name}`);
    }
    else if (act === "toggleCook") {
      const id = el.closest("[data-id]").dataset.id, c = cooks.find(x => x.id === id);
      if (c.active && !(await ask(`Remove ${c.name}? They won't be able to log in. Their old reports stay.`, { ok: "Remove" }))) return;
      await call(`/api/manager/cooks/${id}`, { method: "PATCH", body: { active: !c.active } }); renderCooks();
    }
    else if (act === "logout") { saveToken(null); cooks = []; render(); }
    else if (act === "addProtein") { W.proteins.push({ id: "p" + uid().slice(-8), name: "New protein", units: { prep: 0, pack: 0, box: 0 } }); wDirty = true; renderWeights(); }
    else if (act === "delProtein") {
      const i = Number(el.closest("[data-pi]").dataset.pi);
      if (!(await ask(`Remove ${W.proteins[i].name} from the count?`, { ok: "Remove" }))) return;
      W.proteins.splice(i, 1); wDirty = true; renderWeights();
    }
    else if (act === "addTare") { W.tares.push({ id: "t" + uid().slice(-8), name: "", kg: 0 }); wDirty = true; renderWeights(); }
    else if (act === "delTare") { W.tares.splice(Number(el.closest("[data-ti]").dataset.ti), 1); wDirty = true; renderWeights(); }
    else if (act === "undoW") { W = null; wDirty = false; renderWeights(); }
    else if (act === "saveW") {
      for (const p of W.proteins) {
        if (!p.name.trim()) return toast("Every protein needs a name");
        if (!Object.keys(p.units).length) return toast(`${p.name}: tick at least one of prep, packets or boxes`);
      }
      for (const t of W.tares) if (!t.name.trim() || !(t.kg > 0)) return toast("Each container needs a name and an empty weight");
      const c = await call("/api/config", { method: "PUT", body: W });
      W = { proteins: c.proteins, tares: c.tares }; wDirty = false; renderWeights(); toast("Weights saved for every phone");
    }
  } catch (err) { toast(err.status === 0 ? "No connection" : err.message); }
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.id === "fCook") { R.cook = t.value; renderReports(); }
  else if (t.id === "fDays") { R.days = t.value; renderReports(); }
  else if (t.dataset.f === "use") {
    const p = W.proteins[Number(t.closest("[data-pi]").dataset.pi)];
    if (t.checked) p.units[t.dataset.k] = 0; else delete p.units[t.dataset.k];
    wDirty = true; renderWeights();
  }
});
document.addEventListener("input", e => {
  const t = e.target; if (!W || !t.dataset.f) return;
  const pi = t.closest("[data-pi]"), ti = t.closest("[data-ti]");
  if (pi) { const p = W.proteins[Number(pi.dataset.pi)]; if (t.dataset.f === "name") p.name = t.value; if (t.dataset.f === "w") p.units[t.dataset.k] = kgVal(t.value); }
  if (ti) { const x = W.tares[Number(ti.dataset.ti)]; if (t.dataset.f === "tname") x.name = t.value; if (t.dataset.f === "tkg") x.kg = kgVal(t.value); }
  if (pi || ti) { wDirty = true; setWeightsBar(); }
});

startClock();
render();
