import { describe, expect, it } from 'vitest';
import { createAvatarPose, decodePose, encodePose, POSE_PACKET_BYTES } from '../src/net/pose-codec.js';
import { envelopeUnderside } from '../src/scene-assets/repairs.scene-asset.js';
import {
  EDGE_DROP,
  EDGE_REACH,
  edgeHold,
  ELLIPSOID_UNDERSIDE,
  EnvelopeSim,
  gentlerRate,
  HELD_LIFE,
  MAX_UNMENDED,
  PATCH_DROP,
  PATCH_MAX,
  PATCH_MIN,
  patchLengthFor,
  patchTouches,
  PEEL_SECONDS,
  RIVETS,
  rivetPoint,
  RUSHED_LIFE,
  slitPoint,
  TEAR_GROWTH,
  TEAR_MAX,
  TEAR_SPOTS,
  TEAR_START,
  UNMENDED_POINTS,
} from '../src/sim/envelope.js';
import { createFlightControls, DEFAULT_FLIGHT, FlightSim } from '../src/sim/flight.js';
import { createShipState } from '../src/sim/ship-motion.js';
import {
  Climber,
  DEFAULT_EYE,
  HAMMER_REST,
  PATCH_BOX,
  RATLINES,
  RIG_EYE,
  RIG_REACH,
  RIG_WORK,
  RIG_X,
  RIG_Z,
  rigHold,
  type RigHold,
  rigRaise,
  SHROUD_HOLD_LOW,
  SHROUD_TOP,
} from '../src/sim/rigging.js';
import { DECK_WIDTH, RAIL_HEIGHT } from '../src/sim/gondola-layout.js';
import { scoreRun } from '../src/sim/route.js';

const hold = (): RigHold => ({ x: 0, y: 0, z: 0, shroud: false, distance: 0 });
const point = () => ({ x: 0, y: 0, z: 0 });

describe('the rigging up to the envelope', () => {
  const canvas = envelopeUnderside();

  it("puts everyone's eyes at the same height at the top", () => {
    expect(rigRaise(DEFAULT_EYE) + DEFAULT_EYE).toBeCloseTo(RIG_EYE);
    expect(rigRaise(Number.NaN)).toBeCloseTo(RIG_EYE - DEFAULT_EYE);
    expect(rigRaise(1.85) + 1.85).toBeCloseTo(RIG_EYE);
    // Seated (eyes low) or very tall: raised as far as it goes, and no further.
    expect(rigRaise(0.6)).toBe(3);
    expect(rigRaise(2.4)).toBe(2);
  });

  it('takes hold of the nearest ratline or shroud in reach', () => {
    const h = hold();
    const mid = (RIG_Z[0] + RIG_Z[1]) / 2;
    expect(rigHold(RIG_X + 0.05, RATLINES[2] + 0.02, mid, h)).toBe(true);
    expect(h.shroud).toBe(false);
    expect(h.y).toBeCloseTo(RATLINES[2]);
    expect(rigHold(RIG_X, 3.0, RIG_Z[0] - 0.04, h)).toBe(true);
    expect(h.shroud).toBe(true);
    expect(h.y).toBeCloseTo(3.0);
    expect(rigHold(RIG_X + RIG_REACH + 0.05, RATLINES[0], mid, h)).toBe(false);
    // Down by the rail, where the mooring line runs, there is nothing to take hold of.
    expect(rigHold(RIG_X + 0.05, RAIL_HEIGHT + 0.1, RIG_Z[0], h)).toBe(false);
  });

  it('stands on the port rail clear of the mooring line, and runs up into the envelope', () => {
    // Shrouds aft of the rail's middle post (z 0) and outboard of the mooring line's coil (at x -0.81, z 0.706, 0.13 across).
    expect(RIG_Z[0]).toBeGreaterThan(0.1);
    for (const z of RIG_Z) expect(Math.hypot(RIG_X + 0.81, z - 0.706)).toBeGreaterThan(0.13 + 0.03);
    expect(RIG_X).toBeGreaterThanOrEqual(-DECK_WIDTH / 2);
    // The ratlines start above head height, over the line along the rail.
    expect(RATLINES[0]).toBeGreaterThan(1.7);
    expect(SHROUD_HOLD_LOW).toBeGreaterThan(RAIL_HEIGHT + 0.4);
    for (const z of RIG_Z) {
      expect(SHROUD_TOP).toBeGreaterThan(canvas(RIG_X, z) - 0.02);
      expect(RATLINES[RATLINES.length - 1]).toBeLessThan(canvas(RIG_X, z) - 0.1);
    }
  });

  it('climbs hand over hand: pulling a hand down raises the player', () => {
    const c = new Climber();
    const top = rigRaise(DEFAULT_EYE);
    let rig = 0;
    // Each stroke: take hold at chest height, pull down 0.4 m over a few frames, let go.
    let strokes = 0;
    while (!c.atTop && strokes < 20) {
      const side = strokes % 2 ? 'right' : 'left';
      const grabAt = 1.2 + rig;
      c.grab(side, grabAt);
      for (let f = 1; f <= 8; f++) {
        // The tracked hand moves down in the room; the rig carries it up as the player climbs.
        const tracked = 1.2 - 0.05 * f;
        const y = tracked + rig;
        rig = c.update(side === 'left' ? y : 0, side === 'right' ? y : 0, top);
      }
      c.release(side);
      for (let f = 0; f < 30; f++) rig = c.update(0, 0, top);
      strokes++;
    }
    expect(c.atTop).toBe(true);
    expect(c.height).toBeCloseTo(top);
    expect(c.feet).toBe(c.height);
    expect(strokes).toBeGreaterThan(4);
  });

  it('stays put when let go partway, and climbs down by pushing up', () => {
    const c = new Climber();
    c.grab('left', 1.5);
    c.update(1.0, 0, 2.5);
    expect(c.height).toBeCloseTo(0.2); // at most 0.2 m a frame
    // What the clamp held back is lost (the hand's hold moved with it): a tracking glitch can't throw the player up.
    c.update(1.2, 0, 2.5);
    expect(c.height).toBeCloseTo(0.2);
    c.update(0.95, 0, 2.5);
    expect(c.height).toBeCloseTo(0.4);
    c.release('left');
    for (let f = 0; f < 50; f++) c.update(0, 0, 2.5);
    expect(c.height).toBeCloseTo(0.4);
    expect(c.aloft).toBe(true);
    // Hold on and push up: down the rigging, and no lower than the deck.
    c.grab('right', 1.5);
    for (let f = 1; f <= 10; f++) c.update(0, 1.5 + 0.1 * f, 2.5);
    expect(c.height).toBe(0);
    c.release('right');
    expect(c.aloft).toBe(false);
  });

  it('hands over to the other hand still on the rigging', () => {
    const c = new Climber();
    c.grab('left', 1.4);
    c.grab('right', 1.6);
    c.update(1.4, 1.5, 2.5); // the right (the latest) climbs
    expect(c.height).toBeCloseTo(0.1);
    c.release('right');
    // The left takes over from where it is now: no jump.
    c.update(1.5, 0, 2.5);
    expect(c.height).toBeCloseTo(0.1);
    c.update(1.3, 0, 2.5);
    expect(c.height).toBeCloseTo(0.3);
  });

  it('stands on the deck when let go just above it', () => {
    const c = new Climber();
    c.height = 0.03;
    c.update(0, 0, 2.5);
    expect(c.height).toBe(0);
  });
});

describe("the envelope's underside round the rigging", () => {
  const canvas = envelopeUnderside();

  it('is the modelled envelope, close to its ellipsoid', () => {
    for (const [x, z] of [[-0.5, 0], [-0.2, 0.55], [-0.8, 1.15]]) {
      expect(Math.abs(canvas(x, z) - ELLIPSOID_UNDERSIDE(x, z))).toBeLessThan(0.08);
    }
    // Measured before the compaction: 4.475 at (-0.5, 0), 4.488 at (-0.2, 0.55), 4.625 at (-0.8, 1.15).
    expect(canvas(-0.5, 0)).toBeCloseTo(4.475, 1);
    expect(canvas(-0.8, 1.15)).toBeCloseTo(4.625, 1);
  });

  it('puts every tear in reach overhead from the top of the rigging, over the deck', () => {
    for (const spot of TEAR_SPOTS) {
      for (const t of [0, 0.5, 1]) {
        const p = slitPoint(canvas, spot, TEAR_MAX, t, EDGE_DROP, point());
        expect(Math.abs(p.x)).toBeLessThan(DECK_WIDTH / 2);
        expect(Math.hypot(p.x - RIG_WORK[0], p.y - RIG_WORK[1], p.z - RIG_WORK[2])).toBeLessThan(0.75);
        // Above the eyes, but not out of reach.
        expect(p.y - RIG_EYE).toBeGreaterThan(0.2);
        expect(p.y - RIG_EYE).toBeLessThan(0.65);
      }
    }
  });

  it('keeps the patch box and the hammer in reach from the deck, inboard of the rail', () => {
    for (const at of [PATCH_BOX, HAMMER_REST]) {
      expect(at[1]).toBeGreaterThan(1.2);
      expect(at[1]).toBeLessThan(1.8);
      expect(at[0]).toBeGreaterThan(-DECK_WIDTH / 2);
    }
  });
});

describe('tears and patches', () => {
  const canvas = envelopeUnderside();

  it('open on a schedule once the run is under way, at most two at a time', () => {
    const sim = new EnvelopeSim(canvas);
    sim.reset(3);
    let t = 0;
    let first = Number.NaN;
    while (t < 1200) {
      sim.step(t, true, 1);
      if (Number.isNaN(first) && sim.unmended > 0) first = t;
      expect(sim.unmended).toBeLessThanOrEqual(MAX_UNMENDED);
      t += 1;
    }
    expect(first).toBeGreaterThanOrEqual(50);
    expect(first).toBeLessThanOrEqual(81);
    expect(sim.unmended).toBe(MAX_UNMENDED);
  });

  it('wait while the ship is not under way, and never come with tears off', () => {
    const sim = new EnvelopeSim(canvas);
    sim.reset(3);
    for (let t = 0; t < 600; t++) sim.step(t, false, 1);
    expect(sim.unmended).toBe(0);
    sim.rate = 'off';
    for (let t = 0; t < 600; t++) sim.step(t, true, 1);
    expect(sim.unmended).toBe(0);
  });

  it('leak hot air, more as they grow, much less held shut', () => {
    const sim = new EnvelopeSim(canvas);
    sim.reset(1);
    sim.open(0);
    const fresh = sim.leak;
    expect(fresh).toBeGreaterThan(0.005);
    for (let i = 0; i < 30; i++) sim.step(i, true, 1);
    expect(sim.tears[0].length).toBeCloseTo(TEAR_START + 30 * TEAR_GROWTH);
    expect(sim.leak).toBeGreaterThan(fresh);
    // One hand holds it shut, leaving the other for the patch, and it stops growing.
    sim.setHolds(0, [[0, 0.5]]);
    expect(sim.tears[0].closed).toBe(true);
    const held = sim.leak;
    expect(held).toBeLessThan(fresh / 3);
    const length = sim.tears[0].length;
    sim.step(31, true, 10);
    expect(sim.tears[0].length).toBe(length);
    // Let go, it gapes again.
    sim.setHolds(0, []);
    expect(sim.tears[0].closed).toBe(false);
  });

  it("grow no longer than the longest, and full flame then can't hold height", () => {
    const sim = new EnvelopeSim(canvas);
    sim.reset(1);
    sim.open(0);
    for (let i = 0; i < 400; i++) sim.step(i, true, 1);
    expect(sim.tears[0].length).toBe(TEAR_MAX);
    const flight = new FlightSim({ ...DEFAULT_FLIGHT });
    const ship = createShipState();
    flight.reset(ship, 0, 100, 0, 0);
    const c = createFlightControls();
    c.burner = 1;
    c.leak = sim.leak;
    for (let i = 0; i < 600; i++) flight.step(ship, c, 0.1, -1000, false);
    expect(flight.heat).toBeLessThan(DEFAULT_FLIGHT.balanceHeat);
  });

  it('a patch on a tear held shut waits for four rivets, with nobody holding it, then is sound', () => {
    const sim = new EnvelopeSim(canvas);
    sim.reset(1);
    sim.open(1);
    sim.setHolds(1, [[1, 0.5]]);
    expect(sim.press(1)).toBe('held');
    expect(sim.leak).toBe(0);
    expect(sim.tears[1].patchLength).toBe(patchLengthFor(TEAR_START));
    expect(sim.tears[1].life).toBe(HELD_LIFE);
    // Let go to climb down for the hammer: the patch keeps waiting.
    sim.setHolds(1, []);
    sim.step(0, true, HELD_LIFE / 2);
    expect(sim.tears[1].riveting).toBe(true);
    for (let r = 0; r < RIVETS - 1; r++) expect(sim.rivet(1, r)).toBe(true);
    expect(sim.rivet(1, 0)).toBe(false); // already in
    expect(sim.tears[1].phase).toBe('patched');
    expect(sim.rivet(1, RIVETS - 1)).toBe(true);
    expect(sim.tears[1].phase).toBe('sound');
    expect(sim.unmended).toBe(0);
    // Sound for good: the patch never peels.
    for (let t = 0; t < 300; t++) sim.step(t, true, 1);
    expect(sim.tears[1].phase).toBe('sound');
  });

  it('a patch held shut but not riveted in time peels off', () => {
    const sim = new EnvelopeSim(canvas);
    sim.reset(1);
    sim.open(2);
    sim.setHolds(0, [[2, 0.5]]);
    expect(sim.press(2)).toBe('held');
    sim.setHolds(0, []);
    expect(sim.rivet(2, 0)).toBe(true);
    sim.step(0, true, HELD_LIFE - PEEL_SECONDS + 1);
    expect(sim.tears[2].peeling).toBe(true);
    expect(sim.leak).toBeGreaterThan(0);
    sim.step(1, true, PEEL_SECONDS);
    expect(sim.tears[2].phase).toBe('open');
    expect(sim.tears[2].rivets).toBe(0);
  });

  it('a rushed patch stops the leak for a minute, then peels off', () => {
    const sim = new EnvelopeSim(canvas);
    sim.reset(1);
    sim.open(0);
    expect(sim.press(0)).toBe('rushed');
    expect(sim.leak).toBe(0);
    sim.step(0, true, RUSHED_LIFE - PEEL_SECONDS + 1);
    expect(sim.tears[0].peeling).toBe(true);
    expect(sim.leak).toBeGreaterThan(0);
    expect(sim.rivet(0, 0)).toBe(false);
    sim.step(1, true, PEEL_SECONDS);
    expect(sim.tears[0].phase).toBe('open');
    // A fresh patch can go over a rushed one, held shut this time.
    expect(sim.press(0)).toBe('rushed');
    sim.setHolds(0, [[0, 0.5]]);
    expect(sim.press(0)).toBe('held');
    expect(sim.tears[0].patches).toBe(3);
  });

  it('take hold of an edge, a patch and a rivet only close to them', () => {
    const spot = TEAR_SPOTS[0];
    const p = slitPoint(canvas, spot, TEAR_START, 0.25, EDGE_DROP, point());
    expect(edgeHold(canvas, spot, TEAR_START, p.x, p.y, p.z, point())).toBeCloseTo(0.25);
    expect(edgeHold(canvas, spot, TEAR_START, p.x, p.y - EDGE_REACH - 0.02, p.z, point())).toBeNaN();
    const middle = canvas(spot.x, spot.z) - PATCH_DROP;
    expect(patchTouches(canvas, spot, spot.x, middle - 0.1, spot.z)).toBe(true);
    expect(patchTouches(canvas, spot, spot.x, middle - 0.4, spot.z)).toBe(false);
    // The rivets sit at the patch's corners, under it.
    const r = rivetPoint(canvas, spot, PATCH_MIN, 3, point());
    expect(r.y).toBeLessThan(canvas(r.x, r.z) - PATCH_DROP);
    expect(Math.hypot(r.x - spot.x, r.z - spot.z)).toBeGreaterThan(0.1);
    expect(patchLengthFor(TEAR_MAX)).toBe(PATCH_MAX);
  });

  it('go to the guest and back unchanged', () => {
    const host = new EnvelopeSim(canvas);
    host.reset(5);
    host.open(0);
    host.open(2);
    host.setHolds(0, [[2, 0.5]]);
    host.press(2);
    host.rivet(2, 1);
    host.setHolds(0, [[0, 0.3]]);
    const guest = new EnvelopeSim(canvas);
    expect(guest.adopt(JSON.parse(JSON.stringify(host.toWire())))).toBe(true);
    expect(guest.toWire()).toEqual(host.toWire());
    // Held shut on the host: the guest draws it held.
    expect(guest.tears[0].closed).toBe(true);
    expect(guest.tears[2].riveting).toBe(true);
    expect(guest.adopt({ r: 1, n: 0, s: [[0]] })).toBe(false);
  });

  it("in a crew, either player's choice of how often they come counts: the gentler wins", () => {
    expect(gentlerRate('often', 'off')).toBe('off');
    expect(gentlerRate('normal', 'often')).toBe('normal');
    expect(gentlerRate('off', 'normal')).toBe('off');
  });

  it('cost points left unmended at the finish', () => {
    const base = { seconds: 120, bricks: 6, rings: 2, ringsTotal: 2, tears: 0, cargo: 100, crates: 2, cratesTotal: 2, target: 0 };
    expect(scoreRun(base).score - scoreRun({ ...base, unmended: 2 }).score).toBe(2 * UNMENDED_POINTS);
  });
});

describe("the crewmate's feet", () => {
  it('go with their pose, in centimetres', () => {
    const buffer = new ArrayBuffer(POSE_PACKET_BYTES);
    const pose = createAvatarPose();
    pose.feet = 2.5;
    const out = createAvatarPose();
    encodePose(buffer, 1, 0, pose);
    expect(decodePose(new DataView(buffer), { seq: 0, timeMs: 0 }, out)).toBe(true);
    expect(out.feet).toBeCloseTo(2.5, 2);
    // From a page before repairs: on the deck.
    expect(decodePose(new DataView(buffer, 0, POSE_PACKET_BYTES - 1), { seq: 0, timeMs: 0 }, out)).toBe(true);
    expect(out.feet).toBe(0);
  });
});
