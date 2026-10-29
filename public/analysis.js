/* Game analysis with Stockfish, running entirely in the visitor's browser.
   Used by the "Analyse PGN" button and by "Review game" on finished games. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const MATE_V = 10000;          // stand-in centipawn value for a forced mate
  const LIVE_DEPTH = 18;         // depth for the top lines shown while you browse
  const DEPTHS = [[12, 'Quick'], [16, 'Standard'], [20, 'Deep']];
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const CLASS_LABEL = { best: 'Best', good: 'Good', inaccuracy: 'Inaccuracies', mistake: 'Mistakes', blunder: 'Blunders' };
  const TAG = { best: '✓', inaccuracy: '?!', mistake: '?', blunder: '??' };

  let Chess = null;
  async function loadChess() {
    if (!Chess) Chess = (await import(window.KINGSIDE.localEngine ? window.KINGSIDE.localEngine.chessModule : window.KINGSIDE.url('/vendor/chess.js'))).Chess;
    return Chess;
  }

  /* ---------------- reading games ---------------- */
  function firstGame(text) {
    const t = String(text).replace(/\r\n?/g, '\n').trim();
    const starts = [...t.matchAll(/^\[Event\s/gm)].map((m) => m.index);
    if (starts.length > 1) return { text: t.slice(starts[0], starts[1]).trim(), several: true };
    return { text: t, several: false };
  }

  function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function buildGame(c0, extra) {
    const hist = c0.history({ verbose: true });
    if (!hist.length) throw new Error('No moves found in that PGN.');
    const moves = hist.map((m) => ({ san: m.san, from: m.from, to: m.to, uci: m.from + m.to + (m.promotion || '') }));
    const fens = [hist[0].before, ...hist.map((m) => m.after)];
    const last = new Chess(fens[fens.length - 1]);
    let end = null;
    if (last.isCheckmate()) end = 'mate';
    else if (last.isStalemate() || last.isInsufficientMaterial()) end = 'draw';
    return { moves, fens, end, ...extra };
  }

  async function gameFromPgn(text) {
    await loadChess();
    const { text: one, several } = firstGame(text);
    const c = new Chess();
    try { c.loadPgn(one); } catch (e) {
      throw new Error(String(e.message || e).split('\n')[0].replace(/^Invalid move in PGN: /, 'That PGN has a move that is not legal: ') || 'That does not look like a PGN.');
    }
    const h = c.header();
    const nm = (v, d) => (v && v !== '?' ? v : d);
    const key = 'pgn-' + hashString(c.history({ verbose: true })[0]?.before + c.history().join(' '));
    return buildGame(c, {
      kind: 'pgn', key, several,
      title: 'PGN analysis',
      white: { name: nm(h.White, 'White'), rating: nm(h.WhiteElo, ''), title: nm(h.WhiteTitle, '') },
      black: { name: nm(h.Black, 'Black'), rating: nm(h.BlackElo, ''), title: nm(h.BlackTitle, '') },
      result: nm(h.Result, ''), sub: [nm(h.Event, ''), nm(h.Date, '').replace(/\.\?\?/g, '')].filter(Boolean).join(' · '),
    });
  }

  async function gameFromApi(id) {
    await loadChess();
    const res = await fetch(window.KINGSIDE.url('/api/games/' + encodeURIComponent(id)));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load that game.');
    const g = data.game;
    const c = new Chess();
    for (const san of g.moves) c.move(san);
    const reasonText = g.result === '1/2-1/2' ? 'Draw by ' + g.reason : g.result === '*' ? 'Aborted' : (g.result === '1-0' ? 'White' : 'Black') + ' won by ' + g.reason;
    return buildGame(c, {
      kind: 'game', key: 'game-' + g.id, id: g.id, title: 'Game review',
      white: { name: g.white.name, title: g.white.title, reg: g.white.reg },
      black: { name: g.black.name, title: g.black.title, reg: g.black.reg },
      result: g.result, sub: reasonText + ' · ' + g.tc.replace('+', ' + '), pgn: g.pgn || '',
    });
  }

  /* ---------------- the engine ---------------- */
  function createEngine(info) {
    const worker = new Worker(info.script);
    const listeners = new Set();
    let idName = '';
    let multipv = 1;
    let chain = Promise.resolve();
    let searching = false;
    let dead = null;

    worker.onmessage = (e) => {
      for (const raw of String(e.data).split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('id name ')) idName = line.slice(8);
        for (const f of [...listeners]) f(line);
      }
    };
    worker.onerror = (e) => {
      dead = new Error('The engine stopped working' + (e && e.message ? ' (' + e.message + ')' : '') + '.');
      for (const f of [...listeners]) f(null);
    };
    const send = (c) => worker.postMessage(c);

    function waitFor(test, ms) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { listeners.delete(f); reject(new Error('The engine did not respond.')); }, ms || 30000);
        const f = (line) => {
          if (line === null) { clearTimeout(t); listeners.delete(f); reject(dead); return; }
          if (test(line)) { clearTimeout(t); listeners.delete(f); resolve(line); }
        };
        listeners.add(f);
      });
    }

    async function init() {
      send('uci');
      await waitFor((l) => l === 'uciok');
      send('setoption name Hash value 32');
      send('isready');
      await waitFor((l) => l === 'readyok');
    }

    function parseInfo(l) {
      if (!l.startsWith('info ') || / (lowerbound|upperbound)\b/.test(l)) return null;
      const s = / score (cp|mate) (-?\d+)/.exec(l);
      const p = / pv (.+)$/.exec(l);
      const d = /\bdepth (\d+)/.exec(l);
      if (!s || !p || !d) return null;
      const m = /\bmultipv (\d+)/.exec(l);
      return { mpv: m ? Number(m[1]) : 1, depth: Number(d[1]), kind: s[1], val: Number(s[2]), pv: p[1].trim().split(/\s+/) };
    }

    // One search at a time. Resolves with the best move and the lines found so far.
    function analyse(fen, opts) {
      const { depth = 14, lines = 1, onInfo } = opts || {};
      const run = () => {
        if (dead) return Promise.reject(dead);
        if (lines !== multipv) { send('setoption name MultiPV value ' + lines); multipv = lines; }
        send('position fen ' + fen);
        const res = { lines: [], best: null };
        const done = new Promise((resolve, reject) => {
          const f = (line) => {
            if (line === null) { listeners.delete(f); searching = false; reject(dead); return; }
            if (line.startsWith('bestmove')) {
              listeners.delete(f);
              searching = false;
              res.best = (line.split(/\s+/)[1] || '').replace('(none)', '') || null;
              resolve(res);
              return;
            }
            const inf = parseInfo(line);
            if (inf) { res.lines[inf.mpv - 1] = inf; if (onInfo) onInfo(res); }
          };
          listeners.add(f);
        });
        searching = true;
        send('go depth ' + depth);
        return done;
      };
      const p = chain.then(run, run);
      chain = p.catch(() => {});
      return p;
    }

    return {
      init, analyse,
      stop() { if (searching) send('stop'); },
      terminate() { try { worker.terminate(); } catch (e) { /* already gone */ } listeners.clear(); },
      get name() { return idName; },
    };
  }

  /* ---------------- evaluation helpers ---------------- */
  const stmOf = (fen) => fen.split(' ')[1];
  const wp = (v) => {
    const c = Math.max(-1000, Math.min(1000, v));
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
  };

  // `res` came from the engine for the position `fen`; make the score white's point of view.
  function toEval(res, fen) {
    const l = res.lines[0];
    if (!l) return null;
    const sgn = stmOf(fen) === 'w' ? 1 : -1;
    const v = l.kind === 'mate' ? sgn * Math.sign(l.val) * (MATE_V - Math.abs(l.val)) : sgn * l.val;
    return { v, m: l.kind === 'mate' ? sgn * l.val : null, best: res.best || l.pv[0], pv: l.pv.slice(0, 10), depth: l.depth };
  }

  function lineEval(l, fen) {
    const sgn = stmOf(fen) === 'w' ? 1 : -1;
    return { v: l.kind === 'mate' ? sgn * Math.sign(l.val) * (MATE_V - Math.abs(l.val)) : sgn * l.val, m: l.kind === 'mate' ? sgn * l.val : null };
  }

  function fmtEval(ev) {
    if (!ev) return '…';
    if (ev.end) return ev.end;
    if (ev.m !== null && ev.m !== undefined) return (ev.m > 0 ? '+' : '−') + 'M' + Math.abs(ev.m);
    const x = ev.v / 100;
    return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1);
  }

  function pvToSan(fen, pv, max) {
    const c = new Chess(fen);
    let num = parseInt(fen.split(' ')[5], 10) || 1;
    let white = stmOf(fen) === 'w';
    const out = [];
    for (let k = 0; k < Math.min(pv.length, max || 8); k++) {
      const u = pv[k];
      let m;
      try { m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch (e) { break; }
      out.push(white ? num + '. ' + m.san : (k === 0 ? num + '... ' : '') + m.san);
      if (!white) num++;
      white = !white;
    }
    return out.join(' ');
  }

  /* ---------------- state ---------------- */
  let session = 0;          // bumped whenever the page is shown or hidden; stale async work checks it
  let engineInfo = null;
  let engine = null;
  let S = null;             // everything about the game being viewed
  let pendingPgn = null;
  let liveTimer = null;
  let liveToken = 0;
  let runToken = 0;
  let active = false;

  function fenSquares(fen) {
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

  /* ---------------- building the page ---------------- */
  function root() { return $('#analysis'); }

  function message(title, text, withButton) {
    const box = root();
    box.textContent = '';
    box.appendChild(el('h1', null, title));
    if (text) box.appendChild(el('p', 'lede', text));
    if (withButton) {
      const b = el('button', 'btn primary', 'Analyse a PGN');
      b.type = 'button';
      b.addEventListener('click', openDialog);
      box.appendChild(b);
    }
  }

  function build() {
    const g = S.game;
    const box = root();
    box.textContent = '';

    const head = el('div', 'an-head');
    const titles = el('div');
    titles.appendChild(el('h1', null, g.title));
    titles.appendChild(el('p', 'hint', [g.sub].filter(Boolean).join('')));
    head.appendChild(titles);

    const actions = el('div', 'an-actions');
    if (g.kind === 'game') {
      const back = el('a', 'btn small', 'Back to game');
      back.href = '#/g/' + g.id;
      actions.appendChild(back);
    }
    const sel = document.createElement('select');
    sel.id = 'an-depth';
    sel.setAttribute('aria-label', 'Analysis depth');
    for (const [d, label] of DEPTHS) {
      const o = document.createElement('option');
      o.value = String(d);
      o.textContent = label + ' (depth ' + d + ')';
      if (d === S.depth) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { S.depth = Number(sel.value); startAnalysis(true); });
    actions.appendChild(sel);
    const redo = el('button', 'btn small', 'Analyse again');
    redo.id = 'an-redo';
    redo.type = 'button';
    redo.addEventListener('click', () => startAnalysis(true));
    actions.appendChild(redo);
    const another = el('button', 'btn small', 'Analyse a PGN');
    another.type = 'button';
    another.addEventListener('click', openDialog);
    actions.appendChild(another);
    head.appendChild(actions);
    box.appendChild(head);

    const main = el('div', 'an-main');

    // board column
    const col = el('div', 'an-boardcol');
    const top = el('div', 'an-player');
    top.id = 'an-top';
    const bottom = el('div', 'an-player');
    bottom.id = 'an-bottom';
    const row = el('div', 'an-boardrow');
    const bar = el('div', 'evalbar');
    bar.id = 'an-bar';
    bar.setAttribute('role', 'img');
    bar.appendChild(el('div', 'evalbar-fill'));
    bar.appendChild(el('span', 'evalbar-label'));
    row.appendChild(bar);
    const wrap = el('div', 'an-boardwrap');
    const board = el('div', 'board');
    board.id = 'an-board';
    wrap.appendChild(board);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 8 8');
    svg.setAttribute('class', 'an-arrows');
    svg.id = 'an-arrows';
    svg.setAttribute('aria-hidden', 'true');
    wrap.appendChild(svg);
    row.appendChild(wrap);
    const nav = el('div', 'an-nav');
    for (const [id, label, aria] of [['first', '⏮', 'First position'], ['prev', '◀', 'Previous move'], ['next', '▶', 'Next move'], ['last', '⏭', 'Last position']]) {
      const b = el('button', 'btn small', label);
      b.type = 'button';
      b.id = 'an-' + id;
      b.setAttribute('aria-label', aria);
      b.addEventListener('click', () => go(id));
      nav.appendChild(b);
    }
    const flip = el('button', 'btn small', 'Flip board');
    flip.type = 'button';
    flip.id = 'an-flip';
    flip.addEventListener('click', () => { S.flipped = !S.flipped; renderPly(); });
    nav.appendChild(flip);
    col.append(top, row, bottom, nav);
    main.appendChild(col);

    // side column
    const side = el('div', 'an-side');
    const status = el('div', 'an-status');
    status.id = 'an-status';
    status.setAttribute('aria-live', 'polite');
    status.appendChild(el('div', 'an-status-text'));
    const prog = el('div', 'an-progress');
    prog.appendChild(el('span'));
    prog.setAttribute('role', 'progressbar');
    prog.setAttribute('aria-valuemin', '0');
    prog.setAttribute('aria-valuemax', '100');
    status.appendChild(prog);
    side.appendChild(status);

    const sum = el('div', 'an-summary');
    sum.id = 'an-summary';
    side.appendChild(sum);

    const graph = el('div', 'an-graph');
    graph.id = 'an-graph';
    side.appendChild(graph);

    const lines = el('div', 'an-lines');
    lines.id = 'an-lines';
    side.appendChild(lines);

    const moves = el('div', 'an-moves');
    moves.id = 'an-moves';
    moves.setAttribute('role', 'list');
    for (let i = 0; i < g.moves.length; i += 2) {
      moves.appendChild(el('span', 'an-num', i / 2 + 1 + '.'));
      for (const ply of [i + 1, i + 2]) {
        if (ply > g.moves.length) { moves.appendChild(el('span')); continue; }
        const b = el('button', 'an-move');
        b.type = 'button';
        b.dataset.ply = String(ply);
        b.appendChild(el('span', 'an-san', g.moves[ply - 1].san));
        b.appendChild(el('span', 'an-tag'));
        b.appendChild(el('span', 'an-ev'));
        b.addEventListener('click', () => setPly(ply));
        moves.appendChild(b);
      }
    }
    side.appendChild(moves);

    const how = document.createElement('details');
    how.className = 'an-how';
    how.appendChild(el('summary', null, 'How are moves labelled?'));
    how.appendChild(el('p', 'hint', 'Each move is compared with what Stockfish thought was best. A drop in your winning chances of 5 to 10 points is an inaccuracy (?!), 10 to 20 a mistake (?), and 20 or more a blunder (??). A move Stockfish picked itself is marked ✓. Accuracy is an estimate based on how much winning chance each move gave up.'));
    side.appendChild(how);

    main.appendChild(side);
    box.appendChild(main);
    if (g.pgn) box.appendChild(pgnCard(g));
  }

  // The game as PGN text: copy it, or save it as a .pgn file.
  function pgnCard(g) {
    const card = el('section', 'card an-pgn');
    card.appendChild(el('h2', null, 'PGN'));
    card.appendChild(el('p', 'hint', 'A text record of this game. Paste it into any chess program or analysis site to open it there, or save it as a file.'));
    const ta = document.createElement('textarea');
    ta.id = 'an-pgn-text';
    ta.readOnly = true;
    ta.spellcheck = false;
    ta.rows = Math.min(14, g.pgn.split('\n').length);
    ta.value = g.pgn;
    ta.setAttribute('aria-label', 'PGN of this game');
    ta.addEventListener('focus', () => ta.select());
    card.appendChild(ta);

    const row = el('div', 'row');
    const copy = el('button', 'btn small primary', 'Copy PGN');
    copy.id = 'an-pgn-copy';
    copy.type = 'button';
    let timer = null;
    copy.addEventListener('click', async () => {
      let ok = true;
      try { await navigator.clipboard.writeText(g.pgn); } catch (e) {
        ta.select();
        try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      }
      copy.textContent = ok ? 'Copied' : 'Press Ctrl+C to copy';
      clearTimeout(timer);
      timer = setTimeout(() => { copy.textContent = 'Copy PGN'; }, 2500);
    });
    const dl = el('a', 'btn small', 'Download .pgn');
    dl.id = 'an-pgn-download';
    dl.href = window.KINGSIDE.url('/api/games/' + encodeURIComponent(g.id) + '/pgn');
    dl.setAttribute('download', 'kingside-' + g.id + '.pgn');
    row.append(copy, dl);
    card.appendChild(row);
    return card;
  }

  /* ---------------- drawing ---------------- */
  function drawBoard() {
    const g = S.game;
    const fen = g.fens[S.ply];
    const pos = fenSquares(fen);
    const ori = S.flipped ? 'b' : 'w';
    const last = S.ply > 0 ? [g.moves[S.ply - 1].from, g.moves[S.ply - 1].to] : [];
    let checkSq = null;
    if (new Chess(fen).inCheck()) {
      const king = stmOf(fen) === 'w' ? 'K' : 'k';
      checkSq = Object.keys(pos).find((s) => pos[s] === king) || null;
    }
    const files = 'abcdefgh';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 64; i++) {
      const rw = Math.floor(i / 8);
      const cl = i % 8;
      const f = ori === 'w' ? cl : 7 - cl;
      const r = ori === 'w' ? 7 - rw : rw;
      const sq = files[f] + (r + 1);
      const d = document.createElement('div');
      d.className = 'sq ' + ((f + r) % 2 === 0 ? 'dark' : 'light');
      d.dataset.sq = sq;
      if (rw === 7) d.dataset.file = files[f];
      if (cl === 0) d.dataset.rank = String(r + 1);
      if (last.includes(sq)) d.classList.add('last');
      if (checkSq === sq) d.classList.add('check');
      const p = pos[sq];
      if (p) {
        const img = document.createElement('img');
        img.className = 'pc';
        img.src = 'pieces/' + (p === p.toUpperCase() ? 'w' : 'b') + p.toUpperCase() + '.svg';
        img.alt = '';
        img.draggable = false;
        d.appendChild(img);
      }
      frag.appendChild(d);
    }
    const board = $('#an-board');
    board.textContent = '';
    board.appendChild(frag);
  }

  function drawArrow() {
    const svg = $('#an-arrows');
    svg.textContent = '';
    const ev = S.evals[S.ply];
    const u = ev && ev.best;
    if (!u || u.length < 4) return;
    const pt = (sq) => {
      const f = sq.charCodeAt(0) - 97;
      const r = Number(sq[1]) - 1;
      return S.flipped ? [7 - f + 0.5, r + 0.5] : [f + 0.5, 7 - r + 0.5];
    };
    const [x1, y1] = pt(u.slice(0, 2));
    const [x2, y2] = pt(u.slice(2, 4));
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (!len) return;
    const ux = dx / len;
    const uy = dy / len;
    const head = 0.42;
    const ns = 'http://www.w3.org/2000/svg';
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2 - ux * head * 0.8);
    line.setAttribute('y2', y2 - uy * head * 0.8);
    line.setAttribute('stroke-width', '0.17');
    line.setAttribute('stroke-linecap', 'round');
    const tri = document.createElementNS(ns, 'polygon');
    const bx = x2 - ux * head;
    const by = y2 - uy * head;
    tri.setAttribute('points', [x2, y2, bx - uy * 0.24, by + ux * 0.24, bx + uy * 0.24, by - ux * 0.24].join(' '));
    for (const n of [line, tri]) { n.setAttribute('class', 'an-arrow'); svg.appendChild(n); }
  }

  function playerStrip(id, color) {
    const g = S.game;
    const p = color === 'w' ? g.white : g.black;
    const strip = $('#' + id);
    strip.textContent = '';
    strip.appendChild(el('span', 'swatch ' + color));
    const nm = el('span', 'an-pname');
    if (p.title) nm.appendChild(el('span', 'title', p.title));
    if (p.reg) {
      const a = el('a', 'plink', p.name);
      a.href = '#/u/' + encodeURIComponent(p.name);
      nm.appendChild(a);
    } else {
      nm.appendChild(document.createTextNode(p.name));
    }
    strip.appendChild(nm);
    if (p.rating) strip.appendChild(el('span', 'prating', '(' + p.rating + ')'));
    const acc = S.summary && S.summary[color].accuracy;
    const a = el('span', 'an-acc', acc === null || acc === undefined ? '' : Math.round(acc) + '% accuracy');
    strip.appendChild(a);
  }

  function renderBar() {
    const ev = S.evals[S.ply];
    const bar = $('#an-bar');
    const share = ev ? wp(ev.v) : 50;
    const fill = $('.evalbar-fill', bar);
    fill.style.height = share + '%';
    bar.classList.toggle('flipped', S.flipped);
    const label = $('.evalbar-label', bar);
    label.textContent = fmtEval(ev);
    bar.setAttribute('aria-label', 'Evaluation ' + fmtEval(ev) + ' for White');
  }

  function renderMoves() {
    for (const b of document.querySelectorAll('#an-moves .an-move')) {
      const ply = Number(b.dataset.ply);
      b.classList.toggle('current', ply === S.ply);
      if (ply === S.ply) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
    const cur = $('#an-moves .an-move.current');
    if (cur) {
      const box = $('#an-moves');
      const top = cur.offsetTop;
      if (top < box.scrollTop || top + cur.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top - box.clientHeight / 2;
    }
  }

  function refreshMoveButton(ply) {
    const b = $('#an-moves .an-move[data-ply="' + ply + '"]');
    if (!b) return;
    const j = S.judged[ply];
    const tag = $('.an-tag', b);
    tag.textContent = j && TAG[j.cls] ? TAG[j.cls] : '';
    tag.className = 'an-tag' + (j ? ' ' + j.cls : '');
    $('.an-ev', b).textContent = S.evals[ply] ? fmtEval(S.evals[ply]) : '';
    b.title = j ? { best: 'Best move', good: 'Good move', inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder' }[j.cls] : '';
  }

  function renderGraph() {
    const g = S.game;
    const n = g.fens.length;
    const W = 400;
    const H = 100;
    const box = $('#an-graph');
    box.textContent = '';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Graph of the evaluation through the game. Click to jump to a move.');
    const x = (i) => (n === 1 ? 0 : (i / (n - 1)) * W);
    const pts = [];
    for (let i = 0; i < n; i++) if (S.evals[i]) pts.push([x(i), H - (wp(S.evals[i].v) / 100) * H]);
    if (pts.length) {
      const area = document.createElementNS(ns, 'path');
      area.setAttribute('class', 'an-area');
      area.setAttribute('d', 'M' + pts[0][0] + ',' + H + ' L' + pts.map((p) => p[0] + ',' + p[1]).join(' L') + ' L' + pts[pts.length - 1][0] + ',' + H + ' Z');
      svg.appendChild(area);
      const ln = document.createElementNS(ns, 'path');
      ln.setAttribute('class', 'an-line-path');
      ln.setAttribute('d', 'M' + pts.map((p) => p[0] + ',' + p[1]).join(' L'));
      svg.appendChild(ln);
    }
    const mid = document.createElementNS(ns, 'line');
    mid.setAttribute('x1', 0); mid.setAttribute('x2', W); mid.setAttribute('y1', H / 2); mid.setAttribute('y2', H / 2);
    mid.setAttribute('class', 'an-mid');
    svg.appendChild(mid);
    for (let ply = 1; ply < n; ply++) {
      const j = S.judged[ply];
      if (j && (j.cls === 'mistake' || j.cls === 'blunder')) {
        const t = document.createElementNS(ns, 'rect');
        t.setAttribute('x', x(ply) - 1.2); t.setAttribute('y', H - 7); t.setAttribute('width', 2.4); t.setAttribute('height', 7);
        t.setAttribute('class', 'an-tick ' + j.cls);
        svg.appendChild(t);
      }
    }
    const cur = document.createElementNS(ns, 'line');
    cur.setAttribute('x1', x(S.ply)); cur.setAttribute('x2', x(S.ply)); cur.setAttribute('y1', 0); cur.setAttribute('y2', H);
    cur.setAttribute('class', 'an-cur');
    svg.appendChild(cur);
    svg.addEventListener('click', (e) => {
      const r = svg.getBoundingClientRect();
      setPly(Math.round(((e.clientX - r.left) / r.width) * (n - 1)));
    });
    box.appendChild(svg);
  }

  function renderSummary() {
    const box = $('#an-summary');
    box.textContent = '';
    if (!S.summary || !S.summary.any) return;
    const grid = el('div', 'an-sumgrid');
    grid.appendChild(el('span'));
    grid.appendChild(el('b', null, S.game.white.name));
    grid.appendChild(el('b', null, S.game.black.name));
    const row = (label, w, b, cls) => {
      grid.appendChild(el('span', 'an-sumlabel' + (cls ? ' ' + cls : ''), label));
      grid.appendChild(el('span', 'an-sumval', String(w)));
      grid.appendChild(el('span', 'an-sumval', String(b)));
    };
    const fmtAcc = (a) => (a === null ? '–' : a.toFixed(0) + '%');
    row('Accuracy', fmtAcc(S.summary.w.accuracy), fmtAcc(S.summary.b.accuracy), 'acc');
    for (const k of ['best', 'good', 'inaccuracy', 'mistake', 'blunder']) row(CLASS_LABEL[k], S.summary.w.counts[k], S.summary.b.counts[k], k);
    box.appendChild(grid);
  }

  function renderLines() {
    const box = $('#an-lines');
    const fen = S.game.fens[S.ply];
    box.textContent = '';
    if (S.game.end && S.ply === S.game.fens.length - 1) {
      box.appendChild(el('p', 'hint', S.game.end === 'mate' ? 'Checkmate.' : 'The game is a draw here.'));
      return;
    }
    let lines = S.live && S.live.ply === S.ply ? S.live.lines.filter(Boolean) : [];
    if (!lines.length && S.evals[S.ply] && S.evals[S.ply].pv.length) {
      const ev = S.evals[S.ply];
      lines = [{ ev, pv: ev.pv, depth: ev.depth }];
    } else {
      lines = lines.map((l) => ({ ev: lineEval(l, fen), pv: l.pv, depth: l.depth }));
    }
    if (!lines.length) {
      box.appendChild(el('p', 'hint', S.running ? 'Waiting for the analysis to reach this move…' : ''));
      return;
    }
    const head = el('div', 'an-lines-head');
    head.appendChild(el('b', null, 'Stockfish suggests'));
    head.appendChild(el('span', 'hint', 'depth ' + Math.max(...lines.map((l) => l.depth))));
    box.appendChild(head);
    for (const l of lines) {
      const row = el('div', 'an-line');
      row.appendChild(el('span', 'an-line-ev', fmtEval(l.ev)));
      row.appendChild(el('span', 'an-line-pv', pvToSan(fen, l.pv, 8)));
      box.appendChild(row);
    }
  }

  function renderStatus() {
    const box = $('#an-status');
    if (!box) return;
    const text = $('.an-status-text', box);
    const prog = $('.an-progress', box);
    const label = engineInfo ? engineInfo.label : 'Stockfish';
    if (S.error) {
      text.textContent = S.error;
      text.classList.add('error');
      prog.hidden = true;
      return;
    }
    text.classList.remove('error');
    if (S.running) {
      const pct = Math.round((S.done / S.game.fens.length) * 100);
      text.textContent = label + ' is analysing move ' + Math.min(S.done + 1, S.game.fens.length) + ' of ' + S.game.fens.length + '…';
      prog.hidden = false;
      $('span', prog).style.width = pct + '%';
      prog.setAttribute('aria-valuenow', String(pct));
    } else if (S.complete) {
      text.textContent = label + ' · analysis complete' + (S.fromCache ? ' (saved earlier)' : '') + (S.game.several ? ' · your PGN had several games, this is the first' : '');
      prog.hidden = true;
    } else {
      text.textContent = S.note || 'Starting ' + label + '…';
      prog.hidden = true;
    }
  }

  function renderPly() {
    drawBoard();
    drawArrow();
    renderBar();
    playerStrip('an-top', S.flipped ? 'w' : 'b');
    playerStrip('an-bottom', S.flipped ? 'b' : 'w');
    renderMoves();
    renderGraph();
    renderLines();
    const n = S.game.fens.length - 1;
    $('#an-first').disabled = $('#an-prev').disabled = S.ply === 0;
    $('#an-next').disabled = $('#an-last').disabled = S.ply === n;
  }

  /* ---------------- judging moves ---------------- */
  function judgeAll() {
    const g = S.game;
    const stats = { w: { acc: [], counts: { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 } }, b: { acc: [], counts: { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 } } };
    let any = false;
    for (let ply = 1; ply < g.fens.length; ply++) {
      const a = S.evals[ply - 1];
      const b = S.evals[ply];
      if (!a || !b) { S.judged[ply] = null; continue; }
      const mover = stmOf(g.fens[ply - 1]);
      const wa = wp(a.v);
      const wb = wp(b.v);
      const before = mover === 'w' ? wa : 100 - wa;
      const after = mover === 'w' ? wb : 100 - wb;
      const loss = Math.max(0, before - after);
      const isBest = a.best === g.moves[ply - 1].uci;
      const cls = isBest ? 'best' : loss >= 20 ? 'blunder' : loss >= 10 ? 'mistake' : loss >= 5 ? 'inaccuracy' : 'good';
      const acc = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
      S.judged[ply] = { cls, loss, acc };
      stats[mover].acc.push(acc);
      stats[mover].counts[cls]++;
      any = true;
    }
    const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
    S.summary = { any, w: { accuracy: mean(stats.w.acc), counts: stats.w.counts }, b: { accuracy: mean(stats.b.acc), counts: stats.b.counts } };
  }

  /* ---------------- running the analysis ---------------- */
  function endEval(fen, kind) {
    if (kind === 'draw') return { v: 0, m: null, best: null, pv: [], depth: 0, end: '½-½' };
    const whiteMated = stmOf(fen) === 'w';
    return { v: whiteMated ? -MATE_V : MATE_V, m: null, best: null, pv: [], depth: 0, end: whiteMated ? '0-1' : '1-0' };
  }

  function cacheKey() { return 'kingside-analysis:' + engineInfo.build + ':' + S.game.key; }

  function readCache() {
    try {
      const o = JSON.parse(localStorage.getItem(cacheKey()));
      if (o && o.v === 1 && o.depth >= S.depth && o.evals.length === S.game.fens.length && o.engine === engineInfo.version) return o;
    } catch (e) { /* no storage or bad data */ }
    return null;
  }

  function writeCache() {
    try {
      localStorage.setItem(cacheKey(), JSON.stringify({ v: 1, depth: S.depth, engine: engineInfo.version, evals: S.evals }));
    } catch (e) { /* storage full or blocked: not important */ }
  }

  function afterEvalsChanged(ply) {
    judgeAll();
    if (ply !== undefined) { refreshMoveButton(ply); refreshMoveButton(ply + 1); } else for (let i = 1; i < S.game.fens.length; i++) refreshMoveButton(i);
    renderSummary();
    playerStrip('an-top', S.flipped ? 'w' : 'b');
    playerStrip('an-bottom', S.flipped ? 'b' : 'w');
    renderGraph();
    renderBar();
    drawArrow();
    renderLines();
  }

  // Starts Stockfish the first time it is needed; later calls reuse it.
  let engineReady = null;
  function ensureEngine() {
    if (!engineReady) {
      const e = createEngine(engineInfo);
      engine = e;
      engineReady = e.init().then(() => e, (err) => { engineReady = null; engine = null; e.terminate(); throw err; });
    }
    return engineReady;
  }

  async function startAnalysis(force) {
    const my = session;
    const token = ++runToken;
    stopLive();
    if (engine) engine.stop();
    const g = S.game;
    S.evals = new Array(g.fens.length).fill(null);
    S.judged = new Array(g.fens.length).fill(null);
    S.summary = null;
    S.complete = false;
    S.fromCache = false;
    S.error = null;
    S.done = 0;

    if (!force) {
      const cached = readCache();
      if (cached) {
        S.evals = cached.evals;
        S.complete = true;
        S.fromCache = true;
        S.running = false;
        afterEvalsChanged();
        renderStatus();
        scheduleLive();
        return;
      }
    }

    S.running = true;
    renderStatus();
    renderLines();
    try {
      await ensureEngine();
      if (my !== session) return;
      for (let i = 0; i < g.fens.length; i++) {
        if (token !== runToken || my !== session) return;
        const fen = g.fens[i];
        if (i === g.fens.length - 1 && g.end) {
          S.evals[i] = endEval(fen, g.end);
        } else {
          const res = await engine.analyse(fen, { depth: S.depth });
          if (token !== runToken || my !== session) return;
          S.evals[i] = toEval(res, fen);
        }
        S.done = i + 1;
        afterEvalsChanged(i);
        renderStatus();
      }
      S.running = false;
      S.complete = true;
      writeCache();
      renderStatus();
      scheduleLive();
    } catch (e) {
      if (my !== session) return;
      S.running = false;
      S.error = (e && e.message) || 'The analysis failed.';
      renderStatus();
    }
  }

  /* ---------------- live top lines for the position being viewed ---------------- */
  function stopLive() {
    clearTimeout(liveTimer);
    liveToken++;
    S && (S.live = null);
  }

  function scheduleLive() {
    clearTimeout(liveTimer);
    liveToken++;
    if (!S || !S.complete) return;
    if (engine) engine.stop();
    const ply = S.ply;
    const fen = S.game.fens[ply];
    if (S.game.end && ply === S.game.fens.length - 1) { renderLines(); return; }
    const my = session;
    const token = liveToken;
    liveTimer = setTimeout(async () => {
      let pending = false;
      const paint = () => {
        pending = false;
        if (token === liveToken && my === session) renderLines();
      };
      try {
        const eng = await ensureEngine();
        if (token !== liveToken || my !== session) return;
        await eng.analyse(fen, {
          depth: LIVE_DEPTH, lines: 3,
          onInfo: (res) => {
            if (token !== liveToken || my !== session) return;
            S.live = { ply, lines: res.lines.slice() };
            if (!pending) { pending = true; requestAnimationFrame(paint); }
          },
        });
      } catch (e) { /* the engine was stopped or the page was closed */ }
      if (token === liveToken && my === session) renderLines();
    }, 250);
  }

  /* ---------------- moving around ---------------- */
  function setPly(i) {
    const n = S.game.fens.length - 1;
    const p = Math.max(0, Math.min(n, i));
    if (p === S.ply) return;
    S.ply = p;
    S.live = null;
    renderPly();
    scheduleLive();
  }

  function go(where) {
    const n = S.game.fens.length - 1;
    setPly(where === 'first' ? 0 : where === 'prev' ? S.ply - 1 : where === 'next' ? S.ply + 1 : n);
  }

  function onKey(e) {
    if (!active || !S || !S.game || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if ($('#pgn-dialog') && $('#pgn-dialog').open) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go('prev'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go('next'); }
    else if (e.key === 'Home') { e.preventDefault(); go('first'); }
    else if (e.key === 'End') { e.preventDefault(); go('last'); }
    else if (e.key === 'f' || e.key === 'F') { S.flipped = !S.flipped; renderPly(); }
  }

  /* ---------------- showing and hiding the page ---------------- */
  async function show(route) {
    const my = ++session;
    active = true;
    stopAll();
    S = null;
    message(route.type === 'review' ? 'Game review' : 'Analyse a game', 'Loading…');
    try {
      let game;
      if (route.type === 'review') {
        game = await gameFromApi(route.id);
      } else {
        let text = pendingPgn;
        if (!text) { try { text = sessionStorage.getItem('kingside-pgn'); } catch (e) { text = null; } }
        if (!text) {
          if (my !== session) return;
          message('Analyse a game', 'Paste a PGN to see how Stockfish rates every move, with accuracy, mistakes and the best line in each position.', true);
          return;
        }
        game = await gameFromPgn(text);
      }
      if (my !== session) return;
      let er, ed;
      if (window.KINGSIDE.localEngine) { er = { ok: true }; ed = window.KINGSIDE.localEngine; }
      else { er = await fetch(window.KINGSIDE.url('/api/engine')); ed = await er.json().catch(() => ({})); }
      if (my !== session) return;
      S = { game, ply: 0, flipped: false, depth: readDepth(), evals: [], judged: [], summary: null, running: false, complete: false, live: null, error: null, done: 0 };
      document.title = game.title + ' - Kingside';
      build();
      renderPly();
      renderSummary();
      if (!er.ok) {
        S.error = ed.error || 'Stockfish could not be loaded.';
        renderStatus();
        return;
      }
      engineInfo = ed;
      renderStatus();
      await startAnalysis(false);
    } catch (e) {
      if (my !== session) return;
      S = null;
      message('Could not open this game', (e && e.message) || 'Something went wrong.', true);
    }
  }

  function readDepth() {
    try {
      const d = Number(localStorage.getItem('kingside-depth'));
      if (DEPTHS.some(([x]) => x === d)) return d;
    } catch (e) { /* ignore */ }
    return 16;
  }

  function stopAll() {
    runToken++;
    liveToken++;
    clearTimeout(liveTimer);
    if (engine) { engine.terminate(); engine = null; }
    engineReady = null;
  }

  function hide() {
    session++;
    active = false;
    stopAll();
    S = null;
  }

  /* ---------------- the "Analyse a PGN" dialog ---------------- */
  function openDialog() {
    const dlg = $('#pgn-dialog');
    if (!dlg) return;
    $('#pgn-error').textContent = '';
    if (!dlg.open) dlg.showModal();
    $('#pgn-text').focus();
  }

  function setupDialog() {
    const dlg = $('#pgn-dialog');
    const open = $('#btn-pgn');
    if (!dlg || !open) return;
    open.addEventListener('click', openDialog);
    $('#pgn-cancel').addEventListener('click', () => dlg.close());
    $('#pgn-file').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (f.size > 1024 * 1024) { $('#pgn-error').textContent = 'That file is too big. PGN files should be under 1 MB.'; return; }
      $('#pgn-text').value = await f.text();
      $('#pgn-error').textContent = '';
      e.target.value = '';
    });
    $('#pgn-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#pgn-text').value;
      const err = $('#pgn-error');
      err.textContent = '';
      if (!text.trim()) { err.textContent = 'Paste a PGN first.'; return; }
      if (text.length > 1024 * 1024) { err.textContent = 'That PGN is too long.'; return; }
      try {
        await gameFromPgn(text); // check it reads before leaving the page
      } catch (ex) {
        err.textContent = ex.message;
        return;
      }
      pendingPgn = text;
      try { sessionStorage.setItem('kingside-pgn', text); } catch (ex) { /* fine without it */ }
      dlg.close();
      if (location.hash === '#/analysis') show({ type: 'pgn' });
      else location.hash = '#/analysis';
    });
  }

  document.addEventListener('keydown', onKey);
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'an-depth') { try { localStorage.setItem('kingside-depth', e.target.value); } catch (ex) { /* ignore */ } }
  });
  window.addEventListener('pagehide', () => { if (engine) engine.terminate(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupDialog); else setupDialog();

  window.KingsideAnalysis = { show, hide };
})();
