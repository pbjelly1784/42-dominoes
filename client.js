'use strict';

// ─── Socket setup ─────────────────────────────────────────────────────────────
const socket = io();

// ─── App state ────────────────────────────────────────────────────────────────
let myName = '';
let myRoom = '';
let mySeat = -1;
let lastState = null;

// ─── Screen helpers ───────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ─── Lobby wiring ─────────────────────────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click', () => {
  const name = document.getElementById('player-name').value.trim();
  if (!name) { setLobbyError('Enter your name first'); return; }
  myName = name;
  socket.emit('createRoom', { name });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const name = document.getElementById('player-name').value.trim();
  const code = document.getElementById('room-code-input').value.trim();
  if (!name) { setLobbyError('Enter your name first'); return; }
  if (!code) { setLobbyError('Enter a room code'); return; }
  myName = name;
  socket.emit('joinRoom', { name, code });
});

document.getElementById('player-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-create').click();
});
document.getElementById('room-code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-join').click();
});

function setLobbyError(msg) {
  document.getElementById('lobby-error').textContent = msg;
}

// ─── Copy room code ───────────────────────────────────────────────────────────
document.getElementById('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard.writeText(myRoom).then(() => {
    document.getElementById('btn-copy-code').textContent = '✓';
    setTimeout(() => document.getElementById('btn-copy-code').textContent = '⧉', 1500);
  });
});

// ─── Start game ───────────────────────────────────────────────────────────────
document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('startGame');
  document.getElementById('waiting-error').textContent = '';
});

// ─── Next hand ────────────────────────────────────────────────────────────────
document.getElementById('btn-next-hand').addEventListener('click', () => {
  socket.emit('nextHand');
  hideOverlay('overlay-hand-end');
});

// ─── Play again (reload lobby) ────────────────────────────────────────────────
document.getElementById('btn-play-again').addEventListener('click', () => {
  location.reload();
});

// ─── Overlay helpers ──────────────────────────────────────────────────────────
function showOverlay(id) { document.getElementById(id).classList.remove('hidden'); }
function hideOverlay(id) { document.getElementById(id).classList.add('hidden'); }
function hideAllOverlays() {
  ['overlay-bid','overlay-trump','overlay-hand-end','overlay-game-over'].forEach(hideOverlay);
}

// ─── Socket events ────────────────────────────────────────────────────────────
socket.on('error', msg => {
  const lobbyErr = document.getElementById('lobby-error');
  const waitErr  = document.getElementById('waiting-error');
  if (document.getElementById('screen-lobby').classList.contains('active')) setLobbyError(msg);
  else if (document.getElementById('screen-waiting').classList.contains('active')) waitErr.textContent = msg;
  else alert(msg);
});

socket.on('joined', ({ code, seat, name }) => {
  myRoom = code;
  mySeat = seat;
  myName = name;
  document.getElementById('display-code').textContent = code;
  document.getElementById('score-room-code').textContent = code;
  document.getElementById('btn-start').style.display = seat === 0 ? 'block' : 'none';
  showScreen('screen-waiting');
  // Store for potential rejoin
  sessionStorage.setItem('42-room', code);
  sessionStorage.setItem('42-seat', seat);
  sessionStorage.setItem('42-name', name);
});

socket.on('state', (state) => {
  lastState = state;
  if (state.state === 'lobby') {
    renderWaiting(state);
    if (!document.getElementById('screen-waiting').classList.contains('active')) {
      showScreen('screen-waiting');
    }
    return;
  }

  if (!document.getElementById('screen-game').classList.contains('active')) {
    showScreen('screen-game');
  }
  renderGame(state);
});

// ─── Waiting room render ──────────────────────────────────────────────────────
function renderWaiting(state) {
  const list = document.getElementById('seat-list');
  list.innerHTML = '';
  const teams = ['N/S','E/W','N/S','E/W'];
  const positions = ['North','East','South','West'];
  state.seats.forEach((seat, i) => {
    const row = document.createElement('div');
    row.className = `seat-row${!seat ? ' empty' : ''}`;
    row.innerHTML = `<span class="seat-num">${i+1}</span>
      <span>${seat ? (seat.disconnected ? seat.name + ' (away)' : seat.name) : 'Empty'}</span>
      <span class="seat-team">${positions[i]} · ${teams[i]}</span>`;
    list.appendChild(row);
  });
}

// ─── Game render ──────────────────────────────────────────────────────────────
const SUIT_NAMES = ['Blanks','Ones','Twos','Threes','Fours','Fives','Sixes'];

function seatOffset(targetSeat) {
  // Returns position relative to me: 0=bottom(me), 1=left, 2=top, 3=right (CCW)
  return ((targetSeat - mySeat + 4) % 4);
}

function positionForOffset(offset) {
  return ['bottom','left','top','right'][offset];
}

function renderGame(state) {
  // Score
  document.getElementById('marks-0').textContent = state.score[0];
  document.getElementById('marks-1').textContent = state.score[1];

  // Status label
  const statusLabels = {
    bidding: 'Bidding',
    trump_select: 'Selecting trump',
    playing: state.trump !== null ? `Trump: ${SUIT_NAMES[state.trump]}` : 'Playing',
    hand_end: 'Hand over',
    game_over: 'Game over',
  };
  document.getElementById('game-status-label').textContent = statusLabels[state.state] || '';

  // Trump display
  document.getElementById('trump-display').textContent =
    state.trump !== null ? `Trump\n${SUIT_NAMES[state.trump]}` : '';

  // Render each player's zone
  for (let s = 0; s < 4; s++) {
    const offset = seatOffset(s);
    const pos = positionForOffset(offset);
    const nameEl = document.getElementById(`name-${pos}`);
    const handEl = document.getElementById(`hand-${pos}`);

    if (!nameEl || !handEl) continue;

    // Name tag
    const seat = state.seats[s];
    let nameText = seat ? seat.name : `Seat ${s+1}`;
    if (s === state.dealer) nameText += '<span class="dealer-chip">D</span>';
    nameEl.innerHTML = nameText;

    const isCurrentPlayer = (state.state === 'playing' && state.currentPlayer === s)
      || (state.state === 'bidding' && state.currentBidder === s)
      || (state.state === 'trump_select' && state.bid?.seatIndex === s);
    nameEl.classList.toggle('active-player', isCurrentPlayer);
    document.getElementById(`zone-${pos}`)?.classList.toggle('zone-active', isCurrentPlayer);

    // Hand
    handEl.innerHTML = '';
    if (s === mySeat) {
      // My hand — render full tiles
      const isMyTurn = state.state === 'playing' && state.currentPlayer === mySeat;
      (state.myHand || []).forEach(tile => {
        const el = renderTile(tile, isMyTurn, state.trump);
        if (isMyTurn) {
          el.classList.add('playable');
          el.addEventListener('click', () => socket.emit('playTile', { tileId: tile.id }));
        }
        handEl.appendChild(el);
      });
    } else {
      // Opponent — show backs
      const count = getHandCount(state, s);
      for (let i = 0; i < count; i++) {
        const back = document.createElement('div');
        back.className = 'tile-back';
        handEl.appendChild(back);
      }
    }
  }

  // Trick area
  renderTrickArea(state);

  // Overlays
  hideAllOverlays();

  if (state.state === 'bidding' && state.currentBidder === mySeat) {
    renderBidOverlay(state);
    showOverlay('overlay-bid');
  } else if (state.state === 'trump_select' && state.bid?.seatIndex === mySeat) {
    renderTrumpOverlay(state);
    showOverlay('overlay-trump');
  } else if (state.state === 'hand_end') {
    renderHandEnd(state);
    showOverlay('overlay-hand-end');
  } else if (state.state === 'game_over') {
    renderGameOver(state);
    showOverlay('overlay-game-over');
  }

  // Last trick button
  if (state.lastTrick) {
    document.getElementById('overlay-last-trick').classList.remove('hidden');
    renderLastTrick(state);
  } else {
    document.getElementById('overlay-last-trick').classList.add('hidden');
  }
}

function getHandCount(state, seat) {
  // Approximate: 7 minus tricks taken so far
  const tricksPlayed = state.trickCount ? state.trickCount.reduce((a,b)=>a+b,0) : 0;
  return Math.max(0, 7 - tricksPlayed);
}

// ─── Tile renderer ────────────────────────────────────────────────────────────
function renderTile(tile, playable, trump) {
  const el = document.createElement('div');
  el.className = 'tile';
  if (trump !== null && (tile.hi === trump || tile.lo === trump)) {
    el.classList.add('trump-tile');
  }
  el.dataset.id = tile.id;

  const topHalf = document.createElement('div');
  topHalf.className = 'half';
  topHalf.appendChild(makePips(tile.hi));

  const divider = document.createElement('div');
  divider.className = 'divider';

  const botHalf = document.createElement('div');
  botHalf.className = 'half';
  botHalf.appendChild(makePips(tile.lo));

  el.appendChild(topHalf);
  el.appendChild(divider);
  el.appendChild(botHalf);
  return el;
}

// Pip layouts: positions for 0-6
const PIP_LAYOUTS = {
  0: [],
  1: [[1,1]],
  2: [[0,0],[2,2]],
  3: [[0,0],[1,1],[2,2]],
  4: [[0,0],[2,0],[0,2],[2,2]],
  5: [[0,0],[2,0],[1,1],[0,2],[2,2]],
  6: [[0,0],[2,0],[0,1],[2,1],[0,2],[2,2]],
};

function makePips(n) {
  const container = document.createElement('div');
  container.className = 'pips';
  container.dataset.n = n;

  if (n === 0) return container;

  const layout = PIP_LAYOUTS[n] || [];

  // Build 3x3 grid slots, place pips
  if (n <= 2) {
    layout.forEach(() => {
      const pip = document.createElement('div');
      pip.className = 'pip';
      container.appendChild(pip);
    });
    return container;
  }

  // For 3+, use absolute positioning in a small grid
  container.style.cssText = 'position:relative;width:28px;height:28px;';
  layout.forEach(([col, row]) => {
    const pip = document.createElement('div');
    pip.className = 'pip';
    pip.style.cssText = `position:absolute;left:${col*10}px;top:${row*10}px;`;
    container.appendChild(pip);
  });
  return container;
}

// ─── Trick area render ────────────────────────────────────────────────────────
function renderTrickArea(state) {
  const slots = {
    bottom: document.getElementById('trick-bottom'),
    left:   document.getElementById('trick-left'),
    top:    document.getElementById('trick-top'),
    right:  document.getElementById('trick-right'),
  };

  // Clear
  Object.values(slots).forEach(s => s.innerHTML = '');

  state.trick.forEach(play => {
    const offset = seatOffset(play.seatIndex);
    const pos = positionForOffset(offset);
    const slot = slots[pos];
    if (!slot) return;
    const tileEl = renderTile(play.tile, false, state.trump);
    // Highlight winner of last trick
    if (state.lastTrick && state.trick.length === 0) {
      // handled via lastTrick
    }
    slot.appendChild(tileEl);
  });

  // If trick just finished (lastTrick set, trick is empty) show winner highlight briefly
  if (state.lastTrick && state.trick.length === 0 && state.state === 'playing') {
    // Show last trick tiles briefly then clear — handled by lastTrick panel
  }
}

// ─── Bid overlay ──────────────────────────────────────────────────────────────
function renderBidOverlay(state) {
  const currentBid = state.bid;
  const label = currentBid?.label || 'None';
  document.getElementById('bid-current-label').textContent =
    `Current bid: ${label === '' ? 'None' : label}`;

  const grid = document.getElementById('bid-buttons');
  grid.innerHTML = '';

  // Numeric 30-42
  for (let b = 30; b <= 42; b++) {
    if (b > (currentBid?.amount || 29) && !currentBid?.special) {
      addBidBtn(grid, { amount: b, special: null, label: String(b) }, 'btn');
    }
  }

  // Doubling chain
  [84,126,168,210].forEach(d => {
    if (!currentBid?.special && d > (currentBid?.amount || 0)) {
      addBidBtn(grid, { amount: d, special: null, label: String(d) }, 'double-btn');
    }
  });

  // Special bids
  if (!currentBid?.special) {
    addBidBtn(grid, { amount: 42, special: 'low', label: 'Low 42' }, 'special');
  }

  // Plunge: need 4+ doubles
  const myHand = state.myHand || [];
  const doubleCount = myHand.filter(t => t.hi === t.lo).length;
  if (doubleCount >= 4 && !currentBid?.special && (currentBid?.amount || 0) < 42) {
    addBidBtn(grid, { amount: 84, special: 'plunge', label: 'Plunge' }, 'special');
  }

  // Follow me — always available
  addBidBtn(grid, { amount: 42, special: 'follow_me', label: 'Follow Me' }, 'special');

  // Pass
  addBidBtn(grid, { amount: 0, special: 'pass', label: 'Pass' }, 'pass-btn');
}

function addBidBtn(container, bid, cls) {
  const btn = document.createElement('button');
  btn.className = `bid-btn ${cls}`;
  btn.textContent = bid.label;
  btn.addEventListener('click', () => {
    socket.emit('placeBid', { amount: bid.amount, special: bid.special });
    hideOverlay('overlay-bid');
  });
  container.appendChild(btn);
}

// ─── Trump overlay ────────────────────────────────────────────────────────────
function renderTrumpOverlay(state) {
  const grid = document.getElementById('trump-buttons');
  grid.innerHTML = '';

  // Show my hand to help choose trump
  const myHand = state.myHand || [];
  const countPerSuit = Array(7).fill(0);
  myHand.forEach(t => { countPerSuit[t.hi]++; if (t.hi !== t.lo) countPerSuit[t.lo]++; });

  SUIT_NAMES.forEach((name, i) => {
    const btn = document.createElement('button');
    btn.className = 'trump-btn';

    const preview = document.createElement('div');
    preview.className = 'trump-pip-preview';
    preview.textContent = i;

    const label = document.createElement('span');
    label.textContent = name;

    const count = document.createElement('span');
    count.style.cssText = 'font-size:.7rem;color:var(--gold);';
    count.textContent = `${countPerSuit[i]} tiles`;

    btn.appendChild(preview);
    btn.appendChild(label);
    btn.appendChild(count);

    btn.addEventListener('click', () => {
      socket.emit('selectTrump', { trump: i });
      hideOverlay('overlay-trump');
    });
    grid.appendChild(btn);
  });
}

// ─── Hand end overlay ─────────────────────────────────────────────────────────
function renderHandEnd(state) {
  const last = state.handHistory[state.handHistory.length - 1];
  if (!last) return;

  const bidTeamName = last.bidTeam === 0 ? 'N/S' : 'E/W';
  const defTeamName = last.bidTeam === 0 ? 'E/W' : 'N/S';
  const myTeam = mySeat % 2;
  const made = last.made;

  document.getElementById('result-title').textContent = made ? `${bidTeamName} made it!` : `${bidTeamName} was set!`;

  const marksFor = Object.values(last.delta).reduce((a,b)=>a+b,0);
  const winTeam = last.delta[0] > 0 ? 'N/S' : 'E/W';

  document.getElementById('result-body').innerHTML = `
    <p class="${made ? 'result-made' : 'result-set'}">
      ${made ? '✓' : '✗'} Bid: ${last.bid.label} · ${made ? 'Made' : 'Set'}
    </p>
    <p style="margin-top:.5rem">${winTeam} gets ${marksFor} mark${marksFor !== 1 ? 's' : ''}</p>
    <p style="margin-top:.5rem">Score — N/S: <strong>${state.score[0]}</strong> · E/W: <strong>${state.score[1]}</strong></p>
    <p style="margin-top:.3rem;font-size:.78rem;color:var(--text-dim)">First to 7 marks wins</p>
  `;
}

// ─── Game over overlay ────────────────────────────────────────────────────────
function renderGameOver(state) {
  const winner = state.score[0] >= 7 ? 'N/S' : 'E/W';
  const myTeam = mySeat % 2 === 0 ? 'N/S' : 'E/W';
  document.getElementById('gameover-title').textContent =
    winner === myTeam ? '🎉 Your team wins!' : `${winner} wins!`;
  document.getElementById('gameover-body').innerHTML = `
    <p>Final score</p>
    <p style="font-size:1.3rem;color:var(--gold);margin:.5rem 0">
      N/S ${state.score[0]} – ${state.score[1]} E/W
    </p>
  `;
}

// ─── Last trick panel ─────────────────────────────────────────────────────────
const btnLastTrick = document.getElementById('btn-show-last');
let lastTrickVisible = false;
btnLastTrick.addEventListener('click', () => {
  lastTrickVisible = !lastTrickVisible;
  document.getElementById('last-trick-content').classList.toggle('hidden', !lastTrickVisible);
  btnLastTrick.textContent = lastTrickVisible ? 'Last trick ▼' : 'Last trick ▶';
});

function renderLastTrick(state) {
  if (!state.lastTrick) return;
  const el = document.getElementById('last-trick-content');
  el.innerHTML = '';
  state.lastTrick.plays.forEach(play => {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;';
    const tileEl = renderTile(play.tile, false, state.trump);
    tileEl.style.cssText = `width:32px;height:58px;`;
    if (play.seatIndex === state.lastTrick.winner) tileEl.classList.add('trick-winner');
    const nameTag = document.createElement('div');
    nameTag.style.cssText = 'font-size:.65rem;color:var(--text-dim);text-align:center;max-width:36px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    nameTag.textContent = state.seats[play.seatIndex]?.name || `P${play.seatIndex+1}`;
    wrapper.appendChild(tileEl);
    wrapper.appendChild(nameTag);
    el.appendChild(wrapper);
  });
}

// ─── Rejoin on reconnect ──────────────────────────────────────────────────────
socket.on('connect', () => {
  const code = sessionStorage.getItem('42-room');
  const seat = sessionStorage.getItem('42-seat');
  const name = sessionStorage.getItem('42-name');
  if (code && seat !== null && name) {
    mySeat = parseInt(seat);
    myRoom = code;
    myName = name;
    socket.emit('rejoin', { code, seat: parseInt(seat), name });
  }
});
