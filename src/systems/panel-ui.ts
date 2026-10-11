import { type Entity, type Object3D, Quaternion, type UIKitMLAsset, Vector3 } from '@iwsdk/core';

/**
 * A UIKitML panel the game shows and hides: the start screen and the game
 * menu. Each is a scene node with RayInteractable (clicked with a controller
 * ray in VR, or the mouse on the flat page) and ScreenSpace (pinned to the
 * flat page's screen outside VR; in VR it stands where `place` puts it).
 *
 * Hidden panels keep their size (UIKit `visibility`, which also turns off
 * their pointer events), so ScreenSpace never lays out an empty document.
 * Clicks go through `on`, so tests can press the same handlers by id.
 */
export class PanelUi {
  readonly handlers = new Map<string, () => void>();
  private texts = new Map<string, string>();
  private shown = new Map<string, boolean>();
  private isVisible = true;
  private headPos = new Vector3();
  private headQuat = new Quaternion();
  private scale = new Vector3();
  private forward = new Vector3();
  private toPanel = new Vector3();

  constructor(
    readonly asset: UIKitMLAsset,
    readonly entity: Entity,
    private readonly rootId: string,
    private readonly cleanups: (() => void)[],
  ) {
    // Drawn over the world, as the game's floating signs are, so the
    // gondola's controls and rigging never cut through it in VR.
    asset.getElementById(rootId)?.setProperties({ depthTest: false, renderOrder: 20 });
  }

  /** The panel's placed object (its position in VR). */
  get object(): Object3D {
    return this.entity.object3D!;
  }

  get visible(): boolean {
    return this.isVisible;
  }

  /** Call `handler` when element `id` is clicked. */
  on(id: string, handler: () => void): void {
    const element = this.asset.getElementById(id);
    if (element == null) {
      console.warn(`[UI] no element ${id}`);
      return;
    }
    const listener = () => handler();
    element.addEventListener('click', listener);
    this.handlers.set(id, handler);
    this.cleanups.push(() => element.removeEventListener('click', listener));
  }

  /** Press element `id` as a click would (tests). */
  click(id: string): boolean {
    const handler = this.handlers.get(id);
    handler?.();
    return handler !== undefined;
  }

  /** Set element `id`'s text, if it changed. */
  setText(id: string, text: string): void {
    if (this.texts.get(id) === text) {
      return;
    }
    this.texts.set(id, text);
    this.asset.getElementById(id)?.setProperties({ text });
  }

  /** The text last set on element `id` (tests). */
  text(id: string): string | undefined {
    return this.texts.get(id);
  }

  /** Show or hide element `id`, if that changed. */
  show(id: string, visible: boolean): void {
    if (this.shown.get(id) === visible) {
      return;
    }
    this.shown.set(id, visible);
    this.asset.getElementById(id)?.setProperties({ display: visible ? 'flex' : 'none' });
  }

  /** Whether element `id` was last shown (true if never set). */
  isShown(id: string): boolean {
    return this.shown.get(id) ?? true;
  }

  /** Show or hide the whole panel. */
  setVisible(visible: boolean): void {
    if (visible === this.isVisible) {
      return;
    }
    this.isVisible = visible;
    this.asset.getElementById(this.rootId)?.setProperties({ visibility: visible ? 'visible' : 'hidden' });
    this.object.visible = visible;
  }

  /**
   * Stand the panel `distance` m in front of `head` and `drop` m below eye
   * level, facing it, using only the head's heading so looking down doesn't
   * put the panel in the floor.
   */
  place(head: Object3D, distance: number, drop: number): void {
    this.readHead(head);
    const object = this.object;
    object.position.copy(this.headPos).addScaledVector(this.forward, distance);
    object.position.y -= drop;
    // A UIKit panel faces +Z, which lookAt turns towards the head.
    object.lookAt(this.headPos.x, object.position.y, this.headPos.z);
  }

  /** How far the head's heading is turned away from the panel, rad. */
  angleFromHead(head: Object3D): number {
    this.readHead(head);
    this.toPanel.copy(this.object.position).sub(this.headPos);
    this.toPanel.y = 0;
    if (this.toPanel.lengthSq() < 1e-6) {
      return 0;
    }
    return this.toPanel.normalize().angleTo(this.forward);
  }

  private readHead(head: Object3D): void {
    head.updateWorldMatrix(true, false);
    head.matrixWorld.decompose(this.headPos, this.headQuat, this.scale);
    this.forward.set(0, 0, -1).applyQuaternion(this.headQuat);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) {
      this.forward.set(0, 0, -1);
    }
    this.forward.normalize();
  }
}
