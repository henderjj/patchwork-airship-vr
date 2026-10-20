import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  createSystem,
  DoubleSide,
  Group,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import { settings } from '../settings.js';
import { breezeSpeed, DEFAULT_FLIGHT } from '../sim/flight.js';
import { LANTERN_HOOK } from '../sim/gondola-layout.js';
import { BAND_RAIL, fromPassage, windowMiddle } from '../sim/passages.js';
import { rng } from '../sim/random.js';
import { isNight, isStorm, SOUND_SPEED } from '../sim/weather.js';
import { ROUTE } from '../world/route-world.js';
import { sounds } from './audio-system.js';
import { flightInfo, ship, storm, wind } from './ship-system.js';

/** The sky eases from one weather to the next over about this long, s. */
const EASE_SECONDS = 8;
/** Rain: streaks in a box round the ship (across, up, along, m; its middle this high above the deck), how fast it falls and how long a streak is, m. */
const RAIN_DROPS = 1800;
const RAIN_BOX = [12, 9, 14] as const;
const RAIN_MIDDLE = 2.5;
const RAIN_FALL = 9;
const RAIN_STREAK = 0.35;
/** A strike older than this when it is heard of isn't shown (a guest joining after it), s. */
const STRIKE_FRESH = 3;
/** The bolt shows this long, s, and is drawn as this many jagged segments, this wide, from this high above the ship to this far below. */
const BOLT_SECONDS = 0.32;
const BOLT_SEGMENTS = 22;
const BRANCH_SEGMENTS = 6;
const BOLT_WIDTH = 2.6;
const BOLT_TOP = 140;
const BOLT_BOTTOM = 90;
/** The lamps on the route: how big their glow is, m. */
const LAMP_SIZE = 3.2;

type Vec3 = [number, number, number];

/**
 * How the weather looks right now, shared with SkyWorldSystem (which tints
 * the sky, fog, lights, clouds and rings with it): `night` and `storm` ease
 * from 0 to 1 and back as the weather changes, `flash` is a lightning
 * flash's brightness (0 to 1), `rain` how hard it is raining (0 to 1).
 * Tests set `holdBolt` to keep the last bolt showing for a screenshot.
 */
export const weatherView = { night: 0, storm: 0, flash: 0, rain: 0, lamps: 0, strikes: 0, bolt: false, holdBolt: false };

/**
 * What each player sees and hears of the weather (Phase 3 storms and night,
 * docs/storms-and-night.md), from the weather and the strikes they share
 * (the host's, on the guest): the rain round the ship, slanting with the
 * air's motion past it; lightning (a bolt, a flash, and thunder as long
 * after as sound takes); the rain's patter; and lamps glowing on the
 * route's rings, passages and islands when it is dark or stormy. Nothing
 * is allocated per frame.
 */
export class WeatherSystem extends createSystem({}) {
  private root!: Group;
  private rain!: LineSegments;
  private rainMaterial!: ShaderMaterial;
  private bolt!: Mesh;
  private boltMaterial!: MeshBasicMaterial;
  private boltPositions = new Float32Array((BOLT_SEGMENTS + 2 * BRANCH_SEGMENTS) * 6 * 3);
  private boltVertices = 0;
  private lamps!: Points;
  private lampMaterial!: PointsMaterial;
  private glow!: Points;
  private glowMaterial!: PointsMaterial;
  private seenStrike = -1;
  private strikeAt = Number.NEGATIVE_INFINITY;
  private strikeNear = 0;
  private random = rng(9173);
  private time = 0;
  private dt = 0;
  private shipQuat = new Quaternion();
  private air = new Vector3();
  private a = new Vector3();
  private b = new Vector3();
  private side = new Vector3();
  private toShip = new Vector3();
  private path: Vec3[] = [];
  private xz = { x: 0, z: 0 };

  init(): void {
    this.root = new Group();
    this.root.name = 'Weather';
    this.world.createTransformEntity(this.root, { persistent: true });
    this.createRain();
    this.createBolt();
    this.createLamps();
    for (let i = 0; i <= BOLT_SEGMENTS; i++) this.path.push([0, 0, 0]);
    const start = storm.weather;
    weatherView.night = isNight(start) ? 1 : 0;
    weatherView.storm = isStorm(start) ? 1 : 0;
    (window as { __weatherView?: unknown }).__weatherView = weatherView;
  }

  update(delta: number): void {
    const dt = Math.min(delta, 0.1);
    this.dt = dt;
    this.time += dt;
    const now = performance.now();
    // World = inverse(ship pose), as the sky does it.
    this.shipQuat.set(ship.qx, ship.qy, ship.qz, ship.qw).invert();
    this.root.quaternion.copy(this.shipQuat);
    this.root.position.set(ship.x, ship.y, ship.z).applyQuaternion(this.shipQuat).negate();

    const w = storm.weather;
    const step = dt / EASE_SECONDS;
    weatherView.night = approach(weatherView.night, isNight(w) ? 1 : 0, step);
    weatherView.storm = approach(weatherView.storm, isStorm(w) ? 1 : 0, step);
    weatherView.rain = settings.rain ? 1 : weatherView.storm;

    this.updateLightning(now);
    this.updateRain();
    sounds.setRain(weatherView.rain);
    // Lamps on the route while it is dark or murky (they are part of the route, shown in flight).
    weatherView.lamps = flightInfo.flying ? Math.min(1, Math.max(weatherView.night, weatherView.storm) * 1.5) : 0;
    this.lamps.visible = weatherView.lamps > 0.02;
    this.lampMaterial.opacity = weatherView.lamps;
    // The lantern's and the burner's glow at night.
    this.glow.visible = weatherView.night > 0.02;
    this.glowMaterial.opacity = weatherView.night * (0.6 + 0.08 * Math.sin(this.time * 9) * Math.sin(this.time * 3.7));
  }

  /** A new strike from the host (or this page's own): a bolt, a flash, and thunder after the sound's delay. */
  private updateLightning(now: number): void {
    const s = storm.strike;
    if (s && s.id !== this.seenStrike) {
      this.seenStrike = s.id;
      const age = ship.time - s.time;
      if (age >= -1 && age < STRIKE_FRESH) {
        this.strikeAt = now;
        this.strikeNear = Math.max(0.35, Math.min(1, 1.15 - s.distance / 420));
        weatherView.strikes++;
        this.layBolt(s.x, s.z);
        sounds.thunder(s.distance, s.distance / SOUND_SPEED - Math.max(0, age));
        console.info(`[Storm] lightning ${Math.round(s.distance)} m off`);
      }
    }
    // Two flickers, as real lightning flashes.
    const t = (now - this.strikeAt) / 1000;
    const flicker = t < 0 ? 0 : Math.exp(-t / 0.07) + (t > 0.16 ? 0.7 * Math.exp(-(t - 0.16) / 0.09) : 0);
    weatherView.flash = Math.min(1, flicker * this.strikeNear);
    weatherView.bolt = t < BOLT_SECONDS || weatherView.holdBolt;
    this.bolt.visible = weatherView.bolt;
    this.boltMaterial.opacity = Math.min(1, 0.4 + flicker);
  }

  /** The rain's streaks: moving with the air past the ship, at the rain's strength. */
  private updateRain(): void {
    const rain = weatherView.rain;
    this.rain.visible = rain > 0.02;
    if (!this.rain.visible) return;
    // The air's motion past the ship (the breeze and gust, less the ship's own motion), in ship space.
    const breeze = breezeSpeed(DEFAULT_FLIGHT, ship.time) * wind.scale;
    wind.gustVelocity(ship.time, this.xz);
    this.air.set(
      -Math.sin(DEFAULT_FLIGHT.windHeading) * breeze + this.xz.x - ship.vx,
      -RAIN_FALL - ship.vy,
      -Math.cos(DEFAULT_FLIGHT.windHeading) * breeze + this.xz.z - ship.vz,
    );
    this.air.applyQuaternion(this.shipQuat);
    const u = this.rainMaterial.uniforms;
    // The drops' drift so far, wrapped round the box here so it never grows large.
    const offset = u.offset.value as Vector3;
    offset.addScaledVector(this.air, Math.min(this.dt, 0.1));
    offset.set(wrap(offset.x, RAIN_BOX[0]), wrap(offset.y, RAIN_BOX[1]), wrap(offset.z, RAIN_BOX[2]));
    (u.direction.value as Vector3).copy(this.air).normalize();
    // Dimmer at night; lit up by a flash.
    u.opacity.value = rain * Math.min(1, 0.55 * (1 - 0.6 * weatherView.night) + weatherView.flash);
  }

  private createRain(): void {
    const positions = new Float32Array(RAIN_DROPS * 2 * 3);
    const ends = new Float32Array(RAIN_DROPS * 2);
    const random = rng(12345);
    for (let i = 0; i < RAIN_DROPS; i++) {
      const x = (random() - 0.5) * RAIN_BOX[0];
      const y = (random() - 0.5) * RAIN_BOX[1];
      const z = (random() - 0.5) * RAIN_BOX[2];
      positions.set([x, y, z, x, y, z], i * 6);
      ends[i * 2 + 1] = 1;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('end', new BufferAttribute(ends, 1));
    this.rainMaterial = new ShaderMaterial({
      uniforms: {
        offset: { value: new Vector3() },
        direction: { value: new Vector3(0, -1, 0) },
        box: { value: new Vector3(...RAIN_BOX) },
        middle: { value: RAIN_MIDDLE },
        streak: { value: RAIN_STREAK },
        opacity: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float end;
        uniform vec3 offset;
        uniform vec3 direction;
        uniform vec3 box;
        uniform float middle;
        uniform float streak;
        void main() {
          // Each drop moves with the air past the ship and wraps round the box;
          // its streak trails behind it along the way it moves.
          vec3 p = mod(position + offset + box * 0.5, box) - box * 0.5;
          p.y += middle;
          p -= direction * streak * end;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float opacity;
        void main() { gl_FragColor = vec4(0.62, 0.7, 0.8, opacity); }`,
    });
    this.rain = new LineSegments(geometry, this.rainMaterial);
    this.rain.name = 'Rain';
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    // In the gondola's space, so the box goes with the ship.
    this.world.createTransformEntity(this.rain);
  }

  private createBolt(): void {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.boltPositions, 3));
    geometry.setDrawRange(0, 0);
    this.boltMaterial = new MeshBasicMaterial({
      color: 0xeef4ff,
      fog: false,
      toneMapped: false,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    this.bolt = new Mesh(geometry, this.boltMaterial);
    this.bolt.name = 'Lightning';
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    this.root.add(this.bolt);
  }

  /** A jagged bolt from the clouds above world (x, z) down past the ship's height, with two branches, facing the ship. */
  private layBolt(x: number, z: number): void {
    const top = ship.y + BOLT_TOP;
    const bottom = ship.y - BOLT_BOTTOM;
    const p = this.path;
    let dx = 0;
    let dz = 0;
    for (let i = 0; i <= BOLT_SEGMENTS; i++) {
      const k = i / BOLT_SEGMENTS;
      p[i][0] = x + dx;
      p[i][1] = top + (bottom - top) * k;
      p[i][2] = z + dz;
      dx += (this.random() - 0.5) * 14;
      dz += (this.random() - 0.5) * 14;
    }
    this.boltVertices = 0;
    for (let i = 0; i < BOLT_SEGMENTS; i++) {
      this.quad(p[i], p[i + 1], BOLT_WIDTH * (1 - (0.5 * i) / BOLT_SEGMENTS));
    }
    // Two branches forking off part way down.
    for (const from of [Math.floor(BOLT_SEGMENTS * 0.3), Math.floor(BOLT_SEGMENTS * 0.55)]) {
      let [bx, by, bz] = p[from];
      const out = this.random() < 0.5 ? -1 : 1;
      for (let j = 0; j < BRANCH_SEGMENTS; j++) {
        const nx = bx + out * (4 + this.random() * 6);
        const ny = by - 5 - this.random() * 6;
        const nz = bz + (this.random() - 0.5) * 10;
        this.a.set(bx, by, bz);
        this.quad([bx, by, bz], [nx, ny, nz], BOLT_WIDTH * 0.45);
        bx = nx;
        by = ny;
        bz = nz;
      }
    }
    const geometry = this.bolt.geometry;
    geometry.setDrawRange(0, this.boltVertices);
    (geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    geometry.computeBoundingSphere();
  }

  /** One segment of the bolt: a flat strip from `from` to `to`, `width` across, turned to face the ship. */
  private quad(from: readonly number[], to: readonly number[], width: number): void {
    this.a.set(from[0], from[1], from[2]);
    this.b.set(to[0], to[1], to[2]);
    this.toShip.set(ship.x, ship.y, ship.z).sub(this.a);
    this.side.subVectors(this.b, this.a).cross(this.toShip).normalize().multiplyScalar(width / 2);
    const o = this.boltVertices * 3;
    const v = this.boltPositions;
    if (o + 18 > v.length) return;
    const corners = [
      [this.a, -1], [this.a, 1], [this.b, 1],
      [this.a, -1], [this.b, 1], [this.b, -1],
    ] as const;
    corners.forEach(([point, sign], i) => {
      v[o + i * 3] = point.x + this.side.x * sign;
      v[o + i * 3 + 1] = point.y + this.side.y * sign;
      v[o + i * 3 + 2] = point.z + this.side.z * sign;
    });
    this.boltVertices += 6;
  }

  /** The lamps on the route (world), and the lantern's and burner's glow on deck (ship space). */
  private createLamps(): void {
    const places: Vec3[] = [];
    for (const ring of ROUTE.rings) {
      const r = ring.radius + 1.6;
      const ax = Math.cos(ring.yaw);
      const az = -Math.sin(ring.yaw);
      places.push([ring.x, ring.y + r, ring.z], [ring.x, ring.y - r, ring.z], [ring.x + ax * r, ring.y, ring.z + az * r], [ring.x - ax * r, ring.y, ring.z - az * r]);
    }
    for (const p of ROUTE.passages) {
      const corners: [number, number, number][] =
        p.kind === 'cleft'
          ? // On the walls' lips at each end of the gorge.
            [-1, 1].flatMap((u) => [-1, 1].map((w) => [u * (p.half + 0.6), w * 14, p.floor + p.walls + 0.8] as [number, number, number]))
          : // On each leg's inner face, front and back, at the painted band.
            [-1, 1].flatMap((u) => [-1, 1].map((w) => [u * (p.half - 0.3), w * (p.thickness * p.deep + 0.2), windowMiddle(p) + BAND_RAIL] as [number, number, number]));
      for (const [u, w, y] of corners) {
        fromPassage(p, u, w, this.xz);
        places.push([p.x + this.xz.x, y, p.z + this.xz.z]);
      }
    }
    const a = ROUTE.start;
    for (let i = 0; i < 4; i++) {
      const angle = Math.PI / 4 + (i * Math.PI) / 2;
      places.push([a.x + Math.cos(angle) * (a.padRadius + 0.6), a.y + 0.5, a.z + Math.sin(angle) * (a.padRadius + 0.6)]);
    }
    places.push([ROUTE.dock.x, ROUTE.dock.y + ROUTE.dock.height + 0.6, ROUTE.dock.z]);
    const sprite = glowSprite();
    this.lampMaterial = new PointsMaterial({
      color: 0xffc46b,
      size: LAMP_SIZE,
      map: sprite,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
    });
    this.lamps = new Points(pointsGeometry(places), this.lampMaterial);
    this.lamps.name = 'Route Lamps';
    this.lamps.frustumCulled = false;
    this.lamps.visible = false;
    this.root.add(this.lamps);

    this.glowMaterial = new PointsMaterial({
      color: 0xffb35c,
      size: 0.35,
      map: sprite,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      toneMapped: false,
    });
    // The lantern's glass hangs about 0.3 m under its hook.
    this.glow = new Points(pointsGeometry([[LANTERN_HOOK[0], LANTERN_HOOK[1] - 0.3, LANTERN_HOOK[2]]]), this.glowMaterial);
    this.glow.name = 'Lantern Glow';
    this.glow.frustumCulled = false;
    this.glow.visible = false;
    this.world.createTransformEntity(this.glow);
  }
}

/** `value` wrapped into [-size/2, size/2). */
function wrap(value: number, size: number): number {
  return value - size * Math.floor(value / size + 0.5);
}

function approach(value: number, target: number, step: number): number {
  return value < target ? Math.min(target, value + step) : Math.max(target, value - step);
}

function pointsGeometry(places: readonly Vec3[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(places.flat()), 3));
  return geometry;
}

/** A soft round glow, white in the middle, for the lamps' points. */
function glowSprite(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new CanvasTexture(canvas);
}
