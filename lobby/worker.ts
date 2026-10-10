/**
 * The deployed lobby: a Cloudflare Worker with one PartyServer Durable Object
 * per room code. It runs the same LobbyRoom rules as the local dev lobby and,
 * when TURN is configured, gives each crew of two short-lived Cloudflare TURN
 * credentials so connections behind strict NATs can still be relayed.
 *
 * TURN is the one part of the lobby that is billed per gigabyte, so
 * credentials only go to rooms with two players, a room reuses its
 * credentials for an hour, and a TurnBudget Durable Object caps how many are
 * made per day, in total and per IP address. Past the cap players get free
 * STUN only, which works on most home networks.
 *
 * Deploy: see lobby/README.md.
 */
import { DurableObject } from 'cloudflare:workers';
import { type Connection, type ConnectionContext, routePartykitRequest, Server } from 'partyserver';
import { DEFAULT_ICE_SERVERS, LobbyRoom, type RTCIceServerLike } from '../src/net/lobby-protocol.js';

interface Env {
  Lobby: DurableObjectNamespace<Lobby>;
  TurnBudget: DurableObjectNamespace<TurnBudget>;
  /** Cloudflare Realtime TURN key id and API token (optional secrets). */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Comma-separated origins allowed to connect, e.g. https://henderjj.github.io */
  ALLOWED_ORIGINS?: string;
  /** Most TURN credentials made per UTC day, in total and for one IP address. */
  TURN_CREDENTIALS_PER_DAY?: string;
  TURN_CREDENTIALS_PER_IP_PER_DAY?: string;
}

/** How long TURN credentials last. A relayed connection is cut when they expire. */
const TURN_TTL_S = 6 * 60 * 60;
/** A room hands its credentials to rejoining players for this long, then makes new ones. */
const TURN_REUSE_MS = 60 * 60 * 1000;

/** The only path the game connects to: the lobby party and a four-letter room code. */
const ROOM_PATH = /^\/parties\/lobby\/[A-Z]{4}$/;

async function generateTurnServers(env: Env): Promise<RTCIceServerLike[] | null> {
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TURN_TTL_S }),
      },
    );
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { iceServers: RTCIceServerLike | RTCIceServerLike[] };
    return Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
  } catch {
    return null;
  }
}

function limit(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * One instance for the whole lobby, counting the TURN credentials made today.
 * The counts live in its storage and are wiped when the UTC day changes.
 */
export class TurnBudget extends DurableObject<Env> {
  /** Spend one credential for `ip` if today's limits allow it. */
  async take(ip: string): Promise<boolean> {
    const perDay = limit(this.env.TURN_CREDENTIALS_PER_DAY, 30);
    const perIp = limit(this.env.TURN_CREDENTIALS_PER_IP_PER_DAY, 8);
    const storage = this.ctx.storage;
    const today = new Date().toISOString().slice(0, 10);
    if ((await storage.get<string>('day')) !== today) {
      await storage.deleteAll();
      await storage.put('day', today);
    }
    const total = (await storage.get<number>('total')) ?? 0;
    const ipKey = `ip:${ip}`;
    const forIp = (await storage.get<number>(ipKey)) ?? 0;
    if (total >= perDay || forIp >= perIp) {
      return false;
    }
    await storage.put({ total: total + 1, [ipKey]: forIp + 1 });
    return true;
  }
}

export class Lobby extends Server<Env> {
  // Rooms live for one session and hold their state in memory.
  static options = { hibernate: false };

  /** Each connection's IP address, for the per-IP TURN limit. */
  private ips = new Map<string, string>();
  private turn: { servers: RTCIceServerLike[]; madeAt: number } | null = null;

  private room = new LobbyRoom(
    {
      send: (id, message) => this.getConnection(id)?.send(JSON.stringify(message)),
      close: (id) => this.getConnection(id)?.close(),
    },
    (id) => this.iceServersFor(id),
  );

  private async iceServersFor(connectionId: string): Promise<RTCIceServerLike[]> {
    if (!this.env.TURN_KEY_ID || !this.env.TURN_KEY_API_TOKEN) {
      return DEFAULT_ICE_SERVERS;
    }
    if (this.turn && Date.now() - this.turn.madeAt < TURN_REUSE_MS) {
      return this.turn.servers;
    }
    const budget = this.env.TurnBudget.get(this.env.TurnBudget.idFromName('global'));
    if (!(await budget.take(this.ips.get(connectionId) ?? 'unknown'))) {
      return DEFAULT_ICE_SERVERS;
    }
    const servers = await generateTurnServers(this.env);
    if (!servers) {
      return DEFAULT_ICE_SERVERS;
    }
    this.turn = { servers, madeAt: Date.now() };
    return servers;
  }

  onConnect(connection: Connection, ctx: ConnectionContext): void {
    this.ips.set(connection.id, ctx.request.headers.get('CF-Connecting-IP') ?? 'unknown');
  }

  onMessage(connection: Connection, message: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    return this.room.onMessage(connection.id, typeof message === 'string' ? message : '');
  }

  onClose(connection: Connection): void {
    this.ips.delete(connection.id);
    this.room.onClose(connection.id);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Turn away anything that isn't the game joining a room before it can
    // wake a Durable Object. A script can fake the Origin header, so this only
    // stops other web pages and casual misuse; the limits above do the rest.
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin');
    if (allowed.length > 0 && (!origin || !allowed.includes(origin))) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!ROOM_PATH.test(new URL(request.url).pathname)) {
      return new Response('Patchwork Airship lobby', { status: 404 });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket', { status: 426 });
    }
    return (await routePartykitRequest(request, env)) ?? new Response('Patchwork Airship lobby', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
