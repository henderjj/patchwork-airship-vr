import {
  type BufferGeometry,
  Color,
  createSystem,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from '@iwsdk/core';
import { settings } from '../settings.js';
import {
  createCloudGeometry,
  createIslandVariant,
  createSkyDomeGeometry,
  type IslandVariant,
  SKY_DOME_SIDE,
  SKY_HORIZON,
} from '../world/sky-assets.js';
import { ISLAND_VARIANTS, islandVariantSeed } from '../sim/islands.js';
import { rng } from '../sim/random.js';
import { wrapNear } from '../sim/world-tile.js';
import { createBeaconLampGeometry, createBeaconMastGeometry, createLandingIslandGeometry, createRingGeometry } from '../world/route-assets.js';
import { ROUTE, sceneryIslands } from '../world/route-world.js';
import { flightInfo, route, ship } from './ship-system.js';

const CLOUD_VARIANTS = 3;
/** Islands nearer than this (m) use the detailed mesh. */
const LOD_DISTANCE = 220;
const LOD_INTERVAL_FRAMES = 15;
const SKY_RADIUS = 1000;
/** Island B's beacon mast height, m, and the tint of a ring flown through. */
const BEACON_HEIGHT = 22;
const PASSED_TINT = 0x7be07b;
const SUN_DIRECTION = new Vector3(0.45, 0.8, 0.3).normalize();

interface Placement {
  position: Vector3;
  scale: Vector3;
  rotationY: number;
  variant: number;
}

/**
 * Builds the world outside the gondola (sky dome, islands, clouds, sun) and
 * moves it with the inverse of the ship's pose every frame, so the gondola
 * stays fixed in the player's tracking space while the world flies past.
 *
 * Islands are instanced per shape and per level of detail, so the whole sky
 * costs about a dozen draw calls regardless of how many islands there are.
 */
export class SkyWorldSystem extends createSystem({}) {
  private worldRoot!: Group;
  private sky!: Mesh;
  private sun!: DirectionalLight;
  private islands: Placement[] = [];
  private clouds: Placement[] = [];
  private cloudMeshes: InstancedMesh[] = [];
  private islandMeshes: { high: InstancedMesh; low: InstancedMesh }[] = [];
  private route!: Group;
  private rings: Mesh[] = [];
  private shownRings = 0;
  private frame = 0;
  private shipQuat = new Quaternion();
  private inverseQuat = new Quaternion();
  private shipPos = new Vector3();
  private tmpMatrix = new Matrix4();
  private tmpQuat = new Quaternion();
  private tmpVec = new Vector3();
  private worldUp = new Vector3(0, 1, 0);

  init(): void {
    this.scene.fog = new Fog(SKY_HORIZON.getHex(), 180, 950);

    this.worldRoot = new Group();
    this.worldRoot.name = 'WorldRoot';
    this.world.createTransformEntity(this.worldRoot, { persistent: true });

    const skyMaterial = new MeshBasicMaterial({
      vertexColors: true,
      side: SKY_DOME_SIDE,
      fog: false,
      depthWrite: false,
    });
    this.sky = new Mesh(createSkyDomeGeometry(SKY_RADIUS), skyMaterial);
    this.sky.name = 'SkyDome';
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.world.createTransformEntity(this.sky, { persistent: true });

    const hemi = new HemisphereLight(0xdfeeff, 0x8a7a66, 1.6);
    this.world.createTransformEntity(hemi, { persistent: true });
    this.sun = new DirectionalLight(0xfff1dc, 1.8);
    this.sun.castShadow = settings.shadows;
    if (settings.shadows) {
      this.renderer.shadowMap.enabled = true;
      const cam = this.sun.shadow.camera;
      cam.left = -2.5;
      cam.right = 2.5;
      cam.top = 2.5;
      cam.bottom = -2.5;
      cam.near = 1;
      cam.far = 40;
      this.sun.shadow.mapSize.set(1024, 1024);
    }
    this.world.createTransformEntity(this.sun, { persistent: true });
    this.world.createTransformEntity(this.sun.target, { persistent: true });

    this.buildIslands();
    this.buildClouds();
    this.buildRoute();
    this.update();
  }

  private buildIslands(): void {
    const variants: IslandVariant[] = [];
    for (let v = 0; v < ISLAND_VARIANTS; v++) {
      variants.push(createIslandVariant(islandVariantSeed(settings.seed, v)));
    }
    for (const island of sceneryIslands) {
      this.islands.push({
        position: new Vector3(island.x, island.y, island.z),
        scale: new Vector3(island.radius, island.height, island.radius),
        rotationY: island.rotationY,
        variant: island.variant,
      });
    }
    const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const perVariant = new Array(ISLAND_VARIANTS).fill(0);
    for (const island of this.islands) {
      perVariant[island.variant]++;
    }
    for (let v = 0; v < ISLAND_VARIANTS; v++) {
      const count = Math.max(1, perVariant[v]);
      const high = this.instanced(variants[v].high, material, count, `Islands${v}High`);
      const low = this.instanced(variants[v].low, material, count, `Islands${v}Low`);
      this.islandMeshes.push({ high, low });
    }
  }

  /** The route's islands, rings and beacon, shown while the crew flies the ship (`?motion=flight`). */
  private buildRoute(): void {
    this.route = new Group();
    this.route.name = 'Route';
    this.worldRoot.add(this.route);
    const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const islands: [typeof ROUTE.start, number][] = [
      [ROUTE.start, 0x3f8f4a],
      [ROUTE.finish, 0xd8452f],
    ];
    islands.forEach(([island, flag], i) => {
      const mesh = new Mesh(createLandingIslandGeometry(island, flag, settings.seed + i), material);
      mesh.name = `Island ${island.name}`;
      mesh.position.set(island.x, island.y, island.z);
      this.route.add(mesh);
    });
    for (const [i, ring] of ROUTE.rings.entries()) {
      // Each ring has its own material so it can turn green once flown through.
      const mesh = new Mesh(createRingGeometry(ring.radius), new MeshLambertMaterial({ vertexColors: true, emissive: new Color(0x3a2a20) }));
      mesh.name = `Ring ${i + 1}`;
      mesh.position.set(ring.x, ring.y, ring.z);
      mesh.rotation.y = ring.yaw;
      this.route.add(mesh);
      this.rings.push(mesh);
    }
    // Island B's beacon, on its rim on the side facing the way in.
    const b = ROUTE.finish;
    const mast = new Mesh(createBeaconMastGeometry(BEACON_HEIGHT), material);
    mast.name = 'Beacon Mast';
    mast.position.set(b.x + b.radius * 0.55, b.y, b.z + b.radius * 0.3);
    const lamp = new Mesh(createBeaconLampGeometry(), new MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false }));
    lamp.name = 'Beacon Lamp';
    lamp.position.copy(mast.position);
    lamp.position.y += BEACON_HEIGHT + 1.4;
    this.route.add(mast, lamp);
    this.route.visible = false;
  }

  /** Show the route while flying, and colour the rings already flown through. */
  private updateRoute(): void {
    this.route.visible = flightInfo.flying;
    if (route.ringMask === this.shownRings) {
      return;
    }
    this.shownRings = route.ringMask;
    this.rings.forEach((ring, i) => {
      (ring.material as MeshLambertMaterial).color.setHex(route.ringMask & (1 << i) ? PASSED_TINT : 0xffffff);
    });
  }

  private buildClouds(): void {
    const random = rng(settings.seed * 211 + 9);
    const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: new Color(0x5a6470) });
    const meshes: InstancedMesh[] = [];
    const perVariant = Math.ceil(settings.clouds / CLOUD_VARIANTS);
    for (let v = 0; v < CLOUD_VARIANTS && settings.clouds > 0; v++) {
      meshes.push(this.instanced(createCloudGeometry(settings.seed * 3 + v), material, perVariant, `Clouds${v}`));
      meshes[v].count = 0;
    }
    for (let i = 0; i < settings.clouds; i++) {
      const angle = random() * Math.PI * 2;
      const distance = 25 + Math.pow(random(), 0.7) * 650;
      const size = 10 + random() * 30;
      this.clouds.push({
        position: new Vector3(Math.cos(angle) * distance, 70 + random() * 110, Math.sin(angle) * distance),
        rotationY: random() * Math.PI * 2,
        scale: new Vector3(size, size * (0.6 + random() * 0.5), size * (0.6 + random() * 0.4)),
        variant: i % CLOUD_VARIANTS,
      });
    }
    this.cloudMeshes = meshes;
  }

  private instanced(geometry: BufferGeometry, material: MeshLambertMaterial, count: number, name: string): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, count);
    mesh.name = name;
    // The sky surrounds the player, so per-mesh culling would rarely skip anything.
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.worldRoot.add(mesh);
    return mesh;
  }

  /** Re-bucket islands into near and far meshes by distance from the ship. */
  private updateIslandLod(): void {
    for (const pair of this.islandMeshes) {
      pair.high.count = 0;
      pair.low.count = 0;
    }
    for (const island of this.islands) {
      const p = this.wrapped(island.position);
      const dx = p.x - ship.x;
      const dy = p.y - ship.y;
      const dz = p.z - ship.z;
      const near = dx * dx + dy * dy + dz * dz < LOD_DISTANCE * LOD_DISTANCE;
      const pair = this.islandMeshes[island.variant];
      this.place(near ? pair.high : pair.low, island);
    }
    for (const pair of this.islandMeshes) {
      pair.high.instanceMatrix.needsUpdate = true;
      pair.low.instanceMatrix.needsUpdate = true;
    }
  }

  /** Put the clouds in the copy of the world tile nearest the ship. */
  private updateClouds(): void {
    for (const mesh of this.cloudMeshes) {
      mesh.count = 0;
    }
    for (const cloud of this.clouds) {
      this.wrapped(cloud.position);
      this.place(this.cloudMeshes[cloud.variant], cloud);
    }
    for (const mesh of this.cloudMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** `position` moved by whole world tiles to within half a tile of the ship, in `tmpVec`. */
  private wrapped(position: Vector3): Vector3 {
    return this.tmpVec.set(wrapNear(position.x, ship.x), position.y, wrapNear(position.z, ship.z));
  }

  /** Add an instance of `placement` at `tmpVec` to `mesh`. */
  private place(mesh: InstancedMesh, placement: Placement): void {
    this.tmpQuat.setFromAxisAngle(this.worldUp, placement.rotationY);
    this.tmpMatrix.compose(this.tmpVec, this.tmpQuat, placement.scale);
    mesh.setMatrixAt(mesh.count++, this.tmpMatrix);
  }

  update(): void {
    // World = inverse(ship pose): rotate by q⁻¹ and translate by −q⁻¹·p.
    this.shipQuat.set(ship.qx, ship.qy, ship.qz, ship.qw);
    this.inverseQuat.copy(this.shipQuat).invert();
    this.shipPos.set(ship.x, ship.y, ship.z).applyQuaternion(this.inverseQuat).negate();
    this.worldRoot.position.copy(this.shipPos);
    this.worldRoot.quaternion.copy(this.inverseQuat);

    // The sky dome is infinitely far away: it only rotates.
    this.sky.quaternion.copy(this.inverseQuat);

    // Sun direction in ship space; the shadow box stays on the gondola.
    this.sun.position.copy(SUN_DIRECTION).applyQuaternion(this.inverseQuat).multiplyScalar(20);
    this.sun.target.position.set(0, 0, 0);

    this.updateRoute();
    if (this.frame++ % LOD_INTERVAL_FRAMES === 0) {
      this.updateIslandLod();
      this.updateClouds();
    }
  }
}
