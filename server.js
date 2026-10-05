// Zhol multiplayer server. No extra packages needed: just Node.js.
//   Start it with:  node server.js
//   Then open http://localhost:3000 (or the address it prints) on the phones.
//
// How it works:
// - The game maker creates a game and gets a 4-letter code.
// - Friends join with the code and their name (or open the shared link).
// - The game maker presses Start. Only people play: 2, 3 or 4 of them.
// - Everyone in the game can chat.
// - Every move is checked here with the same rules engine as the single-player game.
// - Each phone gets live updates (Server-Sent Events) and only sees its own cards.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const Z = require('./zhol-engine.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const BOT_DELAY = process.env.ZHOL_BOT_DELAY !== undefined ? parseInt(process.env.ZHOL_BOT_DELAY, 10) : 900;
const BOT_NAMES = ['Besnik', 'Drita', 'Arben', 'Mira'];
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

const games = new Map();          // code -> game

// ---------- Helpers ----------

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!games.has(code)) return code;
  }
}
const newToken = () => crypto.randomBytes(16).toString('hex');

function cleanName(name, game) {
  let n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!n) return '';
  if (game) {
    const taken = new Set(game.players.map((p) => p.name.toLowerCase()));
    let base = n, k = 2;
    while (taken.has(n.toLowerCase())) n = (base.slice(0, 13) + ' ' + k++);
  }
  return n;
}

class ApiError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status || 400; } }

function findPlayer(body) {
  const game = games.get(String(body.code || '').toUpperCase());
  if (!game) throw new ApiError('noGame', 404);
  const player = game.players.find((p) => p.token === body.token);
  if (!player) throw new ApiError('badToken', 403);
  game.lastActive = Date.now();
  return { game, player };
}

// ---------- Game state ----------

function createGame(hostName) {
  const code = newCode();
  const game = {
    code, createdAt: Date.now(), lastActive: Date.now(),
    players: [], hostId: null,
    started: false,
    seats: null,           // [{ playerId | null, botName }]
    match: null,
    event: null, eventSeq: 0, roundId: 0,
    chat: [], chatSeq: 0,
    botTimer: null,
  };
  games.set(code, game);
  const host = addPlayer(game, hostName);
  game.hostId = host.id;
  return { game, player: host };
}

function addPlayer(game, name) {
  const player = { id: crypto.randomBytes(6).toString('hex'), token: newToken(), name: cleanName(name, game), clients: new Set(), botTakeover: false };
  game.players.push(player);
  return player;
}

function seatOf(game, player) {
  if (!game.seats) return -1;
  return game.seats.findIndex((s) => s.playerId === player.id);
}
function isBotSeat(game, seat) {
  const s = game.seats[seat];
  if (!s.playerId) return true;
  const p = game.players.find((x) => x.id === s.playerId);
  return !p || p.botTakeover;
}
function seatName(game, seat) {
  const s = game.seats[seat];
  if (!s.playerId) return s.botName;
  const p = game.players.find((x) => x.id === s.playerId);
  return p ? p.name : s.botName;
}

function startGame(game) {
  // Only people: seats in the order they joined, the game maker first. Play goes to the right in seat order.
  const humans = game.players.slice(0, 4);
  game.seats = humans.map((p, i) => ({ playerId: p.id, botName: BOT_NAMES[i] }));   // botName: only if the computer has to step in
  game.match = new Z.ZholMatch(humans.length);
  game.started = true;
  game.event = null;
  game.roundId++;
}

/** Do a move for a seat, remember what happened (for messages and animations), and tell everyone. */
function doMove(game, seat, move) {
  const round = game.match.round;
  const topBefore = round.discardPile.length ? round.discardPile[round.discardPile.length - 1] : null;
  const handBefore = new Set(round.players[seat].hand.map((c) => c.id));
  round.perform(move);                                    // throws Z.MoveError if not allowed
  let card = null, isPublic = true;
  if (move.type === 'drawFromPile') { card = round.players[seat].hand.find((c) => !handBefore.has(c.id)) || null; isPublic = false; }
  else if (move.type === 'takeBottomCard' || move.type === 'takeDiscard') card = round.players[seat].hand.find((c) => !handBefore.has(c.id)) || null;
  else if (move.type === 'takeDiscardAndOpen') card = topBefore;
  else if (move.type === 'discard' || move.type === 'sell') card = move.card;
  game.event = { seq: ++game.eventSeq, seat, type: move.type, card, isPublic, count: move.groups ? move.groups.length : 0 };
  game.lastActive = Date.now();
  broadcast(game);
  scheduleBots(game);
}

function scheduleBots(game) {
  if (game.botTimer) return;
  const round = game.match && game.match.round;
  if (!round || round.phase === 'finished' || !isBotSeat(game, round.current)) return;
  game.botTimer = setTimeout(() => {
    game.botTimer = null;
    const r = game.match && game.match.round;
    if (!r || r.phase === 'finished' || !isBotSeat(game, r.current)) return;
    const seat = r.current;
    try {
      const move = Z.botNextMove(r);
      doMove(game, seat, move);
    } catch (e) {
      if (!(e instanceof Z.MoveError)) throw e;
      const fallback = Z.botFallbackMove(r);
      if (fallback) { try { doMove(game, seat, fallback); } catch (e2) { if (!(e2 instanceof Z.MoveError)) throw e2; } }
    }
  }, BOT_DELAY);
}

// ---------- What each phone sees ----------

function viewFor(game, player) {
  const view = {
    code: game.code,
    started: game.started,
    you: { id: player.id, name: player.name, isHost: player.id === game.hostId },
    players: game.players.map((p) => ({ id: p.id, name: p.name, isHost: p.id === game.hostId, connected: p.clients.size > 0 })),
    chat: game.chat.slice(-50),
    game: null,
  };
  if (!game.started) return view;
  const m = game.match, r = m.round;
  const mySeat = seatOf(game, player);
  const ev = game.event;
  view.game = {
    mySeat,
    seats: game.seats.map((st, s) => {
      const p = st.playerId ? game.players.find((x) => x.id === st.playerId) : null;
      return {
        name: seatName(game, s),
        isBot: !st.playerId,
        botPlaying: !!(p && p.botTakeover),
        connected: p ? p.clients.size > 0 : true,
        handCount: r.players[s].hand.length,
        hasOpened: r.players[s].hasOpened,
      };
    }),
    phase: r.phase,
    current: r.current,
    myHand: mySeat >= 0 ? r.players[mySeat].hand : [],
    table: r.table,
    discardTop: r.discardPile.length ? r.discardPile[r.discardPile.length - 1] : null,
    drawCount: r.drawPile.length,
    bottomCard: r.bottomCard,
    result: r.result,
    totals: m.totals,
    dealer: m.dealer,
    roundsPlayed: m.roundsPlayed,
    roundId: game.roundId,
    event: ev ? { seq: ev.seq, seat: ev.seat, type: ev.type, count: ev.count, card: (ev.isPublic || ev.seat === mySeat) ? ev.card : null } : null,
  };
  return view;
}

function send(res, view) { res.write('data: ' + JSON.stringify(view) + '\n\n'); }
function broadcast(game) {
  for (const p of game.players) {
    if (p.clients.size === 0) continue;
    const view = viewFor(game, p);
    for (const res of p.clients) send(res, view);
  }
}

// ---------- Moves from a phone (cards arrive as ids) ----------

function hydrateMove(game, seat, raw) {
  const r = game.match.round;
  const hand = r.players[seat].hand;
  const top = r.discardPile.length ? r.discardPile[r.discardPile.length - 1] : null;
  const pool = new Map(hand.map((c) => [c.id, c]));
  if (raw.type === 'takeDiscardAndOpen' && top) pool.set(top.id, top);
  const card = (id) => { const c = pool.get(id); if (!c) throw new Z.MoveError('cardNotInHand'); return c; };
  const cards = (ids) => { if (!Array.isArray(ids)) throw new Z.MoveError('cardNotInHand'); return ids.map(card); };
  switch (raw.type) {
    case 'drawFromPile': case 'takeDiscard': case 'takeBottomCard': return { type: raw.type };
    case 'takeDiscardAndOpen': case 'layDown':
      if (!Array.isArray(raw.groups)) throw new Z.MoveError('notAValidMeld');
      return { type: raw.type, groups: raw.groups.map(cards) };
    case 'sell': return { type: 'sell', card: card(raw.card), meld: raw.meld | 0, atHighEnd: !!raw.atHighEnd };
    case 'takeJoker': return { type: 'takeJoker', meld: raw.meld | 0, giving: cards(raw.giving) };
    case 'discard': return { type: 'discard', card: card(raw.card) };
    default: throw new Z.MoveError('wrongPhase');
  }
}

// ---------- HTTP ----------

const routes = {
  'POST /api/create': (body) => {
    const name = cleanName(body.name);
    if (!name) throw new ApiError('noName');
    const { game, player } = createGame(name);
    return { code: game.code, token: player.token };
  },
  'POST /api/join': (body) => {
    const game = games.get(String(body.code || '').toUpperCase().trim());
    if (!game) throw new ApiError('noGame', 404);
    if (game.started) throw new ApiError('started');
    if (game.players.length >= 4) throw new ApiError('full');
    if (!cleanName(body.name)) throw new ApiError('noName');
    const player = addPlayer(game, body.name);
    game.lastActive = Date.now();
    broadcast(game);
    return { code: game.code, token: player.token };
  },
  'POST /api/check': (body) => { findPlayer(body); return { ok: true }; },
  'POST /api/chat': (body) => {
    const { game, player } = findPlayer(body);
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) throw new ApiError('chatEmpty');
    const now = Date.now();
    if (player.lastChat && now - player.lastChat < 400) throw new ApiError('chatTooFast', 429);
    player.lastChat = now;
    game.chat.push({ id: ++game.chatSeq, playerId: player.id, name: player.name, text, t: now });
    if (game.chat.length > 100) game.chat.splice(0, game.chat.length - 100);
    broadcast(game);
    return { ok: true };
  },
  'POST /api/leave': (body) => {
    const { game, player } = findPlayer(body);
    if (!game.started) {
      game.players = game.players.filter((p) => p !== player);
      for (const res of player.clients) res.end();
      if (game.players.length === 0) games.delete(game.code);
      else if (game.hostId === player.id) game.hostId = game.players[0].id;
      broadcast(game);
    }
    return { ok: true };
  },
  'POST /api/start': (body) => {
    const { game, player } = findPlayer(body);
    if (player.id !== game.hostId) throw new ApiError('notHost', 403);
    if (game.started) throw new ApiError('started');
    if (game.players.length < 2) throw new ApiError('needTwo');
    startGame(game);
    broadcast(game);
    scheduleBots(game);
    return { ok: true };
  },
  'POST /api/move': (body) => {
    const { game, player } = findPlayer(body);
    if (!game.started) throw new ApiError('notStarted');
    const seat = seatOf(game, player);
    const r = game.match.round;
    if (seat < 0 || r.current !== seat || r.phase === 'finished' || player.botTakeover) throw new ApiError('notYourTurn');
    try {
      doMove(game, seat, hydrateMove(game, seat, body.move || {}));
    } catch (e) {
      if (e instanceof Z.MoveError) throw new ApiError(e.code);
      throw e;
    }
    return { ok: true };
  },
  'POST /api/next': (body) => {
    const { game, player } = findPlayer(body);
    if (player.id !== game.hostId) throw new ApiError('notHost', 403);
    if (!game.started || game.match.round.phase !== 'finished') return { ok: true };
    if (game.match.roundsPlayed + 1 >= Z.TOTAL_ROUNDS) game.match = new Z.ZholMatch(game.seats.length);      // the last round: a new game
    else game.match.startNextRound();
    game.event = null;
    game.roundId++;
    broadcast(game);
    scheduleBots(game);
    return { ok: true };
  },
  'POST /api/takeover': (body) => {
    const { game, player } = findPlayer(body);
    if (player.id !== game.hostId) throw new ApiError('notHost', 403);
    if (!game.started) throw new ApiError('notStarted');
    const st = game.seats[body.seat | 0];
    const target = st && st.playerId ? game.players.find((p) => p.id === st.playerId) : null;
    if (!target || target === player) throw new ApiError('notHost');
    target.botTakeover = !!body.on;
    broadcast(game);
    scheduleBots(game);
    return { ok: true };
  },
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 100000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(INDEX_FILE, (err, data) => {
      if (err) { res.writeHead(500); res.end('index.html is missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  // Live updates for one phone
  if (req.method === 'GET' && url.pathname === '/api/events') {
    let found;
    try { found = findPlayer({ code: url.searchParams.get('code'), token: url.searchParams.get('token') }); } catch (e) { json(res, e.status || 400, { error: e.code }); return; }
    const { game, player } = found;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    player.clients.add(res);
    if (player.botTakeover) { player.botTakeover = false; }            // you are back: you play again
    broadcast(game);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      player.clients.delete(res);
      if (games.has(game.code)) broadcast(game);
    });
    return;
  }

  const handler = routes[req.method + ' ' + url.pathname];
  if (!handler) { json(res, 404, { error: 'notFound' }); return; }
  const body = await readBody(req);
  try {
    json(res, 200, handler(body));
  } catch (e) {
    if (e instanceof ApiError) json(res, e.status, { error: e.code });
    else { console.error(e); json(res, 500, { error: 'server' }); }
  }
});

// Forget games nobody has used for 6 hours
setInterval(() => {
  const old = Date.now() - 6 * 3600 * 1000;
  for (const [code, g] of games) {
    if (g.lastActive < old && g.players.every((p) => p.clients.size === 0)) { if (g.botTimer) clearTimeout(g.botTimer); games.delete(code); }
  }
}, 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('Zhol is running.');
    console.log('  On this computer:  http://localhost:' + PORT);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log('  On phones in the same Wi-Fi:  http://' + a.address + ':' + PORT);
    }
  });
}

module.exports = { server, games };
