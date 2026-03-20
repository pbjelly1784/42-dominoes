# Texas 42 — Multiplayer Dominoes

Real-time 4-player Texas 42 dominoes. Supports standard bids (30–42), Low, Plunge, Follow Me, and the doubling chain (84 / 126 / 168 / 210).

---

## How to deploy (step-by-step, no prior experience needed)

### Step 1 — Get the code on GitHub

1. Go to https://github.com and create a free account if you don't have one.
2. Click **New repository**, name it `42-dominoes`, set it to **Public**, click **Create**.
3. On the next page, click **uploading an existing file**.
4. Drag ALL the files from this folder into the upload area. Make sure to include:
   - `server.js`
   - `package.json`
   - `.gitignore`
   - `src/gameLogic.js`
   - `public/index.html`
   - `public/css/style.css`
   - `public/js/client.js`
5. Click **Commit changes**.

### Step 2 — Deploy on Railway (free, easiest)

1. Go to https://railway.app and sign in with your GitHub account.
2. Click **New Project** → **Deploy from GitHub repo**.
3. Select your `42-dominoes` repo.
4. Railway will auto-detect it as a Node.js app and deploy it.
5. After ~60 seconds, click **Settings** → **Networking** → **Generate Domain**.
6. You'll get a URL like `42-dominoes-production.up.railway.app`.
7. Share that URL with your friends. Done!

### Alternative: Render (also free)

1. Go to https://render.com, sign up with GitHub.
2. Click **New** → **Web Service**.
3. Connect your repo, set:
   - **Build command**: `npm install`
   - **Start command**: `node server.js`
4. Click **Create Web Service**. You'll get a public URL.

---

## How to play locally (for testing)

1. Install Node.js from https://nodejs.org (LTS version).
2. Open a terminal in this folder.
3. Run: `npm install`
4. Run: `npm start`
5. Open http://localhost:3000 in your browser.

To test with multiple players on the same computer, open 4 different browser tabs.

---

## Game rules

### Teams
- Seats 1 & 3 = North/South team
- Seats 2 & 4 = East/West team

### Bidding order
Starts to the left of the dealer. Each player bids or passes. The highest bid wins.
- Minimum bid: 30
- If all four players pass, the dealer is forced to bid 30.

### Bid types
| Bid | Description |
|-----|-------------|
| 30–41 | Standard bid |
| 42 | Bid all points (set bid) |
| 84 | Double — worth 2 marks |
| 126 | Triple — worth 3 marks |
| 168 | Quadruple — worth 4 marks |
| 210 | Quintuple — worth 5 marks |
| Low | Win by taking *fewer* points than opponents |
| Plunge | Requires 4+ doubles in hand; automatically wins bid; worth 4 marks |
| Follow Me | Bidder names trump after seeing hand; cannot be outbid |

### Trump & scoring
- After winning the bid, choose a suit (0–6) as trump.
- All dominoes containing that number are trump.
- There are 42 points per hand: 35 pip-points (5s and 10s) + 7 trick-points (1 per trick).
- The bidding team must reach their bid or be "set."

### Winning
First team to reach **7 marks** wins the game.

---

## Project structure

```
42-dominoes/
├── server.js          — Node.js server, Socket.io game rooms
├── package.json
├── src/
│   └── gameLogic.js   — Pure game logic (deals, scoring, validation)
└── public/
    ├── index.html
    ├── css/style.css
    └── js/client.js   — Browser UI and socket client
```
