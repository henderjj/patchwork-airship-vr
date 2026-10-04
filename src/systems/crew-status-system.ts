import {
  CanvasTexture,
  createSystem,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import { type CrewStatus, crewPresence } from '../net/crew-presence.js';

/** How far in front of the player the sign floats, m, and how quickly it follows their gaze (per second). */
const SIGN_DISTANCE = 1.2;
const FOLLOW_RATE = 3;

interface CrewStatusDebug {
  readonly status: CrewStatus;
  readonly paused: boolean;
  readonly message: string;
  /** The sign is showing. */
  readonly signVisible: boolean;
  /** The last few statuses, oldest first, so tests can see short ones. */
  readonly history: CrewStatus[];
}

/**
 * Spike S10: while the shared game is on hold, a sign floats in front of the
 * player saying why ("Your crewmate stepped away", "Reconnecting..."). It
 * follows the head's heading slowly rather than being fixed to the face, so
 * it stays readable without feeling stuck to the eyes.
 */
export class CrewStatusSystem extends createSystem({}) {
  private sign!: Mesh;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private texture!: CanvasTexture;
  private shown: CrewStatus = 'solo';
  private history: CrewStatus[] = ['solo'];
  private placed = false;
  private headPos = new Vector3();
  private headQuat = new Quaternion();
  private scale = new Vector3();
  private forward = new Vector3();
  private target = new Vector3();

  init(): void {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 128;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    // Drawn over the scene so the gondola never hides it.
    const material = new MeshBasicMaterial({ map: this.texture, toneMapped: false, depthTest: false, transparent: true });
    this.sign = new Mesh(new PlaneGeometry(0.6, 0.15), material);
    this.sign.name = 'Crew Status Sign';
    this.sign.renderOrder = 10;
    this.sign.visible = false;
    this.world.createTransformEntity(this.sign);

    const self = this;
    (window as { __crew?: CrewStatusDebug }).__crew = {
      get status() { return crewPresence.status; },
      get paused() { return crewPresence.paused; },
      get message() { return crewPresence.message(); },
      get signVisible() { return self.sign.visible; },
      history: this.history,
    };
  }

  update(delta: number): void {
    const status = crewPresence.status;
    if (status !== this.shown) {
      this.shown = status;
      this.history.push(status);
      if (this.history.length > 16) {
        this.history.shift();
      }
      this.sign.visible = crewPresence.paused;
      this.placed = false;
      if (this.sign.visible) {
        this.draw(crewPresence.message());
      }
    }
    if (this.sign.visible) {
      this.follow(delta);
    }
  }

  private follow(delta: number): void {
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    const head = immersive ? this.player.head : this.camera;
    head.updateWorldMatrix(true, false);
    head.matrixWorld.decompose(this.headPos, this.headQuat, this.scale);
    // Level heading only, so looking down doesn't drag the sign into the floor.
    this.forward.set(0, 0, -1).applyQuaternion(this.headQuat);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) {
      this.forward.set(0, 0, -1);
    }
    this.forward.normalize();
    this.target.copy(this.headPos).addScaledVector(this.forward, SIGN_DISTANCE);
    if (this.placed) {
      this.sign.position.lerp(this.target, Math.min(1, FOLLOW_RATE * delta));
    } else {
      this.sign.position.copy(this.target);
      this.placed = true;
    }
    this.sign.lookAt(this.headPos.x, this.sign.position.y, this.headPos.z);
  }

  private draw(message: string): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, 512, 128);
    ctx.fillStyle = 'rgba(43, 29, 18, 0.92)';
    ctx.fillRect(0, 0, 512, 128);
    ctx.strokeStyle = '#c9a03a';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, 506, 122);
    ctx.fillStyle = '#f3e3c3';
    ctx.textAlign = 'center';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(message, 256, 58, 480);
    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#c9b48a';
    ctx.fillText('The ship waits until you are both back', 256, 96, 480);
    this.texture.needsUpdate = true;
  }
}
