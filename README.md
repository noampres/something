# Game Library

A private website for tracking a video game collection and wishlist, with prices
from DekuDeals, reviews from Metacritic and Backloggd, and play times from
HowLongToBeat. Each game has a completion percentage and a half-star rating.

## Structure

```
game-library/
├── app.py               # the website (Flask)
├── templates/           # page templates
├── static/style.css     # styling (dark/light follows your device)
├── db/
│   ├── schema.sql       # database schema
│   └── game_library.db  # your data (SQLite, created on first run, not in git)
├── scripts/
│   └── init_db.py       # create an empty database (safe to re-run)
├── requirements.txt
└── Procfile             # start command for hosting
```

## Run it on your computer

```
pip install -r requirements.txt
APP_PASSWORD=choose-a-password python3 app.py
```

Then open http://localhost:5000. On Windows PowerShell:

```
$env:APP_PASSWORD="choose-a-password"; python app.py
```

The database is created automatically the first time the site starts.

## Put it on the web (Railway)

1. On railway.app, create a project → **Deploy from GitHub repo** → pick this repo.
2. Add a **Volume** to the service, mounted at `/data`.
3. Under **Variables**, set:
   - `APP_PASSWORD` — your login password
   - `SECRET_KEY` — any long random string (keeps you logged in between restarts)
   - `DB_PATH` — `/data/game_library.db`
   - `COOKIE_SECURE` — `1`
4. Under **Settings → Networking**, generate a domain, then open it.

Any host that runs Python with persistent disk works the same way
(Fly.io with a volume, Render with a disk, or a small VPS). Without a
persistent volume your data is wiped on every redeploy.

## Using the site

- **Collection**: status, completion %, hours, your rating, review scores, HLTB time.
- **Wishlist**: current price, a "Lowest price" badge when a game is at its
  historical low, and a "Target hit" badge when the price drops to your
  "I'd buy at" price. Tick **Deals only** to see just the games on sale.
- Click any game to edit it. Moving a game from Wishlist to Collection is
  just changing the **List** field.
- **Record a price** on a game's page each time it changes; every change is
  kept, so each game builds a price history and a historical low.
- Scores, play times and reviews are entered on the game's page, with a link
  field for the game's page on each source site.

## Database overview

| Table | Holds | Source |
|---|---|---|
| `games` | title, developer, publisher, release date, cover | all |
| `platforms`, `game_platforms` | platforms per game | all |
| `genres`, `game_genres` | genres per game | all |
| `library_entries` | collection/wishlist, status, completion %, hours, rating (1–10 = 0.5–5 stars), prices paid/target, priority | you |
| `source_links` | each game's page on each source site | all |
| `prices` | store, regular/current price, discount, sale end, historical low — one row per change | DekuDeals |
| `metacritic_scores` | metascore, critic breakdown, user score, Must-Play | Metacritic |
| `backloggd_stats` | average rating and community counts | Backloggd |
| `hltb_times` | main, main + extras, completionist, all styles (hours) | HowLongToBeat |
| `reviews` | individual critic/user reviews | Metacritic, Backloggd |

The `library_overview` view joins it all into one row per library entry.
