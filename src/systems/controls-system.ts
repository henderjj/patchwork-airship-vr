import { CanvasTexture, createSystem, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, SRGBColorSpace, Vector3 } from '@iwsdk/core';
import {
  CONTROLS_FLAG_TILLER,
  CONTROLS_FLAG_VENT,
  CONTROLS_PACKET_BYTES,
  type ControlsPacket,
  decodeControls,
  encodeControls,
  PacketType,
} from '../net/pose-codec.js';
import {
  createBellLanyard,
  createBellToggle,
  createBoardFrame,
  createFireGlow,
  createFlame,
  createLantern,
  createSandbag,
  createTillerBar,
  createVentCord,
  createVentToggle,
} from '../scene-assets/controls.scene-asset.js';
import { FIRE_DOOR } from '../scene-assets/gondola.scene-asset.js';
import { BURNER_POSITION, BURNER_SIZE, LANTERN_HOOK } from '../sim/gondola-layout.js';
import {
  BALLAST_BAGS,
  BALLAST_REACH,
  BELL_CLAPPER,
  BELL_LANYARD_END,
  BELL_LANYARD_REACH,
  BELL_LANYARD_SLIP,
  BellPull,
  overboard,
  rudderFromHand,
  TILLER_PIVOT,
  TILLER_REACH,
  tillerAngle,
  tillerHandle,
  toggleFromHand,
  trimFromCrew,
  VENT_CORD_TOP,
  VENT_PULL,
  VENT_REACH,
  VENT_TOGGLE,
  ventFromToggle,
} from '../sim/gondola-controls.js';
import { grip, handUse } from './grip-system.js';
import { FLAG_LEFT_CRANK, FLAG_LEFT_ROPE, FLAG_RIGHT_CRANK, FLAG_RIGHT_ROPE, netLink } from './net-system.js';
import { bell } from './route-system.js';
import { dropBallast, flightControls, flightInfo, ship, stations } from './ship-system.js';

const SIDES = ['left', 'right'] as const;
type Side = (typeof SIDES)[number];

/** Guest control packets per second, and how long one counts after it arrives, ms. */
const SEND_HZ = 20;
const GUEST_INPUT_MS = 400;
/** Instrument board size, m, and how often it is redrawn, ms. */
const BOARD_SIZE = [0.34, 0.22] as const;
const BOARD_REFRESH_MS = 250;
/** Lantern pendulum: natural frequency squared (g / length) and damping, per second. */
const LANTERN_OMEGA2 = 9.81 / 0.32;
const LANTERN_DAMPING = 0.8;
/** A dropped bag falls this long before it is gone, s. */
const BAG_FALL_SECONDS = 1.6;
/** How quickly the bell's lanyard swings back to hanging straight when let go, per second. */
const LANYARD_SETTLE = 6;
const DOWN = new Vector3(0, -1, 0);

interface Bag {
  mesh: Mesh;
  heldBy: Side | null;
  /** Seconds since it went overboard, or -1 while aboard. */
  falling: number;
  vy: number;
  gone: boolean;
}

interface ControlsDebug {
  /** Test hook: hold the vent cord pulled this far (0 to 1) and the tiller at this rudder setting, or null to let go. */
  test(hold: { vent?: number | null; rudder?: number | null }): void;
  local(): { vent: number; rudder: number | null; held: Record<Side, string | null> };
  /** Drop bag `index` overboard as if a hand let it go outside the rail. */
  dropBag(index: number): void;
  bags(): { gone: boolean; falling: boolean; heldBy: Side | null }[];
  lantern(): { x: number; z: number };
  boardText(): string[];
}

/**
 * Phase 2: the gondola's flight controls, worked by hand. The tiller, the
 * vent cord and the ballast bags are taken with the grip (or a fist or
 * pinch with tracked hands), like the crank. The burner takes fuel bricks
 * through ThrowablesSystem.
 *
 * The host flies the ship (ShipSystem), so this system writes the host's
 * own hands straight into the flight controls and the guest sends its hands'
 * effect (vent pulled, tiller setting) 20 times a second; the host combines
 * them: the vent opens as far as either player pulls it, and whoever holds
 * the tiller steers (the host if both do). Bags dropped and bricks burned by
 * the guest are reliable events to the host. Everyone draws the controls
 * from the ship state the host sends back, except a control in their own hand.
 *
 * Also here: trim from where the crew stands, flames in the burner, a
 * lantern that hangs along the felt gravity (so it shows which way the deck
 * leans), and an instrument board on the burner flue.
 */
export class ControlsSystem extends createSystem({}) {
  private tiller!: Mesh;
  private toggle!: Mesh;
  private cord!: Mesh;
  private flames: Mesh[] = [];
  private fireGlow!: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private lantern!: Mesh;
  private bags: Bag[] = [];
  private board!: { ctx: CanvasRenderingContext2D; texture: CanvasTexture; lines: string[] };
  private lastBoardDraw = 0;

  private hold: Record<Side, string | null> = handUse;
  private handPos = new Vector3();
  private headPos = new Vector3();
  /** Height a hand holding the toggle is above it. */
  private toggleOffset: Record<Side, number> = { left: 0, right: 0 };
  private toggleY: number = VENT_TOGGLE[1];
  private localVent = 0;
  private localRudder: number | null = null;
  private testHold: { vent: number | null; rudder: number | null } = { vent: null, rudder: null };

  private guestInput: ControlsPacket = { timeMs: 0, flags: 0, vent: 0, rudder: 0 };
  private guestInputAt = Number.NEGATIVE_INFINITY;
  private outgoing: ControlsPacket = { timeMs: 0, flags: 0, vent: 0, rudder: 0 };
  private sendBuffer = new ArrayBuffer(CONTROLS_PACKET_BYTES);
  private sendAccumulator = 0;

  private trim = { pitch: 0, roll: 0 };
  private crewX = [0, 0];
  private crewZ = [0, 0];
  private swing = { x: 0, z: 0, vx: 0, vz: 0 };
  private tillerTmp = { x: 0, y: 0, z: 0 };
  private lanyard!: Mesh;
  private bellToggle!: Mesh;
  private lanyardEnd = new Vector3(BELL_LANYARD_END[0], BELL_LANYARD_END[1], BELL_LANYARD_END[2]);
  private lanyardRest = new Vector3(BELL_LANYARD_END[0], BELL_LANYARD_END[1], BELL_LANYARD_END[2]);
  private lanyardDir = new Vector3();
  private lanyardTurn = new Quaternion();
  private bellPull = new BellPull();

  init(): void {
    this.tiller = createTillerBar();
    this.tiller.position.set(TILLER_PIVOT[0], TILLER_PIVOT[1], TILLER_PIVOT[2]);
    this.toggle = createVentToggle();
    this.toggle.position.set(VENT_TOGGLE[0], VENT_TOGGLE[1], VENT_TOGGLE[2]);
    this.cord = createVentCord();
    this.cord.position.set(VENT_TOGGLE[0], VENT_CORD_TOP, VENT_TOGGLE[2]);
    // One flame in the hopper mouth, one at the envelope's mouth above the flue.
    const hopper = createFlame('Burner Flame');
    hopper.position.set(BURNER_POSITION[0], BURNER_SIZE[1] + 0.02, BURNER_POSITION[2]);
    const mouth = createFlame('Envelope Flame');
    mouth.position.set(BURNER_POSITION[0], 4.55, BURNER_POSITION[2]);
    mouth.scale.setScalar(2.2);
    this.flames.push(hopper, mouth);
    // The fire behind the door grate: glowing while lit, embers when out.
    this.fireGlow = createFireGlow(FIRE_DOOR[1], FIRE_DOOR[2]) as Mesh<PlaneGeometry, MeshBasicMaterial>;
    this.fireGlow.position.set(BURNER_POSITION[0] - BURNER_SIZE[0] / 2 - 0.002, FIRE_DOOR[0], BURNER_POSITION[2]);
    this.world.createTransformEntity(this.fireGlow);
    this.lantern = createLantern();
    this.lantern.position.set(LANTERN_HOOK[0], LANTERN_HOOK[1], LANTERN_HOOK[2]);
    // The ship's bell's lanyard (the bell itself belongs to the route, RouteSystem).
    this.lanyard = createBellLanyard();
    this.lanyard.position.set(BELL_CLAPPER[0], BELL_CLAPPER[1], BELL_CLAPPER[2]);
    this.bellToggle = createBellToggle();
    for (const mesh of [this.tiller, this.toggle, this.cord, hopper, mouth, this.lantern, this.lanyard, this.bellToggle]) {
      this.world.createTransformEntity(mesh);
    }
    BALLAST_BAGS.forEach((p, i) => {
      const mesh = createSandbag(i);
      mesh.position.set(p[0], p[1], p[2]);
      this.world.createTransformEntity(mesh);
      this.bags.push({ mesh, heldBy: null, falling: -1, vy: 0, gone: false });
    });
    this.createBoard();

    netLink.handlers.set(PacketType.Controls, (view) => {
      if (decodeControls(view, this.guestInput)) {
        this.guestInputAt = performance.now();
      }
    });
    this.cleanupFuncs.push(() => netLink.handlers.delete(PacketType.Controls));

    const debug: ControlsDebug = {
      test: (hold) => {
        if (hold.vent !== undefined) this.testHold.vent = hold.vent;
        if (hold.rudder !== undefined) this.testHold.rudder = hold.rudder;
      },
      local: () => ({ vent: this.localVent, rudder: this.localRudder, held: { ...this.hold } }),
      dropBag: (index) => {
        const bag = this.bags[index];
        if (bag && !bag.gone && bag.falling < 0) {
          this.letGoOverboard(bag, index);
        }
      },
      bags: () => this.bags.map((b) => ({ gone: b.gone, falling: b.falling >= 0, heldBy: b.heldBy })),
      lantern: () => ({ x: this.swing.x, z: this.swing.z }),
      boardText: () => [...this.board.lines],
    };
    (window as unknown as { __controls: ControlsDebug }).__controls = debug;
  }

  update(delta: number): void {
    const now = performance.now();
    const dt = Math.min(delta, 0.1);
    this.updateHands();

    const guest = netLink.connected && !netLink.isHost;
    if (guest) {
      this.sendLocal(dt, now);
    } else {
      this.combine(now);
    }
    this.updateBags(dt);
    this.draw(now, dt);
  }

  /** Take, work and let go of the controls with this player's hands. */
  private updateHands(): void {
    const busyFlags = (netLink.extraFlags.crank ?? 0) | (netLink.extraFlags.rope ?? 0);
    let vent = 0;
    let rudder: number | null = null;
    for (const side of SIDES) {
      const held = this.hold[side];
      const g = grip[side];
      this.player.gripSpaces[side].getWorldPosition(this.handPos);
      const p = this.handPos;
      if (held) {
        if (!g.pressed) {
          this.release(side, held, p);
          continue;
        }
        if (held === 'vent') {
          this.toggleY = toggleFromHand(p.y, this.toggleOffset[side]);
          vent = Math.max(vent, ventFromToggle(this.toggleY));
        } else if (held === 'tiller') {
          rudder = rudderFromHand(p.x, p.z);
        } else if (held === 'bell') {
          // Pull the lanyard to one side and the clapper strikes.
          this.lanyardEnd.copy(p);
          if (p.distanceTo(this.lanyardRest) > BELL_LANYARD_SLIP) {
            this.release(side, held, p);
          } else if (this.bellPull.step(p.x, p.z)) {
            bell.ring();
            this.pulse(side, 0.6, 60);
          }
        } else {
          // A bag hangs from the hand by its neck.
          const bag = this.bags[Number(held.slice(3))].mesh.position;
          bag.copy(p);
          bag.y -= 0.12;
        }
        continue;
      }
      const sideBusy = busyFlags & (side === 'left' ? FLAG_LEFT_CRANK | FLAG_LEFT_ROPE : FLAG_RIGHT_CRANK | FLAG_RIGHT_ROPE);
      if (!g.down || sideBusy) {
        continue;
      }
      const taken = this.reach(side, p);
      if (taken) {
        this.hold[side] = taken;
        this.pulse(side, 0.4, 30);
      }
    }
    if (this.testHold.vent !== null) {
      vent = Math.max(vent, this.testHold.vent);
      this.toggleY = VENT_TOGGLE[1] - this.testHold.vent * VENT_PULL;
    }
    if (this.testHold.rudder !== null) {
      rudder = this.testHold.rudder;
    }
    this.localVent = vent;
    this.localRudder = rudder;
  }

  /** The control within reach of a hand at `p` that isn't already held, nearest first. */
  private reach(side: Side, p: Vector3): string | null {
    const other = this.hold[side === 'left' ? 'right' : 'left'];
    let best: string | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    const handle = tillerHandle(flightInfo.rudder, this.tillerTmp);
    let d = Math.hypot(p.x - handle.x, p.y - handle.y, p.z - handle.z);
    if (d < TILLER_REACH && other !== 'tiller') {
      best = 'tiller';
      bestD = d;
    }
    d = Math.hypot(p.x - VENT_TOGGLE[0], p.y - this.toggleY, p.z - VENT_TOGGLE[2]);
    if (d < VENT_REACH && d < bestD && other !== 'vent') {
      best = 'vent';
      bestD = d;
    }
    d = p.distanceTo(this.lanyardEnd);
    if (flightInfo.flying && d < BELL_LANYARD_REACH && d < bestD && other !== 'bell') {
      best = 'bell';
      bestD = d;
    }
    let bagIndex = -1;
    for (let i = 0; i < this.bags.length; i++) {
      const bag = this.bags[i];
      d = bag.mesh.position.distanceTo(p);
      if (!bag.gone && bag.falling < 0 && !bag.heldBy && d < BALLAST_REACH && d < bestD) {
        best = `bag${i}`;
        bestD = d;
        bagIndex = i;
      }
    }
    if (best === 'vent') {
      this.toggleOffset[side] = p.y - this.toggleY;
    } else if (bagIndex >= 0 && best === `bag${bagIndex}`) {
      this.bags[bagIndex].heldBy = side;
    }
    return best;
  }

  private release(side: Side, held: string, p: Vector3): void {
    this.hold[side] = null;
    if (held === 'bell') {
      this.bellPull.reset();
    }
    if (held.startsWith('bag')) {
      const index = Number(held.slice(3));
      const bag = this.bags[index];
      bag.heldBy = null;
      if (overboard(p.x, p.z)) {
        this.letGoOverboard(bag, index);
      } else {
        // Back on its hook.
        const home = BALLAST_BAGS[index];
        bag.mesh.position.set(home[0], home[1], home[2]);
      }
    }
  }

  private letGoOverboard(bag: Bag, index: number): void {
    bag.falling = 0;
    bag.vy = 0;
    dropBallast(index);
  }

  /** Host or solo: combine both players' hands into the flight controls. */
  private combine(now: number): void {
    const fresh = netLink.connected && now - this.guestInputAt < GUEST_INPUT_MS;
    const g = this.guestInput;
    stations.vent = Math.max(this.localVent, fresh && g.flags & CONTROLS_FLAG_VENT ? g.vent : 0);
    if (this.localRudder !== null) {
      flightControls.rudder = this.localRudder;
    } else if (fresh && g.flags & CONTROLS_FLAG_TILLER) {
      flightControls.rudder = g.rudder;
    }

    // Trim from where the crew's heads are over the deck.
    this.player.head.getWorldPosition(this.headPos);
    this.crewX[0] = this.headPos.x;
    this.crewZ[0] = this.headPos.z;
    let count = 1;
    if (netLink.connected && netLink.haveRemote) {
      this.crewX[1] = netLink.remote.head.px;
      this.crewZ[1] = netLink.remote.head.pz;
      count = 2;
    }
    trimFromCrew(this.crewX, this.crewZ, count, this.trim);
    flightControls.trimPitch = this.trim.pitch;
    flightControls.trimRoll = this.trim.roll;
  }

  /** Guest: send what this player's hands are doing to the controls. */
  private sendLocal(dt: number, now: number): void {
    this.sendAccumulator += dt;
    if (this.sendAccumulator < 1 / SEND_HZ) {
      return;
    }
    this.sendAccumulator = Math.min(this.sendAccumulator - 1 / SEND_HZ, 1 / SEND_HZ);
    const o = this.outgoing;
    o.timeMs = now;
    o.flags = (this.localVent > 0 || this.hold.left === 'vent' || this.hold.right === 'vent' ? CONTROLS_FLAG_VENT : 0) |
      (this.localRudder !== null ? CONTROLS_FLAG_TILLER : 0);
    o.vent = this.localVent;
    o.rudder = this.localRudder ?? 0;
    netLink.send(this.sendBuffer, encodeControls(this.sendBuffer, o));
  }

  private updateBags(dt: number): void {
    const mask = flightInfo.ballastMask;
    for (let i = 0; i < this.bags.length; i++) {
      const bag = this.bags[i];
      // Dropped by the crewmate: fall from the hook.
      if (mask & (1 << i) && bag.falling < 0 && !bag.gone) {
        bag.falling = 0;
        bag.vy = 0;
        if (bag.heldBy) {
          this.hold[bag.heldBy] = null;
          bag.heldBy = null;
        }
      }
      // A new flight: back on the hook.
      if (!(mask & (1 << i)) && bag.gone) {
        bag.gone = false;
        bag.falling = -1;
        bag.mesh.visible = true;
        const home = BALLAST_BAGS[i];
        bag.mesh.position.set(home[0], home[1], home[2]);
      }
      if (bag.falling >= 0 && !bag.gone) {
        bag.falling += dt;
        bag.vy -= 9.81 * dt;
        bag.mesh.position.y += bag.vy * dt;
        bag.mesh.position.x += 0.4 * dt;
        if (bag.falling > BAG_FALL_SECONDS) {
          bag.gone = true;
          bag.mesh.visible = false;
        }
      }
    }
  }

  private draw(now: number, dt: number): void {
    // Tiller: in this player's hand, else as the host flies it.
    const rudder = this.localRudder ?? (netLink.connected && !netLink.isHost ? flightInfo.rudder : flightControls.rudder);
    this.tiller.rotation.y = -tillerAngle(rudder);

    // Vent toggle: in this player's hand, else as far as the vent is open.
    const holdingVent = this.hold.left === 'vent' || this.hold.right === 'vent' || this.testHold.vent !== null;
    if (!holdingVent) {
      this.toggleY = VENT_TOGGLE[1] - (flightInfo.flying ? flightInfo.ventOpen : 0) * VENT_PULL;
    }
    this.toggle.position.y = this.toggleY;
    this.cord.scale.y = VENT_CORD_TOP - this.toggleY - 0.02;
    this.updateLanyard(dt);

    // Flames flicker while the burner is lit.
    const lit = flightInfo.burner;
    for (let i = 0; i < this.flames.length; i++) {
      const flame = this.flames[i];
      flame.visible = lit;
      if (lit) {
        const base = i === 0 ? 1.3 : 2.2;
        const f = 0.85 + 0.15 * Math.sin(now * 0.031 + i * 2) * Math.sin(now * 0.017 + i);
        flame.scale.set(base * (1.05 - 0.1 * f), base * f * 1.15, base * (1.05 - 0.1 * f));
      }
    }
    if (lit) {
      const f = 0.8 + 0.2 * Math.sin(now * 0.023) * Math.sin(now * 0.041);
      this.fireGlow.material.color.setRGB(1, 0.42 * f, 0.08 * f);
    } else {
      this.fireGlow.material.color.setRGB(0.25, 0.06, 0.03);
    }

    // Lantern: a damped pendulum pulled towards the felt gravity's direction in ship space.
    const gy = Math.min(-0.1, ship.gy);
    const targetZ = Math.atan2(ship.gx, -gy);
    const targetX = -Math.atan2(ship.gz, -gy);
    const s = this.swing;
    s.vz += (-LANTERN_OMEGA2 * (s.z - targetZ) - LANTERN_DAMPING * s.vz) * dt;
    s.vx += (-LANTERN_OMEGA2 * (s.x - targetX) - LANTERN_DAMPING * s.vx) * dt;
    s.z += s.vz * dt;
    s.x += s.vx * dt;
    this.lantern.rotation.set(s.x, 0, s.z);

    if (now - this.lastBoardDraw > BOARD_REFRESH_MS) {
      this.lastBoardDraw = now;
      this.drawBoard();
    }
  }

  private createBoard(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 340;
    canvas.height = 220;
    const ctx = canvas.getContext('2d')!;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const face = new Mesh(new PlaneGeometry(BOARD_SIZE[0], BOARD_SIZE[1]), new MeshBasicMaterial({ map: texture, toneMapped: false }));
    face.name = 'Instrument Face';
    const frame = createBoardFrame(BOARD_SIZE[0], BOARD_SIZE[1]);
    // On the burner flue at eye height, facing the stern and the tiller.
    for (const mesh of [frame, face]) {
      mesh.position.set(BURNER_POSITION[0], 1.5, BURNER_POSITION[2] + 0.1);
      this.world.createTransformEntity(mesh);
    }
    face.position.z += 0.001;
    this.board = { ctx, texture, lines: [] };
  }

  private drawBoard(): void {
    const { ctx, texture } = this.board;
    const info = flightInfo;
    const climb = info.flying ? ship.vy : 0;
    const arrow = climb > 0.05 ? '▲' : climb < -0.05 ? '▼' : '■';
    const bags = BALLAST_BAGS.length;
    let dropped = 0;
    for (let i = 0; i < bags; i++) if (info.ballastMask & (1 << i)) dropped++;
    const lines = [
      `HEIGHT ${ship.y.toFixed(0)} m`,
      `CLIMB ${arrow} ${Math.abs(climb).toFixed(1)} m/s`,
      `SPEED ${ship.speed.toFixed(1)} m/s`,
      `BURNER ${info.burnLeft > 0 ? `${Math.ceil(info.burnLeft)} s` : 'out'}`,
      `BALLAST ${bags - dropped} of ${bags}`,
    ];
    // Only redraw when something shown has changed.
    if (lines.every((line, i) => line === this.board.lines[i])) {
      return;
    }
    this.board.lines = lines;
    ctx.fillStyle = '#efe3c4';
    ctx.fillRect(0, 0, 340, 220);
    ctx.strokeStyle = '#6a4428';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 334, 214);
    ctx.font = 'bold 30px monospace';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      ctx.fillStyle = i === 1 ? (climb > 0.05 ? '#2c6e2f' : climb < -0.05 ? '#a3321f' : '#3a2a1a') : i === 3 && info.burnLeft > 0 ? '#b35a12' : '#3a2a1a';
      ctx.fillText(line, 16, 14 + i * 40);
    });
    texture.needsUpdate = true;
  }

  /** The bell's lanyard: to the hand holding it, else swinging back to hang straight. Shown with the bell. */
  private updateLanyard(dt: number): void {
    const shown = flightInfo.flying;
    this.lanyard.visible = shown;
    this.bellToggle.visible = shown;
    if (this.hold.left !== 'bell' && this.hold.right !== 'bell') {
      this.lanyardEnd.lerp(this.lanyardRest, Math.min(1, LANYARD_SETTLE * dt));
    }
    if (!shown) {
      return;
    }
    const dir = this.lanyardDir.copy(this.lanyardEnd).sub(this.lanyard.position);
    const length = dir.length();
    this.lanyard.quaternion.copy(this.lanyardTurn.setFromUnitVectors(DOWN, dir.divideScalar(Math.max(length, 1e-4))));
    this.lanyard.scale.y = Math.max(0.01, length - 0.03);
    this.bellToggle.position.copy(this.lanyardEnd);
  }

  private pulse(side: Side, intensity: number, ms: number): void {
    const actuator = this.input.xr.gamepads[side]?.gamepad.hapticActuators?.[0] as
      | { pulse?: (value: number, duration: number) => Promise<boolean> }
      | undefined;
    void actuator?.pulse?.(intensity, ms)?.catch(() => undefined);
  }
}
