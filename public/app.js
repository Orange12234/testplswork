(() => {
  'use strict';

  /* ---------- helpers ---------- */
  const $ = (sel, el = document) => el.querySelector(sel);
  // Piece images live in /pieces as wK.svg, bP.svg, and so on (colour letter, then piece letter).
  function pieceImg(color, type) {
    const img = document.createElement('img');
    img.className = 'pc';
    img.src = 'pieces/' + color + type.toUpperCase() + '.svg';
    img.alt = '';
    img.draggable = false;
    return img;
  }
  for (const c of ['w', 'b']) for (const t of 'kqrbnp') new Image().src = 'pieces/' + c + t.toUpperCase() + '.svg'; // warm the cache
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  // Every player has a separate rating for each of these (the server decides a game's category from its clock).
  const CAT_NAMES = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid' };
  let leaderCat = ['bullet', 'blitz', 'rapid'].includes(store('leaderCat')) ? store('leaderCat') : 'blitz';
  const TIME_CONTROLS = [
    { tc: '1+0', label: 'Bullet' },
    { tc: '3+0', label: 'Blitz' },
    { tc: '3+2', label: 'Blitz' },
    { tc: '5+0', label: 'Blitz' },
    { tc: '5+3', label: 'Blitz' },
    { tc: '10+0', label: 'Rapid' },
    { tc: '15+10', label: 'Rapid' },
  ];

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  function randomId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  let cid;
  try {
    cid = sessionStorage.getItem('cid');
    if (!cid) { cid = randomId(); sessionStorage.setItem('cid', cid); }
  } catch (e) { cid = randomId(); }

  let toastTimer;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // A player's name, with their title badge, linked to their profile when they have an account.
  function fillName(container, p, fallback) {
    container.textContent = '';
    if (!p) { container.textContent = fallback || ''; return; }
    if (p.title) container.appendChild(el('span', 'title', p.title));
    if (p.reg) {
      const a = el('a', 'plink', p.name);
      a.href = '#/u/' + encodeURIComponent(p.name);
      container.appendChild(a);
    } else {
      container.appendChild(document.createTextNode(p.name));
    }
  }

  /* ---------- state ---------- */
  let ws = null;
  let wsReady = false;
  let token = store('token');
  let user = null;
  let game = null;
  let recvAt = 0;
  let curPos = {};
  let selected = null;
  let pendingPromo = null;
  let seekingTc = null;
  let guestsAllowed = false;  // the server says whether people without an account may play
  let afterLogin = null;      // what to do once a guest has logged in (for example, start the search they asked for)
  let chosenTc = store('tc') || '5+0';
  if (!TIME_CONTROLS.some((t) => t.tc === chosenTc)) chosenTc = '5+0';
  let routeGameId = null;

  if (!window.KINGSIDE.configured) {
    const b = document.createElement('div');
    b.className = 'toast';
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99;border-radius:0;text-align:center;padding:10px 16px;background:#7a1f1f;color:#fff';
    b.textContent = 'This site is not connected to a game server yet. Open config.js and put your server address in it.';
    document.body.appendChild(b);
  }

  /* ---------- API ---------- */
  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(window.KINGSIDE.url(path), { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  /* ---------- websocket ---------- */
  function send(obj) {
    if (wsReady && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function connect() {
    ws = new WebSocket(window.KINGSIDE.wsUrl());
    ws.onopen = () => {
      wsReady = true;
      $('#conn').hidden = true;
      send({ t: 'hello', cid, token });
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      onMessage(msg);
    };
    ws.onclose = () => {
      wsReady = false;
      $('#conn').hidden = false;
      seekingTc = null;
      renderSeek();
      setTimeout(connect, 1500);
    };
  }

  function onMessage(msg) {
    switch (msg.t) {
      case 'welcome':
        user = msg.user;
        guestsAllowed = !!msg.guests;
        if (!user && token) { token = null; store('token', null); }
        renderAccount();
        loadAccountData();
        route(true);
        if (user && afterLogin) { const next = afterLogin; afterLogin = null; next(); }
        break;
      case 'goto':
        seekingTc = null;
        renderSeek();
        if (location.hash === '#/g/' + msg.id) route(true);
        else location.hash = '#/g/' + msg.id;
        break;
      case 'seeking':
        seekingTc = msg.tc;
        renderSeek();
        break;
      case 'seekCancelled':
        seekingTc = null;
        renderSeek();
        break;
      case 'game':
        if (msg.id !== routeGameId) return;
        onGame(msg);
        break;
      case 'banned': {
        token = null;
        store('token', null);
        user = null;
        const until = msg.until ? ' until ' + new Date(msg.until).toLocaleString() : ' permanently';
        alert('Your account has been banned' + until + '.\nReason: ' + msg.reason);
        location.hash = '#/';
        renderAccount();
        break;
      }
      case 'chatHistory':
        $('#chat-log').textContent = '';
        msg.chat.forEach(addChat);
        break;
      case 'chat':
        addChat(msg.msg);
        break;
      case 'error':
        if (msg.code === 'nogame') showMissingGame(msg.msg);
        else if (msg.code === 'login') needAccount(msg.msg);
        else toast(msg.msg || 'Something went wrong.');
        break;
      default:
        break;
    }
  }

  /* ---------- routing ---------- */
  function parseRoute() {
    let m = /^#\/g\/([a-z0-9]+)$/.exec(location.hash);
    if (m) return { type: 'game', id: m[1] };
    m = /^#\/u\/([A-Za-z0-9_]{3,16})$/.exec(location.hash);
    if (m) return { type: 'user', name: m[1] };
    if (location.hash === '#/mod') return { type: 'mod' };
    if (location.hash === '#/analysis') return { type: 'analysis' };
    m = /^#\/review\/([a-z0-9]{8})$/.exec(location.hash);
    if (m) return { type: 'review', id: m[1] };
    return { type: 'lobby' };
  }

  function showView(name) {
    for (const v of ['lobby', 'game', 'profile', 'mod', 'analysis']) $('#view-' + v).hidden = v !== name;
  }

  function route(force) {
    const r = parseRoute();
    if (r.type === 'game') {
      showView('game');
      if (r.id !== routeGameId || !game || force) {
        if (r.id !== routeGameId) resetGameUI();
        routeGameId = r.id;
        send({ t: 'join', id: r.id });
      }
      return;
    }
    if (routeGameId) send({ t: 'leave' });
    routeGameId = null;
    game = null;
    document.title = 'Kingside - play chess online';
    if (r.type !== 'analysis' && r.type !== 'review' && window.KingsideAnalysis) window.KingsideAnalysis.hide();
    if (r.type === 'analysis' || r.type === 'review') {
      showView('analysis');
      window.KingsideAnalysis.show(r);
    } else if (r.type === 'user') {
      showView('profile');
      loadProfile(r.name);
    } else if (r.type === 'mod') {
      showView('mod');
      loadMod();
    } else {
      showView('lobby');
      loadAccountData();
    }
  }

  window.addEventListener('hashchange', () => route(false));

  /* ---------- board drawing ---------- */
  function parseFen(fen) {
    const pos = {};
    fen.split(' ')[0].split('/').forEach((row, i) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += Number(ch);
        else { pos['abcdefgh'[f] + (8 - i)] = ch; f++; }
      }
    });
    return pos;
  }

  function drawBoard(container, pos, ori, hl = {}) {
    const files = 'abcdefgh';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 64; i++) {
      const row = Math.floor(i / 8);
      const col = i % 8;
      const f = ori === 'w' ? col : 7 - col;
      const r = ori === 'w' ? 7 - row : row;
      const sq = files[f] + (r + 1);
      const d = document.createElement('div');
      d.className = 'sq ' + ((f + r) % 2 === 0 ? 'dark' : 'light');
      d.dataset.sq = sq;
      if (row === 7) d.dataset.file = files[f];
      if (col === 0) d.dataset.rank = String(r + 1);
      if (hl.last && hl.last.includes(sq)) d.classList.add('last');
      if (hl.sel === sq) d.classList.add('sel');
      if (hl.targets && hl.targets.has(sq)) d.classList.add(pos[sq] ? 'capture' : 'target');
      if (hl.check === sq) d.classList.add('check');
      const p = pos[sq];
      if (p) {
        d.appendChild(pieceImg(p === p.toUpperCase() ? 'w' : 'b', p));
      }
      frag.appendChild(d);
    }
    container.textContent = '';
    container.appendChild(frag);
  }

  /* ---------- game rendering ---------- */
  function isPlayer() { return game && (game.color === 'w' || game.color === 'b'); }

  function resetGameUI() {
    game = null;
    selected = null;
    pendingPromo = null;
    $('#board').textContent = '';
    $('#moves').textContent = '';
    $('#chat-log').textContent = '';
    $('#status').textContent = 'Joining game…';
    $('#status-sub').textContent = '';
    $('#invite').hidden = true;
    $('#promo').hidden = true;
    for (const id of ['btn-draw', 'btn-resign', 'btn-rematch', 'btn-review', 'btn-pgn-dl', 'draw-offered', 'draw-prompt']) $('#' + id).hidden = true;
    for (const id of ['p-top', 'p-bottom']) {
      const p = $('#' + id);
      $('.pname', p).textContent = '';
      $('.prating', p).textContent = '';
      $('.clock', p).textContent = '';
      p.classList.remove('turn');
    }
  }

  function showMissingGame(text) {
    game = null;
    $('#status').textContent = 'Game not found';
    $('#status-sub').textContent = text || 'It may have finished or expired.';
    $('#board').textContent = '';
    $('#invite').hidden = true;
  }

  function onGame(msg) {
    const prevTurnKey = game ? game.fen + game.status : null;
    game = msg;
    recvAt = Date.now();
    if (prevTurnKey !== game.fen + game.status) { selected = null; pendingPromo = null; $('#promo').hidden = true; }
    renderGame();
  }

  function resultText(g) {
    if (g.result === '*') return 'Game aborted';
    if (g.result === '1/2-1/2') return 'Draw by ' + g.reason;
    const winner = g.result === '1-0' ? 'White' : 'Black';
    if (g.reason === 'checkmate') return winner + ' wins by checkmate';
    if (g.reason === 'timeout') return winner + ' wins on time';
    if (g.reason === 'resignation') return winner + ' wins by resignation';
    return winner + ' wins';
  }

  function renderGame() {
    const g = game;
    if (!g) return;
    const ori = g.color === 'b' ? 'b' : 'w';
    curPos = parseFen(g.fen);
    if (selected && !(g.legal && g.legal[selected])) selected = null;

    let checkSq = null;
    if (g.check && g.status !== 'waiting') {
      const kingChar = g.turn === 'w' ? 'K' : 'k';
      checkSq = Object.keys(curPos).find((s) => curPos[s] === kingChar) || null;
    }
    drawBoard($('#board'), curPos, ori, {
      last: g.lastMove ? [g.lastMove.from, g.lastMove.to] : null,
      sel: selected,
      targets: new Set(selected && g.legal ? g.legal[selected] : []),
      check: checkSq,
    });

    // player strips
    const bottomColor = ori;
    const topColor = ori === 'w' ? 'b' : 'w';
    fillPlayer($('#p-top'), topColor);
    fillPlayer($('#p-bottom'), bottomColor);

    // info
    $('#g-tc').textContent = (CAT_NAMES[g.cat] ? CAT_NAMES[g.cat] + ' ' : '') + g.tc.replace('+', ' + ');
    $('#g-rated').textContent = g.rated ? 'Rated' : 'Casual';

    // status
    const mine = isPlayer();
    const myTurn = mine && g.turn === g.color;
    let status = '';
    let sub = '';
    if (g.status === 'waiting') {
      status = 'Waiting for your friend to join';
      sub = 'You are playing ' + (g.color === 'w' ? 'White' : 'Black') + '.';
    } else if (g.status === 'active') {
      if (mine) {
        status = myTurn ? (g.check ? 'Check! Your move' : 'Your move') : "Opponent's move";
        const opp = g.color === 'w' ? 'b' : 'w';
        if (!g.online[opp]) sub = 'Your opponent is not connected right now.';
        else if (g.moves.length < 2) sub = 'Clocks start once both players have moved.';
      } else {
        status = (g.turn === 'w' ? 'White' : 'Black') + ' to move';
        sub = 'You are watching this game.';
      }
    } else {
      status = resultText(g);
      if (g.ratingChange && mine) {
        const d = g.ratingChange[g.color];
        const mineP = g.color === 'w' ? g.white : g.black;
        sub = (CAT_NAMES[g.cat] || 'Your') + ' rating: ' + mineP.rating + ' (' + (d > 0 ? '+' : '') + d + ')';
      }
    }
    $('#status').textContent = status;
    $('#status-sub').textContent = sub;
    document.title = (g.status === 'active' && myTurn ? 'Your move - ' : '') + 'Kingside';

    // invite box
    const invite = $('#invite');
    invite.hidden = !(g.status === 'waiting' && mine);
    if (!invite.hidden) $('#invite-link').value = window.KINGSIDE.home() + '#/g/' + g.id;

    // moves
    renderMoves(g.moves);

    // controls
    const active = g.status === 'active';
    const offer = g.drawOffer;
    $('#btn-resign').hidden = !(active && mine);
    $('#btn-draw').hidden = !(active && mine && !offer);
    $('#draw-offered').hidden = !(active && mine && offer === g.color);
    $('#draw-prompt').hidden = !(active && mine && offer && offer !== g.color);

    const reviewBtn = $('#btn-review');
    const canReview = g.status === 'finished' && g.result !== '*' && g.moves.length >= 2;
    reviewBtn.hidden = !canReview;
    if (canReview) reviewBtn.href = '#/review/' + g.id;
    const pgnBtn = $('#btn-pgn-dl');
    pgnBtn.hidden = !canReview;
    if (canReview) {
      pgnBtn.href = window.KINGSIDE.url('/api/games/' + g.id + '/pgn');
      pgnBtn.setAttribute('download', 'kingside-' + g.id + '.pgn');
    }

    const rematchBtn = $('#btn-rematch');
    const canRematch = g.status === 'finished' && mine && g.white && g.black;
    rematchBtn.hidden = !canRematch;
    if (canRematch) {
      const iAsked = g.rematch.includes(g.color);
      const theyAsked = g.rematch.length > 0 && !iAsked;
      rematchBtn.disabled = iAsked;
      rematchBtn.textContent = iAsked ? 'Waiting for opponent…' : theyAsked ? 'Accept rematch' : 'Rematch';
    }

    // chat
    $('#chat-form').hidden = !mine;
    tick();
  }

  function fillPlayer(strip, color) {
    const g = game;
    const p = color === 'w' ? g.white : g.black;
    fillName($('.pname', strip), p, 'Waiting for opponent');
    $('.prating', strip).textContent = p && p.rating != null ? '(' + p.rating + ')' : '';
    $('.swatch', strip).className = 'swatch ' + color;
    $('.dot', strip).classList.toggle('on', !!g.online[color]);
    strip.classList.toggle('turn', g.status === 'active' && g.turn === color);
    $('.clock', strip).dataset.color = color;
  }

  function renderMoves(moves) {
    const box = $('#moves');
    box.textContent = '';
    for (let i = 0; i < moves.length; i += 2) {
      box.appendChild(el('span', 'n', (i / 2 + 1) + '.'));
      box.appendChild(el('span', 'm' + (i === moves.length - 1 ? ' latest' : ''), moves[i]));
      box.appendChild(el('span', 'm' + (i + 1 === moves.length - 1 ? ' latest' : ''), moves[i + 1] || ''));
    }
    box.scrollTop = box.scrollHeight;
  }

  /* ---------- clocks ---------- */
  function fmt(ms) {
    if (ms <= 0) return '0:00';
    if (ms < 10000) return '0:0' + (Math.floor(ms / 100) / 10).toFixed(1);
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function tick() {
    if (!game || $('#view-game').hidden) return;
    const elapsed = Date.now() - recvAt;
    for (const id of ['p-top', 'p-bottom']) {
      const clock = $('.clock', $('#' + id));
      const color = clock.dataset.color;
      if (!color) continue;
      let ms = game.clocks[color];
      const running = game.status === 'active' && game.running && game.turn === color;
      if (running) ms = Math.max(0, ms - elapsed);
      clock.textContent = fmt(ms);
      clock.classList.toggle('running', running);
      clock.classList.toggle('low', game.status === 'active' && ms < 30000 && game.running && game.turn === color);
    }
  }
  setInterval(tick, 100);

  /* ---------- moving pieces ---------- */
  function onSquareClick(sq) {
    const g = game;
    if (!g || g.status !== 'active' || !isPlayer() || pendingPromo) return;
    const myTurn = g.turn === g.color;
    if (!myTurn || !g.legal) return;

    if (selected && g.legal[selected] && g.legal[selected].includes(sq)) {
      attemptMove(selected, sq);
      return;
    }
    const p = curPos[sq];
    const isMine = p && ((p === p.toUpperCase()) === (g.color === 'w'));
    selected = isMine && g.legal[sq] && selected !== sq ? sq : null;
    renderGame();
  }

  function attemptMove(from, to) {
    const p = curPos[from];
    const lastRank = game.color === 'w' ? '8' : '1';
    if (p && p.toLowerCase() === 'p' && to[1] === lastRank) {
      pendingPromo = { from, to };
      showPromo();
      return;
    }
    selected = null;
    send({ t: 'move', from, to });
  }

  function showPromo() {
    const box = $('#promo');
    box.textContent = '';
    const inner = el('div', 'promo-inner');
    for (const piece of ['q', 'r', 'b', 'n']) {
      const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-label', { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[piece]);
      b.appendChild(pieceImg(game.color, piece));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const m = pendingPromo;
        pendingPromo = null;
        selected = null;
        box.hidden = true;
        if (m) send({ t: 'move', from: m.from, to: m.to, promotion: piece });
      });
      inner.appendChild(b);
    }
    box.appendChild(inner);
    box.hidden = false;
  }

  $('#promo').addEventListener('click', () => {
    pendingPromo = null;
    $('#promo').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pendingPromo) { pendingPromo = null; $('#promo').hidden = true; }
  });

  $('#board').addEventListener('click', (e) => {
    const sqEl = e.target.closest('.sq');
    if (sqEl) onSquareClick(sqEl.dataset.sq);
  });

  /* ---------- game controls ---------- */
  $('#btn-resign').addEventListener('click', () => {
    if (confirm('Resign this game?')) send({ t: 'resign' });
  });
  $('#btn-draw').addEventListener('click', () => send({ t: 'draw', action: 'offer' }));
  $('#btn-draw-accept').addEventListener('click', () => send({ t: 'draw', action: 'accept' }));
  $('#btn-draw-decline').addEventListener('click', () => send({ t: 'draw', action: 'decline' }));
  $('#btn-rematch').addEventListener('click', () => send({ t: 'rematch' }));
  $('#btn-lobby').addEventListener('click', () => { location.hash = '#/'; });

  $('#btn-copy').addEventListener('click', async () => {
    const input = $('#invite-link');
    try {
      await navigator.clipboard.writeText(input.value);
      toast('Link copied');
    } catch (e) {
      input.select();
      document.execCommand('copy');
      toast('Link copied');
    }
  });

  /* ---------- chat ---------- */
  function addChat(m) {
    const log = $('#chat-log');
    const mine = game && game.color === m.c;
    const row = el('div', 'chat-msg' + (mine ? ' me' : ''));
    row.appendChild(el('b', null, m.name));
    row.appendChild(document.createTextNode(m.text));
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    send({ t: 'chat', text });
    input.value = '';
  });

  /* ---------- lobby ---------- */
  function renderChips() {
    const wrap = $('#tc-chips');
    wrap.textContent = '';
    for (const { tc, label } of TIME_CONTROLS) {
      const b = el('button', 'chip');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(tc === chosenTc));
      b.disabled = !!seekingTc;
      b.appendChild(el('b', null, tc.replace('+', ' + ')));
      b.appendChild(el('small', null, label));
      b.addEventListener('click', () => {
        chosenTc = tc;
        store('tc', tc);
        renderChips();
      });
      wrap.appendChild(b);
    }
  }

  function renderSeek() {
    $('#seek-status').hidden = !seekingTc;
    $('#btn-seek').disabled = !!seekingTc;
    if (seekingTc) $('#seek-text').textContent = 'Looking for a ' + seekingTc.replace('+', ' + ') + ' opponent…';
    renderChips();
  }

  // Guests are asked to log in first, and the game they asked for starts as soon as they have.
  function needAccount(text) {
    if (routeGameId && !game) {
      $('#status').textContent = 'Log in to join this game';
      $('#status-sub').textContent = 'Log in or create a free account and you will join straight away.';
    }
    openAuth('signup', text || 'You need an account to play. It is free and takes a few seconds.');
  }

  $('#btn-seek').addEventListener('click', () => {
    if (!wsReady) return toast('Still connecting. Try again in a moment.');
    const tc = chosenTc;
    if (!user && !guestsAllowed) { afterLogin = () => send({ t: 'seek', tc }); return needAccount(); }
    send({ t: 'seek', tc });
  });
  $('#btn-cancel-seek').addEventListener('click', () => send({ t: 'cancelSeek' }));
  $('#btn-friend').addEventListener('click', () => {
    if (!wsReady) return toast('Still connecting. Try again in a moment.');
    const tc = chosenTc;
    const color = $('#friend-color').value;
    if (!user && !guestsAllowed) { afterLogin = () => send({ t: 'create', tc, color }); return needAccount(); }
    send({ t: 'create', tc, color });
  });

  /* ---------- account ---------- */
  function renderAccount() {
    // top bar
    const who = $('#who');
    who.textContent = '';
    if (user) {
      const nm = el('span', 'uname');
      fillName(nm, { name: user.username, title: user.title, reg: true });
      if (user.role) {
        const m = el('a', 'btn small', 'Moderation');
        m.href = '#/mod';
        who.appendChild(m);
      }
      who.appendChild(nm);
      const ur = el('span', 'urating', String(user.rating));
      ur.title = CAT_NAMES[user.main] + ' rating';
      who.appendChild(ur);
    } else {
      const b = el('button', 'btn small', 'Log in');
      b.type = 'button';
      b.addEventListener('click', () => openAuth('login'));
      who.appendChild(b);
    }

    $('#guest-note').textContent = user
      ? 'Random games are rated. Games with friends are casual.'
      : guestsAllowed
        ? 'You are playing as a guest. Log in to play rated games and get a rating.'
        : 'You need a free account to play. Log in or create one when you press a play button.';

    // account card
    const card = $('#account-card');
    card.textContent = '';
    if (!user) {
      card.appendChild(el('h2', null, 'Your account'));
      card.appendChild(el('p', null, 'You need an account to play. It is free, and it gives you a rating that moves after every rated game against a random opponent.'));
      const row = el('div', 'row');
      const login = el('button', 'btn primary', 'Log in');
      login.type = 'button';
      login.addEventListener('click', () => openAuth('login'));
      const signup = el('button', 'btn', 'Create account');
      signup.type = 'button';
      signup.addEventListener('click', () => openAuth('signup'));
      row.append(login, signup);
      card.appendChild(row);
      return;
    }
    const head = el('div', 'account-head');
    const accName = el('span', 'account-name');
    fillName(accName, { name: user.username, title: user.title, reg: true });
    head.appendChild(accName);
    card.appendChild(head);
    card.appendChild(ratingCards(user, false));
    const out = el('button', 'btn small', 'Log out');
    out.type = 'button';
    out.addEventListener('click', async () => {
      try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
      token = null;
      store('token', null);
      user = null;
      send({ t: 'hello', cid, token: null });
    });
    card.appendChild(out);
    const list = el('ol', 'recent');
    list.id = 'recent';
    list.setAttribute('aria-label', 'Recent games');
    card.appendChild(list);
  }

  // Three cards, one per category: the rating and (when `detailed`) the record in that category.
  function ratingCards(u, detailed) {
    const wrap = el('div', 'cat-cards' + (detailed ? '' : ' compact'));
    for (const c of ['bullet', 'blitz', 'rapid']) {
      const r = (u.ratings && u.ratings[c]) || { rating: 1200, games: 0, wins: 0, losses: 0, draws: 0 };
      const card = el('div', 'cat-card' + (r.games ? '' : ' unplayed'));
      card.dataset.cat = c;
      card.appendChild(el('span', 'cat-name', CAT_NAMES[c]));
      card.appendChild(el('b', 'cat-rating', String(r.rating)));
      card.appendChild(el('small', 'cat-games', r.games ? r.games + (r.games === 1 ? ' rated game' : ' rated games') : 'No rated games yet'));
      if (detailed && r.games) card.appendChild(el('small', 'cat-record', `${r.wins} won, ${r.losses} lost, ${r.draws} drawn`));
      wrap.appendChild(card);
    }
    return wrap;
  }

  // Bullet / Blitz / Rapid tabs above the top-players list.
  function renderLeaderTabs() {
    const wrap = $('#leader-tabs');
    wrap.textContent = '';
    for (const c of ['bullet', 'blitz', 'rapid']) {
      const b = el('button', 'btn small', CAT_NAMES[c]);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(c === leaderCat));
      b.addEventListener('click', () => {
        leaderCat = c;
        store('leaderCat', c);
        renderLeaderTabs();
        loadLeaders();
      });
      wrap.appendChild(b);
    }
  }

  async function loadLeaders() {
    const wanted = leaderCat;
    try {
      const { players } = await api('/api/leaderboard?cat=' + wanted);
      if (wanted !== leaderCat) return; // they switched tabs while this was loading
      const ol = $('#leaders');
      ol.textContent = '';
      players.forEach((p, i) => {
        const li = el('li');
        const nm = el('span');
        fillName(nm, { name: p.username, title: p.title, reg: true });
        li.append(el('span', 'rank', String(i + 1)), nm, el('span', 'rt', String(p.rating)));
        ol.appendChild(li);
      });
      const empty = $('#leaders-empty');
      empty.hidden = players.length > 0;
      empty.textContent = 'No rated ' + wanted + ' games yet. Log in and play a random opponent to get on the board.';
    } catch (e) { /* offline */ }
  }

  async function loadAccountData() {
    if ($('#view-lobby').hidden) return;
    await loadLeaders();

    if (user) {
      try {
        const [{ user: fresh }, { games }] = await Promise.all([api('/api/me'), api('/api/me/games')]);
        user = fresh;
        const oldCards = $('#account-card .cat-cards');
        if (oldCards) oldCards.replaceWith(ratingCards(fresh, false));
        const urating = $('#who .urating');
        if (urating) { urating.textContent = String(fresh.rating); urating.title = CAT_NAMES[fresh.main] + ' rating'; }
        const list = $('#recent');
        if (list) {
          list.textContent = '';
          games.slice(0, 6).forEach((g) => {
            const white = g.white_id === user.id;
            const opp = white ? g.black_name : g.white_name;
            const score = g.result === '1/2-1/2' ? 'draw' : (g.result === '1-0') === white ? 'win' : 'loss';
            const delta = white ? g.white_delta : g.black_delta;
            const li = el('li');
            li.appendChild(el('span', 'res ' + score, score === 'win' ? 'W' : score === 'loss' ? 'L' : 'D'));
            li.appendChild(el('span', 'grow', 'vs ' + opp + ' (' + g.tc.replace('+', ' + ') + ')'));
            if (delta != null) li.appendChild(el('span', 'delta', (delta > 0 ? '+' : '') + delta));
            const rv = el('a', 'plink review-link', 'Review');
            rv.href = '#/review/' + g.id;
            li.appendChild(rv);
            list.appendChild(li);
          });
        }
      } catch (e) { /* ignore */ }
    }
  }

  /* ---------- profile ---------- */
  async function loadProfile(name) {
    const box = $('#profile');
    box.textContent = '';
    box.appendChild(el('p', 'hint', 'Loading profile…'));
    document.title = name + ' - Kingside';
    let data;
    try {
      data = await api('/api/users/' + encodeURIComponent(name));
    } catch (e) {
      const r = parseRoute();
      if (r.type !== 'user' || r.name !== name) return;
      box.textContent = '';
      box.appendChild(el('h1', null, 'Player not found'));
      box.appendChild(el('p', 'lede', 'There is no player called ' + name + '.'));
      const back = el('a', 'btn', 'Back to lobby');
      back.href = '#/';
      box.appendChild(back);
      return;
    }
    const r = parseRoute();
    if (r.type !== 'user' || r.name.toLowerCase() !== name.toLowerCase()) return;
    renderProfile(data.user, data.games, data.mod);
  }

  function fmtUntil(until) {
    return until ? 'until ' + new Date(until).toLocaleString() : 'permanently';
  }

  async function modAction(path, body, done) {
    try {
      await api(path, { method: 'POST', body });
      toast('Done');
      done();
    } catch (err) {
      toast(err.message);
    }
  }

  function renderModCard(u, mod) {
    const card = el('section', 'card mod-card');
    card.appendChild(el('h2', null, 'Moderation'));
    if (mod.ban) {
      card.appendChild(el('p', 'bio', 'Banned ' + fmtUntil(mod.ban.until) + ' by ' + mod.ban.by + '. Reason: ' + mod.ban.reason));
    }
    if (mod.canUnban) {
      const b = el('button', 'btn small', 'Lift ban');
      b.type = 'button';
      b.addEventListener('click', () => modAction('/api/mod/unban', { username: u.username }, () => loadProfile(u.username)));
      card.appendChild(b);
    }
    if (mod.canBan) {
      const form = el('form', 'ban-form');
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Ban length');
      for (const [label, hours] of [['1 hour', 1], ['1 day', 24], ['1 week', 168], ['30 days', 720], ['Permanent', null]]) {
        const o = document.createElement('option');
        o.textContent = label;
        o.value = hours === null ? 'perm' : String(hours);
        sel.appendChild(o);
      }
      const reason = document.createElement('input');
      reason.type = 'text';
      reason.maxLength = 200;
      reason.required = true;
      reason.placeholder = 'Reason (the player will see this)';
      reason.setAttribute('aria-label', 'Reason');
      const go = el('button', 'btn small danger', 'Ban ' + u.username);
      go.type = 'submit';
      form.append(sel, reason, go);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!confirm('Ban ' + u.username + ' (' + sel.options[sel.selectedIndex].text + ')?')) return;
        modAction('/api/mod/ban', { username: u.username, hours: sel.value === 'perm' ? null : Number(sel.value), reason: reason.value }, () => loadProfile(u.username));
      });
      card.appendChild(form);
    }
    if (mod.canSetMod) {
      const isMod = u.role === 'mod';
      const b = el('button', 'btn small', isMod ? 'Remove moderator' : 'Make moderator');
      b.type = 'button';
      b.addEventListener('click', () => modAction('/api/owner/mod', { username: u.username, mod: !isMod }, () => loadProfile(u.username)));
      card.appendChild(b);
    }
    if (!mod.canBan && !mod.canUnban && !mod.canSetMod && !mod.ban) {
      card.appendChild(el('p', 'hint', 'No moderation actions are available for this player.'));
    }
    return card;
  }

  function renderProfile(u, games, mod) {
    const box = $('#profile');
    box.textContent = '';
    document.title = u.username + ' - Kingside';
    const own = !!user && user.id === u.id;

    const head = el('div', 'profile-head');
    const h = el('h1', 'profile-name');
    if (u.title) h.appendChild(el('span', 'title big', u.title));
    h.appendChild(document.createTextNode(u.username));
    if (u.role) h.appendChild(el('span', 'role-tag', u.role === 'owner' ? 'Owner' : 'Moderator'));
    if (u.banned) h.appendChild(el('span', 'ban-tag', 'Banned'));
    head.appendChild(h);
    box.appendChild(head);

    const since = new Date(u.created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    box.appendChild(el('p', 'hint', 'Member since ' + since));

    box.appendChild(ratingCards(u, true));

    const about = el('section', 'card profile-about');
    about.appendChild(el('h2', null, own ? 'About you' : 'About'));
    if (own) {
      const form = el('form', 'bio-form');
      const ta = document.createElement('textarea');
      ta.maxLength = 200;
      ta.rows = 3;
      ta.value = u.bio || '';
      ta.placeholder = 'Tell people a little about yourself';
      ta.setAttribute('aria-label', 'Bio');
      const row = el('div', 'row');
      const save = el('button', 'btn small primary', 'Save');
      save.type = 'submit';
      const msg = el('span', 'note');
      msg.setAttribute('role', 'status');
      row.append(save, msg);
      form.append(ta, row);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        msg.textContent = '';
        try {
          const res = await api('/api/me/profile', { method: 'POST', body: { bio: ta.value } });
          user = res.user;
          msg.textContent = 'Saved';
        } catch (err) {
          msg.textContent = err.message;
        }
      });
      about.appendChild(form);
    } else {
      about.appendChild(el('p', u.bio ? 'bio' : 'hint', u.bio || 'No bio yet.'));
    }
    box.appendChild(about);
    if (mod) box.appendChild(renderModCard(u, mod));

    const recent = el('section', 'card');
    recent.appendChild(el('h2', null, 'Recent games'));
    if (!games.length) {
      recent.appendChild(el('p', 'hint', 'No finished games yet.'));
    } else {
      const list = el('ol', 'recent');
      games.forEach((g) => {
        const white = g.white_id === u.id;
        const oppName = white ? g.black_name : g.white_name;
        const oppId = white ? g.black_id : g.white_id;
        const score = g.result === '1/2-1/2' ? 'draw' : (g.result === '1-0') === white ? 'win' : 'loss';
        const delta = white ? g.white_delta : g.black_delta;
        const li = el('li');
        li.appendChild(el('span', 'res ' + score, score === 'win' ? 'W' : score === 'loss' ? 'L' : 'D'));
        const who = el('span', 'grow');
        who.textContent = 'vs ';
        if (oppId) {
          const a = el('a', 'plink', oppName);
          a.href = '#/u/' + encodeURIComponent(oppName);
          who.appendChild(a);
        } else {
          who.appendChild(document.createTextNode(oppName));
        }
        who.appendChild(document.createTextNode(' (' + g.tc.replace('+', ' + ') + ')'));
        li.appendChild(who);
        if (delta != null) li.appendChild(el('span', 'delta', (delta > 0 ? '+' : '') + delta));
        li.appendChild(el('span', 'delta', new Date(g.ended_at).toLocaleDateString()));
        const rv = el('a', 'plink review-link', 'Review');
        rv.href = '#/review/' + g.id;
        li.appendChild(rv);
        list.appendChild(li);
      });
      recent.appendChild(list);
    }
    box.appendChild(recent);
  }

  /* ---------- moderation page ---------- */
  async function loadMod() {
    const box = $('#mod');
    box.textContent = '';
    document.title = 'Moderation - Kingside';
    let data;
    try {
      data = await api('/api/mod/overview');
    } catch (e) {
      box.appendChild(el('h1', null, 'Moderators only'));
      box.appendChild(el('p', 'lede', 'Log in with a moderator account to see this page.'));
      const back = el('a', 'btn', 'Back to lobby');
      back.href = '#/';
      box.appendChild(back);
      return;
    }
    box.appendChild(el('h1', null, 'Moderation'));

    const find = el('form', 'ban-form');
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'Find a player by username';
    inp.setAttribute('aria-label', 'Username');
    inp.pattern = '[A-Za-z0-9_]{3,16}';
    inp.required = true;
    const go = el('button', 'btn small primary', 'Open profile');
    go.type = 'submit';
    find.append(inp, go);
    find.addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/u/' + encodeURIComponent(inp.value.trim()); });
    box.appendChild(find);

    const bans = el('section', 'card');
    bans.appendChild(el('h2', null, 'Current bans'));
    if (!data.bans.length) bans.appendChild(el('p', 'hint', 'Nobody is banned right now.'));
    else {
      const list = el('ul', 'modlist');
      for (const b of data.bans) {
        const li = el('li');
        const a = el('a', 'plink', b.username);
        a.href = '#/u/' + encodeURIComponent(b.username);
        li.appendChild(a);
        li.appendChild(el('span', 'grow', fmtUntil(b.until) + ' by ' + b.by + ': ' + b.reason));
        if (b.canUnban) {
          const u = el('button', 'btn small', 'Lift');
          u.type = 'button';
          u.addEventListener('click', () => modAction('/api/mod/unban', { username: b.username }, loadMod));
          li.appendChild(u);
        }
        list.appendChild(li);
      }
      bans.appendChild(list);
    }
    box.appendChild(bans);

    const staff = el('section', 'card');
    staff.appendChild(el('h2', null, 'Staff'));
    const sl = el('ul', 'modlist');
    for (const s of data.staff) {
      const li = el('li');
      const a = el('a', 'plink', s.username);
      a.href = '#/u/' + encodeURIComponent(s.username);
      li.append(a, el('span', 'grow', s.role === 'owner' ? 'Owner' : 'Moderator'));
      sl.appendChild(li);
    }
    staff.appendChild(sl);
    if (data.you === 'owner') staff.appendChild(el('p', 'hint', 'To make someone a moderator, open their profile and choose "Make moderator".'));
    box.appendChild(staff);

    const log = el('section', 'card');
    log.appendChild(el('h2', null, 'Recent actions'));
    if (!data.log.length) log.appendChild(el('p', 'hint', 'Nothing yet.'));
    else {
      const ll = el('ul', 'modlist');
      for (const l of data.log) {
        const li = el('li');
        li.appendChild(el('span', 'grow', l.actor + ' ' + l.action + ' ' + l.target + (l.detail ? ' (' + l.detail + ')' : '')));
        li.appendChild(el('span', 'delta', new Date(l.at).toLocaleString()));
        ll.appendChild(li);
      }
      log.appendChild(ll);
    }
    box.appendChild(log);
  }

  /* ---------- auth dialog ---------- */
  let authMode = 'login';
  function openAuth(mode, note) {
    authMode = mode;
    $('#auth-note').textContent = note || '';
    $('#auth-note').hidden = !note;
    const signup = mode === 'signup';
    $('#auth-title').textContent = signup ? 'Create an account' : 'Log in';
    $('#auth-submit').textContent = signup ? 'Create account' : 'Log in';
    $('#auth-switch-text').textContent = signup ? 'Already have an account?' : 'New here?';
    $('#auth-switch').textContent = signup ? 'Log in' : 'Create an account';
    $('#auth-pass').autocomplete = signup ? 'new-password' : 'current-password';
    $('#auth-error').textContent = '';
    const dlg = $('#auth');
    if (!dlg.open) dlg.showModal();
    $('#auth-user').focus();
  }

  $('#auth-switch').addEventListener('click', () => openAuth(authMode === 'login' ? 'signup' : 'login'));
  $('#auth-cancel').addEventListener('click', () => $('#auth').close());
  // If the box is closed without logging in, forget what the guest was trying to do.
  $('#auth').addEventListener('close', () => { if (!user) afterLogin = null; });
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { username: $('#auth-user').value.trim(), password: $('#auth-pass').value };
    $('#auth-error').textContent = '';
    try {
      const r = await api(authMode === 'signup' ? '/api/signup' : '/api/login', { method: 'POST', body });
      token = r.token;
      store('token', token);
      user = r.user;
      $('#auth-pass').value = '';
      $('#auth').close();
      send({ t: 'hello', cid, token });
      renderAccount();
      loadAccountData();
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  });

  /* ---------- Play button ---------- */
  $('#btn-play').addEventListener('click', (e) => {
    if (parseRoute().type === 'lobby') {
      // Already at the lobby: just point at the buttons that start a game.
      e.preventDefault();
      $('#btn-seek').scrollIntoView({ block: 'center' });
      $('#btn-seek').focus();
      return;
    }
    if (game && game.status === 'active' && isPlayer() && !confirm('Leave this game? Your clock keeps running while you are away.')) {
      e.preventDefault();
    }
  });

  /* ---------- player search ---------- */
  (function setupFinder() {
    const input = $('#finder-input');
    const list = $('#finder-results');
    let active = -1;
    let seq = 0;
    let timer = null;

    function close() {
      list.hidden = true;
      list.textContent = '';
      active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function setActive(i) {
      active = i;
      [...list.children].forEach((li, n) => {
        const on = n === i && !!li.dataset.name;
        li.classList.toggle('active', on);
        li.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      const cur = list.children[i];
      if (cur && cur.id) input.setAttribute('aria-activedescendant', cur.id);
      else input.removeAttribute('aria-activedescendant');
    }

    function openProfile(name) {
      close();
      input.value = '';
      input.blur();
      location.hash = '#/u/' + encodeURIComponent(name);
    }

    function render(players, term) {
      list.textContent = '';
      if (!players.length) {
        list.appendChild(el('li', 'finder-empty', 'No player matches “' + term + '”'));
      }
      players.forEach((p, i) => {
        const li = el('li', 'finder-item');
        li.id = 'finder-opt-' + i;
        li.setAttribute('role', 'option');
        li.dataset.name = p.username;
        if (p.title) li.appendChild(el('span', 'title', p.title));
        li.appendChild(el('span', 'finder-name', p.username));
        li.appendChild(el('span', 'finder-rating', String(p.rating)));
        li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the box
        li.addEventListener('click', () => openProfile(p.username));
        li.addEventListener('mousemove', () => { if (active !== i) setActive(i); });
        list.appendChild(li);
      });
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      setActive(players.length ? 0 : -1);
    }

    async function search() {
      const term = input.value.trim();
      const mine = ++seq;
      try {
        const res = await fetch(window.KINGSIDE.url('/api/players/search?q=') + encodeURIComponent(term));
        const data = await res.json();
        if (mine !== seq || document.activeElement !== input) return; // a newer search or a blur happened
        render(data.players || [], term);
      } catch (e) {
        if (mine === seq) close();
      }
    }

    input.addEventListener('input', () => {
      clearTimeout(timer);
      seq++;
      const term = input.value.trim();
      if (term.length < 2) { close(); return; }
      timer = setTimeout(search, 150);
    });

    input.addEventListener('keydown', (e) => {
      const n = list.querySelectorAll('.finder-item').length;
      if (e.key === 'ArrowDown' && n) { e.preventDefault(); setActive((active + 1) % n); }
      else if (e.key === 'ArrowUp' && n) { e.preventDefault(); setActive((active - 1 + n) % n); }
      else if (e.key === 'Escape') { if (!list.hidden) close(); else input.blur(); }
    });

    $('#finder-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const cur = list.children[active];
      if (cur && cur.dataset.name) openProfile(cur.dataset.name);
    });

    input.addEventListener('blur', () => { clearTimeout(timer); seq++; setTimeout(close, 120); });
  })();

  /* ---------- start ---------- */
  drawBoard($('#preview'), parseFen(START_FEN), 'w');
  renderLeaderTabs();
  renderChips();
  renderAccount();
  renderSeek();
  route(false);
  connect();
})();
