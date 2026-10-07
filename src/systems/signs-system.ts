import { BufferAttribute, BufferGeometry, CanvasTexture, createSystem, Mesh, MeshBasicMaterial, SRGBColorSpace, Vector3 } from '@iwsdk/core';
import { CRANK_POSITION, FUEL_CRATE_POSITION, FUEL_CRATE_SIZE, RAIL_HEIGHT } from '../scene-assets/gondola.scene-asset.js';
import { TILLER_PIVOT, VENT_TOGGLE } from '../sim/gondola-controls.js';
import { BURNER_POSITION, BURNER_SIZE, DECK_WIDTH } from '../sim/gondola-layout.js';

/** Each sign's size, m, and its cell in the shared canvas, px (two columns of four). */
const SIGN_SIZE = [0.24, 0.12] as const;
const CELL = [512, 256] as const;
const COLUMNS = 2;
const CANVAS = [CELL[0] * COLUMNS, 1024] as const;

interface Sign {
  title: string;
  hint: string;
  /** Centre, m, in ship space. */
  at: readonly [number, number, number];
  /** The way the sign faces (horizontal). */
  facing: readonly [number, number, number];
  /** Painted on both sides (hung on a cord or a rail), or only the front (fixed to a face). */
  twoSided: boolean;
}

const RAIL_TOP = RAIL_HEIGHT + SIGN_SIZE[1] / 2 + 0.01;
const PORT_RAIL = -DECK_WIDTH / 2 + 0.01;
const STARBOARD_RAIL = DECK_WIDTH / 2 - 0.01;

const SIGNS: readonly Sign[] = [
  {
    title: 'BURNER',
    hint: 'Drop fuel bricks in the top',
    at: [BURNER_POSITION[0] - BURNER_SIZE[0] / 2 - 0.004, 0.475, BURNER_POSITION[2]],
    facing: [-1, 0, 0],
    twoSided: false,
  },
  {
    title: 'BURNER',
    hint: 'Drop fuel bricks in the top',
    at: [BURNER_POSITION[0], 0.42, BURNER_POSITION[2] + BURNER_SIZE[2] / 2 + 0.004],
    facing: [0, 0, 1],
    twoSided: false,
  },
  // Beside the vent cord, just above its toggle.
  {
    title: 'VENT',
    hint: 'Pull down to let hot air out and sink',
    at: [VENT_TOGGLE[0] + SIGN_SIZE[0] / 2 + 0.02, VENT_TOGGLE[1] + 0.12, VENT_TOGGLE[2]],
    facing: [0, 0, 1],
    twoSided: true,
  },
  { title: "SHIP'S BELL", hint: 'Tug its lanyard side to side', at: [PORT_RAIL, RAIL_TOP, -1.05], facing: [1, 0, 0], twoSided: true },
  { title: 'MOORING LINE', hint: 'Haul it towards the stern', at: [PORT_RAIL, RAIL_TOP, -0.45], facing: [1, 0, 0], twoSided: true },
  { title: 'BALLAST', hint: 'Drop a bag overboard to rise', at: [STARBOARD_RAIL, RAIL_TOP, 0.9], facing: [-1, 0, 0], twoSided: true },
  { title: 'TILLER', hint: 'Swing it to steer', at: [TILLER_PIVOT[0], 0.62, TILLER_PIVOT[2] - 0.055], facing: [0, 0, -1], twoSided: false },
  { title: 'CRANK', hint: 'Turn the handles for speed', at: [CRANK_POSITION[0], 0.6, CRANK_POSITION[2] + 0.074], facing: [0, 0, 1], twoSided: false },
  {
    title: 'FUEL',
    hint: 'Bricks for the burner',
    at: [FUEL_CRATE_POSITION[0], 0.2, FUEL_CRATE_POSITION[2] - FUEL_CRATE_SIZE[2] / 2 - 0.004],
    facing: [0, 0, -1],
    twoSided: false,
  },
];

/**
 * Painted signs that say what each control on the gondola is for and how to
 * use it, after a playtest found the burner and the cords hard to read. All
 * of them are one mesh with one canvas texture (one draw call). They don't
 * change, so the canvas is drawn once.
 */
export class SignsSystem extends createSystem({}) {
  init(): void {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS[0];
    canvas.height = CANVAS[1];
    const ctx = canvas.getContext('2d')!;
    const titles = [...new Set(SIGNS.map((s) => `${s.title}\n${s.hint}`))];
    titles.forEach((key, i) => {
      const [title, hint] = key.split('\n');
      drawSign(ctx, (i % COLUMNS) * CELL[0], Math.floor(i / COLUMNS) * CELL[1], title, hint);
    });
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 4;

    const quads = SIGNS.reduce((n, s) => n + (s.twoSided ? 2 : 1), 0);
    const positions = new Float32Array(quads * 12);
    const uvs = new Float32Array(quads * 8);
    const indices: number[] = [];
    let quad = 0;
    const up = new Vector3(0, 1, 0);
    const normal = new Vector3();
    const right = new Vector3();
    const centre = new Vector3();
    const addQuad = (cell: number) => {
      const u0 = ((cell % COLUMNS) * CELL[0]) / CANVAS[0];
      const u1 = u0 + CELL[0] / CANVAS[0];
      const v1 = 1 - (Math.floor(cell / COLUMNS) * CELL[1]) / CANVAS[1];
      const v0 = v1 - CELL[1] / CANVAS[1];
      right.crossVectors(up, normal).normalize();
      const corners = [
        [-1, -1, u0, v0],
        [1, -1, u1, v0],
        [1, 1, u1, v1],
        [-1, 1, u0, v1],
      ];
      corners.forEach(([sx, sy, u, v], k) => {
        const i = quad * 4 + k;
        positions[i * 3] = centre.x + right.x * sx * (SIGN_SIZE[0] / 2);
        positions[i * 3 + 1] = centre.y + sy * (SIGN_SIZE[1] / 2);
        positions[i * 3 + 2] = centre.z + right.z * sx * (SIGN_SIZE[0] / 2);
        uvs[i * 2] = u;
        uvs[i * 2 + 1] = v;
      });
      const b = quad * 4;
      indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
      quad++;
    };
    for (const sign of SIGNS) {
      const cell = titles.indexOf(`${sign.title}\n${sign.hint}`);
      normal.set(sign.facing[0], sign.facing[1], sign.facing[2]).normalize();
      centre.set(sign.at[0], sign.at[1], sign.at[2]).addScaledVector(normal, 0.001);
      addQuad(cell);
      if (sign.twoSided) {
        normal.negate();
        centre.addScaledVector(normal, 0.002);
        addQuad(cell);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, new MeshBasicMaterial({ map: texture, toneMapped: false }));
    mesh.name = 'Control Signs';
    this.world.createTransformEntity(mesh);
    (window as { __signs?: unknown }).__signs = { titles: () => SIGNS.map((s) => s.title) };
  }
}

/** One sign in the house style of the mooring line's sign: dark wood, brass edge, cream lettering. */
function drawSign(ctx: CanvasRenderingContext2D, x: number, y: number, title: string, hint: string): void {
  const [w, h] = CELL;
  ctx.fillStyle = '#2b1d12';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#c9a03a';
  ctx.lineWidth = 8;
  ctx.strokeRect(x + 6, y + 6, w - 12, h - 12);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f3e3c3';
  fitText(ctx, title, 'bold', 72, w - 48);
  ctx.fillText(title, x + w / 2, y + 62);
  // The hint on up to two lines, split at the space nearest the middle.
  ctx.fillStyle = '#e8d4a2';
  ctx.font = 'bold 44px sans-serif';
  let lines = [hint];
  if (ctx.measureText(hint).width > w - 40) {
    const middle = hint.length / 2;
    let cut = hint.indexOf(' ');
    for (let i = cut; i !== -1; i = hint.indexOf(' ', i + 1)) {
      if (Math.abs(i - middle) < Math.abs(cut - middle)) {
        cut = i;
      }
    }
    lines = [hint.slice(0, cut), hint.slice(cut + 1)];
  }
  fitText(ctx, lines.reduce((a, b) => (a.length > b.length ? a : b)), 'bold', 44, w - 40);
  lines.forEach((line, i) => ctx.fillText(line, x + w / 2, y + (lines.length === 1 ? 170 : 148 + i * 52)));
}

/** Set the font, shrinking it until the text fits the width. */
function fitText(ctx: CanvasRenderingContext2D, text: string, weight: string, size: number, width: number): void {
  for (let px = size; px >= 12; px -= 2) {
    ctx.font = `${weight} ${px}px sans-serif`;
    if (ctx.measureText(text).width <= width) {
      return;
    }
  }
}
