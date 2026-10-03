/**
 * Local lobby for development and automated tests: the same LobbyRoom rules as
 * the Cloudflare worker, served over plain WebSockets on port 8787 at
 * /parties/lobby/<ROOM>. The Vite dev server proxies /parties here, so pages
 * served over HTTPS (and headsets on the LAN) can reach it.
 *
 *   node --experimental-strip-types lobby/dev-server.ts [port]
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_ICE_SERVERS, LobbyRoom } from '../src/net/lobby-protocol.ts';

const port = Number(process.argv[2] ?? process.env.LOBBY_PORT ?? 8787);
const rooms = new Map<string, { room: LobbyRoom; sockets: Map<string, WebSocket> }>();

function getRoom(code: string) {
  let entry = rooms.get(code);
  if (!entry) {
    const sockets = new Map<string, WebSocket>();
    const room = new LobbyRoom(
      {
        send: (id, message) => sockets.get(id)?.send(JSON.stringify(message)),
        close: (id) => sockets.get(id)?.close(),
      },
      () => DEFAULT_ICE_SERVERS,
    );
    entry = { room, sockets };
    rooms.set(code, entry);
  }
  return entry;
}

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('patchwork lobby\n');
});
const wss = new WebSocketServer({ server });

wss.on('connection', (socket, request) => {
  const match = /^\/parties\/lobby\/([A-Za-z]{4})/.exec(request.url ?? '');
  if (!match) {
    socket.close(1008, 'bad room');
    return;
  }
  const code = match[1].toUpperCase();
  const entry = getRoom(code);
  const id = randomUUID();
  entry.sockets.set(id, socket);
  socket.on('message', (data) => void entry.room.onMessage(id, data.toString()));
  socket.on('close', () => {
    entry.sockets.delete(id);
    entry.room.onClose(id);
    if (entry.sockets.size === 0) {
      rooms.delete(code);
    }
  });
});

server.listen(port, () => console.log(`lobby listening on ws://localhost:${port}/parties/lobby/<ROOM>`));
