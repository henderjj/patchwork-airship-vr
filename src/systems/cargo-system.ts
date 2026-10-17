import {
  CanvasTexture,
  createSystem,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import {
  CARGO_FLAG_DOOR,
  CARGO_FLAG_LEVER,
  CARGO_FLAG_TAG,
  CARGO_FLAG_WINCH,
  CARGO_HANDS_PACKET_BYTES,
  CARGO_PACKET_BYTES,
  createCargoHandsPacket,
  createCargoStatePacket,
  decodeCargo,
  decodeCargoHands,
  encodeCargo,
  encodeCargoHands,
  PacketType,
} from '../net/pose-codec.js';
import {
  createCargoHook,
  createCargoLine,
  createCrate,
  createHatchDoor,
  createHatchLever,
  createTagToggle,
  createWinchDrum,
  SLING_HEIGHT,
} from '../scene-assets/cargo.scene-asset.js';
import {
  angleRoundWinch,
  BLOCK,
  CARGO_PHASES,
  type CargoGround,
  type CargoPhase,
  createCargoInput,
  CRATE_SIZE,
  DERRICK_POST,
  type GroundAt,
  HATCH,
  HATCH_CENTER,
  LEVER_OPEN,
  LEVER_PIVOT,
  LEVER_REACH,
  leverFromHand,
  leverKnob,
  lineFromWinch,
  TAG_REACH,
  TAG_RING,
  TAG_SLIP,
  TRUNK_DEPTH,
  turnWinch,
  WINCH_AXLE,
  WINCH_REACH,
  winchHandle,
} from '../sim/cargo.js';
import { shipToWorld } from '../sim/docking.js';
import { KEEL_DEPTH } from '../sim/gondola-layout.js';
import { groundBelow } from '../sim/islands.js';
import { JETTY_TOP, onJetty } from '../sim/route.js';
import { wrapNear } from '../sim/world-tile.js';
import { settings } from '../settings.js';
import { ROUTE, ROUTE_ISLANDS, sceneryIslands } from '../world/route-world.js';
import { sounds } from './audio-system.js';
import { grip, handUse } from './grip-system.js';
import { HoldKind, lockResolvers } from './hand-lock.js';
import { FLAG_LEFT_CRANK, FLAG_LEFT_ROPE, FLAG_RIGHT_CRANK, FLAG_RIGHT_ROPE, netLink } from './net-system.js';
import { cargo, flight, ship } from './ship-system.js';

/**
 * Cargo (Phase 3, docs/cargo.md): the crate in the hatch, the hatch lever,
 * the winch and the tag line. Squeeze near the winch handle's grip and turn
 * it (tops towards the stern lower away), near the lever's knob and pull it
 * back to open the hatch door, or near the tag line's toggle on its ring
 * and hold it over the hatch to steady the crate.
 *
 * The host (or a solo page) runs the crate (src/sim/cargo.ts) with both
 * players' hands and sends it 30 times a second; the guest sends what its
 * hands are doing to the gear (the winch angle it has turned to, the lever,
 * where it holds the tag line) and draws the crate as the host has it. A
 * hand on the winch or the lever moves it at once on its own page.
 *
 * Feedback: a click in the hand every eighth of a turn of the winch, a thump
 * and a pulse in the hands on the gear when the crate is knocked, and a
 * creak while it swings hard. The cargo sign on the derrick post says what
 * to do next, how far the crate has to go and its condition.
 */

const SIDES = ['left', 'right'] as const;
type Side = (typeof SIDES)[number];
type Gear = 'winch' | 'lever' | 'tag';
const SEND_HZ = 30;
/** A guest's hands older than this are let go of, ms. */
const GUEST_HANDS_MS = 400;
/** The guest's winch eases to the host's by this share of the gap per frame. */
const BLEND_RATE = 0.2;
/** The door swings open or shut at this rate, rad/s, and the lever eases back to where the door is at this one. */
const DOOR_RATE = 5;
const LEVER_RETURN_RATE = 4;
/** Swinging faster than this creaks, this often, m/s and ms. */
const CREAK_SWING = 0.3;
const CREAK_EVERY_MS = 700;
/** The hand on the tag line feels the crate's swing as a buzz this often, ms, stronger the faster it swings. */
const TUG_EVERY_MS = 100;
/** The tag line is tied to the crate's top corner nearest its ring. */
const TAG_CORNER = [-CRATE_SIZE / 2 + 0.03, -0.04, -CRATE_SIZE / 2 + 0.03] as const;

/** A scripted hand on the winch (tests): the angle it turns it to at a time, or null to let go. */
type WinchScript = (nowMs: number) => number | null;
/** A scripted hand on the tag line: where it is across the deck at a time, or null to let go. */
type TagScript = (nowMs: number) => [number, number] | null;

interface CargoDebug {
  sim: typeof cargo;
  state(): {
    phase: CargoPhase;
    condition: number;
    knocks: number;
    line: number;
    winch: number;
    lever: number;
    door: boolean;
    held: Record<Side, Gear | null>;
    crewHolds: { winch: boolean; lever: boolean; tag: boolean };
    toGo: number;
    swing: number;
    pos: [number, number, number];
    /** How fast it swings across the deck, ship space, m/s. */
    vel: [number, number];
  };
  /** Where a hand takes hold of each piece of gear (ship space). */
  grabPoint(gear: Gear): [number, number, number];
  /** Turn the winch with a scripted hand (an angle for a time), or let go with null. */
  setWinchHand(hand: WinchScript | null): void;
  /** Hold the tag line with a scripted hand at (x, z) across the deck (or where a function of the time puts it each frame), or let go with null. */
  setTagHand(at: [number, number] | TagScript | null): void;
  /** Hold the hatch lever with a scripted hand at an angle (rad, 0 shut, LEVER_OPEN open), or let go with null. */
  setLeverHand(angle: number | null): void;
  /** What the cargo sign says. */
  signText(): string[];
}

export class CargoSystem extends createSystem({}) {
  private crate!: Mesh;
  private door!: Mesh;
  private drum!: Mesh;
  private lever!: Mesh;
  private hook!: Mesh;
  private hoist!: Mesh;
  private tagLine!: Mesh;
  private toggle!: Mesh;
  private sign!: { ctx: CanvasRenderingContext2D; texture: CanvasTexture; lines: string[] };
  private lastSignDraw = 0;

  /** The winch's angle (the line out follows it) and the lever's, as this page has them. */
  private winch = 0;
  private leverAngle = 0;
  private doorAngle = 0;
  /** What each of this player's hands holds. */
  private held: Record<Side, Gear | null> = { left: null, right: null };
  private winchScript: WinchScript | null = null;
  private tagScript: [number, number] | null = null;
  private tagScriptFn: TagScript | null = null;
  private leverScript: number | null = null;
  private seenResets = -1;
  private groundOut: CargoGround = { y: 0, delivery: false };
  /** What is under a point in the world: the route's islands (B's top and the cargo stage are delivery spots), the scenery islands and B's jetty. */
  private readonly groundAt: GroundAt = (x, z, fromY, out) => {
    out.y = Number.NEGATIVE_INFINITY;
    out.delivery = false;
    for (const island of ROUTE_ISLANDS) {
      const r = island.radius * 0.92;
      if ((x - island.x) ** 2 + (z - island.z) ** 2 < r * r && island.y <= fromY && island.y > out.y) {
        out.y = island.y;
        out.delivery = island === ROUTE.finish || island === ROUTE.cargo;
      }
    }
    const scenery = groundBelow(sceneryIslands, x, z, fromY + KEEL_DEPTH, wrapNear) - KEEL_DEPTH;
    if (scenery > out.y) {
      out.y = scenery;
      out.delivery = false;
    }
    const jetty = ROUTE.dock.y + JETTY_TOP;
    if (jetty <= fromY && jetty > out.y && onJetty(ROUTE, x, z)) {
      out.y = jetty;
      out.delivery = true;
    }
  };
  private cargoInput = createCargoInput(this.groundAt);

  private hostState = createCargoStatePacket();
  private hostFresh = false;
  private outState = createCargoStatePacket();
  private sendBuffer = new ArrayBuffer(CARGO_PACKET_BYTES);
  private guestHands = createCargoHandsPacket();
  private guestHandsAt = Number.NEGATIVE_INFINITY;
  private outHands = createCargoHandsPacket();
  private handsBuffer = new ArrayBuffer(CARGO_HANDS_PACKET_BYTES);
  private sendAccumulator = 0;

  private heardKnocks = 0;
  private lastClick = 0;
  private lastCreak = 0;
  private lastTug = 0;
  private handPos = new Vector3();
  private dir = new Vector3();
  private up = new Vector3(0, 1, 0);
  private top = { x: 0, y: 0, z: 0 };
  private tmp = { x: 0, y: 0, z: 0 };
  private hookAt = new Vector3();
  private tagEnd = new Vector3();

  init(): void {
    this.crate = this.place(createCrate());
    this.door = this.place(createHatchDoor());
    this.door.position.set(HATCH.x0, -TRUNK_DEPTH, HATCH_CENTER[1]);
    this.drum = this.place(createWinchDrum());
    this.drum.position.set(WINCH_AXLE[0], WINCH_AXLE[1], WINCH_AXLE[2]);
    this.lever = this.place(createHatchLever());
    this.lever.position.set(LEVER_PIVOT[0], LEVER_PIVOT[1], LEVER_PIVOT[2]);
    this.hook = this.place(createCargoHook());
    this.hoist = this.place(createCargoLine('Hoist Line'));
    this.tagLine = this.place(createCargoLine('Tag Line', true));
    this.toggle = this.place(createTagToggle());
    this.createSign();

    netLink.handlers.set(PacketType.Cargo, (view) => {
      if (decodeCargo(view, this.hostState)) {
        this.hostFresh = true;
      }
    });
    netLink.handlers.set(PacketType.CargoHands, (view) => {
      if (decodeCargoHands(view, this.guestHands)) {
        this.guestHandsAt = performance.now();
      }
    });
    this.cleanupFuncs.push(() => {
      netLink.handlers.delete(PacketType.Cargo);
      netLink.handlers.delete(PacketType.CargoHands);
    });

    // Grip locking: a hand on the winch is drawn on its grip, one on the lever round its knob.
    lockResolvers.set(HoldKind.Winch, (_hand, point, axis) => {
      winchHandle(this.winch, this.tmp);
      point.set(this.tmp.x, this.tmp.y, this.tmp.z);
      axis.set(1, 0, 0);
    });
    lockResolvers.set(HoldKind.Lever, (_hand, point, axis) => {
      leverKnob(this.leverAngle, this.tmp);
      point.set(this.tmp.x, this.tmp.y - 0.06, this.tmp.z);
      axis.set(0, Math.cos(this.leverAngle), Math.sin(this.leverAngle));
    });
    this.cleanupFuncs.push(() => {
      lockResolvers.delete(HoldKind.Winch);
      lockResolvers.delete(HoldKind.Lever);
    });

    const debug: CargoDebug = {
      sim: cargo,
      state: () => ({
        phase: cargo.phase,
        condition: cargo.condition,
        knocks: cargo.knocks,
        line: lineFromWinch(this.winch),
        winch: this.winch,
        lever: this.leverAngle,
        door: cargo.doorOpen,
        held: { ...this.held },
        crewHolds: { winch: this.crewHolds('winch'), lever: this.crewHolds('lever'), tag: this.crewHolds('tag') },
        toGo: cargo.heightAboveGround(ship, this.groundAt),
        swing: cargo.swing,
        pos: [cargo.pos.x, cargo.pos.y, cargo.pos.z],
        vel: [cargo.vel.x, cargo.vel.z],
      }),
      grabPoint: (gear) => {
        if (gear === 'winch') {
          winchHandle(this.winch, this.tmp);
        } else if (gear === 'lever') {
          leverKnob(this.leverAngle, this.tmp);
        } else {
          Object.assign(this.tmp, { x: TAG_RING[0], y: TAG_RING[1] - 0.04, z: TAG_RING[2] });
        }
        return [this.tmp.x, this.tmp.y, this.tmp.z];
      },
      setWinchHand: (hand) => {
        this.winchScript = hand;
      },
      setTagHand: (at) => {
        this.tagScriptFn = typeof at === 'function' ? at : null;
        this.tagScript = typeof at === 'function' ? at(performance.now()) : at;
      },
      setLeverHand: (angle) => {
        this.leverScript = angle;
      },
      signText: () => [...this.sign.lines],
    };
    (window as unknown as { __cargo: CargoDebug }).__cargo = debug;
  }

  update(delta: number): void {
    const now = performance.now();
    const dt = Math.min(delta, 0.1);
    const host = !netLink.connected || netLink.isHost;

    if (cargo.resets !== this.seenResets) {
      // A fresh run: the crate back in the hatch, the door shut, the line in.
      this.seenResets = cargo.resets;
      this.letGoAll();
      this.winch = 0;
      this.leverAngle = 0;
      this.doorAngle = 0;
    }
    if (!host) {
      this.followHost(dt);
    }
    this.updateHands(dt);

    if (host) {
      this.combine(now);
      if (cargo.step(ship, this.cargoInput, dt)) {
        this.knocked();
      }
      this.heardKnocks = cargo.knocks;
      if (netLink.connected) {
        this.sendState(dt, now);
      }
    } else {
      this.sendHands(dt, now);
    }

    this.feedback(now);
    this.draw(dt);
    if (now - this.lastSignDraw > 250) {
      this.lastSignDraw = now;
      this.drawSign();
    }
  }

  /** Host or solo: this player's hands and the guest's, into the crate's input. */
  private combine(now: number): void {
    const guest = netLink.connected && now - this.guestHandsAt < GUEST_HANDS_MS && this.guestHands.resets === (cargo.resets & 255) ? this.guestHands.flags : 0;
    const mine = this.holding('winch') || this.winchScript !== null;
    if (!mine && guest & CARGO_FLAG_WINCH) {
      this.winch = this.guestHands.winch;
    }
    if (!this.leverMine() && guest & CARGO_FLAG_LEVER) {
      this.leverAngle = this.guestHands.lever;
    }
    const i = this.cargoInput;
    i.line = lineFromWinch(this.winch);
    // The door opens once the lever is past halfway, and shuts once it's back unless the crate is through it.
    const wantOpen = this.leverAngle > LEVER_OPEN / 2;
    i.doorOpen = wantOpen || (cargo.doorOpen && !cargo.canClose);
    i.tagHeld = false;
    const tagSide = this.sideHolding('tag');
    if (this.tagScript) {
      i.tagHeld = true;
      i.tagX = this.tagScript[0];
      i.tagZ = this.tagScript[1];
    } else if (tagSide) {
      this.player.gripSpaces[tagSide].getWorldPosition(this.handPos);
      i.tagHeld = true;
      i.tagX = this.handPos.x;
      i.tagZ = this.handPos.z;
    } else if (guest & CARGO_FLAG_TAG) {
      i.tagHeld = true;
      i.tagX = this.guestHands.tagX;
      i.tagZ = this.guestHands.tagZ;
    }
    // The wind as the flight model blows it (the breeze and any gust), and the menu's setting for how strong.
    i.windX = flight.windX;
    i.windZ = flight.windZ;
    i.windScale = settings.wind;
    i.time = ship.time;
  }

  /** The guest: take the host's crate, door, and winch and lever where this player's hands aren't on them. */
  private followHost(dt: number): void {
    if (!this.hostFresh) {
      return;
    }
    const h = this.hostState;
    if (h.resets !== (cargo.resets & 255)) {
      // The host restarted the run.
      cargo.reset();
      cargo.resets = h.resets;
      this.seenResets = cargo.resets;
      this.letGoAll();
      this.winch = h.winch;
    }
    const phase = CARGO_PHASES[h.phase] ?? 'aboard';
    cargo.adopt(phase, h.x, h.y, h.z, h.vx, h.vz, h.condition, ship);
    cargo.doorOpen = (h.flags & CARGO_FLAG_DOOR) !== 0;
    cargo.line = lineFromWinch(h.winch);
    if (!this.holding('winch') && this.winchScript === null) {
      const gap = h.winch - this.winch;
      this.winch = Math.abs(gap) > 3 ? h.winch : this.winch + gap * Math.min(1, BLEND_RATE * dt * 60);
    }
    if (!this.leverMine()) {
      this.leverAngle = h.lever;
    }
    if (h.knocks !== this.heardKnocks) {
      this.heardKnocks = h.knocks;
      this.knocked();
    }
  }

  private updateHands(dt: number): void {
    const now = performance.now();
    // A scripted tag line hand (tests) that moves.
    if (this.tagScriptFn) {
      this.tagScript = this.tagScriptFn(now);
      if (this.tagScript === null) this.tagScriptFn = null;
    }
    // A scripted winch hand (tests) turns it as a hand on the handle would.
    if (this.winchScript) {
      const angle = this.winchScript(now);
      if (angle === null) {
        this.winchScript = null;
      } else {
        const turned = turnWinch(this.winch, angle, dt);
        if (!Number.isNaN(turned)) this.winch = turned;
      }
    }
    const busy = (netLink.extraFlags.crank ?? 0) | (netLink.extraFlags.rope ?? 0);
    for (const side of SIDES) {
      const gear = this.held[side];
      if (gear) {
        if (!grip[side].pressed) {
          this.release(side);
          continue;
        }
        this.player.gripSpaces[side].getWorldPosition(this.handPos);
        const p = this.handPos;
        if (gear === 'winch') {
          const turned = turnWinch(this.winch, angleRoundWinch(p.y, p.z), dt);
          if (Number.isNaN(turned)) {
            // The handle got away from the hand.
            this.release(side);
            this.pulse(side, 0.9, 70);
          } else {
            this.winch = turned;
          }
        } else if (gear === 'lever') {
          this.leverAngle = leverFromHand(p.y, p.z);
        } else if (Math.hypot(p.x - HATCH_CENTER[0], p.z - HATCH_CENTER[1]) > TAG_SLIP) {
          // Too far across the deck: the line runs out of the hand.
          this.release(side);
          this.pulse(side, 0.6, 50);
        }
        continue;
      }
      const sideBusy = busy & (side === 'left' ? FLAG_LEFT_CRANK | FLAG_LEFT_ROPE : FLAG_RIGHT_CRANK | FLAG_RIGHT_ROPE);
      if (!grip[side].down || sideBusy || handUse[side]) {
        continue;
      }
      this.player.gripSpaces[side].getWorldPosition(this.handPos);
      const take = this.reachable(this.handPos);
      if (take) {
        this.held[side] = take;
        handUse[side] = take;
        this.pulse(side, 0.4, 30);
      }
    }
    if (this.leverScript !== null) {
      this.leverAngle = Math.max(0, Math.min(LEVER_OPEN, this.leverScript));
    } else if (!this.holding('lever')) {
      // Let go, the lever goes back to where the door is.
      const rest = cargo.doorOpen ? LEVER_OPEN : 0;
      const step = LEVER_RETURN_RATE * dt;
      this.leverAngle += Math.max(-step, Math.min(step, rest - this.leverAngle));
    }
  }

  /** Which piece of gear a hand at `p` can take, if any (not one the crewmate holds). */
  private reachable(p: Vector3): Gear | null {
    winchHandle(this.winch, this.tmp);
    if (Math.hypot(p.x - this.tmp.x, p.y - this.tmp.y, p.z - this.tmp.z) < WINCH_REACH && !this.holding('winch') && !this.crewHolds('winch')) {
      return 'winch';
    }
    leverKnob(this.leverAngle, this.tmp);
    if (Math.hypot(p.x - this.tmp.x, p.y - this.tmp.y, p.z - this.tmp.z) < LEVER_REACH && !this.holding('lever') && !this.crewHolds('lever')) {
      return 'lever';
    }
    if (Math.hypot(p.x - TAG_RING[0], p.y - (TAG_RING[1] - 0.04), p.z - TAG_RING[2]) < TAG_REACH && !this.holding('tag') && !this.crewHolds('tag')) {
      return 'tag';
    }
    return null;
  }

  /** A hand on the lever, real or scripted. */
  private leverMine(): boolean {
    return this.holding('lever') || this.leverScript !== null;
  }

  private holding(gear: Gear): boolean {
    return this.held.left === gear || this.held.right === gear;
  }

  private sideHolding(gear: Gear): Side | null {
    return this.held.left === gear ? 'left' : this.held.right === gear ? 'right' : null;
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

  /** The crewmate has a hand on that gear, as their pose says. */
  private crewHolds(gear: Gear): boolean {
    return this.crewHand(gear) !== null;
  }

  /** The crewmate's hand on that gear, as drawn, or null. */
  private crewHand(gear: Gear): { px: number; py: number; pz: number } | null {
    if (!netLink.connected || !netLink.haveRemote) {
      return null;
    }
    const kind = gear === 'winch' ? HoldKind.Winch : gear === 'lever' ? HoldKind.Lever : HoldKind.Tag;
    const r = netLink.remote;
    if ((r.holds & 15) === kind) return r.left;
    if (((r.holds >> 4) & 15) === kind) return r.right;
    return null;
  }

  private sendState(dt: number, now: number): void {
    this.sendAccumulator += dt;
    if (this.sendAccumulator < 1 / SEND_HZ) {
      return;
    }
    this.sendAccumulator = Math.min(this.sendAccumulator - 1 / SEND_HZ, 1 / SEND_HZ);
    const s = this.outState;
    cargo.topInShip(ship, this.top);
    s.timeMs = now;
    s.phase = CARGO_PHASES.indexOf(cargo.phase);
    s.flags = (cargo.doorOpen ? CARGO_FLAG_DOOR : 0) | (this.cargoInput.tagHeld ? CARGO_FLAG_TAG : 0);
    s.winch = this.winch;
    s.lever = this.leverAngle;
    s.x = this.top.x;
    s.y = this.top.y;
    s.z = this.top.z;
    s.vx = cargo.vel.x;
    s.vz = cargo.vel.z;
    s.condition = cargo.condition;
    s.knocks = cargo.knocks;
    s.resets = cargo.resets;
    netLink.send(this.sendBuffer, encodeCargo(this.sendBuffer, s));
  }

  /** The guest: what this player's hands are doing to the gear. */
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
    const tagSide = this.sideHolding('tag');
    o.timeMs = now;
    o.flags = (this.holding('winch') || this.winchScript ? CARGO_FLAG_WINCH : 0) | (this.leverMine() ? CARGO_FLAG_LEVER : 0) |
      (tagSide || this.tagScript ? CARGO_FLAG_TAG : 0);
    o.winch = this.winch;
    o.lever = this.leverAngle;
    if (this.tagScript) {
      o.tagX = this.tagScript[0];
      o.tagZ = this.tagScript[1];
    } else if (tagSide) {
      this.player.gripSpaces[tagSide].getWorldPosition(this.handPos);
      o.tagX = this.handPos.x;
      o.tagZ = this.handPos.z;
    }
    o.resets = cargo.resets;
    netLink.send(this.handsBuffer, encodeCargoHands(this.handsBuffer, o));
  }

  /** The crate was knocked: a thump, and a pulse in the hands on the gear. */
  private knocked(): void {
    const hard = Math.min(1, cargo.lastKnock / 10);
    console.info(`[Cargo] knocked: -${cargo.lastKnock.toFixed(1)}%, now ${cargo.condition.toFixed(0)}%`);
    sounds.thump(0.3 + 0.7 * hard);
    for (const side of SIDES) {
      if (this.held[side]) this.pulse(side, 0.5 + 0.5 * hard, 60);
    }
  }

  private feedback(now: number): void {
    // A click every eighth of a turn under the hand on the winch.
    const eighth = Math.floor((this.winch * 4) / Math.PI);
    if (eighth !== this.lastClick) {
      const side = this.sideHolding('winch');
      if (side) {
        this.pulse(side, 0.2, 12);
        sounds.ratchet(0.4);
      }
      this.lastClick = eighth;
    }
    const tagSide = this.sideHolding('tag');
    if (tagSide && cargo.phase === 'hanging' && cargo.swing > 0.05 && now - this.lastTug > TUG_EVERY_MS) {
      this.lastTug = now;
      this.pulse(tagSide, Math.min(0.6, cargo.swing * 0.8), 40);
    }
    if (cargo.phase === 'hanging' && cargo.swing > CREAK_SWING && now - this.lastCreak > CREAK_EVERY_MS) {
      this.lastCreak = now;
      sounds.creak(BLOCK, Math.min(1, cargo.swing / 1));
    }
  }

  private draw(dt: number): void {
    // The crate, where the sim (or the host) has it.
    cargo.topInShip(ship, this.top);
    const c = this.crate;
    c.position.set(this.top.x, this.top.y, this.top.z);
    // Turned with the world once it rests there; upright to the deck while aboard or on the line.
    const resting = cargo.phase === 'landed' || cargo.phase === 'delivered';
    c.rotation.set(0, resting ? -ship.yaw : 0, 0);

    // The door eases open or shut.
    const target = cargo.doorOpen ? -Math.PI / 2 : 0;
    const step = DOOR_RATE * dt;
    this.doorAngle += Math.max(-step, Math.min(step, target - this.doorAngle));
    this.door.rotation.z = this.doorAngle;
    this.drum.rotation.x = this.winch;
    this.lever.rotation.x = this.leverAngle;

    // The hook: in the sling's ring above the crate, or once delivered, hanging under the block on the line out.
    const h = this.hookAt;
    if (cargo.phase === 'delivered') {
      shipToWorld(ship, BLOCK[0], BLOCK[1], BLOCK[2], this.tmp);
      this.groundAt(this.tmp.x, this.tmp.z, this.tmp.y, this.groundOut);
      const drop = Math.min(lineFromWinch(this.winch), this.tmp.y - this.groundOut.y);
      h.set(BLOCK[0], BLOCK[1] - Math.max(0.15, drop), BLOCK[2]);
    } else {
      h.set(this.top.x, this.top.y + SLING_HEIGHT, this.top.z);
    }
    this.hook.position.copy(h).setY(h.y + 0.1);
    this.span(this.hoist, BLOCK[0], BLOCK[1] - 0.03, BLOCK[2], h.x, h.y + 0.1, h.z);

    // The tag line: from the crate's corner to the hand holding it, or to its ring.
    const corner = this.tagEnd;
    corner.set(TAG_CORNER[0], TAG_CORNER[1], TAG_CORNER[2]);
    if (resting) {
      corner.applyAxisAngle(this.up, -ship.yaw);
    }
    corner.x += this.top.x;
    corner.y += this.top.y;
    corner.z += this.top.z;
    const side = this.sideHolding('tag');
    const crew = this.crewHand('tag');
    if (side) {
      this.player.gripSpaces[side].getWorldPosition(this.handPos);
    } else if (this.tagScript) {
      this.handPos.set(this.tagScript[0], 1.1, this.tagScript[1]);
    } else if (crew) {
      this.handPos.set(crew.px, crew.py, crew.pz);
    } else {
      this.handPos.set(TAG_RING[0] + 0.03, TAG_RING[1] - 0.04, TAG_RING[2]);
    }
    this.toggle.position.copy(this.handPos);
    this.span(this.tagLine, corner.x, corner.y, corner.z, this.handPos.x, this.handPos.y, this.handPos.z);
  }

  /** Point a 1 m line span from one point to another. */
  private span(mesh: Mesh, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    this.dir.set(bx - ax, by - ay, bz - az);
    const length = this.dir.length();
    mesh.position.set(ax, ay, az);
    mesh.scale.set(1, Math.max(0.01, length), 1);
    if (length > 1e-4) {
      mesh.quaternion.setFromUnitVectors(this.up, this.dir.multiplyScalar(1 / length));
    }
  }

  private place(mesh: Mesh): Mesh {
    this.world.createTransformEntity(mesh);
    return mesh;
  }

  private pulse(side: Side, intensity: number, ms: number): void {
    const actuator = this.input.xr.gamepads[side]?.gamepad.hapticActuators?.[0] as
      | { pulse?: (value: number, duration: number) => Promise<boolean> }
      | undefined;
    void actuator?.pulse?.(intensity, ms)?.catch(() => undefined);
  }

  private createSign(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const sign = new Mesh(new PlaneGeometry(0.3, 0.15), new MeshBasicMaterial({ map: texture, toneMapped: false }));
    sign.name = 'Cargo Sign';
    // On the derrick post's forward face, facing the hatch.
    sign.position.set(DERRICK_POST[0] - 0.02, 1.62, DERRICK_POST[1] - 0.05);
    sign.rotation.set(0, Math.atan2(HATCH_CENTER[0] - DERRICK_POST[0], HATCH_CENTER[1] - DERRICK_POST[1]), 0);
    this.world.createTransformEntity(sign);
    this.sign = { ctx, texture, lines: [] };
    this.drawSign();
  }

  private signLines(): string[] {
    const condition = `CRATE ${Math.round(cargo.condition)}%`;
    switch (cargo.phase) {
      case 'aboard':
        return [condition, cargo.doorOpen ? 'lower away' : 'lever aft: open'];
      case 'hanging': {
        const toGo = cargo.heightAboveGround(ship, this.groundAt);
        const swinging = cargo.swing > 0.2 ? 'SWINGING' : '';
        return [condition, Number.isFinite(toGo) ? `${toGo.toFixed(1)} m to go` : 'lower away', swinging];
      }
      case 'landed':
        return [condition, cargo.rest.delivery ? 'down: pay out' : 'not here: hoist'];
      default:
        return [condition, 'DELIVERED'];
    }
  }

  private drawSign(): void {
    const lines = this.signLines();
    if (lines.length === this.sign.lines.length && lines.every((line, i) => line === this.sign.lines[i])) {
      return;
    }
    this.sign.lines = lines;
    const { ctx, texture } = this.sign;
    ctx.fillStyle = '#2b1d12';
    ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = '#c9a03a';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 252, 124);
    ctx.textAlign = 'center';
    ctx.fillStyle = cargo.condition < 60 ? '#f08a5d' : '#f3e3c3';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(lines[0], 128, 40);
    ctx.font = 'bold 26px sans-serif';
    ctx.fillStyle = cargo.phase === 'delivered' ? '#7fd17f' : '#e8d4a2';
    ctx.fillText(lines[1] ?? '', 128, 78);
    ctx.fillStyle = '#f08a5d';
    ctx.fillText(lines[2] ?? '', 128, 112);
    texture.needsUpdate = true;
  }
}
