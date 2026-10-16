import { BoxGeometry, CylinderGeometry, Mesh, MeshLambertMaterial, SphereGeometry, TorusGeometry } from '@iwsdk/core';
import { CRATE_HEIGHT, CRATE_SIZE, DRUM_RADIUS, HATCH, LEVER_LENGTH, WINCH_AXLE, WINCH_HANDLE_X, WINCH_RADIUS } from '../sim/cargo.js';
import { beam, mergeParts, type Part, shade } from './lowpoly.js';

/**
 * The cargo gear that moves (docs/cargo.md): the crate, the hatch door, the
 * winch's drum and handle, the hatch lever, the hook, and the lengths of
 * hoist line and tag line. The static derrick, trunk and winch frame are
 * part of the gondola (src/scene-assets/gondola.scene-asset.ts). Each piece
 * is one mesh; origins are where CargoSystem turns or places them.
 */

const WOOD = 0xc08a52;
const WOOD_DARK = 0x7a5232;
const IRON = 0x3a3f47;
const ROPE = 0xd8c39a;
const RED = 0xc8402c;
const BRASS = 0xc9a03a;
/** The hoist line's and the tag line's radii, m. */
const HOIST_RADIUS = 0.009;
const TAG_RADIUS = 0.006;
/** The sling's ropes meet this far above the crate's top, where the hook takes them. */
export const SLING_HEIGHT = 0.1;

const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });

function box(size: [number, number, number], position: [number, number, number], color: number): Part {
  return { geometry: new BoxGeometry(...size), color, position };
}

/**
 * The crate: planked sides with dark battens on its edges, a red FRAGILE
 * band round it, rope handles on two sides, and a four-legged sling from its
 * top corners to a ring above its middle. Origin at the middle of its top.
 * The battens stand 4 mm proud of the planks and the band 4 mm proud of the
 * battens: faces any closer flicker through each other in the headset (see
 * test/z-fighting.test.ts).
 */
export function createCrate(): Mesh {
  const s = CRATE_SIZE;
  const h = CRATE_HEIGHT;
  const half = s / 2;
  const parts: Part[] = [
    { geometry: new BoxGeometry(s, h, s), color: (tri) => (tri % 4 < 2 ? WOOD : shade(WOOD, 0.9)), position: [0, -h / 2, 0] },
    box([s + 0.02, 0.05, s + 0.02], [0, -h * 0.55, 0], RED),
  ];
  // Battens on the four upright edges and round the top and bottom.
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      parts.push(box([0.035, h + 0.01, 0.035], [x * (half - 0.012), -h / 2, z * (half - 0.012)], WOOD_DARK));
    }
  }
  for (const y of [-0.011, -h + 0.011]) {
    parts.push(box([s + 0.01, 0.03, 0.035], [0, y, half - 0.012], WOOD_DARK));
    parts.push(box([s + 0.01, 0.03, 0.035], [0, y, -half + 0.012], WOOD_DARK));
    parts.push(box([0.035, 0.03, s + 0.01], [half - 0.012, y, 0], WOOD_DARK));
    parts.push(box([0.035, 0.03, s + 0.01], [-half + 0.012, y, 0], WOOD_DARK));
  }
  // Rope handles on the port and starboard faces.
  for (const x of [-1, 1]) {
    parts.push({ geometry: new TorusGeometry(0.06, 0.01, 4, 8, Math.PI), color: ROPE, position: [x * (half + 0.012), -h * 0.32, 0], rotation: [0, Math.PI / 2, 0] });
  }
  // The sling.
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      parts.push(beam([x * (half - 0.03), 0, z * (half - 0.03)], [0, SLING_HEIGHT - 0.015, 0], 0.006, ROPE, 4));
    }
  }
  parts.push({ geometry: new TorusGeometry(0.018, 0.005, 4, 8), color: IRON, position: [0, SLING_HEIGHT, 0] });
  const mesh = new Mesh(mergeParts(parts), material);
  mesh.name = 'Cargo Crate';
  return mesh;
}

/** The hatch door: a plank square hinged along its port edge (the origin, the hinge running along Z); turning it about Z by -90° drops it open. */
export function createHatchDoor(): Mesh {
  const w = HATCH.x1 - HATCH.x0;
  const d = HATCH.z1 - HATCH.z0;
  const parts: Part[] = [
    { geometry: new BoxGeometry(w - 0.005, 0.03, d - 0.005), color: (tri) => (tri % 4 < 2 ? WOOD_DARK : shade(WOOD_DARK, 1.1)), position: [w / 2, -0.015, 0] },
    box([0.03, 0.035, d - 0.02], [w * 0.3, -0.045, 0], IRON),
    box([0.03, 0.035, d - 0.02], [w * 0.7, -0.045, 0], IRON),
  ];
  const mesh = new Mesh(mergeParts(parts), material);
  mesh.name = 'Hatch Door';
  return mesh;
}

/**
 * The winch drum with turns of line on it, the crank arm on its port end and
 * the handle's grip: origin on the axle, the arm pointing +Y (turning it
 * about X by the winch angle puts the grip where `winchHandle` says).
 */
export function createWinchDrum(): Mesh {
  // The arm turns just outboard of the frame's port cheek; the grip runs from it, centred on the handle's grip point.
  const armX = WINCH_HANDLE_X + 0.05 - WINCH_AXLE[0];
  const parts: Part[] = [
    { geometry: new CylinderGeometry(DRUM_RADIUS, DRUM_RADIUS, 0.16, 8), color: WOOD_DARK, position: [0.0, 0, 0], rotation: [0, 0, Math.PI / 2] },
    { geometry: new CylinderGeometry(DRUM_RADIUS + 0.012, DRUM_RADIUS + 0.012, 0.1, 8), color: ROPE, position: [0.01, 0, 0], rotation: [0, 0, Math.PI / 2] },
    { geometry: new CylinderGeometry(DRUM_RADIUS + 0.03, DRUM_RADIUS + 0.03, 0.015, 10), color: IRON, position: [-0.085, 0, 0], rotation: [0, 0, Math.PI / 2] },
    { geometry: new CylinderGeometry(DRUM_RADIUS + 0.03, DRUM_RADIUS + 0.03, 0.015, 10), color: IRON, position: [0.085, 0, 0], rotation: [0, 0, Math.PI / 2] },
    // The crank arm and its wooden grip, sticking out to port.
    beam([-0.09, 0, 0], [armX, 0, 0], 0.014, IRON, 5),
    beam([armX, 0, 0], [armX, WINCH_RADIUS, 0], 0.016, IRON, 5),
    beam([armX, WINCH_RADIUS, 0], [armX - 0.1, WINCH_RADIUS, 0], 0.022, RED, 6),
  ];
  const mesh = new Mesh(mergeParts(parts), material);
  mesh.name = 'Cargo Winch';
  return mesh;
}

/** The hatch lever: an iron bar up +Y from its pivot with a red knob on top. */
export function createHatchLever(): Mesh {
  const parts: Part[] = [
    beam([0, 0, 0], [0, LEVER_LENGTH - 0.03, 0], 0.014, IRON, 5),
    { geometry: new SphereGeometry(0.035, 8, 6), color: RED, position: [0, LEVER_LENGTH, 0] },
    { geometry: new CylinderGeometry(0.025, 0.025, 0.05, 8), color: BRASS, position: [0.0, 0, 0], rotation: [0, 0, Math.PI / 2] },
  ];
  const mesh = new Mesh(mergeParts(parts), material);
  mesh.name = 'Hatch Lever';
  return mesh;
}

/** The cargo hook: its eye at the origin, the hook below it. */
export function createCargoHook(): Mesh {
  const parts: Part[] = [
    { geometry: new TorusGeometry(0.02, 0.006, 4, 8), color: IRON, position: [0, -0.012, 0] },
    beam([0, -0.03, 0], [0, -0.08, 0], 0.009, IRON, 5),
    { geometry: new TorusGeometry(0.028, 0.008, 4, 8, Math.PI * 1.3), color: IRON, position: [0.0, -0.1, 0], rotation: [0, 0, Math.PI] },
  ];
  const mesh = new Mesh(mergeParts(parts), material);
  mesh.name = 'Cargo Hook';
  return mesh;
}

/** The tag line's toggle: a short wooden peg on the line's end. Origin at the line's end, the peg across X. */
export function createTagToggle(): Mesh {
  const mesh = new Mesh(mergeParts([beam([-0.05, 0, 0], [0.05, 0, 0], 0.014, WOOD, 6)]), material);
  mesh.name = 'Tag Line Toggle';
  return mesh;
}

/** A straight length of line 1 m long up +Y from its origin: point it from one end to the other and scale Y to the length. */
export function createCargoLine(name: string, tag = false): Mesh {
  const r = tag ? TAG_RADIUS : HOIST_RADIUS;
  const mesh = new Mesh(mergeParts([{ geometry: new CylinderGeometry(r, r, 1, 5, 1, true), color: tag ? shade(ROPE, 0.85) : ROPE, position: [0, 0.5, 0] }]), material);
  mesh.name = name;
  // It reaches metres below the ship; its bounds would need refitting each frame.
  mesh.frustumCulled = false;
  return mesh;
}
