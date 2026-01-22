// server.js — AUTHORITATIVE v2 (FINAL + CHAT)
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 10;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Poker WS server running. MODE=AUTHORITATIVE v2\n");
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  for (const ws of room.clients.values()) send(ws, obj);
}

function lobbyPayload(room) {
  return {
    humans: room.humans.map(h => ({ clientId: h.id, name: h.name, seat: h.seat })),
    ready: room.ready,
    hostId: room.hostId,
    started: room.started,
    cfg: { stack: 1000 } // most fix (később bővíthető)
  };
}

function makeRoom(pw) {
  return {
    pw,
    clients: new Map(),
    humans: [],
    ready: {},
    hostId: null,
    started: false,
    state: null,
  };
}

function everyoneReady(room) {
  return room.humans.length > 0 && room.humans.every(h => room.ready[h.id] === true);
}

wss.on("connection", (ws) => {
  ws.id = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  ws.roomName = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // JOIN
    if (msg.type === "join") {
      const { room, name, pw } = msg || {};
      if (!room || !name || !pw) return send(ws, { type: "error", message: "Hiányzó belépési adat." });

      let r = rooms.get(room);
      if (!r) {
        r = makeRoom(pw);
        rooms.set(room, r);
      }
      if (r.pw !== pw) return send(ws, { type: "error", message: "Rossz jelszó." });

      if (r.humans.length >= MAX_PLAYERS) {
        return send(ws, { type: "error", message: "Tele az asztal (max 10 fő)." });
      }

      ws.roomName = room;
      r.clients.set(ws.id, ws);

      const seat = r.humans.length;
      r.humans.push({ id: ws.id, name: String(name).slice(0, 16), seat });
      r.ready[ws.id] = false;

      if (!r.hostId) r.hostId = ws.id;

      send(ws, { type: "welcome", clientId: ws.id, hostId: r.hostId, seat });
      broadcast(r, { type: "lobby", lobby: lobbyPayload(r) });
      if (r.state) send(ws, { type: "state", state: r.state });
      return;
    }

    const r = rooms.get(ws.roomName);
    if (!r) return;

    if (msg.type === "getLobby") {
      send(ws, { type: "lobby", lobby: lobbyPayload(r) });
      return;
    }

    // INTENTS
    if (msg.type === "intent") {
      const intent = msg.intent;

      if (intent === "ready") r.ready[ws.id] = true;
      if (intent === "unready") r.ready[ws.id] = false;

      if (intent === "chat") {
        const who = r.humans.find(h => h.id === ws.id)?.name || "Ismeretlen";
        const text = String(msg.text || "").slice(0, 300);
        broadcast(r, { type: "chat", name: who, text, at: Date.now() });
      }

      if (intent === "startGame") {
        if (ws.id !== r.hostId) return;
        if (!everyoneReady(r)) return send(ws, { type: "error", message: "Nem mindenki KÉSZ." });

        r.started = true;

        // MINIMAL demo state (nem teljes Texas, de stabil)
        r.state = {
          handNo: 1,
          street: "PREFLOP",
          pot: 0,
          currentBet: 0,
          toAct: 0, // index a players tömbben
          players: r.humans.map(h => ({
            id: h.id,
            name: h.name,
            stack: 1000,
            bet: 0,
            folded: false,
            allIn: false,
          })),
          msg: "Játék elindult."
        };

        broadcast(r, { type: "state", state: r.state });
      }

      if (intent === "action") {
        if (!r.state) return;

        const players = r.state.players || [];
        const actorIdx = r.state.toAct;

        // csak az léphet, aki soron van
        if (players[actorIdx]?.id !== ws.id) return;

        const p = players[actorIdx];
        if (!p || p.folded) return;

        const action = msg.action;
        if (action === "fold") {
          p.folded = true;
        }

        if (action === "call") {
          const need = Math.max(0, (r.state.currentBet || 0) - (p.bet || 0));
          const pay = Math.min(need, p.stack);
          p.stack -= pay;
          p.bet += pay;
          r.state.pot += pay;
          if (p.stack === 0) p.allIn = true;
        }

        if (action === "raise") {
          const to = Number(msg.amount || 0);
          const target = Math.max(to, r.state.currentBet || 0);

          const need = Math.max(0, target - (p.bet || 0));
          const pay = Math.min(need, p.stack);
          p.stack -= pay;
          p.bet += pay;
          r.state.pot += pay;
          r.state.currentBet = Math.max(r.state.currentBet || 0, p.bet);
          if (p.stack === 0) p.allIn = true;
        }

        // következő aktív játékos
        const n = players.length;
        let next = actorIdx;
        for (let t = 1; t <= n; t++) {
          const idx = (actorIdx + t) % n;
          if (!players[idx].folded) { next = idx; break; }
        }
        r.state.toAct = next;

        broadcast(r, { type: "state", state: r.state });
      }

      broadcast(r, { type: "lobby", lobby: lobbyPayload(r) });
      return;
    }
  });

  ws.on("close", () => {
    const r = rooms.get(ws.roomName);
    if (!r) return;

    r.clients.delete(ws.id);
    delete r.ready[ws.id];
    r.humans = r.humans.filter(h => h.id !== ws.id);

    if (r.hostId === ws.id) r.hostId = r.humans[0]?.id ?? null;

    if (r.clients.size === 0) rooms.delete(ws.roomName);
    else broadcast(r, { type: "lobby", lobby: lobbyPayload(r) });
  });
});

server.listen(PORT, () => console.log("Server on", PORT));
