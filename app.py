"""Game Library: a private site for a video game collection and wishlist.

Data per game: prices (DekuDeals), reviews (Metacritic, Backloggd),
play times (HowLongToBeat), plus your own status, completion % and rating.
"""
import hmac
import os
import re
import secrets
import sqlite3
from datetime import date
from functools import wraps

from flask import (Flask, abort, flash, g, redirect, render_template,
                   request, session, url_for)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE_DIR, "db", "game_library.db"))
SCHEMA_PATH = os.path.join(BASE_DIR, "db", "schema.sql")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")

if not APP_PASSWORD:
    raise RuntimeError("Set the APP_PASSWORD environment variable before starting the site.")

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY") or secrets.token_hex(32),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE") == "1",
)

STATUSES = [
    ("not_started", "Not started"),
    ("playing", "Playing"),
    ("paused", "Paused"),
    ("completed", "Completed"),
    ("mastered", "Mastered"),
    ("abandoned", "Abandoned"),
]
STATUS_LABELS = dict(STATUSES)
OWNERSHIP = [("physical", "Physical"), ("digital", "Digital"), ("subscription", "Subscription")]
LISTS = [("collection", "Collection"), ("wishlist", "Wishlist")]
SOURCES = [("dekudeals", "DekuDeals"), ("backloggd", "Backloggd"),
           ("metacritic", "Metacritic"), ("howlongtobeat", "HowLongToBeat")]


# ------------------------------------------------------------------ database

def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        schema = f.read()
    conn = connect()
    conn.executescript(schema)
    conn.close()


def get_db():
    if "db" not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


init_db()


# ------------------------------------------------------- login and CSRF guard

def csrf_token():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


app.jinja_env.globals["csrf_token"] = csrf_token


@app.before_request
def guard():
    if request.endpoint == "static":
        return None
    if request.method == "POST":
        sent = request.form.get("csrf", "")
        if not session.get("csrf") or not hmac.compare_digest(session["csrf"], sent):
            abort(400)
    if request.endpoint != "login" and not session.get("auth"):
        return redirect(url_for("login", next=request.path))
    return None


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        if hmac.compare_digest(request.form.get("password", ""), APP_PASSWORD):
            session.clear()
            session["auth"] = True
            session.permanent = True
            nxt = request.args.get("next", "")
            return redirect(nxt if nxt.startswith("/") and not nxt.startswith("//") else url_for("index"))
        flash("Wrong password.", "error")
    return render_template("login.html")


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


# ------------------------------------------------------------ template helpers

@app.template_filter("stars")
def stars_filter(rating):
    if not rating:
        return ""
    full, half = divmod(int(rating), 2)
    return "★" * full + ("½" if half else "")


@app.template_filter("num")
def num_filter(value):
    if value is None or value == "":
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


@app.template_filter("money")
def money_filter(value, currency="USD"):
    if value is None:
        return "—"
    symbol = {"USD": "$", "EUR": "€", "GBP": "£", "ILS": "₪", "JPY": "¥"}.get(currency or "USD")
    return f"{symbol}{value:,.2f}" if symbol else f"{value:,.2f} {currency}"


@app.context_processor
def constants():
    return dict(STATUSES=STATUSES, STATUS_LABELS=STATUS_LABELS, OWNERSHIP=OWNERSHIP,
                LISTS=LISTS, SOURCES=SOURCES)


# -------------------------------------------------------------- form parsing

class FormError(ValueError):
    pass


def field(form, col=None, kind="text", lo=None, hi=None, label=None, choices=None):
    return dict(form=form, col=col or form, kind=kind, lo=lo, hi=hi,
                label=label or form.replace("_", " ").capitalize(), choices=choices)


GAME_FIELDS = [
    field("title", label="Title"),
    field("developer"), field("publisher"),
    field("release_date", kind="date", label="Release date"),
    field("cover_image_url", label="Cover image URL"),
    field("description"),
]
ENTRY_FIELDS = [
    field("list_type", kind="choice", choices=[k for k, _ in LISTS], label="List"),
    field("ownership_format", kind="choice", choices=[k for k, _ in OWNERSHIP], label="Format"),
    field("play_status", kind="choice", choices=[k for k, _ in STATUSES], label="Status"),
    field("completion_percentage", kind="float", lo=0, hi=100, label="Completion %"),
    field("hours_played", kind="float", lo=0, label="Hours played"),
    field("personal_rating", kind="int", lo=1, hi=10, label="Your rating"),
    field("personal_review", label="Your review"),
    field("purchase_price", kind="float", lo=0, label="Price paid"),
    field("purchase_currency", label="Currency"),
    field("purchase_date", kind="date", label="Purchase date"),
    field("target_price", kind="float", lo=0, label="I'd buy at"),
    field("priority", kind="int", lo=1, hi=5, label="Priority"),
    field("started_at", kind="date", label="Started"),
    field("completed_at", kind="date", label="Completed"),
    field("notes"),
]
MC_FIELDS = [
    field("metascore", kind="int", lo=0, hi=100, label="Metascore"),
    field("critic_review_count", kind="int", lo=0, label="Critic reviews"),
    field("critic_positive", kind="int", lo=0, label="Positive"),
    field("critic_mixed", kind="int", lo=0, label="Mixed"),
    field("critic_negative", kind="int", lo=0, label="Negative"),
    field("mc_user_score", "user_score", kind="float", lo=0, hi=10, label="User score"),
    field("mc_user_review_count", "user_review_count", kind="int", lo=0, label="User reviews"),
    field("must_play", kind="bool", label="Must-Play"),
]
BL_FIELDS = [
    field("bl_average_rating", "average_rating", kind="float", lo=0, hi=5, label="Average rating"),
    field("bl_rating_count", "rating_count", kind="int", lo=0, label="Ratings"),
    field("bl_review_count", "review_count", kind="int", lo=0, label="Reviews"),
    field("bl_plays_count", "plays_count", kind="int", lo=0, label="Played"),
    field("bl_playing_count", "playing_count", kind="int", lo=0, label="Playing"),
    field("bl_backlog_count", "backlog_count", kind="int", lo=0, label="Backlogged"),
    field("bl_wishlist_count", "wishlist_count", kind="int", lo=0, label="Wishlisted"),
]
HLTB_FIELDS = [
    field("main_story_hours", kind="float", lo=0, label="Main story"),
    field("main_extras_hours", kind="float", lo=0, label="Main + extras"),
    field("completionist_hours", kind="float", lo=0, label="Completionist"),
    field("all_styles_hours", kind="float", lo=0, label="All styles"),
    field("hltb_submissions_count", "submissions_count", kind="int", lo=0, label="Submissions"),
]
PRICE_FIELDS = [
    field("price_store", "store", label="Store"),
    field("price_format", "format", kind="choice", choices=["physical", "digital"], label="Format"),
    field("price_currency", "currency", label="Currency"),
    field("regular_price", kind="float", lo=0, label="Regular price"),
    field("current_price", kind="float", lo=0, label="Current price"),
    field("sale_ends_at", kind="date", label="Sale ends"),
    field("price_url", "url", label="Store link"),
]
REVIEW_FIELDS = [
    field("source", kind="choice", choices=["metacritic", "backloggd"], label="Source"),
    field("reviewer_type", kind="choice", choices=["critic", "user"], label="Type"),
    field("reviewer_name", label="Reviewer"),
    field("publication"),
    field("score", kind="float", lo=0, label="Score"),
    field("score_scale", kind="float", lo=0, label="Out of"),
    field("summary"),
    field("url", label="Link"),
    field("published_at", kind="date", label="Published"),
]


def parse(fields, form):
    """Turn submitted form values into {column: value}, validating each."""
    out = {}
    for f in fields:
        raw = (form.get(f["form"]) or "").strip()
        if f["kind"] == "bool":
            out[f["col"]] = 1 if raw else 0
            continue
        if not raw:
            out[f["col"]] = None
            continue
        if f["kind"] in ("int", "float"):
            try:
                value = int(raw) if f["kind"] == "int" else float(raw)
            except ValueError:
                raise FormError(f"{f['label']}: “{raw}” is not a number.")
            if (f["lo"] is not None and value < f["lo"]) or (f["hi"] is not None and value > f["hi"]):
                bounds = f"{f['lo']}–{f['hi']}" if f["hi"] is not None else f"at least {f['lo']}"
                raise FormError(f"{f['label']} must be {bounds}.")
        elif f["kind"] == "date":
            try:
                value = date.fromisoformat(raw).isoformat()
            except ValueError:
                raise FormError(f"{f['label']}: use a date like 2026-10-15.")
        elif f["kind"] == "choice":
            if raw not in f["choices"]:
                raise FormError(f"{f['label']}: invalid choice.")
            value = raw
        else:
            value = raw
        out[f["col"]] = value
    return out


def slugify(title):
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "game"


def platform_id_for(db, name):
    name = (name or "").strip()
    if not name:
        return None
    db.execute("INSERT OR IGNORE INTO platforms (name) VALUES (?)", (name,))
    return db.execute("SELECT id FROM platforms WHERE name = ?", (name,)).fetchone()["id"]


def set_genres(db, game_id, text):
    db.execute("DELETE FROM game_genres WHERE game_id = ?", (game_id,))
    for name in {n.strip() for n in (text or "").split(",") if n.strip()}:
        db.execute("INSERT OR IGNORE INTO genres (name) VALUES (?)", (name,))
        gid = db.execute("SELECT id FROM genres WHERE name = ?", (name,)).fetchone()["id"]
        db.execute("INSERT OR IGNORE INTO game_genres VALUES (?, ?)", (game_id, gid))


def save_sources(db, game_id, platform_id, form):
    """Write Metacritic, Backloggd, HowLongToBeat and source-link data for a game."""
    mc, bl, hl = parse(MC_FIELDS, form), parse(BL_FIELDS, form), parse(HLTB_FIELDS, form)
    urls = {key: (form.get(f"url_{key}") or "").strip() or None for key, _ in SOURCES}

    for key, url in urls.items():
        if url:
            db.execute("INSERT OR REPLACE INTO source_links (game_id, source, url, last_synced) "
                       "VALUES (?, ?, ?, datetime('now'))", (game_id, key, url))
        else:
            db.execute("DELETE FROM source_links WHERE game_id = ? AND source = ?", (game_id, key))

    db.execute("DELETE FROM metacritic_scores WHERE game_id = ? AND platform_id IS ?",
               (game_id, platform_id))
    if any(v is not None for k, v in mc.items() if k != "must_play") or mc["must_play"] \
            or urls["metacritic"]:
        cols = list(mc)
        db.execute(f"INSERT INTO metacritic_scores (game_id, platform_id, url, {', '.join(cols)}) "
                   f"VALUES (?, ?, ?, {', '.join('?' * len(cols))})",
                   (game_id, platform_id, urls["metacritic"], *mc.values()))

    for table, data, url in (("backloggd_stats", bl, urls["backloggd"]),
                             ("hltb_times", hl, urls["howlongtobeat"])):
        if any(v is not None for v in data.values()) or url:
            cols = list(data)
            db.execute(f"INSERT OR REPLACE INTO {table} (game_id, url, {', '.join(cols)}) "
                       f"VALUES (?, ?, {', '.join('?' * len(cols))})", (game_id, url, *data.values()))
        else:
            db.execute(f"DELETE FROM {table} WHERE game_id = ?", (game_id,))


def record_price(db, game_id, platform_id, data):
    """Add a price row for a store if it changed. Returns True when a row was added."""
    if data["current_price"] is None and data["regular_price"] is None:
        return False
    if not data["store"]:
        raise FormError("Store is required when entering a price.")
    currency = data["currency"] or "USD"
    last = db.execute("SELECT * FROM prices WHERE game_id = ? AND store = ? "
                      "ORDER BY fetched_at DESC, id DESC LIMIT 1", (game_id, data["store"])).fetchone()
    if last and all(last[k] == data[k] for k in ("current_price", "regular_price", "sale_ends_at", "format")):
        return False

    current, regular = data["current_price"], data["regular_price"]
    low, low_date = (last["historical_low"], last["historical_low_date"]) if last else (None, None)
    if current is not None and (low is None or current < low):
        low, low_date = current, date.today().isoformat()
    discount = 0.0
    if current is not None and regular and current < regular:
        discount = round((1 - current / regular) * 100, 1)

    db.execute("""INSERT INTO prices (game_id, platform_id, store, format, currency, regular_price,
                  current_price, discount_percent, sale_ends_at, historical_low, historical_low_date,
                  is_on_sale, url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
               (game_id, platform_id, data["store"], data["format"], currency, regular, current,
                discount, data["sale_ends_at"], low, low_date, 1 if discount > 0 else 0, data["url"]))
    return True


def entry_values(entry):
    values = parse(ENTRY_FIELDS, request.form)
    values["play_status"] = values["play_status"] or "not_started"
    values["list_type"] = values["list_type"] or (entry["list_type"] if entry else "collection")
    values["completion_percentage"] = values["completion_percentage"] or 0
    values["purchase_currency"] = values["purchase_currency"] or "USD"
    return values


# --------------------------------------------------------------- list pages

LIST_SQL = """
SELECT le.*, g.title, g.cover_image_url, g.release_date, p.name AS platform,
  (SELECT MIN(lp.current_price) FROM prices lp
     WHERE lp.game_id = g.id
       AND lp.id = (SELECT p2.id FROM prices p2 WHERE p2.game_id = lp.game_id AND p2.store = lp.store
                    ORDER BY p2.fetched_at DESC, p2.id DESC LIMIT 1)) AS best_price,
  (SELECT MAX(lp.discount_percent) FROM prices lp
     WHERE lp.game_id = g.id
       AND lp.id = (SELECT p2.id FROM prices p2 WHERE p2.game_id = lp.game_id AND p2.store = lp.store
                    ORDER BY p2.fetched_at DESC, p2.id DESC LIMIT 1)) AS discount,
  (SELECT MIN(CASE WHEN pr.historical_low IS NOT NULL
                    AND (pr.current_price IS NULL OR pr.historical_low < pr.current_price)
                   THEN pr.historical_low ELSE pr.current_price END)
     FROM prices pr WHERE pr.game_id = g.id) AS low_price,
  mc.metascore AS metascore, mc.user_score AS mc_user_score, mc.must_play AS must_play,
  bl.average_rating AS bl_rating,
  h.main_story_hours, h.main_extras_hours, h.completionist_hours
FROM library_entries le
JOIN games g ON g.id = le.game_id
LEFT JOIN platforms p ON p.id = le.platform_id
LEFT JOIN metacritic_scores mc ON mc.rowid = COALESCE(
    (SELECT m2.rowid FROM metacritic_scores m2
      WHERE m2.game_id = le.game_id AND m2.platform_id IS le.platform_id),
    (SELECT MIN(m3.rowid) FROM metacritic_scores m3 WHERE m3.game_id = le.game_id))
LEFT JOIN backloggd_stats bl ON bl.game_id = g.id
LEFT JOIN hltb_times h ON h.game_id = g.id
"""

SORTS = {
    "title": ("Title", "g.title COLLATE NOCASE"),
    "recent": ("Recently added", "le.created_at DESC, le.id DESC"),
    "status": ("Status", "le.play_status, g.title COLLATE NOCASE"),
    "completion": ("Completion", "le.completion_percentage DESC"),
    "rating": ("Your rating", "le.personal_rating IS NULL, le.personal_rating DESC"),
    "metascore": ("Metascore", "metascore IS NULL, metascore DESC"),
    "backloggd": ("Backloggd rating", "bl_rating IS NULL, bl_rating DESC"),
    "length": ("Length (main story)", "h.main_story_hours IS NULL, h.main_story_hours"),
    "price": ("Price", "best_price IS NULL, best_price"),
    "discount": ("Biggest discount", "discount IS NULL, discount DESC"),
    "priority": ("Priority", "le.priority IS NULL, le.priority DESC"),
}


@app.route("/")
def index():
    return redirect(url_for("show_list", list_type="collection"))


@app.route("/<any(collection, wishlist):list_type>")
def show_list(list_type):
    db = get_db()
    args = request.args
    default_sort = "title" if list_type == "collection" else "priority"
    sort = args.get("sort") if args.get("sort") in SORTS else default_sort
    where, params = ["le.list_type = ?"], [list_type]
    if args.get("q"):
        where.append("g.title LIKE ?")
        params.append(f"%{args['q']}%")
    if args.get("status") in STATUS_LABELS:
        where.append("le.play_status = ?")
        params.append(args["status"])
    if args.get("platform"):
        where.append("p.name = ?")
        params.append(args["platform"])
    rows = db.execute(f"{LIST_SQL} WHERE {' AND '.join(where)} "
                      f"ORDER BY {SORTS[sort][1]}, g.title COLLATE NOCASE", params).fetchall()

    games = []
    for r in rows:
        item = dict(r)
        item["at_low"] = r["best_price"] is not None and r["low_price"] is not None \
            and r["best_price"] <= r["low_price"]
        item["target_hit"] = r["best_price"] is not None and r["target_price"] is not None \
            and r["best_price"] <= r["target_price"]
        games.append(item)

    if args.get("deals") == "1":
        games = [x for x in games if x["at_low"] or x["target_hit"] or (x["discount"] or 0) > 0]

    count = len(games)
    stats = {"count": count}
    if list_type == "collection":
        stats["finished"] = sum(1 for x in games if x["play_status"] in ("completed", "mastered"))
        stats["playing"] = sum(1 for x in games if x["play_status"] == "playing")
        stats["avg_completion"] = round(sum(x["completion_percentage"] for x in games) / count) if count else 0
        stats["hours"] = round(sum(x["hours_played"] or 0 for x in games))
    else:
        stats["on_sale"] = sum(1 for x in games if (x["discount"] or 0) > 0)
        stats["target_hits"] = sum(1 for x in games if x["target_hit"])
        stats["total"] = sum(x["best_price"] or 0 for x in games)

    platforms = [r["name"] for r in db.execute(
        "SELECT DISTINCT p.name FROM platforms p JOIN library_entries le ON le.platform_id = p.id "
        "WHERE le.list_type = ? ORDER BY p.name", (list_type,))]
    return render_template("list.html", list_type=list_type, games=games, stats=stats,
                           sorts={k: v[0] for k, v in SORTS.items()}, sort=sort,
                           platforms=platforms, args=args)


# ----------------------------------------------------------- add / edit game

def form_from_db(db, entry):
    """Collect everything about an entry into one dict keyed by form field names."""
    game = db.execute("SELECT * FROM games WHERE id = ?", (entry["game_id"],)).fetchone()
    f = {x["form"]: game[x["col"]] for x in GAME_FIELDS}
    f.update({x["form"]: entry[x["col"]] for x in ENTRY_FIELDS})
    f["platform"] = entry["platform"]
    f["genres"] = ", ".join(r["name"] for r in db.execute(
        "SELECT ge.name FROM genres ge JOIN game_genres gg ON gg.genre_id = ge.id "
        "WHERE gg.game_id = ? ORDER BY ge.name", (game["id"],)))
    mc = db.execute("SELECT * FROM metacritic_scores WHERE game_id = ? "
                    "ORDER BY (platform_id IS ?) DESC LIMIT 1",
                    (game["id"], entry["platform_id"])).fetchone()
    for fields, row in ((MC_FIELDS, mc),
                        (BL_FIELDS, db.execute("SELECT * FROM backloggd_stats WHERE game_id = ?", (game["id"],)).fetchone()),
                        (HLTB_FIELDS, db.execute("SELECT * FROM hltb_times WHERE game_id = ?", (game["id"],)).fetchone())):
        if row:
            f.update({x["form"]: row[x["col"]] for x in fields})
    for r in db.execute("SELECT source, url FROM source_links WHERE game_id = ?", (game["id"],)):
        f[f"url_{r['source']}"] = r["url"]
    return game, f


def load_entry(db, entry_id):
    entry = db.execute("SELECT le.*, p.name AS platform FROM library_entries le "
                       "LEFT JOIN platforms p ON p.id = le.platform_id WHERE le.id = ?",
                       (entry_id,)).fetchone()
    if entry is None:
        abort(404)
    return entry


def detail_context(db, entry, game):
    prices = db.execute("SELECT * FROM prices WHERE game_id = ? ORDER BY fetched_at DESC, id DESC",
                        (game["id"],)).fetchall()
    latest, seen = [], set()
    for p in prices:
        if p["store"] not in seen:
            seen.add(p["store"])
            latest.append(p)
    reviews = db.execute("SELECT * FROM reviews WHERE game_id = ? "
                         "ORDER BY published_at IS NULL, published_at DESC, id DESC", (game["id"],)).fetchall()
    others = db.execute("SELECT le.id, le.list_type, p.name AS platform FROM library_entries le "
                        "LEFT JOIN platforms p ON p.id = le.platform_id "
                        "WHERE le.game_id = ? AND le.id != ?", (game["id"], entry["id"])).fetchall()
    return dict(prices=prices, latest_prices=latest, reviews=reviews, other_entries=others)


def all_platforms(db):
    return [r["name"] for r in db.execute("SELECT name FROM platforms ORDER BY name")]


@app.route("/game/new", methods=["GET", "POST"])
def add_game():
    db = get_db()
    list_type = request.values.get("list_type", "collection")
    if request.method == "POST":
        try:
            game = parse(GAME_FIELDS, request.form)
            if not game["title"]:
                raise FormError("Title is required.")
            values = entry_values(None)
            price = parse(PRICE_FIELDS, request.form)
            slug = slugify(game["title"])
            existing = db.execute("SELECT id FROM games WHERE slug = ?", (slug,)).fetchone()
            if existing:
                game_id = existing["id"]
                given = {k: v for k, v in game.items() if v is not None}
                db.execute(f"UPDATE games SET {', '.join(f'{k} = ?' for k in given)} WHERE id = ?",
                           (*given.values(), game_id))
            else:
                game_id = db.execute(
                    f"INSERT INTO games (slug, {', '.join(game)}) VALUES (?, {', '.join('?' * len(game))})",
                    (slug, *game.values())).lastrowid
            pid = platform_id_for(db, request.form.get("platform"))
            if pid:
                db.execute("INSERT OR IGNORE INTO game_platforms VALUES (?, ?)", (game_id, pid))
            if request.form.get("genres", "").strip():
                set_genres(db, game_id, request.form["genres"])
            entry_id = db.execute(
                f"INSERT INTO library_entries (game_id, platform_id, {', '.join(values)}) "
                f"VALUES (?, ?, {', '.join('?' * len(values))})",
                (game_id, pid, *values.values())).lastrowid
            save_sources(db, game_id, pid, request.form)
            record_price(db, game_id, pid, price)
            db.commit()
            flash(f"Added {game['title']}.", "ok")
            return redirect(url_for("edit_entry", entry_id=entry_id))
        except FormError as e:
            db.rollback()
            flash(str(e), "error")
        except sqlite3.IntegrityError:
            db.rollback()
            flash("That game is already on this list for that platform.", "error")
        f = request.form.to_dict()
    else:
        f = {"list_type": list_type if list_type in ("collection", "wishlist") else "collection",
             "play_status": "not_started", "completion_percentage": 0}
    return render_template("game.html", f=f, entry=None, game=None, list_type=f.get("list_type"),
                           platforms=all_platforms(db), new=True)


@app.route("/entry/<int:entry_id>", methods=["GET", "POST"])
def edit_entry(entry_id):
    db = get_db()
    entry = load_entry(db, entry_id)
    if request.method == "POST":
        try:
            game = parse(GAME_FIELDS, request.form)
            if not game["title"]:
                raise FormError("Title is required.")
            values = entry_values(entry)
            gid = entry["game_id"]
            db.execute(f"UPDATE games SET slug = ?, {', '.join(f'{k} = ?' for k in game)} WHERE id = ?",
                       (slugify(game["title"]), *game.values(), gid))
            pid = platform_id_for(db, request.form.get("platform"))
            if pid:
                db.execute("INSERT OR IGNORE INTO game_platforms VALUES (?, ?)", (gid, pid))
            set_genres(db, gid, request.form.get("genres"))
            db.execute(f"UPDATE library_entries SET platform_id = ?, "
                       f"{', '.join(f'{k} = ?' for k in values)} WHERE id = ?",
                       (pid, *values.values(), entry_id))
            if pid != entry["platform_id"]:
                db.execute("UPDATE metacritic_scores SET platform_id = ? "
                           "WHERE game_id = ? AND platform_id IS ?", (pid, gid, entry["platform_id"]))
            save_sources(db, gid, pid, request.form)
            db.commit()
            flash("Saved.", "ok")
            return redirect(url_for("edit_entry", entry_id=entry_id))
        except FormError as e:
            db.rollback()
            flash(str(e), "error")
        except sqlite3.IntegrityError:
            db.rollback()
            flash("Couldn't save: another game already has that title, or this game is already "
                  "on that list for that platform.", "error")
        game = db.execute("SELECT * FROM games WHERE id = ?", (entry["game_id"],)).fetchone()
        f = request.form.to_dict()
    else:
        game, f = form_from_db(db, entry)
    return render_template("game.html", f=f, entry=entry, game=game, new=False,
                           list_type=entry["list_type"],
                           platforms=all_platforms(db), **detail_context(db, entry, game))


@app.route("/entry/<int:entry_id>/price", methods=["POST"])
def add_price(entry_id):
    db = get_db()
    entry = load_entry(db, entry_id)
    try:
        added = record_price(db, entry["game_id"], entry["platform_id"], parse(PRICE_FIELDS, request.form))
        db.commit()
        flash("Price recorded." if added else "Price unchanged, nothing added.", "ok")
    except FormError as e:
        db.rollback()
        flash(str(e), "error")
    return redirect(url_for("edit_entry", entry_id=entry_id) + "#prices")


@app.route("/entry/<int:entry_id>/price/<int:price_id>/delete", methods=["POST"])
def delete_price(entry_id, price_id):
    db = get_db()
    entry = load_entry(db, entry_id)
    db.execute("DELETE FROM prices WHERE id = ? AND game_id = ?", (price_id, entry["game_id"]))
    db.commit()
    return redirect(url_for("edit_entry", entry_id=entry_id) + "#prices")


@app.route("/entry/<int:entry_id>/review", methods=["POST"])
def add_review(entry_id):
    db = get_db()
    entry = load_entry(db, entry_id)
    try:
        r = parse(REVIEW_FIELDS, request.form)
        if not r["source"]:
            raise FormError("Pick a source for the review.")
        if not (r["summary"] or r["score"] is not None):
            raise FormError("Add a score or a summary.")
        db.execute(f"INSERT INTO reviews (game_id, {', '.join(r)}) VALUES (?, {', '.join('?' * len(r))})",
                   (entry["game_id"], *r.values()))
        db.commit()
        flash("Review added.", "ok")
    except FormError as e:
        flash(str(e), "error")
    return redirect(url_for("edit_entry", entry_id=entry_id) + "#reviews")


@app.route("/entry/<int:entry_id>/review/<int:review_id>/delete", methods=["POST"])
def delete_review(entry_id, review_id):
    db = get_db()
    entry = load_entry(db, entry_id)
    db.execute("DELETE FROM reviews WHERE id = ? AND game_id = ?", (review_id, entry["game_id"]))
    db.commit()
    return redirect(url_for("edit_entry", entry_id=entry_id) + "#reviews")


@app.route("/entry/<int:entry_id>/delete", methods=["POST"])
def delete_entry(entry_id):
    db = get_db()
    entry = load_entry(db, entry_id)
    db.execute("DELETE FROM library_entries WHERE id = ?", (entry_id,))
    remaining = db.execute("SELECT COUNT(*) FROM library_entries WHERE game_id = ?",
                           (entry["game_id"],)).fetchone()[0]
    if remaining == 0:
        db.execute("DELETE FROM games WHERE id = ?", (entry["game_id"],))
    db.commit()
    flash("Removed.", "ok")
    return redirect(url_for("show_list", list_type=entry["list_type"]))


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=False)
