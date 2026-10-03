/**
 * The deployed lobby: a Cloudflare Worker with one PartyServer Durable Object
 * per room code. It runs the same LobbyRoom rules as the local dev lobby and,
 * when TURN is configured, gives each player short-lived Cloudflare TURN
 * credentials so connections behind strict NATs can still be relayed.
 *
 * Deploy: see lobby/README.md.
 */
import { type Connection, routePartykitRequest, Server } from 'partyserver';
import { DEFAULT_ICE_SERVERS, LobbyRoom, type RTCIceServerLike } from '../src/net/lobby-protocol.js';

interface Env {
  Lobby: DurableObjectNamespace<Lobby>;
  /** Cloudflare Realtime TURN key id and API token (optional secrets). */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Comma-separated origins allowed to connect, e.g. https://henderjj.github.io */
  ALLOWED_ORIGINS?: string;
}

async function iceServersFor(env: Env): Promise<RTCIceServerLike[]> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return DEFAULT_ICE_SERVERS;
  }
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 6 * 60 * 60 }),
      },
    );
    if (!response.ok) {
      return DEFAULT_ICE_SERVERS;
    }
    const body = (await response.json()) as { iceServers: RTCIceServerLike | RTCIceServerLike[] };
    return Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
}

export class Lobby extends Server<Env> {
  // Rooms live for one session and hold their state in memory.
  static options = { hibernate: false };

  private room = new LobbyRoom(
    {
      send: (id, message) => this.getConnection(id)?.send(JSON.stringify(message)),
      close: (id) => this.getConnection(id)?.close(),
    },
    () => iceServersFor(this.env),
  );

  onMessage(connection: Connection, message: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    return this.room.onMessage(connection.id, typeof message === 'string' ? message : '');
  }

  onClose(connection: Connection): void {
    this.room.onClose(connection.id);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (origin && allowed.length > 0 && !allowed.includes(origin)) {
      return new Response('Forbidden', { status: 403 });
    }
    return (await routePartykitRequest(request, env)) ?? new Response('Patchwork Airship lobby', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
