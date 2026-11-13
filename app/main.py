"""Night Protein Count: API + static web app.

Run locally:  uvicorn app.main:app --reload
Environment (also read from .env.local / .env, which `neon deploy` writes):
  DATABASE_URL      postgresql://... (e.g. Neon, pooled) or mysql://... (default: SQLite file in ./data)
  SECRET_KEY        signs login tokens (default: generated once and stored in the database)
  MANAGER_PASSWORD  optional; if set it always works as the manager password (recovery)
"""
import csv
import io
import json
import mimetypes
import os
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import envfile
from .calc import DEFAULT_CONFIG, Invalid, validate_config, validate_report
from .db import Database
from .security import Lockout, Tokens, hash_secret, verify_secret

envfile.load()
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")

STATIC = Path(__file__).resolve().parent.parent / "static"
COOK_TTL = 60 * 60 * 24 * 30      # cooks stay logged in for 30 days
MANAGER_TTL = 60 * 60 * 24 * 30
PIN_RE = re.compile(r"^\d{4}$")
MAX_BODY = 512 * 1024


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def create_app(database_url: str | None = None) -> FastAPI:
    db = Database(database_url)
    secret = os.environ.get("SECRET_KEY") or db.get_setting("secret_key")
    if not secret:
        secret = secrets.token_hex(32)
        db.set_setting("secret_key", secret)
    tokens = Tokens(secret)
    lockout = Lockout()

    app = FastAPI(title="Night Protein Count", docs_url=None, redoc_url=None)
    app.state.db = db

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if int(request.headers.get("content-length") or 0) > MAX_BODY:
            return JSONResponse({"detail": "Request too large"}, status_code=413)
        resp = await call_next(request)
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "same-origin"
        resp.headers["X-Frame-Options"] = "DENY"
        if request.url.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    # ---------- helpers ----------
    def config() -> dict:
        raw = db.get_setting("config")
        if raw:
            return json.loads(raw)
        return {**DEFAULT_CONFIG, "updatedAt": None}

    def bearer(authorization: str | None) -> dict | None:
        if not authorization or not authorization.startswith("Bearer "):
            return None
        return tokens.read(authorization[7:])

    def manager(authorization: str | None = Header(None)) -> dict:
        p = bearer(authorization)
        if not p or p.get("role") != "manager" or p.get("v") != manager_version():
            raise HTTPException(401, "Please log in as manager")
        return p

    def cook(authorization: str | None = Header(None)) -> dict:
        p = bearer(authorization)
        if not p or p.get("role") != "cook":
            raise HTTPException(401, "Please log in")
        row = db.one("SELECT id, name, pin_hash, active FROM cooks WHERE id = ?", (p.get("cook_id"),))
        if not row or not row["active"] or row["pin_hash"][-8:] != p.get("v"):
            raise HTTPException(401, "Please log in again")
        return row

    def manager_hash() -> str | None:
        return db.get_setting("manager_hash")

    def manager_version() -> str:
        return (manager_hash() or "env")[-8:]

    async def json_body(request: Request):
        try:
            return await request.json()
        except Exception:
            raise HTTPException(400, "Body must be JSON")

    def bad(e: Invalid):
        raise HTTPException(422, str(e))

    # ---------- public ----------
    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.get("/api/config")
    def get_config():
        return config()

    @app.get("/api/cooks")
    def list_cooks():
        return db.all("SELECT id, name FROM cooks WHERE active = 1 ORDER BY name")

    @app.post("/api/login")
    async def cook_login(request: Request):
        body = await json_body(request)
        cid, pin = str(body.get("cook_id", "")), str(body.get("pin", ""))
        key = "cook:" + cid
        if wait := lockout.locked_for(key):
            raise HTTPException(429, f"Too many wrong PINs. Try again in {wait // 60 + 1} min.")
        row = db.one("SELECT id, name, pin_hash, active FROM cooks WHERE id = ?", (cid,))
        if not row or not row["active"] or not verify_secret(pin, row["pin_hash"]):
            lockout.fail(key)
            raise HTTPException(401, "Wrong PIN")
        lockout.success(key)
        token = tokens.make({"role": "cook", "cook_id": row["id"], "v": row["pin_hash"][-8:]}, COOK_TTL)
        return {"token": token, "cook": {"id": row["id"], "name": row["name"]}}

    # ---------- cook ----------
    @app.post("/api/reports")
    async def submit_report(request: Request, who: dict = Depends(cook)):
        try:
            rep = validate_report(await json_body(request))
        except Invalid as e:
            bad(e)
        data = {**rep, "cook_id": who["id"], "cook_name": who["name"], "received_at": now_iso()}
        inserted = db.insert_ignore("reports", {
            "id": rep["id"], "cook_id": who["id"], "cook_name": who["name"], "started_at": rep["started_at"],
            "submitted_at": rep["submitted_at"], "received_at": data["received_at"],
            "total": rep["total"], "missing": rep["missing"], "data": json.dumps(data),
        })
        # A retry of a report already received (e.g. after losing signal) is fine.
        return {"id": rep["id"], "total": rep["total"], "duplicate": inserted == 0}

    @app.get("/api/my/reports")
    def my_reports(who: dict = Depends(cook)):
        rows = db.all(
            "SELECT id, cook_name, submitted_at, total, missing FROM reports WHERE cook_id = ? "
            "ORDER BY submitted_at DESC LIMIT 20", (who["id"],))
        return rows

    @app.get("/api/my/reports/{rid}")
    def my_report(rid: str, who: dict = Depends(cook)):
        row = db.one("SELECT data FROM reports WHERE id = ? AND cook_id = ?", (rid, who["id"]))
        if not row:
            raise HTTPException(404, "Report not found")
        return json.loads(row["data"])

    # ---------- manager: login ----------
    @app.get("/api/manager/status")
    def manager_status():
        return {"setup_needed": not manager_hash() and not os.environ.get("MANAGER_PASSWORD")}

    @app.post("/api/manager/setup")
    async def manager_setup(request: Request):
        if manager_hash() or os.environ.get("MANAGER_PASSWORD"):
            raise HTTPException(409, "Manager password is already set")
        pw = str((await json_body(request)).get("password", ""))
        if len(pw) < 8:
            raise HTTPException(422, "Use at least 8 characters")
        db.set_setting("manager_hash", hash_secret(pw))
        return {"token": tokens.make({"role": "manager", "v": manager_version()}, MANAGER_TTL)}

    @app.post("/api/manager/login")
    async def manager_login(request: Request):
        if wait := lockout.locked_for("manager"):
            raise HTTPException(429, f"Too many wrong passwords. Try again in {wait // 60 + 1} min.")
        pw = str((await json_body(request)).get("password", ""))
        env_pw = os.environ.get("MANAGER_PASSWORD")
        ok = (env_pw and secrets.compare_digest(pw, env_pw)) or (manager_hash() and verify_secret(pw, manager_hash()))
        if not ok:
            lockout.fail("manager")
            raise HTTPException(401, "Wrong password")
        lockout.success("manager")
        return {"token": tokens.make({"role": "manager", "v": manager_version()}, MANAGER_TTL)}

    @app.post("/api/manager/password")
    async def manager_password(request: Request, _: dict = Depends(manager)):
        pw = str((await json_body(request)).get("password", ""))
        if len(pw) < 8:
            raise HTTPException(422, "Use at least 8 characters")
        db.set_setting("manager_hash", hash_secret(pw))
        # Changing the password logs out every other manager session.
        return {"token": tokens.make({"role": "manager", "v": manager_version()}, MANAGER_TTL)}

    # ---------- manager: cooks ----------
    @app.get("/api/manager/cooks")
    def all_cooks(_: dict = Depends(manager)):
        rows = db.all("SELECT c.id, c.name, c.active, c.created_at, "
                      "(SELECT COUNT(*) FROM reports r WHERE r.cook_id = c.id) AS reports "
                      "FROM cooks c ORDER BY c.active DESC, c.name")
        for r in rows:
            r["active"] = bool(r["active"])
        return rows

    @app.post("/api/manager/cooks")
    async def add_cook(request: Request, _: dict = Depends(manager)):
        body = await json_body(request)
        name, pin = str(body.get("name", "")).strip(), str(body.get("pin", ""))
        if not 1 <= len(name) <= 40:
            raise HTTPException(422, "Name is required (up to 40 characters)")
        if not PIN_RE.match(pin):
            raise HTTPException(422, "PIN must be 4 digits")
        if db.one("SELECT id FROM cooks WHERE lower(name) = lower(?) AND active = 1", (name,)):
            raise HTTPException(409, "A cook with that name already exists")
        cid = secrets.token_hex(8)
        db.run("INSERT INTO cooks (id, name, pin_hash, active, created_at) VALUES (?, ?, ?, 1, ?)",
               (cid, name, hash_secret(pin), now_iso()))
        return {"id": cid, "name": name, "active": True}

    @app.patch("/api/manager/cooks/{cid}")
    async def edit_cook(cid: str, request: Request, _: dict = Depends(manager)):
        body = await json_body(request)
        if not db.one("SELECT id FROM cooks WHERE id = ?", (cid,)):
            raise HTTPException(404, "Cook not found")
        if "name" in body:
            name = str(body["name"]).strip()
            if not 1 <= len(name) <= 40:
                raise HTTPException(422, "Name is required (up to 40 characters)")
            db.run("UPDATE cooks SET name = ? WHERE id = ?", (name, cid))
        if "pin" in body:
            if not PIN_RE.match(str(body["pin"])):
                raise HTTPException(422, "PIN must be 4 digits")
            db.run("UPDATE cooks SET pin_hash = ? WHERE id = ?", (hash_secret(str(body["pin"])), cid))
            lockout.success("cook:" + cid)
        if "active" in body:
            db.run("UPDATE cooks SET active = ? WHERE id = ?", (1 if body["active"] else 0, cid))
        return {"ok": True}

    # ---------- manager: weights ----------
    @app.put("/api/config")
    async def put_config(request: Request, _: dict = Depends(manager)):
        try:
            conf = validate_config(await json_body(request))
        except Invalid as e:
            bad(e)
        conf["updatedAt"] = now_iso()
        db.set_setting("config", json.dumps(conf))
        return conf

    # ---------- manager: reports ----------
    def report_filter(cook_id: str | None, date_from: str | None, date_to: str | None):
        where, params = [], []
        if cook_id:
            where.append("cook_id = ?"); params.append(cook_id)
        if date_from:
            where.append("submitted_at >= ?"); params.append(date_from)
        if date_to:
            where.append("submitted_at < ?"); params.append(date_to)
        return (" WHERE " + " AND ".join(where)) if where else "", params

    @app.get("/api/reports")
    def list_reports(cook_id: str | None = None, date_from: str | None = None, date_to: str | None = None,
                     limit: int = 50, offset: int = 0, _: dict = Depends(manager)):
        where, params = report_filter(cook_id, date_from, date_to)
        limit, offset = max(1, min(limit, 200)), max(0, offset)
        rows = db.all(f"SELECT id, cook_id, cook_name, submitted_at, total, missing FROM reports{where} "
                      f"ORDER BY submitted_at DESC LIMIT {limit} OFFSET {offset}", params)
        return rows

    @app.get("/api/reports/{rid}")
    def get_report(rid: str, _: dict = Depends(manager)):
        row = db.one("SELECT data, submitted_at FROM reports WHERE id = ?", (rid,))
        if not row:
            raise HTTPException(404, "Report not found")
        rep = json.loads(row["data"])
        prev = db.one("SELECT data FROM reports WHERE submitted_at < ? ORDER BY submitted_at DESC LIMIT 1", (row["submitted_at"],))
        rep["previous"] = json.loads(prev["data"]) if prev else None
        return rep

    @app.delete("/api/reports/{rid}")
    def delete_report(rid: str, _: dict = Depends(manager)):
        if not db.run("DELETE FROM reports WHERE id = ?", (rid,)):
            raise HTTPException(404, "Report not found")
        return {"ok": True}

    @app.get("/api/export.csv")
    def export_csv(cook_id: str | None = None, date_from: str | None = None, date_to: str | None = None,
                   _: dict = Depends(manager)):
        where, params = report_filter(cook_id, date_from, date_to)
        rows = db.all(f"SELECT data FROM reports{where} ORDER BY submitted_at DESC", params)
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["Submitted (UTC)", "Cook", "Protein", "Counted", "Prep containers", "Open packets", "Boxes",
                    "Weighed containers", "Prepared kg", "Unopened kg", "Total kg", "Notes"])
        for r in rows:
            d = json.loads(r["data"])
            for i in d["items"]:
                q = {u["k"]: u["qty"] for u in i["units"]}
                w.writerow([d["submitted_at"], d["cook_name"], i["name"], "yes" if i["counted"] else "no",
                            q.get("prep", ""), q.get("pack", ""), q.get("box", ""), len(i["entries"]),
                            i["prepared"], i["unopened"], i["total"], d.get("notes", "")])
        return Response(out.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": 'attachment; filename="protein-counts.csv"'})

    # ---------- web pages ----------
    @app.get("/manager")
    def manager_page():
        return FileResponse(STATIC / "manager.html")

    @app.get("/sw.js")
    def service_worker():
        return FileResponse(STATIC / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})

    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
    return app


app = create_app()
