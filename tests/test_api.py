"""API tests. Run: pytest -q
Set TEST_DATABASE_URL=postgresql://... or mysql://... to run the same tests on that database."""
import os
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture()
def client(tmp_path):
    url = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / 'test.db'}"
    app = create_app(url)
    if app.state.db.dialect != "sqlite":  # start each test from empty tables
        for t in ("reports", "cooks", "settings"):
            app.state.db.run(f"DELETE FROM {t}")
        app = create_app(url)
    return TestClient(app)


def manager_token(c):
    r = c.post("/api/manager/setup", json={"password": "manager-pass"})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


def add_cook(c, mh, name, pin="1234"):
    r = c.post("/api/manager/cooks", json={"name": name, "pin": pin}, headers=mh)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def cook_token(c, cid, pin="1234"):
    r = c.post("/api/login", json={"cook_id": cid, "pin": pin})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


def report(**over):
    base = {
        "id": uuid.uuid4().hex[:16], "startedAt": None, "submittedAt": None, "notes": "",
        "items": [
            {"pid": "chk", "name": "Chicken", "units": [{"k": "prep", "qty": 10, "each": 7.5}, {"k": "box", "qty": 4, "each": 7.5}], "entries": []},
            {"pid": "gbf", "name": "Ground Beef", "units": [{"k": "prep", "qty": 3, "each": 6}, {"k": "pack", "qty": 4, "each": 2}, {"k": "box", "qty": 3, "each": 16}], "entries": []},
            {"pid": "rib", "name": "BBQ Beef Rib", "units": [], "entries": []},
        ],
    }
    base.update(over)
    return base


def test_full_flow_two_cooks(client):
    mh = manager_token(client)
    a, b = add_cook(client, mh, "Cook A", "1111"), add_cook(client, mh, "Cook B", "2222")
    assert [c["name"] for c in client.get("/api/cooks").json()] == ["Cook A", "Cook B"]

    r = client.post("/api/reports", json=report(), headers=cook_token(client, b, "2222"))
    assert r.status_code == 200 and r.json()["total"] == 179  # 105 + 74
    r = client.post("/api/reports", json=report(notes="1 pan dropped"), headers=cook_token(client, a, "1111"))
    assert r.status_code == 200

    rows = client.get("/api/reports", headers=mh).json()
    assert [x["cook_name"] for x in rows] == ["Cook A", "Cook B"] or len(rows) == 2
    assert all(x["missing"] == 1 for x in rows)
    only_a = client.get(f"/api/reports?cook_id={a}", headers=mh).json()
    assert len(only_a) == 1 and only_a[0]["cook_name"] == "Cook A"

    detail = client.get(f"/api/reports/{only_a[0]['id']}", headers=mh).json()
    chicken = detail["items"][0]
    assert chicken["prepared"] == 75 and chicken["unopened"] == 30 and chicken["total"] == 105
    assert detail["notes"] == "1 pan dropped" and detail["cook_name"] == "Cook A"


def test_server_recalculates_totals(client):
    mh = manager_token(client)
    ck = cook_token(client, add_cook(client, mh, "Sam"))
    body = report()
    body["total"] = 99999  # a wrong total from the phone is ignored
    body["items"][0]["total"] = 1
    r = client.post("/api/reports", json=body, headers=ck)
    assert r.json()["total"] == 179


@pytest.mark.parametrize("units,msg", [
    ([{"k": "prep", "qty": -1, "each": 7.5}], "between"),
    ([{"k": "prep", "qty": 2.3, "each": 7.5}], "whole or half"),
    ([{"k": "pack", "qty": 1.5, "each": 2}], "whole"),
    ([{"k": "box", "qty": 1, "each": -2}], "weight"),
    ([{"k": "tray", "qty": 1, "each": 2}], "unknown unit"),
])
def test_rejects_bad_counts(client, units, msg):
    mh = manager_token(client)
    ck = cook_token(client, add_cook(client, mh, "Sam"))
    body = report()
    body["items"][0]["units"] = units
    r = client.post("/api/reports", json=body, headers=ck)
    assert r.status_code == 422 and msg in r.json()["detail"]


def test_half_prep_and_weighed_leftovers(client):
    mh = manager_token(client)
    ck = cook_token(client, add_cook(client, mh, "Sam"))
    body = report()
    body["items"] = [{"pid": "chk", "name": "Chicken", "units": [{"k": "prep", "qty": 2.5, "each": 7.5}],
                      "entries": [{"type": "prepared", "gross": 8.5, "tare": 0.5}]}]
    assert client.post("/api/reports", json=body, headers=ck).json()["total"] == 26.75  # 18.75 + 8
    body["id"] = "x2"
    body["items"][0]["entries"] = [{"type": "prepared", "gross": 1, "tare": 2}]
    assert client.post("/api/reports", json=body, headers=ck).status_code == 422


def test_resending_same_report_is_safe(client):
    mh = manager_token(client)
    ck = cook_token(client, add_cook(client, mh, "Sam"))
    body = report()
    assert client.post("/api/reports", json=body, headers=ck).json()["duplicate"] is False
    assert client.post("/api/reports", json=body, headers=ck).json()["duplicate"] is True
    assert len(client.get("/api/reports", headers=mh).json()) == 1


def test_auth_rules(client):
    assert client.get("/api/reports").status_code == 401
    mh = manager_token(client)
    assert client.post("/api/manager/setup", json={"password": "another-pass"}).status_code == 409
    cid = add_cook(client, mh, "Sam")
    ck = cook_token(client, cid)
    assert client.get("/api/reports", headers=ck).status_code == 401          # cooks can't read all reports
    assert client.put("/api/config", json={"proteins": []}, headers=ck).status_code == 401
    assert client.post("/api/login", json={"cook_id": cid, "pin": "9999"}).status_code == 401
    # changing the PIN logs the old phone out
    client.patch(f"/api/manager/cooks/{cid}", json={"pin": "5678"}, headers=mh)
    assert client.post("/api/reports", json=report(), headers=ck).status_code == 401
    # deactivated cooks can't log in
    client.patch(f"/api/manager/cooks/{cid}", json={"active": False}, headers=mh)
    assert client.post("/api/login", json={"cook_id": cid, "pin": "5678"}).status_code == 401
    assert client.get("/api/cooks").json() == []


def test_pin_lockout(client):
    mh = manager_token(client)
    cid = add_cook(client, mh, "Sam")
    for _ in range(5):
        client.post("/api/login", json={"cook_id": cid, "pin": "0000"})
    assert client.post("/api/login", json={"cook_id": cid, "pin": "1234"}).status_code == 429


def test_weights_saved_for_everyone(client):
    mh = manager_token(client)
    conf = client.get("/api/config").json()
    avo = next(p for p in conf["proteins"] if p["id"] == "avo")
    assert avo["units"] == {"box": 0}
    avo["units"]["box"] = 10
    assert client.put("/api/config", json=conf, headers=mh).status_code == 200
    assert next(p for p in client.get("/api/config").json()["proteins"] if p["id"] == "avo")["units"]["box"] == 10
    conf["proteins"][0]["units"] = {"prep": 500}
    assert client.put("/api/config", json=conf, headers=mh).status_code == 422


def test_csv_export_and_delete(client):
    mh = manager_token(client)
    ck = cook_token(client, add_cook(client, mh, "Sam"))
    rid = client.post("/api/reports", json=report(), headers=ck).json()["id"]
    csv_text = client.get("/api/export.csv", headers=mh).text
    assert "Chicken" in csv_text and "105.0" in csv_text and "Sam" in csv_text
    assert client.delete(f"/api/reports/{rid}", headers=mh).status_code == 200
    assert client.get("/api/reports", headers=mh).json() == []


def test_cook_sees_only_own_reports(client):
    mh = manager_token(client)
    a, b = add_cook(client, mh, "A"), add_cook(client, mh, "B")
    ta, tb = cook_token(client, a), cook_token(client, b)
    rid = client.post("/api/reports", json=report(), headers=ta).json()["id"]
    assert len(client.get("/api/my/reports", headers=ta).json()) == 1
    assert client.get("/api/my/reports", headers=tb).json() == []
    assert client.get(f"/api/my/reports/{rid}", headers=tb).status_code == 404


def test_manager_adds_new_item_and_cooks_count_it(client):
    mh = manager_token(client)
    conf = client.get("/api/config").json()
    conf["proteins"].append({"id": "ptomato1", "name": "Tomatoes", "units": {"box": 5}})
    assert client.put("/api/config", json=conf, headers=mh).status_code == 200
    assert "Tomatoes" in [p["name"] for p in client.get("/api/config").json()["proteins"]]
    ck = cook_token(client, add_cook(client, mh, "Sam"))
    body = report(items=[{"pid": "ptomato1", "name": "Tomatoes", "units": [{"k": "box", "qty": 3, "each": 5}], "entries": []}])
    assert client.post("/api/reports", json=body, headers=ck).json()["total"] == 15
