/**
 * Messages between a game client and the lobby (the signalling server that
 * hands out room codes and relays WebRTC offers, answers and ICE candidates).
 * Shared by the browser, the Cloudflare PartyServer worker and the local Node
 * lobby, so it must not import anything browser- or Workers-specific.
 */

export const MAX_CREW = 2;
/** Longest message a client may send; an offer with every codec is a few KB. */
export const MAX_MESSAGE_LENGTH = 16 * 1024;
/**
 * Messages a connection may send per minute. A connection negotiates with a
 * few dozen candidates and pings twice a minute; anything near this is a flood.
 */
export const MAX_MESSAGES_PER_MINUTE = 300;

export interface CrewMember {
  id: string;
  name: string;
  color: number;
  host: boolean;
}

export type ClientMessage =
  /**
   * `player` is a random key the page keeps for its whole life, so a player
   * rejoining after a network drop replaces their own stale connection
   * instead of finding the room full.
   */
  | { t: 'hello'; name: string; color: number; player?: string }
  | { t: 'signal'; to: string; data: SignalData }
  /** Keeps the lobby connection from looking idle while the players are connected directly. */
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'welcome'; you: CrewMember; crew: CrewMember[]; iceServers: RTCIceServerLike[] }
  /** `iceServers` replaces the ones from `welcome`: TURN is only handed out once there are two players. */
  | { t: 'joined'; member: CrewMember; iceServers?: RTCIceServerLike[] }
  | { t: 'left'; id: string; newHost: string | null }
  | { t: 'signal'; from: string; data: SignalData }
  | { t: 'full' }
  | { t: 'error'; message: string };

export type SignalData =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

export interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Free STUN only; TURN is added by the deployed lobby when configured. */
export const DEFAULT_ICE_SERVERS: RTCIceServerLike[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/** Room codes: four letters without easily confused ones (no I, L, O). */
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

export function makeRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_LETTERS[Math.floor(random() * CODE_LETTERS.length)];
  }
  return code;
}

export function normaliseRoomCode(input: string): string | null {
  const code = input.trim().toUpperCase();
  return /^[A-Z]{4}$/.test(code) ? code : null;
}

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const m = JSON.parse(raw);
    if (m?.t === 'hello' && typeof m.name === 'string' && typeof m.color === 'number') {
      const player = typeof m.player === 'string' && m.player.length > 0 ? m.player.slice(0, 32) : undefined;
      return { t: 'hello', name: m.name.slice(0, 24), color: m.color >>> 0, player };
    }
    if (m?.t === 'ping') {
      return { t: 'ping' };
    }
    if (m?.t === 'signal' && typeof m.to === 'string' && m.data && typeof m.data.kind === 'string') {
      return { t: 'signal', to: m.to, data: m.data };
    }
  } catch {
    // ignore
  }
  return null;
}

export interface Outbox {
  send(connectionId: string, message: ServerMessage): void;
  close(connectionId: string): void;
}

/**
 * The ICE servers for a crew of two, asked for when the second player joins.
 * `connectionId` is the player who just joined.
 */
export type IceServersSource = (connectionId: string) => Promise<RTCIceServerLike[]> | RTCIceServerLike[];

/**
 * The lobby's rules for one room, independent of transport: at most two crew,
 * the first to arrive hosts, the host role passes on if the host leaves, and
 * signals are only relayed between members of the same room. A player alone
 * in a room gets free STUN only; relay (TURN) servers, which cost money per
 * gigabyte, are asked for once a crewmate is there to connect to. Oversized
 * messages and floods close the connection.
 */
export class LobbyRoom {
  readonly members = new Map<string, CrewMember>();
  private order: string[] = [];
  /** Connection id of each member's player key. */
  private players = new Map<string, string>();
  /** Messages each connection sent in its current one-minute window. */
  private traffic = new Map<string, { since: number; count: number }>();
  private readonly outbox: Outbox;
  private readonly iceServers: IceServersSource;
  private readonly now: () => number;

  constructor(outbox: Outbox, iceServers: IceServersSource, now: () => number = Date.now) {
    this.outbox = outbox;
    this.iceServers = iceServers;
    this.now = now;
  }

  async onMessage(connectionId: string, raw: string): Promise<void> {
    if (this.overLimit(connectionId, raw)) {
      this.onClose(connectionId);
      this.outbox.close(connectionId);
      return;
    }
    const message = parseClientMessage(raw);
    if (!message) {
      this.outbox.send(connectionId, { t: 'error', message: 'bad message' });
      return;
    }
    if (message.t === 'ping') {
      return;
    }
    if (message.t === 'hello') {
      await this.join(connectionId, message.name, message.color, message.player);
    } else if (this.members.has(connectionId) && this.members.has(message.to)) {
      this.outbox.send(message.to, { t: 'signal', from: connectionId, data: message.data });
    }
  }

  private overLimit(connectionId: string, raw: string): boolean {
    if (raw.length > MAX_MESSAGE_LENGTH) {
      return true;
    }
    const now = this.now();
    let window = this.traffic.get(connectionId);
    if (!window || now - window.since >= 60_000) {
      window = { since: now, count: 0 };
      this.traffic.set(connectionId, window);
    }
    return ++window.count > MAX_MESSAGES_PER_MINUTE;
  }

  private async join(id: string, name: string, color: number, player?: string): Promise<void> {
    if (this.members.has(id)) {
      return;
    }
    const stale = player !== undefined ? this.players.get(player) : undefined;
    if (stale !== undefined && stale !== id) {
      // The same player again on a new connection: their old one is dead.
      this.onClose(stale);
      this.outbox.close(stale);
    }
    if (this.members.size >= MAX_CREW) {
      this.outbox.send(id, { t: 'full' });
      this.outbox.close(id);
      return;
    }
    const member: CrewMember = { id, name, color, host: this.members.size === 0 };
    const crew = [...this.members.values()];
    this.members.set(id, member);
    this.order.push(id);
    if (player !== undefined) {
      this.players.set(player, id);
    }
    const iceServers = crew.length > 0 ? await this.iceServers(id) : DEFAULT_ICE_SERVERS;
    if (this.members.get(id) !== member) {
      return; // left while the servers were being fetched
    }
    // The crewmate may have left meanwhile; tell the newcomer who is here now.
    const others = [...this.members.values()].filter((m) => m.id !== id);
    this.outbox.send(id, { t: 'welcome', you: member, crew: others, iceServers });
    for (const other of others) {
      this.outbox.send(other.id, { t: 'joined', member, iceServers });
    }
  }

  onClose(connectionId: string): void {
    this.traffic.delete(connectionId);
    const member = this.members.get(connectionId);
    if (!member) {
      return;
    }
    this.members.delete(connectionId);
    this.order = this.order.filter((id) => id !== connectionId);
    for (const [player, id] of this.players) {
      if (id === connectionId) {
        this.players.delete(player);
      }
    }
    let newHost: string | null = null;
    if (member.host && this.order.length > 0) {
      const next = this.members.get(this.order[0])!;
      next.host = true;
      newHost = next.id;
    }
    for (const other of this.members.values()) {
      this.outbox.send(other.id, { t: 'left', id: connectionId, newHost });
    }
  }
}

