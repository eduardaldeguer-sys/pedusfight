// ═══════════════════════════════════════════════════════════════
//  NEON CLASH v2 — Game Server
//  Modes: Multiplayer (rooms) + Competitive (ELO matchmaking)
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static('.'));
app.use(express.json());

// ── IN-MEMORY STORES ──────────────────────────────────────────
const rooms      = new Map();   // roomId -> Room
const queue      = [];           // Competitive matchmaking queue
const playerData = new Map();    // socketId -> PlayerData
const eloStore   = new Map();    // username -> { elo, wins, losses, rank }

// ── ELO CONFIG ────────────────────────────────────────────────
const RANKS = [
  { name: 'BRONCE',   min: 0,    color: '#cd7f32', icon: '🥉' },
  { name: 'PLATA',    min: 800,  color: '#aaaaaa', icon: '🥈' },
  { name: 'ORO',      min: 1000, color: '#ffe600', icon: '🥇' },
  { name: 'PLATINO',  min: 1200, color: '#00ffcc', icon: '💎' },
  { name: 'DIAMANTE', min: 1500, color: '#00d4ff', icon: '💠' },
  { name: 'MAESTRO',  min: 1800, color: '#b400ff', icon: '👑' },
  { name: 'LEYENDA',  min: 2100, color: '#ff003c', icon: '🔥' },
];

function getRank(elo) {
  let rank = RANKS[0];
  for (const r of RANKS) { if (elo >= r.min) rank = r; }
  return rank;
}

function calcElo(winnerElo, loserElo, kFactor = 32) {
  const expectedW = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const expectedL = 1 - expectedW;
  return {
    winnerNew: Math.round(winnerElo + kFactor * (1 - expectedW)),
    loserNew:  Math.max(0, Math.round(loserElo + kFactor * (0 - expectedL))),
    winnerGain: Math.round(kFactor * (1 - expectedW)),
    loserLoss:  Math.round(kFactor * expectedL),
  };
}

function getOrCreateElo(username) {
  if (!eloStore.has(username)) {
    eloStore.set(username, { elo: 800, wins: 0, losses: 0, draws: 0, streak: 0 });
  }
  return eloStore.get(username);
}

// ── ROOM CLASS ────────────────────────────────────────────────
class Room {
  constructor(id, mode, password = null) {
    this.id         = id;
    this.mode       = mode;     // 'casual' | 'competitive'
    this.password   = password;
    this.players    = [];       // max 2
    this.spectators = [];
    this.state      = 'waiting'; // waiting | playing | finished
    this.createdAt  = Date.now();
    this.gameState  = null;
    this.roundData  = { round: 1, p1Wins: 0, p2Wins: 0 };
  }

  isFull()  { return this.players.length >= 2; }
  isEmpty() { return this.players.length === 0; }

  broadcast(msg, exclude = null) {
    const data = JSON.stringify(msg);
    this.players.forEach(p => {
      if (p !== exclude && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
    });
    this.spectators.forEach(s => {
      if (s !== exclude && s.readyState === WebSocket.OPEN) s.send(data);
    });
  }

  broadcastPlayers(msg, exclude = null) {
    const data = JSON.stringify(msg);
    this.players.forEach(p => {
      if (p !== exclude && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
    });
  }

  toInfo() {
    return {
      id:       this.id,
      mode:     this.mode,
      players:  this.players.length,
      state:    this.state,
      hasPass:  !!this.password,
      spectators: this.spectators.length,
      p1name:   this.players[0]?.username || '',
      p2name:   this.players[1]?.username || '',
    };
  }
}

// ── WEBSOCKET HANDLER ─────────────────────────────────────────
let connCount = 0;

wss.on('connection', (ws, req) => {
  const id = `p_${++connCount}_${crypto.randomBytes(3).toString('hex')}`;
  ws.clientId = id;
  ws.isAlive   = true;

  console.log(`[WS] Connected: ${id}`);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    console.log(`[WS] Disconnected: ${id}`);
    handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error ${id}:`, err.message);
  });

  // Send welcome
  ws.send(JSON.stringify({ type: 'connected', clientId: id }));
});

// Heartbeat — detects dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// ── MESSAGE HANDLER ────────────────────────────────────────────
function handleMessage(ws, msg) {
  const pd = playerData.get(ws.clientId);

  switch (msg.type) {

    // ── AUTH / IDENTIFY ──────────────────────────────────────
    case 'identify': {
      const username = (msg.username || 'Luchador').substring(0, 20).replace(/[^a-zA-Z0-9_\- ]/g,'');
      const eloData  = getOrCreateElo(username);
      playerData.set(ws.clientId, {
        clientId: ws.clientId,
        username,
        ws,
        room: null,
        ...eloData,
        rank: getRank(eloData.elo),
      });
      ws.send(JSON.stringify({
        type: 'identified',
        username,
        elo:  eloData.elo,
        rank: getRank(eloData.elo),
        wins: eloData.wins,
        losses: eloData.losses,
      }));
      break;
    }

    // ── ROOM LIST ────────────────────────────────────────────
    case 'get_rooms': {
      const list = [];
      rooms.forEach(r => {
        if (r.mode === 'casual' && !r.isFull() && r.state === 'waiting') {
          list.push(r.toInfo());
        }
      });
      ws.send(JSON.stringify({ type: 'room_list', rooms: list }));
      break;
    }

    // ── CREATE ROOM ──────────────────────────────────────────
    case 'create_room': {
      if (!pd) { ws.send(JSON.stringify({ type: 'error', msg: 'Identifícate primero' })); return; }
      if (pd.room) leaveRoom(ws, pd);

      const roomId = crypto.randomBytes(3).toString('hex').toUpperCase();
      const room   = new Room(roomId, msg.mode || 'casual', msg.password || null);
      rooms.set(roomId, room);

      const player = { ws, clientId: ws.clientId, username: pd.username, playerId: 1, charId: msg.charId || 0, ready: false };
      room.players.push(player);
      pd.room = roomId;

      ws.send(JSON.stringify({
        type: 'room_created',
        roomId,
        playerId: 1,
        mode: room.mode,
      }));
      console.log(`[Room] Created ${roomId} by ${pd.username} (${room.mode})`);
      broadcastLobby();
      break;
    }

    // ── JOIN ROOM ────────────────────────────────────────────
    case 'join_room': {
      if (!pd) { ws.send(JSON.stringify({ type: 'error', msg: 'Identifícate primero' })); return; }
      const room = rooms.get(msg.roomId);
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Sala no encontrada' })); return; }
      if (room.isFull()) { ws.send(JSON.stringify({ type: 'error', msg: 'Sala llena' })); return; }
      if (room.password && room.password !== msg.password) { ws.send(JSON.stringify({ type: 'error', msg: 'Contraseña incorrecta' })); return; }
      if (pd.room) leaveRoom(ws, pd);

      const player = { ws, clientId: ws.clientId, username: pd.username, playerId: 2, charId: msg.charId || 1, ready: false };
      room.players.push(player);
      pd.room = msg.roomId;

      ws.send(JSON.stringify({ type: 'room_joined', roomId: room.id, playerId: 2, mode: room.mode }));

      // Notify P1
      room.broadcastPlayers({ type: 'opponent_joined', username: pd.username, elo: pd.elo, rank: pd.rank }, player);

      // If both in, send ready-check
      if (room.isFull()) {
        room.broadcastPlayers({
          type: 'both_connected',
          p1: { username: room.players[0].username, elo: getOrCreateElo(room.players[0].username).elo, rank: getRank(getOrCreateElo(room.players[0].username).elo) },
          p2: { username: room.players[1].username, elo: getOrCreateElo(room.players[1].username).elo, rank: getRank(getOrCreateElo(room.players[1].username).elo) },
        });
      }
      console.log(`[Room] ${pd.username} joined ${room.id}`);
      broadcastLobby();
      break;
    }

    // ── JOIN AS SPECTATOR ────────────────────────────────────
    case 'spectate': {
      const room = rooms.get(msg.roomId);
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Sala no encontrada' })); return; }
      room.spectators.push(ws);
      ws.send(JSON.stringify({ type: 'spectating', roomId: room.id, state: room.gameState }));
      break;
    }

    // ── CHAR SELECTION ───────────────────────────────────────
    case 'select_char': {
      if (!pd?.room) return;
      const room = rooms.get(pd.room);
      if (!room) return;
      const player = room.players.find(p => p.clientId === ws.clientId);
      if (player) {
        player.charId  = msg.charId;
        player.charName = msg.charName;
        room.broadcastPlayers({ type: 'opponent_char', charId: msg.charId, charName: msg.charName, playerId: player.playerId }, player);
      }
      break;
    }

    // ── READY ────────────────────────────────────────────────
    case 'ready': {
      if (!pd?.room) return;
      const room = rooms.get(pd.room);
      if (!room || !room.isFull()) return;
      const player = room.players.find(p => p.clientId === ws.clientId);
      if (player) {
        player.ready   = true;
        player.charId  = msg.charId ?? player.charId;
        player.stageId = msg.stageId ?? 0;
      }
      room.broadcastPlayers({ type: 'player_ready', playerId: player.playerId });

      if (room.players.every(p => p.ready)) {
        room.state = 'playing';
        const stageId = room.players[0].stageId ?? 0;
        const startData = {
          type:    'game_start',
          stageId,
          p1: { username: room.players[0].username, charId: room.players[0].charId },
          p2: { username: room.players[1].username, charId: room.players[1].charId },
        };
        room.broadcast(startData);
        console.log(`[Room] Game started in ${room.id}`);
      }
      break;
    }

    // ── GAME INPUT (relay to opponent) ───────────────────────
    case 'input': {
      if (!pd?.room) return;
      const room = rooms.get(pd.room);
      if (!room) return;
      const player = room.players.find(p => p.clientId === ws.clientId);
      if (!player) return;
      // Relay input to opponent + spectators with sender's playerId
      const relayMsg = JSON.stringify({ type: 'input', playerId: player.playerId, ...msg });
      room.players.forEach(p => {
        if (p !== player && p.ws.readyState === WebSocket.OPEN) p.ws.send(relayMsg);
      });
      room.spectators.forEach(s => { if (s.readyState === WebSocket.OPEN) s.send(relayMsg); });
      break;
    }

    // ── GAME STATE SYNC (authoritative from P1) ──────────────
    case 'state_sync': {
      if (!pd?.room) return;
      const room = rooms.get(pd.room);
      if (!room) return;
      const player = room.players.find(p => p.clientId === ws.clientId);
      if (!player || player.playerId !== 1) return;
      room.gameState = msg.state;
      // Relay to P2 + spectators
      const syncMsg = JSON.stringify({ type: 'state_sync', state: msg.state });
      room.players.forEach(p => {
        if (p !== player && p.ws.readyState === WebSocket.OPEN) p.ws.send(syncMsg);
      });
      room.spectators.forEach(s => { if (s.readyState === WebSocket.OPEN) s.send(syncMsg); });
      break;
    }

    // ── ROUND RESULT ─────────────────────────────────────────
    case 'round_result': {
      if (!pd?.room) return;
      const room = rooms.get(pd.room);
      if (!room) return;
      room.broadcast({ type: 'round_result', ...msg });
      break;
    }

    // ── MATCH OVER ───────────────────────────────────────────
    case 'match_over': {
      if (!pd?.room) return;
      const room = rooms.get(pd.room);
      if (!room) return;
      room.state = 'finished';

      const winnerName = msg.winner; // username string
      const loserName  = room.players.find(p => p.username !== winnerName)?.username;

      if (room.mode === 'competitive' && winnerName && loserName) {
        const winnerEloData = getOrCreateElo(winnerName);
        const loserEloData  = getOrCreateElo(loserName);
        const result = calcElo(winnerEloData.elo, loserEloData.elo);
        winnerEloData.elo     = result.winnerNew;
        winnerEloData.wins++;
        winnerEloData.streak  = (winnerEloData.streak > 0 ? winnerEloData.streak : 0) + 1;
        loserEloData.elo      = result.loserNew;
        loserEloData.losses++;
        loserEloData.streak   = (loserEloData.streak < 0 ? loserEloData.streak : 0) - 1;

        room.broadcast({
          type:       'elo_update',
          winner:     winnerName,
          loser:      loserName,
          winnerElo:  result.winnerNew,
          loserElo:   result.loserNew,
          winnerGain: result.winnerGain,
          loserLoss:  result.loserLoss,
          winnerRank: getRank(result.winnerNew),
          loserRank:  getRank(result.loserNew),
        });
      }

      room.broadcast({ type: 'match_over', winner: winnerName, stats: msg.stats || {} });
      console.log(`[Room] Match over in ${room.id}. Winner: ${winnerName}`);

      // Clean up room after delay
      setTimeout(() => { rooms.delete(room.id); broadcastLobby(); }, 15000);
      break;
    }

    // ── CHAT ─────────────────────────────────────────────────
    case 'chat': {
      if (!pd?.room) return;
      const room = rooms.get(pd.room);
      if (!room) return;
      const clean = (msg.text || '').substring(0, 100).replace(/</g, '&lt;');
      room.broadcast({ type: 'chat', username: pd?.username || '?', text: clean });
      break;
    }

    // ── COMPETITIVE QUEUE ─────────────────────────────────────
    case 'queue_join': {
      if (!pd) { ws.send(JSON.stringify({ type: 'error', msg: 'Identifícate primero' })); return; }
      if (pd.room) leaveRoom(ws, pd);

      // Remove if already queuing
      const qi = queue.findIndex(q => q.clientId === ws.clientId);
      if (qi !== -1) queue.splice(qi, 1);

      queue.push({ ws, clientId: ws.clientId, username: pd.username, elo: pd.elo, charId: msg.charId || 0, joinedAt: Date.now() });
      ws.send(JSON.stringify({ type: 'queue_joined', position: queue.length, estimated: estimateWait() }));
      console.log(`[Queue] ${pd.username} (ELO:${pd.elo}) joined. Queue size: ${queue.length}`);
      tryMatch();
      break;
    }

    case 'queue_leave': {
      const qi = queue.findIndex(q => q.clientId === ws.clientId);
      if (qi !== -1) queue.splice(qi, 1);
      ws.send(JSON.stringify({ type: 'queue_left' }));
      break;
    }

    // ── PING ────────────────────────────────────────────────
    case 'ping': {
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
      break;
    }

    // ── LEADERBOARD ──────────────────────────────────────────
    case 'get_leaderboard': {
      const lb = [];
      eloStore.forEach((data, username) => { lb.push({ username, ...data, rank: getRank(data.elo) }); });
      lb.sort((a, b) => b.elo - a.elo);
      ws.send(JSON.stringify({ type: 'leaderboard', data: lb.slice(0, 20) }));
      break;
    }
  }
}

// ── COMPETITIVE MATCHMAKING ────────────────────────────────────
function tryMatch() {
  if (queue.length < 2) return;

  // Sort by ELO
  queue.sort((a, b) => a.elo - b.elo);

  // Find closest ELO pair — expand range over time in queue
  let bestI = -1, bestJ = -1, bestDiff = Infinity;
  for (let i = 0; i < queue.length - 1; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const diff = Math.abs(queue[i].elo - queue[j].elo);
      const waitBonus = Math.min((Date.now() - queue[i].joinedAt) / 1000 * 10, 200);
      const adjusted  = diff - waitBonus;
      if (adjusted < bestDiff) { bestDiff = adjusted; bestI = i; bestJ = j; }
    }
  }

  if (bestI === -1 || bestDiff > 400) return; // Too far apart

  const qp1 = queue[bestI];
  const qp2 = queue[bestJ];
  queue.splice(Math.max(bestI, bestJ), 1);
  queue.splice(Math.min(bestI, bestJ), 1);

  // Create competitive room
  const roomId = 'COMP_' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const room   = new Room(roomId, 'competitive');
  rooms.set(roomId, room);

  const pl1 = { ws: qp1.ws, clientId: qp1.clientId, username: qp1.username, playerId: 1, charId: qp1.charId, ready: false };
  const pl2 = { ws: qp2.ws, clientId: qp2.clientId, username: qp2.username, playerId: 2, charId: qp2.charId, ready: false };
  room.players.push(pl1, pl2);

  const pd1 = playerData.get(qp1.clientId);
  const pd2 = playerData.get(qp2.clientId);
  if (pd1) pd1.room = roomId;
  if (pd2) pd2.room = roomId;

  const matchData = {
    type: 'match_found',
    roomId,
    p1: { username: qp1.username, elo: qp1.elo, rank: getRank(qp1.elo) },
    p2: { username: qp2.username, elo: qp2.elo, rank: getRank(qp2.elo) },
  };
  qp1.ws.send(JSON.stringify({ ...matchData, yourId: 1 }));
  qp2.ws.send(JSON.stringify({ ...matchData, yourId: 2 }));

  console.log(`[Competitive] Matched: ${qp1.username} (${qp1.elo}) vs ${qp2.username} (${qp2.elo})`);

  // Auto-start after character lock delay
  setTimeout(() => {
    if (room.state === 'waiting') {
      room.state = 'playing';
      room.broadcast({ type: 'game_start', stageId: Math.floor(Math.random() * 12), p1: { username: pl1.username, charId: pl1.charId }, p2: { username: pl2.username, charId: pl2.charId } });
    }
  }, 8000);
}

function estimateWait() {
  if (queue.length === 0) return 30;
  return Math.max(5, 30 - queue.length * 5);
}

// ── DISCONNECT HANDLER ────────────────────────────────────────
function handleDisconnect(ws) {
  // Remove from queue
  const qi = queue.findIndex(q => q.clientId === ws.clientId);
  if (qi !== -1) queue.splice(qi, 1);

  const pd = playerData.get(ws.clientId);
  if (pd?.room) leaveRoom(ws, pd);
  playerData.delete(ws.clientId);
  broadcastLobby();
}

function leaveRoom(ws, pd) {
  if (!pd?.room) return;
  const room = rooms.get(pd.room);
  if (!room) { pd.room = null; return; }

  const playerIdx = room.players.findIndex(p => p.clientId === ws.clientId);
  if (playerIdx !== -1) {
    room.players.splice(playerIdx, 1);
    if (room.state === 'playing') {
      room.broadcast({ type: 'opponent_disconnected', username: pd.username });
      rooms.delete(pd.room);
    } else if (room.isEmpty()) {
      rooms.delete(pd.room);
    }
  }
  // Remove from spectators
  const si = room.spectators.indexOf(ws);
  if (si !== -1) room.spectators.splice(si, 1);

  pd.room = null;
  broadcastLobby();
}

function broadcastLobby() {
  const list = [];
  rooms.forEach(r => { if (r.mode === 'casual') list.push(r.toInfo()); });
  const msg = JSON.stringify({ type: 'lobby_update', rooms: list, online: wss.clients.size, queue: queue.length });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ── REST ENDPOINTS ────────────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  const lb = [];
  eloStore.forEach((data, username) => lb.push({ username, ...data, rank: getRank(data.elo) }));
  lb.sort((a, b) => b.elo - a.elo);
  res.json(lb.slice(0, 50));
});

app.get('/api/stats', (req, res) => {
  res.json({ online: wss.clients.size, rooms: rooms.size, queue: queue.length });
});

// ── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ NEON CLASH Server on port ${PORT}`);
});
