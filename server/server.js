// Anik's Ludo - online multiplayer server (Node.js + Socket.IO)
// One process serves the game page (index.html) and the realtime game rooms.
// The server owns the dice and the rules, so players cannot cheat from the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const SPEED = Number(process.env.SPEED || 1); // >1 only for automated tests
const TURN_SECS = 20;
const sleep = ms => new Promise(r => setTimeout(r, ms / SPEED));

/* ---------- optional: serve the frontend folder from this same server ---------- */
const FRONT = process.env.FRONTEND_DIR || path.join(__dirname, '..', 'frontend');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/healthz' || url === '/health' || url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(healthInfo()));
    return;
  }
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(FRONT, url));
  if (!file.startsWith(FRONT + path.sep) && file !== FRONT) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) {
      if (url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Anik\u2019s Ludo game server is running.'); return; }
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});
/* ---------- health check (used by the keep-alive ping and by uptime monitors) ---------- */
function healthInfo() {
  let players = 0;
  rooms.forEach(r => r.seats.forEach(s => { if (s.connected) players++; }));
  return { ok: true, uptime: Math.round(process.uptime()), rooms: rooms.size, players, time: new Date().toISOString() };
}

const io = new Server(server, { cors: { origin: '*' } });

/* ---------- rules (same board maths as the client) ---------- */
const START = [0, 13, 26, 39];
const SAFE = new Set([0, 13, 26, 39, 8, 21, 34, 47]);
const absIdx = (c, s) => (START[c] + s) % 52;

function legalMoves(g, c, d) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const s = g.tokens[c][i];
    if (s === -1) { if (d === 6) out.push(i); }
    else if (s + d <= 56) out.push(i);
  }
  return out;
}
function dangerAt(g, c, s) {
  if (s < 0 || s > 50) return 0;
  const a = absIdx(c, s); if (SAFE.has(a)) return 0;
  let n = 0;
  g.active.forEach(oc => {
    if (oc === c) return;
    g.tokens[oc].forEach(os => {
      if (os < 0 || os > 50) return;
      const dist = (a - absIdx(oc, os) + 52) % 52;
      if (dist >= 1 && dist <= 6) n++;
    });
  });
  return n;
}
function capturesAt(g, c, target) {
  if (target < 0 || target > 50) return 0;
  const a = absIdx(c, target); if (SAFE.has(a)) return 0;
  let n = 0;
  g.active.forEach(oc => {
    if (oc === c) return;
    g.tokens[oc].forEach(os => { if (os >= 0 && os <= 50 && absIdx(oc, os) === a) n++; });
  });
  return n;
}
function botPick(g, c, moves, d, easy) {
  if (easy) return moves[Math.floor(Math.random() * moves.length)];
  let best = moves[0], bs = -1e9;
  moves.forEach(i => {
    const s = g.tokens[c][i], t = s === -1 ? 0 : s + d;
    let sc = 0;
    if (t === 56) sc += 100;
    const k = capturesAt(g, c, t); if (k) sc += 80 + k * 10;
    if (s === -1) sc += 55;
    if (t >= 51 && t <= 55) sc += 35;
    if (t <= 50 && SAFE.has(absIdx(c, t))) sc += 28;
    sc += (dangerAt(g, c, s) - dangerAt(g, c, t)) * 22;
    sc += t * .3 + Math.random() * 3;
    if (sc > bs) { bs = sc; best = i; }
  });
  return best;
}
function applyMove(g, c, i, d) {
  const from = g.tokens[c][i];
  const to = from === -1 ? 0 : from + d;
  g.tokens[c][i] = to;
  const killed = [];
  if (to <= 50 && !SAFE.has(absIdx(c, to))) {
    const a = absIdx(c, to);
    g.active.forEach(oc => {
      if (oc === c) return;
      g.tokens[oc].forEach((os, j) => {
        if (os >= 0 && os <= 50 && absIdx(oc, os) === a) { g.tokens[oc][j] = -1; killed.push([oc, j]); }
      });
    });
  }
  return { from, to, killed };
}

/* ---------- rooms ---------- */
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  for (let n = 0; n < 50; n++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const mkSeat = type => ({ type, pid: null, name: '', sid: null, connected: false });
const cleanName = n => String(n || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 12) || 'Player';
const cleanPid = p => String(p || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
const REACTS = new Set(['laugh', 'cool', 'angry', 'cry', 'love', 'wow']);

function publicRoom(room) {
  return {
    code: room.code, stage: room.stage, host: room.host, diff: room.diff,
    seats: room.seats.map(s => ({ type: s.type, name: s.name, connected: s.connected, taken: !!s.pid }))
  };
}
const broadcastRoom = room => io.to(room.code).emit('room', publicRoom(room));
const emit = (room, ev, data) => io.to(room.code).emit(ev, data);

function snapshot(room, fresh) {
  const g = room.g;
  return {
    fresh: !!fresh, active: g.active, seats: room.seats.map(s => s.type), names: room.names,
    tokens: g.tokens, turn: g.turn, phase: g.phase, dice: g.dice,
    valid: g.phase === 'pick' ? g.valid : [],
    tleft: Math.max(0, Math.round((g.deadline - Date.now()) / 1000)), diff: room.diff
  };
}
const humanConnected = room => room.seats.some(s => s.type === 'human' && s.connected);

function ctx(socket) {
  const code = socket.data.code;
  const room = code && rooms.get(code);
  return { room, seat: socket.data.seat };
}

/* wait for a player's input, or time out */
function waitInput(g, type, ms) {
  return new Promise(resolve => {
    g.deadline = Date.now() + ms;
    const timer = setTimeout(() => { g.wait = null; resolve('timeout'); }, ms);
    g.wait = { type, resolve: v => { clearTimeout(timer); g.wait = null; resolve(v); } };
  });
}
function resolveWait(g, type, payload) {
  if (g.wait && g.wait.type === type) g.wait.resolve(payload);
}
function stopGame(room) {
  if (room.g) { room.g.over = true; if (room.g.wait) room.g.wait.resolve('timeout'); }
}

/* ---------- the game loop (runs on the server) ---------- */
async function runGame(room, g) {
  const alive = () => room.g === g && !g.over;
  const nextTurn = () => {
    g.sixes = 0;
    const a = g.active; g.turn = a[(a.indexOf(g.turn) + 1) % a.length];
  };
  while (alive()) {
    while (alive() && !humanConnected(room)) await sleep(1500); // pause if everybody left
    if (!alive()) return;
    const c = g.turn, seat = room.seats[c];
    const auto = seat.type === 'bot' || !seat.connected;
    const easy = room.diff === 'easy';

    /* roll */
    g.phase = 'roll'; g.valid = [];
    g.deadline = Date.now() + (auto ? 0 : TURN_SECS * 1000);
    emit(room, 'turn', { turn: c, tleft: auto ? 0 : TURN_SECS });
    if (seat.type === 'bot') await sleep(750);
    else if (!seat.connected) await sleep(1200);
    else await waitInput(g, 'roll', TURN_SECS * 1000);
    if (!alive()) return;

    const d = 1 + Math.floor(Math.random() * 6);
    g.dice = d; g.phase = 'rolling';
    if (d === 6) g.sixes++; else g.sixes = 0;
    emit(room, 'rolled', { c, d });
    await sleep(1300); if (!alive()) return;

    if (g.sixes === 3) {
      emit(room, 'info', { text: 'Three 6s in a row \u2013 turn lost' });
      await sleep(1100); if (!alive()) return;
      nextTurn(); continue;
    }
    const valid = legalMoves(g, c, d);
    if (!valid.length) {
      emit(room, 'info', { text: `rolled ${d} \u2013 no move`, c });
      await sleep(1000); if (!alive()) return;
      if (d === 6) continue;
      nextTurn(); continue;
    }
    const uniq = []; const seen = new Set();
    valid.forEach(i => { const s = g.tokens[c][i]; if (!seen.has(s)) { seen.add(s); uniq.push(i); } });

    /* choose a token */
    let pick;
    if (uniq.length === 1) { await sleep(350); pick = uniq[0]; }
    else if (seat.type === 'bot') { await sleep(450); pick = botPick(g, c, uniq, d, easy); }
    else if (!seat.connected) { await sleep(500); pick = botPick(g, c, uniq, d, false); }
    else {
      g.phase = 'pick'; g.valid = valid;
      g.deadline = Date.now() + TURN_SECS * 1000;
      emit(room, 'pick', { c, valid, tleft: TURN_SECS });
      const r = await waitInput(g, 'move', TURN_SECS * 1000);
      if (!alive()) return;
      pick = (r === 'timeout') ? botPick(g, c, uniq, d, false) : r.i;
    }
    if (!alive()) return;

    /* move */
    g.phase = 'anim'; g.valid = [];
    const { from, to, killed } = applyMove(g, c, pick, d);
    emit(room, 'moved', { c, i: pick, from, to, killed });
    if (killed.length) {
      if (seat.type === 'bot' && Math.random() < .6) emit(room, 'react', { c, t: 'cool' });
      killed.forEach(([oc]) => { if (room.seats[oc].type === 'bot' && Math.random() < .6) setTimeout(() => emit(room, 'react', { c: oc, t: 'angry' }), 350 / SPEED); });
    }
    const dur = 30 + (from === -1 ? 300 : (to - from) * 175) + (killed.length ? 650 : to === 56 ? 600 : 250) + 250;
    await sleep(dur); if (!alive()) return;

    if (g.tokens[c].every(v => v === 56)) {
      g.over = true; room.stage = 'lobby';
      emit(room, 'over', { winner: c });
      broadcastRoom(room);
      return;
    }
    if (killed.length || to === 56 || d === 6) continue; // bonus roll
    nextTurn();
  }
}

/* ---------- sockets ---------- */
io.on('connection', socket => {
  socket.data = { code: null, seat: -1 };

  function attach(room, si, pid, name) {
    const seat = room.seats[si];
    const oldSid = seat.sid;
    seat.pid = pid; seat.name = name || seat.name || 'Player'; seat.sid = socket.id; seat.connected = true;
    if (oldSid && oldSid !== socket.id) { const old = io.sockets.sockets.get(oldSid); if (old) { old.data = { code: null, seat: -1 }; old.leave(room.code); } }
    socket.join(room.code);
    socket.data = { code: room.code, seat: si };
    room.last = Date.now();
  }

  socket.on('create', (d, ack) => {
    if (typeof ack !== 'function') return;
    d = d || {};
    const code = genCode(); if (!code) return ack({ ok: false, msg: 'Server is busy, try again' });
    const room = { code, stage: 'lobby', host: 0, diff: 'hard', gid: 0, g: null, names: [], last: Date.now(),
      seats: [mkSeat('human'), mkSeat('human'), mkSeat('off'), mkSeat('off')] };
    rooms.set(code, room);
    attach(room, 0, cleanPid(d.pid) || ('p' + Math.random().toString(36).slice(2, 12)), cleanName(d.name));
    ack({ ok: true, code, seat: 0, stage: room.stage });
    broadcastRoom(room);
  });

  socket.on('join', (d, ack) => {
    if (typeof ack !== 'function') return;
    d = d || {};
    const code = String(d.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, msg: 'Room not found. Check the code.' });
    const pid = cleanPid(d.pid) || ('p' + Math.random().toString(36).slice(2, 12));
    let si = room.seats.findIndex(s => s.pid === pid);
    if (si < 0) {
      if (room.stage !== 'lobby') return ack({ ok: false, msg: 'That game has already started.' });
      si = room.seats.findIndex(s => s.type === 'human' && !s.pid);
      if (si < 0) return ack({ ok: false, msg: 'Room is full.' });
      attach(room, si, pid, cleanName(d.name));
    } else {
      attach(room, si, pid, room.seats[si].name);
    }
    ack({ ok: true, code, seat: si, stage: room.stage });
    broadcastRoom(room);
    if (room.g && room.stage === 'play') socket.emit('game', snapshot(room, false));
  });

  socket.on('cfg', (d, ack) => {
    const { room, seat } = ctx(socket); if (!room || room.stage !== 'lobby' || seat !== room.host || !d) return;
    const si = Number(d.seat), type = d.type;
    if (!(si >= 0 && si < 4) || !['human', 'bot', 'off'].includes(type)) return;
    const s = room.seats[si];
    if (s.pid || si === room.host) return; // seat is taken by a person
    s.type = type; broadcastRoom(room);
  });
  socket.on('diff', d => {
    const { room, seat } = ctx(socket); if (!room || seat !== room.host) return;
    if (d === 'easy' || d === 'hard') { room.diff = d; broadcastRoom(room); }
  });

  socket.on('start', () => {
    const { room, seat } = ctx(socket); if (!room || room.stage !== 'lobby' || seat !== room.host) return;
    const active = [0, 1, 2, 3].filter(c => room.seats[c].type !== 'off');
    if (active.length < 2) return;
    if (room.seats.some(s => s.type === 'human' && !s.pid)) return; // empty seat still open
    room.names = room.seats.map(s => s.type === 'bot' ? 'Guest' + (1000 + Math.floor(Math.random() * 9000)) : (s.name || 'Player'));
    const g = { id: ++room.gid, active, tokens: [0, 1, 2, 3].map(() => [-1, -1, -1, -1]), turn: active[0], dice: 0, sixes: 0,
      phase: 'roll', valid: [], over: false, deadline: Date.now() + TURN_SECS * 1000, wait: null };
    stopGame(room);
    room.g = g; room.stage = 'play';
    broadcastRoom(room);
    emit(room, 'game', snapshot(room, true));
    runGame(room, g).catch(e => console.error('game loop error', e));
  });

  socket.on('roll', () => {
    const { room, seat } = ctx(socket); if (!room || !room.g) return;
    const g = room.g;
    if (g.over || g.phase !== 'roll' || g.turn !== seat) return;
    resolveWait(g, 'roll', {});
  });
  socket.on('move', d => {
    const { room, seat } = ctx(socket); if (!room || !room.g || !d) return;
    const g = room.g, i = Number(d.i);
    if (g.over || g.phase !== 'pick' || g.turn !== seat || !g.valid.includes(i)) return;
    resolveWait(g, 'move', { i });
  });
  socket.on('react', t => {
    const { room, seat } = ctx(socket); if (!room || seat < 0 || !REACTS.has(t)) return;
    emit(room, 'react', { c: seat, t });
  });

  function leaveRoom(hard) {
    const { room, seat } = ctx(socket); if (!room) return;
    socket.leave(room.code);
    socket.data = { code: null, seat: -1 };
    const s = room.seats[seat]; if (!s || s.sid !== socket.id) return;
    s.connected = false; s.sid = null; room.last = Date.now();
    if (hard) {
      if (room.stage === 'lobby') {
        s.pid = null; s.name = '';
        if (seat === room.host) {
          const nh = room.seats.findIndex(x => x.pid && x.connected);
          if (nh < 0) { rooms.delete(room.code); return; }
          room.host = nh;
        }
      } else { // in a running game the bot takes over this seat
        s.pid = null;
        if (seat === room.host) { const nh = room.seats.findIndex(x => x.pid && x.connected); if (nh >= 0) room.host = nh; }
      }
    }
    if (room.g && room.g.wait && room.g.turn === seat) room.g.wait.resolve('timeout');
    broadcastRoom(room);
  }
  socket.on('leave', () => leaveRoom(true));
  socket.on('disconnect', () => leaveRoom(false));
});

/* tidy up rooms nobody is in */
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (!humanConnected(room) && now - room.last > 15 * 60 * 1000) { stopGame(room); rooms.delete(code); }
  });
}, 60 * 1000);

/* ---------- keep-alive: stops the free Render server from going to sleep ----------
   Every KEEP_ALIVE_MINUTES (default 14) the server calls its own public /healthz URL.
   Render sets RENDER_EXTERNAL_URL automatically. Locally nothing runs unless you set KEEP_ALIVE_URL.
   Set KEEP_ALIVE=off to disable. */
const KEEP_URL = (process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const KEEP_MIN = Number(process.env.KEEP_ALIVE_MINUTES || 14);
if (KEEP_URL && process.env.KEEP_ALIVE !== 'off') {
  setInterval(async () => {
    try { const r = await fetch(KEEP_URL + '/healthz'); console.log('keep-alive ping:', r.status); }
    catch (e) { console.log('keep-alive ping failed:', e.message); }
  }, KEEP_MIN * 60 * 1000);
  console.log('keep-alive: pinging ' + KEEP_URL + '/healthz every ' + KEEP_MIN + ' min');
}

server.listen(PORT, () => console.log('Anik\u2019s Ludo server on port ' + PORT));
