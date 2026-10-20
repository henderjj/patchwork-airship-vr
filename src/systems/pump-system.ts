import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  createSystem,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import type { PoseSample } from '../net/pose-codec.js';
import { createDeckWater, createPumpBody, createPumpLever, createPumpRod, ROD_ARM } from '../scene-assets/pump.scene-asset.js';
import { PUMP, PUMP_PIVOT, PUMP_RADIUS, PUMP_SPOUT, pumpHandle } from '../sim/gondola-layout.js';
import { PUMP_REACH, PUMP_WARNING, PumpLever, waterDepth } from '../sim/weather.js';
import { sounds } from './audio-system.js';
import { grip, handUse } from './grip-system.js';
import { HoldKind, lockResolvers } from './hand-lock.js';
import { FLAG_LEFT_CRANK, FLAG_LEFT_ROPE, FLAG_RIGHT_CRANK, FLAG_RIGHT_ROPE, netLink } from './net-system.js';
import { storm } from './ship-system.js';

const SIDES = ['left', 'right'] as const;
type Side = (typeof SIDES)[number];

/** A scripted hand (tests and the practice crewmate): where it is, ship space, and whether it squeezes; null lets go of it. */
export interface PumpHandPose {
  x: number;
  y: number;
  z: number;
  squeeze: boolean;
}
export type PumpHand = (nowMs: number) => PumpHandPose | null;

/** A hand holding the handle lets go once it is this far from it, m. */
const HOLD_SLIP = 0.3;
/** The guest sends what it has pumped this often while it pumps, ms. */
const SEND_MS = 250;
/** Water drawn gushing from the spout, and how far it falls, m. */
const GUSH_DROPS = 28;
const GUSH_FALL = 1.4;
/** A gush is heard for every this many litres pumped. */
const GUSH_LITRES = 0.6;
/** Bilge sign: its size, m, and canvas, px; it is redrawn this often, ms. */
const SIGN_SIZE = [0.18, 0.09] as const;
const SIGN_PX = [256, 128] as const;
const SIGN_MS = 250;

/** The pump as it is now, for tests and the crewmate. */
export const pumpView = { angle: 0, held: false, crewHeld: false, flow: 0, gushes: 0, pumped: 0 };

interface PumpDebug {
  state(): { angle: number; held: Record<Side, boolean>; crewHeld: boolean; water: number; flow: number; pumped: number; depth: number; sign: string[] };
  /** Work the pump with a scripted hand (ship space), or let it go with null. */
  setHand(side: Side, hand: PumpHand | [number, number, number, boolean] | null): void;
  /** Where the middle of the handle is with the lever at `angle` (rad from level, up positive). */
  handlePoint(angle: number): [number, number, number];
}

/**
 * The bilge pump (Phase 3 storms, docs/storms-and-night.md): squeeze its
 * handle and work it up and down, and each down stroke sends water out of
 * the bilge and over the side through the spout. On the host (or solo)
 * the water comes out of the storm's bilge at once; the guest takes it out
 * of its own copy at once too and sends what it pumped to the host (`pump`
 * events). Works with real or scripted hands (the practice crewmate); the
 * crewmate's hand on the handle (from its pose packets) moves the lever on
 * this page. Also draws the water on the deck and the bilge's sign.
 */
export class PumpSystem extends createSystem({}) {
  private lever = new PumpLever();
  private leverMesh!: Mesh;
  private rod!: Mesh;
  private water!: Mesh;
  private gush!: Points;
  private gushPositions!: Float32Array;
  private sign!: { ctx: CanvasRenderingContext2D; texture: CanvasTexture; lines: string[] };
  private lastSignDraw = 0;

  private held: Record<Side, boolean> = { left: false, right: false };
  private scripted: Record<Side, PumpHand | null> = { left: null, right: null };
  private scriptedPose: Record<Side, PumpHandPose | null> = { left: null, right: null };
  private squeezed: Record<Side, boolean> = { left: false, right: false };
  /** The guest's water pumped and not yet sent, litres, and when it last sent. */
  private unsent = 0;
  private sentAt = 0;
  /** Litres pumped since the last gush was heard. */
  private toHear = 0;
  private flowShown = 0;
  private gushTime = 0;
  private hand = new Vector3();
  private handle = { x: 0, y: 0, z: 0 };

  init(): void {
    this.world.createTransformEntity(createPumpBody());
    this.leverMesh = createPumpLever();
    this.leverMesh.position.set(PUMP_PIVOT[0], PUMP_PIVOT[1], PUMP_PIVOT[2]);
    this.world.createTransformEntity(this.leverMesh);
    this.rod = createPumpRod();
    this.world.createTransformEntity(this.rod);
    this.water = createDeckWater();
    this.water.visible = false;
    this.world.createTransformEntity(this.water);
    this.gushPositions = new Float32Array(GUSH_DROPS * 3);
    const gushGeometry = new BufferGeometry();
    gushGeometry.setAttribute('position', new BufferAttribute(this.gushPositions, 3));
    this.gush = new Points(gushGeometry, new PointsMaterial({ color: 0xa9c4d4, size: 0.04, transparent: true, opacity: 0.8, depthWrite: false }));
    this.gush.name = 'Pump Gush';
    this.gush.frustumCulled = false;
    this.gush.visible = false;
    this.world.createTransformEntity(this.gush);
    this.createSign();
    this.place();

    // Grip locking: a hand on the pump is drawn round the handle's crossbar, which runs fore and aft.
    lockResolvers.set(HoldKind.Pump, (_hand, point, axis) => {
      pumpHandle(this.lever.angle, this.handle);
      point.set(this.handle.x, this.handle.y, this.handle.z);
      axis.set(0, 0, 1);
    });
    // The guest's strokes: their water comes out of the host's bilge.
    netLink.events.set('pump', (event) => {
      const litres = Number(event.l);
      if (netLink.isHost && Number.isFinite(litres) && litres > 0) {
        storm.pump(Math.min(litres, 20));
      }
    });
    this.cleanupFuncs.push(
      () => lockResolvers.delete(HoldKind.Pump),
      () => netLink.events.delete('pump'),
    );

    const debug: PumpDebug = {
      state: () => ({
        angle: this.lever.angle,
        held: { ...this.held },
        crewHeld: pumpView.crewHeld,
        water: storm.water,
        flow: this.flowShown,
        pumped: pumpView.pumped,
        depth: waterDepth(storm.water),
        sign: [...this.sign.lines],
      }),
      setHand: (side, hand) => {
        if (hand === null || typeof hand === 'function') {
          this.setScriptedHand(side, hand);
        } else {
          const pose: PumpHandPose = { x: hand[0], y: hand[1], z: hand[2], squeeze: hand[3] };
          this.setScriptedHand(side, () => pose);
        }
      },
      handlePoint: (angle) => {
        pumpHandle(angle, this.handle);
        return [this.handle.x, this.handle.y, this.handle.z];
      },
    };
    (window as unknown as { __pump: PumpDebug }).__pump = debug;
  }

  /** Work the pump with a scripted hand (tests, the practice crewmate), or give the hand back with null. */
  setScriptedHand(side: Side, hand: PumpHand | null): void {
    this.scripted[side] = hand;
  }

  /** Whether one of this player's hands holds the handle. */
  holding(side: Side): boolean {
    return this.held[side];
  }

  update(delta: number): void {
    const now = performance.now();
    const dt = Math.min(delta, 0.1);
    const host = !netLink.connected || netLink.isHost;

    // This player's hands on the handle: the lever follows them (their middle, with both on it).
    let sum = 0;
    let hands = 0;
    const busy = (netLink.extraFlags.crank ?? 0) | (netLink.extraFlags.rope ?? 0);
    for (const side of SIDES) {
      const present = this.readHand(side, now);
      if (this.held[side]) {
        pumpHandle(this.lever.angle, this.handle);
        const far = Math.hypot(this.hand.x - this.handle.x, this.hand.y - this.handle.y, this.hand.z - this.handle.z) > HOLD_SLIP;
        if (!present || !this.pressed(side) || far) {
          this.release(side);
          continue;
        }
        sum += this.hand.y;
        hands++;
        continue;
      }
      const sideBusy = busy & (side === 'left' ? FLAG_LEFT_CRANK | FLAG_LEFT_ROPE : FLAG_RIGHT_CRANK | FLAG_RIGHT_ROPE);
      if (!present || !this.down(side) || sideBusy || (handUse[side] && this.scripted[side] === null) || this.crewHand() !== null) {
        continue;
      }
      pumpHandle(this.lever.angle, this.handle);
      if (Math.hypot(this.hand.x - this.handle.x, this.hand.y - this.handle.y, this.hand.z - this.handle.z) <= PUMP_REACH) {
        this.held[side] = true;
        handUse[side] = 'pump';
        this.pulse(side, 0.4, 30);
        sum += this.hand.y;
        hands++;
      }
    }

    let litres = 0;
    const crew = hands === 0 ? this.crewHand() : null;
    pumpView.crewHeld = crew !== null;
    if (hands > 0) {
      litres = this.lever.follow(sum / hands, dt);
      // This player's own strokes: out of the bilge here at once, and (as the guest) to the host.
      litres = storm.pump(litres);
      if (!host && litres > 0) this.unsent += litres;
      if (litres > 0) {
        for (const side of SIDES) if (this.held[side]) this.pulse(side, Math.min(0.6, 0.15 + litres), 15);
      }
    } else if (crew) {
      // The crewmate's strokes move the lever here, and show and sound here; their water comes out in their `pump` events.
      const moved = this.lever.follow(crew.py, dt);
      litres = storm.water > 0.5 ? moved : 0;
    } else {
      this.lever.sink(dt);
    }
    pumpView.angle = this.lever.angle;
    pumpView.held = hands > 0;
    pumpView.pumped += hands > 0 ? litres : 0;
    if (this.unsent > 0 && now - this.sentAt > SEND_MS) {
      this.sentAt = now;
      netLink.sendEvent({ t: 'pump', l: Math.round(this.unsent * 100) / 100 } as { t: string });
      this.unsent = 0;
    }

    // The gush from the spout, and its sound.
    const flow = dt > 0 ? litres / dt : 0;
    this.flowShown += (flow - this.flowShown) * Math.min(1, dt * (flow > this.flowShown ? 12 : 4));
    pumpView.flow = this.flowShown;
    this.toHear += litres;
    if (this.toHear >= GUSH_LITRES) {
      sounds.gush(Math.min(1, this.toHear / 1.5));
      pumpView.gushes++;
      this.toHear = 0;
    }
    this.place();
    this.layGush(dt);
    const depth = waterDepth(storm.water);
    this.water.visible = depth > 0;
    this.water.position.y = depth;
    if (now - this.lastSignDraw > SIGN_MS) {
      this.lastSignDraw = now;
      this.drawSign();
    }
  }

  /** The lever at its angle, and the rod hanging from its short end. */
  private place(): void {
    const a = this.lever.angle;
    // The lever reaches along -X: turning it about Z by -a lifts the handle by a.
    this.leverMesh.rotation.z = -a;
    this.rod.position.set(PUMP_PIVOT[0] + ROD_ARM * Math.cos(a), PUMP_PIVOT[1] - ROD_ARM * Math.sin(a), PUMP_PIVOT[2]);
  }

  /** Water falling from the spout while it flows. */
  private layGush(dt: number): void {
    const flowing = this.flowShown > 0.3;
    this.gush.visible = flowing;
    if (!flowing) return;
    this.gushTime += dt;
    const a = this.gushPositions;
    const spread = Math.min(1, this.flowShown / 3);
    for (let k = 0; k < GUSH_DROPS; k++) {
      const age = (this.gushTime * 1.8 + k / GUSH_DROPS) % 1;
      const o = k * 3;
      a[o] = PUMP_SPOUT[0] + age * (0.12 + 0.1 * spread) + ((k * 0.37) % 1) * 0.03;
      a[o + 1] = PUMP_SPOUT[1] - age * age * GUSH_FALL;
      a[o + 2] = PUMP_SPOUT[2] + (((k * 0.61) % 1) - 0.5) * 0.06 * (1 + age);
    }
    (this.gush.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }

  /** Where a hand is this frame (into `hand`); false if there is no hand. */
  private readHand(side: Side, now: number): boolean {
    const script = this.scripted[side];
    if (script) {
      const pose = script(now);
      if (pose === null) {
        this.scripted[side] = null;
        this.scriptedPose[side] = null;
        if (this.held[side]) this.release(side);
        return false;
      }
      this.scriptedPose[side] = pose;
      this.hand.set(pose.x, pose.y, pose.z);
      return true;
    }
    this.scriptedPose[side] = null;
    if (!this.world.session || !this.input.xr.getPrimaryInputSource(side)) {
      return false;
    }
    this.player.gripSpaces[side].getWorldPosition(this.hand);
    return true;
  }

  private pressed(side: Side): boolean {
    const pose = this.scriptedPose[side];
    return pose ? pose.squeeze : grip[side].pressed;
  }

  /** The squeeze started this frame. */
  private down(side: Side): boolean {
    const pose = this.scriptedPose[side];
    if (pose) {
      const down = pose.squeeze && !this.squeezed[side];
      this.squeezed[side] = pose.squeeze;
      return down;
    }
    return grip[side].down;
  }

  private release(side: Side): void {
    this.held[side] = false;
    if (handUse[side] === 'pump') handUse[side] = null;
    if (this.scriptedPose[side]) this.squeezed[side] = this.scriptedPose[side].squeeze;
  }

  /** The crewmate's hand on the handle, as drawn, or null. */
  private crewHand(): PoseSample | null {
    if (!netLink.connected || !netLink.haveRemote) return null;
    const r = netLink.remote;
    if ((r.holds & 15) === HoldKind.Pump) return r.left;
    if (((r.holds >> 4) & 15) === HoldKind.Pump) return r.right;
    return null;
  }

  private pulse(side: Side, intensity: number, ms: number): void {
    const actuator = this.input.xr.gamepads[side]?.gamepad.hapticActuators?.[0] as
      | { pulse?: (value: number, duration: number) => Promise<boolean> }
      | undefined;
    void actuator?.pulse?.(intensity, ms)?.catch(() => undefined);
  }

  /** The bilge's sign, on a board fixed to the barrel's inboard side under the handle. */
  private createSign(): void {
    const canvas = document.createElement('canvas');
    canvas.width = SIGN_PX[0];
    canvas.height = SIGN_PX[1];
    const ctx = canvas.getContext('2d')!;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const mesh = new Mesh(new PlaneGeometry(SIGN_SIZE[0], SIGN_SIZE[1]), new MeshBasicMaterial({ map: texture, toneMapped: false }));
    mesh.name = 'Bilge Sign';
    // Clear of the staves (which bulge to 1.06 times the radius at the foot).
    mesh.position.set(PUMP[0] - PUMP_RADIUS * 1.04 - 0.012, 0.5, PUMP[1]);
    mesh.rotation.y = -Math.PI / 2;
    this.world.createTransformEntity(mesh);
    this.sign = { ctx, texture, lines: [] };
    this.drawSign();
  }

  private drawSign(): void {
    const water = storm.water;
    const lines = ['BILGE', water < 1 ? 'dry' : `${Math.round(water)} litres`, water >= PUMP_WARNING ? 'PUMP!' : ''];
    if (lines.every((line, i) => line === this.sign.lines[i])) return;
    this.sign.lines = lines;
    const { ctx, texture } = this.sign;
    const [w, h] = SIGN_PX;
    ctx.fillStyle = '#2b1d12';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#c9a03a';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w - 4, h - 4);
    ctx.textAlign = 'center';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillStyle = '#e8d4a2';
    ctx.fillText(lines[0], w / 2, 36);
    ctx.font = 'bold 28px sans-serif';
    ctx.fillStyle = '#f3e3c3';
    ctx.fillText(lines[1], w / 2, 74);
    ctx.fillStyle = '#f08a5d';
    ctx.fillText(lines[2], w / 2, 110);
    texture.needsUpdate = true;
  }
}
