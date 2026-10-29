'use strict';
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+, nothing to compile
const { CATEGORIES, categoryOfTc } = require('./timecontrol');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'chess.db'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  username_lc TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 1200,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  white_name TEXT NOT NULL,
  black_name TEXT NOT NULL,
  white_id INTEGER,
  black_id INTEGER,
  result TEXT NOT NULL,
  reason TEXT NOT NULL,
  moves TEXT NOT NULL,
  tc TEXT NOT NULL,
  rated INTEGER NOT NULL,
  white_delta INTEGER,
  black_delta INTEGER,
  ended_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS games_white ON games(white_id);
CREATE INDEX IF NOT EXISTS games_black ON games(black_id);
`);

// Upgrade databases created before titles and bios existed.
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('title')) db.exec("ALTER TABLE users ADD COLUMN title TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('bio')) db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('ban_until')) db.exec('ALTER TABLE users ADD COLUMN ban_until INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('ban_reason')) db.exec("ALTER TABLE users ADD COLUMN ban_reason TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('banned_by')) db.exec("ALTER TABLE users ADD COLUMN banned_by TEXT NOT NULL DEFAULT ''");
}

// Each saved game also remembers both players' ratings from before it started (for the PGN).
{
  const gcols = db.prepare('PRAGMA table_info(games)').all().map((c) => c.name);
  if (!gcols.includes('white_elo')) db.exec('ALTER TABLE games ADD COLUMN white_elo INTEGER');
  if (!gcols.includes('black_elo')) db.exec('ALTER TABLE games ADD COLUMN black_elo INTEGER');
}

// One rating per player per category (bullet, blitz, rapid), each with its own win/loss/draw count.
db.exec(`
CREATE TABLE IF NOT EXISTS ratings (
  user_id INTEGER NOT NULL REFERENCES users(id),
  cat TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 1200,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, cat)
);
`);

// Sites that started with a single rating: split it by replaying every rated game in the history.
// A player's rating in a category becomes 1200 plus the points they won or lost in that category,
// so nobody's total changes and nobody is handed a rating they did not earn there. Runs once.
{
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 1) {
    const rated = db.prepare('SELECT white_id, black_id, result, tc, white_delta, black_delta FROM games WHERE rated = 1').all();
    const totals = new Map();
    const add = (userId, cat, delta, outcome) => {
      if (!userId) return;
      const key = userId + ':' + cat;
      const t = totals.get(key) || { userId, cat, rating: 1200, games: 0, wins: 0, losses: 0, draws: 0 };
      t.rating += delta || 0;
      t.games += 1;
      if (outcome === 'win') t.wins += 1; else if (outcome === 'loss') t.losses += 1; else t.draws += 1;
      totals.set(key, t);
    };
    for (const g of rated) {
      const cat = categoryOfTc(g.tc);
      const white = g.result === '1-0' ? 'win' : g.result === '0-1' ? 'loss' : 'draw';
      const black = white === 'win' ? 'loss' : white === 'loss' ? 'win' : 'draw';
      add(g.white_id, cat, g.white_delta, white);
      add(g.black_id, cat, g.black_delta, black);
    }
    const exists = db.prepare('SELECT 1 FROM users WHERE id = ?');
    const insert = db.prepare('INSERT OR REPLACE INTO ratings (user_id, cat, rating, games, wins, losses, draws) VALUES (?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const t of totals.values()) {
        if (exists.get(t.userId)) insert.run(t.userId, t.cat, t.rating, t.games, t.wins, t.losses, t.draws);
      }
      db.exec('PRAGMA user_version = 1');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS mod_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
`);

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const q = {
  insertUser: db.prepare('INSERT INTO users (username, username_lc, pass_hash, created_at) VALUES (?, ?, ?, ?)'),
  byName: db.prepare('SELECT * FROM users WHERE username_lc = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
  session: db.prepare('SELECT user_id, created_at FROM sessions WHERE token = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  ratingsFor: db.prepare('SELECT cat, rating, games, wins, losses, draws FROM ratings WHERE user_id = ?'),
  upsertResult: db.prepare(`INSERT INTO ratings (user_id, cat, rating, games, wins, losses, draws) VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(user_id, cat) DO UPDATE SET rating = excluded.rating, games = games + 1,
    wins = wins + excluded.wins, losses = losses + excluded.losses, draws = draws + excluded.draws`),
  insertGame: db.prepare(`INSERT OR REPLACE INTO games
    (id, white_name, black_name, white_id, black_id, result, reason, moves, tc, rated, white_delta, black_delta, ended_at, white_elo, black_elo)
    VALUES (@id, @white_name, @black_name, @white_id, @black_id, @result, @reason, @moves, @tc, @rated, @white_delta, @black_delta, @ended_at, @white_elo, @black_elo)`),
  setTitle: db.prepare('UPDATE users SET title = ? WHERE id = ?'),
  setBio: db.prepare('UPDATE users SET bio = ? WHERE id = ?'),
  setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  ban: db.prepare('UPDATE users SET ban_until = ?, ban_reason = ?, banned_by = ? WHERE id = ?'),
  unban: db.prepare("UPDATE users SET ban_until = 0, ban_reason = '', banned_by = '' WHERE id = ?"),
  delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  log: db.prepare('INSERT INTO mod_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)'),
  modLog: db.prepare('SELECT at, actor, action, target, detail FROM mod_log ORDER BY id DESC LIMIT ?'),
  bans: db.prepare('SELECT username, title, ban_until, ban_reason, banned_by FROM users WHERE ban_until > ? ORDER BY ban_until DESC'),
  staff: db.prepare("SELECT username, role FROM users WHERE role != '' ORDER BY role DESC, username"),
  leaderboard: db.prepare(`SELECT u.username, u.title, r.rating, r.games, r.wins, r.losses, r.draws
    FROM ratings r JOIN users u ON u.id = r.user_id
    WHERE r.cat = ? AND r.games > 0 AND u.ban_until <= ? ORDER BY r.rating DESC, r.games DESC LIMIT 20`),
  getGame: db.prepare('SELECT * FROM games WHERE id = ?'),
  searchUsers: db.prepare(`SELECT id, username, title FROM users WHERE username_lc LIKE ? ESCAPE '\\'
    ORDER BY (username_lc LIKE ? ESCAPE '\\') DESC, username_lc LIMIT 8`),
  userGames: db.prepare(`SELECT id, white_name, black_name, white_id, black_id, result, reason, tc, rated,
    white_delta, black_delta, ended_at FROM games WHERE white_id = ? OR black_id = ? ORDER BY ended_at DESC LIMIT 20`),
};

function getUserByName(name) { return q.byName.get(String(name).toLowerCase()) || null; }
function getUserById(id) { return q.byId.get(id) || null; }

function createUser(username, passHash) {
  const info = q.insertUser.run(username, username.toLowerCase(), passHash, Date.now());
  return getUserById(Number(info.lastInsertRowid));
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q.insertSession.run(token, userId, Date.now());
  return token;
}

function userForToken(token) {
  if (typeof token !== 'string' || token.length !== 64) return null;
  const s = q.session.get(token);
  if (!s) return null;
  if (Date.now() - s.created_at > SESSION_TTL_MS) { q.delSession.run(token); return null; }
  return getUserById(s.user_id);
}

function deleteSession(token) { q.delSession.run(token); }

// All three categories for a player, 1200 and no games where they have not played yet.
function getRatings(userId) {
  const out = {};
  for (const c of CATEGORIES) out[c] = { rating: 1200, games: 0, wins: 0, losses: 0, draws: 0 };
  for (const r of q.ratingsFor.all(userId)) {
    if (out[r.cat]) out[r.cat] = { rating: r.rating, games: r.games, wins: r.wins, losses: r.losses, draws: r.draws };
  }
  return out;
}
function getRating(userId, cat) {
  const r = getRatings(userId)[cat];
  return r ? r.rating : 1200;
}
// The category a player has played most (blitz when they have played none), for places that show one number.
function mainCategory(ratings) {
  let best = 'blitz';
  for (const c of CATEGORIES) if (ratings[c].games > ratings[best].games) best = c;
  return best;
}

// cat: 'bullet' | 'blitz' | 'rapid'; outcome: 'win' | 'loss' | 'draw'
function recordResult(userId, cat, newRating, outcome) {
  q.upsertResult.run(userId, cat, newRating, outcome === 'win' ? 1 : 0, outcome === 'loss' ? 1 : 0, outcome === 'draw' ? 1 : 0);
}

function saveGame(g) { q.insertGame.run(g); }
function leaderboard(cat) { return q.leaderboard.all(CATEGORIES.includes(cat) ? cat : 'blitz', Date.now()); }
function setTitle(userId, title) { q.setTitle.run(title, userId); }
function setBio(userId, bio) { q.setBio.run(bio, userId); }
function setRole(userId, role) { q.setRole.run(role, userId); }
function banUser(userId, until, reason, by) { q.ban.run(until, reason, by, userId); }
function unbanUser(userId) { q.unban.run(userId); }
function deleteSessionsForUser(userId) { q.delUserSessions.run(userId); }
function logAction(a) { q.log.run(Date.now(), a.actor_name, a.action, a.target_name, a.detail || ''); }
function modLog(limit = 30) { return q.modLog.all(limit); }
function listBans() { return q.bans.all(Date.now()); }
function listStaff() { return q.staff.all(); }
function userGames(id) { return q.userGames.all(id, id); }
function getGame(id) { return q.getGame.get(String(id)) || null; }
// Players whose name contains `term`, names that start with it first. `term` must be letters, digits or underscores.
function searchUsers(term) {
  const e = String(term).toLowerCase().replace(/_/g, '\\_');
  return q.searchUsers.all('%' + e + '%', e + '%');
}

module.exports = {
  getUserByName, getUserById, createUser, createSession, userForToken,
  deleteSession, recordResult, saveGame, leaderboard, userGames, setTitle, setBio, searchUsers, getGame,
  getRatings, getRating, mainCategory,
  setRole, banUser, unbanUser, deleteSessionsForUser, logAction, modLog, listBans, listStaff,
};
