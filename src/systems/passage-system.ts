import { CanvasTexture, createSystem, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Vector3 } from '@iwsdk/core';
import { BRUSH_SPEED, deckWindow, type LookoutCall, rockDistance, toPassage } from '../sim/passages.js';
import { ROUTE } from '../world/route-world.js';
import { sounds } from './audio-system.js';
import { drawSignBackground } from './floating-sign.js';
import { buzz } from './haptics.js';
import { netLink } from './net-system.js';
import { flightInfo, passageContact, passageInfo, practicePassage, route, ship } from './ship-system.js';

/** While the ship grinds along rock, the scrape is heard and felt again this often, ms. */
const GRIND_MS = 450;
/** The crewmate's call shows over its head this long, ms. */
const CALL_SHOWN_MS = 2500;
/** The call's bubble: its size, m, its canvas, px, and how far over the crewmate's head it floats, m. */
const BUBBLE_SIZE = [0.42, 0.16] as const;
const BUBBLE_CANVAS = [384, 146] as const;
const BUBBLE_RISE = 0.38;

/** What each call says on the bubble, and the whistle that goes with it. */
const CALLS: Record<LookoutCall, { text: string; whistle: 'up' | 'down' | 'steer' | 'steady' }> = {
  UP: { text: 'UP! ▲', whistle: 'up' },
  DOWN: { text: 'DOWN! ▼', whistle: 'down' },
  PORT: { text: '◀ PORT', whistle: 'steer' },
  STARBOARD: { text: 'STBD ▶', whistle: 'steer' },
  STEADY: { text: 'STEADY', whistle: 'steady' },
};

/** The crewmate's last call heard on this page, for tests and the bubble. */
export const crewCall = { call: '' as LookoutCall | '', at: Number.NEGATIVE_INFINITY, count: 0 };

/**
 * Narrow passages and rock arches on deck (Phase 3, docs/passages.md). The
 * host's ShipSystem keeps the ship out of the rock and counts the scrapes;
 * this system lets both players hear and feel them (a rasp of canvas
 * overhead or the gondola's timbers grinding underfoot, and a knock in both
 * hands, again and again while the ship grinds along), and shows the
 * practice crewmate's calls as it looks out from the bow (src/systems/crew-bot-system.ts):
 * a bubble over its head, with a whistle.
 */
export class PassageSystem extends createSystem({}) {
  private grindAt = Number.NEGATIVE_INFINITY;
  private bubble!: Mesh;
  private bubbleCtx!: CanvasRenderingContext2D;
  private bubbleTexture!: CanvasTexture;
  private shownCall = '';
  private headPos = new Vector3();

  init(): void {
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = BUBBLE_CANVAS;
    this.bubbleCtx = canvas.getContext('2d')!;
    this.bubbleTexture = new CanvasTexture(canvas);
    this.bubbleTexture.colorSpace = SRGBColorSpace;
    this.bubble = new Mesh(
      new PlaneGeometry(BUBBLE_SIZE[0], BUBBLE_SIZE[1]),
      new MeshBasicMaterial({ map: this.bubbleTexture, toneMapped: false, transparent: true }),
    );
    this.bubble.name = 'Crewmate Call';
    this.bubble.visible = false;
    this.world.createTransformEntity(this.bubble);

    netLink.events.set('crew-call', (event) => {
      const call = String(event.c ?? '') as LookoutCall;
      if (!(call in CALLS)) {
        return;
      }
      crewCall.call = call;
      crewCall.at = performance.now();
      crewCall.count++;
      sounds.call(CALLS[call].whistle);
    });
    this.cleanupFuncs.push(() => netLink.events.delete('crew-call'));

    (window as { __passages?: unknown }).__passages = {
      route: ROUTE.passages,
      contact: passageContact,
      info: passageInfo,
      call: crewCall,
      /** What Practice → Passages does: start a run short of passage `i`. */
      practice: (i: number) => practicePassage(i),
      /** The deck heights that take the ship through passage `i`. */
      window: (i: number) => deckWindow(ROUTE.passages[i]),
      /** Where the ship is from passage `i`'s gate: across (starboard positive), along (ahead positive), and the deck's height. */
      where: (i: number) => {
        const at = toPassage(ROUTE.passages[i], ship.x, ship.z, { u: 0, w: 0 });
        return { u: at.u, w: at.w, y: ship.y };
      },
      /** How far a world point is from passage `i`'s rock (negative inside). */
      rock: (i: number, x: number, y: number, z: number) => rockDistance(ROUTE.passages[i], x, y, z),
      scrapes: () => route.scrapes,
      passes: () => route.passMask,
    };
  }

  update(): void {
    const now = performance.now();
    if (passageInfo.count !== passageInfo.heard) {
      passageInfo.heard = passageInfo.count;
      const strength = Math.min(1, passageInfo.speed / 1.5);
      sounds.scrape(passageInfo.part === 'envelope', passageInfo.speed < BRUSH_SPEED ? 0.1 : 0.3 + strength);
      this.knock(passageInfo.speed < BRUSH_SPEED ? 0.25 : 0.5 + 0.5 * strength, 140);
      this.grindAt = now;
    } else if (passageInfo.grinding && flightInfo.flying && now - this.grindAt > GRIND_MS) {
      this.grindAt = now;
      sounds.scrape(passageInfo.part === 'envelope', 0.15);
      this.knock(0.2, 60);
    }
    this.showCall(now);
  }

  private knock(intensity: number, ms: number): void {
    for (const side of ['left', 'right'] as const) {
      buzz(this.input.xr.gamepads[side]?.gamepad, side, intensity, ms);
    }
  }

  /** The crewmate's latest call, over its head and facing this player, for a few seconds. */
  private showCall(now: number): void {
    const shown = netLink.connected && netLink.haveRemote && crewCall.call !== '' && now - crewCall.at < CALL_SHOWN_MS;
    this.bubble.visible = shown;
    if (!shown) {
      return;
    }
    const call = crewCall.call;
    if (call !== '' && call !== this.shownCall) {
      this.shownCall = call;
      const ctx = this.bubbleCtx;
      const [w, h] = BUBBLE_CANVAS;
      drawSignBackground(ctx, w, h);
      ctx.fillStyle = call === 'STEADY' ? '#f3e3c3' : '#ffcf5a';
      ctx.font = 'bold 64px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(CALLS[call].text, w / 2, h / 2 + 4);
      this.bubbleTexture.needsUpdate = true;
    }
    const head = netLink.remote.head;
    this.bubble.position.set(head.px, head.py + BUBBLE_RISE, head.pz);
    this.player.head.getWorldPosition(this.headPos);
    this.bubble.lookAt(this.headPos.x, this.bubble.position.y, this.headPos.z);
  }
}
