// server.js — AUTHORITATIVE v2 (FINAL)
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

function send(ws, obj){
  if(ws.readyState === WebSocket.OPEN){
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(room, obj){
  for(const ws of room.clients.values()) send(ws, obj);
}

function makeRoom(pw){
  return {
    pw,
    clients: new Map(),
    humans: [],
    ready: {},
    hostId: null,
    started: false,
    state: null
  };
}

wss.on("connection", ws => {
  ws.id = Math.random().toString(36).slice(2);
  ws.room = null;

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    /* JOIN */
    if(msg.type === "join"){
      const { room, name, pw } = msg;
      if(!room || !name || !pw) return;

      let r = rooms.get(room);
      if(!r){
        r = makeRoom(pw);
        rooms.set(room, r);
      }
      if(r.pw !== pw) return;

      ws.room = room;
      r.clients.set(ws.id, ws);

      const seat = r.humans.length;
      r.humans.push({ id: ws.id, name, seat });
      r.ready[ws.id] = false;
      if(!r.hostId) r.hostId = ws.id;

      send(ws, { type:"welcome", clientId: ws.id, hostId: r.hostId, seat });
      broadcast(r, { type:"lobby", lobby: r });
      return;
    }

    const r = rooms.get(ws.room);
    if(!r) return;

    /* READY */
    if(msg.type === "intent" && msg.intent === "ready"){
      r.ready[ws.id] = true;
      broadcast(r, { type:"lobby", lobby: r });
    }
    if(msg.type === "intent" && msg.intent === "unready"){
      r.ready[ws.id] = false;
      broadcast(r, { type:"lobby", lobby: r });
    }

    /* START GAME */
    if(msg.type === "intent" && msg.intent === "startGame"){
      if(ws.id !== r.hostId) return;
      if(!r.humans.every(h => r.ready[h.id])) return;

      r.started = true;
      r.state = {
        handNo: 1,
        street: "PREFLOP",
        pot: 0,
        currentBet: 0,
        toAct: 0,
        players: r.humans.map(h => ({
          id: h.id,
          name: h.name,
          stack: 1000,
          bet: 0,
          folded: false,
          hand: []
        }))
      };
      broadcast(r, { type:"state", state: r.state });
    }

    /* PLAYER ACTION */
    if(msg.type === "intent" && msg.intent === "action"){
      if(!r.state) return;
      const p = r.state.players.find(p => p.id === ws.id);
      if(!p) return;

      if(msg.action === "fold") p.folded = true;
      if(msg.action === "call"){
        const need = r.state.currentBet - p.bet;
        p.stack -= need;
        p.bet += need;
        r.state.pot += need;
      }
      if(msg.action === "raise"){
        const to = Number(msg.amount||0);
        const diff = to - p.bet;
        if(diff > 0){
          p.stack -= diff;
          p.bet = to;
          r.state.currentBet = to;
          r.state.pot += diff;
        }
      }

      r.state.toAct = (r.state.toAct + 1) % r.state.players.length;
      broadcast(r, { type:"state", state: r.state });
    }
  });

  ws.on("close", ()=>{
    const r = rooms.get(ws.room);
    if(!r) return;
    r.clients.delete(ws.id);
    r.humans = r.humans.filter(h => h.id !== ws.id);
    delete r.ready[ws.id];
    if(r.hostId === ws.id) r.hostId = r.humans[0]?.id ?? null;
    if(r.clients.size === 0) rooms.delete(ws.room);
    else broadcast(r, { type:"lobby", lobby: r });
  });
});

server.listen(PORT, ()=>console.log("Server on", PORT));
