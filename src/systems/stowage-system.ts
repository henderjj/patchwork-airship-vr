import { createSystem, type Mesh, Vector3 } from '@iwsdk/core';
import {
  CRATE_HANDS_PACKET_BYTES,
  CRATES_PACKET_BYTES,
  createCrateHandsPacket,
  createCratesPacket,
  decodeCrateHands,
  decodeCrates,
  encodeCrateHands,
  encodeCrates,
  PacketType,
} from '../net/pose-codec.js';
import { createCrate } from '../scene-assets/cargo.scene-asset.js';
import { CRATE_HEIGHT } from '../sim/cargo.js';
import { CRATE_STATES, type CrateHand, type CrateState, handleAt, HANDLE_SLIP } from '../sim/stowage.js';
import { cargoGround } from '../world/route-world.js';
import { sounds } from './audio-system.js';
import { buzz } from './haptics.js';
import { grip, handUse } from './grip-system.js';
import { HoldKind, lockResolvers } from './hand-lock.js';
import { FLAG_LEFT_CRANK, FLAG_LEFT_ROPE, FLAG_RIGHT_CRANK, FLAG_RIGHT_ROPE, netLink } from './net-system.js';
import { cargo, flightInfo, ship, yard } from './ship-system.js';

/**
 * Cargo loading (Phase 3, docs/cargo.md): the crates carried by hand.
 * Squeeze near a crate's rope handle to take it: one hand drags the crate
 * across what it stands on, a hand on each handle lifts it (slowly alone,
 * easily with the crewmate on the other handle). Lift them off the loading
 * stage on island A over the rail, set one down in the hatch (the hook
 * must be wound up into it and the door shut) and stow the other on deck;
 * at island B, once the first is lowered and the hook wound back up, lift
 * the other into the hatch.
 *
 * The host (or a solo page) runs the crates (src/sim/stowage.ts) with both
 * players' hands and sends them 30 times a second; the guest sends where
 * its hands are on which handles, draws the crates as the host has them,
 * and runs ahead with a crate it carries alone by both handles so it keeps
 * up with its hands. A guest's hand the host hasn't put on its handle soon
 * after taking it (the crewmate took that handle first) lets go.
 *
 * Feedback: a pulse on taking a handle, a buzz that grows as the crate
 * lags the hands (it is heavy; past HANDLE_SLIP it slips out of them), and
 * a thump and a jolt in the hands when one lands hard.
 */

const SIDES = ['left', 'right'] as const;
type Side = (typeof SIDES)[number];
const SEND_HZ = 30;
/** A guest's hands older than this are let go of, ms. */
const GUEST_HANDS_MS = 400;
/**
 * The guest's hands reach the host a moment late, so on the host they trail
 * a crate the two carry by about the crate's speed times that delay: they
 * slip off only this much further from their handles than the host's, m.
 */
const GUEST_SLIP = 0.2;
/** The guest lets go of a handle the host hasn't given it this long after taking it, ms. */
const CONFIRM_MS = 600;
/** The hands feel the crate's weight as a buzz this often, ms, from this far behind the hands, m. */
const STRAIN_EVERY_MS = 120;
const STRAIN_FROM = 0.08;
/** This player's crew index: 0 the host or a solo player, 1 the guest. */
const crewIndex = (): number => (netLink.connected && !netLink.isHost ? 1 : 0);

/** A scripted hand (tests, the practice crewmate): which crate and handle, where it is (ship space), and optionally whose (crew index; this player's by default). */
export interface ScriptHand {
  crate: number;
  handle: number;
  x: number;
  y: number;
  z: number;
  crew?: number;
}
export type HandScript = (nowMs: number) => ScriptHand[] | null;

interface CratesDebug {
  state(): {
    crates: { state: CrateState; pos: [number, number, number]; yaw: number; condition: number; holders: [number, number] }[];
    hatch: number;
    aboard: number;
    knocks: number;
    held: Record<Side, [number, number] | null>;
  };
  /** Where a hand takes crate `i`'s handle `handle` now (ship space). */
  grabPoint(i: number, handle: number): [number, number, number];
  /** Scripted hands on handles: a function of the time giving them each frame (empty for none), or null to stop. */
  setHands(script: HandScript | null): void;
}

export class StowageSystem extends createSystem({}) {
  private meshes: Mesh[] = [];
  /** Which handle each of this player's hands holds ([crate, handle]), and when it took it. */
  private held: Record<Side, [number, number] | null> = { left: null, right: null };
  private heldAt: Record<Side, number> = { left: 0, right: 0 };
  private script: HandScript | null = null;
  private scripted: ScriptHand[] = [];
  private seenResets = -1;
  private heardKnocks = 0;
  private lastStrain = 0;

  /** The hands on handles this frame, and whose each is: a side, the script's, or the guest's. */
  private hands: CrateHand[] = [];
  private handOwner: (Side | 'script' | 'guest')[] = [];
  private pool: CrateHand[] = [];

  private hostState = createCratesPacket();
  private hostFresh = false;
  private hostAt = Number.NEGATIVE_INFINITY;
  private outState = createCratesPacket();
  private sendBuffer = new ArrayBuffer(CRATES_PACKET_BYTES);
  private guestHands = createCrateHandsPacket();
  private guestHandsAt = Number.NEGATIVE_INFINITY;
  private outHands = createCrateHandsPacket();
  private handsBuffer = new ArrayBuffer(CRATE_HANDS_PACKET_BYTES);
  private sendAccumulator = 0;

  private handPos = new Vector3();
  private pose = { x: 0, y: 0, z: 0, yaw: 0 };
  private tmp = { x: 0, y: 0, z: 0 };

  init(): void {
    for (let i = 0; i < yard.crates.length; i++) {
      const mesh = createCrate();
      mesh.name = `Crate ${i + 1}`;
      this.world.createTransformEntity(mesh);
      this.meshes.push(mesh);
    }
    for (let i = 0; i < 4; i++) {
      this.pool.push({ crate: -1, handle: 0, crew: 0, x: 0, y: 0, z: 0, slip: HANDLE_SLIP });
    }

    netLink.handlers.set(PacketType.Crates, (view) => {
      if (decodeCrates(view, this.hostState)) {
        this.hostFresh = true;
        this.hostAt = performance.now();
      }
    });
    netLink.handlers.set(PacketType.CrateHands, (view) => {
      if (decodeCrateHands(view, this.guestHands)) {
        this.guestHandsAt = performance.now();
      }
    });
    this.cleanupFuncs.push(() => {
      netLink.handlers.delete(PacketType.Crates);
      netLink.handlers.delete(PacketType.CrateHands);
    });

    // Grip locking: a hand on a crate is drawn on the nearest handle, along it.
    lockResolvers.set(HoldKind.Crate, (hand, point, axis) => {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < yard.crates.length; i++) {
        if (yard.crates[i].state === 'lost') continue;
        yard.shipPose(i, ship, cargo, this.pose);
        for (let h = 0; h < 2; h++) {
          handleAt(this.pose.x, this.pose.y, this.pose.z, this.pose.yaw, h, this.tmp);
          const d = Math.hypot(this.tmp.x - hand.x, this.tmp.y - hand.y, this.tmp.z - hand.z);
          if (d < best) {
            best = d;
            point.set(this.tmp.x, this.tmp.y, this.tmp.z);
            axis.set(Math.sin(this.pose.yaw), 0, Math.cos(this.pose.yaw));
          }
        }
      }
    });
    this.cleanupFuncs.push(() => lockResolvers.delete(HoldKind.Crate));

    const debug: CratesDebug = {
      state: () => ({
        crates: yard.crates.map((c, i) => {
          yard.shipPose(i, ship, cargo, this.pose);
          return { state: c.state, pos: [this.pose.x, this.pose.y, this.pose.z], yaw: this.pose.yaw, condition: c.condition, holders: [c.holders[0], c.holders[1]] };
        }),
        hatch: yard.hatchCrate,
        aboard: yard.aboard(cargo),
        knocks: yard.knocks,
        held: { left: this.held.left && [...this.held.left], right: this.held.right && [...this.held.right] } as Record<Side, [number, number] | null>,
      }),
      grabPoint: (i, handle) => {
        yard.shipPose(i, ship, cargo, this.pose);
        handleAt(this.pose.x, this.pose.y, this.pose.z, this.pose.yaw, handle, this.tmp);
        return [this.tmp.x, this.tmp.y, this.tmp.z];
      },
      setHands: (script) => this.setScriptedHands(script),
    };
    (window as unknown as { __crates: CratesDebug }).__crates = debug;
  }

  /** Hands on handles from a script (tests, the practice crewmate): a function of the time giving them each frame (empty for none), or null to stop. */
  setScriptedHands(script: HandScript | null): void {
    this.script = script;
    this.scripted = [];
  }

  update(delta: number): void {
    const now = performance.now();
    const dt = Math.min(delta, 0.1);
    const host = !netLink.connected || netLink.isHost;

    if (this.script) {
      const hands = this.script(now);
      if (hands === null) {
        this.script = null;
        this.scripted = [];
      } else {
        this.scripted = hands;
      }
    }
    if (yard.resets !== this.seenResets) {
      // A fresh run (or a practice start): the crates are somewhere new.
      this.seenResets = yard.resets;
      this.letGoAll();
    }
    if (!host) {
      this.followHost(now);
    }
    this.takeAndLetGo(now);
    this.gatherHands(now, host);

    if (host) {
      this.letGoRefused(yard.step(ship, cargo, this.hands, dt, cargoGround));
      if (netLink.connected) {
        this.sendState(dt, now);
      }
    } else {
      // Run ahead with a crate this player carries alone by both handles.
      for (let i = 0; i < yard.crates.length; i++) {
        if (this.carryingAlone(i)) {
          this.letGoRefused(yard.step(ship, cargo, this.hands, dt, cargoGround, i));
        }
      }
      this.sendHands(dt, now);
    }
    if (yard.knocks !== this.heardKnocks) {
      this.heardKnocks = yard.knocks;
      this.knocked();
    }
    this.strain(now);
    this.draw();
  }

  /** Take a handle with a hand that squeezes near one, and let go of handles with hands that open, or that the crank or line took. */
  private takeAndLetGo(now: number): void {
    const busy = (netLink.extraFlags.crank ?? 0) | (netLink.extraFlags.rope ?? 0);
    for (const side of SIDES) {
      const sideBusy = busy & (side === 'left' ? FLAG_LEFT_CRANK | FLAG_LEFT_ROPE : FLAG_RIGHT_CRANK | FLAG_RIGHT_ROPE);
      if (this.held[side]) {
        if (!grip[side].pressed || sideBusy) {
          this.release(side);
        }
        continue;
      }
      if (!grip[side].down || sideBusy || handUse[side]) {
        continue;
      }
      this.player.gripSpaces[side].getWorldPosition(this.handPos);
      const take = yard.handleNear(ship, cargo, this.handPos.x, this.handPos.y, this.handPos.z, crewIndex());
      if (take) {
        this.held[side] = take;
        this.heldAt[side] = now;
        handUse[side] = 'crate';
        this.pulse(side, 0.4, 30);
      }
    }
  }

  /** This frame's hands on handles: this player's, any scripted ones and (on the host) the guest's. */
  private gatherHands(now: number, host: boolean): void {
    this.hands.length = 0;
    this.handOwner.length = 0;
    const me = crewIndex();
    for (const side of SIDES) {
      const held = this.held[side];
      if (!held) continue;
      this.player.gripSpaces[side].getWorldPosition(this.handPos);
      this.addHand(side, held[0], held[1], me, this.handPos.x, this.handPos.y, this.handPos.z, HANDLE_SLIP);
    }
    for (const s of this.scripted) {
      this.addHand('script', s.crate, s.handle, s.crew ?? me, s.x, s.y, s.z, HANDLE_SLIP);
    }
    const g = this.guestHands;
    if (host && netLink.connected && now - this.guestHandsAt < GUEST_HANDS_MS && g.resets === (yard.resets & 255)) {
      for (const h of g.hands) {
        if (h.crate >= 0) this.addHand('guest', h.crate, h.handle, 1, h.x, h.y, h.z, HANDLE_SLIP + GUEST_SLIP);
      }
    }
  }

  private addHand(owner: Side | 'script' | 'guest', crate: number, handle: number, crew: number, x: number, y: number, z: number, slip: number): void {
    if (this.hands.length >= this.pool.length) {
      this.pool.push({ crate: -1, handle: 0, crew: 0, x: 0, y: 0, z: 0, slip: HANDLE_SLIP });
    }
    const hand = this.pool[this.hands.length];
    hand.crate = crate;
    hand.handle = handle;
    hand.crew = crew;
    hand.x = x;
    hand.y = y;
    hand.z = z;
    hand.slip = slip;
    this.hands.push(hand);
    this.handOwner.push(owner);
  }

  /** This player's hands the crates refused or slipped out of let go. */
  private letGoRefused(refused: number): void {
    if (!refused) return;
    for (let k = 0; k < this.hands.length; k++) {
      const owner = this.handOwner[k];
      if (refused & (1 << k) && (owner === 'left' || owner === 'right')) {
        this.release(owner);
        this.pulse(owner, 0.7, 60);
      }
    }
  }

  /** The guest: both of crate `i`'s handles in this player's hands (or the script's), and the crewmate on neither. */
  private carryingAlone(i: number): boolean {
    let mine = 0;
    for (let k = 0; k < this.hands.length; k++) {
      if (this.hands[k].crate === i) mine |= 1 << this.hands[k].handle;
    }
    const c = yard.crates[i];
    return mine === 3 && c.holders[0] !== 0 && c.holders[1] !== 0;
  }

  /** The guest: take the host's crates, except one this player carries alone, and let go of handles the host gave the crewmate. */
  private followHost(now: number): void {
    if (!this.hostFresh) {
      return;
    }
    this.hostFresh = false;
    const h = this.hostState;
    if (h.resets !== (yard.resets & 255)) {
      // The host restarted the run.
      yard.resets = h.resets;
      this.seenResets = yard.resets;
      this.letGoAll();
    }
    for (let i = 0; i < h.crates.length && i < yard.crates.length; i++) {
      const c = h.crates[i];
      const state = CRATE_STATES[c.state] ?? 'ground';
      const ahead = (state === 'held' || state === 'deck' || state === 'ground') && this.holdsBoth(i) && c.holders[0] !== 0 && c.holders[1] !== 0;
      if (ahead) {
        yard.crates[i].holders[0] = c.holders[0];
        yard.crates[i].holders[1] = c.holders[1];
      } else {
        yard.adopt(i, state, c.x, c.y, c.z, c.yaw, c.condition, c.holders[0], c.holders[1]);
      }
    }
    yard.hatchCrate = h.hatch;
    if (h.knocks !== yard.knocks) {
      yard.knocks = h.knocks;
    }
    // A handle the host hasn't given this player (the crewmate had it, or it slipped) lets go.
    for (const side of SIDES) {
      const held = this.held[side];
      if (held && now - this.heldAt[side] > CONFIRM_MS && h.crates[held[0]]?.holders[held[1]] !== 1) {
        this.release(side);
        this.pulse(side, 0.6, 50);
      }
    }
  }

  /** This player's own hands (or the script's) are on both of crate `i`'s handles. */
  private holdsBoth(i: number): boolean {
    let mine = 0;
    for (const side of SIDES) {
      const held = this.held[side];
      if (held && held[0] === i) mine |= 1 << held[1];
    }
    for (const s of this.scripted) {
      if (s.crate === i) mine |= 1 << s.handle;
    }
    return mine === 3;
  }

  private release(side: Side): void {
    if (this.held[side]) {
      handUse[side] = null;
    }
    this.held[side] = null;
  }

  private letGoAll(): void {
    this.release('left');
    this.release('right');
  }

  private sendState(dt: number, now: number): void {
    this.sendAccumulator += dt;
    if (this.sendAccumulator < 1 / SEND_HZ) {
      return;
    }
    this.sendAccumulator = Math.min(this.sendAccumulator - 1 / SEND_HZ, 1 / SEND_HZ);
    const s = this.outState;
    s.timeMs = now;
    s.resets = yard.resets;
    s.knocks = yard.knocks;
    s.hatch = yard.hatchCrate;
    for (let i = 0; i < s.crates.length && i < yard.crates.length; i++) {
      const c = yard.crates[i];
      const o = s.crates[i];
      o.state = CRATE_STATES.indexOf(c.state);
      o.holders[0] = c.holders[0];
      o.holders[1] = c.holders[1];
      o.condition = c.condition;
      o.x = c.x;
      o.y = c.y;
      o.z = c.z;
      o.yaw = c.yaw;
    }
    netLink.send(this.sendBuffer, encodeCrates(this.sendBuffer, s));
  }

  /** The guest: where this player's hands are on which handles. */
  private sendHands(dt: number, now: number): void {
    if (!netLink.connected) {
      return;
    }
    this.sendAccumulator += dt;
    if (this.sendAccumulator < 1 / SEND_HZ) {
      return;
    }
    this.sendAccumulator = Math.min(this.sendAccumulator - 1 / SEND_HZ, 1 / SEND_HZ);
    const o = this.outHands;
    o.timeMs = now;
    o.resets = yard.resets;
    for (let k = 0; k < o.hands.length; k++) {
      const out = o.hands[k];
      const hand = k < this.hands.length ? this.hands[k] : null;
      out.crate = hand ? hand.crate : -1;
      out.handle = hand ? hand.handle : 0;
      out.x = hand ? hand.x : 0;
      out.y = hand ? hand.y : 0;
      out.z = hand ? hand.z : 0;
    }
    netLink.send(this.handsBuffer, encodeCrateHands(this.handsBuffer, o));
  }

  /** A crate landed hard: a thump, and a jolt in the hands on crates. */
  private knocked(): void {
    const hard = Math.min(1, yard.lastKnock / 20);
    console.info(`[Crates] knocked: -${yard.lastKnock.toFixed(1)}%`);
    sounds.thump(0.3 + 0.7 * hard);
    for (const side of SIDES) {
      if (this.held[side]) this.pulse(side, 0.5 + 0.5 * hard, 60);
    }
  }

  /** The crate's weight in the hands: a buzz that grows as it lags them. */
  private strain(now: number): void {
    if (now - this.lastStrain < STRAIN_EVERY_MS) return;
    for (const side of SIDES) {
      const held = this.held[side];
      if (!held) continue;
      this.player.gripSpaces[side].getWorldPosition(this.handPos);
      yard.shipPose(held[0], ship, cargo, this.pose);
      handleAt(this.pose.x, this.pose.y, this.pose.z, this.pose.yaw, held[1], this.tmp);
      const lag = Math.hypot(this.tmp.x - this.handPos.x, this.tmp.y - this.handPos.y, this.tmp.z - this.handPos.z);
      if (lag > STRAIN_FROM) {
        this.lastStrain = now;
        this.pulse(side, Math.min(0.8, 0.15 + (0.65 * (lag - STRAIN_FROM)) / (HANDLE_SLIP - STRAIN_FROM)), 40);
      }
    }
  }

  private draw(): void {
    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i];
      const state = yard.crates[i].state;
      // Only with the route out (flying), and not once lost below.
      mesh.visible = flightInfo.flying && state !== 'lost';
      if (!mesh.visible) continue;
      yard.shipPose(i, ship, cargo, this.pose);
      // The crate's origin is its top middle.
      mesh.position.set(this.pose.x, this.pose.y + CRATE_HEIGHT, this.pose.z);
      mesh.rotation.set(0, this.pose.yaw, 0);
    }
  }

  private pulse(side: Side, intensity: number, ms: number): void {
    buzz(this.input.xr.gamepads[side]?.gamepad, side, intensity, ms);
  }
}
