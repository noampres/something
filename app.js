/* Game Library: runs entirely in the browser (GitHub Pages friendly).
 *
 * The database mirrors db/schema.sql: same tables, same columns. It is kept in
 * this browser's IndexedDB and can be exported/imported as a JSON backup file.
 */
'use strict';

// ------------------------------------------------------------------ constants

const STATUSES = [
  ['not_started', 'Not started'], ['playing', 'Playing'], ['paused', 'Paused'],
  ['completed', 'Completed'], ['mastered', 'Mastered'], ['abandoned', 'Abandoned'],
];
const STATUS_LABELS = Object.fromEntries(STATUSES);
const OWNERSHIP = [['physical', 'Physical'], ['digital', 'Digital'], ['subscription', 'Subscription']];
const LISTS = [['collection', 'Collection'], ['wishlist', 'Wishlist']];
const SOURCES = [['dekudeals', 'DekuDeals'], ['backloggd', 'Backloggd'],
                 ['metacritic', 'Metacritic'], ['howlongtobeat', 'HowLongToBeat']];
const TABLES = ['games', 'platforms', 'game_platforms', 'genres', 'game_genres', 'library_entries',
                'source_links', 'prices', 'metacritic_scores', 'backloggd_stats', 'hltb_times', 'reviews'];
const FORMAT = 'game-library';

// ------------------------------------------------------------------- helpers

const esc = v => v == null ? '' : String(v).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => v == null || v === '' ? '' : typeof v === 'number' ? String(+v.toFixed(2)) : String(v);
const safeUrl = u => typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '';
const nowStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const today = () => new Date().toLocaleDateString('en-CA');
const slugify = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'game';
const byNewest = (a, b) => (b.fetched_at || '').localeCompare(a.fetched_at || '') || b.id - a.id;

function money(v, currency) {
  if (v == null) return '—';
  const symbol = { USD: '$', EUR: '€', GBP: '£', ILS: '₪', JPY: '¥' }[currency || 'USD'];
  const n = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return symbol ? symbol + n : `${n} ${currency}`;
}

function stars(r) {
  if (!r) return '';
  return '★'.repeat(Math.floor(r / 2)) + (r % 2 ? '½' : '');
}

class FormError extends Error {}

// ------------------------------------------------------------------- storage

function emptyDb() {
  const db = { format: FORMAT, version: 1, seq: {}, last_backup_at: null };
  for (const t of TABLES) db[t] = [];
  return db;
}

function normalizeDb(obj) {
  if (!obj || obj.format !== FORMAT || typeof obj !== 'object') return null;
  const db = { ...emptyDb(), ...obj };
  for (const t of TABLES) if (!Array.isArray(db[t])) return null;
  db.seq = db.seq && typeof db.seq === 'object' ? db.seq : {};
  for (const t of TABLES) {
    const maxId = db[t].reduce((m, r) => Math.max(m, r.id || 0), 0);
    db.seq[t] = Math.max(db.seq[t] || 0, maxId);
  }
  return db;
}

const storage = {
  mode: 'memory',
  idb: null,
  async init() {
    try {
      this.idb = await new Promise((resolve, reject) => {
        const req = indexedDB.open('game-library', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      this.mode = 'indexeddb';
    } catch {
      try { localStorage.setItem('gl-test', '1'); localStorage.removeItem('gl-test'); this.mode = 'local'; }
      catch { this.mode = 'memory'; }
    }
  },
  load() {
    if (this.mode === 'indexeddb') {
      return new Promise((resolve, reject) => {
        const req = this.idb.transaction('kv').objectStore('kv').get('data');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    }
    if (this.mode === 'local') {
      const s = localStorage.getItem('game-library');
      return Promise.resolve(s ? JSON.parse(s) : null);
    }
    return Promise.resolve(null);
  },
  save(data) {
    if (this.mode === 'indexeddb') {
      return new Promise((resolve, reject) => {
        const tx = this.idb.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(data, 'data');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    if (this.mode === 'local') localStorage.setItem('game-library', JSON.stringify(data));
    return Promise.resolve();
  },
};

let D = emptyDb();
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('game-library') : null;

async function persist() {
  try {
    await storage.save(D);
    channel?.postMessage('saved');
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  } catch (err) {
    flash(`Couldn't save to this browser: ${err.message}. Export a backup to keep your changes.`, 'error');
  }
}

/** Run a change on a copy of the database; only keep it if nothing throws. */
async function mutate(fn) {
  const draft = structuredClone(D);
  const result = fn(draft);
  D = draft;
  await persist();
  return result;
}

// ---------------------------------------------------------------- form specs

const field = (form, opts = {}) => ({
  form, col: opts.col || form, kind: opts.kind || 'text', lo: opts.lo ?? null, hi: opts.hi ?? null,
  label: opts.label || form[0].toUpperCase() + form.slice(1).replace(/_/g, ' '), choices: opts.choices || null,
});

const GAME_FIELDS = [
  field('title', { label: 'Title' }), field('developer'), field('publisher'),
  field('release_date', { kind: 'date', label: 'Release date' }),
  field('cover_image_url', { kind: 'url', label: 'Cover image URL' }), field('description'),
];
const ENTRY_FIELDS = [
  field('list_type', { kind: 'choice', choices: LISTS.map(x => x[0]), label: 'List' }),
  field('ownership_format', { kind: 'choice', choices: OWNERSHIP.map(x => x[0]), label: 'Format' }),
  field('play_status', { kind: 'choice', choices: STATUSES.map(x => x[0]), label: 'Status' }),
  field('completion_percentage', { kind: 'float', lo: 0, hi: 100, label: 'Completion %' }),
  field('hours_played', { kind: 'float', lo: 0, label: 'Hours played' }),
  field('personal_rating', { kind: 'int', lo: 1, hi: 10, label: 'Your rating' }),
  field('personal_review', { label: 'Your review' }),
  field('purchase_price', { kind: 'float', lo: 0, label: 'Price paid' }),
  field('purchase_currency', { label: 'Currency' }),
  field('purchase_date', { kind: 'date', label: 'Purchase date' }),
  field('target_price', { kind: 'float', lo: 0, label: "I'd buy at" }),
  field('priority', { kind: 'int', lo: 1, hi: 5, label: 'Priority' }),
  field('started_at', { kind: 'date', label: 'Started' }),
  field('completed_at', { kind: 'date', label: 'Completed' }),
  field('notes'),
];
const MC_FIELDS = [
  field('metascore', { kind: 'int', lo: 0, hi: 100, label: 'Metascore' }),
  field('critic_review_count', { kind: 'int', lo: 0, label: 'Critic reviews' }),
  field('critic_positive', { kind: 'int', lo: 0, label: 'Positive' }),
  field('critic_mixed', { kind: 'int', lo: 0, label: 'Mixed' }),
  field('critic_negative', { kind: 'int', lo: 0, label: 'Negative' }),
  field('mc_user_score', { col: 'user_score', kind: 'float', lo: 0, hi: 10, label: 'User score' }),
  field('mc_user_review_count', { col: 'user_review_count', kind: 'int', lo: 0, label: 'User reviews' }),
  field('must_play', { kind: 'bool', label: 'Must-Play' }),
];
const BL_FIELDS = [
  field('bl_average_rating', { col: 'average_rating', kind: 'float', lo: 0, hi: 5, label: 'Average rating' }),
  field('bl_rating_count', { col: 'rating_count', kind: 'int', lo: 0, label: 'Ratings' }),
  field('bl_review_count', { col: 'review_count', kind: 'int', lo: 0, label: 'Reviews' }),
  field('bl_plays_count', { col: 'plays_count', kind: 'int', lo: 0, label: 'Played' }),
  field('bl_playing_count', { col: 'playing_count', kind: 'int', lo: 0, label: 'Playing' }),
  field('bl_backlog_count', { col: 'backlog_count', kind: 'int', lo: 0, label: 'Backlogged' }),
  field('bl_wishlist_count', { col: 'wishlist_count', kind: 'int', lo: 0, label: 'Wishlisted' }),
];
const HLTB_FIELDS = [
  field('main_story_hours', { kind: 'float', lo: 0, label: 'Main story' }),
  field('main_extras_hours', { kind: 'float', lo: 0, label: 'Main + extras' }),
  field('completionist_hours', { kind: 'float', lo: 0, label: 'Completionist' }),
  field('all_styles_hours', { kind: 'float', lo: 0, label: 'All styles' }),
  field('hltb_submissions_count', { col: 'submissions_count', kind: 'int', lo: 0, label: 'Submissions' }),
];
const PRICE_FIELDS = [
  field('price_store', { col: 'store', label: 'Store' }),
  field('price_format', { col: 'format', kind: 'choice', choices: ['physical', 'digital'], label: 'Format' }),
  field('price_currency', { col: 'currency', label: 'Currency' }),
  field('regular_price', { kind: 'float', lo: 0, label: 'Regular price' }),
  field('current_price', { kind: 'float', lo: 0, label: 'Current price' }),
  field('sale_ends_at', { kind: 'date', label: 'Sale ends' }),
  field('price_url', { col: 'url', kind: 'url', label: 'Store link' }),
];
const REVIEW_FIELDS = [
  field('source', { kind: 'choice', choices: ['metacritic', 'backloggd'], label: 'Source' }),
  field('reviewer_type', { kind: 'choice', choices: ['critic', 'user'], label: 'Type' }),
  field('reviewer_name', { label: 'Reviewer' }), field('publication'),
  field('score', { kind: 'float', lo: 0, label: 'Score' }),
  field('score_scale', { kind: 'float', lo: 0, label: 'Out of' }),
  field('summary'), field('url', { kind: 'url', label: 'Link' }),
  field('published_at', { kind: 'date', label: 'Published' }),
];
const SOURCE_URL_FIELDS = SOURCES.map(([key, label]) => field(`url_${key}`, { kind: 'url', label: `${label} link` }));

function parse(fields, fd) {
  const out = {};
  for (const f of fields) {
    const raw = String(fd.get(f.form) ?? '').trim();
    if (f.kind === 'bool') { out[f.col] = raw ? 1 : 0; continue; }
    if (!raw) { out[f.col] = null; continue; }
    let value = raw;
    if (f.kind === 'int' || f.kind === 'float') {
      value = Number(raw);
      if (!Number.isFinite(value) || (f.kind === 'int' && !Number.isInteger(value))) {
        throw new FormError(`${f.label}: “${raw}” is not a ${f.kind === 'int' ? 'whole number' : 'number'}.`);
      }
      if ((f.lo != null && value < f.lo) || (f.hi != null && value > f.hi)) {
        throw new FormError(`${f.label} must be ${f.hi != null ? `${f.lo}–${f.hi}` : `at least ${f.lo}`}.`);
      }
    } else if (f.kind === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || isNaN(Date.parse(raw))) {
        throw new FormError(`${f.label}: use a date like 2026-10-15.`);
      }
    } else if (f.kind === 'choice') {
      if (!f.choices.includes(raw)) throw new FormError(`${f.label}: invalid choice.`);
    } else if (f.kind === 'url') {
      if (!safeUrl(raw)) throw new FormError(`${f.label} must start with http:// or https://`);
    }
    out[f.col] = value;
  }
  return out;
}

// ------------------------------------------------------------ data operations

function insertRow(db, table, row) {
  db.seq[table] = (db.seq[table] || 0) + 1;
  const r = { id: db.seq[table], ...row };
  db[table].push(r);
  return r;
}

const findGame = (db, id) => db.games.find(g => g.id === id);
const platformName = (db, id) => db.platforms.find(p => p.id === id)?.name ?? null;

function platformIdFor(db, name) {
  name = String(name ?? '').trim();
  if (!name) return null;
  const hit = db.platforms.find(p => p.name.toLowerCase() === name.toLowerCase());
  return hit ? hit.id : insertRow(db, 'platforms', { name }).id;
}

function linkPlatform(db, gameId, platformId) {
  if (platformId && !db.game_platforms.some(r => r.game_id === gameId && r.platform_id === platformId)) {
    db.game_platforms.push({ game_id: gameId, platform_id: platformId });
  }
}

function genresOf(db, gameId) {
  return db.game_genres.filter(r => r.game_id === gameId)
    .map(r => db.genres.find(g => g.id === r.genre_id)?.name).filter(Boolean).sort();
}

function setGenres(db, gameId, text) {
  db.game_genres = db.game_genres.filter(r => r.game_id !== gameId);
  const names = [...new Set(String(text ?? '').split(',').map(s => s.trim()).filter(Boolean))];
  for (const name of names) {
    let genre = db.genres.find(g => g.name.toLowerCase() === name.toLowerCase());
    if (!genre) genre = insertRow(db, 'genres', { name });
    db.game_genres.push({ game_id: gameId, genre_id: genre.id });
  }
}

function metacriticFor(db, gameId, platformId) {
  const rows = db.metacritic_scores.filter(r => r.game_id === gameId);
  return rows.find(r => r.platform_id === platformId) || rows[0] || null;
}

function entryValues(fd, existing) {
  const v = parse(ENTRY_FIELDS, fd);
  v.play_status = v.play_status || 'not_started';
  v.list_type = v.list_type || existing?.list_type || 'collection';
  v.completion_percentage = v.completion_percentage ?? 0;
  v.purchase_currency = v.purchase_currency || 'USD';
  return v;
}

function assertUniqueEntry(db, gameId, platformId, listType, exceptId) {
  if (db.library_entries.some(e => e.id !== exceptId && e.game_id === gameId &&
      e.platform_id === platformId && e.list_type === listType)) {
    throw new FormError(`This game is already on your ${listType}${platformId ? ' for ' + platformName(db, platformId) : ''}.`);
  }
}

function saveSources(db, gameId, platformId, fd) {
  const mc = parse(MC_FIELDS, fd), bl = parse(BL_FIELDS, fd), hl = parse(HLTB_FIELDS, fd);
  const urlValues = parse(SOURCE_URL_FIELDS, fd);
  const urls = Object.fromEntries(SOURCES.map(([k]) => [k, urlValues[`url_${k}`]]));
  const stamp = nowStamp();

  db.source_links = db.source_links.filter(r => r.game_id !== gameId);
  for (const [key, url] of Object.entries(urls)) {
    if (url) db.source_links.push({ game_id: gameId, source: key, external_id: null, url, last_synced: stamp });
  }

  db.metacritic_scores = db.metacritic_scores.filter(r => !(r.game_id === gameId && r.platform_id === platformId));
  const mcHasData = Object.entries(mc).some(([k, v]) => k !== 'must_play' && v != null) || mc.must_play || urls.metacritic;
  if (mcHasData) db.metacritic_scores.push({ game_id: gameId, platform_id: platformId, ...mc, url: urls.metacritic, fetched_at: stamp });

  for (const [table, data, url] of [['backloggd_stats', bl, urls.backloggd], ['hltb_times', hl, urls.howlongtobeat]]) {
    db[table] = db[table].filter(r => r.game_id !== gameId);
    if (Object.values(data).some(v => v != null) || url) db[table].push({ game_id: gameId, ...data, url, fetched_at: stamp });
  }
}

/** Add a price row for a store when it changed. Returns true if a row was added. */
function recordPrice(db, gameId, platformId, data) {
  if (data.current_price == null && data.regular_price == null) return false;
  if (!data.store) throw new FormError('Store is required when entering a price.');
  const last = db.prices.filter(p => p.game_id === gameId && p.store === data.store).sort(byNewest)[0];
  if (last && ['current_price', 'regular_price', 'sale_ends_at', 'format'].every(k => (last[k] ?? null) === data[k])) {
    return false;
  }
  const current = data.current_price, regular = data.regular_price;
  // A single price says nothing about the all-time low, so only track it once there's history.
  let low = last?.historical_low ?? null, lowDate = last?.historical_low_date ?? null;
  if (last) {
    const seen = [low, last.current_price].filter(v => v != null);
    if (seen.length && (low == null || Math.min(...seen) < low)) {
      low = Math.min(...seen);
      lowDate = low === last.current_price ? (last.fetched_at || '').slice(0, 10) : lowDate;
    }
    if (current != null && (low == null || current < low)) { low = current; lowDate = today(); }
  }
  const discount = current != null && regular && current < regular ? Math.round((1 - current / regular) * 1000) / 10 : 0;
  insertRow(db, 'prices', {
    game_id: gameId, platform_id: platformId, store: data.store, format: data.format, region: 'US',
    currency: data.currency || 'USD', regular_price: regular, current_price: current, discount_percent: discount,
    sale_ends_at: data.sale_ends_at, historical_low: low, historical_low_date: lowDate,
    is_on_sale: discount > 0 ? 1 : 0, url: data.url, fetched_at: nowStamp(),
  });
  return true;
}

function readGameForm(fd) {
  const game = parse(GAME_FIELDS, fd);
  if (!game.title) throw new FormError('Title is required.');
  return game;
}

function addGame(db, fd) {
  const game = readGameForm(fd);
  const values = entryValues(fd, null);
  const price = parse(PRICE_FIELDS, fd);
  const slug = slugify(game.title);
  const stamp = nowStamp();
  let g = db.games.find(x => x.slug === slug);
  if (g) {
    for (const [k, v] of Object.entries(game)) if (v != null) g[k] = v;
    g.updated_at = stamp;
  } else {
    g = insertRow(db, 'games', { ...game, slug, created_at: stamp, updated_at: stamp });
  }
  const pid = platformIdFor(db, fd.get('platform'));
  assertUniqueEntry(db, g.id, pid, values.list_type, null);
  linkPlatform(db, g.id, pid);
  if (String(fd.get('genres') ?? '').trim()) setGenres(db, g.id, fd.get('genres'));
  const entry = insertRow(db, 'library_entries', { game_id: g.id, platform_id: pid, ...values, created_at: stamp, updated_at: stamp });
  saveSources(db, g.id, pid, fd);
  recordPrice(db, g.id, pid, price);
  return entry.id;
}

function updateEntry(db, entryId, fd) {
  const entry = db.library_entries.find(e => e.id === entryId);
  if (!entry) throw new FormError('This game no longer exists.');
  const game = readGameForm(fd);
  const values = entryValues(fd, entry);
  const g = findGame(db, entry.game_id);
  const slug = slugify(game.title);
  if (db.games.some(x => x.id !== g.id && x.slug === slug)) {
    throw new FormError(`Another game is already called “${game.title}”.`);
  }
  const pid = platformIdFor(db, fd.get('platform'));
  assertUniqueEntry(db, g.id, pid, values.list_type, entry.id);
  const stamp = nowStamp();
  Object.assign(g, game, { slug, updated_at: stamp });
  linkPlatform(db, g.id, pid);
  setGenres(db, g.id, fd.get('genres'));
  if (pid !== entry.platform_id) {
    for (const r of db.metacritic_scores) if (r.game_id === g.id && r.platform_id === entry.platform_id) r.platform_id = pid;
  }
  Object.assign(entry, values, { platform_id: pid, updated_at: stamp });
  saveSources(db, g.id, pid, fd);
}

function deleteEntry(db, entryId) {
  const entry = db.library_entries.find(e => e.id === entryId);
  if (!entry) return null;
  db.library_entries = db.library_entries.filter(e => e.id !== entryId);
  if (!db.library_entries.some(e => e.game_id === entry.game_id)) {
    for (const t of TABLES) {
      if (t === 'games') db.games = db.games.filter(g => g.id !== entry.game_id);
      else if (db[t].length && 'game_id' in db[t][0]) db[t] = db[t].filter(r => r.game_id !== entry.game_id);
    }
  }
  return entry.list_type;
}

// ------------------------------------------------------------------- queries

function priceSummary(db, gameId) {
  const all = db.prices.filter(p => p.game_id === gameId).sort(byNewest);
  const latest = [];
  const seen = new Set();
  for (const p of all) if (!seen.has(p.store)) { seen.add(p.store); latest.push(p); }
  const currents = latest.map(p => p.current_price).filter(v => v != null);
  const lows = all.map(p => p.historical_low).filter(v => v != null);
  const discounts = latest.map(p => p.discount_percent).filter(v => v != null);
  return {
    all, latest,
    best: currents.length ? Math.min(...currents) : null,
    low: lows.length ? Math.min(...lows) : null,
    discount: discounts.length ? Math.max(...discounts) : null,
    currency: latest[0]?.currency || 'USD',
  };
}

function listItems(db, listType, params) {
  const q = (params.get('q') || '').toLowerCase();
  const status = params.get('status');
  const platform = params.get('platform');
  let items = db.library_entries.filter(e => e.list_type === listType).map(e => {
    const g = findGame(db, e.game_id) || {};
    const prices = priceSummary(db, e.game_id);
    const mc = metacriticFor(db, e.game_id, e.platform_id);
    const bl = db.backloggd_stats.find(r => r.game_id === e.game_id);
    const h = db.hltb_times.find(r => r.game_id === e.game_id);
    return {
      ...e, title: g.title || '?', cover_image_url: g.cover_image_url, platform: platformName(db, e.platform_id),
      best_price: prices.best, low_price: prices.low, discount: prices.discount, currency: prices.currency,
      metascore: mc?.metascore ?? null, mc_user_score: mc?.user_score ?? null, must_play: mc?.must_play,
      bl_rating: bl?.average_rating ?? null, main_story_hours: h?.main_story_hours ?? null,
      at_low: prices.best != null && prices.low != null && prices.best <= prices.low,
      target_hit: prices.best != null && e.target_price != null && prices.best <= e.target_price,
    };
  });
  if (q) items = items.filter(x => x.title.toLowerCase().includes(q));
  if (status in STATUS_LABELS) items = items.filter(x => x.play_status === status);
  if (platform) items = items.filter(x => x.platform === platform);
  if (params.get('deals') === '1') items = items.filter(x => x.at_low || x.target_hit || (x.discount || 0) > 0);

  const sort = SORTS[params.get('sort')] ? params.get('sort') : (listType === 'collection' ? 'title' : 'priority');
  const [, key, dir] = SORTS[sort];
  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  items.sort((a, b) => {
    if (key === 'title') return byTitle(a, b);
    const va = key === 'status' ? STATUSES.findIndex(s => s[0] === a.play_status) : a[key];
    const vb = key === 'status' ? STATUSES.findIndex(s => s[0] === b.play_status) : b[key];
    if (va == null && vb == null) return byTitle(a, b);
    if (va == null) return 1;
    if (vb == null) return -1;
    const c = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return (dir === 'desc' ? -c : c) || byTitle(a, b);
  });
  return { items, sort };
}

const SORTS = {
  title: ['Title', 'title', 'asc'],
  recent: ['Recently added', 'id', 'desc'],
  status: ['Status', 'status', 'asc'],
  completion: ['Completion', 'completion_percentage', 'desc'],
  rating: ['Your rating', 'personal_rating', 'desc'],
  metascore: ['Metascore', 'metascore', 'desc'],
  backloggd: ['Backloggd rating', 'bl_rating', 'desc'],
  length: ['Length (main story)', 'main_story_hours', 'asc'],
  price: ['Price', 'best_price', 'asc'],
  discount: ['Biggest discount', 'discount', 'desc'],
  priority: ['Priority', 'priority', 'desc'],
};

function formFromDb(db, entry) {
  const g = findGame(db, entry.game_id);
  const f = {};
  for (const x of GAME_FIELDS) f[x.form] = g[x.col];
  for (const x of ENTRY_FIELDS) f[x.form] = entry[x.col];
  f.platform = platformName(db, entry.platform_id);
  f.genres = genresOf(db, g.id).join(', ');
  const rows = [[MC_FIELDS, metacriticFor(db, g.id, entry.platform_id)],
                [BL_FIELDS, db.backloggd_stats.find(r => r.game_id === g.id)],
                [HLTB_FIELDS, db.hltb_times.find(r => r.game_id === g.id)]];
  for (const [fields, row] of rows) if (row) for (const x of fields) f[x.form] = row[x.col];
  for (const r of db.source_links.filter(r => r.game_id === g.id)) f[`url_${r.source}`] = r.url;
  return f;
}

// --------------------------------------------------------------------- views

let flashMsg = null;
let scrollTarget = null;
function flash(msg, kind = 'ok') { flashMsg = { msg, kind }; }

function viewList(listType, params) {
  const { items, sort } = listItems(D, listType, params);
  const count = items.length;
  let stats;
  if (listType === 'collection') {
    const finished = items.filter(x => ['completed', 'mastered'].includes(x.play_status)).length;
    const playing = items.filter(x => x.play_status === 'playing').length;
    const avg = count ? Math.round(items.reduce((s, x) => s + (x.completion_percentage || 0), 0) / count) : 0;
    const hours = Math.round(items.reduce((s, x) => s + (x.hours_played || 0), 0));
    stats = `<span><b>${count}</b> games</span><span><b>${playing}</b> playing</span>
      <span><b>${finished}</b> finished</span><span><b>${avg}%</b> avg. completion</span>
      <span><b>${hours}</b> hours played</span>`;
  } else {
    const onSale = items.filter(x => (x.discount || 0) > 0).length;
    const hits = items.filter(x => x.target_hit).length;
    const total = items.reduce((s, x) => s + (x.best_price || 0), 0);
    stats = `<span><b>${count}</b> games</span><span><b>${onSale}</b> on sale</span>
      <span><b>${hits}</b> at your price</span><span><b>${esc(money(total))}</b> to buy everything</span>`;
  }
  const platforms = [...new Set(D.library_entries.filter(e => e.list_type === listType)
    .map(e => platformName(D, e.platform_id)).filter(Boolean))].sort();
  const hasFilters = [...params.keys()].length > 0;

  const cards = items.map(x => {
    const cover = safeUrl(x.cover_image_url)
      ? `<img src="${esc(x.cover_image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<span>${esc(x.title.slice(0, 1))}</span>`;
    const middle = listType === 'collection'
      ? `<div class="progress" title="${esc(num(x.completion_percentage))}% complete"><div style="width:${Math.min(100, Math.max(0, x.completion_percentage || 0))}%"></div></div>
         <div class="meta small"><span>${esc(num(x.completion_percentage))}% complete</span>
         ${x.hours_played ? `<span>${esc(num(x.hours_played))} h played</span>` : ''}</div>`
      : `<div class="price-row"><span class="price">${esc(money(x.best_price, x.currency))}</span>
         ${x.discount ? `<span class="badge sale">−${Math.round(x.discount)}%</span>` : ''}
         ${x.at_low ? '<span class="badge low">Lowest price</span>' : ''}
         ${x.target_hit ? '<span class="badge target">Target hit</span>' : ''}</div>
         <div class="meta small">
         ${x.target_price != null ? `<span>I'd buy at ${esc(money(x.target_price, x.currency))}</span>` : ''}
         ${x.low_price != null && !x.at_low ? `<span>Low ${esc(money(x.low_price, x.currency))}</span>` : ''}</div>`;
    return `<a class="game card" href="#/entry/${x.id}">
      <div class="cover">${cover}</div>
      <div class="info">
        <div class="title-row"><h2>${esc(x.title)}</h2>
          ${x.personal_rating ? `<span class="stars" title="${x.personal_rating / 2} stars">${stars(x.personal_rating)}</span>` : ''}</div>
        <div class="meta">
          ${x.platform ? `<span>${esc(x.platform)}</span>` : ''}
          ${listType === 'collection' ? `<span class="pill s-${esc(x.play_status)}">${esc(STATUS_LABELS[x.play_status])}</span>` : ''}
          ${x.ownership_format ? `<span>${esc(x.ownership_format[0].toUpperCase() + x.ownership_format.slice(1))}</span>` : ''}
          ${listType === 'wishlist' && x.priority ? `<span>Priority ${x.priority}</span>` : ''}
        </div>
        ${middle}
        <div class="scores">
          ${x.metascore != null ? `<span title="Metascore"><i>MC</i> ${x.metascore}</span>` : ''}
          ${x.mc_user_score != null ? `<span title="Metacritic user score"><i>User</i> ${esc(num(x.mc_user_score))}</span>` : ''}
          ${x.bl_rating != null ? `<span title="Backloggd average"><i>BL</i> ${esc(num(x.bl_rating))}/5</span>` : ''}
          ${x.main_story_hours != null ? `<span title="HowLongToBeat main story"><i>HLTB</i> ${esc(num(x.main_story_hours))} h</span>` : ''}
          ${x.must_play ? '<span class="badge must">Must-Play</span>' : ''}
        </div>
      </div></a>`;
  }).join('');

  const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  const title = listType === 'collection' ? 'Collection' : 'Wishlist';
  return `
  <div class="page-head"><h1>${title}</h1><div class="stats">${stats}</div></div>
  <form class="filters" data-action="filter" data-list="${listType}">
    <input type="search" name="q" value="${esc(params.get('q') || '')}" placeholder="Search titles">
    <select name="status">${opt('', 'Any status')}${STATUSES.map(([k, l]) => opt(k, l, params.get('status') === k)).join('')}</select>
    <select name="platform">${opt('', 'Any platform')}${platforms.map(p => opt(p, p, params.get('platform') === p)).join('')}</select>
    <select name="sort">${Object.entries(SORTS).map(([k, v]) => opt(k, 'Sort: ' + v[0], sort === k)).join('')}</select>
    ${listType === 'wishlist' ? `<label class="check"><input type="checkbox" name="deals" value="1"${params.get('deals') === '1' ? ' checked' : ''}> Deals only</label>` : ''}
    <button class="btn">Apply</button>
    ${hasFilters ? `<a class="btn ghost" href="#/${listType}">Clear</a>` : ''}
  </form>
  ${count ? '' : `<div class="empty card">${hasFilters ? 'No games match these filters.'
    : `Nothing here yet. <a href="#/new?list=${listType}">Add your first game</a>.`}</div>`}
  <div class="grid">${cards}</div>`;
}

function formControls(f) {
  const val = n => f[n] == null ? '' : String(f[n]);
  const input = (n, label, { type = 'text', step, min, max, placeholder, wide, list } = {}) =>
    `<label${wide ? ' class="wide"' : ''}>${esc(label)}
      <input type="${type}" name="${n}" value="${esc(val(n))}"${step ? ` step="${step}"` : ''}${min != null ? ` min="${min}"` : ''}${max != null ? ` max="${max}"` : ''}${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}${list ? ` list="${list}"` : ''}></label>`;
  const select = (n, label, options, blank = '—') =>
    `<label>${esc(label)}<select name="${n}">${blank ? `<option value="">${esc(blank)}</option>` : ''}${options
      .map(([k, t]) => `<option value="${esc(k)}"${String(f[n] ?? '') === String(k) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  const textarea = (n, label, rows = 3) =>
    `<label class="wide">${esc(label)}<textarea name="${n}" rows="${rows}">${esc(val(n))}</textarea></label>`;
  return { val, input, select, textarea };
}

function viewForm(entryId, listType, values) {
  const isNew = entryId == null;
  let entry = null, f;
  if (!isNew) {
    entry = D.library_entries.find(e => e.id === entryId);
    if (!entry) return `<div class="empty card">That game isn't in your library. <a href="#/collection">Back to collection</a></div>`;
  }
  f = values || (isNew ? { list_type: listType, play_status: 'not_started', completion_percentage: 0 } : formFromDb(D, entry));
  const { val, input, select, textarea } = formControls(f);
  const ratingOptions = Array.from({ length: 10 }, (_, i) => [i + 1, `${stars(i + 1)}  (${(i + 1) / 2} stars)`]);
  const allPlatforms = D.platforms.map(p => p.name).sort();
  const completion = val('completion_percentage') || '0';
  const title = isNew ? 'Add a game' : (findGame(D, entry.game_id)?.title || '');

  const sourceLinks = SOURCES.map(([k, label]) => input(`url_${k}`, label, { type: 'url', wide: true }) +
    (safeUrl(f[`url_${k}`]) ? `<a class="small ext" href="${esc(f[`url_${k}`])}" target="_blank" rel="noopener noreferrer">Open ${label} ↗</a>` : '')).join('');

  const form = `
  <form class="card main-form" data-action="${isNew ? 'add-game' : 'save-game'}" ${isNew ? '' : `data-entry="${entry.id}"`} novalidate>
    <datalist id="platform-list">${allPlatforms.map(p => `<option value="${esc(p)}">`).join('')}</datalist>
    <fieldset><legend>Your library</legend><div class="fields">
      ${input('title', 'Title', { wide: true })}
      ${select('list_type', 'List', LISTS, null)}
      ${input('platform', 'Platform', { placeholder: 'e.g. Nintendo Switch', list: 'platform-list' })}
      ${select('ownership_format', 'Format', OWNERSHIP)}
      ${select('play_status', 'Status', STATUSES, null)}
      <label>Completion %<span class="range-row">
        <input type="range" min="0" max="100" step="1" value="${esc(completion)}" aria-label="Completion slider" data-sync="completion_percentage">
        <input type="number" name="completion_percentage" min="0" max="100" step="any" value="${esc(completion)}">
      </span></label>
      ${input('hours_played', 'Hours played', { type: 'number', step: 'any', min: 0 })}
      ${select('personal_rating', 'Your rating', ratingOptions, 'Not rated')}
      ${select('priority', 'Priority', [[1, '1 · low'], [2, '2'], [3, '3'], [4, '4'], [5, '5 · high']])}
      ${input('target_price', "I'd buy at", { type: 'number', step: '0.01', min: 0 })}
      ${input('purchase_price', 'Price paid', { type: 'number', step: '0.01', min: 0 })}
      ${input('purchase_currency', 'Currency', { placeholder: 'USD' })}
      ${input('purchase_date', 'Purchase date', { type: 'date' })}
      ${input('started_at', 'Started', { type: 'date' })}
      ${input('completed_at', 'Completed', { type: 'date' })}
      ${textarea('personal_review', 'Your review')}
      ${textarea('notes', 'Notes', 2)}
    </div></fieldset>
    <fieldset><legend>Game info</legend><div class="fields">
      ${input('developer', 'Developer')}${input('publisher', 'Publisher')}
      ${input('release_date', 'Release date', { type: 'date' })}
      ${input('genres', 'Genres', { placeholder: 'Comma separated' })}
      ${input('cover_image_url', 'Cover image URL', { type: 'url', wide: true })}
      ${textarea('description', 'Description')}
    </div></fieldset>
    ${isNew ? `<fieldset><legend>Price · DekuDeals</legend><div class="fields">
      ${input('price_store', 'Store', { placeholder: 'e.g. eShop' })}
      ${select('price_format', 'Format', [['digital', 'Digital'], ['physical', 'Physical']])}
      ${input('regular_price', 'Regular price', { type: 'number', step: '0.01', min: 0 })}
      ${input('current_price', 'Current price', { type: 'number', step: '0.01', min: 0 })}
      ${input('price_currency', 'Currency', { placeholder: 'USD' })}
      ${input('sale_ends_at', 'Sale ends', { type: 'date' })}
      ${input('price_url', 'Store link', { type: 'url', wide: true })}
    </div></fieldset>` : ''}
    <fieldset><legend>Metacritic</legend><div class="fields">
      ${input('metascore', 'Metascore', { type: 'number', min: 0, max: 100 })}
      ${input('mc_user_score', 'User score (0–10)', { type: 'number', step: '0.1', min: 0, max: 10 })}
      ${input('critic_review_count', 'Critic reviews', { type: 'number', min: 0 })}
      ${input('mc_user_review_count', 'User reviews', { type: 'number', min: 0 })}
      ${input('critic_positive', 'Positive', { type: 'number', min: 0 })}
      ${input('critic_mixed', 'Mixed', { type: 'number', min: 0 })}
      ${input('critic_negative', 'Negative', { type: 'number', min: 0 })}
      <label class="check"><input type="checkbox" name="must_play" value="1"${f.must_play && f.must_play !== '0' ? ' checked' : ''}> Must-Play</label>
    </div></fieldset>
    <fieldset><legend>Backloggd</legend><div class="fields">
      ${input('bl_average_rating', 'Average rating (0–5)', { type: 'number', step: '0.01', min: 0, max: 5 })}
      ${input('bl_rating_count', 'Ratings', { type: 'number', min: 0 })}
      ${input('bl_review_count', 'Reviews', { type: 'number', min: 0 })}
      ${input('bl_plays_count', 'Played', { type: 'number', min: 0 })}
      ${input('bl_playing_count', 'Playing', { type: 'number', min: 0 })}
      ${input('bl_backlog_count', 'Backlogged', { type: 'number', min: 0 })}
      ${input('bl_wishlist_count', 'Wishlisted', { type: 'number', min: 0 })}
    </div></fieldset>
    <fieldset><legend>HowLongToBeat (hours)</legend><div class="fields">
      ${input('main_story_hours', 'Main story', { type: 'number', step: '0.5', min: 0 })}
      ${input('main_extras_hours', 'Main + extras', { type: 'number', step: '0.5', min: 0 })}
      ${input('completionist_hours', 'Completionist', { type: 'number', step: '0.5', min: 0 })}
      ${input('all_styles_hours', 'All styles', { type: 'number', step: '0.5', min: 0 })}
      ${input('hltb_submissions_count', 'Submissions', { type: 'number', min: 0 })}
    </div></fieldset>
    <fieldset><legend>Pages on each site</legend><div class="fields">${sourceLinks}</div></fieldset>
    <div class="actions"><button class="btn primary">${isNew ? 'Add game' : 'Save changes'}</button></div>
  </form>`;

  const head = `<div class="page-head"><h1>${esc(title)}</h1>
    ${isNew ? '' : `<a class="btn ghost" href="#/${entry.list_type}">← Back to ${entry.list_type}</a>`}</div>`;
  if (isNew) return `${head}<div class="detail new">${form}</div>`;
  return `${head}<div class="detail">${form}${sidePanel(entry)}</div>`;
}

function sidePanel(entry) {
  const gid = entry.game_id;
  const p = priceSummary(D, gid);
  const first = p.latest[0];
  const reviews = D.reviews.filter(r => r.game_id === gid)
    .sort((a, b) => (b.published_at || '').localeCompare(a.published_at || '') || b.id - a.id);
  const others = D.library_entries.filter(e => e.game_id === gid && e.id !== entry.id);

  const latestRows = p.latest.map(x => `<tr>
    <td>${safeUrl(x.url) ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.store)}</a>` : esc(x.store)}
      ${x.format ? `<span class="muted">· ${esc(x.format)}</span>` : ''}</td>
    <td><b>${esc(money(x.current_price, x.currency))}</b>
      ${x.discount_percent ? `<span class="badge sale">−${Math.round(x.discount_percent)}%</span>` : ''}
      ${x.sale_ends_at ? `<div class="muted small">until ${esc(x.sale_ends_at)}</div>` : ''}</td>
    <td>${esc(money(x.regular_price, x.currency))}</td>
    <td>${esc(money(x.historical_low, x.currency))}${x.historical_low_date ? `<div class="muted small">${esc(x.historical_low_date)}</div>` : ''}</td>
  </tr>`).join('');

  const history = p.all.length > p.latest.length ? `<details><summary>Price history (${p.all.length})</summary>
    <table class="tbl"><tr><th>Date</th><th>Store</th><th>Price</th><th></th></tr>
    ${p.all.map(x => `<tr><td>${esc((x.fetched_at || '').slice(0, 10))}</td><td>${esc(x.store)}</td>
      <td>${esc(money(x.current_price, x.currency))}</td>
      <td><form data-action="delete-price" data-entry="${entry.id}" data-id="${x.id}"><button class="link-btn" title="Delete this price">×</button></form></td></tr>`).join('')}
    </table></details>` : '';

  const reviewHtml = reviews.length ? reviews.map(r => `<div class="review">
      <div class="review-head"><b>${esc(r.publication || r.reviewer_name || (r.source === 'metacritic' ? 'Metacritic' : 'Backloggd'))}</b>
        ${r.score != null ? `<span class="score">${esc(num(r.score))}${r.score_scale ? '/' + esc(num(r.score_scale)) : ''}</span>` : ''}
        <form data-action="delete-review" data-entry="${entry.id}" data-id="${r.id}" data-confirm="Delete this review?"><button class="link-btn" title="Delete review">×</button></form></div>
      <div class="muted small">${esc(r.source[0].toUpperCase() + r.source.slice(1))}${r.reviewer_type ? ' · ' + esc(r.reviewer_type) : ''}
        ${r.reviewer_name && r.publication ? ' · ' + esc(r.reviewer_name) : ''}${r.published_at ? ' · ' + esc(r.published_at) : ''}
        ${safeUrl(r.url) ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">read</a>` : ''}</div>
      ${r.summary ? `<p>${esc(r.summary)}</p>` : ''}</div>`).join('')
    : '<p class="muted">No reviews saved.</p>';

  return `<aside class="side">
    <section class="card" id="prices"><h2>Prices</h2>
      ${p.latest.length ? `<table class="tbl"><tr><th>Store</th><th>Now</th><th>Regular</th><th>Low</th></tr>${latestRows}</table>` : '<p class="muted">No prices yet.</p>'}
      <details${p.latest.length ? '' : ' open'}><summary>Record a price</summary>
        <form data-action="add-price" data-entry="${entry.id}" class="fields compact" novalidate>
          <label>Store <input name="price_store" placeholder="e.g. eShop" value="${esc(first?.store || '')}"></label>
          <label>Format <select name="price_format"><option value="">—</option>
            <option value="digital"${first?.format === 'digital' ? ' selected' : ''}>Digital</option>
            <option value="physical"${first?.format === 'physical' ? ' selected' : ''}>Physical</option></select></label>
          <label>Current price <input type="number" step="0.01" min="0" name="current_price"></label>
          <label>Regular price <input type="number" step="0.01" min="0" name="regular_price" value="${esc(num(first?.regular_price))}"></label>
          <label>Currency <input name="price_currency" placeholder="USD" value="${esc(first?.currency || '')}"></label>
          <label>Sale ends <input type="date" name="sale_ends_at"></label>
          <label class="wide">Store link <input type="url" name="price_url" value="${esc(first?.url || '')}"></label>
          <button class="btn">Add price</button>
        </form></details>
      ${history}
    </section>
    <section class="card" id="reviews"><h2>Reviews</h2>${reviewHtml}
      <details><summary>Add a review</summary>
        <form data-action="add-review" data-entry="${entry.id}" class="fields compact" novalidate>
          <label>Source <select name="source"><option value="metacritic">Metacritic</option><option value="backloggd">Backloggd</option></select></label>
          <label>Type <select name="reviewer_type"><option value="critic">Critic</option><option value="user">User</option></select></label>
          <label>Reviewer <input name="reviewer_name"></label>
          <label>Publication <input name="publication"></label>
          <label>Score <input type="number" step="any" min="0" name="score"></label>
          <label>Out of <input type="number" step="any" min="0" name="score_scale" placeholder="100"></label>
          <label>Published <input type="date" name="published_at"></label>
          <label class="wide">Link <input type="url" name="url"></label>
          <label class="wide">Summary <textarea name="summary" rows="3"></textarea></label>
          <button class="btn">Add review</button>
        </form></details>
    </section>
    ${others.length ? `<section class="card"><h2>Also in your library</h2>${others.map(o =>
      `<a href="#/entry/${o.id}">${o.list_type === 'collection' ? 'Collection' : 'Wishlist'}${o.platform_id ? ' · ' + esc(platformName(D, o.platform_id)) : ''}</a><br>`).join('')}</section>` : ''}
    <form data-action="delete-entry" data-entry="${entry.id}" data-confirm="Remove this game from your ${entry.list_type}?">
      <button class="btn danger">Remove from ${entry.list_type}</button></form>
  </aside>`;
}

function viewData() {
  const games = D.games.length, entries = D.library_entries.length, prices = D.prices.length;
  const where = { indexeddb: 'this browser (IndexedDB)', local: 'this browser (localStorage)',
                  memory: 'memory only — changes are lost when you close the tab' }[storage.mode];
  return `<div class="page-head"><h1>Backup &amp; data</h1></div>
  <div class="data-grid">
    <section class="card pad"><h2>Where your data is</h2>
      <p>Your library is saved in <b>${where}</b>. It isn't uploaded anywhere, so other people who open
      this site see an empty library, and your other devices don't see these games until you import a backup there.</p>
      <p class="muted">${games} games · ${entries} library entries · ${prices} price records</p>
      <p class="muted">Last backup: ${D.last_backup_at ? esc(D.last_backup_at.slice(0, 10)) : 'never'}</p>
    </section>
    <section class="card pad"><h2>Export a backup</h2>
      <p>Downloads everything as one file. Do this now and then, and before clearing your browser data.</p>
      <button class="btn primary" data-click="export">Download backup</button>
    </section>
    <section class="card pad"><h2>Import a backup</h2>
      <p>Replaces the library in this browser with the one in the file. Use it to restore, or to move your library to another device.</p>
      <label class="btn">Choose backup file…<input type="file" accept=".json,application/json" data-change="import" hidden></label>
    </section>
    <section class="card pad"><h2>Start over</h2>
      <p>Deletes every game from this browser. Export a backup first if you might want it back.</p>
      <button class="btn danger" data-click="erase">Erase all data</button>
    </section>
  </div>`;
}

// -------------------------------------------------------------------- router

function currentRoute() {
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  return { parts: (path || '').split('/').filter(Boolean), params: new URLSearchParams(qs || '') };
}

function render(overrideHtml) {
  const { parts, params } = currentRoute();
  let html, active = null;
  try {
    if (overrideHtml != null) html = overrideHtml;
    else if (!parts.length || parts[0] === 'collection' || parts[0] === 'wishlist') {
      active = parts[0] || 'collection';
      html = viewList(active, params);
    } else if (parts[0] === 'new') {
      html = viewForm(null, params.get('list') === 'wishlist' ? 'wishlist' : 'collection');
    } else if (parts[0] === 'entry') {
      html = viewForm(Number(parts[1]));
    } else if (parts[0] === 'data') {
      html = viewData();
    } else {
      html = `<div class="empty card">Page not found. <a href="#/collection">Go to your collection</a></div>`;
    }
  } catch (err) {
    console.error(err);
    html = `<div class="empty card">Something went wrong showing this page: ${esc(err.message)}</div>`;
  }
  if (!active) {
    if (parts[0] === 'entry') active = D.library_entries.find(e => e.id === Number(parts[1]))?.list_type;
    else if (parts[0] === 'new') active = params.get('list') === 'wishlist' ? 'wishlist' : 'collection';
    else if (parts[0] === 'data') active = 'data';
  }
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === active);
  const addLink = document.getElementById('add-link');
  if (addLink) addLink.href = `#/new?list=${active === 'wishlist' ? 'wishlist' : 'collection'}`;

  const banner = storage.mode === 'memory'
    ? `<div class="flash error">This browser isn't letting the site save data (private mode?). Changes are lost when you close the tab.</div>` : '';
  const msg = flashMsg ? `<div class="flash ${flashMsg.kind}" role="status">${esc(flashMsg.msg)}</div>` : '';
  flashMsg = null;
  document.getElementById('app').innerHTML = banner + msg + html;
  if (scrollTarget) { document.getElementById(scrollTarget)?.scrollIntoView(); scrollTarget = null; }
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

// -------------------------------------------------------------------- events

const actions = {
  async filter(form, fd) {
    const qs = new URLSearchParams();
    for (const [k, v] of fd.entries()) if (String(v).trim()) qs.set(k, String(v).trim());
    const s = qs.toString();
    go(`#/${form.dataset.list}${s ? '?' + s : ''}`);
  },
  async 'add-game'(form, fd) {
    const id = await mutate(db => addGame(db, fd));
    flash(`Added ${String(fd.get('title')).trim()}.`);
    window.scrollTo(0, 0);
    go(`#/entry/${id}`);
  },
  async 'save-game'(form, fd) {
    await mutate(db => updateEntry(db, Number(form.dataset.entry), fd));
    flash('Saved.');
    window.scrollTo(0, 0);
    render();
  },
  async 'add-price'(form, fd) {
    const entry = D.library_entries.find(e => e.id === Number(form.dataset.entry));
    const data = parse(PRICE_FIELDS, fd);
    if (data.current_price == null) throw new FormError('Enter the current price.');
    const added = await mutate(db => recordPrice(db, entry.game_id, entry.platform_id, data));
    flash(added ? 'Price recorded.' : 'Price unchanged, nothing added.');
    scrollTarget = 'prices';
    render();
  },
  async 'delete-price'(form) {
    const entry = D.library_entries.find(e => e.id === Number(form.dataset.entry));
    await mutate(db => { db.prices = db.prices.filter(p => !(p.id === Number(form.dataset.id) && p.game_id === entry.game_id)); });
    scrollTarget = 'prices';
    render();
  },
  async 'add-review'(form, fd) {
    const entry = D.library_entries.find(e => e.id === Number(form.dataset.entry));
    const r = parse(REVIEW_FIELDS, fd);
    if (!r.source) throw new FormError('Pick a source for the review.');
    if (!r.summary && r.score == null) throw new FormError('Add a score or a summary.');
    await mutate(db => insertRow(db, 'reviews', { game_id: entry.game_id, ...r, fetched_at: nowStamp() }));
    flash('Review added.');
    scrollTarget = 'reviews';
    render();
  },
  async 'delete-review'(form) {
    await mutate(db => { db.reviews = db.reviews.filter(r => r.id !== Number(form.dataset.id)); });
    scrollTarget = 'reviews';
    render();
  },
  async 'delete-entry'(form) {
    const listType = await mutate(db => deleteEntry(db, Number(form.dataset.entry)));
    flash('Removed.');
    go(`#/${listType || 'collection'}`);
  },
};

document.addEventListener('submit', async e => {
  const form = e.target;
  const act = form.dataset.action;
  if (!actions[act]) return;
  e.preventDefault();
  if (form.dataset.confirm && !confirm(form.dataset.confirm)) return;
  const fd = new FormData(form);
  try {
    await actions[act](form, fd);
  } catch (err) {
    if (!(err instanceof FormError)) console.error(err);
    flash(err instanceof FormError ? err.message : `Something went wrong: ${err.message}`, 'error');
    if (act === 'add-game' || act === 'save-game') {
      // keep what was typed
      render(viewForm(act === 'add-game' ? null : Number(form.dataset.entry),
        String(fd.get('list_type') || 'collection'), Object.fromEntries(fd.entries())));
      window.scrollTo(0, 0);
    } else {
      render();
    }
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.sync) t.form.elements[t.dataset.sync].value = t.value;
  else if (t.name === 'completion_percentage' && t.previousElementSibling?.dataset.sync) t.previousElementSibling.value = t.value;
});

document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-click]');
  if (!btn) return;
  if (btn.dataset.click === 'export') {
    D.last_backup_at = nowStamp();
    await persist();
    const blob = new Blob([JSON.stringify(D, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `game-library-backup-${today()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    flash('Backup downloaded.');
    render();
  } else if (btn.dataset.click === 'erase') {
    if (!confirm('Delete every game in this browser? This cannot be undone.')) return;
    D = emptyDb();
    await persist();
    flash('All data erased.');
    render();
  }
});

document.addEventListener('change', async e => {
  const input = e.target;
  if (input.dataset.change !== 'import' || !input.files?.length) return;
  try {
    const parsed = normalizeDb(JSON.parse(await input.files[0].text()));
    if (!parsed) throw new FormError("That file isn't a Game Library backup.");
    const n = parsed.library_entries.length;
    if (!confirm(`Replace the library in this browser with the backup (${n} entries)?`)) return;
    D = parsed;
    await persist();
    flash(`Backup imported: ${n} entries.`);
  } catch (err) {
    flash(err instanceof FormError ? err.message : `Couldn't read that file: ${err.message}`, 'error');
  } finally {
    input.value = '';
  }
  render();
});

window.addEventListener('hashchange', () => render());

channel?.addEventListener('message', async () => {
  // Another tab saved: reload so this tab doesn't overwrite newer data.
  const fresh = normalizeDb(await storage.load());
  if (fresh) {
    D = fresh;
    const editing = document.activeElement?.closest('form.main-form');
    if (!editing) render();
  }
});

// ---------------------------------------------------------------------- start

(async function start() {
  await storage.init();
  try {
    D = normalizeDb(await storage.load()) || emptyDb();
  } catch (err) {
    flash(`Couldn't load saved data: ${err.message}`, 'error');
  }
  if (!location.hash) history.replaceState(null, '', '#/collection');
  render();
})();
