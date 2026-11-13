// Cook app: log in, count six proteins, submit. Every tap is saved on the phone,
// and reports wait on the phone until there is signal to send them.
"use strict";

const KEY = "npc.cook.v1";
const TYPES = { prepared: "Prepared", unopened: "Unopened" };
const MAX_KG = 100;

let S = store.get(KEY) || {};
S = { token: null, cook: null, cfg: null, count: null, pending: [], view: { screen: "home" }, lastTare: {}, ...S };
const save = () => store.set(KEY, S);
let tab = "count";
let cooksList = null, pickedCook = null, mine = null;

const cfg = () => S.cfg || { proteins: [], tares: [] };
const proteins = () => cfg().proteins;
const usedUnits = p => UNITS.filter(u => u.k in p.units);

// ---------- count maths (the server checks it again) ----------
const pc = pid => { const c = S.count.proteins[pid] || (S.count.proteins[pid] = { entries: [], zero: false }); c.units = c.units || {}; return c; };
const net = e => r2(e.gross - e.tare);
function sums(pid) {
  const c = S.count?.proteins[pid], p = proteins().find(x => x.id === pid), out = { prepared: 0, unopened: 0, total: 0, n: 0 };
  (c?.entries || []).forEach(e => { out[e.type] += net(e); out.n++; });
  if (c?.units && p) UNITS.forEach(u => { const q = c.units[u.k]; if (q !== undefined && u.k in p.units) out[u.type] += q * (p.units[u.k] || 0); });
  out.prepared = r2(out.prepared); out.unopened = r2(out.unopened); out.total = r2(out.prepared + out.unopened);
  return out;
}
const isDone = pid => { const c = S.count?.proteins[pid]; return !!c && (c.entries.length > 0 || c.zero || Object.keys(c.units || {}).length > 0); };
const doneCount = () => proteins().filter(p => isDone(p.id)).length;
const grand = () => r2(proteins().reduce((s, p) => s + sums(p.id).total, 0));
const tareList = () => [{ id: "none", name: "No container", kg: 0 }, ...(cfg().tares || [])];
const unsetWeights = () => proteins().filter(p => usedUnits(p).some(u => !(p.units[u.k] > 0) && Number(S.count?.proteins[p.id]?.units?.[u.k]) > 0));

function parseKg(v) {
  const s = String(v ?? "").trim().replace(",", ".");
  if (s === "") return { empty: true };
  if (!/^-?\d*\.?\d+$/.test(s)) return { error: "Enter a number, like 8.5" };
  const n = Number(s);
  if (n < 0) return { error: "Weight can't be negative" };
  if (n > MAX_KG) return { error: `That's over ${MAX_KG} kg. Check the scale reading.` };
  return { value: r2(n) };
}
function parseQty(u, v) {
  const s = String(v ?? "").trim().replace(",", ".");
  if (s === "") return { empty: true };
  if (!/^-?\d*\.?\d+$/.test(s)) return { error: "Enter a number" };
  const n = Number(s);
  if (n < 0) return { error: "Can't be negative" };
  if (n > 500) return { error: "That's too many. Check the count." };
  if (u.step === 1 && !Number.isInteger(n)) return { error: "Whole numbers only" };
  if (u.step === 0.5 && !Number.isInteger(n * 2)) return { error: "Use whole or half, like 2.5" };
  return { value: n };
}

// ---------- server sync ----------
async function loadConfig() {
  try { S.cfg = await api("/api/config"); save(); } catch {}
}
async function sendPending() {
  if (!S.token) return;
  for (const rec of [...S.pending]) {
    try {
      await api("/api/reports", { method: "POST", body: rec, token: S.token });
      S.pending = S.pending.filter(r => r.id !== rec.id); save();
      if (S.view.screen === "done" && S.view.id === rec.id) { S.view.status = "sent"; render(); }
    } catch (e) {
      if (e.status === 401) { S.token = null; save(); toast("Please log in again to send your report"); render(); return; }
      if (e.status === 422) { S.view.error = e.message; toast("Report rejected: " + e.message); save(); return; }
      return; // no signal: try again later
    }
  }
  if (tab === "mine") renderMine();
}
addEventListener("online", sendPending);
setInterval(sendPending, 30000);

// ---------- navigation ----------
$("nav").addEventListener("click", e => {
  const b = e.target.closest("button[data-tab]"); if (!b) return;
  tab = b.dataset.tab; mine = null; render();
});
function go(screen, extra = {}) { hideToast(); S.view = { screen, ...extra }; save(); render(); window.scrollTo(0, 0); }
function render() {
  $("nav").hidden = !S.token && !S.pending.length;
  document.querySelectorAll("#nav button").forEach(x => x.classList.toggle("active", x.dataset.tab === tab));
  if (!S.token) return renderLogin();
  if (tab === "mine") return renderMine();
  const v = S.view || { screen: "home" };
  if (v.screen === "protein" && S.count && proteins().some(p => p.id === v.pid)) return renderProtein(v.pid);
  if (v.screen === "review" && S.count) return renderReview();
  if (v.screen === "done") return renderDone();
  return renderHome();
}

// ---------- LOGIN ----------
async function renderLogin() {
  setBar("");
  $("view").innerHTML = `<div class="card stack login"><p class="eyebrow">Log in</p><h2>Who is counting?</h2><p class="muted">Loading names…</p></div>`;
  if (!cooksList) { try { cooksList = await api("/api/cooks"); } catch (e) { cooksList = null; } }
  if (!cooksList) {
    $("view").innerHTML = `<div class="card stack login"><h2>No connection</h2><p class="muted">You need signal to log in the first time. Connect to Wi-Fi and try again.</p><button class="btn primary" data-act="retryLogin">Try again</button></div>`;
    return;
  }
  if (!cooksList.length) {
    $("view").innerHTML = `<div class="card stack login"><h2>No cooks yet</h2><p class="muted">Ask your manager to add you in the manager app (<b>/manager</b>, Cooks tab).</p><button class="btn" data-act="retryLogin">Refresh</button></div>`;
    return;
  }
  $("view").innerHTML = `
    <div class="card stack login">
      <p class="eyebrow">Log in</p><h2>Who is counting?</h2>
      <div class="cook-list">${cooksList.map(c => `<button class="cook-btn${pickedCook === c.id ? " on" : ""}" data-act="pick" data-id="${esc(c.id)}">${esc(c.name)}</button>`).join("")}</div>
      <label${pickedCook ? "" : " hidden"} id="pinWrap">Your 4-digit PIN<input id="pin" class="pin num" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="4" placeholder="••••"></label>
      <p class="err" id="loginErr" hidden></p>
      <button class="btn primary block" data-act="login"${pickedCook ? "" : " disabled"}>Log in</button>
    </div>`;
  if (pickedCook) $("pin").focus();
}
async function doLogin() {
  const pin = $("pin")?.value || "";
  if (!/^\d{4}$/.test(pin)) { showLoginErr("Enter your 4-digit PIN"); return; }
  try {
    const r = await api("/api/login", { method: "POST", body: { cook_id: pickedCook, pin } });
    S.token = r.token; S.cook = r.cook; save();
    await loadConfig(); sendPending(); go(S.view?.screen || "home", S.view || {});
  } catch (e) { showLoginErr(e.status === 0 ? "No connection. Try again." : e.message); $("pin").value = ""; $("pin").focus(); }
}
function showLoginErr(m) { const el = $("loginErr"); el.hidden = false; el.textContent = m; }

// ---------- HOME ----------
function renderHome() {
  if (!S.count) {
    $("view").innerHTML = `
      <div class="card stack">
        <p class="eyebrow">Closing</p>
        <h2>${esc(dayFmt(Date.now()))}</h2>
        <p class="muted">Hi ${esc(S.cook?.name)}. Count all ${proteins().length} items, then submit the report to your manager.</p>
        <button class="btn primary block" data-act="start"${proteins().length ? "" : " disabled"}>Start closing count</button>
      </div>
      ${S.pending.length ? `<div class="card"><p class="err">${S.pending.length} report${S.pending.length === 1 ? "" : "s"} waiting to send. They send automatically when there's signal.</p></div>` : ""}`;
    setBar("");
    return;
  }
  const done = doneCount(), total = proteins().length, pct = total ? Math.round(done / total * 100) : 0;
  $("view").innerHTML = `
    <div class="card progress-card">
      <div class="progress-big num">${done} / ${total}</div>
      <p class="eyebrow">Counting progress</p>
      <div><div class="meter"><i style="width:${pct}%"></i></div><p class="muted" style="margin-top:6px">${pct}% completed · started ${esc(timeFmt(S.count.startedAt))} by ${esc(S.cook?.name)}</p></div>
    </div>
    <p class="eyebrow">Select a protein</p>
    <div class="stack">
      ${proteins().map(p => {
        const s = sums(p.id), d = isDone(p.id), c = S.count.proteins[p.id];
        const parts = UNITS.filter(u => c?.units?.[u.k] !== undefined && u.k in p.units).map(u => `${c.units[u.k]} ${unitWord(u, c.units[u.k])}`);
        if (s.n) parts.push(`${s.n} weighed`);
        let sub = !d ? "Not counted" : c.zero ? "None in stock" : (parts.join(" · ") || "0 kg");
        if (usedUnits(p).some(u => !(p.units[u.k] > 0))) sub += ' · <span style="color:var(--chilli);font-weight:700">weight not set</span>';
        return `<button class="tile${d ? " done" : ""}" data-act="open" data-pid="${p.id}">
          <span class="t-name">${esc(p.name)}<span class="pill ${d ? "ok" : "pending"}">${d ? "Done" : "Pending"}</span></span>
          <span class="t-sub num">${sub}</span>
          <span class="t-kg num">${d ? f2(s.total) + "<small> kg</small>" : "<small>—</small>"}</span>
        </button>`;
      }).join("")}
    </div>
    <div class="card sum-row"><span><p class="eyebrow">Total counted</p></span><span class="sum-big num">${f2(grand())} <small style="font:700 15px var(--body);color:var(--muted)">kg</small></span></div>
    <button class="link" data-act="discard">Discard this count</button>`;
  setBar(`<button class="btn primary" data-act="review">Review &amp; submit</button>`);
}

// ---------- PROTEIN ----------
function lastTare(type) { const id = S.lastTare[type]; return tareList().some(t => t.id === id) ? id : "none"; }
function draft() { const v = S.view; v.draft = v.draft || { type: "prepared", gross: "", tare: lastTare("prepared"), tareCustom: "" }; return v.draft; }
function tareOf(d) {
  if (d.tare === "custom") return parseKg(d.tareCustom);
  const t = tareList().find(x => x.id === d.tare) || tareList()[0];
  return { value: t.kg, name: t.name };
}
function unitInfo(p, u) {
  const q = pc(p.id).units[u.k], w = p.units[u.k];
  if (!(w > 0)) return `<span class="err">Weight of 1 ${u.short} not set</span>`;
  return q ? `${q} × ${fmtW(w)} kg = <b>${f2(q * w)} kg</b>` : `${fmtW(w)} kg each`;
}
function renderProtein(pid) {
  const p = proteins().find(x => x.id === pid), d = draft(), s = sums(pid), entry = pc(pid), units = usedUnits(p);
  const editing = S.view.edit ? entry.entries.find(e => e.id === S.view.edit) : null;
  const idx = proteins().findIndex(x => x.id === pid);
  const showWeigh = !units.length || editing || S.view.weighOpen || entry.entries.length > 0;
  const groups = ["prepared", "unopened"].map(t => {
    const list = entry.entries.map((e, i) => ({ e, i })).filter(x => x.e.type === t);
    if (!list.length) return "";
    return `<div class="group-h"><span>${TYPES[t]}</span></div>
      <div>${list.map(({ e, i }) => `<div class="entry${editing && editing.id === e.id ? " editing" : ""}">
        <span class="e-no num">${i + 1}</span>
        <span class="e-main"><b class="num">${f2(net(e))} kg</b><span class="num">${e.tare ? `${f2(e.gross)} − ${f2(e.tare)} ${esc(e.tareName || "container")}` : "No container"}</span></span>
        <span class="e-acts"><button class="icon" data-act="edit" data-eid="${e.id}" aria-label="Edit">✎</button><button class="icon del" data-act="del" data-eid="${e.id}" aria-label="Delete">🗑</button></span>
      </div>`).join("")}</div>`;
  }).join("");

  $("view").innerHTML = `
    <div class="back"><button class="btn small ghost" data-act="home">‹ All items</button><span class="muted num">${idx + 1} of ${proteins().length}</span></div>
    <div class="card stack">
      <div class="p-title"><h2>${esc(p.name)}</h2><span class="p-total num" id="pTotal">${f2(s.total)}<small>kg</small></span></div>
      <p class="muted num" id="pSplit">Prepared ${f2(s.prepared)} kg · Unopened ${f2(s.unopened)} kg</p>
    </div>
    ${units.length ? `<div class="card stack">
      <p class="eyebrow">Count</p>
      ${units.map(u => `<div class="c-row" data-k="${u.k}">
        <div class="c-label"><b>${u.label}</b><span class="num" data-info>${unitInfo(p, u)}</span><span class="err" data-uerr hidden></span></div>
        <div class="stepper">
          <button type="button" data-act="uminus" data-k="${u.k}" aria-label="Fewer ${u.label}">−</button>
          <input data-unit="${u.k}" class="num" inputmode="${u.step === 1 ? "numeric" : "decimal"}" autocomplete="off" placeholder="–" value="${entry.units[u.k] ?? ""}" aria-label="${u.label} of ${esc(p.name)}">
          <button type="button" data-act="uplus" data-k="${u.k}" aria-label="More ${u.label}">+</button>
        </div>
      </div>`).join("")}
      ${units.some(u => !(p.units[u.k] > 0)) ? `<p class="muted">⚠ Ask your manager to set this weight in the manager app. You can still count; it's added once the weight is set.</p>` : ""}
    </div>` : ""}
    ${showWeigh ? `<div class="card stack">
      <p class="eyebrow">${editing ? "Edit weighed container" : units.length ? "Weigh odd leftovers" : "Weigh a container"}</p>
      <div class="seg" role="group" aria-label="Stock type">
        ${Object.entries(TYPES).map(([k, l]) => `<button data-act="type" data-type="${k}" class="${d.type === k ? "on" : ""}" aria-pressed="${d.type === k}">${l}</button>`).join("")}
      </div>
      <label>Scale reading (kg)<input id="gross" class="gross num" inputmode="decimal" enterkeyhint="done" autocomplete="off" placeholder="0.00" value="${esc(d.gross)}"></label>
      <div class="two">
        <label>Container<select id="tareSel">
          ${tareList().map(t => `<option value="${t.id}"${d.tare === t.id ? " selected" : ""}>${esc(t.name)}${t.kg ? ` (−${f2(t.kg)} kg)` : ""}</option>`).join("")}
          <option value="custom"${d.tare === "custom" ? " selected" : ""}>Other: type its weight</option>
        </select></label>
        <label${d.tare === "custom" ? "" : " hidden"} id="customWrap">Container weight (kg)<input id="tareCustom" class="num" inputmode="decimal" placeholder="0.00" value="${esc(d.tareCustom)}"></label>
      </div>
      <div class="netline num" id="netLine"></div>
      <p class="err" id="err" hidden></p>
      <div class="two">
        ${editing ? `<button class="btn" data-act="cancelEdit">Cancel</button><button class="btn go" data-act="add">Update</button>`
                  : `<button class="btn go" data-act="add" style="grid-column:1/-1">+ Add container</button>`}
      </div>
    </div>` : `<button class="btn ghost block" data-act="weighOpen">Weigh odd leftovers instead ›</button>`}
    ${s.n ? `<div class="card stack"><p class="eyebrow">Weighed containers (${s.n})</p>${groups}</div>` : ""}`;
  if (showWeigh) updateNetLine();
  setProteinBar(pid);
}
function setProteinBar(pid) {
  const entry = pc(pid), next = nextPending(pid);
  const any = entry.entries.length || Object.values(entry.units).some(q => q > 0);
  setBar(`${!any ? `<button class="btn shrink${entry.zero ? " go" : ""}" data-act="zero">${entry.zero ? "✓ None in stock" : "None in stock"}</button>` : ""}
          <button class="btn primary" data-act="next">${next ? "Done · Next ›" : "Done · Review ›"}</button>`);
}
function refreshProtein(pid) {
  const s = sums(pid);
  $("pTotal").innerHTML = `${f2(s.total)}<small>kg</small>`;
  $("pSplit").textContent = `Prepared ${f2(s.prepared)} kg · Unopened ${f2(s.unopened)} kg`;
}
function setUnit(pid, k, raw, fromInput) {
  const p = proteins().find(x => x.id === pid), u = unitOf(k), c = pc(pid);
  const row = document.querySelector(`.c-row[data-k="${k}"]`), err = row?.querySelector("[data-uerr]");
  const v = typeof raw === "number" ? { value: raw } : parseQty(u, raw);
  if (v.error) { if (err) { err.hidden = false; err.textContent = v.error; } return; }
  if (err) err.hidden = true;
  if (v.empty) delete c.units[k]; else { c.units[k] = v.value; c.zero = false; }
  save();
  if (row) { row.querySelector("[data-info]").innerHTML = unitInfo(p, u); if (!fromInput) row.querySelector("input").value = c.units[k] ?? ""; }
  refreshProtein(pid); setProteinBar(pid);
}
function nextPending(pid) {
  const order = proteins().map(p => p.id), start = order.indexOf(pid);
  for (let i = 1; i <= order.length; i++) { const id = order[(start + i) % order.length]; if (id !== pid && !isDone(id)) return id; }
  return null;
}
function validateDraft() {
  const d = draft(), g = parseKg(d.gross), t = tareOf(d);
  if (g.empty) return {};
  if (g.error) return { error: g.error };
  if (t.error) return { error: "Container weight: " + t.error };
  if (t.empty) return { error: "Type the container weight" };
  if (g.value <= 0) return { error: "Weight must be more than 0" };
  if (t.value >= g.value) return { error: "Container weight must be less than the scale reading" };
  return { gross: g.value, tare: t.value || 0, tareName: d.tare === "custom" ? "container" : t.name };
}
function updateNetLine() {
  const v = validateDraft(), el = $("netLine"), err = $("err"); if (!el) return;
  err.hidden = !v.error; err.textContent = v.error || "";
  if (v.gross !== undefined) el.innerHTML = v.tare ? `${f2(v.gross)} − ${f2(v.tare)} = <b>${f2(v.gross - v.tare)} kg</b> ${TYPES[draft().type].toLowerCase()}` : `<b>${f2(v.gross)} kg</b> ${TYPES[draft().type].toLowerCase()}`;
  else el.textContent = "Enter the scale reading";
}
function addEntry() {
  const pid = S.view.pid, v = validateDraft(), d = draft();
  if (v.gross === undefined) { const err = $("err"); err.hidden = false; err.textContent = v.error || "Enter the scale reading first"; $("gross").focus(); return; }
  const list = pc(pid).entries;
  if (S.view.edit) {
    Object.assign(list.find(x => x.id === S.view.edit), { type: d.type, gross: v.gross, tare: v.tare, tareName: v.tareName });
    S.view.edit = null; toast("Container updated");
  } else {
    list.push({ id: uid(), type: d.type, gross: v.gross, tare: v.tare, tareName: v.tareName });
    toast(`Added ${f2(v.gross - v.tare)} kg ${TYPES[d.type].toLowerCase()}`);
  }
  pc(pid).zero = false; d.gross = "";
  if (d.tare !== "custom") S.lastTare[d.type] = d.tare;
  save(); renderProtein(pid); $("gross")?.focus();
}
async function keepTyped() {
  if (S.view.screen !== "protein") return true;
  const d = draft();
  if (!String(d.gross).trim()) return true;
  if (await ask(`You typed ${d.gross} kg but didn't add it.`, { ok: "Add it", cancel: "Discard it" })) { addEntry(); return !String(draft().gross).trim(); }
  d.gross = ""; S.view.edit = null; save(); return true;
}

// ---------- REVIEW & SUBMIT ----------
function renderReview() {
  const rows = proteins().map(p => ({ p, s: sums(p.id), d: isDone(p.id) }));
  const tot = rows.reduce((a, r) => ({ pr: a.pr + r.s.prepared, un: a.un + r.s.unopened }), { pr: 0, un: 0 });
  const missing = rows.filter(r => !r.d);
  $("view").innerHTML = `
    <div class="back"><button class="btn small ghost" data-act="home">‹ Back to count</button></div>
    <div class="card stack">
      <p class="eyebrow">Review closing count</p>
      <h2>${esc(dayFmt(S.count.startedAt))}</h2>
      ${missing.length ? `<p class="err">⚠ Not counted: ${missing.map(r => esc(r.p.name)).join(", ")}</p>` : `<p class="muted">✅ All ${rows.length} proteins counted.</p>`}
      <div class="scroll-x"><table class="rtable">
        <thead><tr><th>Protein</th><th>Prepared</th><th>Unopened</th><th>Total kg</th></tr></thead>
        <tbody>${rows.map(r => `<tr class="${r.d ? "" : "missing"}" data-act="open" data-pid="${r.p.id}" style="cursor:pointer">
          <td>${esc(r.p.name)}</td>${r.d ? `<td>${f2(r.s.prepared)}</td><td>${f2(r.s.unopened)}</td><td><b>${f2(r.s.total)}</b></td>` : `<td colspan="3">Missing</td>`}</tr>`).join("")}</tbody>
        <tfoot><tr><td>Total</td><td>${f2(tot.pr)}</td><td>${f2(tot.un)}</td><td>${f2(tot.pr + tot.un)}</td></tr></tfoot>
      </table></div>
    </div>
    <div class="card stack">
      <p class="muted">Counted by <b>${esc(S.cook?.name)}</b></p>
      <label>Notes for the manager (optional)<textarea id="countNotes" placeholder="Waste, low stock, anything unusual">${esc(S.count.notes || "")}</textarea></label>
    </div>`;
  setBar(`<button class="btn primary" data-act="submit">Submit closing count</button>`);
}
function buildRecord() {
  return {
    id: S.count.id, startedAt: S.count.startedAt, submittedAt: new Date().toISOString(), notes: S.count.notes || "",
    items: proteins().map(p => {
      const c = S.count.proteins[p.id];
      return {
        pid: p.id, name: p.name, zero: !!c?.zero,
        units: UNITS.filter(u => c?.units?.[u.k] !== undefined && u.k in p.units).map(u => ({ k: u.k, qty: c.units[u.k], each: p.units[u.k] || 0 })),
        entries: (c?.entries || []).map(e => ({ type: e.type, gross: e.gross, tare: e.tare })),
      };
    }),
  };
}
// The same shape the server stores, for showing the report on this phone.
function localReport(rec) {
  const items = rec.items.map(i => {
    const units = i.units.map(u => ({ ...u, kg: r2(u.qty * u.each) })), entries = i.entries.map(e => ({ ...e, net: r2(e.gross - e.tare) }));
    let prepared = 0, unopened = 0;
    units.forEach(u => { unitOf(u.k).type === "prepared" ? prepared += u.kg : unopened += u.kg; });
    entries.forEach(e => { e.type === "prepared" ? prepared += e.net : unopened += e.net; });
    const counted = units.length > 0 || entries.length > 0 || i.zero;
    return { ...i, units, entries, counted, prepared: r2(prepared), unopened: r2(unopened), total: r2(prepared + unopened) };
  });
  return { ...rec, cook_name: S.cook?.name, submitted_at: rec.submittedAt, items, total: r2(items.reduce((a, i) => a + i.total, 0)), missing: items.filter(i => !i.counted).length };
}
async function submit() {
  S.count.notes = $("countNotes")?.value || "";
  const unset = unsetWeights();
  if (unset.length && !(await ask(`${unset.map(p => p.name).join(", ")}: the weight isn't set yet, so those count as 0 kg. Tell your manager.\n\nSubmit anyway?`, { ok: "Submit anyway", cancel: "Go back" }))) return;
  const missing = proteins().filter(p => !isDone(p.id)).map(p => p.name);
  if (missing.length && !(await ask(`These proteins are not counted:\n\n${missing.join("\n")}\n\nSubmit anyway?`, { ok: "Submit anyway", cancel: "Go back" }))) return;
  const rec = buildRecord();
  S.pending.push(rec); S.lastReport = rec; S.count = null;
  go("done", { id: rec.id, status: "sending" });
  await sendPending();
  if (S.view.id === rec.id && S.pending.some(r => r.id === rec.id)) { S.view.status = "waiting"; save(); render(); }
}
function renderDone() {
  const rec = S.lastReport && S.lastReport.id === S.view.id ? S.lastReport : null;
  if (!rec) return go("home");
  const rep = localReport(rec), st = S.view.status;
  const msg = st === "sent" ? "✅ Sent. Your manager can see it now."
    : st === "sending" ? "Sending…"
    : "📶 No signal. It's saved on this phone and will send by itself when there's signal.";
  $("view").innerHTML = `
    <div class="card stack">
      <p class="eyebrow">Closing count submitted</p>
      <h2 class="num">${f2(rep.total)} kg total</h2>
      <p style="margin:0;font-weight:700;color:${st === "sent" ? "var(--lime)" : "var(--ink)"}">${msg}</p>
      <pre class="summary">${esc(reportText(rep))}</pre>
    </div>`;
  setBar(`<button class="btn shrink" data-act="newCount">Done</button><button class="btn primary" data-act="copyRep">Copy report</button>`);
}

// ---------- MY REPORTS ----------
async function renderMine() {
  setBar("");
  if (mine && mine.detail) {
    $("view").innerHTML = `<div class="back"><button class="btn small ghost" data-act="mineBack">‹ My reports</button></div>
      <div class="card stack"><h2 class="num">${f2(mine.detail.total)} kg</h2><p class="muted">${esc(shortFmt(mine.detail.submitted_at))}</p><pre class="summary">${esc(reportText(mine.detail))}</pre></div>`;
    return;
  }
  const pend = S.pending.map(localReport);
  $("view").innerHTML = `<div class="card"><p class="eyebrow">My reports</p><p class="muted" style="margin-top:4px">Your last 20 closing counts.</p></div>
    <div id="mineList" class="stack">${pend.map(r => repRow(r, true)).join("")}<p class="empty">Loading…</p></div>
    <div class="card stack"><p class="muted">Logged in as <b>${esc(S.cook?.name)}</b></p><button class="btn" data-act="logout">Log out</button></div>`;
  let rows = [];
  try { rows = await api("/api/my/reports", { token: S.token }); }
  catch (e) {
    if (e.status === 401) { S.token = null; save(); return render(); }
    $("mineList").innerHTML = pend.map(r => repRow(r, true)).join("") + `<p class="empty">No connection. Reports already sent will show when you're back online.</p>`;
    return;
  }
  $("mineList").innerHTML = pend.map(r => repRow(r, true)).join("") + (rows.map(r => repRow(r)).join("") || (pend.length ? "" : `<p class="empty">No reports yet.</p>`));
}
function repRow(r, pending) {
  return `<button class="rep" data-act="${pending ? "" : "mineOpen"}" data-id="${esc(r.id)}">
    <b>${esc(relDay(r.submitted_at))} · ${esc(timeFmt(r.submitted_at))}</b>
    <span class="r-sub">${pending ? '<span style="color:var(--chilli);font-weight:700">Waiting to send</span>' : r.missing ? `<span style="color:var(--chilli)">${r.missing} missing</span>` : "All counted"}</span>
    <span class="r-kg num">${f2(r.total)}<small> kg</small></span></button>`;
}

// ---------- events ----------
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if (!el || !el.dataset.act) return;
  const act = el.dataset.act;
  if (act === "pick") { pickedCook = el.dataset.id; renderLogin(); }
  else if (act === "login") doLogin();
  else if (act === "retryLogin") { cooksList = null; renderLogin(); }
  else if (act === "start") { await loadConfig(); S.count = { id: uid(), startedAt: new Date().toISOString(), notes: "", proteins: {} }; go("home"); }
  else if (act === "open") go("protein", { pid: el.dataset.pid });
  else if (act === "home") { if (!(await keepTyped())) return; go("home"); }
  else if (act === "review") go("review");
  else if (act === "discard") { if (await ask("Discard this count? All entries will be deleted.", { ok: "Discard" })) { S.count = null; go("home"); } }
  else if (act === "uplus" || act === "uminus") {
    const u = unitOf(el.dataset.k), cur = Number(pc(S.view.pid).units[u.k] || 0);
    setUnit(S.view.pid, u.k, Math.max(0, cur + (act === "uplus" ? u.step : -u.step)));
  }
  else if (act === "weighOpen") { S.view.weighOpen = true; save(); renderProtein(S.view.pid); $("gross")?.focus(); }
  else if (act === "type") { const d = draft(); if (d.type !== el.dataset.type) { d.type = el.dataset.type; d.tare = lastTare(d.type); d.tareCustom = ""; } save(); renderProtein(S.view.pid); $("gross")?.focus(); }
  else if (act === "add") addEntry();
  else if (act === "edit") {
    const en = pc(S.view.pid).entries.find(x => x.id === el.dataset.eid);
    const known = tareList().find(t => t.name === en.tareName && t.kg === en.tare);
    S.view.edit = en.id;
    S.view.draft = { type: en.type, gross: String(en.gross), tare: known ? known.id : (en.tare ? "custom" : "none"), tareCustom: known ? "" : String(en.tare || "") };
    save(); renderProtein(S.view.pid); $("gross")?.focus();
  }
  else if (act === "cancelEdit") { S.view.edit = null; draft().gross = ""; save(); renderProtein(S.view.pid); }
  else if (act === "del") {
    const pid = S.view.pid, list = pc(pid).entries, i = list.findIndex(x => x.id === el.dataset.eid), [gone] = list.splice(i, 1);
    if (S.view.edit === gone.id) { S.view.edit = null; draft().gross = ""; }
    save(); renderProtein(pid);
    toast(`Deleted ${f2(net(gone))} kg`, { action: "Undo", onAction: () => { pc(pid).entries.splice(i, 0, gone); save(); if (S.view.pid === pid) renderProtein(pid); } });
  }
  else if (act === "zero") { const c = pc(S.view.pid); c.zero = !c.zero; save(); renderProtein(S.view.pid); if (c.zero) toast("Marked as none in stock"); }
  else if (act === "next") {
    const pid = S.view.pid;
    if (!(await keepTyped())) return;
    const nx = nextPending(pid);
    if (!isDone(pid)) toast(`${proteins().find(p => p.id === pid).name} is still pending`);
    nx ? go("protein", { pid: nx }) : go("review");
  }
  else if (act === "submit") submit();
  else if (act === "newCount") go("home");
  else if (act === "copyRep") copyText(reportText(localReport(S.lastReport)), "Copied");
  else if (act === "mineOpen") {
    try { mine = { detail: await api(`/api/my/reports/${encodeURIComponent(el.dataset.id)}`, { token: S.token }) }; renderMine(); }
    catch { toast("Couldn't open it. Check your signal."); }
  }
  else if (act === "mineBack") { mine = null; renderMine(); }
  else if (act === "logout") {
    if (S.count && !(await ask("You have a count in progress. It stays on this phone. Log out anyway?", { ok: "Log out" }))) return;
    S.token = null; S.cook = null; pickedCook = null; cooksList = null; tab = "count"; save(); render();
  }
});
document.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "countNotes" && S.count) { S.count.notes = t.value; save(); }
  else if (t.dataset.unit) setUnit(S.view.pid, t.dataset.unit, t.value, true);
  else if (t.id === "gross") { draft().gross = t.value; save(); updateNetLine(); }
  else if (t.id === "tareCustom") { draft().tareCustom = t.value; save(); updateNetLine(); }
  else if (t.id === "tareSel") { draft().tare = t.value; $("customWrap").hidden = t.value !== "custom"; save(); updateNetLine(); if (t.value === "custom") $("tareCustom").focus(); }
  else if (t.id === "pin" && t.value.length === 4) doLogin();
});
document.addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  if (e.target.id === "gross" || e.target.id === "tareCustom") { e.preventDefault(); addEntry(); }
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });

// ---------- start ----------
startClock();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
render();
loadConfig().then(() => { if (S.token) render(); });
sendPending();
