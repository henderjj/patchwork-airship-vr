import { CanvasTexture, createSystem, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from '@iwsdk/core';
import { createBell, createBellBracket, createBoardFrame } from '../scene-assets/controls.scene-asset.js';
import { BELL_HOOK } from '../sim/gondola-controls.js';
import { FLUE_POSITION } from '../sim/gondola-layout.js';
import { restingDeck } from '../sim/islands.js';
import { SHIP_MIDDLE } from '../sim/route.js';
import { ROUTE } from '../world/route-world.js';
import { netLink } from './net-system.js';
import { crewReady, flightInfo, markReady, moored, restartRoute, route, ship } from './ship-system.js';

/** Route board size, m, its canvas, px, and how often it is redrawn, ms. */
const BOARD_SIZE = [0.42, 0.26] as const;
const CANVAS = [512, 320] as const;
const BOARD_REFRESH_MS = 250;
/** Mid-run, a second ring within this long starts again, ms. */
const RING_AGAIN_MS = 3000;
/** Where the best score is kept in this browser. */
const BEST_KEY = 'patchwork-airship.best';

/**
 * The ship's bell: `ring` is what a ring means for the route (set here, and
 * called by ControlsSystem, whose clapper strikes the bell); `knock` strikes
 * it as if its lanyard were tugged (set by ControlsSystem, for the keyboard).
 */
export const bell = { ring: (): void => undefined, knock: (): void => undefined };

/**
 * Phase 2's route on deck: a board on the bow side of the burner flue that
 * shows the run (waiting on island A, the timer and the way to the next ring
 * or island B, then the score), and the ship's bell, which starts the route
 * again from island A. Its clapper and lanyard are in ControlsSystem, which
 * calls `bell.ring` for each ring. Mid-run it takes two rings, so a knock
 * doesn't throw a good run away. With a crewmate, ringing it on island A
 * says you're ready, and the ship stays moored until both have. The host
 * runs the route itself (ShipSystem).
 */
export class RouteSystem extends createSystem({}) {
  private bell!: Mesh;
  private bracket!: Mesh;
  private frame!: Mesh;
  private face!: Mesh;
  private board!: { ctx: CanvasRenderingContext2D; texture: CanvasTexture; lines: string[] };
  private lastDraw = 0;
  private lastRing = Number.NEGATIVE_INFINITY;
  /** The bell was last rung for the ready check on island A: ringing on as the ship casts off doesn't count mid-run. */
  private rungBeforeRun = false;
  private best = 0;
  private scored: unknown = null;

  init(): void {
    this.bracket = createBellBracket([-0.19, 1.0 - BELL_HOOK[1], -0.17], 0.78);
    this.bell = createBell();
    for (const mesh of [this.bracket, this.bell]) {
      mesh.position.set(BELL_HOOK[0], BELL_HOOK[1], BELL_HOOK[2]);
      this.world.createTransformEntity(mesh);
    }
    this.createBoard();
    bell.ring = () => this.ring();
    this.cleanupFuncs.push(() => {
      bell.ring = () => undefined;
    });
    try {
      this.best = Number(localStorage.getItem(BEST_KEY)) || 0;
    } catch {
      this.best = 0;
    }

    // Keyboard: N rings the bell (clear of the emulator's keys).
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && !event.repeat && !(event.target as Element | null)?.closest?.('input, textarea')) {
        bell.knock();
      }
    };
    window.addEventListener('keydown', onKey);
    this.cleanupFuncs.push(() => window.removeEventListener('keydown', onKey));

    (window as { __route?: unknown }).__route = {
      run: route,
      ring: () => this.ring(),
      boardText: () => [...this.board.lines],
    };
  }

  /**
   * The bell was rung: on island A with a crewmate, this player is ready to
   * cast off; otherwise start again if the run is over, or on a second ring
   * mid-run. Ringing on from the ready check as the crew casts off (rings
   * no more than a few seconds apart since island A) doesn't count mid-run.
   */
  private ring(): void {
    const now = performance.now();
    const pealing = now - this.lastRing < RING_AGAIN_MS;
    if (route.phase === 'flying' && this.rungBeforeRun && pealing) {
      this.lastRing = now;
      return;
    }
    this.rungBeforeRun = route.phase === 'ready' && netLink.connected;
    if (route.phase === 'ready' && netLink.connected) {
      markReady();
      this.lastRing = now;
    } else if (route.phase === 'finished' || route.phase === 'lost' || (route.phase === 'flying' && pealing)) {
      restartRoute();
      this.lastRing = Number.NEGATIVE_INFINITY;
    } else {
      this.lastRing = now;
    }
    this.lastDraw = 0;
  }

  update(): void {
    const shown = flightInfo.flying;
    for (const mesh of [this.bell, this.bracket, this.frame, this.face]) {
      mesh.visible = shown;
    }
    if (!shown) {
      return;
    }

    if (route.phase === 'finished' && route.result && route.result !== this.scored) {
      this.scored = route.result;
      if (route.result.score > this.best) {
        this.best = route.result.score;
        try {
          localStorage.setItem(BEST_KEY, String(this.best));
        } catch {
          // Private browsing: the best score lasts for this visit only.
        }
      }
    }
    const now = performance.now();
    if (now - this.lastDraw > BOARD_REFRESH_MS) {
      this.lastDraw = now;
      this.drawBoard(now);
    }
  }

  private createBoard(): void {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS[0];
    canvas.height = CANVAS[1];
    const ctx = canvas.getContext('2d')!;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.face = new Mesh(new PlaneGeometry(BOARD_SIZE[0], BOARD_SIZE[1]), new MeshBasicMaterial({ map: texture, toneMapped: false }));
    this.face.name = 'Route Board Face';
    this.frame = createBoardFrame(BOARD_SIZE[0], BOARD_SIZE[1]);
    this.frame.name = 'Route Board';
    // On the bow side of the burner flue at eye height, facing the crank,
    // back to back with the instrument board.
    for (const mesh of [this.frame, this.face]) {
      mesh.position.set(FLUE_POSITION[0], 1.5, FLUE_POSITION[1] - 0.1);
      mesh.rotation.y = Math.PI;
      this.world.createTransformEntity(mesh);
    }
    this.face.position.z -= 0.001;
    this.board = { ctx, texture, lines: [] };
  }

  private boardLines(now: number): string[] {
    const best = this.best > 0 ? `Best score ${this.best}` : '';
    const ringAgain = !this.rungBeforeRun && now - this.lastRing < RING_AGAIN_MS;
    switch (route.phase) {
      case 'ready': {
        if (netLink.connected) {
          const [mine, theirs] = netLink.isHost ? [crewReady.host, crewReady.guest] : [crewReady.guest, crewReady.host];
          const mark = (ready: boolean) => (ready ? 'READY' : '...');
          return moored()
            ? ['CALM SKIES', 'Moored on island A', 'Ring the bell when ready', `You ${mark(mine)}  Crewmate ${mark(theirs)}`, `Then fly ${ROUTE.rings.length} rings to island B.`, best]
            : ['CAST OFF!', 'The crew is ready.', 'Feed the burner to lift off,', `fly through ${ROUTE.rings.length} rings`, 'and land on island B.', best];
        }
        return ['CALM SKIES', 'Waiting on island A', 'Feed the burner to lift off,', `fly through ${ROUTE.rings.length} rings`, 'and land on island B.', best];
      }
      case 'flying': {
        const next = this.nextTarget();
        return [
          `TIME ${clock(route.seconds)}`,
          `RINGS ${route.rings} of ${ROUTE.rings.length}`,
          `NEXT ${next.name}  ${next.distance} m`,
          `     ${next.bearing}  ${next.height}`,
          `FUEL ${flightInfo.bricksBurned} brick${flightInfo.bricksBurned === 1 ? '' : 's'}`,
          ringAgain ? 'Ring again to restart' : '',
        ];
      }
      case 'finished': {
        const r = route.result!;
        return [
          `LANDED!  ${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)}`,
          `SCORE ${r.score}${this.best > 0 ? `   BEST ${this.best}` : ''}`,
          `Time ${clock(r.seconds)}   Fuel ${r.bricks}`,
          `Rings ${r.rings}/${r.ringsTotal}   Pad ${r.padDistance.toFixed(1)} m`,
          `Touchdown ${r.touchdown.toFixed(1)} m/s`,
          'Ring the bell to fly again',
        ];
      }
      case 'lost':
        return ['RUN OVER', route.lostReason, '', 'Ring the bell to start', 'again from island A.', best];
    }
  }

  /** The first ring not yet flown through, or island B: how far, which way and how much higher. */
  private nextTarget(): { name: string; distance: number; bearing: string; height: string } {
    let name = 'Island B';
    let tx = ROUTE.finish.x;
    let tz = ROUTE.finish.z;
    // For a ring, the deck wants to be the ship's middle below the ring's.
    let ty = restingDeck(ROUTE.finish);
    for (let i = 0; i < ROUTE.rings.length; i++) {
      if (!(route.ringMask & (1 << i))) {
        const ring = ROUTE.rings[i];
        name = `Ring ${i + 1}`;
        tx = ring.x;
        tz = ring.z;
        ty = ring.y - SHIP_MIDDLE;
        break;
      }
    }
    const dx = tx - ship.x;
    const dz = tz - ship.z;
    // Yaw grows to port; the bow points along (-sin yaw, -cos yaw).
    let rel = Math.atan2(-dx, -dz) - ship.yaw;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    const deg = Math.round(Math.abs(rel) * (180 / Math.PI));
    const bearing = deg < 8 ? 'AHEAD' : deg > 172 ? 'ASTERN' : `${deg}° ${rel > 0 ? 'PORT' : 'STBD'}`;
    const dy = ty - ship.y;
    const height = Math.abs(dy) < 3 ? 'LEVEL' : `${dy > 0 ? '▲' : '▼'}${Math.round(Math.abs(dy))} m`;
    return { name, distance: Math.round(Math.hypot(dx, dz)), bearing, height };
  }

  private drawBoard(now: number): void {
    const lines = this.boardLines(now);
    if (lines.every((line, i) => line === this.board.lines[i])) {
      return;
    }
    const { ctx, texture } = this.board;
    this.board.lines = lines;
    const [w, h] = CANVAS;
    ctx.fillStyle = '#efe3c4';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#6a4428';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, w - 8, h - 8);
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      const heading = i === 0;
      ctx.font = heading ? 'bold 38px monospace' : 'bold 30px monospace';
      ctx.fillStyle = heading ? (route.phase === 'lost' ? '#a3321f' : route.phase === 'finished' ? '#2c6e2f' : '#3a2a1a') : '#3a2a1a';
      ctx.fillText(line, 20, 16 + i * 49);
    });
    texture.needsUpdate = true;
  }
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
