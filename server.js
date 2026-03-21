'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// ─── Game Logic ───────────────────────────────────────────────────────────────

function makeDominoes() {
  const tiles = [];
  for (let hi = 0; hi <= 6; hi++)
    for (let lo = 0; lo <= hi; lo++)
      tiles.push({ hi, lo, id: `${hi}-${lo}` });
  return tiles; // 28 tiles
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function deal() {
  const tiles = shuffle(makeDominoes());
  return [tiles.slice(0,7), tiles.slice(7,14), tiles.slice(14,21), tiles.slice(21,28)];
}

function tileScore(tile) {
  const s = tile.hi + tile.lo;
  return (s === 5 || s === 10) ? s : 0;
}

// Is this tile a trump? trump is a suit number 0-6, or null for no trump
function isTrump(tile, trump) {
  if (trump === null || trump === undefined) return false;
  return tile.hi === trump || tile.lo === trump;
}

// The "suit" of a led tile for follow-suit purposes (non-trump context)
// For non-doubles: higher end. For doubles: that number.
function leadSuitOf(tile, trump) {
  if (isTrump(tile, trump)) return trump; // trump suit
  return tile.hi; // higher end is always hi (hi >= lo by construction)
}

// Does a tile follow the led suit?
function followsSuit(tile, leadSuit, trump) {
  if (isTrump(tile, trump)) return false; // trump tiles don't follow non-trump suit
  return tile.hi === leadSuit || tile.lo === leadSuit;
}

// In Follow Me, trump for a trick = high side of lead tile
function followMeTrump(leadTile) {
  return leadTile.hi; // hi >= lo always
}

// Determine trick winner
// plays = [{seatIndex, tile}, ...], first is the lead
// trump = suit number or null
function trickWinner(plays, trump) {
  const leadTile = plays[0].tile;
  const effectiveTrump = trump; // may be null for low hands

  // led suit (for non-trump following)
  const ledSuit = leadSuitOf(leadTile, effectiveTrump);

  let best = plays[0];
  let bestIsTrump = isTrump(leadTile, effectiveTrump);

  for (let i = 1; i < plays.length; i++) {
    const p = plays[i];
    const pTrump = isTrump(p.tile, effectiveTrump);

    if (pTrump && !bestIsTrump) {
      best = p; bestIsTrump = true;
    } else if (pTrump && bestIsTrump) {
      // Both trump: higher pip wins (hi end for non-doubles, same number for doubles)
      const bestPip = Math.max(best.tile.hi, best.tile.lo);
      const pPip = Math.max(p.tile.hi, p.tile.lo);
      if (pPip > bestPip) best = p;
    } else if (!pTrump && !bestIsTrump) {
      // Both non-trump: must match led suit to challenge
      const pSuit = followsSuit(p.tile, ledSuit, effectiveTrump);
      const bestSuit = followsSuit(best.tile, ledSuit, effectiveTrump) || leadSuitOf(best.tile, effectiveTrump) === ledSuit;
      if (pSuit && bestSuit) {
        const bestPip = Math.max(best.tile.hi, best.tile.lo);
        const pPip = Math.max(p.tile.hi, p.tile.lo);
        if (pPip > bestPip) best = p;
      } else if (pSuit && !bestSuit) {
        best = p;
      }
    }
  }
  return best.seatIndex;
}

// Follow-suit validation: returns true if tile is a legal play
function isLegalPlay(tile, hand, trick, trump, bidType, sittingOut) {
  if (trick.length === 0) return true; // leading — any tile is fine
  const leadTile = trick[0].tile;
  const effectiveTrump = (bidType === 'follow_me') ? followMeTrump(leadTile) : trump;
  const leadSuit = leadSuitOf(leadTile, effectiveTrump);
  const leadIsTrump = isTrump(leadTile, effectiveTrump);

  // Can I follow?
  const canFollow = hand.some(t => {
    if (leadIsTrump) return isTrump(t, effectiveTrump);
    return followsSuit(t, leadSuit, effectiveTrump);
  });

  if (!canFollow) return true; // can't follow — play anything

  if (leadIsTrump) return isTrump(tile, effectiveTrump);
  return followsSuit(tile, leadSuit, effectiveTrump);
}

// Score a completed hand
// Returns marks delta {0: n, 1: n}
function scoreHand(bid, trickCount, pointsTaken) {
  const bidTeam = bid.seatIndex % 2;
  const defTeam = 1 - bidTeam;

  // Team totals (seats 0&2 = team 0, seats 1&3 = team 1)
  const teamTricks = [trickCount[0]+trickCount[2], trickCount[1]+trickCount[3]];
  const teamPoints = [pointsTaken[0]+pointsTaken[2], pointsTaken[1]+pointsTaken[3]];

  const bidTeamTricks = teamTricks[bidTeam];
  const bidTeamPts   = teamPoints[bidTeam];
  const bidTeamTotal = bidTeamTricks + bidTeamPts;

  let delta = {0:0, 1:0};

  if (bid.type === 'plunge') {
    const marks = bid.plungeLevel || 2; // 2 base, +1 each re-bid
    const won = bidTeamTricks === 7;
    delta[won ? bidTeam : defTeam] = marks;
    return delta;
  }

  if (bid.type === 'low') {
    // Bidder must take ZERO tricks
    const won = bidTeamTricks === 0;
    const marks = bid.marks || 1;
    delta[won ? bidTeam : defTeam] = marks;
    return delta;
  }

  // High (normal, double chain, follow_me)
  const marks = bid.marks || 1;
  const won = bidTeamTotal >= bid.amount;
  delta[won ? bidTeam : defTeam] = marks;
  return delta;
}

// ─── Bidding helpers ──────────────────────────────────────────────────────────

// Build available bids for the current bidder given game state
// highBid = current winning bid object or null
// hand = current player's tiles
// allBids = all bids placed so far
function getAvailableBids(highBid, hand, allBids) {
  const bids = [];
  const hAmount  = highBid ? highBid.amount : 0;
  const hType    = highBid ? highBid.type   : null;

  const any42Bid   = allBids.some(b => b.amount === 42);
  const any42Low   = allBids.some(b => b.amount === 42 && b.type === 'low');
  const any84Bid   = allBids.some(b => b.amount >= 84);
  const doubleCount = hand.filter(t => t.hi === t.lo).length;

  // ── Standard high bids 30-42 ──
  for (let n = 30; n <= 42; n++) {
    const available = hAmount < n; // beats current
    bids.push({ amount: n, type: 'high', label: String(n), enabled: available });
  }

  // ── Low 42 ──
  // Available if no one has bid 42+ yet, OR current high is less than 42
  // Only one 42-level bid can be active at a time
  const lowEnabled = hAmount < 42 || (hAmount === 42 && hType !== 'low');
  bids.push({ amount: 42, type: 'low', label: '42 Low', enabled: lowEnabled && hAmount <= 42 && hType !== 'low' });

  // ── 84 High ──
  // Always available as a bid (beats anything up to 84)
  bids.push({ amount: 84, type: 'high', label: '84 High', enabled: hAmount < 84, marks: 2 });

  // ── 84 Low ──
  // Only available if someone has already bid 42 (high or low)
  bids.push({ amount: 84, type: 'low', label: '84 Low', enabled: any42Bid && hAmount < 84, marks: 2 });

  // ── Plunge ──
  // Available if player has 4+ doubles. Starts at 2 marks, +1 per re-bid
  const plungeAlreadyBid = allBids.filter(b => b.type === 'plunge').length;
  const plungeMarks = 2 + plungeAlreadyBid;
  const plungeEnabled = doubleCount >= 4 && hAmount < 84;
  bids.push({ amount: 84, type: 'plunge', label: `Plunge (${plungeMarks} marks)`, enabled: plungeEnabled, marks: plungeMarks, plungeLevel: plungeMarks });

  // ── Doubling chain: 126, 168, 210 ──
  // Only available after an 84 bid exists. Each can be high, low, or plunge.
  if (any84Bid) {
    const chainLevels = [
      { amount: 126, label: '126', marks: 3 },
      { amount: 168, label: '168', marks: 4 },
      { amount: 210, label: '210', marks: 5 },
    ];
    for (const cl of chainLevels) {
      bids.push({ amount: cl.amount, type: 'high',   label: cl.label+' High',   enabled: hAmount < cl.amount, marks: cl.marks });
      bids.push({ amount: cl.amount, type: 'low',    label: cl.label+' Low',    enabled: hAmount < cl.amount, marks: cl.marks });
      const plunge126Level = allBids.filter(b => b.type === 'plunge').length + (plungeAlreadyBid > 0 ? 0 : 0);
      bids.push({ amount: cl.amount, type: 'plunge', label: cl.label+' Plunge', enabled: doubleCount >= 4 && hAmount < cl.amount, marks: cl.marks, plungeLevel: cl.marks });
    }
  }

  // ── Pass ──
  bids.push({ amount: 0, type: 'pass', label: 'Pass', enabled: true });

  return bids;
}

// ─── HTML Page (inlined) ──────────────────────────────────────────────────────

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --felt:#1a5c38;--felt-dark:#123e27;--felt-light:#246b43;--felt-edge:#0d2e1a;
  --ivory:#f5f0e8;--pip:#1a1a1a;--gold:#c9a84c;--gold-light:#e8c96a;
  --text-main:#f5f0e8;--text-dim:rgba(245,240,232,.6);
  --card-bg:rgba(10,30,18,.88);--card-border:rgba(201,168,76,.25);
  --radius:12px;--tile-w:52px;--tile-h:96px;
  font-family:'DM Sans',sans-serif;
}
html,body{height:100%;overflow:hidden}
body{background:var(--felt-dark);color:var(--text-main);display:flex;align-items:center;justify-content:center}
.screen{display:none;width:100%;height:100%}
.screen.active{display:flex;align-items:center;justify-content:center}
#screen-game.active{display:flex;flex-direction:column}

/* Lobby */
.lobby-card,.waiting-card{
  background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius);
  padding:2.5rem 2.5rem 2rem;width:min(420px,92vw);display:flex;flex-direction:column;gap:1.2rem;
  backdrop-filter:blur(12px)
}
h1{font-family:'Playfair Display',serif;font-size:2.8rem;color:var(--gold);text-align:center;letter-spacing:.04em;line-height:1}
h2{font-family:'Playfair Display',serif;font-size:1.6rem;color:var(--gold);text-align:center}
.subtitle{text-align:center;color:var(--text-dim);font-size:.9rem}
input[type="text"]{
  width:100%;background:rgba(255,255,255,.07);border:1px solid rgba(201,168,76,.3);
  border-radius:8px;color:var(--ivory);padding:.7rem 1rem;font-size:1rem;font-family:inherit;
  outline:none;transition:border-color .2s
}
input[type="text"]:focus{border-color:var(--gold)}
input[type="text"]::placeholder{color:var(--text-dim)}
.lobby-actions{display:flex;flex-direction:column;gap:.8rem}
.join-row{display:flex;gap:.6rem}
.join-row input{flex:1;text-transform:uppercase;letter-spacing:.12em}
.btn-primary{
  background:var(--gold);color:#1a1a1a;border:none;border-radius:8px;padding:.75rem 1.4rem;
  font-size:.95rem;font-weight:600;font-family:inherit;cursor:pointer;width:100%;transition:background .15s,transform .1s
}
.btn-primary:hover{background:var(--gold-light)}
.btn-primary:active{transform:scale(.98)}
.btn-secondary{
  background:transparent;color:var(--gold);border:1px solid var(--gold);border-radius:8px;
  padding:.75rem 1.2rem;font-size:.95rem;font-weight:500;font-family:inherit;cursor:pointer;
  white-space:nowrap;transition:background .15s
}
.btn-secondary:hover{background:rgba(201,168,76,.12)}
.error-msg{color:#e07070;font-size:.85rem;min-height:1.2em;text-align:center}

/* Waiting */
.room-code-display{
  text-align:center;font-size:1.6rem;font-family:'Playfair Display',serif;color:var(--gold);
  letter-spacing:.18em;display:flex;align-items:center;justify-content:center;gap:.5rem
}
.btn-copy{background:none;border:1px solid var(--card-border);color:var(--gold);border-radius:6px;padding:.2rem .5rem;font-size:.9rem;cursor:pointer}
.btn-copy:hover{background:rgba(201,168,76,.1)}
.seat-list{display:flex;flex-direction:column;gap:.5rem}
.seat-row{
  display:flex;align-items:center;gap:.8rem;padding:.6rem .9rem;
  background:rgba(255,255,255,.05);border-radius:8px;border:1px solid rgba(255,255,255,.08)
}
.seat-row .seat-num{color:var(--gold);font-weight:600;min-width:24px}
.seat-row .seat-team{font-size:.75rem;color:var(--text-dim);margin-left:auto}
.seat-row.empty{opacity:.45;font-style:italic}
.waiting-hint{text-align:center;font-size:.82rem;color:var(--text-dim)}

/* Score bar */
.score-bar{
  display:flex;align-items:center;justify-content:space-between;
  background:var(--felt-edge);border-bottom:1px solid rgba(201,168,76,.2);
  padding:.5rem 1.2rem;flex-shrink:0;z-index:10
}
.score-team{display:flex;align-items:center;gap:.5rem}
.score-team.right{flex-direction:row-reverse}
.team-label{font-size:.75rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.08em}
.team-marks{font-family:'Playfair Display',serif;font-size:1.8rem;color:var(--gold);line-height:1;min-width:2ch;text-align:center}
.team-pip{font-size:.7rem;color:var(--text-dim)}
.score-center{display:flex;flex-direction:column;align-items:center;gap:.15rem}
#game-status-label{font-size:.82rem;color:var(--text-dim)}
.room-tag{font-size:.7rem;color:rgba(201,168,76,.5);letter-spacing:.12em}

/* Trump banner */
#trump-banner{
  background:rgba(13,46,26,.9);border-bottom:1px solid rgba(201,168,76,.3);
  padding:.3rem 1rem;text-align:center;font-size:.82rem;color:var(--gold);
  letter-spacing:.05em;flex-shrink:0;display:none
}
#trump-banner.visible{display:block}

/* Table */
.table-wrap{
  flex:1;position:relative;display:grid;
  grid-template-areas:". top ." "left center right" ". bottom .";
  grid-template-columns:130px 1fr 130px;grid-template-rows:110px 1fr 150px;
  gap:4px;padding:8px;overflow:hidden
}
.player-zone{display:flex;align-items:center;justify-content:center;position:relative}
.player-zone.top{grid-area:top;flex-direction:column;gap:4px}
.player-zone.left{grid-area:left;flex-direction:column;gap:4px}
.player-zone.right{grid-area:right;flex-direction:column;gap:4px}
.player-zone.bottom{grid-area:bottom;flex-direction:column;gap:6px}
.player-name-tag{
  font-size:.78rem;font-weight:500;color:var(--text-dim);background:rgba(0,0,0,.3);
  border:1px solid rgba(201,168,76,.15);border-radius:20px;padding:.2rem .7rem;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px
}
.player-name-tag.active-player{color:var(--gold);border-color:rgba(201,168,76,.5)}
.player-name-tag.sitting-out{color:#e07070;border-color:rgba(220,100,100,.3);text-decoration:line-through}
.opponent-hand{display:flex;gap:3px;align-items:center;justify-content:center;flex-wrap:nowrap}
.opponent-hand.vertical{flex-direction:column}

/* Tiles */
.tile{
  width:var(--tile-w);height:var(--tile-h);background:var(--ivory);border-radius:6px;
  border:1px solid #ccc;display:flex;flex-direction:column;align-items:center;
  justify-content:space-between;padding:5px;cursor:default;position:relative;flex-shrink:0;
  user-select:none;box-shadow:0 2px 6px rgba(0,0,0,.4);transition:transform .12s,box-shadow .12s
}
.tile.playable{cursor:pointer;border-color:var(--gold)}
.tile.playable:hover{transform:translateY(-10px);box-shadow:0 10px 24px rgba(0,0,0,.5)}
.tile.playable:active{transform:translateY(-5px)}
.tile.illegal{opacity:.4;cursor:not-allowed}
.tile.trump-tile{border-color:#c0392b;box-shadow:0 0 0 2px rgba(192,57,43,.4),0 2px 6px rgba(0,0,0,.4)}
.tile .half{width:100%;display:flex;align-items:center;justify-content:center;flex:1}
.tile .divider{width:80%;height:1px;background:#bbb;flex-shrink:0}
.tile-back{background:var(--felt);border:1px solid rgba(201,168,76,.3);width:28px;height:52px;border-radius:4px;flex-shrink:0}
.pips{display:grid;gap:3px;align-items:center;justify-items:center;padding:2px}
.pip{width:8px;height:8px;background:var(--pip);border-radius:50%}
.pips[data-n="0"]{grid-template-columns:1fr;min-height:24px}
.pips[data-n="1"]{grid-template-columns:1fr}
.pips[data-n="2"]{grid-template-columns:1fr 1fr}
.pips[data-n="3"]{grid-template-columns:1fr 1fr 1fr}
.pips[data-n="4"]{grid-template-columns:1fr 1fr}
.pips[data-n="5"]{grid-template-columns:1fr 1fr 1fr}
.pips[data-n="6"]{grid-template-columns:1fr 1fr 1fr}

/* Trick area */
.trick-area{grid-area:center;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px}
.trick-row{display:flex;align-items:center;gap:8px}
.trick-slot{width:var(--tile-w);height:var(--tile-h);display:flex;align-items:center;justify-content:center}
.trick-center-info{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:60px;gap:4px}
.tile.trick-winner{box-shadow:0 0 0 3px var(--gold),0 4px 12px rgba(0,0,0,.5)}

/* My hand */
.my-hand{
  display:flex;gap:6px;align-items:flex-end;justify-content:center;flex-wrap:nowrap;
  overflow-x:auto;padding:4px 4px 0;max-width:100%
}

/* Overlays */
.overlay{
  position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;
  background:rgba(0,0,0,.4);z-index:100;padding-bottom:8px
}
.overlay.hidden{display:none}
.overlay-card{
  background:#0e2c1a;border:1px solid var(--card-border);border-radius:var(--radius) var(--radius) 0 0;
  padding:1rem 1.2rem 1.2rem;width:100%;max-width:100%;display:flex;flex-direction:column;gap:.8rem;
  max-height:60vh;overflow-y:auto
}
.overlay-card h3{font-family:'Playfair Display',serif;color:var(--gold);font-size:1.2rem;text-align:center}
.overlay-full{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);z-index:100}
.overlay-full.hidden{display:none}
.overlay-full-card{
  background:#0e2c1a;border:1px solid var(--card-border);border-radius:var(--radius);
  padding:1.8rem 2rem;min-width:300px;max-width:min(480px,92vw);display:flex;flex-direction:column;gap:1rem
}
.overlay-full-card h3{font-family:'Playfair Display',serif;color:var(--gold);font-size:1.4rem;text-align:center}
.bid-subtitle{text-align:center;font-size:.82rem;color:var(--text-dim)}

/* Bid panel (bottom sheet, collapsible) */
#bid-sheet{position:absolute;bottom:0;left:0;right:0;z-index:200;transition:transform .25s}
#bid-sheet.hidden{display:none}
.bid-sheet-handle{
  background:#0e2c1a;border:1px solid var(--card-border);border-radius:var(--radius) var(--radius) 0 0;
  padding:.5rem 1.2rem;display:flex;align-items:center;justify-content:space-between;cursor:pointer
}
.bid-sheet-handle h3{font-family:'Playfair Display',serif;color:var(--gold);font-size:1rem;margin:0}
.bid-sheet-toggle{background:none;border:none;color:var(--gold);font-size:1.2rem;cursor:pointer;line-height:1}
.bid-sheet-body{
  background:#0b2217;border:1px solid var(--card-border);border-top:none;
  padding:.8rem 1rem 1rem;max-height:42vh;overflow-y:auto
}
.bid-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px}
.bid-btn{
  background:rgba(255,255,255,.06);border:1px solid rgba(201,168,76,.25);border-radius:8px;
  color:var(--ivory);padding:.5rem .4rem;font-family:inherit;font-size:.82rem;font-weight:500;
  cursor:pointer;transition:background .12s,border-color .12s;text-align:center
}
.bid-btn:hover:not(:disabled){background:rgba(201,168,76,.18);border-color:var(--gold)}
.bid-btn.special{color:var(--gold);border-color:rgba(201,168,76,.5)}
.bid-btn.pass-btn{color:#e07070;border-color:rgba(220,100,100,.3)}
.bid-btn.double-btn{color:#8ecdf5;border-color:rgba(100,180,240,.3)}
.bid-btn.low-btn{color:#a8e6cf;border-color:rgba(100,220,170,.3)}
.bid-btn:disabled{opacity:.28;cursor:not-allowed;pointer-events:none}

/* Trump select */
.trump-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.trump-btn{
  display:flex;flex-direction:column;align-items:center;gap:.3rem;
  background:rgba(255,255,255,.06);border:1px solid rgba(201,168,76,.25);border-radius:10px;
  color:var(--ivory);padding:.9rem .5rem;cursor:pointer;font-family:inherit;font-size:.8rem;transition:background .12s
}
.trump-btn:hover{background:rgba(201,168,76,.18);border-color:var(--gold)}
.trump-btn.follow-me-btn{grid-column:span 2;border-color:rgba(100,180,240,.4);color:#8ecdf5}
.trump-pip-preview{
  width:22px;height:22px;background:var(--pip);border-radius:50%;
  display:flex;align-items:center;justify-content:center;color:var(--ivory);font-size:.75rem;font-weight:600
}

/* Result card */
.result-made{color:#6fcf97}
.result-set{color:#eb5757}
#result-body,#gameover-body{font-size:.9rem;color:var(--text-dim);line-height:1.7;text-align:center}

/* Boneyard panel */
#boneyard-panel{
  position:absolute;left:0;top:50%;transform:translateY(-50%);z-index:50;
  display:flex;flex-direction:column;align-items:flex-start
}
.boneyard-tab{
  background:rgba(13,46,26,.9);border:1px solid var(--card-border);
  border-left:none;border-radius:0 8px 8px 0;padding:.4rem .6rem;
  font-size:.72rem;color:var(--gold);cursor:pointer;writing-mode:vertical-rl;
  text-orientation:mixed;letter-spacing:.08em;user-select:none
}
.boneyard-tab:hover{background:rgba(201,168,76,.12)}
#boneyard-content{
  background:rgba(10,28,18,.95);border:1px solid var(--card-border);border-radius:0 8px 8px 0;
  padding:.6rem;max-height:70vh;overflow-y:auto;min-width:220px;display:none
}
#boneyard-content.open{display:block}
#boneyard-content h4{font-size:.75rem;color:var(--gold);margin-bottom:.5rem;letter-spacing:.06em}
.boneyard-tiles{display:flex;flex-wrap:wrap;gap:3px}
.boneyard-tile{
  width:22px;height:40px;background:var(--ivory);border-radius:3px;border:1px solid #bbb;
  display:flex;flex-direction:column;align-items:center;justify-content:space-between;
  padding:2px;flex-shrink:0;font-size:7px;color:var(--pip);font-weight:600
}
.boneyard-tile span{line-height:1}
.boneyard-tile .bd{width:90%;height:1px;background:#bbb;flex-shrink:0}
.boneyard-empty{font-size:.75rem;color:var(--text-dim);font-style:italic}

/* Dealer chip */
.dealer-chip{
  display:inline-block;background:var(--gold);color:#1a1a1a;font-size:.6rem;font-weight:700;
  border-radius:50%;width:16px;height:16px;text-align:center;line-height:16px;margin-left:4px
}
.zone-active .player-name-tag{color:var(--gold);border-color:rgba(201,168,76,.6);background:rgba(201,168,76,.1)}

@media(max-width:600px){
  :root{--tile-w:38px;--tile-h:70px}
  .table-wrap{grid-template-columns:80px 1fr 80px;grid-template-rows:85px 1fr 140px}
  .tile-back{width:20px;height:36px}
  .bid-grid{grid-template-columns:repeat(auto-fill,minmax(80px,1fr))}
}
`;

const CLIENT_JS = `
'use strict';
const socket = io();
let myName='',myRoom='',mySeat=-1,lastState=null;

function showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active')}
function showOverlay(id){document.getElementById(id).classList.remove('hidden')}
function hideOverlay(id){document.getElementById(id).classList.add('hidden')}
function hideAllOverlays(){['overlay-trump','overlay-hand-end','overlay-game-over'].forEach(hideOverlay);document.getElementById('bid-sheet').classList.add('hidden')}

// Lobby
document.getElementById('btn-create').addEventListener('click',()=>{
  const name=document.getElementById('player-name').value.trim();
  if(!name){setErr('lobby-error','Enter your name first');return}
  myName=name;socket.emit('createRoom',{name})
});
document.getElementById('btn-join').addEventListener('click',()=>{
  const name=document.getElementById('player-name').value.trim();
  const code=document.getElementById('room-code-input').value.trim();
  if(!name){setErr('lobby-error','Enter your name first');return}
  if(!code){setErr('lobby-error','Enter a room code');return}
  myName=name;socket.emit('joinRoom',{name,code})
});
document.getElementById('player-name').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('btn-create').click()});
document.getElementById('room-code-input').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('btn-join').click()});
document.getElementById('btn-copy-code').addEventListener('click',()=>{
  navigator.clipboard.writeText(myRoom).then(()=>{
    document.getElementById('btn-copy-code').textContent='✓';
    setTimeout(()=>document.getElementById('btn-copy-code').textContent='⧉',1500)
  })
});
document.getElementById('btn-start').addEventListener('click',()=>socket.emit('startGame'));
document.getElementById('btn-next-hand').addEventListener('click',()=>{socket.emit('nextHand');hideOverlay('overlay-hand-end')});
document.getElementById('btn-play-again').addEventListener('click',()=>location.reload());

function setErr(id,msg){document.getElementById(id).textContent=msg}

// Bid sheet collapse/expand
let bidSheetOpen=true;
document.getElementById('bid-sheet-toggle').addEventListener('click',()=>{
  bidSheetOpen=!bidSheetOpen;
  document.getElementById('bid-sheet-body').style.display=bidSheetOpen?'block':'none';
  document.getElementById('bid-sheet-toggle').textContent=bidSheetOpen?'▼':'▲'
});

// Boneyard
let boneyardOpen=false;
document.getElementById('boneyard-tab').addEventListener('click',()=>{
  boneyardOpen=!boneyardOpen;
  document.getElementById('boneyard-content').classList.toggle('open',boneyardOpen)
});

socket.on('error',msg=>{
  if(document.getElementById('screen-lobby').classList.contains('active'))setErr('lobby-error',msg);
  else if(document.getElementById('screen-waiting').classList.contains('active'))setErr('waiting-error',msg);
  else alert(msg)
});

socket.on('joined',({code,seat,name})=>{
  myRoom=code;mySeat=seat;myName=name;
  document.getElementById('display-code').textContent=code;
  document.getElementById('score-room-code').textContent=code;
  document.getElementById('btn-start').style.display=seat===0?'block':'none';
  showScreen('screen-waiting');
  sessionStorage.setItem('42-room',code);
  sessionStorage.setItem('42-seat',seat);
  sessionStorage.setItem('42-name',name)
});

socket.on('state',state=>{
  lastState=state;
  if(state.state==='lobby'){renderWaiting(state);if(!document.getElementById('screen-waiting').classList.contains('active'))showScreen('screen-waiting');return}
  if(!document.getElementById('screen-game').classList.contains('active'))showScreen('screen-game');
  renderGame(state)
});

function renderWaiting(state){
  const list=document.getElementById('seat-list');list.innerHTML='';
  const teams=['N/S','E/W','N/S','E/W'],positions=['North','East','South','West'];
  state.seats.forEach((seat,i)=>{
    const row=document.createElement('div');
    row.className='seat-row'+(seat?'':' empty');
    row.innerHTML='<span class="seat-num">'+(i+1)+'</span><span>'+(seat?(seat.disconnected?seat.name+' (away)':seat.name):'Empty')+'</span><span class="seat-team">'+positions[i]+' · '+teams[i]+'</span>';
    list.appendChild(row)
  })
}

const SUIT_NAMES=['Blanks','Ones','Twos','Threes','Fours','Fives','Sixes'];

function seatOffset(s){return((s-mySeat+4)%4)}
function posForOffset(o){return['bottom','left','top','right'][o]}

function renderGame(state){
  // Score
  document.getElementById('marks-0').textContent=state.score[0];
  document.getElementById('marks-1').textContent=state.score[1];

  // Status label
  const sl={bidding:'Bidding',trump_select:'Selecting trump',plunge_trump_select:'Partner selecting trump',playing:'Playing',hand_end:'Hand over',game_over:'Game over'};
  document.getElementById('game-status-label').textContent=sl[state.state]||'';

  // Trump banner
  const banner=document.getElementById('trump-banner');
  if(state.state==='playing'||state.state==='hand_end'){
    if(state.bidType==='low'){
      banner.textContent='42 LOW — No trump · Bidder must take zero tricks';banner.classList.add('visible')
    } else if(state.bidType==='follow_me'){
      const t=state.trickTrump!==null&&state.trickTrump!==undefined?'This trick trump: '+SUIT_NAMES[state.trickTrump]:'Follow Me — trump set by each lead';
      banner.textContent=t;banner.classList.add('visible')
    } else if(state.trump!==null&&state.trump!==undefined){
      banner.textContent='Trump: '+SUIT_NAMES[state.trump];banner.classList.add('visible')
    } else {
      banner.classList.remove('visible')
    }
  } else {
    banner.classList.remove('visible')
  }

  // Players
  for(let s=0;s<4;s++){
    const offset=seatOffset(s),pos=posForOffset(offset);
    const nameEl=document.getElementById('name-'+pos);
    const handEl=document.getElementById('hand-'+pos);
    if(!nameEl||!handEl)continue;
    const seat=state.seats[s];
    let nameText=seat?seat.name:'Seat '+(s+1);
    if(s===state.dealer)nameText+='<span class="dealer-chip">D</span>';
    nameEl.innerHTML=nameText;
    const isActive=(state.state==='playing'&&state.currentPlayer===s)||(state.state==='bidding'&&state.currentBidder===s)||((state.state==='trump_select'||state.state==='plunge_trump_select')&&state.trumpSelector===s);
    nameEl.classList.toggle('active-player',isActive);
    nameEl.classList.toggle('sitting-out',!!(state.sittingOut===s));
    document.getElementById('zone-'+pos)?.classList.toggle('zone-active',isActive);
    handEl.innerHTML='';
    if(s===mySeat){
      const myTurn=state.state==='playing'&&state.currentPlayer===mySeat&&state.sittingOut!==mySeat;
      (state.myHand||[]).forEach(tile=>{
        const el=renderTile(tile,state.trump,state.bidType,state.trickTrump);
        if(myTurn){
          const legal=isLegalPlayClient(tile,state.myHand,state.trick,state.trump,state.bidType,state.trickTrump);
          if(legal){el.classList.add('playable');el.addEventListener('click',()=>socket.emit('playTile',{tileId:tile.id}))}
          else el.classList.add('illegal')
        }
        handEl.appendChild(el)
      })
    } else {
      const count=Math.max(0,7-state.trickCount.reduce((a,b)=>a+b,0));
      for(let i=0;i<count;i++){const b=document.createElement('div');b.className='tile-back';handEl.appendChild(b)}
    }
  }

  renderTrickArea(state);
  renderBoneyard(state);
  hideAllOverlays();

  if(state.state==='bidding'&&state.currentBidder===mySeat){
    renderBidSheet(state);document.getElementById('bid-sheet').classList.remove('hidden')
  } else if((state.state==='trump_select')&&state.trumpSelector===mySeat){
    renderTrumpOverlay(state);showOverlay('overlay-trump')
  } else if(state.state==='plunge_trump_select'&&state.trumpSelector===mySeat){
    renderTrumpOverlay(state);showOverlay('overlay-trump')
  } else if(state.state==='hand_end'){
    renderHandEnd(state);showOverlay('overlay-hand-end')
  } else if(state.state==='game_over'){
    renderGameOver(state);showOverlay('overlay-game-over')
  }
}

function isLegalPlayClient(tile,hand,trick,trump,bidType,trickTrump){
  if(trick.length===0)return true;
  const leadTile=trick[0].tile;
  const effectiveTrump=bidType==='follow_me'?trickTrump:trump;
  if(effectiveTrump===null||effectiveTrump===undefined){
    // No trump (low hand) — must follow high end suit
    const ledSuit=leadTile.hi;
    const canFollow=hand.some(t=>t.hi===ledSuit||t.lo===ledSuit);
    if(!canFollow)return true;
    return tile.hi===ledSuit||tile.lo===ledSuit
  }
  const leadIsTrump=leadTile.hi===effectiveTrump||leadTile.lo===effectiveTrump;
  const ledSuit=leadIsTrump?effectiveTrump:leadTile.hi;
  const tileIsTrump=tile.hi===effectiveTrump||tile.lo===effectiveTrump;
  const canFollowTrump=hand.some(t=>t.hi===effectiveTrump||t.lo===effectiveTrump);
  const canFollowSuit=hand.some(t=>(t.hi!==effectiveTrump&&t.lo!==effectiveTrump)&&(t.hi===ledSuit||t.lo===ledSuit));
  if(leadIsTrump){if(!canFollowTrump)return true;return tileIsTrump}
  if(!canFollowSuit)return true;
  return !tileIsTrump&&(tile.hi===ledSuit||tile.lo===ledSuit)
}

function renderTile(tile,trump,bidType,trickTrump){
  const el=document.createElement('div');el.className='tile';el.dataset.id=tile.id;
  const effectiveTrump=bidType==='follow_me'?trickTrump:trump;
  if(effectiveTrump!==null&&effectiveTrump!==undefined&&(tile.hi===effectiveTrump||tile.lo===effectiveTrump))el.classList.add('trump-tile');
  const top=document.createElement('div');top.className='half';top.appendChild(makePips(tile.hi));
  const div=document.createElement('div');div.className='divider';
  const bot=document.createElement('div');bot.className='half';bot.appendChild(makePips(tile.lo));
  el.appendChild(top);el.appendChild(div);el.appendChild(bot);
  return el
}

const PIP_POS={0:[],1:[[1,1]],2:[[0,0],[2,2]],3:[[0,0],[1,1],[2,2]],4:[[0,0],[2,0],[0,2],[2,2]],5:[[0,0],[2,0],[1,1],[0,2],[2,2]],6:[[0,0],[2,0],[0,1],[2,1],[0,2],[2,2]]};
function makePips(n){
  const c=document.createElement('div');c.className='pips';c.dataset.n=n;
  if(n===0)return c;
  if(n<=2){PIP_POS[n].forEach(()=>{const p=document.createElement('div');p.className='pip';c.appendChild(p)});return c}
  c.style.cssText='position:relative;width:28px;height:28px;';
  PIP_POS[n].forEach(([col,row])=>{const p=document.createElement('div');p.className='pip';p.style.cssText='position:absolute;left:'+(col*10)+'px;top:'+(row*10)+'px;';c.appendChild(p)});
  return c
}

function renderTrickArea(state){
  const slots={bottom:document.getElementById('trick-bottom'),left:document.getElementById('trick-left'),top:document.getElementById('trick-top'),right:document.getElementById('trick-right')};
  Object.values(slots).forEach(s=>s.innerHTML='');
  state.trick.forEach(play=>{
    const pos=posForOffset(seatOffset(play.seatIndex));
    const slot=slots[pos];if(!slot)return;
    const el=renderTile(play.tile,state.trump,state.bidType,state.trickTrump);
    slot.appendChild(el)
  })
}

function renderBoneyard(state){
  const content=document.getElementById('boneyard-content');
  content.innerHTML='<h4>Boneyard ('+( state.boneyard?state.boneyard.length:0)+' played)</h4>';
  if(!state.boneyard||state.boneyard.length===0){content.innerHTML+='<p class="boneyard-empty">No tiles played yet</p>';return}
  const wrap=document.createElement('div');wrap.className='boneyard-tiles';
  state.boneyard.forEach(tile=>{
    const el=document.createElement('div');el.className='boneyard-tile';
    el.innerHTML='<span>'+tile.hi+'</span><div class="bd"></div><span>'+tile.lo+'</span>';
    wrap.appendChild(el)
  });
  content.appendChild(wrap)
}

function renderBidSheet(state){
  const grid=document.getElementById('bid-buttons');grid.innerHTML='';
  const bids=state.availableBids||[];
  const currentLabel=state.bid&&state.bid.amount>0?(state.bid.label||state.bid.amount):'None';
  document.getElementById('bid-current-label').textContent='Current bid: '+currentLabel;
  bids.forEach(bid=>{
    const btn=document.createElement('button');
    btn.className='bid-btn'+(bid.type==='pass'?' pass-btn':bid.type==='low'?' low-btn':bid.type==='plunge'?' special':bid.amount>=84?' double-btn':'');
    btn.textContent=bid.label;
    if(!bid.enabled)btn.disabled=true;
    btn.addEventListener('click',()=>{
      socket.emit('placeBid',{amount:bid.amount,type:bid.type,marks:bid.marks,plungeLevel:bid.plungeLevel});
      document.getElementById('bid-sheet').classList.add('hidden')
    });
    grid.appendChild(btn)
  })
}

function renderTrumpOverlay(state){
  const grid=document.getElementById('trump-buttons');grid.innerHTML='';
  const myHand=state.myHand||[];
  const countPerSuit=Array(7).fill(0);
  myHand.forEach(t=>{countPerSuit[t.hi]++;if(t.hi!==t.lo)countPerSuit[t.lo]++});
  SUIT_NAMES.forEach((name,i)=>{
    const btn=document.createElement('button');btn.className='trump-btn';
    const preview=document.createElement('div');preview.className='trump-pip-preview';preview.textContent=i;
    const label=document.createElement('span');label.textContent=name;
    const count=document.createElement('span');count.style.cssText='font-size:.7rem;color:var(--gold)';count.textContent=countPerSuit[i]+' tiles';
    btn.appendChild(preview);btn.appendChild(label);btn.appendChild(count);
    btn.addEventListener('click',()=>{socket.emit('selectTrump',{trump:i});hideOverlay('overlay-trump')});
    grid.appendChild(btn)
  });
  // Follow Me option only for normal high bids
  if(state.bidType==='high'){
    const fm=document.createElement('button');fm.className='trump-btn follow-me-btn';
    fm.innerHTML='<span style="font-size:1rem">&#9733;</span><span>Follow Me</span><span style="font-size:.7rem;color:#8ecdf5">Lead sets trump</span>';
    fm.addEventListener('click',()=>{socket.emit('selectTrump',{trump:-1,followMe:true});hideOverlay('overlay-trump')});
    grid.appendChild(fm)
  }
  document.getElementById('trump-card-title').textContent=state.state==='plunge_trump_select'?'Partner: Pick Trump':'Select Trump'
}

function renderHandEnd(state){
  const last=state.handHistory[state.handHistory.length-1];if(!last)return;
  const bidTeamName=last.bidTeam===0?'N/S':'E/W';
  document.getElementById('result-title').textContent=last.made?bidTeamName+' made it!':bidTeamName+' was set!';
  const winTeam=last.delta[0]>0?'N/S':'E/W';
  const marks=Math.max(last.delta[0],last.delta[1]);
  document.getElementById('result-body').innerHTML='<p class="'+(last.made?'result-made':'result-set')+'">'+(last.made?'✓':'✗')+' Bid: '+last.bid.label+' · '+(last.made?'Made':'Set')+'</p><p style="margin-top:.5rem">'+winTeam+' gets '+marks+' mark'+(marks!==1?'s':'')+'</p><p style="margin-top:.5rem">Score — N/S: <strong>'+state.score[0]+'</strong> · E/W: <strong>'+state.score[1]+'</strong></p><p style="margin-top:.3rem;font-size:.78rem;color:var(--text-dim)">First to 7 marks wins</p>'
}

function renderGameOver(state){
  const winner=state.score[0]>=7?'N/S':'E/W';
  const myTeam=mySeat%2===0?'N/S':'E/W';
  document.getElementById('gameover-title').textContent=winner===myTeam?'Your team wins!':winner+' wins!';
  document.getElementById('gameover-body').innerHTML='<p>Final score</p><p style="font-size:1.3rem;color:var(--gold);margin:.5rem 0">N/S '+state.score[0]+' – '+state.score[1]+' E/W</p>'
}

socket.on('connect',()=>{
  const code=sessionStorage.getItem('42-room');
  const seat=sessionStorage.getItem('42-seat');
  const name=sessionStorage.getItem('42-name');
  if(code&&seat!==null&&name){mySeat=parseInt(seat);myRoom=code;myName=name;socket.emit('rejoin',{code,seat:parseInt(seat),name})}
});
`;

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Texas 42</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>

<div id="screen-lobby" class="screen active">
  <div class="lobby-card">
    <h1>Texas&nbsp;42</h1>
    <p class="subtitle">Classic dominoes for 4 players</p>
    <input id="player-name" type="text" placeholder="Your name" maxlength="18" autocomplete="off">
    <div class="lobby-actions">
      <button id="btn-create" class="btn-primary">Create Game</button>
      <div class="join-row">
        <input id="room-code-input" type="text" placeholder="Room code" maxlength="4" autocomplete="off">
        <button id="btn-join" class="btn-secondary">Join</button>
      </div>
    </div>
    <p id="lobby-error" class="error-msg"></p>
  </div>
</div>

<div id="screen-waiting" class="screen">
  <div class="waiting-card">
    <h2>Waiting for players</h2>
    <div class="room-code-display">
      Room: <span id="display-code">----</span>
      <button id="btn-copy-code" class="btn-copy">&#x29C9;</button>
    </div>
    <div id="seat-list" class="seat-list"></div>
    <p class="waiting-hint">Share the room code with your friends</p>
    <button id="btn-start" class="btn-primary" style="display:none">Start Game</button>
    <p id="waiting-error" class="error-msg"></p>
  </div>
</div>

<div id="screen-game" class="screen">
  <header class="score-bar">
    <div class="score-team">
      <span class="team-label">N/S</span>
      <span class="team-marks" id="marks-0">0</span>
      <span class="team-pip">marks</span>
    </div>
    <div class="score-center">
      <span id="game-status-label"></span>
      <span class="room-tag" id="score-room-code"></span>
    </div>
    <div class="score-team right">
      <span class="team-pip">marks</span>
      <span class="team-marks" id="marks-1">0</span>
      <span class="team-label">E/W</span>
    </div>
  </header>

  <div id="trump-banner"></div>

  <div class="table-wrap">
    <div class="player-zone top" id="zone-top">
      <div class="player-name-tag" id="name-top"></div>
      <div class="opponent-hand" id="hand-top"></div>
    </div>
    <div class="player-zone left" id="zone-left">
      <div class="player-name-tag" id="name-left"></div>
      <div class="opponent-hand vertical" id="hand-left"></div>
    </div>
    <div class="player-zone right" id="zone-right">
      <div class="opponent-hand vertical" id="hand-right"></div>
      <div class="player-name-tag" id="name-right"></div>
    </div>
    <div class="trick-area">
      <div class="trick-slot" id="trick-top"></div>
      <div class="trick-row">
        <div class="trick-slot" id="trick-left"></div>
        <div class="trick-center-info" id="trick-center-info"></div>
        <div class="trick-slot" id="trick-right"></div>
      </div>
      <div class="trick-slot" id="trick-bottom"></div>
    </div>
    <div class="player-zone bottom" id="zone-bottom">
      <div class="player-name-tag" id="name-bottom"></div>
      <div class="my-hand" id="hand-bottom"></div>
    </div>

    <!-- Boneyard -->
    <div id="boneyard-panel">
      <div class="boneyard-tab" id="boneyard-tab">BONEYARD</div>
      <div id="boneyard-content"></div>
    </div>
  </div>

  <!-- Bid sheet (collapsible bottom panel) -->
  <div id="bid-sheet" class="hidden">
    <div class="bid-sheet-handle" onclick="document.getElementById('bid-sheet-toggle').click()">
      <h3>Your Bid — <span id="bid-current-label" style="font-size:.85rem;font-weight:400"></span></h3>
      <button class="bid-sheet-toggle" id="bid-sheet-toggle">&#9660;</button>
    </div>
    <div class="bid-sheet-body" id="bid-sheet-body">
      <div class="bid-grid" id="bid-buttons"></div>
    </div>
  </div>

  <!-- Trump select -->
  <div id="overlay-trump" class="overlay-full hidden">
    <div class="overlay-full-card">
      <h3 id="trump-card-title">Select Trump</h3>
      <p class="bid-subtitle">Choose the trump suit for this hand</p>
      <div class="trump-grid" id="trump-buttons"></div>
    </div>
  </div>

  <!-- Hand result -->
  <div id="overlay-hand-end" class="overlay-full hidden">
    <div class="overlay-full-card">
      <h3 id="result-title"></h3>
      <div id="result-body"></div>
      <button id="btn-next-hand" class="btn-primary">Next Hand</button>
    </div>
  </div>

  <!-- Game over -->
  <div id="overlay-game-over" class="overlay-full hidden">
    <div class="overlay-full-card">
      <h3 id="gameover-title">Game Over</h3>
      <div id="gameover-body"></div>
      <button id="btn-play-again" class="btn-primary">Play Again</button>
    </div>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

// ─── Express + Socket.io ──────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/', (req, res) => { res.setHeader('Content-Type', 'text/html'); res.send(getHTML()); });
app.get('/index.html', (req, res) => { res.setHeader('Content-Type', 'text/html'); res.send(getHTML()); });

// ─── Room storage ─────────────────────────────────────────────────────────────

const rooms = new Map();

function makeRoom(code) {
  return {
    code,
    seats: [null, null, null, null],
    state: 'lobby',
    hands: [[], [], [], []],
    bid: null,
    bids: [],
    currentBidder: 0,
    trump: null,
    bidType: null,       // 'high' | 'low' | 'plunge' | 'follow_me'
    trickTrump: null,    // for follow_me: trump of current trick
    trumpSelector: -1,   // who picks trump
    sittingOut: -1,      // seat index of player sitting out (42 low)
    trick: [],
    trickCount: [0,0,0,0],
    pointsTaken: [0,0,0,0],
    currentPlayer: 0,
    score: [0, 0],
    dealer: 0,
    lastTrick: null,
    handHistory: [],
    boneyard: [],        // all tiles played this game
  };
}

function pub(room) {
  return {
    code: room.code,
    seats: room.seats,
    state: room.state,
    bid: room.bid,
    bids: room.bids,
    currentBidder: room.currentBidder,
    trump: room.trump,
    bidType: room.bidType,
    trickTrump: room.trickTrump,
    trumpSelector: room.trumpSelector,
    sittingOut: room.sittingOut,
    trick: room.trick,
    trickCount: room.trickCount,
    pointsTaken: room.pointsTaken,
    currentPlayer: room.currentPlayer,
    score: room.score,
    dealer: room.dealer,
    lastTrick: room.lastTrick,
    handHistory: room.handHistory,
    boneyard: room.boneyard,
  };
}

function broadcast(room) {
  for (let i = 0; i < 4; i++) {
    const seat = room.seats[i];
    if (!seat || seat.disconnected) continue;
    // Compute available bids if this player is the current bidder
    let availableBids = [];
    if (room.state === 'bidding' && room.currentBidder === i) {
      availableBids = getAvailableBids(room.bid, room.hands[i], room.bids);
    }
    io.to(seat.socketId).emit('state', {
      ...pub(room),
      myHand: room.hands[i],
      mySeat: i,
      availableBids,
    });
  }
}

function findRoom(socketId) {
  for (const room of rooms.values())
    for (let i = 0; i < 4; i++)
      if (room.seats[i]?.socketId === socketId) return { room, seat: i };
  return null;
}

// ─── Game flow ────────────────────────────────────────────────────────────────

function startBidding(room) {
  room.hands = deal();
  room.bid = { amount: 0, type: null, label: '', marks: 0 };
  room.bids = [];
  room.trump = null;
  room.bidType = null;
  room.trickTrump = null;
  room.trumpSelector = -1;
  room.sittingOut = -1;
  room.trick = [];
  room.trickCount = [0,0,0,0];
  room.pointsTaken = [0,0,0,0];
  room.lastTrick = null;
  room.currentBidder = (room.dealer + 1) % 4;
  room.state = 'bidding';
  broadcast(room);
}

function advanceBidder(room) {
  // Find next non-passed seat
  const passed = new Set(room.bids.filter(b => b.type === 'pass').map(b => b.seatIndex));
  let next = (room.currentBidder + 1) % 4;
  let loops = 0;
  while (passed.has(next) && loops++ < 4) next = (next + 1) % 4;
  room.currentBidder = next;
}

function biddingComplete(room) {
  const passed = new Set(room.bids.filter(b => b.type === 'pass').map(b => b.seatIndex));
  const active = [0,1,2,3].filter(i => !passed.has(i));
  // Done if only one active bidder, or a plunge was bid (instant win)
  if (active.length === 1) return true;
  if (room.bid.type === 'plunge') return true;
  return false;
}

function openTrumpSelect(room) {
  const bid = room.bid;
  room.bidType = bid.type;

  if (bid.type === 'low') {
    // No trump, no trump select — bidder leads, partner sits out
    room.trump = null;
    room.trumpSelector = -1;
    room.sittingOut = (bid.seatIndex + 2) % 4; // partner is opposite seat
    room.currentPlayer = bid.seatIndex;
    room.state = 'playing';
    broadcast(room);
    return;
  }

  if (bid.type === 'plunge') {
    // Partner picks trump and leads
    const partner = (bid.seatIndex + 2) % 4;
    room.trumpSelector = partner;
    room.state = 'plunge_trump_select';
    broadcast(room);
    return;
  }

  // High or follow_me — bidder picks trump (follow_me is just a trump option)
  room.trumpSelector = bid.seatIndex;
  room.state = 'trump_select';
  broadcast(room);
}

function startPlay(room, trump, followMe) {
  if (followMe) {
    room.bidType = 'follow_me';
    room.trump = null;
    room.trickTrump = null;
  } else {
    room.trump = trump;
  }

  if (room.state === 'plunge_trump_select') {
    // Partner leads
    room.currentPlayer = (room.bid.seatIndex + 2) % 4;
  } else {
    room.currentPlayer = room.bid.seatIndex;
  }
  room.state = 'playing';
  broadcast(room);
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
  broadcast(room);
}

// ─── Socket handlers ──────────────────────────────────────────────────────────

io.on('connection', socket => {

  socket.on('createRoom', ({ name }) => {
    let code;
    do { code = Math.random().toString(36).slice(2,6).toUpperCase(); } while (rooms.has(code));
    const room = makeRoom(code);
    // Random dealer assigned when game starts
    room.seats[0] = { socketId: socket.id, name };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('joined', { code, seat: 0, name });
    broadcast(room);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.state !== 'lobby') { socket.emit('error', 'Game already in progress'); return; }
    const empty = room.seats.findIndex(s => s === null);
    if (empty === -1) { socket.emit('error', 'Room is full'); return; }
    room.seats[empty] = { socketId: socket.id, name };
    socket.join(code.toUpperCase());
    socket.emit('joined', { code: room.code, seat: empty, name });
    broadcast(room);
  });

  socket.on('startGame', () => {
    const found = findRoom(socket.id); if (!found) return;
    const { room, seat } = found;
    if (seat !== 0) { socket.emit('error', 'Only the host can start'); return; }
    if (room.seats.some(s => s === null)) { socket.emit('error', 'Need 4 players'); return; }
    // Random dealer
    room.dealer = Math.floor(Math.random() * 4);
    startBidding(room);
  });

  socket.on('placeBid', ({ amount, type, marks, plungeLevel }) => {
    const found = findRoom(socket.id); if (!found) return;
    const { room, seat } = found;
    if (room.state !== 'bidding') return;
    if (room.currentBidder !== seat) { socket.emit('error', 'Not your turn to bid'); return; }

    const label = type === 'pass' ? 'Pass'
      : type === 'low'    ? `${amount} Low`
      : type === 'plunge' ? `Plunge (${plungeLevel || 2} marks)`
      : String(amount);

    const bidObj = { amount, type, label, marks: marks || 1, plungeLevel, seatIndex: seat };

    if (type === 'pass') {
      room.bids.push(bidObj);
      const passed = room.bids.filter(b => b.type === 'pass').length;
      // If 3 passed and someone has a real bid
      if (passed === 3 && room.bid.amount > 0) { openTrumpSelect(room); return; }
      // If all 4 pass somehow — dealer forced (shouldn't happen with dealer logic but safety net)
      if (passed === 4) {
        room.bid = { amount: 30, type: 'high', label: '30 (forced)', marks: 1, seatIndex: room.dealer };
        room.bids.push(room.bid);
        openTrumpSelect(room); return;
      }
      // If we've come back around to dealer and dealer is last
      advanceBidder(room);
      // Check if next bidder is dealer and everyone else passed — dealer must bid
      const passedSet = new Set(room.bids.filter(b => b.type === 'pass').map(b => b.seatIndex));
      const active = [0,1,2,3].filter(i => !passedSet.has(i));
      if (active.length === 1 && room.bid.amount === 0) {
        // Dealer forced — they must bid but we wait for them to choose
      }
      broadcast(room); return;
    }

    room.bid = bidObj;
    room.bids.push(bidObj);

    if (biddingComplete(room)) { openTrumpSelect(room); return; }
    advanceBidder(room);
    broadcast(room);
  });

  socket.on('selectTrump', ({ trump, followMe }) => {
    const found = findRoom(socket.id); if (!found) return;
    const { room, seat } = found;
    if (room.state !== 'trump_select' && room.state !== 'plunge_trump_select') return;
    if (room.trumpSelector !== seat) { socket.emit('error', 'Not your turn to select trump'); return; }
    startPlay(room, trump, followMe);
  });

  socket.on('playTile', ({ tileId }) => {
    const found = findRoom(socket.id); if (!found) return;
    const { room, seat } = found;
    if (room.state !== 'playing') return;
    if (room.currentPlayer !== seat) { socket.emit('error', 'Not your turn'); return; }
    if (room.sittingOut === seat) { socket.emit('error', 'You are sitting out this hand'); return; }

    const hand = room.hands[seat];
    const idx = hand.findIndex(t => t.id === tileId);
    if (idx === -1) { socket.emit('error', 'Tile not in hand'); return; }

    const tile = hand[idx];

    // Follow-suit enforcement
    if (room.trick.length > 0) {
      const leadTile = room.trick[0].tile;
      const effectiveTrump = room.bidType === 'follow_me' ? room.trickTrump : room.trump;

      const leadIsTrump = effectiveTrump !== null && (leadTile.hi === effectiveTrump || leadTile.lo === effectiveTrump);
      const ledSuit = leadIsTrump ? effectiveTrump : leadTile.hi;
      const tileIsTrump = effectiveTrump !== null && (tile.hi === effectiveTrump || tile.lo === effectiveTrump);

      if (effectiveTrump === null) {
        // Low hand: no trump, follow high-end suit
        const ledSuitLow = leadTile.hi;
        const canFollow = hand.some(t => t.hi === ledSuitLow || t.lo === ledSuitLow);
        if (canFollow && !(tile.hi === ledSuitLow || tile.lo === ledSuitLow)) {
          socket.emit('error', 'Must follow suit'); return;
        }
      } else {
        const canFollowTrump = hand.some(t => t.hi === effectiveTrump || t.lo === effectiveTrump);
        const canFollowSuit  = hand.some(t => (t.hi !== effectiveTrump && t.lo !== effectiveTrump) && (t.hi === ledSuit || t.lo === ledSuit));
        if (leadIsTrump && canFollowTrump && !tileIsTrump) { socket.emit('error', 'Must follow trump'); return; }
        if (!leadIsTrump && canFollowSuit && (tileIsTrump || !(tile.hi === ledSuit || tile.lo === ledSuit))) { socket.emit('error', 'Must follow suit'); return; }
      }
    }

    // Set follow_me trick trump on the lead play
    if (room.bidType === 'follow_me' && room.trick.length === 0) {
      room.trickTrump = tile.hi; // high end of lead sets trump for this trick
    }

    hand.splice(idx, 1)[0];
    room.trick.push({ seatIndex: seat, tile });

    // In low hand, skip sitting-out player
    const activePlayers = room.sittingOut >= 0 ? [0,1,2,3].filter(s => s !== room.sittingOut) : [0,1,2,3];

    if (room.trick.length === activePlayers.length) {
      // Resolve trick
      const effectiveTrump = room.bidType === 'follow_me' ? room.trickTrump : room.trump;
      const winner = trickWinner(room.trick, effectiveTrump);
      const pts = room.trick.reduce((s, p) => s + tileScore(p.tile), 0) + 1;
      room.pointsTaken[winner] += pts;
      room.trickCount[winner]++;

      // Add played tiles to boneyard
      room.trick.forEach(p => room.boneyard.push(p.tile));

      room.lastTrick = { plays: [...room.trick], winner };
      room.trick = [];
      room.trickTrump = null; // reset for next trick in follow_me

      // Low hand: if bidder took a trick, they lose immediately
      if (room.bidType === 'low' && winner === room.bid.seatIndex) {
        resolveHand(room); return;
      }

      const totalTricks = room.trickCount.reduce((a,b)=>a+b,0);
      if (totalTricks === 7 || (room.sittingOut >= 0 && totalTricks === 6)) {
        resolveHand(room); return;
      }

      // Next leader — skip sitting out
      let next = winner;
      if (room.sittingOut === next) next = (next + 1) % 4;
      room.currentPlayer = next;
    } else {
      // Advance to next active player
      let next = (seat + 1) % 4;
      if (room.sittingOut === next) next = (next + 1) % 4;
      room.currentPlayer = next;
    }
    broadcast(room);
  });

  socket.on('nextHand', () => {
    const found = findRoom(socket.id); if (!found) return;
    const { room } = found;
    if (room.state === 'hand_end') startBidding(room);
  });

  socket.on('disconnect', () => {
    const found = findRoom(socket.id); if (!found) return;
    const { room, seat } = found;
    if (room.seats[seat]) room.seats[seat] = { ...room.seats[seat], disconnected: true };
    broadcast(room);
  });

  socket.on('rejoin', ({ code, seat, name }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.seats[seat]?.name !== name) { socket.emit('error', 'Name mismatch'); return; }
    room.seats[seat] = { socketId: socket.id, name };
    socket.join(code.toUpperCase());
    socket.emit('joined', { code: room.code, seat, name });
    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`42 Dominoes running on port ${PORT}`));
