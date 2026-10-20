import { createSystem, type Entity, Mesh, PhysicsBody, PhysicsShape, PhysicsShapeType, PhysicsState } from '@iwsdk/core';
import {
  createColliderBox,
  createFuelBrick,
  FUEL_BRICK_SIZE,
  FUEL_CRATE_POSITION,
  GONDOLA_COLLIDERS,
} from '../scene-assets/gondola.scene-asset.js';
import { createDummyAvatar } from '../scene-assets/avatar.scene-asset.js';
import { settings } from '../settings.js';


/**
 * Sets up everything aboard the gondola that isn't authored in the scene:
 * static colliders (from GONDOLA_COLLIDERS, so mesh and physics share one
 * table), loose fuel bricks (held and thrown through ThrowablesSystem), the
 * stress-test dummy avatars (the rain is WeatherSystem's).
 */
export class GondolaSystem extends createSystem({}) {
  private avatars: Mesh[] = [];
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
  }

  /** Stack bricks in the fuel crate, spilling onto the deck beside it. */
  private spawnBricks(count: number): void {
    const [cx, cy, cz] = FUEL_CRATE_POSITION;
    const [bw, bh, bd] = FUEL_BRICK_SIZE;
    const perLayer = 6;
    for (let i = 0; i < count; i++) {
      const brick = createFuelBrick();
      brick.name = `Fuel Brick ${i + 1}`;
      const layer = Math.floor(i / perLayer);
      const slot = i % perLayer;
      const col = slot % 3;
      const row = Math.floor(slot / 3);
      brick.position.set(cx + (col - 1) * (bw + 0.01), cy + 0.05 + bh / 2 + layer * (bh + 0.01), cz + (row - 0.5) * (bd + 0.02));
      const entity = this.world.createTransformEntity(brick);
      entity.addComponent(PhysicsBody, { state: PhysicsState.Dynamic, angularDamping: 0.2 });
      entity.addComponent(PhysicsShape, {
        shape: PhysicsShapeType.Box,
        dimensions: [bw, bh, bd],
        density: 900,
        friction: 0.6,
        restitution: 0.1,
      });
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

  update(_delta: number, time: number): void {
    for (let i = 0; i < this.avatars.length; i++) {
      // Idle sway so the avatars cost what a moving, skinned-free avatar would.
      const a = this.avatars[i];
      a.position.y = Math.sin(time * 1.3 + i) * 0.01;
      a.rotation.z = Math.sin(time * 0.7 + i) * 0.03;
    }
  }
}
