// Shared helpers for the cook app (app.js) and the manager app (manager.js).
"use strict";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r2 = n => Math.round(n * 100) / 100;
const f2 = n => r2(n).toFixed(2);
const fmtW = w => String(r2(w));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const clone = o => JSON.parse(JSON.stringify(o));

const dayFmt = d => new Date(d).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
const timeFmt = d => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const shortFmt = d => new Date(d).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + " · " + timeFmt(d);
function relDay(d) {
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : dayFmt(d);
}

// Count units: how many of each, times the weight of one (set by the manager).
const UNITS = [
  { k: "prep", label: "Prep containers", short: "prep",   plural: "prep",    type: "prepared", step: 0.5 },
  { k: "pack", label: "Open packets",    short: "packet", plural: "packets", type: "unopened", step: 1 },
  { k: "box",  label: "Boxes",           short: "box",    plural: "boxes",   type: "unopened", step: 1 },
];
const unitOf = k => UNITS.find(u => u.k === k);
const unitWord = (u, q) => q === 1 ? u.short : u.plural;

// ---------- server calls ----------
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function api(path, { method = "GET", body, token, timeout = 12000 } = {}) {
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(path, {
      method, signal: ctrl.signal,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const isJson = (res.headers.get("content-type") || "").includes("json");
    const data = isJson ? await res.json() : await res.text();
    if (!res.ok) throw new ApiError(res.status, (isJson && data.detail) || "Something went wrong");
    return data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, "No connection");
  } finally { clearTimeout(t); }
}

// ---------- storage (never throws) ----------
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---------- dialogs ----------
function ask(msg, { ok = "OK", cancel = "Cancel", text = null } = {}) {
  return new Promise(res => {
    $("modalMsg").textContent = msg;
    $("modalOk").textContent = ok;
    $("modalCancel").textContent = cancel || "";
    $("modalCancel").hidden = !cancel;
    const ta = $("modalText"); ta.hidden = text === null; ta.value = text || "";
    $("modal").hidden = false;
    if (text !== null) { ta.focus(); ta.select(); } else $("modalOk").focus();
    const done = v => { $("modal").hidden = true; $("modalOk").onclick = $("modalCancel").onclick = null; res(v); };
    $("modalOk").onclick = () => done(true);
    $("modalCancel").onclick = () => done(false);
  });
}
function toast(msg, { action, onAction, ms = 2500 } = {}) {
  $("toastMsg").textContent = msg;
  const b = $("toastAct"); b.hidden = !action; b.textContent = action || "";
  b.onclick = () => { $("toast").classList.remove("show"); onAction && onAction(); };
  $("toast").classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => $("toast").classList.remove("show"), action ? 5000 : ms);
}
const hideToast = () => $("toast").classList.remove("show");
async function copyText(text, done = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(done); return; } catch {}
  ask("Copy this text:", { ok: "Done", cancel: null, text });
}
function setBar(html) { $("barInner").innerHTML = html; $("bar").hidden = !html; }

// ---------- report text (same format everywhere) ----------
function reportText(rep) {
  const L = ["CLOSING PROTEIN COUNT", `${dayFmt(rep.submitted_at)} · ${timeFmt(rep.submitted_at)}`, `Counted by: ${rep.cook_name || "—"}`, ""];
  rep.items.forEach(i => {
    if (!i.counted) { L.push(`• ${i.name}: NOT COUNTED`); return; }
    if (i.zero) { L.push(`• ${i.name}: 0.00 kg (none in stock)`); return; }
    L.push(`• ${i.name}: ${f2(i.total)} kg  (prepared ${f2(i.prepared)} / unopened ${f2(i.unopened)})`);
    const parts = i.units.filter(x => x.qty > 0).map(x => { const u = unitOf(x.k); return `${x.qty} ${unitWord(u, x.qty)} × ${fmtW(x.each)}`; });
    if (i.entries.length) parts.push(`${i.entries.length} weighed = ${f2(i.entries.reduce((a, e) => a + e.net, 0))}`);
    if (parts.length) L.push(`   ${parts.join(" + ")}`);
  });
  L.push("", `TOTAL: ${f2(rep.total)} kg`);
  if (rep.missing) L.push(`⚠ ${rep.missing} protein${rep.missing === 1 ? "" : "s"} not counted`);
  if (rep.notes) L.push("", "Notes: " + rep.notes);
  return L.join("\n");
}

// Header clock + offline banner
function startClock() {
  const tick = () => { $("clock").textContent = `${new Date().toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} · ${timeFmt(new Date())}`; };
  tick(); setInterval(tick, 20000);
  const netState = () => { $("offline").hidden = navigator.onLine !== false; };
  addEventListener("online", netState); addEventListener("offline", netState); netState();
}
