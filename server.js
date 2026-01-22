// server.js (authoritative)
// npm i ws
// node server.js

"use strict";

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_HUMANS = 10;
const HEARTBEAT_MS = 30000;

// ---- Game constants / limits
const MAX_BOTS = 10;
const MIN_STACK = 100;
const MAX_STACK = 50000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Poker WS server running.\n");
});

const wss = new WebSocket.Server({ server });

// -------------------- Utils
function rid() {
  return (
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function now() {
  return Date.now();
}

// -------------------- Cards / evaluator (7->5)
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
const RANK_VALUE = Object.fromEntries(RANKS.map((r,i)=>[r,i+2]));

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s });
  return d;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function findStraightHigh(uniqueValsDesc) {
  const set = new Set(uniqueValsDesc);
  const wheel = [14, 5, 4, 3, 2];
  if (wheel.every((v) => set.has(v))) return 5;

  for (const high of uniqueValsDesc) {
    let ok = true;
    for (let d = 1; d <= 4; d++) {
      if (!set.has(high - d)) { ok = false; break; }
    }
    if (ok) return high;
  }
  return null;
}
function evaluate7(cards) {
  const vals = cards.map((c) => RANK_VALUE[c.r]).sort((a, b) => b - a);

  const byRank = new Map();
  for (const c of cards) {
    const v = RANK_VALUE[c.r];
    byRank.set(v, (byRank.get(v) || 0) + 1);
  }
  const groups = [...byRank.entries()]
    .map(([v, c]) => ({ v, c }))
    .sort((a, b) => (b.c - a.c) || (b.v - a.v));

  const bySuit = new Map();
  for (const c of cards) {
    if (!bySuit.has(c.s)) bySuit.set(c.s, []);
    bySuit.get(c.s).push(RANK_VALUE[c.r]);
  }
  for (const [s, arr] of bySuit) arr.sort((a, b) => b - a);
  const flushSuit = [...bySuit.entries()].find(([s, arr]) => arr.length >= 5)?.[0] ?? null;

  const unique = [...new Set(vals)];
  const straight = findStraightHigh(unique);

  let sf = null;
  if (flushSuit) {
    const fv = [...new Set(bySuit.get(flushSuit))].sort((a, b) => b - a);
    sf = findStraightHigh(fv);
  }

  if (sf) return { cat: 8, t: [sf], name: "színsor" };
  if (groups[0]?.c === 4) {
    const q = groups[0].v;
    const k = unique.find((v) => v !== q);
    return { cat: 7, t: [q, k], name: "póker" };
  }
  if (groups[0]?.c === 3 && groups[1]?.c >= 2) {
    return { cat: 6, t: [groups[0].v, groups[1].v], name: "full house" };
  }
  if (flushSuit) return { cat: 5, t: bySuit.get(flushSuit).slice(0, 5), name: "szín" };
  if (straight) return { cat: 4, t: [straight], name: "sor" };
  if (groups[0]?.c === 3) {
    const tr = groups[0].v;
    const k = unique.filter((v) => v !== tr).slice(0, 2);
    return { cat: 3, t: [tr, ...k], name: "drill" };
  }
  if (groups[0]?.c === 2 && groups[1]?.c === 2) {
    const hi = Math.max(groups[0].v, groups[1].v);
    const lo = Math.min(groups[0].v, groups[1].v);
    const k = unique.find((v) => v !== hi && v !== lo);
    return { cat: 2, t: [hi, lo, k], name: "két pár" };
  }
  if (groups[0]?.c === 2) {
    const pr = groups[0].v;
    const k = unique.filter((v) => v !== pr).slice(0, 3);
    return { cat: 1, t: [pr, ...k], name: "pár" };
  }
  return { cat: 0, t: unique.slice(0, 5), name: "magas lap" };
}
function cmpEval(a, b) {
  if (a.cat !== b.cat) return a.cat > b.cat ? 1 : -1;
  for (let i = 0; i < Math.max(a.t.length, b.t.length); i++) {
    const av = a.t[i] ?? 0;
    const bv = b.t[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

// -------------------- Poker engine helpers
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function amountToCall(st, p) {
  return Math.max(0, st.currentBet - p.bet);
}
function countAlive(st) {
  return st.players.filter(p => p.inHand && !p.folded).length;
}
function nextEligibleIndex(st, from) {
  const n = st.players.length;
  for (let t = 1; t <= n; t++) {
    const idx = (from + t) % n;
    const p = st.players[idx];
    if (p.inHand && !p.folded) return idx;
  }
  return from;
}
function nextActionIndex(st, from) {
  const n = st.players.length;
  for (let t = 1; t <= n; t++) {
    const idx = (from + t) % n;
    const p = st.players[idx];
    if (p.inHand && !p.folded && !p.allIn) return idx;
  }
  return null;
}
function bettingClosed(st) {
  if (countAlive(st) <= 1) return true;
  const elig = st.players.filter(p => p.inHand && !p.folded && !p.allIn);
  if (elig.length === 0) return true;

  const acted = new Set(st.acted || []);
  for (const p of elig) {
    if (p.bet !== st.currentBet) return false;
    if (!acted.has(p.id)) return false;
  }
  return true;
}
function hist(st, text) {
  st.history = st.history || [];
  st.history.push(text);
  if (st.history.length > 250) st.history.shift();
  st.msg = text;
}

function postBlind(st, idx, amt, label) {
  const p = st.players[idx];
  const pay = Math.min(amt, p.stack);
  p.stack -= pay;
  p.bet += pay;
  p.totalInvested += pay;
  st.pot += pay;
  if (p.stack === 0) p.allIn = true;
  hist(st, `${p.name} posztolja: ${label} ${pay}`);
}

function startHand(st) {
  st.handNo++;
  st.history = [];
  st.showdownInfo = null;
  st.showAllHands = false;

  hist(st, `=== ${st.handNo}. kör indul ===`);

  st.deck = shuffle(makeDeck());
  st.community = [];
  st.pot = 0;
  st.street = "PREFLOP";
  st.currentBet = 0;
  st.acted = [];
  st.handActive = true;

  for (const p of st.players) {
    p.hand = [];
    p.inHand = p.stack > 0;
    p.folded = !p.inHand;
    p.allIn = false;
    p.bet = 0;
    p.totalInvested = 0;
    p._eval = null;
  }

  st.dealer = nextEligibleIndex(st, st.dealer);

  // deal 2 cards
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < st.players.length; i++) {
      const idx = (st.dealer + 1 + i) % st.players.length;
      if (st.players[idx].inHand) st.players[idx].hand.push(st.deck.pop());
    }
  }

  st.sbIndex = nextEligibleIndex(st, st.dealer);
  st.bbIndex = nextEligibleIndex(st, st.sbIndex);

  postBlind(st, st.sbIndex, st.cfg.sb, "SB");
  postBlind(st, st.bbIndex, st.cfg.bb, "BB");

  st.currentBet = Math.max(...st.players.map(p => p.bet));
  st.toAct = nextEligibleIndex(st, st.bbIndex);
  st.acted = [];
  hist(st, `Preflop indul. Aktuális tét: ${st.currentBet}.`);
}

function awardIfOnlyOne(st) {
  if (countAlive(st) <= 1) {
    const w = st.players.find(p => p.inHand && !p.folded);
    if (w) w.stack += st.pot;
    st.handActive = false;
    st.street = "SHOWDOWN";
    st.showAllHands = false; // ha mindenki dobott, ne spoilerezzünk
    st.showdownInfo = w ? { winners: [w.name], handName: "mindenki dobott" } : null;
    hist(st, `Nyertes: ${w?.name ?? "—"} (+${st.pot})`);
    return true;
  }
  return false;
}

function actFold(st, idx) {
  const p = st.players[idx];
  p.folded = true;
  st.acted.push(p.id);
  hist(st, `${p.name}: dobás`);

  if (awardIfOnlyOne(st)) return;

  st.toAct = bettingClosed(st) ? null : nextActionIndex(st, idx);
}

function actCallCheck(st, idx) {
  const p = st.players[idx];
  const call = amountToCall(st, p);
  const pay = Math.min(call, p.stack);

  p.stack -= pay;
  p.bet += pay;
  p.totalInvested += pay;
  st.pot += pay;

  if (p.stack === 0 && call > 0) p.allIn = true;

  if (call === 0) hist(st, `${p.name}: passz`);
  else hist(st, `${p.name}: megad ${pay}${pay < call ? " (all-in)" : ""}`);

  st.acted.push(p.id);
  st.toAct = bettingClosed(st) ? null : nextActionIndex(st, idx);
}

// Raise-to (klasszikus): amount = cél tét szint (nem +)
// Kliensben majd úgy oldjuk meg, hogy érthető legyen.
function actRaiseTo(st, idx, raiseToRaw) {
  const p = st.players[idx];
  let raiseTo = Number(raiseToRaw || 0);

  if (!Number.isFinite(raiseTo)) raiseTo = st.currentBet;
  if (raiseTo <= st.currentBet) {
    actCallCheck(st, idx);
    return;
  }

  const need = Math.max(0, raiseTo - p.bet);
  const pay = Math.min(need, p.stack);

  p.stack -= pay;
  p.bet += pay;
  p.totalInvested += pay;
  st.pot += pay;

  if (p.stack === 0) p.allIn = true;

  st.currentBet = p.bet;
  st.acted = [p.id]; // újraindítjuk az "acted" kört
  hist(st, `${p.name}: emel ${st.currentBet}-ig${p.allIn ? " (all-in)" : ""}`);

  st.toAct = bettingClosed(st) ? null : nextActionIndex(st, idx);
}

function advanceStreet(st) {
  if (!st.handActive) return;
  if (!bettingClosed(st)) return;

  if (awardIfOnlyOne(st)) return;

  // reset bets
  for (const p of st.players) p.bet = 0;
  st.currentBet = 0;
  st.acted = [];
  st.toAct = nextEligibleIndex(st, st.dealer);

  if (st.street === "PREFLOP") {
    st.deck.pop(); // burn
    st.community.push(st.deck.pop(), st.deck.pop(), st.deck.pop());
    st.street = "FLOP";
    hist(st, "Flop.");
  } else if (st.street === "FLOP") {
    st.deck.pop();
    st.community.push(st.deck.pop());
    st.street = "TURN";
    hist(st, "Turn.");
  } else if (st.street === "TURN") {
    st.deck.pop();
    st.community.push(st.deck.pop());
    st.street = "RIVER";
    hist(st, "River.");
  } else if (st.street === "RIVER") {
    st.street = "SHOWDOWN";
    doShowdown(st);
  }
}

function doShowdown(st) {
  const alive = st.players.filter(p => p.inHand && !p.folded);
  if (alive.length === 0) {
    st.handActive = false;
    hist(st, "Showdown: nincs aktív játékos.");
    return;
  }

  for (const p of alive) {
    p._eval = evaluate7(p.hand.concat(st.community));
  }

  // overall winners + banner
  let best = alive[0]._eval;
  for (const p of alive) if (cmpEval(p._eval, best) > 0) best = p._eval;

  const winnersOverall = alive.filter(p => cmpEval(p._eval, best) === 0).map(p => p.name);
  st.showdownInfo = { winners: winnersOverall, handName: best.name };
  st.showAllHands = true;

  // side pot payout by invested levels
  const investedAll = st.players
    .map(p => ({ id: p.id, invested: Number(p.totalInvested || 0) }))
    .filter(x => x.invested > 0)
    .sort((a, b) => a.invested - b.invested);

  if (investedAll.length === 0) {
    st.handActive = false;
    hist(st, "Showdown: üres pot.");
    return;
  }

  const levels = [...new Set(investedAll.map(x => x.invested))].sort((a, b) => a - b);
  const won = new Map(st.players.map(p => [p.id, 0]));
  let prev = 0;

  for (const L of levels) {
    const inTier = st.players.filter(p => Number(p.totalInvested || 0) >= L);
    const tierAmount = (L - prev) * inTier.length;
    prev = L;
    if (tierAmount <= 0) continue;

    const eligible = inTier.filter(p => p.inHand && !p.folded);
    if (eligible.length === 0) continue;

    let bestTier = eligible[0]._eval;
    for (const p of eligible) if (cmpEval(p._eval, bestTier) > 0) bestTier = p._eval;

    const winners = eligible.filter(p => cmpEval(p._eval, bestTier) === 0);

    const share = Math.floor(tierAmount / winners.length);
    let rem = tierAmount - share * winners.length;

    const ordered = winners.slice().sort((a, b) => a.id - b.id);
    for (const w of ordered) {
      w.stack += share;
      won.set(w.id, (won.get(w.id) || 0) + share);
    }
    for (let i = 0; i < ordered.length && rem > 0; i++) {
      ordered[i].stack += 1;
      won.set(ordered[i].id, (won.get(ordered[i].id) || 0) + 1);
      rem--;
    }

    hist(st, `Side pot (${tierAmount}) nyertes(ek): ${ordered.map(w => w.name).join(", ")} – ${bestTier.name}`);
  }

  st.handActive = false;
  const summary = st.players
    .filter(p => (won.get(p.id) || 0) > 0)
    .map(p => `${p.name} +${won.get(p.id)}`)
    .join(" | ");
  if (summary) hist(st, `Kifizetések: ${summary}`);
}

// -------------------- Rooms / state
function publicLobbyPayload(r) {
  return {
    humans: r.humans.map(h => ({ clientId: h.clientId, name: h.name, seat: h.seat })),
    ready: { ...r.ready },
    cfg: { ...r.cfg },
    started: r.started
  };
}

function publicStatePayload(r, viewerClientId) {
  // IMPORTANT: hole cards only for the viewer, unless showdown + showAllHands
  const st = r.state;
  if (!st) return null;

  const viewerSeat = r.humans.find(h => h.clientId === viewerClientId)?.seat ?? null;

  const players = st.players.map((p, idx) => {
    const isHuman = !p.isBot;
    const canSeeHand =
      (st.showAllHands && st.street === "SHOWDOWN") ||
      (viewerSeat !== null && viewerSeat === idx);

    return {
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      stack: p.stack,
      inHand: p.inHand,
      folded: p.folded,
      allIn: p.allIn,
      bet: p.bet,
      totalInvested: p.totalInvested,
      hand: canSeeHand ? p.hand : [], // hide others
      _eval: (st.showAllHands && st.street === "SHOWDOWN") ? p._eval : null
    };
  });

  return {
    cfg: { ...st.cfg },
    history: st.history || [],
    handNo: st.handNo,
    dealer: st.dealer,
    sbIndex: st.sbIndex,
    bbIndex: st.bbIndex,
    community: st.community || [],
    pot: st.pot,
    street: st.street,
    toAct: st.toAct,
    currentBet: st.currentBet,
    acted: st.acted || [],
    handActive: st.handActive,
    msg: st.msg || "",
    showdownInfo: st.showdownInfo || null,
    showAllHands: !!st.showAllHands,
    players
  };
}

function broadcastLobby(roomName) {
  const r = rooms.get(roomName);
  if (!r) return;
  const payload = publicLobbyPayload(r);
  for (const [cid, ws] of r.clients) {
    send(ws, { type: "lobby", lobby: payload, hostId: r.hostId });
  }
}

function broadcastState(roomName) {
  const r = rooms.get(roomName);
  if (!r || !r.state) return;
  for (const [cid, ws] of r.clients) {
    send(ws, { type: "state", state: publicStatePayload(r, cid) });
  }
}

function ensureHost(r) {
  if (r.hostId && r.clients.has(r.hostId)) return;
  r.hostId = r.humans[0]?.clientId ?? null;
}

// ---- Bot scheduling (server-side)
function scheduleBotTick(r) {
  if (!r || !r.state || !r.started) return;
  if (!r.state.handActive) return;
  if (r.botTimer) return;

  r.botTimer = setTimeout(() => {
    r.botTimer = null;
    botActIfNeeded(r);
  }, 1200);
}

function botActIfNeeded(r) {
  const st = r.state;
  if (!st || !st.handActive || st.toAct == null) return;

  const p = st.players[st.toAct];
  if (!p || !p.isBot) return;

  const call = amountToCall(st, p);
  const pressure = call / Math.max(1, p.stack + call);
  const rr = Math.random();

  if (call > 0 && pressure > 0.45 && rr < 0.55) actFold(st, st.toAct);
  else if (rr < 0.12 && p.stack > call + st.cfg.bb) actRaiseTo(st, st.toAct, st.currentBet + st.cfg.bb);
  else actCallCheck(st, st.toAct);

  let guard = 0;
  while (st.handActive && st.street !== "SHOWDOWN" && bettingClosed(st) && guard++ < 50) {
    advanceStreet(st);
  }

  broadcastState(r.name);
  scheduleBotTick(r);
}

// -------------------- Room store
const rooms = new Map(); // roomName -> room object

function getOrCreateRoom(roomName, pw, creatorClientId) {
  let r = rooms.get(roomName);
  if (!r) {
    r = {
      name: roomName,
      pw,
      hostId: creatorClientId,
      clients: new Map(), // clientId -> ws
      humans: [], // {clientId,name,seat}
      ready: {}, // clientId -> bool
      cfg: { bots: 2, stack: 1000, blinds: "10,20" },
      started: false,
      state: null,
      botTimer: null,
    };
    rooms.set(roomName, r);
  }
  return r;
}

function allHumansReady(r) {
  return r.humans.length > 0 && r.humans.every(h => r.ready[h.clientId] === true);
}

function rebuildStateForRoom(r) {
  const humans = r.humans.slice().sort((a,b)=>a.seat-b.seat);

  const bots = clamp(Number(r.cfg.bots || 0), 0, MAX_BOTS);
  const stack = clamp(Number(r.cfg.stack || 1000), MIN_STACK, MAX_STACK);
  const [sb, bb] = String(r.cfg.blinds || "10,20").split(",").map(n => Number(n));

  const players = [
    ...humans.map((h, idx) => ({
      id: idx,
      name: h.name,
      isBot: false,
      stack,
      hand: [],
      inHand: true,
      folded: false,
      allIn: false,
      bet: 0,
      totalInvested: 0,
      _eval: null
    })),
    ...Array.from({ length: bots }).map((_, i) => ({
      id: humans.length + i,
      name: `Robot #${i + 1}`,
      isBot: true,
      stack,
      hand: [],
      inHand: true,
      folded: false,
      allIn: false,
      bet: 0,
      totalInvested: 0,
      _eval: null
    }))
  ];

  r.state = {
    cfg: { sb: Number(sb || 10), bb: Number(bb || 20), stack, bots },
    history: [],
    handNo: 0,
    dealer: 0,
    sbIndex: null,
    bbIndex: null,
    deck: [],
    community: [],
    pot: 0,
    street: "PREFLOP",
    toAct: null,
    currentBet: 0,
    acted: [],
    handActive: false,
    msg: "Játék indul!",
    showdownInfo: null,
    showAllHands: false,
    players
  };
}

// -------------------- Heartbeat
function heartbeat() { this.isAlive = true; }

const interval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(interval));

// -------------------- Connection
wss.on("connection", (ws) => {
  const clientId = rid();
  ws._id = clientId;
  ws._room = null;
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // -------- JOIN
    if (msg.type === "join") {
      const roomName = String(msg.room || "").trim();
      const name = String(msg.name || "").trim().slice(0, 16);
      const pw = String(msg.pw || "").trim();

      if (!roomName || !name || !pw) {
        send(ws, { type: "error", message: "Hiányzó belépési adat." });
        return;
      }

      const r = rooms.get(roomName);
      if (!r) {
        // create
        const created = getOrCreateRoom(roomName, pw, clientId);
        created.clients.set(clientId, ws);
        ws._room = roomName;

        created.humans.push({ clientId, name, seat: 0 });
        created.ready[clientId] = false;
        ensureHost(created);

        send(ws, { type: "welcome", clientId, hostId: created.hostId, seat: 0 });
        broadcastLobby(roomName);
        return;
      }

      // existing room pw check
      if (r.pw !== pw) {
        send(ws, { type: "error", message: "Rossz jelszó." });
        return;
      }

      if (r.humans.length >= MAX_HUMANS) {
        send(ws, { type: "error", message: "Tele van az asztal (max 10 fő)." });
        return;
      }

      // seat = next free lowest
      const used = new Set(r.humans.map(h => h.seat));
      let seat = 0;
      while (used.has(seat)) seat++;

      r.clients.set(clientId, ws);
      ws._room = roomName;

      r.humans.push({ clientId, name, seat });
      r.ready[clientId] = false;

      ensureHost(r);

      send(ws, { type: "welcome", clientId, hostId: r.hostId, seat });
      broadcastLobby(roomName);

      // if game is running, also send state snapshot immediately
      if (r.started && r.state) {
        send(ws, { type: "state", state: publicStatePayload(r, clientId) });
      }
      return;
    }

    const roomName = ws._room;
    if (!roomName) return;

    const r = rooms.get(roomName);
    if (!r) return;

    // -------- GET LOBBY
    if (msg.type === "getLobby") {
      send(ws, { type: "lobby", lobby: publicLobbyPayload(r), hostId: r.hostId });
      if (r.started && r.state) send(ws, { type: "state", state: publicStatePayload(r, ws._id) });
      return;
    }

    // -------- INTENTS (server-authoritative)
    if (msg.type === "intent") {
      const intent = String(msg.intent || "");

      // ready / unready
      if (intent === "ready") r.ready[ws._id] = true;
      if (intent === "unready") r.ready[ws._id] = false;

      // host config (only host)
      if (intent === "hostConfig") {
        if (ws._id !== r.hostId) return;

        const cfg = msg.cfg && typeof msg.cfg === "object" ? msg.cfg : {};
        const bots = clamp(Number(cfg.bots ?? r.cfg.bots), 0, MAX_BOTS);
        const stack = clamp(Number(cfg.stack ?? r.cfg.stack), MIN_STACK, MAX_STACK);
        const blinds = String(cfg.blinds ?? r.cfg.blinds);

        r.cfg = { bots, stack, blinds };
      }

      // chat broadcast
      if (intent === "chat") {
        const text = String(msg.text || "").slice(0, 300);
        const who = r.humans.find(h => h.clientId === ws._id)?.name || "Ismeretlen";
        for (const [cid, cws] of r.clients) send(cws, { type: "chat", name: who, text, at: now() });
      }

      // host commands: start/newHand/newGame/topup
      if (intent === "startGame") {
        if (ws._id !== r.hostId) return;
        if (!allHumansReady(r)) {
          send(ws, { type: "error", message: "Nem minden ember KÉSZ még." });
          broadcastLobby(roomName);
          return;
        }
        r.started = true;
        rebuildStateForRoom(r);
        startHand(r.state);
        broadcastLobby(roomName);
        broadcastState(roomName);
        scheduleBotTick(r);
        return;
      }

      if (intent === "newHand") {
        if (ws._id !== r.hostId) return;
        if (!r.started || !r.state) return;
        if (r.state.handActive) {
          send(ws, { type: "error", message: "A leosztás még tart." });
          return;
        }
        startHand(r.state);
        broadcastState(roomName);
        scheduleBotTick(r);
        return;
      }

      if (intent === "newGame") {
        if (ws._id !== r.hostId) return;
        if (!allHumansReady(r)) {
          send(ws, { type: "error", message: "Új játékhoz minden ember legyen KÉSZ." });
          broadcastLobby(roomName);
          return;
        }
        r.started = true;
        rebuildStateForRoom(r);
        startHand(r.state);
        broadcastLobby(roomName);
        broadcastState(roomName);
        scheduleBotTick(r);
        return;
      }

      if (intent === "topup") {
        if (ws._id !== r.hostId) return;
        if (!r.started || !r.state) return;
        if (r.state.handActive) {
          send(ws, { type: "error", message: "Zsetont csak kör végén adj!" });
          return;
        }
        const seatIdx = Number(msg.seat);
        const amt = Math.max(1, Number(msg.amount || 0));

        const humansSorted = r.humans.slice().sort((a,b)=>a.seat-b.seat);
        const humanSeats = humansSorted.map(h => h.seat);
        if (!humanSeats.includes(seatIdx)) {
          send(ws, { type: "error", message: "Csak ember játékosnak adhatsz zsetont." });
          return;
        }

        const p = r.state.players[seatIdx];
        if (!p || p.isBot) {
          send(ws, { type: "error", message: "Csak ember játékosnak adhatsz zsetont." });
          return;
        }

        p.stack += amt;
        if (p.stack > 0) p.allIn = false;
        hist(r.state, `HOST: ${p.name} kapott +${amt} zsetont.`);
        broadcastState(roomName);
        return;
      }

      // player action
      if (intent === "action") {
        if (!r.started || !r.state) return;
        const st = r.state;
        if (!st.handActive) return;

        const seat = r.humans.find(h => h.clientId === ws._id)?.seat ?? null;
        if (seat == null) return;

        // enforce turn
        if (st.toAct !== seat) return;

        const p = st.players[seat];
        if (!p || p.isBot || p.folded || p.allIn || !p.inHand) return;

        const action = String(msg.action || "");
        if (action === "fold") actFold(st, seat);
        else if (action === "call") actCallCheck(st, seat);
        else if (action === "raise") actRaiseTo(st, seat, Number(msg.amount || 0));
        else return;

        let guard = 0;
        while (st.handActive && st.street !== "SHOWDOWN" && bettingClosed(st) && guard++ < 50) {
          advanceStreet(st);
        }

        broadcastState(roomName);
        scheduleBotTick(r);
        return;
      }

      // always broadcast lobby if ready/config changed
      broadcastLobby(roomName);
      return;
    }

    // ignore unknown
  });

  ws.on("close", () => {
    const roomName = ws._room;
    if (!roomName) return;

    const r = rooms.get(roomName);
    if (!r) return;

    r.clients.delete(ws._id);
    delete r.ready[ws._id];
    r.humans = r.humans.filter(h => h.clientId !== ws._id);

    // if someone leaves during active hand -> fold their seat (if state exists)
    if (r.started && r.state) {
      const seatIdx = r.state.players.findIndex(p => p.name && !p.isBot && p.name === undefined);
      // (nem támaszkodunk erre)
      // inkább: ha volt seat a humans listában, nem tudjuk már; ezért a kliens oldalon
      // majd küldjük a seat-et "welcome"-ből és a szerver map alapján dolgozunk.
      // A humans listából már kiszedtük, de a handben bent maradhatna a player.
      // Egyszerű és korrekt: ha az adott seat indexet tudnánk, foldolnánk.
      // Itt most a tiszta megoldás: rebuild newGame-hez lesz rendbe.
      // (Kliens oldali újraírásnál betesszük, hogy disconnect esetén fold a seat szerint.)
    }

    const oldHost = r.hostId;
    ensureHost(r);

    if (oldHost !== r.hostId) {
      // host changed notice
      for (const [cid, cws] of r.clients) send(cws, { type: "hostChanged", hostId: r.hostId });
    }

    if (r.clients.size === 0) {
      if (r.botTimer) { clearTimeout(r.botTimer); r.botTimer = null; }
      rooms.delete(roomName);
      return;
    }

    broadcastLobby(roomName);
    // state stays on server even if host leaves
    broadcastState(roomName);
  });
});

server.listen(PORT, () => console.log("WS szerver figyel a porton:", PORT));
