-- Game Library database schema (SQLite)
-- Sources: DekuDeals (prices), Backloggd (community ratings/status),
--          Metacritic (critic/user reviews), HowLongToBeat (play time)

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------
-- Core game record (one row per game, shared by all sources)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS games (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT    NOT NULL,
    slug            TEXT    UNIQUE,
    developer       TEXT,
    publisher       TEXT,
    release_date    TEXT,               -- ISO 8601 (YYYY-MM-DD)
    description     TEXT,
    cover_image_url TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platforms (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE          -- e.g. 'Nintendo Switch', 'PS5', 'PC'
);

CREATE TABLE IF NOT EXISTS game_platforms (
    game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    platform_id INTEGER NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
    PRIMARY KEY (game_id, platform_id)
);

CREATE TABLE IF NOT EXISTS genres (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS game_genres (
    game_id  INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (game_id, genre_id)
);

-- ---------------------------------------------------------------
-- Your library: collection + wishlist ("games to potentially buy")
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS library_entries (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id               INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    platform_id           INTEGER REFERENCES platforms(id),
    list_type             TEXT    NOT NULL DEFAULT 'collection'
                          CHECK (list_type IN ('collection', 'wishlist')),
    ownership_format      TEXT    CHECK (ownership_format IN ('physical', 'digital', 'subscription')),
    play_status           TEXT    NOT NULL DEFAULT 'not_started'
                          CHECK (play_status IN ('not_started', 'playing', 'paused',
                                                 'completed', 'mastered', 'abandoned')),
    completion_percentage REAL    NOT NULL DEFAULT 0
                          CHECK (completion_percentage BETWEEN 0 AND 100),
    hours_played          REAL    DEFAULT 0,
    -- Personal rating system: 0.5–5 stars in half steps (stored as 1–10)
    personal_rating       INTEGER CHECK (personal_rating BETWEEN 1 AND 10),
    personal_review       TEXT,
    purchase_price        REAL,
    purchase_currency     TEXT    DEFAULT 'USD',
    purchase_date         TEXT,
    target_price          REAL,       -- wishlist: alert when price <= this
    priority              INTEGER CHECK (priority BETWEEN 1 AND 5),
    started_at            TEXT,
    completed_at          TEXT,
    notes                 TEXT,
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (game_id, platform_id, list_type)
);

-- ---------------------------------------------------------------
-- Source links: external IDs/URLs per source, for re-syncing
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_links (
    game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    source       TEXT    NOT NULL
                 CHECK (source IN ('dekudeals', 'backloggd', 'metacritic', 'howlongtobeat')),
    external_id  TEXT,
    url          TEXT,
    last_synced  TEXT,
    PRIMARY KEY (game_id, source)
);

-- ---------------------------------------------------------------
-- DekuDeals: prices (current snapshot + history)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prices (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id          INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    platform_id      INTEGER REFERENCES platforms(id),
    store            TEXT    NOT NULL,   -- e.g. 'eShop', 'Amazon', 'PlayStation Store'
    format           TEXT    CHECK (format IN ('physical', 'digital')),
    region           TEXT    DEFAULT 'US',
    currency         TEXT    NOT NULL DEFAULT 'USD',
    regular_price    REAL,
    current_price    REAL,
    discount_percent REAL,
    sale_ends_at     TEXT,
    historical_low   REAL,
    historical_low_date TEXT,
    is_on_sale       INTEGER NOT NULL DEFAULT 0 CHECK (is_on_sale IN (0, 1)),
    url              TEXT,
    fetched_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prices_game ON prices(game_id, fetched_at);

-- ---------------------------------------------------------------
-- Metacritic: critic + user review scores
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metacritic_scores (
    game_id             INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    platform_id         INTEGER REFERENCES platforms(id),
    metascore           INTEGER CHECK (metascore BETWEEN 0 AND 100),
    critic_review_count INTEGER,
    critic_positive     INTEGER,
    critic_mixed        INTEGER,
    critic_negative     INTEGER,
    user_score          REAL    CHECK (user_score BETWEEN 0 AND 10),
    user_review_count   INTEGER,
    must_play           INTEGER DEFAULT 0 CHECK (must_play IN (0, 1)),
    url                 TEXT,
    fetched_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (game_id, platform_id)
);

-- ---------------------------------------------------------------
-- Backloggd: community rating + player status counts
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backloggd_stats (
    game_id         INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    average_rating  REAL CHECK (average_rating BETWEEN 0 AND 5),
    rating_count    INTEGER,
    review_count    INTEGER,
    plays_count     INTEGER,
    playing_count   INTEGER,
    backlog_count   INTEGER,
    wishlist_count  INTEGER,
    url             TEXT,
    fetched_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------
-- HowLongToBeat: completion times (hours)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hltb_times (
    game_id             INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    main_story_hours    REAL,
    main_extras_hours   REAL,
    completionist_hours REAL,
    all_styles_hours    REAL,
    submissions_count   INTEGER,
    url                 TEXT,
    fetched_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------
-- Individual reviews (critic or user) from any source
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    source        TEXT    NOT NULL CHECK (source IN ('metacritic', 'backloggd')),
    reviewer_type TEXT    CHECK (reviewer_type IN ('critic', 'user')),
    reviewer_name TEXT,
    publication   TEXT,
    score         REAL,
    score_scale   REAL,                 -- e.g. 100, 10, 5
    summary       TEXT,
    url           TEXT,
    published_at  TEXT,
    fetched_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_game ON reviews(game_id);

-- ---------------------------------------------------------------
-- Keep updated_at fresh
-- ---------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_games_updated AFTER UPDATE ON games
BEGIN UPDATE games SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS trg_library_updated AFTER UPDATE ON library_entries
BEGIN UPDATE library_entries SET updated_at = datetime('now') WHERE id = NEW.id; END;

-- ---------------------------------------------------------------
-- Convenience view: one row per library entry with all source data
-- ---------------------------------------------------------------
CREATE VIEW IF NOT EXISTS library_overview AS
SELECT
    le.id                    AS entry_id,
    g.title,
    p.name                   AS platform,
    le.list_type,
    le.play_status,
    le.completion_percentage,
    le.hours_played,
    le.personal_rating / 2.0 AS personal_stars,
    le.target_price,
    (SELECT MIN(pr.current_price) FROM prices pr
       WHERE pr.game_id = g.id
         AND pr.fetched_at = (SELECT MAX(fetched_at) FROM prices WHERE game_id = g.id)
    )                        AS best_current_price,
    (SELECT MIN(pr.historical_low) FROM prices pr WHERE pr.game_id = g.id) AS historical_low,
    mc.metascore,
    mc.user_score            AS metacritic_user_score,
    bl.average_rating        AS backloggd_rating,
    h.main_story_hours,
    h.main_extras_hours,
    h.completionist_hours
FROM library_entries le
JOIN games g              ON g.id = le.game_id
LEFT JOIN platforms p     ON p.id = le.platform_id
LEFT JOIN metacritic_scores mc ON mc.game_id = g.id
                              AND (mc.platform_id = le.platform_id OR mc.platform_id IS NULL)
LEFT JOIN backloggd_stats bl ON bl.game_id = g.id
LEFT JOIN hltb_times h       ON h.game_id = g.id;
