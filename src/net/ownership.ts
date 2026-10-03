/**
 * Who simulates each loose object (spike S7). The owner runs the object in
 * its own physics and sends its state; the other player draws it from those
 * packets. Ownership follows the hand: whoever grabs or catches an object
 * owns it from that moment, and keeps it after throwing it until someone
 * else takes it.
 *
 * The host decides races. The host's own grabs take effect at once. The
 * guest's grabs also take effect at once on the guest (so a catch feels
 * instant) and are confirmed or refused by the host; a refusal only happens
 * when the host took the object first, and the guest's hand then lets go.
 *
 * Each change of owner bumps the object's epoch (0–255, wrapping), and every
 * state packet carries the epoch it was sent under, so packets sent before a
 * hand-over are recognised and dropped. A guest claim predicts the epoch the
 * host will grant (one more than it knows), so its packets are accepted as
 * soon as the host has granted the claim.
 *
 * Pure TypeScript, no allocation after construction apart from the events it
 * sends.
 */

export const HOST = 0;
export const GUEST = 1;

export interface ClaimEvent {
  t: 'claim';
  id: number;
  /** The epoch the guest claimed under (the one it predicts the host will grant). */
  epoch: number;
}

export interface OwnEvent {
  t: 'own';
  id: number;
  owner: number;
  epoch: number;
}

export type OwnershipEvent = ClaimEvent | OwnEvent;

export interface OwnState {
  owner: number;
  epoch: number;
  /** Guest only: claimed and waiting for the host's answer. */
  pending: boolean;
  /** The crewmate held it in their latest accepted packet. */
  remoteHeld: boolean;
}

/** What a call did to this player's ownership of the object. */
export const Change = { None: 0, Gained: 1, Lost: 2 } as const;
export type Change = (typeof Change)[keyof typeof Change];

/** Packet verdicts from acceptState. */
export const Accept = { Drop: 0, Use: 1, UseAndLost: 2 } as const;
export type Accept = (typeof Accept)[keyof typeof Accept];

export function epochNewer(a: number, b: number): boolean {
  const d = (a - b) & 0xff;
  return d !== 0 && d < 0x80;
}

export class Ownership {
  readonly objects: OwnState[] = [];
  /** HOST or GUEST. */
  me = HOST;
  /** Guest claims refused by the host so far. */
  refused = 0;

  constructor(
    count: number,
    private readonly send: (event: OwnershipEvent) => void,
  ) {
    for (let i = 0; i < count; i++) {
      this.objects.push({ owner: HOST, epoch: 0, pending: false, remoteHeld: false });
    }
  }

  /** A new session (or none): the host owns everything again. */
  reset(me: number): void {
    this.me = me;
    for (const o of this.objects) {
      o.owner = HOST;
      o.epoch = 0;
      o.pending = false;
      o.remoteHeld = false;
    }
  }

  owns(id: number): boolean {
    return this.objects[id].owner === this.me;
  }

  /**
   * A local hand takes the object. Returns false (and changes nothing) if the
   * crewmate is holding it.
   */
  grab(id: number): boolean {
    const o = this.objects[id];
    if (o.owner === this.me && this.me === GUEST) {
      return true;
    }
    if (o.owner !== this.me && o.remoteHeld) {
      return false;
    }
    if (this.me === HOST) {
      // Every host grab moves the epoch on, even of an object it already
      // owns, so a guest claim made before it (on an older view) is refused.
      o.owner = HOST;
      o.epoch = (o.epoch + 1) & 0xff;
      this.send({ t: 'own', id, owner: HOST, epoch: o.epoch });
    } else {
      o.owner = GUEST;
      o.epoch = (o.epoch + 1) & 0xff;
      o.pending = true;
      this.send({ t: 'claim', id, epoch: o.epoch });
    }
    return true;
  }

  /**
   * Host: the guest claims an object. `heldHere` says whether a host hand
   * holds it. Returns Lost when the claim is granted.
   */
  onClaim(id: number, epoch: number, heldHere: boolean): Change {
    const o = this.objects[id];
    if (this.me !== HOST || !o) {
      return Change.None;
    }
    if (o.owner === HOST && epoch === ((o.epoch + 1) & 0xff) && !heldHere) {
      o.owner = GUEST;
      o.epoch = epoch;
      o.remoteHeld = true;
      this.send({ t: 'own', id, owner: GUEST, epoch });
      return Change.Lost;
    }
    // Refused (the host took it first or holds it), or a duplicate: restate the truth.
    this.send({ t: 'own', id, owner: o.owner, epoch: o.epoch });
    return Change.None;
  }

  /** Guest: the host announced an owner. */
  onOwn(id: number, owner: number, epoch: number): Change {
    const o = this.objects[id];
    if (this.me !== GUEST || !o) {
      return Change.None;
    }
    if (o.pending) {
      if (owner === GUEST) {
        if (epoch === o.epoch) {
          o.pending = false; // confirmed
        }
        return Change.None;
      }
      // Refused: the host had it first.
      o.pending = false;
      o.owner = owner;
      o.epoch = epoch;
      o.remoteHeld = false;
      this.refused++;
      return Change.Lost;
    }
    if (!epochNewer(epoch, o.epoch)) {
      return Change.None; // stale
    }
    const before = o.owner;
    o.owner = owner;
    o.epoch = epoch;
    if (before === GUEST && owner === HOST) {
      return Change.Lost;
    }
    if (before === HOST && owner === GUEST) {
      return Change.Gained;
    }
    return Change.None;
  }

  /**
   * A state packet arrived from the crewmate under `epoch`; `held` is its held
   * flag. Says whether to use it, and whether it means this player has lost
   * the object (the host took it and its packet beat the announcement).
   */
  acceptState(id: number, epoch: number, held: boolean): Accept {
    const o = this.objects[id];
    if (!o) {
      return Accept.Drop;
    }
    const peer = 1 - this.me;
    if (o.owner === peer && o.epoch === epoch) {
      o.remoteHeld = held;
      return Accept.Use;
    }
    if (this.me === GUEST && !o.pending && epochNewer(epoch, o.epoch)) {
      const lost = o.owner === GUEST;
      o.owner = HOST;
      o.epoch = epoch;
      o.remoteHeld = held;
      return lost ? Accept.UseAndLost : Accept.Use;
    }
    return Accept.Drop;
  }
}
