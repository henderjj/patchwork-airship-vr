import {
  Color,
  createSystem,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import { breezeSpeed, DEFAULT_FLIGHT } from '../sim/flight.js';
import { rng } from '../sim/random.js';
import { jettyRoot } from '../sim/route.js';
import { type Draft, draftAt, GUST_WARNING, gustStrength } from '../sim/wind.js';
import { createCloudGeometry } from '../world/sky-assets.js';
import { createStreakGeometry, createWindSockGeometry, createWindSockPoleGeometry, SOCK_MAX_DROOP, SOCK_POLE } from '../world/wind-assets.js';
import { ROUTE } from '../world/route-world.js';
import { flightInfo, ship, wind } from './ship-system.js';

/** Streaks per draft, and how fast they rise or fall, m/s (faster than the air, so they read as a shimmer). */
const DRAFT_STREAKS = 64;
const DRAFT_STREAK_SPEED = 3;
/** Drafts further than this from the ship aren't updated, m (the fog hides them by then). */
const DRAFT_DRAW_DISTANCE = 400;
/** Streaks this close to the ship's middle are hidden, so none passes through the deck or a face, m. */
const CLEAR_OF_SHIP = 3.5;
/** Gust streaks at once, how fast they fly, m/s, and where they start upwind of the ship, m. */
const GUST_STREAKS = 48;
const GUST_STREAK_SPEED = 10;
const GUST_START: readonly [number, number] = [30, 46];
const GUST_SPREAD = 26;
/** A gust streak lives this long at most, s. */
const GUST_STREAK_LIFE = 8;
/** The wind that blows a sock straight out, m/s. */
const SOCK_FULL = 2;

// Warm gold rising and slate blue sinking: both stand out against the pale sky.
const UPDRAFT_COLOR = 0xffc65c;
const DOWNDRAFT_COLOR = 0x5d7799;

interface DraftView {
  draft: Draft;
  mesh: InstancedMesh;
  material: MeshBasicMaterial;
  x: Float32Array;
  z: Float32Array;
  phase: Float32Array;
}

interface Sock {
  sock: Mesh;
  x: number;
  z: number;
}

/** What the wind looks like right now, for tests and the perf HUD. */
export const windView = { draftsShown: 0, gustStreaks: 0, sockYaw: 0, sockDroop: 0 };

/**
 * Draws the wind (Phase 3, docs/wind.md) in the world, which moves with the
 * inverse of the ship's pose like the sky: streaks rising in each updraft
 * (with a puffy cloud on top, as over a real thermal) and falling in each
 * downdraft, the streaks of a gust's front coming across the sky from
 * upwind a few seconds before it blows and on through it, and a wind sock
 * on each landing island showing which way and how hard it blows. Everyone
 * draws their own, from the ship and the gust they share (the host's, on
 * the guest). Nothing is allocated per frame.
 */
export class WindSystem extends createSystem({}) {
  private root!: Group;
  private drafts: DraftView[] = [];
  private gusts!: InstancedMesh;
  private gustMaterial!: MeshBasicMaterial;
  private gustPos = new Float32Array(GUST_STREAKS * 3);
  private gustAge = new Float32Array(GUST_STREAKS).fill(-1);
  private gustId = -1;
  private gustTurn = new Quaternion();
  private socks: Sock[] = [];
  private random = rng(7919);
  private time = 0;
  private spawnDebt = 0;
  private shipQuat = new Quaternion();
  private matrix = new Matrix4();
  private pos = new Vector3();
  private scale = new Vector3();
  private up = new Vector3(0, 1, 0);
  private gustVel = { x: 0, z: 0 };

  init(): void {
    this.root = new Group();
    this.root.name = 'Wind';
    this.world.createTransformEntity(this.root, { persistent: true });

    const random = rng(4241);
    for (const draft of ROUTE.drafts) {
      const rising = draft.speed > 0;
      // Double-sided: each streak's two crossed quads must show from either side.
      const material = new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, opacity: 0.6, side: DoubleSide });
      const mesh = new InstancedMesh(createStreakGeometry(5, 0.4, rising ? UPDRAFT_COLOR : DOWNDRAFT_COLOR, true), material, DRAFT_STREAKS);
      mesh.name = rising ? 'Updraft' : 'Downdraft';
      mesh.frustumCulled = false;
      const view: DraftView = {
        draft,
        mesh,
        material,
        x: new Float32Array(DRAFT_STREAKS),
        z: new Float32Array(DRAFT_STREAKS),
        phase: new Float32Array(DRAFT_STREAKS),
      };
      for (let i = 0; i < DRAFT_STREAKS; i++) {
        const r = draft.radius * Math.sqrt(random());
        const a = random() * Math.PI * 2;
        view.x[i] = draft.x + Math.cos(a) * r;
        view.z[i] = draft.z + Math.sin(a) * r;
        view.phase[i] = random() * (draft.top - draft.bottom);
      }
      this.root.add(mesh);
      this.drafts.push(view);
      if (rising) {
        // A puffy cloud caps the rising air, as over a real thermal: it reads from far off.
        const cloud = new Mesh(createCloudGeometry(97), new MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: new Color(0x5a6470) }));
        cloud.name = 'Updraft Cloud';
        cloud.position.set(draft.x, draft.top + 7, draft.z);
        cloud.scale.set(draft.radius * 1.4, draft.radius * 0.8, draft.radius * 1.4);
        this.root.add(cloud);
      }
    }

    this.gustMaterial = new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, opacity: 0.5, side: DoubleSide });
    this.gusts = new InstancedMesh(createStreakGeometry(6, 0.2, 0xffffff, false), this.gustMaterial, GUST_STREAKS);
    this.gusts.name = 'Gust Streaks';
    this.gusts.frustumCulled = false;
    this.gusts.count = 0;
    this.root.add(this.gusts);

    // Wind socks on island A beside the pad (across from its flag), and on island B beside where the jetty leaves it.
    const poleMaterial = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const sockMaterial = new MeshLambertMaterial({ vertexColors: true, flatShading: true, side: DoubleSide });
    const a = ROUTE.start;
    const root = jettyRoot(ROUTE);
    const inX = ROUTE.finish.x - root.x;
    const inZ = ROUTE.finish.z - root.z;
    const inLen = Math.hypot(inX, inZ);
    const places: [number, number, number][] = [
      [a.x - a.padRadius - 1.5, a.y, a.z],
      [root.x + (inX / inLen) * 1.2 + (-inZ / inLen) * 2, ROUTE.finish.y, root.z + (inZ / inLen) * 1.2 + (inX / inLen) * 2],
    ];
    const poleGeometry = createWindSockPoleGeometry();
    const sockGeometry = createWindSockGeometry();
    for (const [x, y, z] of places) {
      const pole = new Mesh(poleGeometry, poleMaterial);
      pole.name = 'Wind Sock Pole';
      pole.position.set(x, y, z);
      const sock = new Mesh(sockGeometry, sockMaterial);
      sock.name = 'Wind Sock';
      sock.position.set(x, y + SOCK_POLE + 0.1, z);
      this.root.add(pole, sock);
      this.socks.push({ sock, x, z });
    }

    (window as { __windView?: unknown }).__windView = windView;
  }

  update(delta: number): void {
    const dt = Math.min(delta, 0.1);
    this.time += dt;
    // World = inverse(ship pose), as the sky does it.
    this.shipQuat.set(ship.qx, ship.qy, ship.qz, ship.qw).invert();
    this.root.quaternion.copy(this.shipQuat);
    this.root.position.set(ship.x, ship.y, ship.z).applyQuaternion(this.shipQuat).negate();
    this.root.visible = flightInfo.flying;
    if (!flightInfo.flying) {
      return;
    }
    this.updateDrafts();
    this.updateGust(dt);
    this.updateSocks();
  }

  private updateDrafts(): void {
    const scale = wind.scale;
    let shown = 0;
    for (const view of this.drafts) {
      const d = view.draft;
      const far = Math.hypot(d.x - ship.x, d.z - ship.z) - d.radius > DRAFT_DRAW_DISTANCE;
      view.mesh.visible = scale > 0 && !far;
      if (!view.mesh.visible) {
        continue;
      }
      shown++;
      view.material.opacity = 0.6 * Math.min(1, 0.4 + 0.6 * scale);
      const height = d.top - d.bottom;
      const travel = this.time * DRAFT_STREAK_SPEED * Math.sign(d.speed) * Math.min(1.5, 0.5 + 0.5 * scale);
      const m = view.mesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < DRAFT_STREAKS; i++) {
        let y = (view.phase[i] + travel) % height;
        if (y < 0) y += height;
        // Fade in and out at the column's ends.
        let s = Math.min(1, y / 8, (height - y) / 8);
        y += d.bottom;
        const x = view.x[i];
        const z = view.z[i];
        if (Math.abs(x - ship.x) < CLEAR_OF_SHIP && Math.abs(z - ship.z) < CLEAR_OF_SHIP && Math.abs(y - ship.y - 1) < CLEAR_OF_SHIP + 2) {
          s = 0;
        }
        const o = i * 16;
        m[o] = s;
        m[o + 1] = m[o + 2] = m[o + 3] = m[o + 4] = 0;
        m[o + 5] = s;
        m[o + 6] = m[o + 7] = m[o + 8] = m[o + 9] = 0;
        m[o + 10] = s;
        m[o + 11] = 0;
        m[o + 12] = x;
        m[o + 13] = y;
        m[o + 14] = z;
        m[o + 15] = 1;
      }
      view.mesh.instanceMatrix.needsUpdate = true;
    }
    windView.draftsShown = shown;
  }

  /** The gust's front: streaks spawned upwind of the ship from its warning on, flying downwind past it. */
  private updateGust(dt: number): void {
    const g = wind.gust;
    const t = ship.time;
    const warning = wind.warning(t);
    let intensity = 0;
    if (g && warning >= 0 && wind.scale > 0) {
      // Thin at first, then as thick as the gust is strong.
      intensity = warning > 0 ? 0.35 + 0.65 * (1 - warning / GUST_WARNING) : Math.max(0.15, gustStrength(g, t));
      intensity *= Math.min(1, 0.4 + 0.6 * wind.scale);
      if (g.id !== this.gustId) {
        this.gustId = g.id;
        // The streaks lie along the way it blows (their +X).
        this.gustTurn.setFromAxisAngle(this.up, Math.atan2(Math.cos(g.heading), -Math.sin(g.heading)));
      }
    }
    const dx = g ? -Math.sin(g.heading) : 0;
    const dz = g ? -Math.cos(g.heading) : 0;
    // Spawn enough to keep about `intensity` of the pool flying.
    this.spawnDebt += intensity * (GUST_STREAKS / (GUST_START[1] / GUST_STREAK_SPEED + 3)) * dt;
    let alive = 0;
    const p = this.gustPos;
    for (let i = 0; i < GUST_STREAKS; i++) {
      if (this.gustAge[i] < 0 && this.spawnDebt >= 1 && g) {
        this.spawnDebt -= 1;
        const back = GUST_START[0] + (GUST_START[1] - GUST_START[0]) * this.random();
        const side = (this.random() * 2 - 1) * GUST_SPREAD;
        let up = -4 + this.random() * 13;
        // Not through the deck or anyone's face.
        if (Math.abs(side) < CLEAR_OF_SHIP && up > -2 && up < 4) up += 6;
        p[i * 3] = ship.x - dx * back - dz * side;
        p[i * 3 + 1] = ship.y + up;
        p[i * 3 + 2] = ship.z - dz * back + dx * side;
        this.gustAge[i] = 0;
      }
      if (this.gustAge[i] < 0) {
        continue;
      }
      this.gustAge[i] += dt;
      p[i * 3] += dx * GUST_STREAK_SPEED * dt;
      p[i * 3 + 2] += dz * GUST_STREAK_SPEED * dt;
      const past = (p[i * 3] - ship.x) * dx + (p[i * 3 + 2] - ship.z) * dz;
      if (this.gustAge[i] > GUST_STREAK_LIFE || past > 35 || !g) {
        this.gustAge[i] = -1;
        continue;
      }
      const age = this.gustAge[i];
      const s = Math.min(1, age / 0.6, (GUST_STREAK_LIFE - age) / 0.6, (35 - past) / 6);
      this.pos.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      this.scale.set(s, 1, 1);
      this.matrix.compose(this.pos, this.gustTurn, this.scale);
      this.gusts.setMatrixAt(alive++, this.matrix);
    }
    this.spawnDebt = Math.min(this.spawnDebt, 4);
    this.gusts.count = alive;
    if (alive > 0) {
      this.gusts.instanceMatrix.needsUpdate = true;
    }
    windView.gustStreaks = alive;
  }

  /** The socks stream downwind, straighter the harder it blows, with a little flutter. */
  private updateSocks(): void {
    const breeze = breezeSpeed(DEFAULT_FLIGHT, ship.time) * wind.scale;
    wind.gustVelocity(ship.time, this.gustVel);
    const wx = -Math.sin(DEFAULT_FLIGHT.windHeading) * breeze + this.gustVel.x;
    const wz = -Math.cos(DEFAULT_FLIGHT.windHeading) * breeze + this.gustVel.z;
    const w = Math.hypot(wx, wz);
    const out = Math.min(1, w / SOCK_FULL);
    const droop = SOCK_MAX_DROOP * (1 - out * out * (3 - 2 * out));
    const flutter = 0.07 * Math.min(1, w) * Math.sin(this.time * 3.3);
    const yaw = w > 0.02 ? Math.atan2(-wz, wx) : 0;
    for (const s of this.socks) {
      s.sock.rotation.set(0, yaw + flutter, -droop - 0.04 * Math.min(1, w) * Math.sin(this.time * 2.1 + s.x));
    }
    windView.sockYaw = yaw;
    windView.sockDroop = droop;
  }
}

/** The vertical air at the ship, m/s at the wind setting in effect (for the route board). */
export function draftHere(): number {
  return draftAt(ROUTE.drafts, ship.x, ship.y, ship.z) * wind.scale;
}
