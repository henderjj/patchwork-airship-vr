import {
  BufferAttribute,
  BufferGeometry,
  createSystem,
  type Entity,
  LineSegments,
  Mesh,
  OneHandGrabbable,
  PhysicsBody,
  PhysicsShape,
  PhysicsShapeType,
  PhysicsState,
  ShaderMaterial,
} from '@iwsdk/core';
import {
  createColliderBox,
  createFuelBrick,
  FUEL_BRICK_SIZE,
  FUEL_CRATE_POSITION,
  GONDOLA_COLLIDERS,
} from '../scene-assets/gondola.scene-asset.js';
import { createDummyAvatar } from '../scene-assets/avatar.scene-asset.js';
import { settings } from '../settings.js';

const RAIN_DROPS = 1800;
const RAIN_BOX = [9, 8, 11] as const;

/**
 * Sets up everything aboard the gondola that isn't authored in the scene:
 * static colliders (from GONDOLA_COLLIDERS, so mesh and physics share one
 * table), loose fuel bricks, the stress-test dummy avatars, and rain.
 */
export class GondolaSystem extends createSystem({}) {
  private avatars: Mesh[] = [];
  private rain: LineSegments | null = null;
  private rainMaterial: ShaderMaterial | null = null;
  readonly bricks: Entity[] = [];

  init(): void {
    for (const collider of GONDOLA_COLLIDERS) {
      const mesh = createColliderBox(collider.size);
      mesh.name = `Collider ${collider.name}`;
      mesh.position.set(...collider.center);
      const entity = this.world.createTransformEntity(mesh);
      entity.addComponent(PhysicsBody, { state: PhysicsState.Static });
      entity.addComponent(PhysicsShape, {
        shape: PhysicsShapeType.Box,
        dimensions: collider.size,
        friction: 0.7,
      });
    }
    this.spawnBricks(settings.bricks);
    this.spawnAvatars(settings.avatars);
    if (settings.rain) {
      this.spawnRain();
    }
  }

  /** Stack bricks in the fuel crate, spilling onto the deck beside it. */
  private spawnBricks(count: number): void {
    const [cx, , cz] = FUEL_CRATE_POSITION;
    const [bw, bh, bd] = FUEL_BRICK_SIZE;
    const perLayer = 6;
    for (let i = 0; i < count; i++) {
      const brick = createFuelBrick();
      brick.name = `Fuel Brick ${i + 1}`;
      const layer = Math.floor(i / perLayer);
      const slot = i % perLayer;
      const col = slot % 3;
      const row = Math.floor(slot / 3);
      brick.position.set(cx + (col - 1) * (bw + 0.01), 0.05 + bh / 2 + layer * (bh + 0.01), cz + (row - 0.5) * (bd + 0.02));
      const entity = this.world.createTransformEntity(brick);
      entity.addComponent(PhysicsBody, { state: PhysicsState.Dynamic, angularDamping: 0.2 });
      entity.addComponent(PhysicsShape, {
        shape: PhysicsShapeType.Box,
        dimensions: [bw, bh, bd],
        density: 900,
        friction: 0.6,
        restitution: 0.1,
      });
      entity.addComponent(OneHandGrabbable, {});
      this.bricks.push(entity);
    }
  }

  private spawnAvatars(count: number): void {
    const spots: [number, number, number][] = [
      [-0.5, 0, -0.6], [0.45, 0, 0.75], [-0.4, 0, 0.6], [0.5, 0, -0.7],
      [0, 0, 0.9], [0, 0, -0.9], [-0.6, 0, 0], [0.6, 0, 0.4],
    ];
    for (let i = 0; i < count; i++) {
      const avatar = createDummyAvatar(i);
      avatar.position.set(...spots[i % spots.length]);
      avatar.rotation.y = i % 2 ? Math.PI * 0.8 : -Math.PI * 0.2;
      this.world.createTransformEntity(avatar);
      this.avatars.push(avatar);
    }
  }

  private spawnRain(): void {
    const positions = new Float32Array(RAIN_DROPS * 2 * 3);
    const ends = new Float32Array(RAIN_DROPS * 2);
    let seed = 12345;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < RAIN_DROPS; i++) {
      const x = (random() - 0.5) * RAIN_BOX[0];
      const y = random() * RAIN_BOX[1];
      const z = (random() - 0.5) * RAIN_BOX[2];
      positions.set([x, y, z, x, y, z], i * 6);
      ends[i * 2] = 0;
      ends[i * 2 + 1] = 1;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('end', new BufferAttribute(ends, 1));
    this.rainMaterial = new ShaderMaterial({
      uniforms: { time: { value: 0 }, height: { value: RAIN_BOX[1] } },
      vertexShader: /* glsl */ `
        attribute float end;
        uniform float time;
        uniform float height;
        void main() {
          vec3 p = position;
          // Each drop falls at 9 m/s and wraps; the streak is 0.25 m long.
          p.y = mod(p.y - time * 9.0, height) - 1.0 + end * 0.25;
          p.x += end * 0.02;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        void main() { gl_FragColor = vec4(0.55, 0.62, 0.72, 1.0); }`,
    });
    this.rain = new LineSegments(geometry, this.rainMaterial);
    this.rain.name = 'Rain';
    this.rain.frustumCulled = false;
    this.world.createTransformEntity(this.rain);
  }

  update(_delta: number, time: number): void {
    for (let i = 0; i < this.avatars.length; i++) {
      // Idle sway so the avatars cost what a moving, skinned-free avatar would.
      const a = this.avatars[i];
      a.position.y = Math.sin(time * 1.3 + i) * 0.01;
      a.rotation.z = Math.sin(time * 0.7 + i) * 0.03;
    }
    if (this.rainMaterial) {
      this.rainMaterial.uniforms.time.value = time;
    }
  }
}
