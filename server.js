'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const bcrypt = require('bcryptjs');
const { Chess } = require('chess.js');
const store = require('./db');
const { CATEGORIES, categoryOf } = require('./timecontrol');

const PORT = process.env.PORT || 3000;

// "minutes+increment seconds"
const TIME_CONTROLS = {
  '1+0': { base: 60, inc: 0 },
  '3+0': { base: 180, inc: 0 },
  '3+2': { base: 180, inc: 2 },
  '5+0': { base: 300, inc: 0 },
  '5+3': { base: 300, inc: 3 },
  '10+0': { base: 600, inc: 0 },
  '15+10': { base: 900, inc: 10 },
};
const ABORT_MS = 60 * 1000;      // a side that has not made its first move in this time aborts the game
const K_FACTOR = 32;

const games = new Map();
const queues = new Map(Object.keys(TIME_CONTROLS).map((k) => [k, []]));

/* ------------------------------------------------------------------ */
/* HTTP: static files + accounts                                       */
/* ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', 1);
// Let the pages be hosted on another address (e.g. GitHub Pages). ALLOWED_ORIGINS is a
// comma-separated list such as "https://orange12234.github.io". Nothing is allowed if it is unset.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  attempts.set(ip, list);
  return list.length > 30;
}

// `ratings` has a separate rating and record for bullet, blitz and rapid. `rating` and `main` are the
// single number shown in small places (the category they have played most), and the totals add all three.
function publicUser(u) {
  const ratings = store.getRatings(u.id);
  const main = store.mainCategory(ratings);
  const total = (key) => CATEGORIES.reduce((n, c) => n + ratings[c][key], 0);
  return {
    id: u.id, username: u.username, title: u.title || '', bio: u.bio || '', role: u.role || '',
    rating: ratings[main].rating, main, ratings,
    games: total('games'), wins: total('wins'), losses: total('losses'), draws: total('draws'),
  };
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

app.post('/api/signup', (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–16 characters: letters, numbers or underscores.' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 72) {
    return res.status(400).json({ error: 'Password must be 6–72 characters.' });
  }
  if (store.getUserByName(username)) return res.status(409).json({ error: 'That username is taken.' });
  const user = store.createUser(username, bcrypt.hashSync(password, 10));
  res.json({ token: store.createSession(user.id), user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { username, password } = req.body || {};
  const user = typeof username === 'string' ? store.getUserByName(username) : null;
  const ok = bcrypt.compareSync(typeof password === 'string' ? password : '', user ? user.pass_hash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Wrong username or password.' });
  if (isBanned(user)) return res.status(403).json({ error: banMessage(user), ban: banInfo(user) });
  res.json({ token: store.createSession(user.id), user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  const t = bearer(req);
  if (t) store.deleteSession(t);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = store.userForToken(bearer(req));
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: publicUser(u) });
});

app.get('/api/me/games', (req, res) => {
  const u = store.userForToken(bearer(req));
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  res.json({ games: store.userGames(u.id) });
});

app.get('/api/leaderboard', (req, res) => {
  const cat = CATEGORIES.includes(req.query.cat) ? req.query.cat : 'blitz';
  res.json({ cat, players: store.leaderboard(cat) });
});

// Player search box: up to 8 matches, names that start with the text first.
app.get('/api/players/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!/^[A-Za-z0-9_]{1,16}$/.test(q)) return res.json({ players: [] });
  res.json({
    players: store.searchUsers(q).map((p) => {
      const ratings = store.getRatings(p.id);
      return { username: p.username, title: p.title, rating: ratings[store.mainCategory(ratings)].rating };
    }),
  });
});

/* ---- Stockfish (runs in the visitor's browser) and the files the analysis page needs ---- */
const ENGINE_DIR = path.join(__dirname, 'node_modules', 'stockfish', 'bin');
// "lite-single" is a small (about 2 MB) engine that works in every browser with no special setup.
// Start the server with STOCKFISH_BUILD=single to use the full-strength engine instead (a 94 MB download).
const ENGINE_BUILD = process.env.STOCKFISH_BUILD === 'single' ? 'single' : 'lite-single';

function findEngine() {
  try {
    const re = new RegExp('^stockfish-(\\d+(?:\\.\\d+)?)-' + ENGINE_BUILD + '\\.js$');
    for (const f of fs.readdirSync(ENGINE_DIR)) {
      const m = re.exec(f);
      if (m && fs.existsSync(path.join(ENGINE_DIR, f.replace(/\.js$/, '.wasm')))) return { file: f, version: m[1] };
    }
  } catch (e) { /* package not installed */ }
  return null;
}

app.get('/api/engine', (req, res) => {
  const e = findEngine();
  if (!e) return res.status(404).json({ error: 'The Stockfish files are missing. Run "npm install" in the site folder, then restart the server.' });
  res.json({ script: '/engine/' + e.file, version: e.version, build: ENGINE_BUILD, label: 'Stockfish ' + e.version + (ENGINE_BUILD === 'single' ? '' : ' (lite)') });
});

app.get('/engine/:file', (req, res) => {
  const e = findEngine();
  const ok = e && (req.params.file === e.file || req.params.file === e.file.replace(/\.js$/, '.wasm'));
  if (!ok) return res.status(404).end();
  res.sendFile(path.join(ENGINE_DIR, req.params.file), { maxAge: '7d', headers: { 'X-Content-Type-Options': 'nosniff' } });
});

// chess.js, the same library the server uses, so the browser can read PGNs and step through games.
app.get('/vendor/chess.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'chess.js', 'dist', 'esm', 'chess.js'), { maxAge: '7d' });
});

// A finished game, for the Review page.
app.get('/api/games/:id', (req, res) => {
  const g = /^[a-z0-9]{8}$/.test(req.params.id) ? store.getGame(req.params.id) : null;
  if (!g) return res.status(404).json({ error: 'That game is not saved. It may not have finished yet.' });
  const who = (id, name) => {
    const u = id ? store.getUserById(id) : null;
    return { name, reg: !!u, title: u ? u.title || '' : '' };
  };
  res.json({
    game: {
      id: g.id, white: who(g.white_id, g.white_name), black: who(g.black_id, g.black_name),
      result: g.result, reason: g.reason, moves: g.moves ? g.moves.split(' ') : [], tc: g.tc, rated: !!g.rated,
      ended_at: g.ended_at, white_delta: g.white_delta, black_delta: g.black_delta,
      white_elo: g.white_elo, black_elo: g.black_elo,
      pgn: buildPgn(g, siteOrigin(req)),
    },
  });
});

// The same game as a .pgn file download.
app.get('/api/games/:id/pgn', (req, res) => {
  const g = /^[a-z0-9]{8}$/.test(req.params.id) ? store.getGame(req.params.id) : null;
  if (!g) return res.status(404).type('text/plain').send('That game is not saved. Games need at least two moves to be saved.');
  res.set({
    'Content-Type': 'application/x-chess-pgn; charset=utf-8',
    'Content-Disposition': `attachment; filename="kingside-${g.id}.pgn"`,
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(buildPgn(g, siteOrigin(req)));
});

/* ---- PGN: the standard text record of a chess game ---- */
const TERMINATION = { timeout: 'Time forfeit', forfeit: 'Rules infraction', abandoned: 'Abandoned' };

function siteOrigin(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');   // where the pages live, if elsewhere
  const host = req.get('host') || '';
  return /^[A-Za-z0-9.\-:[\]]{1,100}$/.test(host) ? `${req.protocol}://${host}` : '';
}

function pgnTag(key, value) {
  return `[${key} "${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

function endingSentence(g) {
  if (g.result === '1/2-1/2') return `Draw by ${g.reason}.`;
  const winner = g.result === '1-0' ? 'White' : 'Black';
  switch (g.reason) {
    case 'checkmate': return `${winner} wins by checkmate.`;
    case 'resignation': return `${winner} wins by resignation.`;
    case 'timeout': return `${winner} wins on time.`;
    case 'forfeit': return `${winner} wins by forfeit.`;
    default: return `${winner} wins.`;
  }
}

function buildPgn(g, origin) {
  const ended = new Date(g.ended_at);
  const [mins, inc] = String(g.tc).split('+').map(Number);
  const white = g.white_id ? store.getUserById(g.white_id) : null;
  const black = g.black_id ? store.getUserById(g.black_id) : null;
  const tags = [
    ['Event', g.rated ? 'Kingside rated game' : 'Kingside casual game'],
    ['Site', origin ? `${origin}/#/review/${g.id}` : 'Kingside'],
    ['Date', ended.toISOString().slice(0, 10).replace(/-/g, '.')],
    ['Round', '-'],
    ['White', g.white_name],
    ['Black', g.black_name],
    ['Result', g.result],
  ];
  if (g.white_elo != null) tags.push(['WhiteElo', g.white_elo]);
  if (g.black_elo != null) tags.push(['BlackElo', g.black_elo]);
  if (white && white.title) tags.push(['WhiteTitle', white.title]);
  if (black && black.title) tags.push(['BlackTitle', black.title]);
  tags.push(['TimeControl', `${mins * 60}+${inc}`]);
  tags.push(['Termination', TERMINATION[g.reason] || 'Normal']);

  const tokens = [];
  (g.moves ? g.moves.split(' ').filter(Boolean) : []).forEach((san, i) => {
    if (i % 2 === 0) tokens.push(`${i / 2 + 1}.`);
    tokens.push(san);
  });
  tokens.push(`{ ${endingSentence(g)} }`, g.result);

  const lines = [];
  let line = '';
  for (const t of tokens) {
    if (line && line.length + 1 + t.length > 80) { lines.push(line); line = t; } else line = line ? `${line} ${t}` : t;
  }
  if (line) lines.push(line);
  return tags.map(([k, v]) => pgnTag(k, v)).join('\n') + '\n\n' + lines.join('\n') + '\n';
}

/* ---- roles and bans ---- */
// Roles: 'owner' (full control), 'mod' (can ban and unban regular players), '' (everyone else).
const PERM_BAN = 8640000000000000; // "forever": the largest date JavaScript supports
const ALLOW_GUESTS = process.env.ALLOW_GUESTS === '1'; // an account is required to play, unless ALLOW_GUESTS=1

const isStaff = (u) => !!u && (u.role === 'owner' || u.role === 'mod');
const isBanned = (u) => !!u && u.ban_until > Date.now();
const banInfo = (u) => ({ until: u.ban_until >= PERM_BAN ? null : u.ban_until, reason: u.ban_reason, by: u.banned_by });

function banMessage(u) {
  const when = u.ban_until >= PERM_BAN
    ? 'permanently'
    : 'until ' + new Date(u.ban_until).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return `This account is banned ${when}. Reason: ${u.ban_reason}`;
}

// Can `actor` ban `target`? Mods can't ban mods or the owner, and nobody can ban an owner.
function canBan(actor, t) {
  return isStaff(actor) && t.id !== actor.id && t.role !== 'owner'
    && !(t.role === 'mod' && actor.role !== 'owner') && !isBanned(t);
}
// A ban set by the owner can only be lifted by an owner.
function canLiftBan(actor, t) {
  if (!isStaff(actor) || !isBanned(t)) return false;
  const by = store.getUserByName(t.banned_by);
  return !(by && by.role === 'owner' && actor.role !== 'owner');
}
const canSetMod = (actor, t) => !!actor && actor.role === 'owner' && t.role !== 'owner' && !isBanned(t);

function requireStaff(req, res) {
  const u = store.userForToken(bearer(req));
  if (!u) { res.status(401).json({ error: 'Not logged in' }); return null; }
  if (!isStaff(u)) { res.status(403).json({ error: 'Moderators only.' }); return null; }
  return u;
}

app.get('/api/users/:username', (req, res) => {
  const u = store.getUserByName(req.params.username);
  if (!u) return res.status(404).json({ error: 'No player with that name.' });
  const viewer = store.userForToken(bearer(req));
  const out = {
    user: { ...publicUser(u), created_at: u.created_at, banned: isBanned(u) },
    games: store.userGames(u.id),
  };
  if (isStaff(viewer)) {
    out.mod = {
      canBan: canBan(viewer, u),
      canUnban: canLiftBan(viewer, u),
      canSetMod: canSetMod(viewer, u),
      ban: isBanned(u) ? banInfo(u) : null,
    };
  }
  res.json(out);
});

app.post('/api/mod/ban', (req, res) => {
  const actor = requireStaff(req, res);
  if (!actor) return;
  const { username, hours, reason } = req.body || {};
  const target = typeof username === 'string' ? store.getUserByName(username) : null;
  if (!target) return res.status(404).json({ error: 'No player with that name.' });
  if (target.id === actor.id) return res.status(400).json({ error: 'You cannot ban yourself.' });
  if (!canBan(actor, target)) {
    return res.status(403).json({ error: isBanned(target) ? 'That player is already banned.' : 'You cannot ban this player.' });
  }
  const why = typeof reason === 'string' ? reason.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) : '';
  if (why.length < 3) return res.status(400).json({ error: 'Give a reason (at least 3 characters).' });

  let until = PERM_BAN;
  let length = 'permanent';
  if (hours !== null) {
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0 || h > 24 * 365) {
      return res.status(400).json({ error: 'Ban length must be between 1 hour and 1 year, or permanent.' });
    }
    until = Date.now() + Math.round(h * 3600 * 1000);
    length = h >= 24 ? `${Math.round(h / 24)} day(s)` : `${h} hour(s)`;
  }

  store.banUser(target.id, until, why, actor.username);
  if (target.role === 'mod') store.setRole(target.id, '');
  store.deleteSessionsForUser(target.id);
  store.logAction({ actor_name: actor.username, action: 'banned', target_name: target.username, detail: `${length}: ${why}` });
  enforceBan(target.id, { until: until >= PERM_BAN ? null : until, reason: why });
  res.json({ ok: true });
});

app.post('/api/mod/unban', (req, res) => {
  const actor = requireStaff(req, res);
  if (!actor) return;
  const { username } = req.body || {};
  const target = typeof username === 'string' ? store.getUserByName(username) : null;
  if (!target) return res.status(404).json({ error: 'No player with that name.' });
  if (!isBanned(target)) return res.status(400).json({ error: 'That player is not banned.' });
  if (!canLiftBan(actor, target)) return res.status(403).json({ error: 'Only the owner can lift this ban.' });
  store.unbanUser(target.id);
  store.logAction({ actor_name: actor.username, action: 'unbanned', target_name: target.username });
  res.json({ ok: true });
});

// Only the owner can give or take away moderator powers.
app.post('/api/owner/mod', (req, res) => {
  const actor = store.userForToken(bearer(req));
  if (!actor) return res.status(401).json({ error: 'Not logged in' });
  if (actor.role !== 'owner') return res.status(403).json({ error: 'Only the owner can do this.' });
  const { username, mod } = req.body || {};
  const target = typeof username === 'string' ? store.getUserByName(username) : null;
  if (!target) return res.status(404).json({ error: 'No player with that name.' });
  if (typeof mod !== 'boolean') return res.status(400).json({ error: 'Say whether to add or remove the moderator role.' });
  if (!canSetMod(actor, target)) return res.status(403).json({ error: "You can't change this player's role." });
  store.setRole(target.id, mod ? 'mod' : '');
  store.logAction({ actor_name: actor.username, action: mod ? 'made moderator' : 'removed moderator', target_name: target.username });
  res.json({ ok: true });
});

app.get('/api/mod/overview', (req, res) => {
  const actor = requireStaff(req, res);
  if (!actor) return;
  const bans = store.listBans().map((b) => {
    const full = store.getUserByName(b.username);
    return {
      username: b.username,
      title: b.title,
      until: b.ban_until >= PERM_BAN ? null : b.ban_until,
      reason: b.ban_reason,
      by: b.banned_by,
      canUnban: canLiftBan(actor, full),
    };
  });
  res.json({ you: actor.role, bans, staff: store.listStaff(), log: store.modLog(30) });
});

app.post('/api/me/profile', (req, res) => {
  const u = store.userForToken(bearer(req));
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  const bio = (req.body || {}).bio;
  if (typeof bio !== 'string') return res.status(400).json({ error: 'Bio must be text.' });
  const clean = bio.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  if (clean.length > 200) return res.status(400).json({ error: 'Bio can be at most 200 characters.' });
  store.setBio(u.id, clean);
  res.json({ user: publicUser(store.getUserById(u.id)) });
});

/* ------------------------------------------------------------------ */
/* Game logic                                                          */
/* ------------------------------------------------------------------ */
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function genId() {
  for (;;) {
    let id = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) id += ID_CHARS[bytes[i] % ID_CHARS.length];
    if (!games.has(id)) return id;
  }
}

function newGame(tc, rated) {
  const spec = TIME_CONTROLS[tc];
  const g = {
    id: genId(),
    chess: new Chess(),
    tc,
    cat: categoryOf(spec.base, spec.inc), // 'bullet' | 'blitz' | 'rapid': which rating this game counts towards
    inc: spec.inc,
    clock: { w: spec.base * 1000, b: spec.base * 1000 },
    running: false,
    turnStart: 0,
    status: 'waiting', // waiting | active | finished
    result: null,
    reason: null,
    rated,
    seats: { w: null, b: null },
    sockets: new Set(),
    chat: [],
    drawOffer: null,
    rematch: new Set(),
    lastMove: null,
    ratingChange: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    endedAt: null,
    timers: {},
  };
  games.set(g.id, g);
  return g;
}

function makeSeat(ws, cat) {
  let rating = null;
  let title = '';
  let userId = null;
  let name = 'Guest-' + ws.cid.slice(0, 4);
  if (ws.user) {
    const fresh = store.getUserById(ws.user.id);
    if (fresh) { userId = fresh.id; name = fresh.username; rating = store.getRating(fresh.id, cat); title = fresh.title || ''; }
  }
  return { cid: ws.cid, userId, name, rating, title };
}

function seatMatches(seat, ws) {
  if (!seat) return false;
  if (seat.cid === ws.cid) return true;
  return !!(seat.userId && ws.user && seat.userId === ws.user.id);
}

function currentClocks(g) {
  const c = { w: g.clock.w, b: g.clock.b };
  if (g.status === 'active' && g.running) {
    const t = g.chess.turn();
    c[t] = Math.max(0, c[t] - (Date.now() - g.turnStart));
  }
  return c;
}

function drawReason(chess) {
  if (chess.isStalemate()) return 'stalemate';
  if (chess.isInsufficientMaterial()) return 'insufficient material';
  if (chess.isThreefoldRepetition()) return 'threefold repetition';
  return 'fifty-move rule';
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function statePayload(g, ws) {
  const turn = g.chess.turn();
  const payload = {
    t: 'game',
    id: g.id,
    status: g.status,
    color: ws.color,
    fen: g.chess.fen(),
    turn,
    moves: g.chess.history(),
    lastMove: g.lastMove,
    check: g.chess.isCheck(),
    clocks: currentClocks(g),
    running: g.running && g.status === 'active',
    serverTime: Date.now(),
    white: g.seats.w && { name: g.seats.w.name, rating: g.seats.w.rating, title: g.seats.w.title, reg: !!g.seats.w.userId },
    black: g.seats.b && { name: g.seats.b.name, rating: g.seats.b.rating, title: g.seats.b.title, reg: !!g.seats.b.userId },
    online: { w: false, b: false },
    rated: g.rated,
    tc: g.tc,
    cat: g.cat,
    result: g.result,
    reason: g.reason,
    drawOffer: g.drawOffer,
    rematch: [...g.rematch],
    ratingChange: g.ratingChange,
    legal: null,
  };
  for (const s of g.sockets) if (s.color === 'w' || s.color === 'b') payload.online[s.color] = true;
  if (g.status === 'active' && ws.color === turn) {
    const legal = {};
    for (const m of g.chess.moves({ verbose: true })) (legal[m.from] = legal[m.from] || new Set()).add(m.to);
    payload.legal = Object.fromEntries(Object.entries(legal).map(([k, v]) => [k, [...v]]));
  }
  return payload;
}

function broadcast(g) {
  for (const ws of g.sockets) send(ws, statePayload(g, ws));
}

function clearTimers(g) {
  clearTimeout(g.timers.flag);
  clearTimeout(g.timers.abort);
}

function scheduleFlag(g) {
  clearTimeout(g.timers.flag);
  if (g.status !== 'active' || !g.running) return;
  const t = g.chess.turn();
  const left = g.clock[t] - (Date.now() - g.turnStart);
  g.timers.flag = setTimeout(() => {
    if (g.status !== 'active' || !g.running) return;
    const tt = g.chess.turn();
    if (currentClocks(g)[tt] <= 0) endGame(g, tt === 'w' ? '0-1' : '1-0', 'timeout');
    else scheduleFlag(g);
  }, Math.max(0, left) + 20);
}

function scheduleAbort(g) {
  clearTimeout(g.timers.abort);
  g.timers.abort = setTimeout(() => {
    if (g.status === 'active' && g.chess.history().length < 2) endGame(g, '*', 'aborted (no move played)');
  }, ABORT_MS);
}

function startGame(g) {
  g.status = 'active';
  g.lastActivity = Date.now();
  scheduleAbort(g);
}

function eloDelta(rw, rb, scoreWhite) {
  const expectedWhite = 1 / (1 + Math.pow(10, (rb - rw) / 400));
  return Math.round(K_FACTOR * (scoreWhite - expectedWhite));
}

function endGame(g, result, reason) {
  if (g.status === 'finished') return;
  g.clock = currentClocks(g);
  g.running = false;
  g.status = 'finished';
  g.result = result;
  g.reason = reason;
  g.drawOffer = null;
  g.endedAt = Date.now();
  clearTimers(g);

  const w = g.seats.w;
  const b = g.seats.b;
  const played = g.chess.history().length >= 2 && result !== '*';
  let deltaW = null;
  let deltaB = null;
  // Ratings from before this game, for the PGN (the rated block below changes them).
  const ratingOf = (seat) => {
    const u = seat && seat.userId ? store.getUserById(seat.userId) : null;
    return u ? store.getRating(u.id, g.cat) : null;
  };
  const eloW = ratingOf(w);
  const eloB = ratingOf(b);

  if (g.rated && played && w && b && w.userId && b.userId) {
    const uw = store.getUserById(w.userId);
    const ub = store.getUserById(b.userId);
    if (uw && ub) {
      const score = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
      // Only the rating for this game's category (bullet, blitz or rapid) moves.
      const rw = store.getRating(uw.id, g.cat);
      const rb = store.getRating(ub.id, g.cat);
      const d = eloDelta(rw, rb, score);
      deltaW = d;
      deltaB = -d;
      const outW = score === 1 ? 'win' : score === 0 ? 'loss' : 'draw';
      const outB = score === 1 ? 'loss' : score === 0 ? 'win' : 'draw';
      store.recordResult(uw.id, g.cat, rw + d, outW);
      store.recordResult(ub.id, g.cat, rb - d, outB);
      w.rating = rw + d;
      b.rating = rb - d;
      g.ratingChange = { w: deltaW, b: deltaB };
    }
  }

  if (played && w && b) {
    try {
      store.saveGame({
        id: g.id,
        white_name: w.name,
        black_name: b.name,
        white_id: w.userId,
        black_id: b.userId,
        result,
        reason,
        moves: g.chess.history().join(' '),
        tc: g.tc,
        rated: g.ratingChange ? 1 : 0,
        white_delta: deltaW,
        black_delta: deltaB,
        ended_at: Date.now(),
        white_elo: eloW,
        black_elo: eloB,
      });
    } catch (e) {
      console.error('saveGame failed', e);
    }
  }
  broadcast(g);
}

function handleMove(ws, msg) {
  const g = games.get(ws.gameId);
  if (!g || g.status !== 'active') return send(ws, { t: 'error', msg: 'No active game.' });
  const turn = g.chess.turn();
  if (ws.color !== turn) return send(ws, { t: 'error', msg: 'Not your turn.' });

  const now = Date.now();
  let left = null;
  if (g.running) {
    left = g.clock[turn] - (now - g.turnStart);
    if (left <= 0) {
      g.clock[turn] = 0;
      return endGame(g, turn === 'w' ? '0-1' : '1-0', 'timeout');
    }
  }

  const from = String(msg.from || '');
  const to = String(msg.to || '');
  const promotion = typeof msg.promotion === 'string' && 'qrbn'.includes(msg.promotion) ? msg.promotion : undefined;
  let mv;
  try {
    mv = g.chess.move({ from, to, promotion });
  } catch (e) {
    return send(ws, { t: 'error', msg: 'Illegal move.' });
  }

  if (left !== null) g.clock[turn] = left + g.inc * 1000;
  g.lastMove = { from: mv.from, to: mv.to };
  g.drawOffer = null;
  g.lastActivity = now;
  const n = g.chess.history().length;
  if (n >= 2) {
    g.running = true;
    g.turnStart = now;
  }
  clearTimeout(g.timers.abort);
  if (n < 2) scheduleAbort(g);

  if (g.chess.isCheckmate()) return endGame(g, turn === 'w' ? '1-0' : '0-1', 'checkmate');
  if (g.chess.isDraw()) return endGame(g, '1/2-1/2', drawReason(g.chess));
  scheduleFlag(g);
  broadcast(g);
}

function colorOf(ws) {
  return ws.color === 'w' || ws.color === 'b' ? ws.color : null;
}

function handleResign(ws) {
  const g = games.get(ws.gameId);
  const c = colorOf(ws);
  if (!g || !c || g.status !== 'active') return;
  if (g.chess.history().length < 2) return endGame(g, '*', 'aborted');
  endGame(g, c === 'w' ? '0-1' : '1-0', 'resignation');
}

function handleDraw(ws, action) {
  const g = games.get(ws.gameId);
  const c = colorOf(ws);
  if (!g || !c || g.status !== 'active') return;
  if (action === 'offer') {
    if (g.drawOffer) return;
    g.drawOffer = c;
  } else if (action === 'accept') {
    if (!g.drawOffer || g.drawOffer === c) return;
    return endGame(g, '1/2-1/2', 'agreement');
  } else if (action === 'decline') {
    if (!g.drawOffer || g.drawOffer === c) return;
    g.drawOffer = null;
  }
  broadcast(g);
}

function handleChat(ws, text) {
  const g = games.get(ws.gameId);
  const c = colorOf(ws);
  if (!g || !c || typeof text !== 'string') return;
  const now = Date.now();
  if (ws.lastChat && now - ws.lastChat < 400) return;
  ws.lastChat = now;
  const clean = text.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
  if (!clean) return;
  const msg = { c, name: g.seats[c].name, text: clean, ts: now };
  g.chat.push(msg);
  if (g.chat.length > 100) g.chat.shift();
  for (const s of g.sockets) send(s, { t: 'chat', msg });
}

function handleRematch(ws) {
  const g = games.get(ws.gameId);
  const c = colorOf(ws);
  if (!g || !c || g.status !== 'finished' || !g.seats.w || !g.seats.b) return;
  g.rematch.add(c);
  if (g.rematch.size < 2) return broadcast(g);
  const ng = newGame(g.tc, g.rated);
  ng.seats.w = g.seats.b;
  ng.seats.b = g.seats.w;
  startGame(ng);
  for (const s of g.sockets) if (colorOf(s)) send(s, { t: 'goto', id: ng.id });
  g.rematch.clear();
}

function leaveGame(ws) {
  const g = games.get(ws.gameId);
  ws.gameId = null;
  ws.color = null;
  if (g) {
    g.sockets.delete(ws);
    broadcast(g);
  }
}

function joinGame(ws, id) {
  const g = games.get(String(id));
  if (!g) return send(ws, { t: 'error', code: 'nogame', msg: 'That game could not be found. It may have expired.' });
  if (ws.gameId && ws.gameId !== g.id) leaveGame(ws);
  cancelSeek(ws);

  let color = null;
  for (const c of ['w', 'b']) if (seatMatches(g.seats[c], ws)) color = c;
  if (!color && g.status === 'waiting') {
    if (needLogin(ws)) return;
    color = g.seats.w ? 'b' : 'w';
    g.seats[color] = makeSeat(ws, g.cat);
  }
  ws.gameId = g.id;
  ws.color = color || 's';
  g.sockets.add(ws);
  if (g.status === 'waiting' && g.seats.w && g.seats.b) startGame(g);
  send(ws, { t: 'chatHistory', chat: g.chat });
  broadcast(g);
}

function createFriendGame(ws, tc, pref) {
  if (!TIME_CONTROLS[tc]) return;
  if (needLogin(ws)) return;
  const g = newGame(tc, false);
  const color = pref === 'w' || pref === 'b' ? pref : Math.random() < 0.5 ? 'w' : 'b';
  g.seats[color] = makeSeat(ws, g.cat);
  send(ws, { t: 'goto', id: g.id });
}

/* ---- applying a ban to someone who is online ---- */
function enforceBan(userId, info) {
  // Live games end: the opponent wins (or the game is aborted if it had barely started).
  for (const g of games.values()) {
    if (g.status !== 'active') continue;
    for (const c of ['w', 'b']) {
      if (g.seats[c] && g.seats[c].userId === userId) {
        if (g.chess.history().length < 2) endGame(g, '*', 'aborted');
        else endGame(g, c === 'w' ? '0-1' : '1-0', 'forfeit');
      }
    }
  }
  for (const ws of wss.clients) {
    if (ws.user && ws.user.id === userId) {
      cancelSeek(ws);
      send(ws, { t: 'banned', until: info.until, reason: info.reason });
      ws.user = null;
      ws.close();
    }
  }
}

function needLogin(ws) {
  if (ALLOW_GUESTS || ws.user) return false;
  send(ws, { t: 'error', code: 'login', msg: 'You need an account to play. It is free and takes a few seconds.' });
  return true;
}

/* ---- matchmaking ---- */
function cancelSeek(ws) {
  if (!ws.seeking) return;
  const q = queues.get(ws.seeking);
  if (q) {
    const i = q.findIndex((s) => s.ws === ws);
    if (i >= 0) q.splice(i, 1);
  }
  ws.seeking = null;
}

function seek(ws, tc) {
  if (!TIME_CONTROLS[tc]) return;
  if (needLogin(ws)) return;
  cancelSeek(ws);
  if (ws.gameId) leaveGame(ws);
  const q = queues.get(tc);
  const i = q.findIndex((s) => s.ws.readyState === 1 && s.ws.cid !== ws.cid && !(ws.user && s.ws.user && ws.user.id === s.ws.user.id));
  if (i < 0) {
    q.push({ ws });
    ws.seeking = tc;
    return send(ws, { t: 'seeking', tc });
  }
  const [opp] = q.splice(i, 1);
  opp.ws.seeking = null;
  const rated = !!(ws.user && opp.ws.user);
  const g = newGame(tc, rated);
  const meWhite = Math.random() < 0.5;
  g.seats[meWhite ? 'w' : 'b'] = makeSeat(ws, g.cat);
  g.seats[meWhite ? 'b' : 'w'] = makeSeat(opp.ws, g.cat);
  startGame(g);
  send(ws, { t: 'goto', id: g.id });
  send(opp.ws, { t: 'goto', id: g.id });
}

function queueCounts() {
  const out = {};
  for (const [k, q] of queues) out[k] = q.length;
  return out;
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.cid = null;
  ws.user = null;
  ws.gameId = null;
  ws.color = null;
  ws.seeking = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    try {
      if (msg.t === 'hello') {
        ws.cid = typeof msg.cid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(msg.cid) ? msg.cid : crypto.randomBytes(12).toString('hex');
        ws.user = store.userForToken(msg.token);
        return send(ws, { t: 'welcome', user: ws.user ? publicUser(ws.user) : null, guests: ALLOW_GUESTS, queues: queueCounts() });
      }
      if (!ws.cid) return send(ws, { t: 'error', msg: 'Send hello first.' });

      switch (msg.t) {
        case 'seek': return seek(ws, msg.tc);
        case 'cancelSeek': cancelSeek(ws); return send(ws, { t: 'seekCancelled' });
        case 'create': return createFriendGame(ws, msg.tc, msg.color);
        case 'join': return joinGame(ws, msg.id);
        case 'leave': return leaveGame(ws);
        case 'move': return handleMove(ws, msg);
        case 'resign': return handleResign(ws);
        case 'draw': return handleDraw(ws, msg.action);
        case 'chat': return handleChat(ws, msg.text);
        case 'rematch': return handleRematch(ws);
        case 'queues': return send(ws, { t: 'queues', queues: queueCounts() });
        default: return;
      }
    } catch (e) {
      console.error('message error', e);
      send(ws, { t: 'error', msg: 'Something went wrong.' });
    }
  });

  ws.on('close', () => {
    cancelSeek(ws);
    leaveGame(ws);
  });
});

// keep connections alive through proxies and drop dead ones
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

// tidy up old games
setInterval(() => {
  const now = Date.now();
  for (const [id, g] of games) {
    const stale =
      (g.status === 'finished' && now - g.endedAt > 10 * 60 * 1000) ||
      (g.status === 'waiting' && now - g.createdAt > 30 * 60 * 1000) ||
      (g.status === 'active' && g.sockets.size === 0 && now - g.lastActivity > 60 * 60 * 1000);
    if (stale) {
      if (g.status === 'active') endGame(g, '*', 'abandoned');
      clearTimers(g);
      games.delete(id);
    }
  }
}, 60 * 1000);

if (require.main === module) {
  server.listen(PORT, () => console.log(`Chess server running on http://localhost:${PORT}`));
}

module.exports = { server, TIME_CONTROLS, queues };
