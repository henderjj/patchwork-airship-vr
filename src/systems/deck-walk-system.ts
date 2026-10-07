import {
  BackSide,
  Color,
  createSystem,
  CylinderGeometry,
  InputActions,
  Mesh,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import {
  clampStep,
  SNAP_TURN,
  turnAboutHead,
  WALK_DEAD_ZONE,
  WALK_HALF_LENGTH,
  WALK_HALF_WIDTH,
  WALK_SPEED,
} from '../sim/deck-walk.js';

/** Thumbstick deflection that counts as a snap turn (as IWSDK's). */
const TURN_THRESHOLD = 0.8;
/** How dark the comfort vignette gets at full stick. */
const VIGNETTE_STRENGTH = 0.5;

/**
 * Walking the deck in VR: left thumbstick slides the player in the direction
 * they face, right thumbstick snap turns about their head. Replaces IWSDK's
 * locomotion, whose collision capsule sits at the play-space origin rather
 * than the head (see src/sim/deck-walk.ts). The gondola never moves in
 * tracking space, so the deck is a fixed rectangle and needs no physics.
 */
export class DeckWalkSystem extends createSystem({}) {
  private stick = { x: 0, y: 0 };
  private head = new Vector3();
  private headQuat = new Quaternion();
  private forward = new Vector3();
  private turned: [number, number] = [0, 0];
  private vignette!: Mesh<CylinderGeometry, ShaderMaterial>;

  init(): void {
    this.vignette = createVignette();
    this.camera.add(this.vignette);
    this.cleanupFuncs.push(() => {
      this.vignette.removeFromParent();
      this.vignette.geometry.dispose();
      this.vignette.material.dispose();
    });
    (window as { __deckWalk?: unknown }).__deckWalk = {
      bounds: { halfWidth: WALK_HALF_WIDTH, halfLength: WALK_HALF_LENGTH },
      head: () => this.player.head.getWorldPosition(new Vector3()).toArray(),
    };
  }

  update(delta: number): void {
    const alpha = this.vignette.material.uniforms.uAlpha;
    if (!this.world.session) {
      alpha.value = 0;
      this.vignette.visible = false;
      return;
    }
    const actions = this.input.actions;
    const player = this.player;
    player.head.getWorldPosition(this.head);

    if (actions.getAxis1DEnteringNegative(InputActions.LocomotionTurn, TURN_THRESHOLD)) {
      this.turn(SNAP_TURN);
    } else if (actions.getAxis1DEnteringPositive(InputActions.LocomotionTurn, TURN_THRESHOLD)) {
      this.turn(-SNAP_TURN);
    }

    actions.getAxis2D(InputActions.LocomotionMove, this.stick);
    const tilt = Math.min(1, Math.hypot(this.stick.x, this.stick.y));
    let target = 0;
    if (tilt > WALK_DEAD_ZONE) {
      // Stick up (y < 0) walks the way the head faces, flattened onto the deck.
      player.head.getWorldQuaternion(this.headQuat);
      this.forward.set(0, 0, -1).applyQuaternion(this.headQuat);
      const flat = Math.hypot(this.forward.x, this.forward.z);
      if (flat > 1e-3) {
        const fx = this.forward.x / flat;
        const fz = this.forward.z / flat;
        // Right is forward turned a quarter clockwise seen from above.
        const along = -this.stick.y / tilt;
        const across = this.stick.x / tilt;
        const step = WALK_SPEED * tilt * delta;
        const dx = (fx * along - fz * across) * step;
        const dz = (fz * along + fx * across) * step;
        player.position.x += clampStep(this.head.x, dx, WALK_HALF_WIDTH);
        player.position.z += clampStep(this.head.z, dz, WALK_HALF_LENGTH);
        target = tilt * VIGNETTE_STRENGTH;
      }
    }
    alpha.value += (target - alpha.value) * Math.min(1, delta * 10);
    this.vignette.visible = alpha.value > 0.002;
  }

  private turn(angle: number): void {
    const player = this.player;
    turnAboutHead(player.position.x, player.position.z, this.head.x, this.head.z, angle, this.turned);
    player.rotateY(angle);
    player.position.x = this.turned[0];
    player.position.z = this.turned[1];
  }
}

/** A soft dark ring round the edge of view while walking, for comfort (like IWSDK's slide vignette). */
function createVignette(): Mesh<CylinderGeometry, ShaderMaterial> {
  const mesh = new Mesh(
    new CylinderGeometry(0.3, 0.15, 0.3, 16, 1, true),
    new ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uAlpha;
        varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(uColor, uAlpha * vUv.y);
        }`,
      uniforms: { uColor: { value: new Color(0x000000) }, uAlpha: { value: 0 } },
      depthTest: false,
      side: BackSide,
      transparent: true,
    }),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = 999;
  mesh.rotateX(Math.PI / 2);
  mesh.position.z = -0.15;
  return mesh;
}
