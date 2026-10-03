/**
 * Messages between a game client and the lobby (the signalling server that
 * hands out room codes and relays WebRTC offers, answers and ICE candidates).
 * Shared by the browser, the Cloudflare PartyServer worker and the local Node
 * lobby, so it must not import anything browser- or Workers-specific.
 */

export const MAX_CREW = 2;

export interface CrewMember {
  id: string;
  name: string;
  color: number;
  host: boolean;
}

export type ClientMessage =
  | { t: 'hello'; name: string; color: number }
  | { t: 'signal'; to: string; data: SignalData };

export type ServerMessage =
  | { t: 'welcome'; you: CrewMember; crew: CrewMember[]; iceServers: RTCIceServerLike[] }
  | { t: 'joined'; member: CrewMember }
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
      return { t: 'hello', name: m.name.slice(0, 24), color: m.color >>> 0 };
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
 * The lobby's rules for one room, independent of transport: at most two crew,
 * the first to arrive hosts, the host role passes on if the host leaves, and
 * signals are only relayed between members of the same room.
 */
export class LobbyRoom {
  readonly members = new Map<string, CrewMember>();
  private order: string[] = [];
  private readonly outbox: Outbox;
  private readonly iceServers: () => Promise<RTCIceServerLike[]> | RTCIceServerLike[];

  constructor(outbox: Outbox, iceServers: () => Promise<RTCIceServerLike[]> | RTCIceServerLike[]) {
    this.outbox = outbox;
    this.iceServers = iceServers;
  }

  async onMessage(connectionId: string, raw: string): Promise<void> {
    const message = parseClientMessage(raw);
    if (!message) {
      this.outbox.send(connectionId, { t: 'error', message: 'bad message' });
      return;
    }
    if (message.t === 'hello') {
      await this.join(connectionId, message.name, message.color);
    } else if (this.members.has(connectionId) && this.members.has(message.to)) {
      this.outbox.send(message.to, { t: 'signal', from: connectionId, data: message.data });
    }
  }

  private async join(id: string, name: string, color: number): Promise<void> {
    if (this.members.has(id)) {
      return;
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
    this.outbox.send(id, { t: 'welcome', you: member, crew, iceServers: await this.iceServers() });
    for (const other of crew) {
      this.outbox.send(other.id, { t: 'joined', member });
    }
  }

  onClose(connectionId: string): void {
    const member = this.members.get(connectionId);
    if (!member) {
      return;
    }
    this.members.delete(connectionId);
    this.order = this.order.filter((id) => id !== connectionId);
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

/** Free STUN only; TURN is added by the deployed lobby when configured. */
export const DEFAULT_ICE_SERVERS: RTCIceServerLike[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];
