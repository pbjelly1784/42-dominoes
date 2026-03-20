'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// ─── Game Logic ───────────────────────────────────────────────────────────────

function makeDominoes() {
  const tiles = [];
  for (let hi = 0; hi <= 6; hi++) {
    for (let lo = 0; lo <= hi; lo++) {
      tiles.push({ hi, lo, id: `${hi}-${lo}` });
    }
  }
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
  const tiles = shuffle(makeDominoes());
  return [
    tiles.slice(0, 7),
    tiles.slice(7, 14),
    tiles.slice(14, 21),
    tiles.slice(21, 28),
  ];
}

function tileScore(tile) {
  const sum = tile.hi + tile.lo;
  return (sum === 5 || sum === 10) ? sum : 0;
}

function isTrump(tile, trump) {
  if (trump === null) return false;
  return tile.hi === trump || tile.lo === trump;
}

function trickWinner(plays, trump) {
  const lead = plays[0];
  const ledValue = (() => {
    if (isTrump(lead.tile, trump)) return 'trump';
    if (lead.tile.hi === trump) return lead.tile.lo;
    return lead.tile.hi;
  })();

  let winner = lead;
  let winnerIsTrump = isTrump(lead.tile, trump);

  for (let i = 1; i < plays.length; i++) {
    const p = plays[i];
    const pTrump = isTrump(p.tile, trump);

    if (pTrump && !winnerIsTrump) {
      winner = p;
      winnerIsTrump = true;
    } else if (pTrump && winnerIsTrump) {
      const wPip = Math.max(winner.tile.hi, winner.tile.lo);
      const pPip = Math.max(p.tile.hi, p.tile.lo);
      if (pPip > wPip) winner = p;
    } else if (!pTrump && !winnerIsTrump) {
      const pSuit = p.tile.hi === trump ? p.tile.lo : p.tile.hi;
      if (pSuit === ledValue) {
        const wPip = Math.max(winner.tile.hi, winner.tile.lo);
        const pPip = Math.max(p.tile.hi, p.tile.lo);
        if (pPip > wPip) winner = p;
      }
    }
  }
  return winner.seatIndex;
}

function validBidsFor(highBid, seatIndex, hand) {
  const bids = [];
  for (let b = 30; b <= 42; b++) {
    if (b > (highBid.amount || 29) && !highBid.special) {
      bids.push({ amount: b, special: null, label: String(b) });
    }
  }
  const doubles = [84, 126, 168, 210];
  for (const d of doubles) {
    if (d > (highBid.amount || 0) && !highBid.special) {
      bids.push({ amount: d, special: null, label: String(d) });
    }
  }
  if (!highBid.special) {
    bids.push({ amount: 42, special: 'low', label: 'Low' });
  }
  const doubleCount = hand.filter(t => t.hi === t.lo).length;
  if (doubleCount >= 4 && !highBid.special && (highBid.amount || 0) < 42) {
    bids.push({ amount: 84, special: 'plunge', label: 'Plunge' });
  }
  bids.push({ amount: 42, special: 'follow_me', label: 'Follow Me' });
  bids.push({ amount: 0, special: 'pass', label: 'Pass' });
  return bids;
}

function scoreHand(bid, trickCount, pointsTaken) {
  const bidTeam = bid.seatIndex % 2;
  const defTeam = 1 - bidTeam;

  const bt0 = bidTeam === 0 ? 0 : 1;
  const bt1 = bidTeam === 0 ? 2 : 3;
  const bidTeamTricks = trickCount[bt0] + trickCount[bt1];
  const bidTeamPoints = pointsTaken[bt0] + pointsTaken[bt1];

  let delta = { 0: 0, 1: 0 };

  if (bid.special === 'plunge') {
    const won = bidTeamTricks === 7;
    delta[won ? bidTeam : defTeam] = 4;
    return delta;
  }

  if (bid.special === 'follow_me') {
    const won = bidTeamPoints + bidTeamTricks >= 42;
    delta[won ? bidTeam : defTeam] = 1;
    return delta;
  }

  if (bid.special === 'low') {
    const bidTeamTotal = bidTeamPoints + bidTeamTricks;
    const defTeamTotal = 42 - bidTeamTotal;
    const won = bidTeamTotal < defTeamTotal;
    delta[won ? bidTeam : defTeam] = 1;
    return delta;
  }

  const bidScore = bidTeamPoints + bidTeamTricks;
  const won = bidScore >= bid.amount;

  let marks = 1;
  if (bid.amount === 84)  marks = 2;
  if (bid.amount === 126) marks = 3;
  if (bid.amount === 168) marks = 4;
  if (bid.amount === 210) marks = 5;
  if (bid.amount === 42 && won && bidTeamTricks === 7) marks = 2;

  delta[won ? bidTeam : defTeam] = marks;
  return delta;
}

// ─── Express + Socket.io setup ────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PAGE_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>Texas 42</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=DM+Sans:wght@400;500;600&display=swap\" rel=\"stylesheet\">\n<style>\n/* \u2500\u2500 Reset & base \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n\n:root {\n  --felt:       #1a5c38;\n  --felt-dark:  #123e27;\n  --felt-light: #246b43;\n  --felt-edge:  #0d2e1a;\n  --ivory:      #f5f0e8;\n  --pip:        #1a1a1a;\n  --pip-accent: #c0392b;\n  --gold:       #c9a84c;\n  --gold-light: #e8c96a;\n  --text-main:  #f5f0e8;\n  --text-dim:   rgba(245,240,232,.6);\n  --card-bg:    rgba(10,30,18,.82);\n  --card-border:rgba(201,168,76,.25);\n  --radius:     12px;\n  --tile-w:     52px;\n  --tile-h:     96px;\n  --pip-sz:     8px;\n  font-family: 'DM Sans', sans-serif;\n}\n\nhtml, body { height: 100%; overflow: hidden; }\n\nbody {\n  background: var(--felt-dark);\n  color: var(--text-main);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}\n\n/* \u2500\u2500 Screens \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.screen { display: none; width: 100%; height: 100%; }\n.screen.active { display: flex; align-items: center; justify-content: center; }\n#screen-game.active { display: flex; flex-direction: column; }\n\n/* \u2500\u2500 Lobby \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.lobby-card, .waiting-card {\n  background: var(--card-bg);\n  border: 1px solid var(--card-border);\n  border-radius: var(--radius);\n  padding: 2.5rem 2.5rem 2rem;\n  width: min(420px, 92vw);\n  display: flex;\n  flex-direction: column;\n  gap: 1.2rem;\n  backdrop-filter: blur(12px);\n}\n\nh1 {\n  font-family: 'Playfair Display', serif;\n  font-size: 2.8rem;\n  color: var(--gold);\n  text-align: center;\n  letter-spacing: .04em;\n  line-height: 1;\n}\n\n.subtitle { text-align: center; color: var(--text-dim); font-size: .9rem; }\n\ninput[type=\"text\"] {\n  width: 100%;\n  background: rgba(255,255,255,.07);\n  border: 1px solid rgba(201,168,76,.3);\n  border-radius: 8px;\n  color: var(--ivory);\n  padding: .7rem 1rem;\n  font-size: 1rem;\n  font-family: inherit;\n  outline: none;\n  transition: border-color .2s;\n}\ninput[type=\"text\"]:focus { border-color: var(--gold); }\ninput[type=\"text\"]::placeholder { color: var(--text-dim); }\n\n.lobby-actions { display: flex; flex-direction: column; gap: .8rem; }\n.join-row { display: flex; gap: .6rem; }\n.join-row input { flex: 1; text-transform: uppercase; letter-spacing: .12em; }\n\n.btn-primary {\n  background: var(--gold);\n  color: #1a1a1a;\n  border: none;\n  border-radius: 8px;\n  padding: .75rem 1.4rem;\n  font-size: .95rem;\n  font-weight: 600;\n  font-family: inherit;\n  cursor: pointer;\n  width: 100%;\n  transition: background .15s, transform .1s;\n}\n.btn-primary:hover { background: var(--gold-light); }\n.btn-primary:active { transform: scale(.98); }\n\n.btn-secondary {\n  background: transparent;\n  color: var(--gold);\n  border: 1px solid var(--gold);\n  border-radius: 8px;\n  padding: .75rem 1.2rem;\n  font-size: .95rem;\n  font-weight: 500;\n  font-family: inherit;\n  cursor: pointer;\n  white-space: nowrap;\n  transition: background .15s;\n}\n.btn-secondary:hover { background: rgba(201,168,76,.12); }\n\n.error-msg { color: #e07070; font-size: .85rem; min-height: 1.2em; text-align: center; }\n\n/* \u2500\u2500 Waiting room \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.room-code-display {\n  text-align: center;\n  font-size: 1.6rem;\n  font-family: 'Playfair Display', serif;\n  color: var(--gold);\n  letter-spacing: .18em;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  gap: .5rem;\n}\n\n.btn-copy {\n  background: none;\n  border: 1px solid var(--card-border);\n  color: var(--gold);\n  border-radius: 6px;\n  padding: .2rem .5rem;\n  font-size: .9rem;\n  cursor: pointer;\n}\n.btn-copy:hover { background: rgba(201,168,76,.1); }\n\n.seat-list { display: flex; flex-direction: column; gap: .5rem; }\n.seat-row {\n  display: flex;\n  align-items: center;\n  gap: .8rem;\n  padding: .6rem .9rem;\n  background: rgba(255,255,255,.05);\n  border-radius: 8px;\n  border: 1px solid rgba(255,255,255,.08);\n}\n.seat-row .seat-num { color: var(--gold); font-weight: 600; min-width: 24px; }\n.seat-row .seat-team { font-size: .75rem; color: var(--text-dim); margin-left: auto; }\n.seat-row.empty { opacity: .45; font-style: italic; }\n.waiting-hint { text-align: center; font-size: .82rem; color: var(--text-dim); }\n\n/* \u2500\u2500 Score bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.score-bar {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  background: var(--felt-edge);\n  border-bottom: 1px solid rgba(201,168,76,.2);\n  padding: .5rem 1.2rem;\n  flex-shrink: 0;\n  z-index: 10;\n}\n.score-team { display: flex; align-items: center; gap: .5rem; }\n.score-team.right { flex-direction: row-reverse; }\n.team-label { font-size: .75rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: .08em; }\n.team-marks { font-family: 'Playfair Display', serif; font-size: 1.8rem; color: var(--gold); line-height: 1; min-width: 2ch; text-align: center; }\n.team-pip { font-size: .7rem; color: var(--text-dim); }\n.score-center { display: flex; flex-direction: column; align-items: center; gap: .15rem; }\n#game-status-label { font-size: .82rem; color: var(--text-dim); }\n.room-tag { font-size: .7rem; color: rgba(201,168,76,.5); letter-spacing: .12em; }\n\n/* \u2500\u2500 Table wrap \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.table-wrap {\n  flex: 1;\n  position: relative;\n  display: grid;\n  grid-template-areas:\n    \".      top    .\"\n    \"left   center right\"\n    \".      bottom .\";\n  grid-template-columns: 120px 1fr 120px;\n  grid-template-rows: 110px 1fr 130px;\n  gap: 4px;\n  padding: 8px;\n  overflow: hidden;\n}\n\n/* \u2500\u2500 Player zones \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.player-zone {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  position: relative;\n}\n.player-zone.top    { grid-area: top;    flex-direction: column; gap: 4px; }\n.player-zone.left   { grid-area: left;   flex-direction: column; gap: 4px; }\n.player-zone.right  { grid-area: right;  flex-direction: column; gap: 4px; }\n.player-zone.bottom { grid-area: bottom; flex-direction: column; gap: 6px; }\n\n.player-name-tag {\n  font-size: .78rem;\n  font-weight: 500;\n  color: var(--text-dim);\n  background: rgba(0,0,0,.3);\n  border: 1px solid rgba(201,168,76,.15);\n  border-radius: 20px;\n  padding: .2rem .7rem;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  max-width: 100px;\n}\n.player-name-tag.active-player { color: var(--gold); border-color: rgba(201,168,76,.5); }\n\n.opponent-hand { display: flex; gap: 3px; align-items: center; justify-content: center; flex-wrap: nowrap; }\n.opponent-hand.vertical { flex-direction: column; }\n\n/* \u2500\u2500 Tile \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.tile {\n  width: var(--tile-w);\n  height: var(--tile-h);\n  background: var(--ivory);\n  border-radius: 6px;\n  border: 1px solid #ccc;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: space-between;\n  padding: 5px;\n  cursor: default;\n  position: relative;\n  flex-shrink: 0;\n  user-select: none;\n  box-shadow: 0 2px 6px rgba(0,0,0,.4);\n  transition: transform .12s, box-shadow .12s;\n}\n.tile.playable {\n  cursor: pointer;\n  border-color: var(--gold);\n}\n.tile.playable:hover {\n  transform: translateY(-8px);\n  box-shadow: 0 8px 20px rgba(0,0,0,.5);\n}\n.tile.playable:active { transform: translateY(-4px); }\n\n.tile .half {\n  width: 100%;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  flex: 1;\n}\n.tile .divider {\n  width: 80%;\n  height: 1px;\n  background: #bbb;\n  flex-shrink: 0;\n}\n.tile.trump-tile { border-color: #c0392b; box-shadow: 0 0 0 2px rgba(192,57,43,.4), 0 2px 6px rgba(0,0,0,.4); }\n\n/* Opponent tile back */\n.tile-back {\n  background: var(--felt);\n  border: 1px solid rgba(201,168,76,.3);\n  width: 28px;\n  height: 52px;\n  border-radius: 4px;\n  flex-shrink: 0;\n}\n\n/* Pips */\n.pips {\n  display: grid;\n  gap: 3px;\n  align-items: center;\n  justify-items: center;\n  padding: 2px;\n}\n.pip {\n  width: var(--pip-sz);\n  height: var(--pip-sz);\n  background: var(--pip);\n  border-radius: 50%;\n}\n\n/* pip layouts */\n.pips[data-n=\"0\"] { grid-template-columns: 1fr; min-height: 24px; }\n.pips[data-n=\"1\"] { grid-template-columns: 1fr; }\n.pips[data-n=\"2\"] { grid-template-columns: 1fr 1fr; }\n.pips[data-n=\"3\"] { grid-template-columns: 1fr 1fr 1fr; }\n.pips[data-n=\"4\"] { grid-template-columns: 1fr 1fr; }\n.pips[data-n=\"5\"] { grid-template-columns: 1fr 1fr 1fr; }\n.pips[data-n=\"6\"] { grid-template-columns: 1fr 1fr 1fr; }\n\n/* \u2500\u2500 Trick area \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.trick-area {\n  grid-area: center;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  gap: 4px;\n}\n.trick-row { display: flex; align-items: center; gap: 8px; }\n.trick-slot {\n  width: var(--tile-w);\n  height: var(--tile-h);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}\n.trick-center-info {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  min-width: 60px;\n}\n#trump-display {\n  font-size: .72rem;\n  color: var(--text-dim);\n  text-align: center;\n}\n\n/* Tile in trick: winning glow */\n.tile.trick-winner {\n  box-shadow: 0 0 0 3px var(--gold), 0 4px 12px rgba(0,0,0,.5);\n}\n\n/* \u2500\u2500 My hand \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.my-hand {\n  display: flex;\n  gap: 6px;\n  align-items: flex-end;\n  justify-content: center;\n  flex-wrap: nowrap;\n  overflow-x: auto;\n  padding: 4px 4px 0;\n  max-width: 100%;\n}\n\n/* \u2500\u2500 Overlays \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n.overlay {\n  position: absolute;\n  inset: 0;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: rgba(0,0,0,.55);\n  backdrop-filter: blur(4px);\n  z-index: 100;\n}\n.overlay.hidden { display: none; }\n\n.overlay-card {\n  background: #0e2c1a;\n  border: 1px solid var(--card-border);\n  border-radius: var(--radius);\n  padding: 1.8rem 2rem;\n  min-width: 300px;\n  max-width: min(480px, 92vw);\n  display: flex;\n  flex-direction: column;\n  gap: 1rem;\n}\n.overlay-card h3 {\n  font-family: 'Playfair Display', serif;\n  color: var(--gold);\n  font-size: 1.4rem;\n  text-align: center;\n}\n.bid-subtitle { text-align: center; font-size: .85rem; color: var(--text-dim); }\n\n/* Bid grid */\n.bid-grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(70px, 1fr));\n  gap: 6px;\n}\n.bid-btn {\n  background: rgba(255,255,255,.06);\n  border: 1px solid rgba(201,168,76,.25);\n  border-radius: 8px;\n  color: var(--ivory);\n  padding: .55rem .4rem;\n  font-family: inherit;\n  font-size: .88rem;\n  font-weight: 500;\n  cursor: pointer;\n  transition: background .12s, border-color .12s;\n  text-align: center;\n}\n.bid-btn:hover { background: rgba(201,168,76,.18); border-color: var(--gold); }\n.bid-btn.special { color: var(--gold); border-color: rgba(201,168,76,.5); }\n.bid-btn.pass-btn { color: #e07070; border-color: rgba(220,100,100,.3); }\n.bid-btn.double-btn { color: #8ecdf5; border-color: rgba(100,180,240,.3); }\n.bid-btn:disabled { opacity: .3; cursor: default; pointer-events: none; }\n\n/* Trump grid */\n.trump-grid {\n  display: grid;\n  grid-template-columns: repeat(4, 1fr);\n  gap: 8px;\n}\n.trump-btn {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: .3rem;\n  background: rgba(255,255,255,.06);\n  border: 1px solid rgba(201,168,76,.25);\n  border-radius: 10px;\n  color: var(--ivory);\n  padding: .9rem .5rem;\n  cursor: pointer;\n  font-family: inherit;\n  font-size: .82rem;\n  transition: background .12s, border-color .12s;\n}\n.trump-btn:hover { background: rgba(201,168,76,.18); border-color: var(--gold); }\n.trump-pip-preview {\n  width: 22px;\n  height: 22px;\n  background: var(--pip);\n  border-radius: 50%;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  color: var(--ivory);\n  font-size: .75rem;\n  font-weight: 600;\n}\n\n/* Result card */\n.result-card #result-body, .result-card #gameover-body {\n  font-size: .9rem;\n  color: var(--text-dim);\n  line-height: 1.7;\n  text-align: center;\n}\n.result-made { color: #6fcf97; }\n.result-set   { color: #eb5757; }\n\n/* Overlay side bits */\n.overlay-side { position: absolute; z-index: 50; }\n.right-side { top: 50%; right: 0; transform: translateY(-50%); }\n.waiting-pill {\n  background: rgba(0,0,0,.6);\n  border: 1px solid var(--card-border);\n  border-radius: 20px 0 0 20px;\n  padding: .5rem 1rem .5rem .9rem;\n  font-size: .8rem;\n  color: var(--text-dim);\n}\n\n/* Last trick button */\n.btn-last-trick {\n  background: rgba(0,0,0,.5);\n  border: 1px solid var(--card-border);\n  border-radius: 8px;\n  color: var(--text-dim);\n  padding: .35rem .7rem;\n  font-size: .75rem;\n  cursor: pointer;\n  font-family: inherit;\n}\n.btn-last-trick:hover { color: var(--gold); }\n.last-trick-content { display: flex; gap: 4px; flex-wrap: wrap; padding-top: .4rem; }\n.last-trick-content.hidden { display: none; }\n\n/* Dealer chip */\n.dealer-chip {\n  display: inline-block;\n  background: var(--gold);\n  color: #1a1a1a;\n  font-size: .6rem;\n  font-weight: 700;\n  border-radius: 50%;\n  width: 16px;\n  height: 16px;\n  text-align: center;\n  line-height: 16px;\n  margin-left: 4px;\n}\n\n/* Current player highlight */\n.zone-active .player-name-tag {\n  color: var(--gold);\n  border-color: rgba(201,168,76,.6);\n  background: rgba(201,168,76,.1);\n}\n\n/* Responsive tweaks */\n@media (max-width: 600px) {\n  :root { --tile-w: 40px; --tile-h: 74px; --pip-sz: 6px; }\n  .table-wrap {\n    grid-template-columns: 80px 1fr 80px;\n    grid-template-rows: 90px 1fr 110px;\n  }\n  .tile-back { width: 22px; height: 40px; }\n}\n\n</style>\n</head>\n<body>\n<div id=\"screen-lobby\" class=\"screen active\">\n  <div class=\"lobby-card\">\n    <h1>Texas&nbsp;42</h1>\n    <p class=\"subtitle\">Classic dominoes for 4 players</p>\n    <div class=\"input-group\">\n      <input id=\"player-name\" type=\"text\" placeholder=\"Your name\" maxlength=\"18\" autocomplete=\"off\">\n    </div>\n    <div class=\"lobby-actions\">\n      <button id=\"btn-create\" class=\"btn-primary\">Create Game</button>\n      <div class=\"join-row\">\n        <input id=\"room-code-input\" type=\"text\" placeholder=\"Room code\" maxlength=\"4\" autocomplete=\"off\">\n        <button id=\"btn-join\" class=\"btn-secondary\">Join</button>\n      </div>\n    </div>\n    <p id=\"lobby-error\" class=\"error-msg\"></p>\n  </div>\n</div>\n<div id=\"screen-waiting\" class=\"screen\">\n  <div class=\"waiting-card\">\n    <h2>Waiting for players</h2>\n    <div class=\"room-code-display\">\n      Room: <span id=\"display-code\">----</span>\n      <button id=\"btn-copy-code\" class=\"btn-copy\" title=\"Copy code\">&#x29C9;</button>\n    </div>\n    <div id=\"seat-list\" class=\"seat-list\"></div>\n    <p class=\"waiting-hint\">Share the room code with your friends</p>\n    <button id=\"btn-start\" class=\"btn-primary\" style=\"display:none\">Start Game</button>\n    <p id=\"waiting-error\" class=\"error-msg\"></p>\n  </div>\n</div>\n<div id=\"screen-game\" class=\"screen\">\n  <header class=\"score-bar\">\n    <div class=\"score-team\" id=\"score-team0\">\n      <span class=\"team-label\">N/S</span>\n      <span class=\"team-marks\" id=\"marks-0\">0</span>\n      <span class=\"team-pip\">marks</span>\n    </div>\n    <div class=\"score-center\">\n      <span id=\"game-status-label\">Bidding</span>\n      <span class=\"room-tag\" id=\"score-room-code\"></span>\n    </div>\n    <div class=\"score-team right\" id=\"score-team1\">\n      <span class=\"team-pip\">marks</span>\n      <span class=\"team-marks\" id=\"marks-1\">0</span>\n      <span class=\"team-label\">E/W</span>\n    </div>\n  </header>\n  <div class=\"table-wrap\">\n    <div class=\"player-zone top\" id=\"zone-top\">\n      <div class=\"player-name-tag\" id=\"name-top\"></div>\n      <div class=\"opponent-hand\" id=\"hand-top\"></div>\n    </div>\n    <div class=\"player-zone left\" id=\"zone-left\">\n      <div class=\"player-name-tag\" id=\"name-left\"></div>\n      <div class=\"opponent-hand vertical\" id=\"hand-left\"></div>\n    </div>\n    <div class=\"player-zone right\" id=\"zone-right\">\n      <div class=\"opponent-hand vertical\" id=\"hand-right\"></div>\n      <div class=\"player-name-tag\" id=\"name-right\"></div>\n    </div>\n    <div class=\"trick-area\" id=\"trick-area\">\n      <div class=\"trick-slot\" id=\"trick-top\"></div>\n      <div class=\"trick-row\">\n        <div class=\"trick-slot\" id=\"trick-left\"></div>\n        <div class=\"trick-center-info\" id=\"trick-center-info\">\n          <span id=\"trump-display\"></span>\n        </div>\n        <div class=\"trick-slot\" id=\"trick-right\"></div>\n      </div>\n      <div class=\"trick-slot\" id=\"trick-bottom\"></div>\n    </div>\n    <div class=\"player-zone bottom\" id=\"zone-bottom\">\n      <div class=\"player-name-tag\" id=\"name-bottom\"></div>\n      <div class=\"my-hand\" id=\"hand-bottom\"></div>\n    </div>\n  </div>\n  <div id=\"overlay-bid\" class=\"overlay hidden\">\n    <div class=\"overlay-card bid-card\">\n      <h3>Your Bid</h3>\n      <p class=\"bid-subtitle\" id=\"bid-current-label\"></p>\n      <div id=\"bid-buttons\" class=\"bid-grid\"></div>\n    </div>\n  </div>\n  <div id=\"overlay-trump\" class=\"overlay hidden\">\n    <div class=\"overlay-card trump-card\">\n      <h3>Select Trump</h3>\n      <p class=\"bid-subtitle\">You won the bid - choose a suit</p>\n      <div class=\"trump-grid\" id=\"trump-buttons\"></div>\n    </div>\n  </div>\n  <div id=\"overlay-last-trick\" class=\"overlay-side hidden\">\n    <button id=\"btn-show-last\" class=\"btn-last-trick\">Last trick &#9658;</button>\n    <div id=\"last-trick-content\" class=\"last-trick-content hidden\"></div>\n  </div>\n  <div id=\"overlay-hand-end\" class=\"overlay hidden\">\n    <div class=\"overlay-card result-card\">\n      <h3 id=\"result-title\"></h3>\n      <div id=\"result-body\"></div>\n      <button id=\"btn-next-hand\" class=\"btn-primary\">Next Hand</button>\n    </div>\n  </div>\n  <div id=\"overlay-game-over\" class=\"overlay hidden\">\n    <div class=\"overlay-card result-card\">\n      <h3 id=\"gameover-title\">Game Over</h3>\n      <div id=\"gameover-body\"></div>\n      <button id=\"btn-play-again\" class=\"btn-primary\">Play Again</button>\n    </div>\n  </div>\n  <div id=\"overlay-waiting-play\" class=\"overlay-side right-side hidden\">\n    <div class=\"waiting-pill\" id=\"waiting-pill-label\">Waiting...</div>\n  </div>\n</div>\n<script src=\"/socket.io/socket.io.js\"></script>\n<script>\n'use strict';\n\n// \u2500\u2500\u2500 Socket setup \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconst socket = io();\n\n// \u2500\u2500\u2500 App state \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nlet myName = '';\nlet myRoom = '';\nlet mySeat = -1;\nlet lastState = null;\n\n// \u2500\u2500\u2500 Screen helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction showScreen(id) {\n  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));\n  document.getElementById(id).classList.add('active');\n}\n\n// \u2500\u2500\u2500 Lobby wiring \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\ndocument.getElementById('btn-create').addEventListener('click', () => {\n  const name = document.getElementById('player-name').value.trim();\n  if (!name) { setLobbyError('Enter your name first'); return; }\n  myName = name;\n  socket.emit('createRoom', { name });\n});\n\ndocument.getElementById('btn-join').addEventListener('click', () => {\n  const name = document.getElementById('player-name').value.trim();\n  const code = document.getElementById('room-code-input').value.trim();\n  if (!name) { setLobbyError('Enter your name first'); return; }\n  if (!code) { setLobbyError('Enter a room code'); return; }\n  myName = name;\n  socket.emit('joinRoom', { name, code });\n});\n\ndocument.getElementById('player-name').addEventListener('keydown', e => {\n  if (e.key === 'Enter') document.getElementById('btn-create').click();\n});\ndocument.getElementById('room-code-input').addEventListener('keydown', e => {\n  if (e.key === 'Enter') document.getElementById('btn-join').click();\n});\n\nfunction setLobbyError(msg) {\n  document.getElementById('lobby-error').textContent = msg;\n}\n\n// \u2500\u2500\u2500 Copy room code \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\ndocument.getElementById('btn-copy-code').addEventListener('click', () => {\n  navigator.clipboard.writeText(myRoom).then(() => {\n    document.getElementById('btn-copy-code').textContent = '\u2713';\n    setTimeout(() => document.getElementById('btn-copy-code').textContent = '\u29c9', 1500);\n  });\n});\n\n// \u2500\u2500\u2500 Start game \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\ndocument.getElementById('btn-start').addEventListener('click', () => {\n  socket.emit('startGame');\n  document.getElementById('waiting-error').textContent = '';\n});\n\n// \u2500\u2500\u2500 Next hand \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\ndocument.getElementById('btn-next-hand').addEventListener('click', () => {\n  socket.emit('nextHand');\n  hideOverlay('overlay-hand-end');\n});\n\n// \u2500\u2500\u2500 Play again (reload lobby) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\ndocument.getElementById('btn-play-again').addEventListener('click', () => {\n  location.reload();\n});\n\n// \u2500\u2500\u2500 Overlay helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction showOverlay(id) { document.getElementById(id).classList.remove('hidden'); }\nfunction hideOverlay(id) { document.getElementById(id).classList.add('hidden'); }\nfunction hideAllOverlays() {\n  ['overlay-bid','overlay-trump','overlay-hand-end','overlay-game-over'].forEach(hideOverlay);\n}\n\n// \u2500\u2500\u2500 Socket events \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nsocket.on('error', msg => {\n  const lobbyErr = document.getElementById('lobby-error');\n  const waitErr  = document.getElementById('waiting-error');\n  if (document.getElementById('screen-lobby').classList.contains('active')) setLobbyError(msg);\n  else if (document.getElementById('screen-waiting').classList.contains('active')) waitErr.textContent = msg;\n  else alert(msg);\n});\n\nsocket.on('joined', ({ code, seat, name }) => {\n  myRoom = code;\n  mySeat = seat;\n  myName = name;\n  document.getElementById('display-code').textContent = code;\n  document.getElementById('score-room-code').textContent = code;\n  document.getElementById('btn-start').style.display = seat === 0 ? 'block' : 'none';\n  showScreen('screen-waiting');\n  // Store for potential rejoin\n  sessionStorage.setItem('42-room', code);\n  sessionStorage.setItem('42-seat', seat);\n  sessionStorage.setItem('42-name', name);\n});\n\nsocket.on('state', (state) => {\n  lastState = state;\n  if (state.state === 'lobby') {\n    renderWaiting(state);\n    if (!document.getElementById('screen-waiting').classList.contains('active')) {\n      showScreen('screen-waiting');\n    }\n    return;\n  }\n\n  if (!document.getElementById('screen-game').classList.contains('active')) {\n    showScreen('screen-game');\n  }\n  renderGame(state);\n});\n\n// \u2500\u2500\u2500 Waiting room render \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction renderWaiting(state) {\n  const list = document.getElementById('seat-list');\n  list.innerHTML = '';\n  const teams = ['N/S','E/W','N/S','E/W'];\n  const positions = ['North','East','South','West'];\n  state.seats.forEach((seat, i) => {\n    const row = document.createElement('div');\n    row.className = `seat-row${!seat ? ' empty' : ''}`;\n    row.innerHTML = `<span class=\"seat-num\">${i+1}</span>\n      <span>${seat ? (seat.disconnected ? seat.name + ' (away)' : seat.name) : 'Empty'}</span>\n      <span class=\"seat-team\">${positions[i]} \u00b7 ${teams[i]}</span>`;\n    list.appendChild(row);\n  });\n}\n\n// \u2500\u2500\u2500 Game render \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconst SUIT_NAMES = ['Blanks','Ones','Twos','Threes','Fours','Fives','Sixes'];\n\nfunction seatOffset(targetSeat) {\n  // Returns position relative to me: 0=bottom(me), 1=left, 2=top, 3=right (CCW)\n  return ((targetSeat - mySeat + 4) % 4);\n}\n\nfunction positionForOffset(offset) {\n  return ['bottom','left','top','right'][offset];\n}\n\nfunction renderGame(state) {\n  // Score\n  document.getElementById('marks-0').textContent = state.score[0];\n  document.getElementById('marks-1').textContent = state.score[1];\n\n  // Status label\n  const statusLabels = {\n    bidding: 'Bidding',\n    trump_select: 'Selecting trump',\n    playing: state.trump !== null ? `Trump: ${SUIT_NAMES[state.trump]}` : 'Playing',\n    hand_end: 'Hand over',\n    game_over: 'Game over',\n  };\n  document.getElementById('game-status-label').textContent = statusLabels[state.state] || '';\n\n  // Trump display\n  document.getElementById('trump-display').textContent =\n    state.trump !== null ? `Trump\\n${SUIT_NAMES[state.trump]}` : '';\n\n  // Render each player's zone\n  for (let s = 0; s < 4; s++) {\n    const offset = seatOffset(s);\n    const pos = positionForOffset(offset);\n    const nameEl = document.getElementById(`name-${pos}`);\n    const handEl = document.getElementById(`hand-${pos}`);\n\n    if (!nameEl || !handEl) continue;\n\n    // Name tag\n    const seat = state.seats[s];\n    let nameText = seat ? seat.name : `Seat ${s+1}`;\n    if (s === state.dealer) nameText += '<span class=\"dealer-chip\">D</span>';\n    nameEl.innerHTML = nameText;\n\n    const isCurrentPlayer = (state.state === 'playing' && state.currentPlayer === s)\n      || (state.state === 'bidding' && state.currentBidder === s)\n      || (state.state === 'trump_select' && state.bid?.seatIndex === s);\n    nameEl.classList.toggle('active-player', isCurrentPlayer);\n    document.getElementById(`zone-${pos}`)?.classList.toggle('zone-active', isCurrentPlayer);\n\n    // Hand\n    handEl.innerHTML = '';\n    if (s === mySeat) {\n      // My hand \u2014 render full tiles\n      const isMyTurn = state.state === 'playing' && state.currentPlayer === mySeat;\n      (state.myHand || []).forEach(tile => {\n        const el = renderTile(tile, isMyTurn, state.trump);\n        if (isMyTurn) {\n          el.classList.add('playable');\n          el.addEventListener('click', () => socket.emit('playTile', { tileId: tile.id }));\n        }\n        handEl.appendChild(el);\n      });\n    } else {\n      // Opponent \u2014 show backs\n      const count = getHandCount(state, s);\n      for (let i = 0; i < count; i++) {\n        const back = document.createElement('div');\n        back.className = 'tile-back';\n        handEl.appendChild(back);\n      }\n    }\n  }\n\n  // Trick area\n  renderTrickArea(state);\n\n  // Overlays\n  hideAllOverlays();\n\n  if (state.state === 'bidding' && state.currentBidder === mySeat) {\n    renderBidOverlay(state);\n    showOverlay('overlay-bid');\n  } else if (state.state === 'trump_select' && state.bid?.seatIndex === mySeat) {\n    renderTrumpOverlay(state);\n    showOverlay('overlay-trump');\n  } else if (state.state === 'hand_end') {\n    renderHandEnd(state);\n    showOverlay('overlay-hand-end');\n  } else if (state.state === 'game_over') {\n    renderGameOver(state);\n    showOverlay('overlay-game-over');\n  }\n\n  // Last trick button\n  if (state.lastTrick) {\n    document.getElementById('overlay-last-trick').classList.remove('hidden');\n    renderLastTrick(state);\n  } else {\n    document.getElementById('overlay-last-trick').classList.add('hidden');\n  }\n}\n\nfunction getHandCount(state, seat) {\n  // Approximate: 7 minus tricks taken so far\n  const tricksPlayed = state.trickCount ? state.trickCount.reduce((a,b)=>a+b,0) : 0;\n  return Math.max(0, 7 - tricksPlayed);\n}\n\n// \u2500\u2500\u2500 Tile renderer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction renderTile(tile, playable, trump) {\n  const el = document.createElement('div');\n  el.className = 'tile';\n  if (trump !== null && (tile.hi === trump || tile.lo === trump)) {\n    el.classList.add('trump-tile');\n  }\n  el.dataset.id = tile.id;\n\n  const topHalf = document.createElement('div');\n  topHalf.className = 'half';\n  topHalf.appendChild(makePips(tile.hi));\n\n  const divider = document.createElement('div');\n  divider.className = 'divider';\n\n  const botHalf = document.createElement('div');\n  botHalf.className = 'half';\n  botHalf.appendChild(makePips(tile.lo));\n\n  el.appendChild(topHalf);\n  el.appendChild(divider);\n  el.appendChild(botHalf);\n  return el;\n}\n\n// Pip layouts: positions for 0-6\nconst PIP_LAYOUTS = {\n  0: [],\n  1: [[1,1]],\n  2: [[0,0],[2,2]],\n  3: [[0,0],[1,1],[2,2]],\n  4: [[0,0],[2,0],[0,2],[2,2]],\n  5: [[0,0],[2,0],[1,1],[0,2],[2,2]],\n  6: [[0,0],[2,0],[0,1],[2,1],[0,2],[2,2]],\n};\n\nfunction makePips(n) {\n  const container = document.createElement('div');\n  container.className = 'pips';\n  container.dataset.n = n;\n\n  if (n === 0) return container;\n\n  const layout = PIP_LAYOUTS[n] || [];\n\n  // Build 3x3 grid slots, place pips\n  if (n <= 2) {\n    layout.forEach(() => {\n      const pip = document.createElement('div');\n      pip.className = 'pip';\n      container.appendChild(pip);\n    });\n    return container;\n  }\n\n  // For 3+, use absolute positioning in a small grid\n  container.style.cssText = 'position:relative;width:28px;height:28px;';\n  layout.forEach(([col, row]) => {\n    const pip = document.createElement('div');\n    pip.className = 'pip';\n    pip.style.cssText = `position:absolute;left:${col*10}px;top:${row*10}px;`;\n    container.appendChild(pip);\n  });\n  return container;\n}\n\n// \u2500\u2500\u2500 Trick area render \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction renderTrickArea(state) {\n  const slots = {\n    bottom: document.getElementById('trick-bottom'),\n    left:   document.getElementById('trick-left'),\n    top:    document.getElementById('trick-top'),\n    right:  document.getElementById('trick-right'),\n  };\n\n  // Clear\n  Object.values(slots).forEach(s => s.innerHTML = '');\n\n  state.trick.forEach(play => {\n    const offset = seatOffset(play.seatIndex);\n    const pos = positionForOffset(offset);\n    const slot = slots[pos];\n    if (!slot) return;\n    const tileEl = renderTile(play.tile, false, state.trump);\n    // Highlight winner of last trick\n    if (state.lastTrick && state.trick.length === 0) {\n      // handled via lastTrick\n    }\n    slot.appendChild(tileEl);\n  });\n\n  // If trick just finished (lastTrick set, trick is empty) show winner highlight briefly\n  if (state.lastTrick && state.trick.length === 0 && state.state === 'playing') {\n    // Show last trick tiles briefly then clear \u2014 handled by lastTrick panel\n  }\n}\n\n// \u2500\u2500\u2500 Bid overlay \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction renderBidOverlay(state) {\n  const currentBid = state.bid;\n  const label = currentBid?.label || 'None';\n  document.getElementById('bid-current-label').textContent =\n    `Current bid: ${label === '' ? 'None' : label}`;\n\n  const grid = document.getElementById('bid-buttons');\n  grid.innerHTML = '';\n\n  // Numeric 30-42\n  for (let b = 30; b <= 42; b++) {\n    if (b > (currentBid?.amount || 29) && !currentBid?.special) {\n      addBidBtn(grid, { amount: b, special: null, label: String(b) }, 'btn');\n    }\n  }\n\n  // Doubling chain\n  [84,126,168,210].forEach(d => {\n    if (!currentBid?.special && d > (currentBid?.amount || 0)) {\n      addBidBtn(grid, { amount: d, special: null, label: String(d) }, 'double-btn');\n    }\n  });\n\n  // Special bids\n  if (!currentBid?.special) {\n    addBidBtn(grid, { amount: 42, special: 'low', label: 'Low 42' }, 'special');\n  }\n\n  // Plunge: need 4+ doubles\n  const myHand = state.myHand || [];\n  const doubleCount = myHand.filter(t => t.hi === t.lo).length;\n  if (doubleCount >= 4 && !currentBid?.special && (currentBid?.amount || 0) < 42) {\n    addBidBtn(grid, { amount: 84, special: 'plunge', label: 'Plunge' }, 'special');\n  }\n\n  // Follow me \u2014 always available\n  addBidBtn(grid, { amount: 42, special: 'follow_me', label: 'Follow Me' }, 'special');\n\n  // Pass\n  addBidBtn(grid, { amount: 0, special: 'pass', label: 'Pass' }, 'pass-btn');\n}\n\nfunction addBidBtn(container, bid, cls) {\n  const btn = document.createElement('button');\n  btn.className = `bid-btn ${cls}`;\n  btn.textContent = bid.label;\n  btn.addEventListener('click', () => {\n    socket.emit('placeBid', { amount: bid.amount, special: bid.special });\n    hideOverlay('overlay-bid');\n  });\n  container.appendChild(btn);\n}\n\n// \u2500\u2500\u2500 Trump overlay \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction renderTrumpOverlay(state) {\n  const grid = document.getElementById('trump-buttons');\n  grid.innerHTML = '';\n\n  // Show my hand to help choose trump\n  const myHand = state.myHand || [];\n  const countPerSuit = Array(7).fill(0);\n  myHand.forEach(t => { countPerSuit[t.hi]++; if (t.hi !== t.lo) countPerSuit[t.lo]++; });\n\n  SUIT_NAMES.forEach((name, i) => {\n    const btn = document.createElement('button');\n    btn.className = 'trump-btn';\n\n    const preview = document.createElement('div');\n    preview.className = 'trump-pip-preview';\n    preview.textContent = i;\n\n    const label = document.createElement('span');\n    label.textContent = name;\n\n    const count = document.createElement('span');\n    count.style.cssText = 'font-size:.7rem;color:var(--gold);';\n    count.textContent = `${countPerSuit[i]} tiles`;\n\n    btn.appendChild(preview);\n    btn.appendChild(label);\n    btn.appendChild(count);\n\n    btn.addEventListener('click', () => {\n      socket.emit('selectTrump', { trump: i });\n      hideOverlay('overlay-trump');\n    });\n    grid.appendChild(btn);\n  });\n}\n\n// \u2500\u2500\u2500 Hand end overlay \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction renderHandEnd(state) {\n  const last = state.handHistory[state.handHistory.length - 1];\n  if (!last) return;\n\n  const bidTeamName = last.bidTeam === 0 ? 'N/S' : 'E/W';\n  const defTeamName = last.bidTeam === 0 ? 'E/W' : 'N/S';\n  const myTeam = mySeat % 2;\n  const made = last.made;\n\n  document.getElementById('result-title').textContent = made ? `${bidTeamName} made it!` : `${bidTeamName} was set!`;\n\n  const marksFor = Object.values(last.delta).reduce((a,b)=>a+b,0);\n  const winTeam = last.delta[0] > 0 ? 'N/S' : 'E/W';\n\n  document.getElementById('result-body').innerHTML = `\n    <p class=\"${made ? 'result-made' : 'result-set'}\">\n      ${made ? '\u2713' : '\u2717'} Bid: ${last.bid.label} \u00b7 ${made ? 'Made' : 'Set'}\n    </p>\n    <p style=\"margin-top:.5rem\">${winTeam} gets ${marksFor} mark${marksFor !== 1 ? 's' : ''}</p>\n    <p style=\"margin-top:.5rem\">Score \u2014 N/S: <strong>${state.score[0]}</strong> \u00b7 E/W: <strong>${state.score[1]}</strong></p>\n    <p style=\"margin-top:.3rem;font-size:.78rem;color:var(--text-dim)\">First to 7 marks wins</p>\n  `;\n}\n\n// \u2500\u2500\u2500 Game over overlay \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction renderGameOver(state) {\n  const winner = state.score[0] >= 7 ? 'N/S' : 'E/W';\n  const myTeam = mySeat % 2 === 0 ? 'N/S' : 'E/W';\n  document.getElementById('gameover-title').textContent =\n    winner === myTeam ? '\ud83c\udf89 Your team wins!' : `${winner} wins!`;\n  document.getElementById('gameover-body').innerHTML = `\n    <p>Final score</p>\n    <p style=\"font-size:1.3rem;color:var(--gold);margin:.5rem 0\">\n      N/S ${state.score[0]} \u2013 ${state.score[1]} E/W\n    </p>\n  `;\n}\n\n// \u2500\u2500\u2500 Last trick panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconst btnLastTrick = document.getElementById('btn-show-last');\nlet lastTrickVisible = false;\nbtnLastTrick.addEventListener('click', () => {\n  lastTrickVisible = !lastTrickVisible;\n  document.getElementById('last-trick-content').classList.toggle('hidden', !lastTrickVisible);\n  btnLastTrick.textContent = lastTrickVisible ? 'Last trick \u25bc' : 'Last trick \u25b6';\n});\n\nfunction renderLastTrick(state) {\n  if (!state.lastTrick) return;\n  const el = document.getElementById('last-trick-content');\n  el.innerHTML = '';\n  state.lastTrick.plays.forEach(play => {\n    const wrapper = document.createElement('div');\n    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;';\n    const tileEl = renderTile(play.tile, false, state.trump);\n    tileEl.style.cssText = `width:32px;height:58px;`;\n    if (play.seatIndex === state.lastTrick.winner) tileEl.classList.add('trick-winner');\n    const nameTag = document.createElement('div');\n    nameTag.style.cssText = 'font-size:.65rem;color:var(--text-dim);text-align:center;max-width:36px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';\n    nameTag.textContent = state.seats[play.seatIndex]?.name || `P${play.seatIndex+1}`;\n    wrapper.appendChild(tileEl);\n    wrapper.appendChild(nameTag);\n    el.appendChild(wrapper);\n  });\n}\n\n// \u2500\u2500\u2500 Rejoin on reconnect \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nsocket.on('connect', () => {\n  const code = sessionStorage.getItem('42-room');\n  const seat = sessionStorage.getItem('42-seat');\n  const name = sessionStorage.getItem('42-name');\n  if (code && seat !== null && name) {\n    mySeat = parseInt(seat);\n    myRoom = code;\n    myName = name;\n    socket.emit('rejoin', { code, seat: parseInt(seat), name });\n  }\n});\n\n</script>\n</body>\n</html>";
app.get('/', (req, res) => { res.setHeader('Content-Type', 'text/html'); res.send(PAGE_HTML); });
app.get('/index.html', (req, res) => { res.setHeader('Content-Type', 'text/html'); res.send(PAGE_HTML); });

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
    passCount: 0,
    trump: null,
    trick: [],
    tricksTaken: [0, 0, 0, 0],
    pointsTaken: [0, 0, 0, 0],
    trickCount: [0, 0, 0, 0],
    currentPlayer: 0,
    score: [0, 0],
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
  let loops = 0;
  while (room.bids.find(b => b.seatIndex === room.currentBidder && b.special === 'pass')) {
    room.currentBidder = (room.currentBidder + 1) % 4;
    if (++loops > 4) break;
  }
}

function checkBiddingDone(room) {
  const passed = new Set(room.bids.filter(b => b.special === 'pass').map(b => b.seatIndex));
  const active = [0, 1, 2, 3].filter(i => !passed.has(i));
  return active.length === 1 || room.bid.special === 'plunge' || room.bid.special === 'follow_me';
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
    socket.join(code.toUpperCase());
    socket.emit('joined', { code: room.code, seat: emptySeat, name });
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
      const passed = room.bids.filter(b => b.special === 'pass').length;
      if (passed === 3 && room.bid.seatIndex !== -1) {
        openTrumpSelect(room);
        return;
      }
      if (passed === 4) {
        room.bid = { amount: 30, special: null, seatIndex: room.dealer, label: '30 (forced)' };
        room.bids.push(room.bid);
        openTrumpSelect(room);
        return;
      }
      advanceBidder(room);
      broadcastRoom(room);
      return;
    }

    room.bid = thisBid;
    room.bids.push(thisBid);

    if (checkBiddingDone(room)) {
      openTrumpSelect(room);
    } else {
      advanceBidder(room);
      broadcastRoom(room);
    }
  });

  function openTrumpSelect(room) {
    room.state = 'trump_select';
    broadcastRoom(room);
  }

  socket.on('selectTrump', ({ trump }) => {
    const found = findRoomBySocket(socket.id);
    if (!found) return;
    const { room, seat } = found;
    if (room.state !== 'trump_select') return;
    if (room.bid.seatIndex !== seat) { socket.emit('error', 'Only the bid winner selects trump'); return; }
    if (trump < 0 || trump > 6) return;
    room.trump = trump;
    room.state = 'playing';
    room.currentPlayer = room.bid.seatIndex;
    broadcastRoom(room);
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
        const follows = leadIsThump
          ? tileIsTrump
          : (!tileIsTrump && (tile.hi === leadSuit || tile.lo === leadSuit));
        if (!follows) { socket.emit('error', 'Must follow suit'); return; }
      }
    }

    const tile = hand.splice(tileIdx, 1)[0];
    room.trick.push({ seatIndex: seat, tile });

    if (room.trick.length === 4) {
      const winnerSeat = trickWinner(room.trick, room.trump);
      const pts = room.trick.reduce((s, p) => s + tileScore(p.tile), 0) + 1;
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
    if (room.seats[seat]) room.seats[seat] = { ...room.seats[seat], disconnected: true };
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
