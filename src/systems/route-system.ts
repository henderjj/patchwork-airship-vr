import { CanvasTexture, createSystem, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from '@iwsdk/core';
import { createBell, createBellBracket, createBoardFrame } from '../scene-assets/controls.scene-asset.js';
import { BELL_HOOK } from '../sim/gondola-controls.js';
import { FLUE_POSITION } from '../sim/gondola-layout.js';
import { FAIRLEAD, MADE_FAST_HEIGHT, STRAIN_HEIGHT } from '../sim/docking.js';
import { SHIP_MIDDLE } from '../sim/route.js';
import { UNMENDED_POINTS } from '../sim/envelope.js';
import { ROUTE } from '../world/route-world.js';
import { netLink } from './net-system.js';
import { gustStrength } from '../sim/wind.js';
import { cargo, crewReady, docking, envelope, flightInfo, markReady, moored, restartRoute, route, ship, wind, yard } from './ship-system.js';
import { draftHere } from './wind-system.js';

/** Route board size, m, its canvas, px, and how often it is redrawn, ms. */
const BOARD_SIZE = [0.42, 0.26] as const;
const CANVAS = [512, 320] as const;
const BOARD_REFRESH_MS = 250;
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
 * or island B, then the score), and the ship's bell. Its clapper and
 * lanyard are in ControlsSystem, which calls `bell.ring` for each ring. With
 * a crewmate, ringing it on island A says you're ready, and the ship stays
 * moored until both have; otherwise it is just a bell to play with. Starting
 * again from island A is in the game menu (John, 2026-10-16: restarting on
 * two rings stopped the crew playing with the bell on the move, and sent a
 * ship that had just cast off back to island A). The host runs the route
 * itself (ShipSystem).
 */
export class RouteSystem extends createSystem({}) {
  private bell!: Mesh;
  private bracket!: Mesh;
  private frame!: Mesh;
  private face!: Mesh;
  private board!: { ctx: CanvasRenderingContext2D; texture: CanvasTexture; lines: string[] };
  private lastDraw = 0;
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
      /** What the game menu's Restart does (the guest asks the host). */
      restart: () => restartRoute(),
      boardText: () => [...this.board.lines],
    };
  }

  /** The bell was rung: on island A with a crewmate, this player is ready to cast off. */
  private ring(): void {
    if (route.phase === 'ready' && netLink.connected) {
      markReady();
      this.lastDraw = 0;
    }
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
      this.drawBoard();
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

  private boardLines(): string[] {
    const best = this.best > 0 ? `Best score ${this.best}` : '';
    switch (route.phase) {
      case 'ready': {
        if (netLink.connected) {
          const [mine, theirs] = netLink.isHost ? [crewReady.host, crewReady.guest] : [crewReady.guest, crewReady.host];
          const mark = (ready: boolean) => (ready ? 'READY' : '...');
          return moored()
            ? ['CALM SKIES', 'Moored on island A', 'Load, then ring the bell', `You ${mark(mine)}  Crewmate ${mark(theirs)}`, cratesAboard(), best]
            : ['CAST OFF!', 'The crew is ready.', 'Feed the burner to lift off,', `fly ${ROUTE.rings.length} rings, moor at B`, cratesAboard(), best];
        }
        return ['CALM SKIES', 'Waiting on island A', 'Load the crates aboard,', `fly ${ROUTE.rings.length} rings, moor at B`, cratesAboard(), best];
      }
      case 'flying': {
        const top = [`TIME ${clock(route.seconds)}  ${cratesLine()}`, `RINGS ${route.rings} of ${ROUTE.rings.length}`];
        const fuel = `FUEL ${flightInfo.bricksBurned} brick${flightInfo.bricksBurned === 1 ? '' : 's'}${envelopeWarning()}`;
        const air = windLine();
        if (docking.phase === 'fast') {
          const aboard = yard.aboard(cargo);
          return [...top, 'MADE FAST', aboard === 0 ? '     ALL UNLOADED' : aboard === 1 ? '     LOWER THE CRATE' : '     LOWER THE CRATES', fuel, air];
        }
        if (docking.phase === 'hooked') {
          return [...top, `LINE FAST  ${docking.lineOut.toFixed(1)} m out`, `     ${heightHint()}`, fuel, air];
        }
        const next = this.nextTarget();
        return [
          ...top,
          `NEXT ${next.name}  ${next.distance} m`,
          `     ${next.bearing}  ${next.height}`,
          fuel,
          air,
        ];
      }
      case 'finished': {
        const r = route.result!;
        return [
          `${r.crates > 0 ? 'DELIVERED!' : 'MOORED!'}  ${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)}`,
          `SCORE ${r.score}${this.best > 0 ? `   BEST ${this.best}` : ''}`,
          `Time ${clock(r.seconds)}   Fuel ${r.bricks}`,
          `Rings ${r.rings}/${r.ringsTotal}   Torn off ${r.tears}`,
          r.crates > 0 ? `Crates ${r.crates}/${r.cratesTotal} ${r.cargo}%   Target +${r.target}` : `Crates 0/${r.cratesTotal}`,
          r.unmended > 0 ? `Envelope torn ${r.unmended}  -${r.unmended * UNMENDED_POINTS}` : 'Game menu: Restart to fly again',
        ];
      }
      case 'lost':
        return ['RUN OVER', route.lostReason, '', 'Game menu: Restart to start', 'again from island A.', best];
    }
  }

  /** The first ring not yet flown through, or island B's post: how far, which way and how much higher. */
  private nextTarget(): { name: string; distance: number; bearing: string; height: string } {
    let name = 'Post at B';
    let tx = ROUTE.dock.x;
    let tz = ROUTE.dock.z;
    // For the post, the deck wants the line's fairlead level with the post's top.
    let ty = docking.postTop - FAIRLEAD[1];
    for (let i = 0; i < ROUTE.rings.length; i++) {
      if (!(route.ringMask & (1 << i))) {
        const ring = ROUTE.rings[i];
        name = `Ring ${i + 1}`;
        tx = ring.x;
        tz = ring.z;
        // For a ring, the deck wants to be the ship's middle below the ring's.
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

  private drawBoard(): void {
    const lines = this.boardLines();
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
      // The wind's line goes red for a gust, and the fuel's for a tear in the envelope.
      const gust = i === 5 && route.phase === 'flying' && line.startsWith('GUST');
      const torn = i === 4 && route.phase === 'flying' && envelopeWarning() !== '';
      ctx.fillStyle = heading ? (route.phase === 'lost' ? '#a3321f' : route.phase === 'finished' ? '#2c6e2f' : '#3a2a1a') : gust || torn ? '#a3321f' : '#3a2a1a';
      ctx.fillText(line, 20, 16 + i * 49);
    });
    texture.needsUpdate = true;
  }
}

/** Which side of the bow a direction (a heading, radians) is on. */
function side(heading: number): string {
  const rel = Math.atan2(Math.sin(heading - ship.yaw), Math.cos(heading - ship.yaw));
  const deg = Math.abs(rel) * (180 / Math.PI);
  return deg < 30 ? 'AHEAD' : deg > 150 ? 'ASTERN' : rel > 0 ? 'PORT' : 'STBD';
}

/**
 * The wind, in flight (docs/wind.md): a gust on its way or blowing and
 * which side it comes from, else an updraft or downdraft the ship is in,
 * else how fast the ship is drifting sideways, if it is.
 */
function windLine(): string {
  const g = wind.gust;
  const warning = wind.warning(ship.time);
  if (g && warning > 0) {
    return `GUST COMING FROM ${side(g.heading + Math.PI)}`;
  }
  if (g && warning === 0 && gustStrength(g, ship.time) > 0.1) {
    return `GUST FROM ${side(g.heading + Math.PI)}!`;
  }
  const draft = draftHere();
  if (Math.abs(draft) > 0.15) {
    return draft > 0 ? `UPDRAFT ▲ ${draft.toFixed(1)} m/s` : `DOWNDRAFT ▼ ${(-draft).toFixed(1)} m/s`;
  }
  // Sideways over the ground: positive to starboard, which lies along (cos yaw, -sin yaw).
  const drift = ship.vx * Math.cos(ship.yaw) - ship.vz * Math.sin(ship.yaw);
  return Math.abs(drift) > 0.6 ? `DRIFT ${Math.abs(drift).toFixed(1)} m/s ${drift > 0 ? 'STBD' : 'PORT'}` : '';
}

/** On the line to the post: whether the deck is level with it, or which way to go. */
function heightHint(): string {
  const off = docking.heightOff;
  if (Math.abs(off) <= MADE_FAST_HEIGHT) return 'LEVEL WITH POST';
  const by = `${Math.abs(off).toFixed(1)} m`;
  const warn = Math.abs(off) > STRAIN_HEIGHT ? '!' : '';
  return off > 0 ? `HIGH ${by}${warn} VENT` : `LOW ${by}${warn} BURN`;
}

/** A tear in the envelope, after the fuel (it burns more): open, or patched in a rush and peeling off. */
function envelopeWarning(): string {
  let open = false;
  let peeling = false;
  for (const tear of envelope.tears) {
    open ||= tear.phase === 'open';
    peeling ||= tear.peeling;
  }
  return open ? '  TEAR!' : peeling ? '  PEELING' : '';
}

/** How many crates are aboard, for the board while waiting on island A. */
function cratesAboard(): string {
  return `CRATES ABOARD ${yard.aboard(cargo)} of ${yard.crates.length}`;
}

/** The crates aboard and the worst one's condition, for the board's top line. */
function cratesLine(): string {
  let n = 0;
  let worst = 100;
  for (let i = 0; i < yard.crates.length; i++) {
    if (yard.isAboard(i, cargo)) {
      n++;
      worst = Math.min(worst, yard.crates[i].condition);
    }
  }
  return n === 0 ? 'NO CRATES' : `${n === 1 ? 'CRATE' : 'CRATES'} ${Math.round(worst)}%`;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
