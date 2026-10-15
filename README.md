# Game Library

A website for tracking a video game collection and wishlist, with prices
from DekuDeals, reviews from Metacritic and Backloggd, and play times from
HowLongToBeat. Each game has a completion percentage and a half-star rating.

It's a static site that runs entirely in your browser, so it works on
GitHub Pages with no server.

## Where your data lives

Your library is saved **in the browser you use** (IndexedDB). Nothing is
uploaded, so:

- Other people who open the site see an empty library, not yours.
- Your phone and laptop each have their own copy. To move or sync, go to
  **Backup → Download backup** on one device and **Import a backup** on the other.
- Clearing your browser's site data deletes the library. Download a backup now and then.

## Structure

```
├── index.html     # page shell
├── app.js         # the app: database, pages, prices, reviews, backup
├── style.css      # styling (dark/light follows your device)
├── db/schema.sql  # the database structure (tables and fields)
└── .nojekyll      # tells GitHub Pages to serve files as-is
```

## Publish on GitHub Pages

Repo **Settings → Pages → Build and deployment**: Source **Deploy from a branch**,
branch **main**, folder **/ (root)**, then **Save**. The site appears at
`https://<username>.github.io/<repo>/` after a minute or two.

## Run it on your computer

Open a terminal in this folder and run:

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

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

The browser database has the same tables and fields as `db/schema.sql`
(the backup file is these tables as JSON):

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
