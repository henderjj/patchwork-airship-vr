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
import { rng } from '../scene-assets/lowpoly.js';
import { settings } from '../settings.js';
import {
  createCloudGeometry,
  createIslandVariant,
  createSkyDomeGeometry,
  type IslandVariant,
  SKY_DOME_SIDE,
  SKY_HORIZON,
} from '../world/sky-assets.js';
import { wrapNear } from '../sim/world-tile.js';
import { ship } from './ship-system.js';

const ISLAND_VARIANTS = 4;
const CLOUD_VARIANTS = 3;
/** Islands nearer than this (m) use the detailed mesh. */
const LOD_DISTANCE = 220;
const LOD_INTERVAL_FRAMES = 15;
const SKY_RADIUS = 1000;
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
    this.update();
  }

  private buildIslands(): void {
    const random = rng(settings.seed * 101 + 5);
    const variants: IslandVariant[] = [];
    for (let v = 0; v < ISLAND_VARIANTS; v++) {
      variants.push(createIslandVariant(settings.seed * 10 + v));
    }
    for (let i = 0; i < settings.islands; i++) {
      const angle = random() * Math.PI * 2;
      // Near islands first so a small count still frames the ship nicely.
      const distance = 60 + Math.pow(random(), 0.8) * 600;
      const radius = 8 + random() * 26;
      this.islands.push({
        position: new Vector3(Math.cos(angle) * distance, 25 + random() * 75, Math.sin(angle) * distance),
        scale: new Vector3(radius, radius * (0.8 + random() * 0.6), radius),
        rotationY: random() * Math.PI * 2,
        variant: i % ISLAND_VARIANTS,
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

    if (this.frame++ % LOD_INTERVAL_FRAMES === 0) {
      this.updateIslandLod();
      this.updateClouds();
    }
  }
}
