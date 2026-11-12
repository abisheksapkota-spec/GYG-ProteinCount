# Protein Count

> **Quick demo (no server):** <https://abisheksapkota-spec.github.io/GYG-ProteinCount/>
> This is the single-file version (`index.html` in this folder). It saves on each phone only.
> The full web app below adds cook logins, a shared database and the manager's Reports page.

A web app for the closing protein count in a kitchen. Cooks count on their phones in the cold room, and the manager sees every cook's report from their own phone.

- **Cooks** log in with their name and a 4-digit PIN, then tap in prep containers, open packets and boxes. The app turns them into kg, shows progress (`5 / 6`) and submits the report.
- **The manager** opens `/manager` to see every report grouped by day (Today, Yesterday…), filter by cook, open the full breakdown, compare with the previous count, and export CSV. The manager also adds cooks, resets PINs and sets the weights.

Built with **Python (FastAPI)** for the server, **SQLite, PostgreSQL or MySQL** for the database, and plain **HTML, CSS and JavaScript** for the phone screens. There is no build step.

---

## How it works

```
Cook's phone  ──submit──►  Python server (FastAPI)  ──►  Database
                                   ▲
Manager's phone  /manager  ────────┘
```

### For cooks (`/`)
1. Tap your name, then type your PIN. You stay logged in for 30 days.
2. **Start closing count.** The six proteins show as *Pending* or *Done* with their kg.
3. For each protein, tap **+ / −** (or type) for:
   - **Prep containers.** Halves are allowed, e.g. 2.5. These count as *prepared* stock.
   - **Open packets** and **boxes.** Whole numbers only. These count as *unopened* stock.

   The app shows the working, e.g. `3 × 16 kg = 48.00 kg`.
4. **None in stock** records 0 kg. **Weigh odd leftovers** is a backup: type a scale reading and the container weight is taken off.
5. **Review & submit.** The app warns about missing proteins and about weights that aren't set.
6. **My reports** shows your last 20 reports.

Every tap is saved on the phone. With no signal, the report waits on the phone and **sends itself when signal returns**, even if the app was closed.

### For the manager (`/manager`)
| Tab | What you can do |
|---|---|
| **Reports** | Every closing count, newest first, grouped by day. Filter by cook and period. Tap a report for prepared, unopened and total per protein, the change since the previous count, and notes. Copy, delete, export CSV. |
| **Cooks** | Add cooks with a PIN, give someone a new PIN, remove a cook (their old reports stay), change the manager password. |
| **Weights** | Weight of one prep container, open packet and box per protein, plus which of those each protein uses. Saved for every phone. Add or remove proteins and empty-container weights. |

Default weights:

| Protein | Prep container | Open packet | Box |
|---|---|---|---|
| Chicken | 7.5 kg | not used | 7.5 kg |
| Ground Beef, Brisket, Pulled Pork, BBQ Beef Rib | 6 kg | 2 kg | 16 kg |
| Avocado | not used | not used | set by the manager |

### Accuracy and safety
- **The server recalculates every total.** A report can't contain an addition mistake, whatever the phone sends.
- Negative numbers, half packets or boxes, and weights over 100 kg are rejected.
- PINs and the manager password are stored hashed (PBKDF2).
- 5 wrong PINs lock that cook out for 5 minutes. Changing a PIN logs out that cook's old phone.
- Cooks can only see their own reports. Only the manager sees everyone's.
- Re-sending the same report (for example after signal drops) never creates a duplicate.

---

## Project structure

```
app/
  main.py        API routes, logins, and the web pages
  calc.py        validation and stock maths (server-side totals)
  db.py          SQLite / PostgreSQL / MySQL access
  security.py    password hashing, login tokens, PIN lockout
static/
  index.html, app.js          cook app
  manager.html, manager.js    manager app
  common.js, styles.css       shared code and design
  sw.js, *.webmanifest, icon* offline support and "Add to Home Screen"
tests/
  test_api.py    API tests (pytest), on SQLite, PostgreSQL or MySQL
  e2e.js         real browser test: manager + two cooks, including offline
index.html       single-file demo used by GitHub Pages (no server needed)
```

---

## Run it on your computer

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open <http://localhost:8000/manager>, create the manager password and add your cooks. Cooks use <http://localhost:8000>.

To try it on your phone over home Wi-Fi, run `uvicorn app.main:app --host 0.0.0.0` and open `http://<your computer's IP>:8000`.

## Put it online (free): Render + Neon

1. **Database:** create a free PostgreSQL database at [neon.tech](https://neon.tech) and copy its connection string (`postgresql://…`).
2. **Server:** at [render.com](https://render.com), choose **New → Blueprint** and pick this GitHub repo. `render.yaml` sets everything up.
3. When asked for `DATABASE_URL`, paste the Neon connection string.
4. Open `https://<your-app>.onrender.com/manager`, create the manager password and add cooks.
5. On each phone, open the link and choose **Add to Home Screen**.

> Render's free plan sleeps after 15 minutes without visits, so the first open after that takes about 30 seconds. A paid plan keeps it awake. Without `DATABASE_URL` the app uses a SQLite file, which free hosting deletes on every restart, so always set a PostgreSQL URL online.

### Settings (environment variables)
| Name | Needed? | What it does |
|---|---|---|
| `DATABASE_URL` | Online: yes | Which database to use (see below). Without it, a SQLite file in `data/` is used. |
| `SECRET_KEY` | Recommended | Signs login tokens. Render generates one. If missing, one is created and kept in the database. |
| `MANAGER_PASSWORD` | Optional | Always works as the manager password. Use it if you forget yours. |

### Choosing a database
All three are tested with the same tests. Set `DATABASE_URL` to one of these:

| Database | `DATABASE_URL` | When to use it |
|---|---|---|
| SQLite | *(not set)* | On your own computer. Nothing to install. |
| PostgreSQL | `postgresql://user:pass@host/dbname` | Recommended online, e.g. a free [Neon](https://neon.tech) database |
| MySQL 8 / MariaDB | `mysql://user:pass@host:3306/dbname` | If your host or company already uses MySQL. Add `?ssl=true` for cloud MySQL, or `?ssl_ca=/path/ca.pem` if your host gives you a certificate. |

The tables are created automatically on first start.

---

## Tests

```bash
pip install -r requirements-dev.txt
pytest -q                                   # API tests on SQLite
TEST_DATABASE_URL=postgresql://… pytest -q  # same tests on PostgreSQL
TEST_DATABASE_URL=mysql://… pytest -q       # same tests on MySQL

npm install && npx playwright install chromium
DATABASE_URL=sqlite:///./data/e2e.db uvicorn app.main:app --port 8765 &
npm run test:e2e                            # browser test: manager + 2 cooks + offline
```

## Roadmap
- More than one store, with an area-manager view
- Charts of stock over time, and alerts for unusual changes
- Export to the existing ordering or stock system
- Barcode scanning and Bluetooth scale input
