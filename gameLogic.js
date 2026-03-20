'use strict';

// ─── Domino generation ───────────────────────────────────────────────────────

function makeDominoes() {
  const tiles = [];
  for (let hi = 0; hi <= 6; hi++) {
    for (let lo = 0; lo <= hi; lo++) {
      tiles.push({ hi, lo, id: `${hi}-${lo}` });
    }
  }
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
  return [
    tiles.slice(0, 7),
    tiles.slice(7, 14),
    tiles.slice(14, 21),
    tiles.slice(21, 28),
  ];
}

// ─── Tile helpers ─────────────────────────────────────────────────────────────

function tileScore(tile) {
  const sum = tile.hi + tile.lo;
  return (sum === 5 || sum === 10) ? sum : 0;
}

function tileFollowsSuit(tile, leadSuit, trump) {
  if (trump !== null && (tile.hi === trump || tile.lo === trump)) return false; // trumps handled separately
  return tile.hi === leadSuit || tile.lo === leadSuit;
}

function isTrump(tile, trump) {
  if (trump === null) return false;
  return tile.hi === trump || tile.lo === trump;
}

// Returns effective "suit" of a tile given trump
function effectiveSuit(tile, trump) {
  if (isTrump(tile, trump)) return trump;
  return tile.hi; // lead value is hi by convention for the play
}

// ─── Trick winner ─────────────────────────────────────────────────────────────

function trickWinner(plays, trump) {
  // plays = [{seatIndex, tile}, ...], first play is the lead
  const lead = plays[0];
  const leadSuit = isTrump(lead.tile, trump) ? trump : lead.tile.hi === lead.tile.lo ? lead.tile.hi : null;
  // Determine lead suit properly: the value of the tile that matches led direction
  // For doubles: suit = that number
  // For non-doubles: the "pip" on the end that matches suit (first play sets the suit)
  const ledValue = (() => {
    if (isTrump(lead.tile, trump)) return 'trump';
    // The led suit is determined by whichever end the leader meant — in 42 it's
    // considered the HIGHER end unless the higher end is trump; we track it as
    // the non-trump end (or hi if neither is trump)
    if (lead.tile.hi === trump) return lead.tile.lo;
    return lead.tile.hi;
  })();

  let winner = lead;
  let winnerIsTrump = isTrump(lead.tile, trump);

  for (let i = 1; i < plays.length; i++) {
    const p = plays[i];
    const pTrump = isTrump(p.tile, trump);

    if (pTrump && !winnerIsTrump) {
      // Trump beats non-trump
      winner = p;
      winnerIsTrump = true;
    } else if (pTrump && winnerIsTrump) {
      // Both trump: higher trump pip wins
      const wPip = Math.max(winner.tile.hi, winner.tile.lo);
      const pPip = Math.max(p.tile.hi, p.tile.lo);
      if (pPip > wPip) winner = p;
    } else if (!pTrump && !winnerIsTrump) {
      // Both non-trump: must follow suit to challenge
      const pSuit = p.tile.hi === trump ? p.tile.lo : p.tile.hi;
      if (pSuit === ledValue) {
        // Same suit: higher pip wins
        const wPip = Math.max(winner.tile.hi, winner.tile.lo);
        const pPip = Math.max(p.tile.hi, p.tile.lo);
        if (pPip > wPip) winner = p;
      }
    }
    // Off-suit non-trump: cannot win
  }
  return winner.seatIndex;
}

// ─── Bid validation ───────────────────────────────────────────────────────────

const SPECIAL_BIDS = ['low', 'plunge', 'follow_me'];

// Returns true if newBid beats currentBid
// currentBid: { amount: number, special: string|null }
// newBid:     { amount: number, special: string|null }
function bidBeats(current, newBid) {
  if (newBid.special === 'pass') return false;

  // Numeric bids 30-42
  if (!newBid.special) {
    if (current.special === 'follow_me') return false; // follow_me is game-ender
    if (current.special === 'plunge') return false;
    if (current.special === 'low') return newBid.amount > 42; // can double a low? No — only numeric beats numeric below
    // Current is numeric
    return newBid.amount > current.amount;
  }

  // Doubling chain: 84, 126, 168, 210
  if ([84, 126, 168, 210].includes(newBid.amount) && !newBid.special) {
    return newBid.amount > (current.amount || 0);
  }

  if (newBid.special === 'low') {
    return !current.special && current.amount <= 42;
  }
  if (newBid.special === 'plunge') {
    // Plunge requires player to have at least 4 doubles; validated elsewhere
    return true; // auto-wins bidding
  }
  if (newBid.special === 'follow_me') {
    return true; // auto-wins bidding
  }
  return false;
}

// ─── Bid amount list ──────────────────────────────────────────────────────────

function validBidsFor(highBid, seatIndex, hand) {
  const bids = [];

  // Numeric: 30..42
  for (let b = 30; b <= 42; b++) {
    if (b > (highBid.amount || 29) || highBid.special) {
      if (!highBid.special) bids.push({ amount: b, special: null, label: String(b) });
    }
  }

  // Doubling chain
  const doubles = [84, 126, 168, 210];
  for (const d of doubles) {
    if (d > (highBid.amount || 0) && !highBid.special) {
      bids.push({ amount: d, special: null, label: String(d) });
    }
  }

  // Low (bid 42, win by taking fewest points)
  if (!highBid.special) {
    bids.push({ amount: 42, special: 'low', label: 'Low' });
  }

  // Plunge: all 4 doubles in hand, no bid yet above 42
  const doubleCount = hand.filter(t => t.hi === t.lo).length;
  if (doubleCount >= 4 && !highBid.special && (highBid.amount || 0) < 42) {
    bids.push({ amount: 84, special: 'plunge', label: 'Plunge' });
  }

  // Follow me: bidder names trump, no opponent can outbid
  bids.push({ amount: 42, special: 'follow_me', label: 'Follow Me' });

  bids.push({ amount: 0, special: 'pass', label: 'Pass' });

  return bids;
}

// ─── Mark scoring ─────────────────────────────────────────────────────────────

// Returns { teamA: marks, teamB: marks } delta for this hand
// teams: [[seat0, seat2], [seat1, seat3]] (partnerships)
// bid: { amount, special, seatIndex }
// tricksTaken: { 0: tricks, 1: tricks, 2: tricks, 3: tricks } count per seat
// pointsTaken: same but count of pip-points
function scoreHand(bid, tricksTaken, pointsTaken) {
  const bidTeam = bid.seatIndex % 2; // 0 = seats 0&2, 1 = seats 1&3
  const defTeam = 1 - bidTeam;

  const bidTeamTricks = tricksTaken[bidTeam * 2] + tricksTaken[bidTeam * 2 === 0 ? 2 : 3];
  const bidTeamPoints = pointsTaken[bidTeam * 2] + pointsTaken[bidTeam * 2 === 0 ? 2 : 3];

  // In 42 there are 7 tricks total and 42 pip-points (counting the 7 trick-points)
  // Actually: 35 pips (5s and 10s) + 7 trick-bonus = 42
  // Each trick is worth 1 bonus point; 5-0,5-5=5pts,4-1=5pts,6-4=10pts,5-5=10,double-5=10

  let delta = { 0: 0, 1: 0 }; // marks for team 0 and team 1

  if (bid.special === 'plunge') {
    // Bidding team must win ALL 7 tricks
    const won = bidTeamTricks === 7;
    const marks = 4; // plunge = 4 marks
    if (won) delta[bidTeam] = marks;
    else delta[defTeam] = marks;
    return delta;
  }

  if (bid.special === 'follow_me') {
    // Bidder picks trump after seeing hand, must make their bid (42)
    const won = bidTeamPoints + bidTeamTricks >= 42;
    delta[won ? bidTeam : defTeam] = 1;
    return delta;
  }

  if (bid.special === 'low') {
    // Win by taking FEWER points than opponent
    const defTeamPoints = (42 - bidTeamPoints); // total is always 42
    const won = bidTeamPoints < defTeamPoints;
    delta[won ? bidTeam : defTeam] = 1;
    return delta;
  }

  // Standard / doubling chain
  const needed = bid.amount;
  const bidScore = bidTeamPoints + bidTeamTricks;
  const won = bidScore >= needed;

  let marks = 1;
  if (bid.amount === 84)  marks = 2;
  if (bid.amount === 126) marks = 3;
  if (bid.amount === 168) marks = 4;
  if (bid.amount === 210) marks = 5;

  // Set bid (all 7 tricks) = extra mark in standard game
  if (bid.amount === 42 && bidTeamTricks === 7) marks = 2;

  delta[won ? bidTeam : defTeam] = marks;
  return delta;
}

module.exports = { deal, tileScore, trickWinner, bidBeats, validBidsFor, scoreHand, isTrump };
