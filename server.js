const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Room storage ──────────────────────────────────────────────────
const rooms = {};   // roomCode → RoomState

const RANKS = ['Admiral','Captain','Commander','Commodore','Lieutenant','Ensign'];
const SHIP_COLORS = ['#00d0f8','#f02040','#30e860','#f0c000','#b030f8','#f07020'];

function makeCode() {
  const w = ['WOLF','HAWK','BEAR','SHARK','EAGLE','VIPER','STORM','TITAN'];
  return w[Math.floor(Math.random()*w.length)] + '-' + (10 + Math.floor(Math.random()*90));
}
function makeToken() { return crypto.randomBytes(16).toString('hex'); }

function getRoomOf(socketId) {
  return Object.values(rooms).find(r => r.players.has(socketId)) || null;
}

function getPlayer(room, socketId) {
  return room.players.get(socketId);
}

// ── Fog-of-war view of a player's grid ────────────────────────────
// Returns only hit/miss cells (no ship positions) unless it's your own grid
function fogGrid(grid) {
  return Array.from(grid).map(v => v === 2 ? 2 : v === 3 ? 3 : 0);
}

// ── Build state payload for one socket ────────────────────────────
function stateFor(room, socketId) {
  const me = room.players.get(socketId);
  const playerList = room.order.map(id => {
    const p = room.players.get(id);
    return {
      id,
      name: p.name,
      rank: p.rank,
      pIdx: p.pIdx,
      color: p.color,
      ready: p.ready,
      shots: p.shots,
      hits: p.hits,
      shipsSunk: p.shipsSunk,
      shipsAlive: p.ships.filter(s => !s.sunk).length,
      totalShips: p.ships.length,
      eliminated: p.eliminated,
      connected: p.connected,
      isMe: id === socketId,
    };
  });

  // My own full grid + ships
  const myGrid = me ? Array.from(me.grid) : [];
  const myShips = me ? me.ships.map(s => ({
    name: s.name, abbr: s.abbr, size: s.size,
    cells: s.cells, sunk: s.sunk, hits: s.hits,
  })) : [];

  // Enemy grids — fog of war (hit/miss only)
  const enemyGrids = {};
  room.order.forEach(id => {
    if (id !== socketId) {
      const p = room.players.get(id);
      enemyGrids[id] = fogGrid(p.grid);
    }
  });

  const curId = room.order[room.curIdx] || null;

  return {
    roomCode: room.code,
    phase: room.phase,
    players: playerList,
    myId: socketId,
    myPIdx: me ? me.pIdx : -1,
    myGrid,
    myShips,
    enemyGrids,
    currentPlayerId: curId,
    isMyTurn: curId === socketId,
    turn: room.turn,
    winner: room.winner,
    hostId: room.hostId,
  };
}

function broadcastState(room) {
  room.players.forEach((_, socketId) => {
    const sock = io.sockets.sockets.get(socketId);
    if (sock) sock.emit('state', stateFor(room, socketId));
  });
}

// ── Socket handlers ───────────────────────────────────────────────
io.on('connection', socket => {
  socket.emit('server-info', { url: SERVER_URL });

  // ── Create room ──────────────────────────────────────────────
  socket.on('create-room', ({ name }) => {
    let code = makeCode();
    while (rooms[code]) code = makeCode();

    const player = {
      id: socket.id,
      name: name || 'Admiral',
      rank: RANKS[0],
      pIdx: 0,
      color: SHIP_COLORS[0],
      grid: new Array(100).fill(0),
      ships: [],
      ready: false,
      shots: 0, hits: 0, shipsSunk: 0,
      eliminated: false,
      connected: true,
      token: makeToken(),
      aiTargets: [], aiHunting: false,
    };

    rooms[code] = {
      code,
      hostId: socket.id,
      phase: 'lobby',    // lobby → placement → game → over
      order: [socket.id],
      players: new Map([[socket.id, player]]),
      curIdx: 0,
      turn: 0,
      winner: null,
    };

    socket.join(code);
    socket.emit('joined', { roomCode: code, pIdx: 0, token: player.token });
    socket.emit('state', stateFor(rooms[code], socket.id));
  });

  // ── Join room ────────────────────────────────────────────────
  socket.on('join-room', ({ code, name }) => {
    const room = rooms[code.toUpperCase()];
    if (!room) { socket.emit('error', { msg: 'Room not found. Check the code and try again.' }); return; }
    if (room.phase !== 'lobby') { socket.emit('error', { msg: 'Game already in progress.' }); return; }
    if (room.players.size >= 6) { socket.emit('error', { msg: 'Room is full (6 players max).' }); return; }

    const pIdx = room.players.size;
    const player = {
      id: socket.id,
      name: name || `Player ${pIdx + 1}`,
      rank: RANKS[pIdx] || RANKS[5],
      pIdx,
      color: SHIP_COLORS[pIdx],
      grid: new Array(100).fill(0),
      ships: [],
      ready: false,
      shots: 0, hits: 0, shipsSunk: 0,
      eliminated: false,
      connected: true,
      token: makeToken(),
      aiTargets: [], aiHunting: false,
    };

    room.players.set(socket.id, player);
    room.order.push(socket.id);
    socket.join(code);

    socket.emit('joined', { roomCode: code, pIdx, token: player.token });
    broadcastState(room);
  });

  // ── Kick / remove player (host only) ────────────────────────
  socket.on('kick-player', ({ targetId }) => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (targetId === socket.id) return; // host cannot remove themselves
    const target = io.sockets.sockets.get(targetId);
    if (target) { target.emit('kicked'); target.leave(room.code); }

    if (room.phase === 'lobby') {
      room.players.delete(targetId);
      room.order = room.order.filter(id => id !== targetId);
      room.order.forEach((id, i) => {
        const p = room.players.get(id);
        p.pIdx = i; p.rank = RANKS[i] || RANKS[5]; p.color = SHIP_COLORS[i];
      });
    } else {
      // During placement or game: eliminate the player
      const tp = room.players.get(targetId);
      if (tp) { tp.eliminated = true; tp.connected = false; }
      // If it was their turn, advance
      if (room.phase === 'game' && room.order[room.curIdx] === targetId) {
        let next = (room.curIdx + 1) % room.order.length;
        let tries = 0;
        while (room.players.get(room.order[next]).eliminated && tries < room.order.length) {
          next = (next + 1) % room.order.length; tries++;
        }
        room.curIdx = next; room.turn++;
      }
      // Check win condition
      const alive = room.order.filter(id => !room.players.get(id).eliminated);
      if (alive.length === 1) {
        room.phase = 'over'; room.winner = alive[0];
        broadcastState(room); return;
      }
    }
    broadcastState(room);
  });

  // ── Rejoin room ──────────────────────────────────────────────
  socket.on('rejoin-room', ({ code, token }) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) { socket.emit('error', { msg: 'Room not found.' }); return; }
    if (room.phase === 'over') { socket.emit('error', { msg: 'That battle has already ended.' }); return; }

    let oldId = null;
    for (const [id, p] of room.players) {
      if (p.token === token) { oldId = id; break; }
    }
    if (!oldId) { socket.emit('error', { msg: 'Session expired. Join as a new player.' }); return; }

    const player = room.players.get(oldId);
    if (player.connected) { socket.emit('error', { msg: 'Already connected from another device.' }); return; }

    // Remap to new socket ID
    room.players.delete(oldId);
    player.id = socket.id;
    player.connected = true;
    // Only un-eliminate if their ships aren't all sunk (i.e. they were kicked, not defeated)
    if (player.ships.length === 0 || !player.ships.every(s => s.sunk)) {
      player.eliminated = false;
    }
    room.players.set(socket.id, player);

    const orderIdx = room.order.indexOf(oldId);
    if (orderIdx !== -1) room.order[orderIdx] = socket.id;
    if (room.hostId === oldId) room.hostId = socket.id;

    socket.join(room.code);
    socket.emit('joined', { roomCode: room.code, pIdx: player.pIdx, token: player.token, isRejoin: true });
    broadcastState(room);
  });

  // ── Start game (host only) ───────────────────────────────────
  socket.on('start-game', () => {
    const room = getRoomOf(socket.id);
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    if (room.players.size < 2) { socket.emit('error', { msg: 'Need at least 2 players to start.' }); return; }
    room.phase = 'placement';
    broadcastState(room);
  });

  // ── Submit ship placement ────────────────────────────────────
  socket.on('place-ready', ({ grid, ships }) => {
    const room = getRoomOf(socket.id);
    if (!room || room.phase !== 'placement') return;
    const player = getPlayer(room, socket.id);
    if (!player || player.ready) return;

    // Basic validation
    if (!Array.isArray(grid) || grid.length !== 100) return;
    if (!Array.isArray(ships) || ships.length < 1) return;

    player.grid = grid;
    player.ships = ships;
    player.ready = true;

    broadcastState(room);

    // If all players ready → start game
    if ([...room.players.values()].every(p => p.ready)) {
      room.phase = 'game';
      room.curIdx = 0;
      room.turn = 1;
      broadcastState(room);
    }
  });

  // ── Attack ───────────────────────────────────────────────────
  socket.on('attack', ({ targetId, cellIdx }) => {
    const room = getRoomOf(socket.id);
    if (!room || room.phase !== 'game') return;

    const curId = room.order[room.curIdx];
    if (socket.id !== curId) { socket.emit('error', { msg: "It's not your turn." }); return; }

    const attacker = getPlayer(room, socket.id);
    const target = room.players.get(targetId);
    if (!target || target.eliminated || target.id === socket.id) return;
    if (target.grid[cellIdx] === 2 || target.grid[cellIdx] === 3) return;

    const isHit = target.grid[cellIdx] === 1;
    attacker.shots++;
    if (isHit) attacker.hits++;
    target.grid[cellIdx] = isHit ? 2 : 3;

    let sunkShip = null;
    if (isHit) {
      for (const ship of target.ships) {
        if (!ship.sunk && ship.cells.includes(cellIdx)) {
          ship.hits++;
          if (ship.cells.every(c => target.grid[c] === 2)) {
            ship.sunk = true;
            sunkShip = ship;
            attacker.shipsSunk++;
          }
          break;
        }
      }
    }

    const allSunk = target.ships.every(s => s.sunk);
    if (allSunk) target.eliminated = true;

    // Broadcast attack event to ALL players in room (for animation)
    io.to(room.code).emit('attack-result', {
      attackerId: socket.id,
      targetId,
      cellIdx,
      isHit,
      sunkShip: sunkShip ? { name: sunkShip.name, cells: sunkShip.cells } : null,
      eliminated: allSunk,
    });

    // Check win condition
    const alive = room.order.filter(id => !room.players.get(id).eliminated);
    if (alive.length === 1) {
      room.phase = 'over';
      room.winner = alive[0];
      broadcastState(room);
      return;
    }

    // Advance turn, skipping eliminated players
    let next = (room.curIdx + 1) % room.order.length;
    let tries = 0;
    while (room.players.get(room.order[next]).eliminated && tries < room.order.length) {
      next = (next + 1) % room.order.length;
      tries++;
    }
    room.curIdx = next;
    room.turn++;
    broadcastState(room);
  });

  // ── Disconnect ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    const room = getRoomOf(socket.id);
    if (!room) return;

    const player = getPlayer(room, socket.id);
    if (player) player.connected = false;

    if (room.phase === 'lobby') {
      room.players.delete(socket.id);
      room.order = room.order.filter(id => id !== socket.id);
      // Reassign indices
      room.order.forEach((id, i) => {
        const p = room.players.get(id);
        p.pIdx = i; p.rank = RANKS[i] || RANKS[5]; p.color = SHIP_COLORS[i];
      });
      // If host left, transfer host
      if (room.hostId === socket.id && room.order.length > 0) {
        room.hostId = room.order[0];
      }
      if (room.players.size === 0) { delete rooms[room.code]; return; }
    }

    broadcastState(room);
  });
});

// ── Start server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
let SERVER_URL = `http://localhost:${PORT}`;
httpServer.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(nets).flat()) {
    if (iface.family === 'IPv4' && !iface.internal) { localIP = iface.address; break; }
  }
  SERVER_URL = `http://${localIP}:${PORT}`;
  console.log(`\n⚓  Naval Warfare server running`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${localIP}:${PORT}  ← share this with players on your WiFi\n`);
});
