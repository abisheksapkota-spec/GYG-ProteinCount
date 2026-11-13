"""Load settings from .env.local / .env in the project folder (no extra package needed).

`neon deploy` and `neon env pull` write the Neon connection strings there:
  DATABASE_URL           pooled connection (used by this web app)
  DATABASE_URL_UNPOOLED  direct connection (for migrations, pg_dump)
Variables already set in the real environment (e.g. on Render) always win.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def parse(text: str) -> dict[str, str]:
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        if key:
            out[key] = value
    return out


def load(folder: Path = ROOT, files=(".env.local", ".env")) -> None:
    for name in files:  # .env.local first, so it beats .env
        path = folder / name
        if path.is_file():
            for key, value in parse(path.read_text(encoding="utf-8")).items():
                os.environ.setdefault(key, value)
