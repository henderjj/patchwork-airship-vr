import { describe, expect, it } from 'vitest';
import { GONDOLA_COLLIDERS } from '../src/scene-assets/gondola.scene-asset.js';
import { CargoSim, createCargoInput, type GroundAt, HATCH_CENTER, LINE_ABOARD, TRUNK_DEPTH } from '../src/sim/cargo.js';
import { alongsidePost } from '../src/sim/docking.js';
import { RAIL_HEIGHT } from '../src/sim/gondola-layout.js';
import { restingDeck } from '../src/sim/islands.js';
import { CALM_SKIES, clearedSpot, JETTY_TOP, onJetty, onLoadingStage, targetPoints } from '../src/sim/route.js';
import { createShipState, type ShipState, updateQuaternion } from '../src/sim/ship-motion.js';
import {
  CARRY_ALONE,
  CLEAR_DELAY,
  type CrateHand,
  CrateYard,
  DROP_COST,
  DROP_FREE,
  handleAt,
  obstaclesFrom,
  PRACTICE_DECK,
} from '../src/sim/stowage.js';

const DT = 1 / 90;
const ROUTE = CALM_SKIES;

/** What is under a point, as CargoSystem has it: the loading stage, the route's islands (B and the cargo stage deliver) and B's jetty. */
const ground: GroundAt = (x, z, fromY, out) => {
  out.y = Number.NEGATIVE_INFINITY;
  out.delivery = false;
  for (const island of [ROUTE.start, ROUTE.finish, ROUTE.cargo]) {
    const r = island.radius * 0.92;
    if ((x - island.x) ** 2 + (z - island.z) ** 2 < r * r && island.y <= fromY && island.y > out.y) {
      out.y = island.y;
      out.delivery = island !== ROUTE.start;
    }
  }
  const jetty = ROUTE.dock.y + JETTY_TOP;
  if (jetty <= fromY && jetty > out.y && onJetty(ROUTE, x, z)) {
    out.y = jetty;
    out.delivery = true;
  }
  if (ROUTE.loading.top <= fromY && ROUTE.loading.top > out.y && onLoadingStage(ROUTE.loading, x, z)) {
    out.y = ROUTE.loading.top;
    out.delivery = false;
  }
};

/** The ship as a run starts it: resting on A's pad, facing -Z. */
function atA(): ShipState {
  const ship = createShipState();
  Object.assign(ship, { x: ROUTE.start.x, y: restingDeck(ROUTE.start), z: ROUTE.start.z, yaw: 0 });
  updateQuaternion(ship);
  return ship;
}

/** Flying in still air at 130 m, well away from any island. */
function flying(): ShipState {
  const ship = createShipState(130);
  Object.assign(ship, { x: 0, z: -80 });
  updateQuaternion(ship);
  return ship;
}

function setup(ship = atA()): { yard: CrateYard; cargo: CargoSim; ship: ShipState } {
  const yard = new CrateYard(obstaclesFrom(GONDOLA_COLLIDERS));
  yard.clearTo = (x, y, z, k, out) => clearedSpot(ROUTE, x, y, z, k, out);
  const cargo = new CargoSim();
  yard.reset(ROUTE.loading, cargo);
  return { yard, cargo, ship };
}

/** Where crate `i`'s handle `h` is now, ship space. */
function handle(yard: CrateYard, cargo: CargoSim, ship: ShipState, i: number, h: number): [number, number, number] {
  const pose = { x: 0, y: 0, z: 0, yaw: 0 };
  yard.shipPose(i, ship, cargo, pose);
  const out = { x: 0, y: 0, z: 0 };
  handleAt(pose.x, pose.y, pose.z, pose.yaw, h, out);
  return [out.x, out.y, out.z];
}

type Path = (t: number) => [number, number, number] | null;

/**
 * Run the yard for `seconds` with hands following paths: each hand starts
 * where its path starts and moves along it (offset to start on the handle).
 * A hand whose path returns null has let go. Returns the hands that slipped.
 */
function carry(
  setupState: ReturnType<typeof setup>,
  crate: number,
  hands: { handle: number; crew: number; path: Path }[],
  seconds: number,
  each?: (t: number) => void,
): Set<number> {
  const { yard, cargo, ship } = setupState;
  const slipped = new Set<number>();
  const list: CrateHand[] = [];
  const which: number[] = [];
  for (let t = 0; t < seconds; t += DT) {
    list.length = 0;
    which.length = 0;
    hands.forEach((hand, k) => {
      if (slipped.has(k)) return;
      const p = hand.path(t);
      if (!p) return;
      list.push({ crate, handle: hand.handle, crew: hand.crew, x: p[0], y: p[1], z: p[2] });
      which.push(k);
    });
    const refused = yard.step(ship, cargo, list, DT, ground);
    which.forEach((k, n) => {
      if (refused & (1 << n)) slipped.add(k);
    });
    each?.(t);
  }
  return slipped;
}

/** A straight path from `a` to `b` at `speed` m/s, then staying at `b` (or letting go `hold` s after arriving). */
function line(a: readonly number[], b: readonly number[], speed: number, hold = Number.POSITIVE_INFINITY): Path {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const time = d / speed;
  return (t) => {
    if (t > time + hold) return null;
    const k = Math.min(1, t / time);
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  };
}

/** Paths through several points in turn, at `speed`. */
function via(points: readonly (readonly number[])[], speed: number, hold = Number.POSITIVE_INFINITY): Path {
  const legs: { path: Path; time: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    legs.push({ path: line(a, b, speed), time: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / speed });
  }
  const total = legs.reduce((s, l) => s + l.time, 0);
  return (t) => {
    if (t > total + hold) return null;
    let left = Math.min(t, total);
    for (const leg of legs) {
      if (left <= leg.time) return leg.path(left);
      left -= leg.time;
    }
    return legs[legs.length - 1].path(legs[legs.length - 1].time);
  };
}

/** Both of one player's hands on crate `i`, moving the handles' middle through `points` (offsets from where the handles are now). */
function bothHands(s: ReturnType<typeof setup>, i: number, points: readonly (readonly number[])[], speed: number, crews: [number, number] = [0, 0], hold = 0.5) {
  return [0, 1].map((h) => {
    const at = handle(s.yard, s.cargo, s.ship, i, h);
    const mid0 = handle(s.yard, s.cargo, s.ship, i, 0);
    const mid1 = handle(s.yard, s.cargo, s.ship, i, 1);
    const mid = [(mid0[0] + mid1[0]) / 2, (mid0[1] + mid1[1]) / 2, (mid0[2] + mid1[2]) / 2];
    // Each hand keeps its offset from the middle, so the crate stays turned as it was.
    const off = [at[0] - mid[0], at[1] - mid[1], at[2] - mid[2]];
    return { handle: h, crew: crews[h], path: via(points.map((p) => [p[0] + off[0], p[1] + off[1], p[2] + off[2]]), speed, hold) };
  });
}

/** The handles' middle of crate `i` now. */
function middle(s: ReturnType<typeof setup>, i: number): [number, number, number] {
  const a = handle(s.yard, s.cargo, s.ship, i, 0);
  const b = handle(s.yard, s.cargo, s.ship, i, 1);
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/**
 * Both handles of crate `i` held and led towards each of `points` in turn
 * (where its bottom's middle should go), never more than `lead` ahead of
 * the handles, as a player watching the crate would; let go at the last.
 * Returns how long it took to get there, s (Infinity if it got stuck).
 */
function steer(s: ReturnType<typeof setup>, i: number, points: readonly (readonly number[])[], crews: [number, number] = [0, 0], lead = 0.15, seconds = 30): number {
  const pose = { x: 0, y: 0, z: 0, yaw: 0 };
  let k = 0;
  for (let t = 0; t < seconds; t += DT) {
    s.yard.shipPose(i, s.ship, s.cargo, pose);
    const w = points[k];
    const d = [w[0] - pose.x, w[1] - pose.y, w[2] - pose.z];
    const n = Math.hypot(d[0], d[1], d[2]);
    if (n < 0.03) {
      k++;
      if (k === points.length) {
        // Let go, and let it settle.
        for (let u = 0; u < 1.5; u += DT) s.yard.step(s.ship, s.cargo, [], DT, ground);
        return t;
      }
      continue;
    }
    const f = Math.min(1, lead / n);
    const hands = [0, 1].map((h) => {
      const [x, y, z] = handle(s.yard, s.cargo, s.ship, i, h);
      return { crate: i, handle: h, crew: crews[h], x: x + d[0] * f, y: y + d[1] * f, z: z + d[2] * f };
    });
    s.yard.step(s.ship, s.cargo, hands, DT, ground);
  }
  return Number.POSITIVE_INFINITY;
}

describe('loading and stowing crates', () => {
  it('starts each run with the crates on the loading stage beside the ship on A, the hatch empty', () => {
    const s = setup();
    expect(s.cargo.phase).toBe('empty');
    expect(s.yard.aboard(s.cargo)).toBe(0);
    for (const c of s.yard.crates) {
      expect(c.state).toBe('ground');
      expect(c.condition).toBe(100);
      expect(onLoadingStage(ROUTE.loading, c.x, c.z)).toBe(true);
    }
    // Waist high beside the starboard rail, within reach from the deck: the near handle within 0.75 m of a head at the walking bound.
    for (let i = 0; i < 2; i++) {
      for (let h = 0; h < 2; h++) {
        const [x, y] = handle(s.yard, s.cargo, s.ship, i, h);
        expect(x).toBeGreaterThan(1.1);
        expect(x - 0.75).toBeLessThan(0.75);
        expect(y).toBeGreaterThan(0.8);
        expect(y).toBeLessThan(1.2);
      }
    }
  });

  it('lets one player lift a crate over the rail with both hands, slowly, and set it on the deck unharmed', () => {
    const s = setup();
    const m = middle(s, 0);
    // Up until the bottom clears the rail, in over the deck, and down.
    const over = RAIL_HEIGHT + 0.1 + 0.25;
    const points = [m, [m[0], over, m[2]], [0.2, over, -0.6], [0.2, 0.3, -0.6]];
    let moved = 0;
    let fastest = 0;
    let last = { ...s.yard.crates[0] };
    const slipped = carry(s, 0, bothHands(s, 0, points, 0.35), 12, () => {
      const c = s.yard.crates[0];
      if (c.state === 'held' && last.state === 'held') {
        const step = Math.hypot(c.x - last.x, c.z - last.z);
        moved += step;
        fastest = Math.max(fastest, step / DT);
      }
      last = { ...c };
    });
    const c = s.yard.crates[0];
    expect(slipped.size).toBe(0);
    expect(c.state).toBe('deck');
    expect(c.x).toBeCloseTo(0.2, 1);
    expect(c.z).toBeCloseTo(-0.6, 1);
    expect(c.y).toBe(0);
    expect(c.condition).toBe(100);
    expect(moved).toBeGreaterThan(1);
    expect(fastest).toBeLessThanOrEqual(CARRY_ALONE + 1e-6);
    expect(s.yard.aboard(s.cargo)).toBe(1);
  });

  it("won't let a crate through the bulwark below the rail: the hands slip off and it stays outside", () => {
    const s = setup();
    const m = middle(s, 0);
    const slipped = carry(s, 0, bothHands(s, 0, [m, [0.2, m[1], m[2]]], 0.4), 6);
    const c = s.yard.crates[0];
    expect(slipped.size).toBe(2);
    // Outside the hull, back down on the stage.
    expect(c.state).toBe('ground');
    expect(c.x).toBeGreaterThan(1.2);
    expect(c.y).toBeCloseTo(ROUTE.loading.top, 3);
  });

  it('carries much faster with two players, a handle each, than with one', () => {
    // Lifted a little, then walked forward at 1 m/s: faster than one player can carry it.
    const walk = (crews: [number, number]) => {
      const s = setup();
      s.yard.stowAboard(s.cargo, PRACTICE_DECK);
      const m = middle(s, 1);
      const up = [m[0], m[1] + 0.2, m[2]];
      const hands = bothHands(s, 1, [m], 1, crews, 100);
      const lift = bothHands(s, 1, [m, up], 0.3, crews, 100);
      const forward = bothHands(s, 1, [up, [up[0], up[1], up[2] - 0.9]], 1, crews, 100);
      const liftTime = 0.2 / 0.3 + 0.1;
      hands.forEach((hand, k) => {
        hand.path = (t) => (t < liftTime ? lift[k].path(t) : forward[k].path(t - liftTime));
      });
      const slipped = carry(s, 1, hands, 3);
      return { slipped: slipped.size, z: s.yard.crates[1].z };
    };
    const alone = walk([0, 0]);
    const together = walk([0, 1]);
    expect(alone.slipped).toBeGreaterThan(0);
    expect(together.slipped).toBe(0);
    expect(together.z).toBeCloseTo(-0.9, 1);
  });

  it("can't lift a crate with one hand: the hand slips off as it rises, but it drags a crate across the deck", () => {
    const s = setup();
    const h = handle(s.yard, s.cargo, s.ship, 0, 0);
    const slipped = carry(s, 0, [{ handle: 0, crew: 0, path: line(h, [h[0], h[1] + 0.6, h[2]], 0.5) }], 3);
    expect(slipped.has(0)).toBe(true);
    expect(s.yard.crates[0].y).toBeCloseTo(ROUTE.loading.top, 3);

    // On deck, one hand drags it along slowly.
    const d = setup();
    d.yard.stowAboard(d.cargo, PRACTICE_DECK);
    const at = handle(d.yard, d.cargo, d.ship, 1, 1);
    const x0 = d.yard.crates[1].x;
    carry(d, 1, [{ handle: 1, crew: 0, path: line(at, [at[0], at[1], at[2] - 0.5], 0.25) }], 3);
    expect(d.yard.crates[1].state).toBe('deck');
    expect(d.yard.crates[1].z).toBeCloseTo(-0.5, 1);
    expect(d.yard.crates[1].x).toBeCloseTo(x0, 2);
    expect(d.yard.crates[1].y).toBe(0);
  });

  it('sets a crate lowered square over the ready hatch into the trunk, hooked on; lifted out again it unhooks', () => {
    const s = setup();
    s.yard.stowAboard(s.cargo, PRACTICE_DECK);
    // Take the practice crate in the hatch out, onto the deck forward of it.
    let m = middle(s, 0);
    carry(s, 0, bothHands(s, 0, [m, [m[0], m[1] + 0.5, m[2]], [0.25, 0.6, -0.5], [0.25, 0.25, -0.5]], 0.4), 8);
    expect(s.cargo.phase).toBe('empty');
    expect(s.yard.hatchCrate).toBe(-1);
    expect(s.yard.crates[0].state).toBe('deck');
    // And back in.
    m = middle(s, 0);
    carry(s, 0, bothHands(s, 0, [m, [m[0], 0.7, m[2]], [HATCH_CENTER[0] + 0.05, 0.7, HATCH_CENTER[1] - 0.05], [HATCH_CENTER[0] + 0.05, -0.05, HATCH_CENTER[1] - 0.05]], 0.4), 10);
    const c = s.yard.crates[0];
    expect(c.state).toBe('hatch');
    expect(s.yard.hatchCrate).toBe(0);
    expect(s.cargo.phase).toBe('aboard');
    expect(s.cargo.condition).toBe(100);
    expect(c.x).toBeCloseTo(HATCH_CENTER[0], 5);
    expect(c.z).toBeCloseTo(HATCH_CENTER[1], 5);
  });

  it('loads a crate from the stage on A into the ready hatch over the rail, and stows the other on deck to port', () => {
    const s = setup();
    expect(s.yard.hatchReady(s.cargo)).toBe(true);
    const over = RAIL_HEIGHT + 0.15;
    const start = s.yard.crates[0];
    const [x0, , z0] = handle(s.yard, s.cargo, s.ship, 0, 0);
    expect(x0).toBeGreaterThan(1.1);
    const pose = { x: 0, y: 0, z: 0, yaw: 0 };
    s.yard.shipPose(0, s.ship, s.cargo, pose);
    const into = steer(s, 0, [[pose.x, over, pose.z], [0.6, over, pose.z], [HATCH_CENTER[0], over, HATCH_CENTER[1]], [HATCH_CENTER[0], -0.1, HATCH_CENTER[1]]]);
    expect(into).toBeLessThan(15);
    expect(start.state).toBe('hatch');
    expect(s.cargo.phase).toBe('aboard');
    expect(s.yard.aboard(s.cargo)).toBe(1);
    // Two players carry the other across to the port side amidships, faster.
    s.yard.shipPose(1, s.ship, s.cargo, pose);
    const across = steer(s, 1, [[pose.x, over, pose.z], [0.6, over, pose.z], [-0.6, over, 0], [-0.6, 0.02, 0]], [0, 1], 0.3);
    expect(across).toBeLessThan(10);
    expect(s.yard.crates[1].state).toBe('deck');
    expect(s.yard.crates[1].condition).toBe(100);
    expect(s.yard.aboard(s.cargo)).toBe(2);
  });

  it("won't take a crate into the trunk until the empty hook is wound back up into it", () => {
    const s = setup();
    s.yard.stowAboard(s.cargo, PRACTICE_DECK);
    s.yard.crates[0].state = 'delivered';
    s.yard.hatchCrate = -1;
    s.cargo.clear();
    // The hook still out on its line.
    const input = createCargoInput(ground);
    input.line = LINE_ABOARD + 3;
    s.cargo.step(s.ship, input, DT);
    expect(s.yard.hatchReady(s.cargo)).toBe(false);
    const m = middle(s, 1);
    carry(s, 1, bothHands(s, 1, [m, [m[0], 0.7, m[2]], [HATCH_CENTER[0], 0.7, HATCH_CENTER[1] - 0.45], [HATCH_CENTER[0], 0.7, HATCH_CENTER[1]], [HATCH_CENTER[0], -0.1, HATCH_CENTER[1]]], 0.4), 12);
    expect(s.yard.crates[1].state).toBe('deck');
    expect(s.yard.crates[1].y).toBe(0);
    expect(s.cargo.phase).toBe('empty');
    // Wound up, it goes in.
    input.line = LINE_ABOARD;
    s.cargo.step(s.ship, input, DT);
    expect(s.yard.hatchReady(s.cargo)).toBe(true);
    const n = middle(s, 1);
    carry(s, 1, bothHands(s, 1, [n, [n[0], 0.5, n[2]], [n[0], -0.1, n[2]]], 0.4), 6);
    expect(s.yard.crates[1].state).toBe('hatch');
    expect(s.cargo.phase).toBe('aboard');
  });

  it('knocks a crate dropped from high, not one set down gently', () => {
    const s = setup();
    s.yard.stowAboard(s.cargo, PRACTICE_DECK);
    const m = middle(s, 1);
    // Lifted 1 m and let go.
    carry(s, 1, bothHands(s, 1, [m, [m[0], m[1] + 1, m[2]]], 0.3, [0, 0], 0), 6);
    const c = s.yard.crates[1];
    expect(c.state).toBe('deck');
    expect(100 - c.condition).toBeCloseTo(DROP_COST * (1 - DROP_FREE), 0);
    // Lifted 20 cm and let go: unharmed.
    const before = c.condition;
    const n = middle(s, 1);
    carry(s, 1, bothHands(s, 1, [n, [n[0], n[1] + 0.2, n[2]]], 0.3, [0, 0], 0), 3);
    expect(c.state).toBe('deck');
    expect(c.condition).toBe(before);
  });

  it('loses a crate let go outside the rail in flight', () => {
    const s = setup(flying());
    s.yard.stowAboard(s.cargo, PRACTICE_DECK);
    const m = middle(s, 1);
    carry(s, 1, bothHands(s, 1, [m, [m[0], 1.5, m[2]], [-1.7, 1.5, m[2]]], 0.5, [0, 0], 0.2), 12);
    expect(s.yard.crates[1].state).toBe('lost');
    expect(s.yard.crates[1].condition).toBe(0);
    expect(s.yard.aboard(s.cargo)).toBe(1);
  });

  it("can't carry one crate through the other or through the burner", () => {
    const s = setup();
    s.yard.stowAboard(s.cargo, PRACTICE_DECK);
    const m = middle(s, 1);
    // Along the deck at handle height towards the burner's port side.
    carry(s, 1, bothHands(s, 1, [m, [m[0] + 1.2, m[1] + 0.05, 0.05]], 0.4), 8);
    const c = s.yard.crates[1];
    // The burner's port side is at x 0.34: the crate's starboard side stops there.
    expect(c.x + 0.2).toBeLessThanOrEqual(0.34 + 1e-6);
  });

  it('delivers the crate in the hatch at B, slides it off the target to the stack, then takes the second once the hook is back up', () => {
    const at = alongsidePost(ROUTE.dock, ROUTE.finish.x, ROUTE.finish.z, 1.2);
    const ship = createShipState();
    Object.assign(ship, { x: at.x, y: at.y, z: at.z, yaw: at.yaw });
    updateQuaternion(ship);
    const s = setup(ship);
    s.yard.stowAboard(s.cargo, PRACTICE_DECK);
    expect(s.yard.aboard(s.cargo)).toBe(2);
    const input = createCargoInput(ground);
    input.doorOpen = true;
    // Lower steadily to the stage and pay out the slack.
    for (let t = 0; t < 60; t += DT) {
      input.line = Math.min(LINE_ABOARD + 0.3 * t, 11.5);
      ship.time += DT;
      input.time = ship.time;
      s.cargo.step(ship, input, DT);
      s.yard.step(ship, s.cargo, [], DT, ground);
      if (s.yard.crates[0].state === 'delivered') break;
    }
    const first = s.yard.crates[0];
    expect(first.state).toBe('delivered');
    expect(s.yard.delivered().count).toBe(1);
    expect(s.yard.aboard(s.cargo)).toBe(1);
    // Set down on the target, it stays there a moment, then is slid off it to the stack beside it.
    const [setX, setZ] = [first.x, first.z];
    expect(targetPoints(ROUTE, setX, setZ)).toBeGreaterThan(0);
    const spot = { x: 0, z: 0, yaw: 0 };
    expect(clearedSpot(ROUTE, first.x, first.y, first.z, 0, spot)).toBe(true);
    for (let t = 0; t < CLEAR_DELAY - 0.1; t += DT) s.yard.step(ship, s.cargo, [], DT, ground);
    expect(Math.hypot(first.x - setX, first.z - setZ)).toBe(0);
    expect(s.yard.hatchReady(s.cargo)).toBe(false);
    // Hoist the empty hook back up and shut the door.
    input.doorOpen = false;
    for (let t = 0; t < 20 && s.cargo.phase !== 'empty'; t += DT) {
      input.line = Math.max(LINE_ABOARD, input.line - 0.6 * DT);
      s.cargo.step(ship, input, DT);
      s.yard.step(ship, s.cargo, [], DT, ground);
    }
    expect(s.cargo.phase).toBe('empty');
    expect(s.yard.hatchReady(s.cargo)).toBe(true);
    // Winding on, the empty hook stops at home: it doesn't come up out of the trunk.
    input.line = LINE_ABOARD - 0.3;
    s.cargo.step(ship, input, DT);
    expect(s.cargo.line).toBe(LINE_ABOARD);
    expect(s.yard.hatchReady(s.cargo)).toBe(true);
    // By now the delivered crate is on the stack, off the target, and still scores where it was set down.
    for (let t = 0; t < 5; t += DT) s.yard.step(ship, s.cargo, [], DT, ground);
    expect(first.state).toBe('delivered');
    expect(Math.hypot(first.x - spot.x, first.z - spot.z)).toBeLessThan(1e-6);
    expect(targetPoints(ROUTE, first.x, first.z)).toBe(0);
    // Square with the stack.
    expect(Math.abs(Math.sin(2 * (first.yaw - spot.yaw)))).toBeLessThan(1e-9);
    expect([first.setX, first.setZ]).toEqual([setX, setZ]);
    const m = middle(s, 1);
    carry(s, 1, bothHands(s, 1, [m, [m[0], 0.6, m[2]], [HATCH_CENTER[0], 0.6, HATCH_CENTER[1]], [HATCH_CENTER[0], -TRUNK_DEPTH + 0.2, HATCH_CENTER[1]]], 0.4), 12);
    expect(s.yard.crates[1].state).toBe('hatch');
    expect(s.cargo.phase).toBe('aboard');
  });
});

describe('crates in a flooded gondola (storms)', () => {
  it('soak while standing on the deck boards, but not in the hatch or up off the boards', () => {
    const s = setup();
    // One in the hatch, one stowed on deck.
    s.yard.stowAboard(s.cargo, [[0.5, -1]]);
    s.yard.soak(5);
    expect(s.yard.crates.map((c) => c.condition)).toEqual([100, 95]);
    // Lifted onto another crate (or anything else off the boards): dry.
    s.yard.crates[1].y = 0.4;
    s.yard.soak(5);
    expect(s.yard.crates[1].condition).toBe(95);
    s.yard.crates[1].y = 0;
    s.yard.soak(200);
    expect(s.yard.crates[1].condition).toBe(0);
  });
});
