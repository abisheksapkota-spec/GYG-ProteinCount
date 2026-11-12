"""Tiny database layer for SQLite (default), PostgreSQL or MySQL/MariaDB.

Pick one with DATABASE_URL:
  (not set)                          SQLite file in ./data
  postgresql://user:pass@host/db     PostgreSQL
  mysql://user:pass@host:3306/db     MySQL 8 or MariaDB  (add ?ssl=true for cloud hosts)

SQL is written once with `?` placeholders and adapted per database.
Every call opens a short-lived connection, which is plenty for a store.
"""
import os
import sqlite3
from contextlib import contextmanager
from urllib.parse import parse_qs, unquote, urlparse


def _schema(dialect: str) -> list[str]:
    if dialect == "mysql":
        tail = " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        return [
            "CREATE TABLE IF NOT EXISTS settings (`key` VARCHAR(64) PRIMARY KEY, value MEDIUMTEXT NOT NULL)" + tail,
            """CREATE TABLE IF NOT EXISTS cooks (
                id VARCHAR(64) PRIMARY KEY, name VARCHAR(80) NOT NULL, pin_hash VARCHAR(200) NOT NULL,
                active TINYINT NOT NULL DEFAULT 1, created_at VARCHAR(32) NOT NULL)""" + tail,
            """CREATE TABLE IF NOT EXISTS reports (
                id VARCHAR(64) PRIMARY KEY, cook_id VARCHAR(64), cook_name VARCHAR(80) NOT NULL,
                started_at VARCHAR(32), submitted_at VARCHAR(32) NOT NULL, received_at VARCHAR(32) NOT NULL,
                total DOUBLE NOT NULL, missing INT NOT NULL, data MEDIUMTEXT NOT NULL,
                INDEX reports_submitted (submitted_at), INDEX reports_cook (cook_id))""" + tail,
        ]
    return [
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        """CREATE TABLE IF NOT EXISTS cooks (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS reports (
            id TEXT PRIMARY KEY, cook_id TEXT, cook_name TEXT NOT NULL,
            started_at TEXT, submitted_at TEXT NOT NULL, received_at TEXT NOT NULL,
            total REAL NOT NULL, missing INTEGER NOT NULL, data TEXT NOT NULL)""",
        "CREATE INDEX IF NOT EXISTS reports_submitted ON reports (submitted_at)",
        "CREATE INDEX IF NOT EXISTS reports_cook ON reports (cook_id)",
    ]


class Database:
    def __init__(self, url: str | None = None):
        url = url if url is not None else os.environ.get("DATABASE_URL", "")
        if url.startswith(("postgres://", "postgresql://")):
            self.dialect = "pg"
            import psycopg
            from psycopg.rows import dict_row
            self._connect = lambda: psycopg.connect(url, row_factory=dict_row)
        elif url.startswith(("mysql://", "mysql+pymysql://", "mariadb://")):
            self.dialect = "mysql"
            import pymysql
            from pymysql.constants import CLIENT
            u = urlparse(url)
            opts = {k: v[0] for k, v in parse_qs(u.query).items()}
            ssl = {"ca": opts["ssl_ca"]} if "ssl_ca" in opts else ({} if opts.get("ssl", "").lower() in ("1", "true", "required") else None)
            kwargs = dict(host=u.hostname or "localhost", port=u.port or 3306, user=unquote(u.username or ""),
                          password=unquote(u.password or ""), database=u.path.lstrip("/"), charset="utf8mb4",
                          cursorclass=pymysql.cursors.DictCursor, client_flag=CLIENT.FOUND_ROWS)
            if ssl is not None:
                kwargs["ssl"] = ssl
            if "unix_socket" in opts:
                kwargs["unix_socket"] = opts["unix_socket"]
            self._connect = lambda: pymysql.connect(**kwargs)
        else:
            self.dialect = "sqlite"
            path = url.removeprefix("sqlite:///") if url else os.path.join(os.path.dirname(__file__), "..", "data", "protein-count.db")
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

            def connect():
                conn = sqlite3.connect(path)
                conn.row_factory = sqlite3.Row
                conn.execute("PRAGMA journal_mode=WAL")
                return conn
            self._connect = connect
        self.pg = self.dialect == "pg"  # kept for older callers
        self.init()

    @contextmanager
    def _cursor(self):
        conn = self._connect()
        try:
            cur = conn.cursor()
            yield cur
            conn.commit()
        finally:
            conn.close()

    def _sql(self, sql: str) -> str:
        return sql if self.dialect == "sqlite" else sql.replace("?", "%s")

    def init(self):
        with self._cursor() as cur:
            for stmt in _schema(self.dialect):
                cur.execute(stmt)

    def all(self, sql: str, params=()) -> list[dict]:
        with self._cursor() as cur:
            cur.execute(self._sql(sql), params)
            return [dict(r) for r in cur.fetchall()]

    def one(self, sql: str, params=()) -> dict | None:
        rows = self.all(sql, params)
        return rows[0] if rows else None

    def run(self, sql: str, params=()) -> int:
        """Execute a write and return the number of affected rows."""
        with self._cursor() as cur:
            cur.execute(self._sql(sql), params)
            return cur.rowcount

    def insert_ignore(self, table: str, row: dict) -> int:
        """Insert a row unless its primary key already exists. Returns 1 if inserted, 0 if it was there."""
        cols, marks = ", ".join(row), ", ".join("?" for _ in row)
        if self.dialect == "mysql":
            sql = f"INSERT IGNORE INTO {table} ({cols}) VALUES ({marks})"
        else:
            sql = f"INSERT INTO {table} ({cols}) VALUES ({marks}) ON CONFLICT (id) DO NOTHING"
        return self.run(sql, tuple(row.values()))

    # --- settings (JSON text values); `key` is a reserved word in MySQL ---
    def _key(self) -> str:
        return "`key`" if self.dialect == "mysql" else "key"

    def get_setting(self, key: str) -> str | None:
        row = self.one(f"SELECT value FROM settings WHERE {self._key()} = ?", (key,))
        return row["value"] if row else None

    def set_setting(self, key: str, value: str):
        if self.dialect == "mysql":
            self.run("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", (key, value))
        else:
            self.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", (key, value))
