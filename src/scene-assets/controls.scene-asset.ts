import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  TorusGeometry,
} from '@iwsdk/core';
import { BELL_MOUTH, CLAPPER_BALL, CLAPPER_BALL_RADIUS, CLAPPER_TAIL, TILLER_LENGTH } from '../sim/gondola-controls.js';
import { beam, mergeParts, type Part, shade } from './lowpoly.js';

/**
 * The moving parts of the gondola's flight controls (Phase 2): the tiller
 * bar, the vent cord and its toggle, the ballast sandbags, the burner flames,
 * a swinging lantern that shows which way the deck leans, and the instrument
 * board's frame. Positions live in src/sim/gondola-controls.ts; each mesh
 * here has its origin at the point it moves about.
 */

const WOOD = 0x8a5a32;
const WOOD_DARK = 0x6a4428;
const IRON = 0x3a3f47;
const BRASS = 0xc9a03a;
const ROPE = 0xd8c39a;
const BURLAP = 0xb39465;

const lambert = () => new MeshLambertMaterial({ vertexColors: true, flatShading: true });

function partsMesh(parts: Part[], name: string): Mesh {
  const mesh = new Mesh(mergeParts(parts), lambert());
  mesh.name = name;
  return mesh;
}

/** Tiller bar with its origin on the rudder post, pointing forward (-Z) to a turned handle. */
export function createTillerBar(): Mesh {
  const L = TILLER_LENGTH;
  return partsMesh(
    [
      // Iron cap on the rudder post.
      { geometry: new CylinderGeometry(0.06, 0.06, 0.07, 8), color: IRON },
      // Bar, tapering a little towards the handle and rising slightly.
      beam([0, 0.01, 0], [0, 0.04, -L + 0.14], 0.03, WOOD, 6),
      // Handle grip, darker from hands.
      beam([0, 0.04, -L + 0.15], [0, 0.04, -L], 0.024, WOOD_DARK, 6),
      { geometry: new CylinderGeometry(0.03, 0.03, 0.02, 6), color: BRASS, position: [0, 0.04, -L], rotation: [Math.PI / 2, 0, 0] },
    ],
    'Tiller',
  );
}

/** The vent cord's wooden toggle, origin at its centre, lying along X. */
export function createVentToggle(): Mesh {
  return partsMesh(
    [
      { geometry: new CylinderGeometry(0.022, 0.022, 0.14, 6), color: WOOD, rotation: [0, 0, Math.PI / 2] },
      { geometry: new TorusGeometry(0.022, 0.006, 4, 6), color: ROPE, position: [0, 0.03, 0] },
    ],
    'Vent Toggle',
  );
}

/** A 1 m length of cord hanging down from its origin; scale Y to its length. */
export function createVentCord(): Mesh {
  return partsMesh([{ geometry: new CylinderGeometry(0.007, 0.007, 1, 4), color: 0xc44a32, position: [0, -0.5, 0] }], 'Vent Cord');
}

/** A sandbag, origin at its centre, with a loop of rope to its hook above. */
export function createSandbag(index: number): Mesh {
  return partsMesh(
    [
      { geometry: new IcosahedronGeometry(0.11, 0), color: shade(BURLAP, 1 - index * 0.04), scale: [0.85, 1.2, 0.85] },
      { geometry: new CylinderGeometry(0.035, 0.05, 0.05, 6), color: shade(BURLAP, 0.8), position: [0, 0.14, 0] },
      beam([0, 0.16, 0], [-0.1, 0.22, 0], 0.008, ROPE, 4),
      { geometry: new TorusGeometry(0.03, 0.006, 4, 6), color: IRON, position: [-0.12, 0.22, 0] },
    ],
    `Ballast ${index + 1}`,
  );
}

/** Burner flame, origin at its base, about 25 cm tall; scale it to flicker. Drawn unlit so it glows. */
export function createFlame(name: string): Mesh {
  const geometry = mergeParts([
    { geometry: new ConeGeometry(0.09, 0.25, 6, 1, true), color: 0xff8a1e, position: [0, 0.125, 0] },
    { geometry: new ConeGeometry(0.05, 0.17, 6, 1, true), color: 0xffe07a, position: [0, 0.085, 0] },
  ]);
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
  mesh.name = name;
  mesh.visible = false;
  return mesh;
}

/**
 * The glow of the fire behind the burner's door grate, origin at its centre,
 * facing -X (the door is on the burner's port side). Unlit, so its colour is
 * set each frame to show the fire burning or out.
 */
export function createFireGlow(width: number, height: number): Mesh {
  const mesh = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({ color: 0x401008, toneMapped: false }));
  mesh.rotation.y = -Math.PI / 2;
  mesh.name = 'Fire Glow';
  return mesh;
}

/** A lantern on a short cord, origin at the hook; it hangs along -Y and is swung by rotating it. */
export function createLantern(): Mesh {
  const drop = 0.32;
  const glow = 0xffd27a;
  return partsMesh(
    [
      beam([0, 0, 0], [0, -drop + 0.12, 0], 0.006, ROPE, 4),
      { geometry: new TorusGeometry(0.025, 0.005, 4, 6), color: IRON, position: [0, -drop + 0.13, 0], rotation: [Math.PI / 2, 0, 0] },
      { geometry: new ConeGeometry(0.06, 0.05, 6), color: IRON, position: [0, -drop + 0.09, 0] },
      { geometry: new CylinderGeometry(0.045, 0.045, 0.1, 6), color: glow, position: [0, -drop + 0.015, 0] },
      { geometry: new CylinderGeometry(0.055, 0.055, 0.02, 6), color: IRON, position: [0, -drop - 0.045, 0] },
    ],
    'Lantern',
  );
}

/** Instrument board frame, origin at its centre, facing +Z; the dial face is drawn on a canvas in front of it. */
export function createBoardFrame(width: number, height: number): Mesh {
  return partsMesh(
    [
      { geometry: new BoxGeometry(width + 0.04, height + 0.04, 0.02), color: WOOD_DARK, position: [0, 0, -0.012] },
      { geometry: new BoxGeometry(0.03, 0.03, 0.1), color: IRON, position: [0, 0, -0.06] },
    ],
    'Instrument Board',
  );
}

/**
 * The ship's bell on a bracket over the port bow corner. Origin at the hook;
 * the bell hangs along -Y and stays still: its clapper swings inside it.
 */
export function createBell(): Mesh {
  const m = BELL_MOUTH;
  const height = m.crownY - m.lipY;
  return partsMesh(
    [
      { geometry: new TorusGeometry(0.02, 0.006, 4, 6), color: IRON, position: [0, -0.02, 0] },
      // Bell: a flared cone, open below so the clapper shows, with a crown and a lip.
      { geometry: new CylinderGeometry(m.crownRadius, m.lipRadius, height, 10, 1, true), color: BRASS, position: [0, (m.crownY + m.lipY) / 2, 0] },
      { geometry: new CylinderGeometry(m.crownRadius, m.crownRadius, 0.02, 10), color: shade(BRASS, 0.85), position: [0, m.crownY, 0] },
      { geometry: new TorusGeometry(m.lipRadius, 0.008, 4, 12), color: shade(BRASS, 0.8), position: [0, m.lipY, 0], rotation: [Math.PI / 2, 0, 0] },
    ],
    'Bell',
  );
}

/**
 * The bell's clapper, origin at its pivot inside the bell's crown: an iron
 * shaft down to the ball that strikes the bell, and on below the lip to a
 * ring the lanyard is tied to. Swung by rotating it.
 */
export function createBellClapper(): Mesh {
  return partsMesh(
    [
      beam([0, 0, 0], [0, -CLAPPER_BALL, 0], 0.006, IRON, 4),
      { geometry: new IcosahedronGeometry(CLAPPER_BALL_RADIUS, 1), color: shade(IRON, 1.25), position: [0, -CLAPPER_BALL, 0] },
      beam([0, -CLAPPER_BALL, 0], [0, -CLAPPER_TAIL + 0.012, 0], 0.005, IRON, 4),
      { geometry: new TorusGeometry(0.012, 0.004, 4, 6), color: IRON, position: [0, -CLAPPER_TAIL, 0] },
    ],
    'Bell Clapper',
  );
}

/** The bell's lanyard: a 1 m length of rope hanging down from its origin (the clapper's tail); scale Y to its length and turn it to the hand. */
export function createBellLanyard(): Mesh {
  return partsMesh([{ geometry: new CylinderGeometry(0.008, 0.008, 1, 4), color: ROPE, position: [0, -0.5, 0] }], 'Bell Lanyard');
}

/** The wooden toggle at the lanyard's end, the part a hand takes. */
export function createBellToggle(): Mesh {
  return partsMesh(
    [
      { geometry: new CylinderGeometry(0.02, 0.02, 0.1, 6), color: WOOD, rotation: [0, 0, Math.PI / 2] },
      { geometry: new TorusGeometry(0.018, 0.005, 4, 6), color: ROPE, position: [0, 0.025, 0] },
    ],
    'Bell Toggle',
  );
}

/** The bell's bracket, origin at the hook: a post rising `postHeight` from the rail top at `toPost` (from the hook), and an arm out to the hook. */
export function createBellBracket(toPost: readonly [number, number, number], postHeight: number): Mesh {
  const [px, py, pz] = toPost;
  return partsMesh(
    [
      beam([px, py, pz], [px, py + postHeight, pz], 0.025, WOOD_DARK, 5),
      beam([px, py + postHeight, pz], [0, 0.03, 0], 0.018, IRON, 4),
      beam([0, 0.03, 0], [0, -0.02, 0], 0.006, IRON, 4),
    ],
    'Bell Bracket',
  );
}
