"""Create an empty Game Library database (safe to re-run; existing data is kept).

Usage:  python3 scripts/init_db.py            -> db/game_library.db
        DB_PATH=/data/game_library.db python3 scripts/init_db.py
"""
import os
import sqlite3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "db", "game_library.db"))
SCHEMA_PATH = os.path.join(ROOT, "db", "schema.sql")

os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
with open(SCHEMA_PATH, encoding="utf-8") as f:
    schema = f.read()
conn = sqlite3.connect(DB_PATH)
conn.executescript(schema)
conn.close()
print(f"Database ready at {DB_PATH}")
