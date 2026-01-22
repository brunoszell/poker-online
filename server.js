// server.js
// npm i ws
// node server.js

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 10; // max 10 EMBER / szoba
const HEARTBEAT_MS = 30000; // 30s ping (Render/proxy miatt hasznos)
const MAX_PLAYERS = 10;
const HEARTBEAT_MS = 30000;

const server = http.createServer((req, res) => {
  // egyszeru health endpoint (Rendernek is jol jon)
res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
res.end("Poker WS server running.\n");
});

const wss = new WebSocket.Server({ server });

function rid() {
return (
Math.random().toString(36).slice(2, 10) +
Math.random().toString(36).slice(2, 10)
);
}

const rooms = new Map();

function send(ws, obj) {
if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(roomName, obj) {
const r = rooms.get(roomName);
if (!r) return;
for (const ws of r.clients.values()) send(ws, obj);
}

function lobbyPayload(r) {
return { humans: r.humans, ready: r.ready, cfg: r.cfg, started: r.started };
}

function findSeat(r, clientId) {
const h = r.humans.find((x) => x.clientId === clientId);
return h ? h.seat : null;
}

function ensureHost(r) {
if (r.hostId && r.clients.has(r.hostId)) return;
r.hostId = r.humans[0]?.clientId ?? null;
}

// ===== Ping/Pong heartbeat (proxy idle disconnect ellen) =====
function heartbeat() {
  this.isAlive = true;
}

// heartbeat
function heartbeat() { this.isAlive = true; }
const interval = setInterval(() => {
for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      continue;
    }
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
ws.isAlive = false;
try { ws.ping(); } catch {}
}
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(interval));

// ===== WebSocket events =====
wss.on("connection", (ws) => {
const clientId = rid();
ws._id = clientId;
ws._room = null;

ws.isAlive = true;
ws.on("pong", heartbeat);

  // (opcionalis) log
  console.log("WS kapcsolat:", clientId);

ws.on("message", (buf) => {
let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // ===== JOIN =====
    // JOIN
if (msg.type === "join") {
const { room, name, pw } = msg;

if (!room || !name || !pw) {
return send(ws, { type: "error", message: "Hiányzó belépési adat." });
}

let r = rooms.get(room);
if (!r) {
r = {
pw,
hostId: clientId,
clients: new Map(),
humans: [],
ready: {},
cfg: { bots: 2, stack: 1000, blinds: "10,20" },
started: false,
};
rooms.set(room, r);
        console.log(`Szoba létrehozva: ${room}`);
} else if (r.pw !== pw) {
return send(ws, { type: "error", message: "Rossz jelszó." });
}

if (r.humans.length >= MAX_PLAYERS) {
return send(ws, { type: "error", message: "Tele van az asztal (max 10 fő)." });
}

r.clients.set(clientId, ws);
ws._room = room;

const seat = r.humans.length;
r.humans.push({ clientId, name, seat });
r.ready[clientId] = false;

ensureHost(r);

      console.log(`Belépett: ${name} (${clientId}) szoba=${room} seat=${seat} host=${r.hostId}`);

send(ws, { type: "welcome", clientId, hostId: r.hostId, seat });
broadcast(room, { type: "lobby", lobby: lobbyPayload(r), hostId: r.hostId });
return;
}

    // ===== MUST HAVE ROOM =====
const room = ws._room;
if (!room) return;
const r = rooms.get(room);
if (!r) return;

if (msg.type === "getLobby") {
send(ws, { type: "lobby", lobby: lobbyPayload(r), hostId: r.hostId });
return;
}

    // host snapshots
if (msg.type === "start") {
if (ws._id !== r.hostId) return;
r.started = true;
broadcast(room, { type: "start", state: msg.state });
return;
}

if (msg.type === "state") {
if (ws._id !== r.hostId) return;
broadcast(room, { type: "state", state: msg.state });
return;
}

if (msg.type === "intent") {
if (msg.intent === "ready") r.ready[ws._id] = true;
if (msg.intent === "unready") r.ready[ws._id] = false;

      // ✅ HOST CONFIG MOST MÁR BÁRMIKOR: a következő új játék/leosztás ezt fogja használni
if (msg.intent === "hostConfig") {
if (ws._id !== r.hostId) return;
        if (r.started) return;
if (msg.cfg && typeof msg.cfg === "object") {
const bots = Math.max(0, Math.min(10, Number(msg.cfg.bots ?? r.cfg.bots)));
const stack = Math.max(100, Math.min(50000, Number(msg.cfg.stack ?? r.cfg.stack)));
const blinds = String(msg.cfg.blinds ?? r.cfg.blinds);
r.cfg = { bots, stack, blinds };
}
}

if (msg.intent === "chat") {
const text = String(msg.text || "").slice(0, 300);
const who = r.humans.find((h) => h.clientId === ws._id)?.name || "Ismeretlen";
broadcast(room, { type: "chat", name: who, text, at: Date.now() });
}

      // forward hostnak
const hostWs = r.clients.get(r.hostId);
if (hostWs) {
send(hostWs, {
type: "intent",
from: ws._id,
seat: findSeat(r, ws._id),
intent: msg.intent,
action: msg.action,
amount: msg.amount,
cfg: msg.cfg,
text: msg.text,
});
}

broadcast(room, { type: "lobby", lobby: lobbyPayload(r), hostId: r.hostId });
return;
}
});

ws.on("close", () => {
const room = ws._room;
if (!room) return;
const r = rooms.get(room);
if (!r) return;

r.clients.delete(ws._id);
delete r.ready[ws._id];
r.humans = r.humans.filter((h) => h.clientId !== ws._id);

const oldHost = r.hostId;
ensureHost(r);
if (oldHost !== r.hostId) broadcast(room, { type: "hostChanged", hostId: r.hostId });

    console.log(`Kilépett: ${ws._id} szoba=${room} (host most: ${r.hostId})`);

    if (r.clients.size === 0) {
      rooms.delete(room);
      console.log(`Szoba törölve (üres): ${room}`);
    } else {
      broadcast(room, { type: "lobby", lobby: lobbyPayload(r), hostId: r.hostId });
    }
    if (r.clients.size === 0) rooms.delete(room);
    else broadcast(room, { type: "lobby", lobby: lobbyPayload(r), hostId: r.hostId });
});
});

server.listen(PORT, () => console.log("WS szerver figyel a porton:", PORT));
