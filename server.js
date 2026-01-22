// server.js
// npm i express ws
// node server.js
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

const app = express();
app.get("/", (_, res) => res.send("Poker WS server OK"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map(); // roomCode -> roomObj

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(2, 8);
}
function now() { return Date.now(); }

function makeRoom(roomCode, pw) {
  return {
    roomCode,
    pw,
    createdAt: now(),
    hostId: null,
    clients: new Map(), // clientId -> { ws, name, seat, isBot:false }
    humans: [], // [{clientId,name,seat}]
    ready: {},  // clientId->bool
    cfg: { bots: 3, stack: 1000, blinds: "10,20" },
    started: false,
    state: null
  };
}

function broadcast(room, msgObj) {
  const data = JSON.stringify(msgObj);
  for (const c of room.clients.values()) {
    try { c.ws.send(data); } catch {}
  }
}

function send(ws, msgObj) {
  try { ws.send(JSON.stringify(msgObj)); } catch {}
}

function roomSnapshot(room) {
  return {
    humans: room.humans.map(h => ({ ...h })),
    ready: { ...room.ready },
    cfg: { ...room.cfg },
    started: !!room.started
  };
}

function assignSeat(room) {
  // human seat index is order in humans list
  return room.humans.length;
}

function cleanupRoomIfEmpty(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  if (room.clients.size === 0) rooms.delete(roomCode);
}

wss.on("connection", (ws) => {
  const clientId = uid();
  let joinedRoomCode = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    // JOIN
    if (msg.type === "join") {
      const roomCode = String(msg.room || "").trim();
      const name = String(msg.name || "").trim().slice(0, 24);
      const pw = String(msg.pw || "").trim().slice(0, 48);

      if (!roomCode || !name || !pw) {
        send(ws, { type: "error", message: "Hiányzó adatok (room/name/pw)." });
        return;
      }

      let room = rooms.get(roomCode);
      if (!room) {
        room = makeRoom(roomCode, pw);
        rooms.set(roomCode, room);
      }
      if (room.pw !== pw) {
        send(ws, { type: "error", message: "Hibás jelszó." });
        return;
      }

      joinedRoomCode = roomCode;

      // add client
      if (!room.hostId) room.hostId = clientId;
      const seat = assignSeat(room);

      room.clients.set(clientId, { ws, name, seat, isBot: false });
      room.humans.push({ clientId, name, seat });
      room.ready[clientId] = false;

      send(ws, {
        type: "welcome",
        clientId,
        hostId: room.hostId,
        isHost: room.hostId === clientId,
        seat
      });

      broadcast(room, { type: "lobby", lobby: roomSnapshot(room), hostId: room.hostId });

      // if already started, give current state
      if (room.started && room.state) {
        send(ws, { type: "start", state: room.state });
      }
      return;
    }

    // must be in a room after this
    if (!joinedRoomCode) return;
    const room = rooms.get(joinedRoomCode);
    if (!room) return;

    // GET LOBBY
    if (msg.type === "getLobby") {
      send(ws, { type: "lobby", lobby: roomSnapshot(room), hostId: room.hostId });
      if (room.started && room.state) send(ws, { type: "start", state: room.state });
      return;
    }

    // host change (if needed)
    if (msg.type === "pingHost") {
      send(ws, { type: "hostChanged", hostId: room.hostId });
      return;
    }

    // START / STATE (host authority)
    if (msg.type === "start") {
      if (room.hostId !== clientId) return;
      room.started = true;
      room.state = msg.state || null;
      broadcast(room, { type: "start", state: room.state });
      return;
    }
    if (msg.type === "state") {
      if (room.hostId !== clientId) return;
      room.state = msg.state || null;
      broadcast(room, { type: "state", state: room.state });
      return;
    }

    // INTENTS
    if (msg.type === "intent") {
      const intent = msg.intent;

      if (intent === "ready") {
        room.ready[clientId] = true;
        broadcast(room, { type: "lobby", lobby: roomSnapshot(room), hostId: room.hostId });
        return;
      }
      if (intent === "unready") {
        room.ready[clientId] = false;
        broadcast(room, { type: "lobby", lobby: roomSnapshot(room), hostId: room.hostId });
        return;
      }
      if (intent === "chat") {
        const text = String(msg.text || "").slice(0, 300);
        broadcast(room, { type: "chat", name: room.clients.get(clientId)?.name || "?", text });
        return;
      }
      if (intent === "hostConfig") {
        if (room.hostId !== clientId) return;
        const cfg = msg.cfg || {};
        const bots = Math.max(0, Math.min(10, Number(cfg.bots ?? room.cfg.bots)));
        const stack = Math.max(100, Math.min(100000, Number(cfg.stack ?? room.cfg.stack)));
        const blinds = String(cfg.blinds ?? room.cfg.blinds);
        room.cfg = { bots, stack, blinds };
        broadcast(room, { type: "lobby", lobby: roomSnapshot(room), hostId: room.hostId });
        return;
      }

      // actions are forwarded to host too (so host can run authority logic client-side if wanted)
      // We broadcast as intent to everyone; host listens and applies if it wants.
      if (intent === "action") {
        broadcast(room, { type: "intent", ...msg, from: clientId });
        return;
      }
    }
  });

  ws.on("close", () => {
    if (!joinedRoomCode) return;
    const room = rooms.get(joinedRoomCode);
    if (!room) return;

    const leaving = room.clients.get(clientId);
    room.clients.delete(clientId);
    room.humans = room.humans.filter(h => h.clientId !== clientId);
    delete room.ready[clientId];

    // re-seat humans (compact seats) + update server record
    room.humans.forEach((h, idx) => { h.seat = idx; });

    // host reassign if host left
    if (room.hostId === clientId) {
      room.hostId = room.humans[0]?.clientId || null;
      broadcast(room, { type: "hostChanged", hostId: room.hostId });
    }

    // also update clients’ stored seat (so UI can show correct)
    for (const h of room.humans) {
      const c = room.clients.get(h.clientId);
      if (c) c.seat = h.seat;
    }

    broadcast(room, { type: "lobby", lobby: roomSnapshot(room), hostId: room.hostId });
    cleanupRoomIfEmpty(joinedRoomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("WS server on", PORT));
