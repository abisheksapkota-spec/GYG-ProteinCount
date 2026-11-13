"""Validation and the stock maths. The server recalculates every total, so a report
can never contain an addition mistake, whatever the phone sent."""
import re
from datetime import datetime, timezone

UNIT_KINDS = {
    "prep": {"label": "prep", "plural": "prep", "type": "prepared", "half": True},
    "pack": {"label": "packet", "plural": "packets", "type": "unopened", "half": False},
    "box": {"label": "box", "plural": "boxes", "type": "unopened", "half": False},
}
MAX_QTY = 500
MAX_KG = 100
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

DEFAULT_CONFIG = {
    "proteins": [
        {"id": "chk", "name": "Chicken", "units": {"prep": 7.5, "box": 7.5}},
        {"id": "gbf", "name": "Ground Beef", "units": {"prep": 6, "pack": 2, "box": 16}},
        {"id": "bri", "name": "Brisket", "units": {"prep": 6, "pack": 2, "box": 16}},
        {"id": "rib", "name": "BBQ Beef Rib", "units": {"prep": 6, "pack": 2, "box": 16}},
        {"id": "pp", "name": "Pulled Pork", "units": {"prep": 6, "pack": 2, "box": 16}},
        {"id": "avo", "name": "Avocado", "units": {"box": 0}},
    ],
    "tares": [],
}


class Invalid(ValueError):
    pass


def r2(n: float) -> float:
    return round(n + 0.0, 2)


def _num(v, what: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise Invalid(f"{what} must be a number")
    return float(v)


def _text(v, what: str, max_len: int, required=True) -> str:
    if v is None and not required:
        return ""
    if not isinstance(v, str):
        raise Invalid(f"{what} must be text")
    v = v.strip()
    if required and not v:
        raise Invalid(f"{what} is required")
    if len(v) > max_len:
        raise Invalid(f"{what} is too long")
    return v


def _iso(v) -> str:
    now = datetime.now(timezone.utc)
    try:
        dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        # A phone clock can be off; never accept a time in the future or older than 3 days.
        if dt > now or (now - dt).days > 3:
            dt = now
    except (TypeError, ValueError):
        dt = now
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def validate_config(body) -> dict:
    if not isinstance(body, dict) or not isinstance(body.get("proteins"), list):
        raise Invalid("proteins list is required")
    if not 1 <= len(body["proteins"]) <= 30:
        raise Invalid("keep between 1 and 30 items")
    seen, proteins = set(), []
    for p in body["proteins"]:
        if not isinstance(p, dict):
            raise Invalid("bad protein")
        pid = _text(p.get("id"), "protein id", 64)
        if not ID_RE.match(pid) or pid in seen:
            raise Invalid("bad or duplicate protein id")
        seen.add(pid)
        units = p.get("units") or {}
        if not isinstance(units, dict) or not units or any(k not in UNIT_KINDS for k in units):
            raise Invalid(f"{p.get('name')}: units must use prep, pack or box")
        clean_units = {}
        for k, w in units.items():
            w = _num(w, "weight")
            if not 0 <= w <= MAX_KG:
                raise Invalid(f"weights must be between 0 and {MAX_KG} kg")
            clean_units[k] = r2(w)
        proteins.append({"id": pid, "name": _text(p.get("name"), "protein name", 40), "units": clean_units})
    tares = []
    for t in body.get("tares") or []:
        tid = _text(t.get("id"), "container id", 64)
        kg = _num(t.get("kg"), "container weight")
        if not ID_RE.match(tid) or not 0 < kg <= 20:
            raise Invalid("container weights must be between 0 and 20 kg")
        tares.append({"id": tid, "name": _text(t.get("name"), "container name", 40), "kg": r2(kg)})
    return {"proteins": proteins, "tares": tares}


def validate_report(body) -> dict:
    """Check a submitted count and recompute every total. Returns the clean report."""
    if not isinstance(body, dict):
        raise Invalid("report must be an object")
    rid = _text(body.get("id"), "report id", 64)
    if not ID_RE.match(rid):
        raise Invalid("bad report id")
    items_in = body.get("items")
    if not isinstance(items_in, list) or not 1 <= len(items_in) <= 30:
        raise Invalid("items list is required")

    items, grand, missing = [], 0.0, 0
    for it in items_in:
        if not isinstance(it, dict):
            raise Invalid("bad item")
        name = _text(it.get("name"), "protein name", 40)
        units_out, entries_out = [], []
        prepared = unopened = 0.0
        for u in it.get("units") or []:
            kind = UNIT_KINDS.get(u.get("k"))
            if not kind:
                raise Invalid(f"{name}: unknown unit")
            qty, each = _num(u.get("qty"), "count"), _num(u.get("each"), "weight")
            if not 0 <= qty <= MAX_QTY:
                raise Invalid(f"{name}: count must be between 0 and {MAX_QTY}")
            if (qty * 2 if kind["half"] else qty) != int(qty * 2 if kind["half"] else qty):
                raise Invalid(f"{name}: {kind['plural']} must be {'whole or half' if kind['half'] else 'whole'} numbers")
            if not 0 <= each <= MAX_KG:
                raise Invalid(f"{name}: weight out of range")
            kg = r2(qty * each)
            if kind["type"] == "prepared":
                prepared += kg
            else:
                unopened += kg
            units_out.append({"k": u["k"], "qty": qty, "each": r2(each), "kg": kg})
        for e in it.get("entries") or []:
            gross, tare = _num(e.get("gross"), "scale reading"), _num(e.get("tare", 0), "container weight")
            if not 0 < gross <= MAX_KG or not 0 <= tare < gross:
                raise Invalid(f"{name}: weighed container out of range")
            if e.get("type") not in ("prepared", "unopened"):
                raise Invalid(f"{name}: weighed type must be prepared or unopened")
            net = r2(gross - tare)
            if e["type"] == "prepared":
                prepared += net
            else:
                unopened += net
            entries_out.append({"type": e["type"], "gross": r2(gross), "tare": r2(tare), "net": net})
        if len(units_out) > 3 or len(entries_out) > 200:
            raise Invalid(f"{name}: too many entries")
        zero = bool(it.get("zero"))
        counted = bool(units_out or entries_out or zero)
        if not counted:
            missing += 1
        total = r2(prepared + unopened)
        grand += total
        items.append({
            "pid": _text(it.get("pid"), "protein id", 64), "name": name, "counted": counted, "zero": zero and not (units_out or entries_out),
            "prepared": r2(prepared), "unopened": r2(unopened), "total": total,
            "units": units_out, "entries": entries_out,
        })

    return {
        "id": rid,
        "started_at": _iso(body.get("startedAt")),
        "submitted_at": _iso(body.get("submittedAt")),
        "notes": _text(body.get("notes"), "notes", 1000, required=False),
        "total": r2(grand),
        "missing": missing,
        "items": items,
    }
