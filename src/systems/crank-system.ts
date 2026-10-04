import {
  CanvasTexture,
  createSystem,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { CRANK_PACKET_BYTES, type CrankStatePacket, decodeCrank, encodeCrank, PacketType, type PoseSample } from '../net/pose-codec.js';
import {
  angleAroundAxle,
  CRANK_CENTER,
  CRANK_RADIUS,
  createCrank,
  HANDLE_REACH,
  HANDLE_X,
  handlePosition,
} from '../scene-assets/crank.scene-asset.js';
import { createHandleInput, CrankSim, wrapAngle } from '../sim/crank.js';
import {
  FLAG_LEFT_CRANK,
  FLAG_LEFT_TRACKED,
  FLAG_RIGHT_CRANK,
  FLAG_RIGHT_TRACKED,
  netLink,
} from './net-system.js';
import { grip } from './grip-system.js';

/**
 * Spike S6: the two-person propeller crank in the gondola. Squeeze the grip
 * near a handle to take it; let go to release. The host runs the crank
 * simulation (src/sim/crank.ts) with its own hands now and the crewmate's
 * hands as they arrive, and sends the result 45 times a second. The guest
 * runs the same simulation for prediction, so the handle answers its own
 * hand at once, and blends towards the host's state.
 *
 * Feedback: a ratchet click in the controller every eighth of a turn, a
 * double pulse when high gear engages, and a shudder while the two players
 * pull against each other. A sign on the pedestal shows the speed and gear.
 */

const SIDES = ['left', 'right'] as const;
type Side = (typeof SIDES)[number];
const SEND_HZ = 45;
/** Fraction of the gap to the host's crank closed per frame on the guest. */
const BLEND_RATE = 0.12;

type TestHand = (nowMs: number) => number | null;

interface CrankDebug {
  sim: CrankSim;
  /** Hold `handle` with a scripted hand angle (radians) for tests; null lets go. */
  setTestHand(handle: number, hand: TestHand | null): void;
  /** Which local hand holds each handle ('left', 'right' or null) and who holds it in the simulation. */
  holders(): { local: (Side | null)[]; sim: boolean[] };
  /** Crank turns per second. */
  turnsPerSecond(): number;
  /** Guest only: how far the predicted crank was from the host's before the last blend, radians. */
  hostError(): number;
  /** Stop the crank and reset its angle (tests). */
  reset(): void;
}

/** The crank's current speed, rad/s, read by the flight model as the propeller's thrust, and its angle (radians, not wrapped) for the ratchet's sound. */
export const crankInfo = { speed: 0, angle: 0 };

export class CrankSystem extends createSystem({}) {
  readonly sim = new CrankSim();
  private mesh!: Mesh;
  private inputs = [createHandleInput(), createHandleInput()];
  /** Handle held by each local hand, or -1. */
  private hold: Record<Side, number> = { left: -1, right: -1 };
  private testHands: (TestHand | null)[] = [null, null];
  private handPos = new Vector3();
  private overrides: Record<Side, PoseSample> = {
    left: { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    right: { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
  };
  private handleTmp = { x: 0, y: 0, z: 0 };
  private sendBuffer = new ArrayBuffer(CRANK_PACKET_BYTES);
  private sendAccumulator = 0;
  private outState: CrankStatePacket = { timeMs: 0, angle: 0, omega: 0, gear: 0, flags: 0 };
  private hostState: CrankStatePacket = { timeMs: 0, angle: 0, omega: 0, gear: 0, flags: 0 };
  private hostStateFresh = false;
  private lastClick = 0;
  private lastShudder = 0;
  private wasHighGear = false;
  private sign!: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; texture: CanvasTexture };
  private lastSignDraw = 0;
  private blendError = Number.NaN;

  init(): void {
    this.mesh = createCrank();
    this.mesh.position.set(CRANK_CENTER[0], CRANK_CENTER[1], CRANK_CENTER[2]);
    this.world.createTransformEntity(this.mesh);
    this.createSign();

    netLink.handlers.set(PacketType.Crank, (view) => {
      if (decodeCrank(view, this.hostState)) {
        this.hostStateFresh = true;
      }
    });

    const debug: CrankDebug = {
      sim: this.sim,
      setTestHand: (handle, hand) => {
        this.testHands[handle] = hand;
        if (!hand) {
          netLink.handOverride[handle === 0 ? 'left' : 'right'] = null;
        }
      },
      holders: () => ({
        local: [0, 1].map((h) => (this.hold.left === h ? 'left' : this.hold.right === h ? 'right' : null)),
        sim: this.inputs.map((i) => i.holding),
      }),
      turnsPerSecond: () => this.sim.omega / (2 * Math.PI),
      hostError: () => this.blendError,
      reset: () => {
        this.sim.angle = 0;
        this.sim.omega = 0;
        this.sim.gear = 0;
        this.hostStateFresh = false;
      },
    };
    (window as unknown as { __crank: CrankDebug }).__crank = debug;
    this.cleanupFuncs.push(() => netLink.handlers.delete(PacketType.Crank));
  }

  update(delta: number): void {
    const now = performance.now();
    const dt = Math.min(delta, 0.2);
    const me = netLink.isHost ? 0 : 1;

    this.updateLocalHands();

    // Inputs: this player's hands now, the crewmate's as drawn (a little in the past).
    for (const input of this.inputs) {
      input.holding = false;
    }
    let extraFlags = 0;
    for (const side of SIDES) {
      const handle = this.hold[side];
      if (handle < 0) {
        continue;
      }
      const angle = this.localHandAngle(side, handle, now);
      const input = this.inputs[handle];
      input.holding = true;
      input.player = me;
      input.handAngle = angle;
      input.atMs = now;
      extraFlags |= side === 'left' ? FLAG_LEFT_CRANK : FLAG_RIGHT_CRANK;
      if (this.testHands[handle]) {
        extraFlags |= side === 'left' ? FLAG_LEFT_TRACKED : FLAG_RIGHT_TRACKED;
      }
    }
    netLink.extraFlags.crank = extraFlags;
    if (netLink.connected && netLink.haveRemote) {
      const r = netLink.remote;
      for (const side of SIDES) {
        if ((r.flags & (side === 'left' ? FLAG_LEFT_CRANK : FLAG_RIGHT_CRANK)) === 0) {
          continue;
        }
        const hand = side === 'left' ? r.left : r.right;
        const handle = hand.px < CRANK_CENTER[0] ? 0 : 1;
        const input = this.inputs[handle];
        // Both reaching for one handle: the host keeps it.
        if (input.holding && netLink.isHost) {
          continue;
        }
        input.holding = true;
        input.player = 1 - me;
        input.handAngle = angleAroundAxle(hand.py, hand.pz);
        input.atMs = netLink.remoteAtMs;
      }
    }

    // Fixed steps of at most 1/90 s, so a slow frame doesn't put the crank behind real time.
    const steps = Math.min(20, Math.max(1, Math.ceil(dt * 90)));
    for (let i = 1; i <= steps; i++) {
      this.sim.step(dt / steps, now - (dt * 1000 * (steps - i)) / steps, this.inputs);
    }
    crankInfo.speed = this.sim.omega;
    crankInfo.angle = this.sim.angle;

    if (!netLink.connected || netLink.isHost) {
      if (netLink.connected) {
        this.sendState(dt, now);
      }
    } else if (this.hostStateFresh) {
      // Guest: follow the host's crank, moved on by how old its state is.
      const h = this.hostState;
      const age = Math.max(0, (now - netLink.toLocal(h.timeMs)) / 1000);
      const target = this.sim.angle + wrapAngle(h.angle + h.omega * age - this.sim.angle);
      this.blendError = target - this.sim.angle;
      this.sim.blendToward(target, h.omega, h.gear, BLEND_RATE);
    }

    // A local hand the crank pulled away from lets go.
    for (const side of SIDES) {
      const handle = this.hold[side];
      if (handle >= 0 && this.sim.slipped[handle] && this.inputs[handle].player === me) {
        console.info(`[Crank] handle ${handle} slipped from the ${side} hand (hand ${this.sim.lead[handle].toFixed(2)} rad from it)`);
        this.release(side);
        this.pulse(side, 0.9, 80);
      }
    }

    this.mesh.rotation.x = -this.sim.angle;
    this.feedback(now);
    if (now - this.lastSignDraw > 200) {
      this.lastSignDraw = now;
      this.drawSign();
    }
  }

  private updateLocalHands(): void {
    const testing = this.testHands[0] !== null || this.testHands[1] !== null;
    if (testing) {
      this.hold.left = this.testHands[0] ? 0 : -1;
      this.hold.right = this.testHands[1] ? 1 : -1;
      return;
    }
    for (const side of SIDES) {
      if (this.hold[side] >= 0) {
        if (!grip[side].pressed) {
          this.release(side);
        }
        continue;
      }
      if (!grip[side].down) {
        continue;
      }
      this.player.gripSpaces[side].getWorldPosition(this.handPos);
      for (let h = 0; h < 2; h++) {
        const other = side === 'left' ? this.hold.right : this.hold.left;
        if (other === h) {
          continue;
        }
        handlePosition(h, this.sim.angle, this.handleTmp);
        const d = Math.hypot(this.handPos.x - this.handleTmp.x, this.handPos.y - this.handleTmp.y, this.handPos.z - this.handleTmp.z);
        if (d < HANDLE_REACH) {
          this.hold[side] = h;
          this.pulse(side, 0.4, 30);
          break;
        }
      }
    }
  }

  private localHandAngle(side: Side, handle: number, now: number): number {
    const test = this.testHands[handle];
    if (test) {
      // Send the scripted hand where a real hand on that handle would be at send time.
      const o = this.overrides[side];
      netLink.handOverride[side] ??= (sendMs) => {
        const a = this.testHands[handle]?.(sendMs) ?? 0;
        o.px = CRANK_CENTER[0] + HANDLE_X[handle];
        o.py = CRANK_CENTER[1] + CRANK_RADIUS * Math.cos(a);
        o.pz = CRANK_CENTER[2] - CRANK_RADIUS * Math.sin(a);
        return o;
      };
      return test(now) ?? 0;
    }
    this.player.gripSpaces[side].getWorldPosition(this.handPos);
    return angleAroundAxle(this.handPos.y, this.handPos.z);
  }

  private release(side: Side): void {
    const handle = this.hold[side];
    this.hold[side] = -1;
    if (handle >= 0 && this.testHands[handle]) {
      this.testHands[handle] = null;
      netLink.handOverride[side] = null;
    }
  }

  private sendState(dt: number, now: number): void {
    this.sendAccumulator += dt;
    if (this.sendAccumulator < 1 / SEND_HZ) {
      return;
    }
    this.sendAccumulator = Math.min(this.sendAccumulator - 1 / SEND_HZ, 1 / SEND_HZ);
    const s = this.outState;
    s.timeMs = now;
    s.angle = wrapAngle(this.sim.angle);
    s.omega = this.sim.omega;
    s.gear = this.sim.gear;
    s.flags = (this.sim.inSync ? 1 : 0) | (this.inputs[0].holding ? 2 : 0) | (this.inputs[1].holding ? 4 : 0);
    netLink.send(this.sendBuffer, encodeCrank(this.sendBuffer, s));
  }

  /** Ratchet clicks, the high-gear double pulse and the out-of-sync shudder. */
  private feedback(now: number): void {
    const holding = this.hold.left >= 0 || this.hold.right >= 0;
    const eighth = Math.floor((this.sim.angle * 4) / Math.PI);
    if (holding && eighth !== this.lastClick) {
      for (const side of SIDES) {
        if (this.hold[side] >= 0) this.pulse(side, 0.15 + 0.25 * this.sim.strain[this.hold[side]], 12);
      }
    }
    this.lastClick = eighth;
    const highGear = this.sim.gear > 0.95;
    if (highGear && !this.wasHighGear) {
      for (const side of SIDES) {
        if (this.hold[side] >= 0) this.pulse(side, 0.8, 60);
      }
    }
    this.wasHighGear = highGear;
    if (this.sim.stutter > 0.1 && now - this.lastShudder > 120) {
      this.lastShudder = now;
      for (const side of SIDES) {
        if (this.hold[side] >= 0) this.pulse(side, 0.7, 50);
      }
    }
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
    canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const sign = new Mesh(new PlaneGeometry(0.4, 0.15), new MeshBasicMaterial({ map: texture, toneMapped: false }));
    sign.name = 'Crank Sign';
    // On a bracket above the axle, tilted up towards the cranking players.
    sign.position.set(CRANK_CENTER[0], CRANK_CENTER[1] + 0.4, CRANK_CENTER[2] - 0.05);
    sign.rotation.set(-0.35, 0, 0);
    this.world.createTransformEntity(sign);
    this.sign = { canvas, ctx, texture };
    this.drawSign();
  }

  private drawSign(): void {
    const { ctx, texture } = this.sign;
    const s = this.sim;
    // Round tiny speeds to zero so the sign never shows "-0.00".
    const turns = Math.abs(s.omega) < 0.03 ? 0 : s.omega / (2 * Math.PI);
    ctx.fillStyle = '#2b1d12';
    ctx.fillRect(0, 0, 256, 96);
    ctx.strokeStyle = '#c9a03a';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 252, 92);
    ctx.fillStyle = '#f3e3c3';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${turns.toFixed(2)} turns/s`, 128, 40);
    ctx.font = 'bold 24px sans-serif';
    if (s.gear > 0.95) {
      ctx.fillStyle = '#f4c542';
      ctx.fillText('HIGH GEAR', 128, 78);
    } else if (s.stutter > 0.1) {
      ctx.fillStyle = '#e0604a';
      ctx.fillText('out of step!', 128, 78);
    } else if (s.gear > 0.05) {
      ctx.fillStyle = '#d9b85a';
      ctx.fillText('in step...', 128, 78);
    } else {
      ctx.fillStyle = '#a89878';
      const held = this.inputs[0].holding || this.inputs[1].holding;
      ctx.fillText(held ? 'crank together' : 'grab a handle', 128, 78);
    }
    texture.needsUpdate = true;
  }
}
