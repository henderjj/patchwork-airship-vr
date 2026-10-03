import {
  createSystem,
  type Entity,
  Grabbed,
  PhysicsBody,
  PhysicsManipulation,
  PhysicsSystem,
} from '@iwsdk/core';
import { ReleaseVelocityTracker } from '../sim/release-velocity.js';

/**
 * Sets a thrown object's velocity from how the hand actually moved over the
 * last ~80 ms, instead of the velocity Havok was left with while it chased the
 * grab target.
 *
 * Why: IWSDK drives a held body with a per-frame target transform, but the
 * physics worker can take several fixed steps per rendered frame. Only the
 * first step sees the target, so after any slow frame the held body carries a
 * spurious velocity (metres per second while the hand is still), and letting
 * go then flings it. Measured in the emulator at 15 fps: −6 m/s while held
 * still, 13 m/s on release. On Quest at 90 Hz this happens after any dropped
 * frame. Worse, the body can end up far from the hand it was chasing (in
 * the emulator, under the deck), so on release the body is first put back
 * where the player sees the object. The same release velocity is what the
 * network layer will send for throws (spike S7).
 */
export class ThrowSystem extends createSystem({
  held: { required: [PhysicsBody, Grabbed] },
}) {
  private trackers = new Map<Entity, ReleaseVelocityTracker>();
  private velocity: [number, number, number] = [0, 0, 0];
  private physics: PhysicsSystem | undefined;

  init(): void {
    this.physics = this.world.getSystem(PhysicsSystem);
    this.queries.held.subscribe('qualify', (entity) => {
      let tracker = this.trackers.get(entity);
      if (!tracker) {
        tracker = new ReleaseVelocityTracker();
        this.trackers.set(entity, tracker);
      }
      tracker.reset();
    });
    this.queries.held.subscribe('disqualify', (entity) => {
      const tracker = this.trackers.get(entity);
      if (!tracker || !entity.object3D || !entity.hasComponent(PhysicsBody)) {
        return;
      }
      const p = entity.object3D.position;
      tracker.push(performance.now(), p.x, p.y, p.z);
      this.physics?.setBodyTransform(entity, { position: p, quaternion: entity.object3D.quaternion });
      tracker.velocity(this.velocity);
      const v = this.velocity;
      // A zero vector is ignored by PhysicsManipulation, so a still release
      // sends a negligible velocity instead to overwrite Havok's.
      if (v[0] === 0 && v[1] === 0 && v[2] === 0) {
        v[1] = -1e-4;
      }
      entity.addComponent(PhysicsManipulation, { linearVelocity: v, angularVelocity: [0, 0, 1e-4] });
    });
  }

  update(): void {
    const now = performance.now();
    for (const entity of this.queries.held.entities) {
      const p = entity.object3D?.position;
      if (p) {
        this.trackers.get(entity)?.push(now, p.x, p.y, p.z);
      }
    }
  }
}
