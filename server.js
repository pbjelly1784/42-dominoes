'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { deal, tileScore, trickWinner, validBidsFor, scoreHand, isTrump } = require('./src/gameLogic');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Room storage ─────────────────────────────────────────────────────────────

const rooms = new Map(); // roomCode -> Room

function makeRoom(code) {
  return {
    code,
    seats: [null, null, null, null], // { socketId, name }
    state: 'lobby',    // lobby | bidding | trump_select | playing | hand_end | game_over
    hands: [[], [], [], []],
    bid: null,         // { amount, special, seatIndex, label }
    bids: [],          // history per round
    currentBidder: 0,
    passCount: 0,
    trump: null,       // 0-6 or null
    trick: [],         // [{ seatIndex, tile }]
    tricksTaken: [0, 0, 0, 0],
    pointsTaken: [0, 0, 0, 0],
    trickCount: [0, 0, 0, 0],
    currentPlayer: 0,
    score: [0, 0],     // marks: team0, team1
    dealer: 0,
    lastTrick: null,
    handHistory: [],
  };
}

function roomSummary(room) {
  return {
    code: room.code,
    seats: room.seats,
    state: room.state,
    bid: room.bid,
    bids: room.bids,
    currentBidder: room.currentBidder,
    trump: room.trump,
    trick: room.trick,
    tricksTaken: room.tricksTaken,
    pointsTaken: room.pointsTaken,
    trickCount: room.trickCount,
    currentPlayer: room.currentPlayer,
    score: room.score,
    dealer: room.dealer,
    lastTrick: room.lastTrick,
    handHistory: room.handHistory,
  };
}

function broadcastRoom(room) {
  // Send each player their own hand privately, rest is public
  for (let i = 0; i < 4; i++) {
    const seat = room.seats[i];
    if (!seat) continue;
    io.to(seat.socketId).emit('state', {
      ...roomSummary(room),
      myHand: room.hands[i],
      mySeat: i,
    });
  }
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    for (let i = 0; i < 4; i++) {
      if (room.seats[i]?.socketId === socketId) return { room, seat: i };
    }
  }
  return null;
}

// ─── Game flow ────────────────────────────────────────────────────────────────

function startBidding(room) {
  const hands = deal();
  room.hands = hands;
  room.bid = { amount: 0, special: null, seatIndex: -1, label: '' };
  room.bids = [];
  room.passCount = 0;
  room.trump = null;
  room.trick = [];
  room.tricksTaken = [0, 0, 0, 0];
  room.pointsTaken = [0, 0, 0, 0];
  room.trickCount = [0, 0, 0, 0];
  room.lastTrick = null;
  room.currentBidder = (room.dealer + 1) % 4;
  room.state = 'bidding';
  broadcastRoom(room);
}

function advanceBidder(room) {
  room.currentBidder = (room.currentBidder + 1) % 4;
  // Skip if passed
  const startSeat = room.currentBidder;
  let loops = 0;
  while (room.bids.find(b => b.seatIndex === room.currentBidder && b.special === 'pass')) {
    room.currentBidder = (room.currentBidder + 1) % 4;
    if (++loops > 4) break;
    if (room.currentBidder === startSeat) break;
  }
}

function checkBiddingDone(room) {
  // Count active (non-passed) bidders
  const passed = new Set(room.bids.filter(b => b.special === 'pass').map(b => b.seatIndex));
  const active = [0, 1, 2, 3].filter(i => !passed.has(i));
  return active.length === 1 || room.bid.special === 'plunge' || room.bid.special === 'follow_me';
}

function openTrumpSelect(room) {
  room.state = 'trump_select';
  broadcastRoom(room);
}

function startPlay(room, trump) {
  room.trump = trump;
  room.state = 'playing';
  room.currentPlayer = room.bid.seatIndex; // winner of bid leads first
  broadcastRoom(room);
}

function resolveHand(room) {
  const delta = scoreHand(room.bid, room.trickCount, room.pointsTaken);
  room.score[0] += delta[0];
  room.score[1] += delta[1];

  const bidTeam = room.bid.seatIndex % 2;
  room.handHistory.push({
    bid: room.bid,
    delta,
    score: [...room.score],
    bidTeam,
    made: delta[bidTeam] > 0,
  });

  room.state = room.score[0] >= 7 || room.score[1] >= 7 ? 'game_over' : 'hand_end';
  room.dealer = (room.dealer + 1) % 4;
  broadcastRoom(room);
}

// ─── Socket handlers ──────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('createRoom', ({ name }) => {
    let code;
    do { code = Math.random().toString(36).slice(2, 6).toUpperCase(); }
    while (rooms.has(code));

    const room = makeRoom(code);
    room.seats[0] = { socketId: socket.id, name };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('joined', { code, seat: 0, name });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.state !== 'lobby') { socket.emit('error', 'Game already in progress'); return; }

    const emptySeat = room.seats.findIndex(s => s === null);
    if (emptySeat === -1) { socket.emit('error', 'Room is full'); return; }

    room.seats[emptySeat] = { socketId: socket.id, name };
    socket.join(code);
    socket.emit('joined', { code, seat: emptySeat, name });
    broadcastRoom(room);
  });

  socket.on('startGame', () => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room, seat } = found;
    if (seat !== 0) { socket.emit('error', 'Only the host can start the game'); return; }
    if (room.seats.some(s => s === null)) { socket.emit('error', 'Need 4 players to start'); return; }
    startBidding(room);
  });

  socket.on('placeBid', ({ amount, special }) => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room, seat } = found;
    if (room.state !== 'bidding') return;
    if (room.currentBidder !== seat) { socket.emit('error', 'Not your turn to bid'); return; }

    const label = special === 'pass' ? 'Pass'
      : special === 'low' ? 'Low'
      : special === 'plunge' ? 'Plunge'
      : special === 'follow_me' ? 'Follow Me'
      : String(amount);

    const thisBid = { amount, special: special || null, seatIndex: seat, label };

    if (special === 'pass') {
      room.bids.push(thisBid);
      room.passCount++;
      // If 3 passed and someone has bid, or all 4 passed dealer must take 30
      const passed = room.bids.filter(b => b.special === 'pass').length;
      if (passed === 3 && room.bid.seatIndex !== -1) {
        // bidding done
        room.bids.push(thisBid); // ensure recorded
        openTrumpSelect(room);
        return;
      }
      if (passed === 4) {
        // Force dealer to bid 30
        room.bid = { amount: 30, special: null, seatIndex: room.dealer, label: '30 (forced)' };
        room.bids.push(room.bid);
        openTrumpSelect(room);
        return;
      }
      advanceBidder(room);
      broadcastRoom(room);
      return;
    }

    // Non-pass
    room.bid = thisBid;
    room.bids.push(thisBid);

    if (checkBiddingDone(room)) {
      openTrumpSelect(room);
    } else {
      advanceBidder(room);
      broadcastRoom(room);
    }
  });

  socket.on('selectTrump', ({ trump }) => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room, seat } = found;
    if (room.state !== 'trump_select') return;
    if (room.bid.seatIndex !== seat) { socket.emit('error', 'Only the bid winner selects trump'); return; }
    if (trump < 0 || trump > 6) return;
    startPlay(room, trump);
  });

  socket.on('playTile', ({ tileId }) => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room, seat } = found;
    if (room.state !== 'playing') return;
    if (room.currentPlayer !== seat) { socket.emit('error', 'Not your turn'); return; }

    const hand = room.hands[seat];
    const tileIdx = hand.findIndex(t => t.id === tileId);
    if (tileIdx === -1) { socket.emit('error', 'Tile not in hand'); return; }

    // Basic follow-suit validation (only if not leading)
    if (room.trick.length > 0) {
      const leadTile = room.trick[0].tile;
      const trump = room.trump;
      const leadIsThump = isTrump(leadTile, trump);
      const leadSuit = leadIsThump ? trump : (leadTile.hi === trump ? leadTile.lo : leadTile.hi);

      const tile = hand[tileIdx];
      const tileIsTrump = isTrump(tile, trump);
      const canFollowSuit = hand.some(t => {
        if (leadIsThump) return isTrump(t, trump);
        return !isTrump(t, trump) && (t.hi === leadSuit || t.lo === leadSuit);
      });

      if (canFollowSuit) {
        const follows = leadIsThump ? tileIsTrump : (!tileIsTrump && (tile.hi === leadSuit || tile.lo === leadSuit));
        if (!follows) { socket.emit('error', 'Must follow suit'); return; }
      }
    }

    const tile = hand.splice(tileIdx, 1)[0];
    room.trick.push({ seatIndex: seat, tile });

    if (room.trick.length === 4) {
      // Resolve trick
      const winnerSeat = trickWinner(room.trick, room.trump);
      const pts = room.trick.reduce((s, p) => s + tileScore(p.tile), 0) + 1; // +1 for trick point
      room.pointsTaken[winnerSeat] += pts;
      room.trickCount[winnerSeat]++;
      room.tricksTaken[winnerSeat]++;
      room.lastTrick = { plays: [...room.trick], winner: winnerSeat };
      room.trick = [];
      room.currentPlayer = winnerSeat;

      const totalTricks = room.trickCount.reduce((a, b) => a + b, 0);
      if (totalTricks === 7) {
        resolveHand(room);
        return;
      }
    } else {
      room.currentPlayer = (seat + 1) % 4;
    }
    broadcastRoom(room);
  });

  socket.on('nextHand', () => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room } = found;
    if (room.state === 'hand_end') startBidding(room);
  });

  socket.on('disconnect', () => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room, seat } = found;
    room.seats[seat] = { ...room.seats[seat], disconnected: true };
    broadcastRoom(room);
  });

  socket.on('rejoin', ({ code, seat, name }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.seats[seat]?.name !== name) { socket.emit('error', 'Name mismatch'); return; }
    room.seats[seat] = { socketId: socket.id, name };
    socket.join(code.toUpperCase());
    socket.emit('joined', { code: room.code, seat, name });
    broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`42 Dominoes server running on port ${PORT}`));
