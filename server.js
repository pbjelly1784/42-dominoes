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
  return tiles;
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
  const t = shuffle(makeDominoes());
  return [t.slice(0,7), t.slice(7,14), t.slice(14,21), t.slice(21,28)];
}

function tileScore(tile) {
  const s = tile.hi + tile.lo;
  return (s === 5 || s === 10) ? s : 0;
}

function isTrump(tile, trump) {
  if (trump === null || trump === undefined) return false;
  return tile.hi === trump || tile.lo === trump;
}

function isDouble(tile) { return tile.hi === tile.lo; }

// The suit of a tile when leading (non-trump): always the hi end (hi >= lo)
function tileSuit(tile, trump) {
  if (isTrump(tile, trump)) return trump;
  return tile.hi;
}

// Pip strength of a tile within its suit
// Doubles are highest within their suit (strength = 100 + number)
// Non-doubles: primary = hi end (suit), tiebreaker = lo end
// e.g. 5-3 > 5-2 > 5-1 because lo end 3 > 2 > 1
function tileStrength(tile) {
  if (isDouble(tile)) return 100 + tile.hi;
  // hi*10 + lo: within same suit (same hi), lo end breaks ties
  return tile.hi * 10 + tile.lo;
}

// In 42 Low, doubles are their own suit separate from all numbers
function lowSuitOf(tile) {
  if (isDouble(tile)) return 'double';
  return tile.hi; // higher end is the suit for non-doubles
}

// Determine trick winner
// plays = [{seatIndex, tile}, ...], plays[0] is the lead
// trump = 0-6 or null
// isLow = true for 42 Low hands (doubles are own suit)
function trickWinner(plays, trump, isLow) {
  const leadTile = plays[0].tile;

  if (isLow) {
    // 42 Low: no trump, doubles are their own suit
    const ledSuit = lowSuitOf(leadTile);
    let best = plays[0];
    for (let i = 1; i < plays.length; i++) {
      const p = plays[i];
      const pSuit = lowSuitOf(p.tile);
      const bestSuit = lowSuitOf(best.tile);
      if (pSuit === ledSuit) {
        if (bestSuit !== ledSuit) {
          best = p; // challenger follows suit, current best doesn't
        } else {
          // Both follow led suit — higher strength wins
          if (tileStrength(p.tile) > tileStrength(best.tile)) best = p;
        }
      }
      // Off-suit cannot win
    }
    return best.seatIndex;
  }

  // Normal / high hand logic
  const ledSuit = tileSuit(leadTile, trump);
  const leadIsTrump = isTrump(leadTile, trump);
  let best = plays[0];
  let bestIsTrump = leadIsTrump;

  for (let i = 1; i < plays.length; i++) {
    const p = plays[i];
    const pTrump = isTrump(p.tile, trump);
    if (pTrump && !bestIsTrump) {
      best = p; bestIsTrump = true;
    } else if (pTrump && bestIsTrump) {
      if (tileStrength(p.tile) > tileStrength(best.tile)) best = p;
    } else if (!pTrump && !bestIsTrump) {
      const pSuit = tileSuit(p.tile, trump);
      const bestSuit = tileSuit(best.tile, trump);
      if (pSuit === ledSuit) {
        if (bestSuit !== ledSuit) best = p;
        else if (tileStrength(p.tile) > tileStrength(best.tile)) best = p;
      }
    }
  }
  return best.seatIndex;
}

// Server-side legal play check
function isLegalPlay(tile, hand, trick, trump, bidType, trickTrump) {
  if (trick.length === 0) return true;
  const leadTile = trick[0].tile;

  if (bidType === 'low') {
    // 42 Low: doubles are their own suit, non-doubles follow high end
    const ledSuit = lowSuitOf(leadTile);
    const tileInSuit = lowSuitOf(tile) === ledSuit;
    const canFollow = hand.some(t => lowSuitOf(t) === ledSuit);
    if (!canFollow) return true;
    return tileInSuit;
  }

  const effectiveTrump = bidType === 'follow_me' ? trickTrump : trump;
  const leadIsTrump = isTrump(leadTile, effectiveTrump);
  const ledSuit = leadIsTrump ? effectiveTrump : leadTile.hi;

  const tileIsT = isTrump(tile, effectiveTrump);
  const canFollowTrump = hand.some(t => isTrump(t, effectiveTrump));
  const canFollowSuit = hand.some(t => !isTrump(t, effectiveTrump) && (t.hi === ledSuit || t.lo === ledSuit));

  if (leadIsTrump) {
    if (canFollowTrump) return tileIsT;
    return true;
  } else {
    if (canFollowSuit) return !tileIsT && (tile.hi === ledSuit || tile.lo === ledSuit);
    return true;
  }
}

// Score a completed hand, returns marks delta {0: n, 1: n}
function scoreHand(bid, trickCount, pointsTaken) {
  const bidTeam = bid.seatIndex % 2;
  const defTeam = 1 - bidTeam;
  const teamTricks = [trickCount[0]+trickCount[2], trickCount[1]+trickCount[3]];
  const teamPts    = [pointsTaken[0]+pointsTaken[2], pointsTaken[1]+pointsTaken[3]];
  const bidTotal   = teamTricks[bidTeam] + teamPts[bidTeam];
  let delta = {0:0, 1:0};

  if (bid.type === 'plunge') {
    const won = teamTricks[bidTeam] === 7;
    delta[won ? bidTeam : defTeam] = bid.marks || 2;
    return delta;
  }
  if (bid.type === 'low') {
    // Bidder wins only if they took ZERO tricks
    const won = trickCount[bid.seatIndex] === 0;
    delta[won ? bidTeam : defTeam] = bid.marks || 1;
    return delta;
  }
  // High / follow_me
  const won = bidTotal >= bid.amount;
  delta[won ? bidTeam : defTeam] = bid.marks || 1;
  return delta;
}

// Build available bids for a player
function getAvailableBids(highBid, hand, allBids, isDealer, forced) {
  const hAmount = highBid ? highBid.amount : 0;
  const hType   = highBid ? highBid.type   : null;
  const any42   = allBids.some(b => b.amount >= 42 && b.type !== 'pass');
  const any84   = allBids.some(b => b.amount >= 84 && b.type !== 'pass');
  const doubles = hand.filter(t => t.hi === t.lo).length;
  const plungeCount = allBids.filter(b => b.type === 'plunge').length;
  const bids = [];

  // Standard high 30-42
  for (let n = 30; n <= 42; n++) {
    bids.push({ amount: n, type: 'high', label: String(n), enabled: hAmount < n && hType !== 'plunge' });
  }

  // 42 Low
  bids.push({
    amount: 42, type: 'low', label: '42 Low',
    enabled: hAmount < 42 && hType !== 'low' && hType !== 'plunge',
    marks: 1
  });

  // 84 High — always available as upgrade
  bids.push({ amount: 84, type: 'high', label: '84 High', enabled: hAmount < 84 && hType !== 'plunge', marks: 2 });

  // 84 Low — only if someone already bid 42 (high or low)
  bids.push({ amount: 84, type: 'low', label: '84 Low', enabled: any42 && hAmount < 84 && hType !== 'plunge', marks: 2 });

  // Plunge — needs 4+ doubles, starts at 2 marks +1 per prior plunge bid
  const plungeMarks = 2 + plungeCount;
  bids.push({
    amount: 84, type: 'plunge', label: `Plunge (${plungeMarks} marks)`,
    enabled: doubles >= 4 && hAmount < 84,
    marks: plungeMarks, plungeLevel: plungeMarks
  });

  // Doubling chain 126 / 168 / 210 — only after an 84 bid
  if (any84) {
    for (const [amt, marks] of [[126,3],[168,4],[210,5]]) {
      bids.push({ amount: amt, type: 'high',   label: `${amt} High`,   enabled: hAmount < amt, marks });
      bids.push({ amount: amt, type: 'low',    label: `${amt} Low`,    enabled: hAmount < amt, marks });
      bids.push({ amount: amt, type: 'plunge', label: `${amt} Plunge`, enabled: doubles >= 4 && hAmount < amt, marks, plungeLevel: marks });
    }
  }

  bids.push({ amount: 0, type: 'pass', label: 'Pass', enabled: !forced });
  return bids;
}

// ─── CSS ──────────────────────────────────────────────────────────────────────

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --felt:#1a5c38;--felt-dark:#123e27;--felt-edge:#0d2e1a;
  --ivory:#f5f0e8;--pip:#1a1a1a;--gold:#c9a84c;--gold-light:#e8c96a;
  --text-main:#f5f0e8;--text-dim:rgba(245,240,232,.6);
  --card-bg:rgba(10,30,18,.92);--card-border:rgba(201,168,76,.25);
  --radius:12px;--tile-w:50px;--tile-h:92px;
  font-family:'DM Sans',sans-serif;
}
html,body{height:100%;overflow:hidden}
body{background:var(--felt-dark);color:var(--text-main);display:flex;align-items:center;justify-content:center}
.screen{display:none;width:100%;height:100%}
.screen.active{display:flex;align-items:center;justify-content:center}
#screen-game.active{display:flex;flex-direction:column}

/* Lobby / Waiting */
.lobby-card,.waiting-card{
  background:var(--card-bg);border:1px solid var(--card-border);border-radius:var(--radius);
  padding:2.5rem 2.5rem 2rem;width:min(420px,92vw);display:flex;flex-direction:column;gap:1.1rem;
  backdrop-filter:blur(12px)
}
h1{font-family:'Playfair Display',serif;font-size:2.6rem;color:var(--gold);text-align:center;letter-spacing:.04em;line-height:1}
h2{font-family:'Playfair Display',serif;font-size:1.5rem;color:var(--gold);text-align:center}
.subtitle{text-align:center;color:var(--text-dim);font-size:.88rem}
input[type=text]{
  width:100%;background:rgba(255,255,255,.07);border:1px solid rgba(201,168,76,.3);border-radius:8px;
  color:var(--ivory);padding:.65rem 1rem;font-size:1rem;font-family:inherit;outline:none;transition:border-color .2s
}
input[type=text]:focus{border-color:var(--gold)}
input[type=text]::placeholder{color:var(--text-dim)}
.lobby-actions{display:flex;flex-direction:column;gap:.75rem}
.join-row{display:flex;gap:.6rem}
.join-row input{flex:1;text-transform:uppercase;letter-spacing:.12em}
.btn-primary{
  background:var(--gold);color:#1a1a1a;border:none;border-radius:8px;padding:.7rem 1.2rem;
  font-size:.92rem;font-weight:600;font-family:inherit;cursor:pointer;width:100%;transition:background .15s,transform .1s
}
.btn-primary:hover{background:var(--gold-light)}
.btn-primary:active{transform:scale(.98)}
.btn-secondary{
  background:transparent;color:var(--gold);border:1px solid var(--gold);border-radius:8px;
  padding:.7rem 1.1rem;font-size:.92rem;font-weight:500;font-family:inherit;cursor:pointer;white-space:nowrap;transition:background .15s
}
.btn-secondary:hover{background:rgba(201,168,76,.12)}
.error-msg{color:#e07070;font-size:.82rem;min-height:1.1em;text-align:center}
.room-code-display{
  text-align:center;font-size:1.5rem;font-family:'Playfair Display',serif;color:var(--gold);
  letter-spacing:.18em;display:flex;align-items:center;justify-content:center;gap:.5rem
}
.btn-copy{background:none;border:1px solid var(--card-border);color:var(--gold);border-radius:6px;padding:.18rem .5rem;font-size:.88rem;cursor:pointer}
.btn-copy:hover{background:rgba(201,168,76,.1)}
.seat-list{display:flex;flex-direction:column;gap:.45rem}
.seat-row{
  display:flex;align-items:center;gap:.75rem;padding:.55rem .85rem;
  background:rgba(255,255,255,.05);border-radius:8px;border:1px solid rgba(255,255,255,.08)
}
.seat-row .seat-num{color:var(--gold);font-weight:600;min-width:20px}
.seat-row .seat-team{font-size:.72rem;color:var(--text-dim);margin-left:auto}
.seat-row.empty{opacity:.4;font-style:italic}
.waiting-hint{text-align:center;font-size:.8rem;color:var(--text-dim)}

/* Score / info bar */
.score-bar{
  display:flex;align-items:center;justify-content:space-between;
  background:var(--felt-edge);border-bottom:1px solid rgba(201,168,76,.2);
  padding:.4rem 1rem;flex-shrink:0;gap:.5rem
}
.score-team{display:flex;align-items:center;gap:.4rem}
.score-team.right{flex-direction:row-reverse}
.team-label{font-size:.72rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em}
.team-marks{font-family:'Playfair Display',serif;font-size:1.6rem;color:var(--gold);line-height:1;min-width:1.5ch;text-align:center}
.team-pip{font-size:.68rem;color:var(--text-dim)}
.score-center{display:flex;flex-direction:column;align-items:center;gap:.1rem;flex:1}
#game-status-label{font-size:.75rem;color:var(--text-dim)}
.room-tag{font-size:.65rem;color:rgba(201,168,76,.45);letter-spacing:.1em}

/* Trump + bid banner */
#info-banner{
  background:rgba(8,22,14,.95);border-bottom:1px solid rgba(201,168,76,.2);
  padding:.3rem 1rem;display:none;gap:1rem;align-items:center;justify-content:center;
  flex-wrap:wrap;flex-shrink:0
}
#info-banner.visible{display:flex}
.banner-item{font-size:.78rem;color:var(--text-dim);display:flex;align-items:center;gap:.35rem}
.banner-val{color:var(--gold);font-weight:500}
.banner-sep{color:rgba(201,168,76,.3)}

/* Points bar */
#points-bar{
  background:rgba(5,18,10,.9);border-bottom:1px solid rgba(201,168,76,.15);
  padding:.28rem 1rem;display:none;gap:2rem;align-items:center;justify-content:center;
  flex-shrink:0;font-size:.75rem
}
#points-bar.visible{display:flex}
.pts-team{display:flex;align-items:center;gap:.4rem}
.pts-label{color:var(--text-dim)}
.pts-val{color:var(--gold);font-weight:500;font-size:.85rem}
.pts-need{color:rgba(201,168,76,.5);font-size:.7rem}

/* Table */
.table-wrap{
  flex:1;position:relative;display:grid;
  grid-template-areas:". top ." "left center right" ". bottom .";
  grid-template-columns:110px 1fr 110px;grid-template-rows:108px 1fr 148px;
  gap:4px;padding:6px;overflow:hidden
}
.player-zone{display:flex;align-items:center;justify-content:center;position:relative}
.player-zone.top{grid-area:top;flex-direction:column;gap:4px}
.player-zone.left{grid-area:left;flex-direction:column;gap:4px}
.player-zone.right{grid-area:right;flex-direction:column;gap:4px}
.player-zone.bottom{grid-area:bottom;flex-direction:column;gap:5px}
.player-name-tag{
  font-size:.74rem;font-weight:500;color:var(--text-dim);background:rgba(0,0,0,.3);
  border:1px solid rgba(201,168,76,.15);border-radius:20px;padding:.18rem .65rem;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:105px
}
.player-name-tag.active-player{color:var(--gold);border-color:rgba(201,168,76,.55);background:rgba(201,168,76,.08)}
.player-name-tag.sitting-out{color:#e07070;border-color:rgba(220,100,100,.3);text-decoration:line-through}
.team-badge{display:inline-block;background:rgba(201,168,76,.15);color:var(--gold);border-radius:10px;font-size:.6rem;padding:.05rem .3rem;margin-left:.3rem;vertical-align:middle}
.opponent-hand{display:flex;gap:3px;align-items:center;justify-content:center;flex-wrap:nowrap}
.opponent-hand.vertical{flex-direction:column}

/* Tiles */
.tile{
  width:var(--tile-w);height:var(--tile-h);background:var(--ivory);border-radius:6px;
  border:1px solid #ccc;display:flex;flex-direction:column;align-items:center;
  justify-content:space-between;padding:5px;cursor:default;flex-shrink:0;
  user-select:none;box-shadow:0 2px 5px rgba(0,0,0,.4);transition:transform .12s,box-shadow .12s
}
.tile.playable{cursor:pointer;border-color:var(--gold)}
.tile.playable:hover{transform:translateY(-10px);box-shadow:0 10px 22px rgba(0,0,0,.5)}
.tile.playable:active{transform:translateY(-5px)}
.tile.illegal{opacity:.35;cursor:not-allowed}
.tile.trump-tile{border-color:#c0392b;box-shadow:0 0 0 2px rgba(192,57,43,.35),0 2px 5px rgba(0,0,0,.4)}
.tile.double-tile{border-color:#8ecdf5;box-shadow:0 0 0 1px rgba(100,180,240,.3),0 2px 5px rgba(0,0,0,.4)}
.tile .half{width:100%;display:flex;align-items:center;justify-content:center;flex:1}
.tile .divider{width:78%;height:1px;background:#bbb;flex-shrink:0}
.tile-back{background:var(--felt);border:1px solid rgba(201,168,76,.3);width:24px;height:44px;border-radius:4px;flex-shrink:0}
.pips{display:grid;gap:3px;align-items:center;justify-items:center;padding:2px}
.pip{width:7px;height:7px;background:var(--pip);border-radius:50%}
.pips[data-n="0"]{min-height:22px}
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
.trick-center-info{min-width:56px;text-align:center}
.tile.trick-winner{box-shadow:0 0 0 3px var(--gold),0 4px 12px rgba(0,0,0,.5)}

/* My hand */
.my-hand{
  display:flex;gap:5px;align-items:flex-end;justify-content:center;
  overflow-x:auto;padding:4px 4px 0;max-width:100%;flex-wrap:nowrap
}

/* Full-screen overlays */
.overlay-full{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);z-index:100}
.overlay-full.hidden{display:none}
.overlay-full-card{
  background:#0b2016;border:1px solid var(--card-border);border-radius:var(--radius);
  padding:1.6rem 1.8rem;min-width:290px;max-width:min(460px,92vw);display:flex;flex-direction:column;gap:.9rem
}
.overlay-full-card h3{font-family:'Playfair Display',serif;color:var(--gold);font-size:1.3rem;text-align:center}
.bid-subtitle{text-align:center;font-size:.8rem;color:var(--text-dim)}

/* Bid panel — compact centered floating overlay */
#bid-panel{
  position:absolute;bottom:160px;left:50%;transform:translateX(-50%);
  z-index:200;pointer-events:all;width:auto;min-width:320px;max-width:520px
}
#bid-panel.hidden{display:none}
#bid-panel-inner{
  background:rgba(8,24,14,.72);border:1px solid rgba(201,168,76,.35);
  border-radius:var(--radius);backdrop-filter:blur(2px);
  display:flex;flex-direction:column;padding:.6rem .8rem .7rem
}
.bid-panel-head{
  display:flex;align-items:center;justify-content:center;gap:.6rem;
  margin-bottom:.45rem;flex-shrink:0
}
.bid-panel-head h3{font-family:'Playfair Display',serif;color:var(--gold);font-size:.9rem;margin:0}
.bid-panel-sub{font-size:.7rem;color:var(--text-dim);text-align:center;margin-bottom:.45rem;flex-shrink:0}
.bid-panel-body{overflow:visible}
.bid-grid{display:flex;flex-wrap:wrap;gap:5px;justify-content:center}
.bid-btn{
  background:rgba(10,30,18,.82);border:1px solid rgba(201,168,76,.28);border-radius:7px;
  color:var(--ivory);padding:.38rem .7rem;font-family:inherit;font-size:.78rem;font-weight:500;
  cursor:pointer;transition:background .12s,border-color .12s;text-align:center;white-space:nowrap
}
.bid-btn:hover:not(:disabled){background:rgba(201,168,76,.2);border-color:var(--gold)}
.bid-btn.low-btn{color:#a8e6cf;border-color:rgba(100,220,170,.3)}
.bid-btn.plunge-btn{color:var(--gold);border-color:rgba(201,168,76,.5)}
.bid-btn.double-btn{color:#8ecdf5;border-color:rgba(100,180,240,.3)}
.bid-btn.pass-btn{color:#e07070;border-color:rgba(220,100,100,.3)}
.bid-btn:disabled{opacity:.22;cursor:not-allowed;pointer-events:none}

/* Trump select — same floating panel as bid menu */
#trump-panel{
  position:absolute;bottom:160px;left:50%;transform:translateX(-50%);
  z-index:200;pointer-events:all;width:auto;min-width:320px;max-width:520px
}
#trump-panel.hidden{display:none}
#trump-panel-inner{
  background:rgba(8,24,14,.72);border:1px solid rgba(201,168,76,.35);
  border-radius:var(--radius);backdrop-filter:blur(2px);
  padding:.6rem .8rem .7rem;display:flex;flex-direction:column
}
.trump-panel-head{
  display:flex;align-items:center;justify-content:center;margin-bottom:.45rem
}
.trump-panel-head h3{font-family:'Playfair Display',serif;color:var(--gold);font-size:.9rem;margin:0}
.trump-panel-sub{font-size:.7rem;color:var(--text-dim);text-align:center;margin-bottom:.45rem}
.trump-grid{display:flex;flex-wrap:wrap;gap:5px;justify-content:center}
.trump-btn{
  background:rgba(10,30,18,.82);border:1px solid rgba(201,168,76,.28);border-radius:7px;
  color:var(--ivory);padding:.38rem .7rem;font-family:inherit;font-size:.78rem;font-weight:500;
  cursor:pointer;transition:background .12s,border-color .12s;white-space:nowrap;
  display:flex;align-items:center;gap:.35rem
}
.trump-btn:hover{background:rgba(201,168,76,.2);border-color:var(--gold)}
.trump-btn.follow-me-btn{border-color:rgba(100,180,240,.38);color:#8ecdf5}
.trump-pip-n{width:18px;height:18px;background:var(--pip);border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--ivory);font-size:.65rem;font-weight:600;flex-shrink:0}
.trump-count{font-size:.65rem;color:var(--gold)}

/* Result */
.result-made{color:#6fcf97}
.result-set{color:#eb5757}
#result-body,#gameover-body{font-size:.88rem;color:var(--text-dim);line-height:1.7;text-align:center}

/* Boneyard */
#boneyard-panel{position:absolute;left:0;top:50%;transform:translateY(-50%);z-index:50}
.boneyard-tab{
  background:rgba(10,28,16,.92);border:1px solid var(--card-border);border-left:none;
  border-radius:0 8px 8px 0;padding:.45rem .5rem;font-size:.68rem;color:var(--gold);
  cursor:pointer;writing-mode:vertical-rl;text-orientation:mixed;letter-spacing:.07em;user-select:none
}
.boneyard-tab:hover{background:rgba(201,168,76,.1)}
#boneyard-drawer{
  position:absolute;left:100%;top:50%;transform:translateY(-50%);
  background:rgba(8,24,14,.97);border:1px solid var(--card-border);border-radius:0 8px 8px 0;
  padding:.65rem .7rem;max-height:75vh;overflow-y:auto;min-width:210px;display:none;z-index:51
}
#boneyard-drawer.open{display:block}
#boneyard-drawer h4{font-size:.72rem;color:var(--gold);margin-bottom:.5rem;letter-spacing:.05em;border-bottom:1px solid rgba(201,168,76,.15);padding-bottom:.3rem}
.by-trick{display:flex;gap:3px;margin-bottom:5px;align-items:center}
.by-trick-num{font-size:.62rem;color:var(--text-dim);min-width:14px;text-align:right;margin-right:2px}
.by-tile{
  width:18px;height:32px;background:var(--ivory);border-radius:3px;border:1px solid #bbb;
  display:flex;flex-direction:column;align-items:center;justify-content:space-between;
  padding:2px;flex-shrink:0
}
.by-tile .bt{font-size:6.5px;color:var(--pip);font-weight:700;line-height:1}
.by-tile .bd{width:80%;height:1px;background:#bbb}
.by-empty{font-size:.73rem;color:var(--text-dim);font-style:italic}

/* Dealer chip */
.dealer-chip{
  display:inline-block;background:var(--gold);color:#1a1a1a;font-size:.58rem;font-weight:700;
  border-radius:50%;width:15px;height:15px;text-align:center;line-height:15px;margin-left:3px;vertical-align:middle
}
.zone-active .player-name-tag{color:var(--gold);border-color:rgba(201,168,76,.55);background:rgba(201,168,76,.08)}

@media(max-width:600px){
  :root{--tile-w:36px;--tile-h:66px}
  .table-wrap{grid-template-columns:72px 1fr 72px;grid-template-rows:82px 1fr 138px}
  .tile-back{width:18px;height:32px}
  .bid-grid,.trump-grid{gap:4px}
  #bid-panel,#trump-panel{min-width:260px;max-width:90vw;bottom:130px}
}
`;

// ─── Client JS ────────────────────────────────────────────────────────────────

const CLIENT_JS = `
'use strict';
const socket=io();
let myName='',myRoom='',mySeat=-1,lastState=null,boneyardOpen=false;
const SUIT=['Blanks','Ones','Twos','Threes','Fours','Fives','Sixes'];

function showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active')}
function $$(id){return document.getElementById(id)}
function showFull(id){$$(id).classList.remove('hidden')}
function hideFull(id){$$(id).classList.add('hidden')}
function hideAllOverlays(){['overlay-hand-end','overlay-game-over'].forEach(hideFull);$$('bid-panel').classList.add('hidden');$$('trump-panel').classList.add('hidden')}

// Lobby
$$('btn-create').addEventListener('click',()=>{
  const n=$$('player-name').value.trim();if(!n){setErr('lobby-error','Enter your name');return}
  myName=n;socket.emit('createRoom',{name:n})
});
$$('btn-join').addEventListener('click',()=>{
  const n=$$('player-name').value.trim(),c=$$('room-code-input').value.trim();
  if(!n){setErr('lobby-error','Enter your name');return}if(!c){setErr('lobby-error','Enter room code');return}
  myName=n;socket.emit('joinRoom',{name:n,code:c})
});
$$('player-name').addEventListener('keydown',e=>{if(e.key==='Enter')$$('btn-create').click()});
$$('room-code-input').addEventListener('keydown',e=>{if(e.key==='Enter')$$('btn-join').click()});
$$('btn-copy-code').addEventListener('click',()=>{
  navigator.clipboard.writeText(myRoom).then(()=>{$$('btn-copy-code').textContent='✓';setTimeout(()=>$$('btn-copy-code').textContent='⧉',1500)})
});
$$('btn-start').addEventListener('click',()=>socket.emit('startGame'));
$$('btn-next-hand').addEventListener('click',()=>{socket.emit('nextHand');hideFull('overlay-hand-end')});
$$('btn-play-again').addEventListener('click',()=>location.reload());
function setErr(id,msg){$$(id).textContent=msg}

// Boneyard
$$('boneyard-tab').addEventListener('click',()=>{
  boneyardOpen=!boneyardOpen;
  $$('boneyard-drawer').classList.toggle('open',boneyardOpen)
});

socket.on('error',msg=>{
  if($$('screen-lobby').classList.contains('active'))setErr('lobby-error',msg);
  else if($$('screen-waiting').classList.contains('active'))setErr('waiting-error',msg);
  else alert(msg)
});

socket.on('joined',({code,seat,name})=>{
  myRoom=code;mySeat=seat;myName=name;
  $$('display-code').textContent=code;
  $$('score-room-code').textContent=code;
  $$('btn-start').style.display=seat===0?'block':'none';
  showScreen('screen-waiting');
  sessionStorage.setItem('42-room',code);sessionStorage.setItem('42-seat',seat);sessionStorage.setItem('42-name',name)
});

socket.on('state',state=>{
  lastState=state;
  if(state.state==='lobby'){renderWaiting(state);if(!$$('screen-waiting').classList.contains('active'))showScreen('screen-waiting');return}
  if(!$$('screen-game').classList.contains('active'))showScreen('screen-game');
  renderGame(state)
});

function renderWaiting(state){
  const list=$$('seat-list');list.innerHTML='';
  ['North','East','South','West'].forEach((pos,i)=>{
    const seat=state.seats[i],team=i%2===0?1:2;
    const row=document.createElement('div');
    row.className='seat-row'+(seat?'':' empty');
    row.innerHTML='<span class="seat-num">'+(i+1)+'</span><span>'+(seat?seat.name:'Empty')+'</span><span class="seat-team">'+pos+' · Team '+team+'</span>';
    list.appendChild(row)
  })
}

function teamOf(seat){return seat%2===0?1:2}

function seatOffset(s){return((s-mySeat+4)%4)}
function posOf(o){return['bottom','left','top','right'][o]}

function renderGame(state){
  // Marks
  $$('marks-0').textContent=state.score[0];
  $$('marks-1').textContent=state.score[1];

  // Status
  const sl={bidding:'Bidding',trump_select:'Selecting trump',plunge_trump_select:'Partner picks trump',playing:'Playing',hand_end:'Hand over',game_over:'Game over'};
  $$('game-status-label').textContent=sl[state.state]||'';

  // Info banner (trump + current bid)
  const banner=$$('info-banner');
  if(['playing','hand_end'].includes(state.state)){
    let trumpStr='';
    if(state.bidType==='low') trumpStr='No trump (Low hand)';
    else if(state.bidType==='follow_me') trumpStr='Follow Me'+(state.trickTrump!==null&&state.trickTrump!==undefined?' — trick trump: '+SUIT[state.trickTrump]:'');
    else if(state.trump!==null&&state.trump!==undefined) trumpStr='Trump: '+SUIT[state.trump];
    const bidStr=state.bid?state.bid.label:'—';
    banner.innerHTML=
      '<span class="banner-item">&#9670; <span class="banner-val">'+trumpStr+'</span></span>'+
      '<span class="banner-sep">|</span>'+
      '<span class="banner-item">Bid: <span class="banner-val">'+bidStr+'</span></span>';
    banner.classList.add('visible')
  } else banner.classList.remove('visible');

  // Points bar
  const pb=$$('points-bar');
  if(state.state==='playing'){
    const t1pts=(state.pointsTaken[0]||0)+(state.pointsTaken[2]||0);
    const t2pts=(state.pointsTaken[1]||0)+(state.pointsTaken[3]||0);
    const needed=state.bid?state.bid.amount:42;
    const bidTeam=state.bid?(state.bid.seatIndex%2===0?1:2):0;
    pb.innerHTML=
      '<div class="pts-team"><span class="pts-label">Team 1:</span><span class="pts-val">'+t1pts+' pts</span>'+(bidTeam===1?'<span class="pts-need">need '+needed+'</span>':'')+'</div>'+
      '<div class="pts-team"><span class="pts-label">Team 2:</span><span class="pts-val">'+t2pts+' pts</span>'+(bidTeam===2?'<span class="pts-need">need '+needed+'</span>':'')+'</div>';
    pb.classList.add('visible')
  } else pb.classList.remove('visible');

  // Players + hands
  for(let s=0;s<4;s++){
    const offset=seatOffset(s),pos=posOf(offset);
    const nameEl=$$('name-'+pos),handEl=$$('hand-'+pos);
    if(!nameEl||!handEl)continue;
    const seat=state.seats[s];
    const team=teamOf(s);
    let nameHtml=(seat?seat.name:'Seat '+(s+1))+'<span class="team-badge">T'+team+'</span>';
    if(s===state.dealer)nameHtml+='<span class="dealer-chip">D</span>';
    nameEl.innerHTML=nameHtml;
    const isActive=
      (state.state==='playing'&&state.currentPlayer===s&&state.sittingOut!==s)||
      (state.state==='bidding'&&state.currentBidder===s)||
      ((state.state==='trump_select'||state.state==='plunge_trump_select')&&state.trumpSelector===s);
    nameEl.classList.toggle('active-player',isActive);
    nameEl.classList.toggle('sitting-out',state.sittingOut===s);
    $$('zone-'+pos)?.classList.toggle('zone-active',isActive);
    handEl.innerHTML='';
    if(s===mySeat){
      const myTurn=state.state==='playing'&&state.currentPlayer===mySeat&&state.sittingOut!==mySeat;
      (state.myHand||[]).forEach(tile=>{
        const el=makeTileEl(tile,state.trump,state.bidType,state.trickTrump);
        if(myTurn){
          const legal=legalClient(tile,state.myHand,state.trick,state.trump,state.bidType,state.trickTrump);
          if(legal){el.classList.add('playable');el.addEventListener('click',()=>socket.emit('playTile',{tileId:tile.id}))}
          else el.classList.add('illegal')
        }
        handEl.appendChild(el)
      })
    } else {
      const played=state.trickCount.reduce((a,b)=>a+b,0);
      const inHand=Math.max(0,7-played-(state.sittingOut===s?0:0));
      // Count tiles remaining properly
      const remaining=7-played-(state.trick.some(p=>p.seatIndex===s)?1:0);
      for(let i=0;i<Math.max(0,remaining-(state.trick.some(p=>p.seatIndex===s)?0:0));i++){const b=document.createElement('div');b.className='tile-back';handEl.appendChild(b)}
    }
  }

  renderTrickArea(state);
  renderBoneyard(state);
  hideAllOverlays();

  if(state.state==='bidding'&&state.currentBidder===mySeat){
    renderBidPanel(state);$$('bid-panel').classList.remove('hidden')
  } else if((state.state==='trump_select'||state.state==='plunge_trump_select')&&state.trumpSelector===mySeat){
    renderTrumpOverlay(state);$$('trump-panel').classList.remove('hidden')
  } else if(state.state==='hand_end'){
    renderHandEnd(state);showFull('overlay-hand-end')
  } else if(state.state==='game_over'){
    renderGameOver(state);showFull('overlay-game-over')
  }
}

function lowSuitOf(tile){return tile.hi===tile.lo?'double':tile.hi}
function legalClient(tile,hand,trick,trump,bidType,trickTrump){
  if(trick.length===0)return true;
  const leadTile=trick[0].tile;
  if(bidType==='low'){
    const ls=lowSuitOf(leadTile);
    const tileInSuit=lowSuitOf(tile)===ls;
    const canFollow=hand.some(t=>lowSuitOf(t)===ls);
    if(!canFollow)return true;
    return tileInSuit;
  }
  const et=bidType==='follow_me'?trickTrump:trump;
  if(et===null||et===undefined){
    const ls=leadTile.hi;const can=hand.some(t=>t.hi===ls||t.lo===ls);
    if(!can)return true;return tile.hi===ls||tile.lo===ls
  }
  const lisTrump=leadTile.hi===et||leadTile.lo===et;
  const ls=lisTrump?et:leadTile.hi;
  const tisTrump=tile.hi===et||tile.lo===et;
  const canTrump=hand.some(t=>t.hi===et||t.lo===et);
  const canSuit=hand.some(t=>t.hi!==et&&t.lo!==et&&(t.hi===ls||t.lo===ls));
  if(lisTrump){return canTrump?tisTrump:true}
  return canSuit?((!tisTrump)&&(tile.hi===ls||tile.lo===ls)):true
}

function makeTileEl(tile,trump,bidType,trickTrump){
  const el=document.createElement('div');el.className='tile';el.dataset.id=tile.id;
  const et=bidType==='follow_me'?trickTrump:trump;
  if(et!==null&&et!==undefined&&(tile.hi===et||tile.lo===et))el.classList.add('trump-tile');
  else if(tile.hi===tile.lo)el.classList.add('double-tile');
  const top=document.createElement('div');top.className='half';top.appendChild(makePips(tile.hi));
  const div=document.createElement('div');div.className='divider';
  const bot=document.createElement('div');bot.className='half';bot.appendChild(makePips(tile.lo));
  el.appendChild(top);el.appendChild(div);el.appendChild(bot);return el
}

const PIP_POS={0:[],1:[[1,1]],2:[[0,0],[2,2]],3:[[0,0],[1,1],[2,2]],4:[[0,0],[2,0],[0,2],[2,2]],5:[[0,0],[2,0],[1,1],[0,2],[2,2]],6:[[0,0],[2,0],[0,1],[2,1],[0,2],[2,2]]};
function makePips(n){
  const c=document.createElement('div');c.className='pips';c.dataset.n=n;if(n===0)return c;
  if(n<=2){PIP_POS[n].forEach(()=>{const p=document.createElement('div');p.className='pip';c.appendChild(p)});return c}
  c.style.cssText='position:relative;width:26px;height:26px;';
  PIP_POS[n].forEach(([col,row])=>{const p=document.createElement('div');p.className='pip';p.style.cssText='position:absolute;left:'+(col*9)+'px;top:'+(row*9)+'px;';c.appendChild(p)});return c
}

function renderTrickArea(state){
  ['trick-bottom','trick-left','trick-top','trick-right'].forEach(id=>$$(id).innerHTML='');
  state.trick.forEach(play=>{
    const pos=posOf(seatOffset(play.seatIndex));
    const slot=$$('trick-'+pos);if(!slot)return;
    const el=makeTileEl(play.tile,state.trump,state.bidType,state.trickTrump);
    slot.appendChild(el)
  })
}

function renderBoneyard(state){
  const drawer=$$('boneyard-drawer');
  drawer.innerHTML='<h4>Boneyard — '+((state.boneyard||[]).length)+' tiles</h4>';
  if(!state.boneyard||state.boneyard.length===0){
    drawer.innerHTML+='<p class="by-empty">No tricks completed yet</p>';return
  }
  // Group into tricks of 4 (or 3 for low hands)
  const trickSize=state.sittingOut>=0?3:4;
  const tricks=[];
  for(let i=0;i<state.boneyard.length;i+=trickSize)tricks.push(state.boneyard.slice(i,i+trickSize));
  tricks.forEach((trick,ti)=>{
    const row=document.createElement('div');row.className='by-trick';
    const num=document.createElement('span');num.className='by-trick-num';num.textContent=(ti+1)+'.';
    row.appendChild(num);
    trick.forEach(tile=>{
      const el=document.createElement('div');el.className='by-tile';
      el.innerHTML='<span class="bt">'+tile.hi+'</span><div class="bd"></div><span class="bt">'+tile.lo+'</span>';
      row.appendChild(el)
    });
    drawer.appendChild(row)
  })
}

function renderBidPanel(state){
  const bids=state.availableBids||[];
  const cur=state.bid&&state.bid.amount>0?state.bid.label:'None';
  let bidHolder='';
  if(state.bid&&state.bid.seatIndex>=0&&state.bid.amount>0){
    const holderSeat=state.seats[state.bid.seatIndex];
    bidHolder=holderSeat?' — '+holderSeat.name:'';
  }
  $$('bid-panel-sub').textContent='Current: '+cur+bidHolder;
  const grid=$$('bid-buttons');grid.innerHTML='';
  bids.forEach(bid=>{
    const cls='bid-btn'+(bid.type==='pass'?' pass-btn':bid.type==='low'?' low-btn':bid.type==='plunge'?' plunge-btn':bid.amount>=84?' double-btn':'');
    const btn=document.createElement('button');btn.className=cls;btn.textContent=bid.label;
    if(!bid.enabled)btn.disabled=true;
    btn.addEventListener('click',()=>{
      socket.emit('placeBid',{amount:bid.amount,type:bid.type,marks:bid.marks,plungeLevel:bid.plungeLevel});
      $$('bid-panel').classList.add('hidden')
    });
    grid.appendChild(btn)
  })
}

function renderTrumpOverlay(state){
  const grid=$$('trump-buttons');grid.innerHTML='';
  const hand=state.myHand||[];
  const cnt=Array(7).fill(0);
  hand.forEach(t=>{cnt[t.hi]++;if(t.hi!==t.lo)cnt[t.lo]++});
  SUIT.forEach((name,i)=>{
    const btn=document.createElement('button');btn.className='trump-btn';
    btn.innerHTML='<div class="trump-pip-n">'+i+'</div><span>'+name+'</span><span class="trump-count">('+cnt[i]+')</span>';
    btn.addEventListener('click',()=>{socket.emit('selectTrump',{trump:i});$$('trump-panel').classList.add('hidden')});
    grid.appendChild(btn)
  });
  if(state.bidType==='high'){
    const fm=document.createElement('button');fm.className='trump-btn follow-me-btn';
    fm.innerHTML='<span>&#9733;</span><span>Follow Me</span>';
    fm.addEventListener('click',()=>{socket.emit('selectTrump',{trump:-1,followMe:true});$$('trump-panel').classList.add('hidden')});
    grid.appendChild(fm)
  }
  $$('trump-card-title').textContent=state.state==='plunge_trump_select'?'Partner: Pick Trump':'Select Trump'
}

function renderHandEnd(state){
  const last=state.handHistory[state.handHistory.length-1];if(!last)return;
  const bt='Team '+(last.bidTeam+1);
  $$('result-title').textContent=last.made?bt+' made it!':bt+' was set!';
  const wt=last.delta[0]>0?'Team 1':'Team 2';
  const marks=Math.max(last.delta[0],last.delta[1]);
  $$('result-body').innerHTML=
    '<p class="'+(last.made?'result-made':'result-set')+'">'+(last.made?'✓':'✗')+' Bid: '+last.bid.label+' · '+(last.made?'Made':'Set')+'</p>'+
    '<p style="margin-top:.5rem">'+wt+' gets '+marks+' mark'+(marks!==1?'s':'')+'</p>'+
    '<p style="margin-top:.5rem">Score — Team 1: <strong>'+state.score[0]+'</strong> · Team 2: <strong>'+state.score[1]+'</strong></p>'+
    '<p style="margin-top:.3rem;font-size:.76rem;color:var(--text-dim)">First to 7 marks wins</p>'
}

function renderGameOver(state){
  const wt=state.score[0]>=7?'Team 1':'Team 2';
  const myTeam='Team '+((mySeat%2)+1);
  $$('gameover-title').textContent=wt===myTeam?'Your team wins!':wt+' wins!';
  $$('gameover-body').innerHTML='<p>Final score</p><p style="font-size:1.25rem;color:var(--gold);margin:.5rem 0">Team 1: '+state.score[0]+' — Team 2: '+state.score[1]+'</p>'
}

socket.on('connect',()=>{
  const code=sessionStorage.getItem('42-room'),seat=sessionStorage.getItem('42-seat'),name=sessionStorage.getItem('42-name');
  if(code&&seat!==null&&name){mySeat=parseInt(seat);myRoom=code;myName=name;socket.emit('rejoin',{code,seat:parseInt(seat),name})}
});
`;

// ─── HTML ─────────────────────────────────────────────────────────────────────

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
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
      <span class="team-label">Team 1</span>
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
      <span class="team-label">Team 2</span>
    </div>
  </header>

  <div id="info-banner"></div>
  <div id="points-bar"></div>

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
      <div id="boneyard-drawer"></div>
    </div>

    <!-- Bid panel (right side) -->
    <div id="bid-panel" class="hidden">
      <div id="bid-panel-inner">
        <div class="bid-panel-head">
          <h3>Your Bid &mdash; <span id="bid-panel-sub" style="font-size:.78rem;font-weight:400;color:var(--text-dim)">Current: None</span></h3>
        </div>
        <div class="bid-panel-body" id="bid-panel-body">
          <div class="bid-grid" id="bid-buttons"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Trump select panel (same style as bid panel) -->
  <div id="trump-panel" class="hidden">
    <div id="trump-panel-inner">
      <div class="trump-panel-head">
        <h3 id="trump-card-title">Select Trump</h3>
      </div>
      <div class="trump-panel-sub">Choose the trump suit — your hand tiles shown per suit</div>
      <div class="trump-grid" id="trump-buttons"></div>
    </div>
  </div>

  <!-- Hand result -->
  <div id="overlay-hand-end" class="overlay-full hidden">
    <div class="overlay-full-card">
      <h3 id="result-title"></h3>
      <div id="result-body"></div>
      <button id="btn-next-hand" class="btn-primary" style="margin-top:.5rem">Next Hand</button>
    </div>
  </div>

  <!-- Game over -->
  <div id="overlay-game-over" class="overlay-full hidden">
    <div class="overlay-full-card">
      <h3 id="gameover-title">Game Over</h3>
      <div id="gameover-body"></div>
      <button id="btn-play-again" class="btn-primary" style="margin-top:.5rem">Play Again</button>
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

app.get('/', (req, res) => { res.setHeader('Content-Type','text/html'); res.send(getHTML()); });
app.get('/index.html', (req, res) => { res.setHeader('Content-Type','text/html'); res.send(getHTML()); });

// ─── Room storage ─────────────────────────────────────────────────────────────

const rooms = new Map();

function makeRoom(code) {
  return {
    code, seats: [null,null,null,null], state: 'lobby',
    hands: [[],[],[],[]], bid: null, bids: [],
    currentBidder: 0, trump: null, bidType: null,
    trickTrump: null, trumpSelector: -1, sittingOut: -1,
    trick: [], trickCount: [0,0,0,0], pointsTaken: [0,0,0,0],
    currentPlayer: 0, score: [0,0], dealer: 0,
    lastTrick: null, handHistory: [], boneyard: [],
  };
}

function pubRoom(room) {
  return {
    code: room.code, seats: room.seats, state: room.state,
    bid: room.bid, bids: room.bids, currentBidder: room.currentBidder,
    trump: room.trump, bidType: room.bidType, trickTrump: room.trickTrump,
    trumpSelector: room.trumpSelector, sittingOut: room.sittingOut,
    trick: room.trick, trickCount: room.trickCount, pointsTaken: room.pointsTaken,
    currentPlayer: room.currentPlayer, score: room.score, dealer: room.dealer,
    lastTrick: room.lastTrick, handHistory: room.handHistory, boneyard: room.boneyard,
  };
}

function broadcast(room) {
  for (let i = 0; i < 4; i++) {
    const seat = room.seats[i];
    if (!seat || seat.disconnected) continue;
    const availableBids = (room.state === 'bidding' && room.currentBidder === i)
      ? getAvailableBids(room.bid, room.hands[i], room.bids, i === room.dealer, dealerForced(room)) : [];
    io.to(seat.socketId).emit('state', { ...pubRoom(room), myHand: room.hands[i], mySeat: i, availableBids });
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
  room.trump = null; room.bidType = null; room.trickTrump = null;
  room.trumpSelector = -1; room.sittingOut = -1;
  room.trick = []; room.trickCount = [0,0,0,0]; room.pointsTaken = [0,0,0,0];
  room.lastTrick = null; room.boneyard = [];   // reset boneyard each hand
  room.currentBidder = (room.dealer + 1) % 4;
  room.state = 'bidding';
  broadcast(room);
}

function advanceBidder(room) {
  room.currentBidder = (room.currentBidder + 1) % 4;
}

function biddingDone(room) {
  if (room.bid.type === 'plunge') return true;
  return room.bids.length === 4;
}

function dealerForced(room) {
  if (room.currentBidder !== room.dealer) return false;
  return room.bids.filter(b => b.type !== 'pass').length === 0;
}

function openTrumpSelect(room) {
  const bid = room.bid;
  room.bidType = bid.type;

  if (bid.type === 'low') {
    room.trump = null;
    room.sittingOut = (bid.seatIndex + 2) % 4; // partner sits out
    room.currentPlayer = bid.seatIndex;
    room.state = 'playing';
    broadcast(room); return;
  }
  if (bid.type === 'plunge') {
    room.trumpSelector = (bid.seatIndex + 2) % 4; // partner picks trump & leads
    room.state = 'plunge_trump_select';
    broadcast(room); return;
  }
  // High / follow_me — bidder selects
  room.trumpSelector = bid.seatIndex;
  room.state = 'trump_select';
  broadcast(room);
}

function startPlay(room, trump, followMe) {
  if (followMe) { room.bidType = 'follow_me'; room.trump = null; }
  else { room.trump = trump; }
  room.currentPlayer = room.state === 'plunge_trump_select'
    ? (room.bid.seatIndex + 2) % 4  // partner leads for plunge
    : room.bid.seatIndex;            // bidder leads otherwise
  room.state = 'playing';
  broadcast(room);
}

function resolveHand(room) {
  const delta = scoreHand(room.bid, room.trickCount, room.pointsTaken);
  room.score[0] += delta[0]; room.score[1] += delta[1];
  const bidTeam = room.bid.seatIndex % 2;
  room.handHistory.push({ bid: room.bid, delta, score: [...room.score], bidTeam, made: delta[bidTeam] > 0 });
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
    room.seats[0] = { socketId: socket.id, name };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('joined', { code, seat: 0, name });
    broadcast(room);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) { socket.emit('error','Room not found'); return; }
    if (room.state !== 'lobby') { socket.emit('error','Game in progress'); return; }
    const empty = room.seats.findIndex(s => s === null);
    if (empty === -1) { socket.emit('error','Room is full'); return; }
    room.seats[empty] = { socketId: socket.id, name };
    socket.join(code.toUpperCase());
    socket.emit('joined', { code: room.code, seat: empty, name });
    broadcast(room);
  });

  socket.on('startGame', () => {
    const found = findRoom(socket.id); if (!found) return;
    const { room, seat } = found;
    if (seat !== 0) { socket.emit('error','Only host can start'); return; }
    if (room.seats.some(s => s === null)) { socket.emit('error','Need 4 players'); return; }
    room.dealer = Math.floor(Math.random() * 4);
    startBidding(room);
  });

  socket.on('placeBid', ({ amount, type, marks, plungeLevel }) => {
    const found = findRoom(socket.id); if (!found) return;
    const { room, seat } = found;
    if (room.state !== 'bidding' || room.currentBidder !== seat) return;

    const label = type === 'pass' ? 'Pass'
      : type === 'low'    ? `${amount} Low`
      : type === 'plunge' ? `Plunge (${plungeLevel||2} marks)`
      : String(amount);

    const bidObj = { amount, type, label, marks: marks||1, plungeLevel, seatIndex: seat };

    room.bids.push(bidObj);
    if (type !== 'pass') room.bid = bidObj;

    if (biddingDone(room)) {
      // All 4 acted — find the winner
      if (room.bid.amount === 0 || room.bid.type === null) {
        // Everyone passed (shouldn't happen but safety): dealer forced, send back for input
        room.bid = { amount: 0, type: null, label: '', marks: 0 };
        room.currentBidder = room.dealer;
        broadcast(room); return;
      }
      openTrumpSelect(room); return;
    }

    advanceBidder(room);
    broadcast(room);
  });

  socket.on('selectTrump', ({ trump, followMe }) => {
    const found = findRoom(socket.id); if (!found) return;
    const { room, seat } = found;
    if (!['trump_select','plunge_trump_select'].includes(room.state)) return;
    if (room.trumpSelector !== seat) return;
    startPlay(room, trump, followMe);
  });

  socket.on('playTile', ({ tileId }) => {
    const found = findRoom(socket.id); if (!found) return;
    const { room, seat } = found;
    if (room.state !== 'playing') return;
    if (room.currentPlayer !== seat) { socket.emit('error','Not your turn'); return; }
    if (room.sittingOut === seat) { socket.emit('error','You are sitting out'); return; }

    const hand = room.hands[seat];
    const idx = hand.findIndex(t => t.id === tileId);
    if (idx === -1) { socket.emit('error','Tile not in hand'); return; }
    const tile = hand[idx];

    // Renege check
    if (!isLegalPlay(tile, hand, room.trick, room.trump, room.bidType, room.trickTrump)) {
      socket.emit('error','Must follow suit'); return;
    }

    // Set follow_me trick trump on first play of trick
    if (room.bidType === 'follow_me' && room.trick.length === 0) {
      room.trickTrump = tile.hi;
    }

    hand.splice(idx, 1);
    room.trick.push({ seatIndex: seat, tile });

    // Active players (exclude sitting out)
    const active = [0,1,2,3].filter(s => s !== room.sittingOut);

    if (room.trick.length === active.length) {
      // Resolve trick
      const et = room.bidType === 'follow_me' ? room.trickTrump : room.trump;
      const winner = trickWinner(room.trick, et, room.bidType === 'low');

      const pts = room.trick.reduce((s,p) => s + tileScore(p.tile), 0) + 1;
      room.pointsTaken[winner] += pts;
      room.trickCount[winner]++;
      room.boneyard.push(...room.trick.map(p => p.tile));
      room.lastTrick = { plays: [...room.trick], winner };
      room.trick = [];
      room.trickTrump = null;

      // 42 Low: if BIDDER takes a trick, hand ends immediately (bidder loses)
      if (room.bidType === 'low' && winner === room.bid.seatIndex) {
        resolveHand(room); return;
      }

      const totalTricks = room.trickCount.reduce((a,b)=>a+b,0);
      const maxTricks = active.length === 3 ? 6 : 7; // 6 tricks when someone sits out (3 players × ... no, still 7 tiles each but 3 active = 7 tricks total from those hands)
      // Actually with 3 active players each has 7 tiles so 7 tricks total
      if (totalTricks === 7) { resolveHand(room); return; }

      // Next leader = winner (skip sitting out — winner can't be sittingOut)
      room.currentPlayer = winner;
    } else {
      // Advance to next active player
      let next = (seat + 1) % 4;
      if (next === room.sittingOut) next = (next + 1) % 4;
      room.currentPlayer = next;
    }
    broadcast(room);
  });

  socket.on('nextHand', () => {
    const found = findRoom(socket.id); if (!found) return;
    if (found.room.state === 'hand_end') startBidding(found.room);
  });

  socket.on('disconnect', () => {
    const found = findRoom(socket.id); if (!found) return;
    const { room, seat } = found;
    if (room.seats[seat]) room.seats[seat] = { ...room.seats[seat], disconnected: true };
    broadcast(room);
  });

  socket.on('rejoin', ({ code, seat, name }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) { socket.emit('error','Room not found'); return; }
    if (room.seats[seat]?.name !== name) { socket.emit('error','Name mismatch'); return; }
    room.seats[seat] = { socketId: socket.id, name };
    socket.join(code.toUpperCase());
    socket.emit('joined', { code: room.code, seat, name });
    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`42 Dominoes running on port ${PORT}`));
