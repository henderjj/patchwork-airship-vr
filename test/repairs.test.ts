import { describe, expect, it } from 'vitest';
import { createAvatarPose, decodePose, encodePose, POSE_PACKET_BYTES } from '../src/net/pose-codec.js';
import { envelopeUnderside } from '../src/scene-assets/repairs.scene-asset.js';
import {
  EDGE_DROP,
  EDGE_REACH,
  edgeHold,
  ELLIPSOID_UNDERSIDE,
  EnvelopeSim,
  HOLD_GRACE,
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
  HAMMER_HEAD,
  HAMMER_REST,
  LADDER_REACH,
  LADDER_TOP,
  LADDER_X,
  LADDER_Z,
  LOFT,
  LOFT_EYE,
  LOFT_FLOOR,
  LOFT_HATCH,
  LOFT_WALK,
  ladderHold,
  type LadderHold,
  loftRaise,
  PATCH_BOX,
  RUNGS,
} from '../src/sim/loft.js';
import { scoreRun } from '../src/sim/route.js';

const hold = (): LadderHold => ({ x: 0, y: 0, z: 0, stile: false, distance: 0 });
const point = () => ({ x: 0, y: 0, z: 0 });

describe('the patch loft and its ladder', () => {
  it("puts everyone's eyes at the same height on the loft", () => {
    expect(loftRaise(DEFAULT_EYE) + DEFAULT_EYE).toBeCloseTo(LOFT_EYE);
    expect(loftRaise(Number.NaN)).toBeCloseTo(LOFT_EYE - DEFAULT_EYE);
    expect(loftRaise(1.85) + 1.85).toBeCloseTo(LOFT_EYE);
    // Seated (eyes low) or very tall: raised as far as it goes, and no further.
    expect(loftRaise(0.6)).toBe(3);
    expect(loftRaise(2.4)).toBe(2);
  });

  it('takes hold of the nearest rung or stile in reach', () => {
    const h = hold();
    expect(ladderHold(LADDER_X + 0.05, RUNGS[2] + 0.02, 0.55, h)).toBe(true);
    expect(h.stile).toBe(false);
    expect(h.y).toBeCloseTo(RUNGS[2]);
    expect(ladderHold(LADDER_X, 3.0, LADDER_Z[0] - 0.04, h)).toBe(true);
    expect(h.stile).toBe(true);
    expect(h.y).toBeCloseTo(3.0);
    expect(ladderHold(LADDER_X + LADDER_REACH + 0.05, 1, 0.55, h)).toBe(false);
    // Above the stiles' tops, nothing to hold.
    expect(ladderHold(LADDER_X, LADDER_TOP + 0.2, LADDER_Z[0], h)).toBe(false);
  });

  it("stands the ladder in the loft's hatch, clear of its floor", () => {
    for (const z of LADDER_Z) {
      expect(z).toBeGreaterThan(LOFT_HATCH.z0);
      expect(z).toBeLessThan(LOFT_HATCH.z1);
    }
    expect(LADDER_X).toBeGreaterThan(LOFT_HATCH.x0);
    expect(LADDER_X).toBeLessThan(LOFT_HATCH.x1);
    // The top rung is at the floor, so the last step up is onto the loft.
    expect(RUNGS[RUNGS.length - 1]).toBeLessThanOrEqual(LOFT_FLOOR);
  });

  it('climbs hand over hand: pulling a hand down raises the player', () => {
    const c = new Climber();
    const top = loftRaise(DEFAULT_EYE);
    let rig = 0;
    // Each stroke: take hold at chest height, pull down 0.4 m over a few frames, let go.
    let strokes = 0;
    while (!c.onLoft && strokes < 20) {
      const side = strokes % 2 ? 'right' : 'left';
      const grabAt = 1.2 + rig;
      c.grab(side, grabAt);
      for (let f = 1; f <= 8; f++) {
        // The tracked hand moves down in the room; the rig carries it up as the player climbs.
        const tracked = 1.2 - 0.05 * f;
        const y = tracked + rig;
        rig = c.update(1 / 72, side === 'left' ? y : 0, side === 'right' ? y : 0, top);
      }
      c.release(side);
      for (let f = 0; f < 30; f++) rig = c.update(1 / 72, 0, 0, top);
      strokes++;
    }
    expect(c.onLoft).toBe(true);
    expect(c.height).toBeCloseTo(top);
    expect(c.feet).toBe(LOFT_FLOOR);
    expect(strokes).toBeGreaterThan(4);
  });

  it('stays put when let go partway, and climbs down by pushing up', () => {
    const c = new Climber();
    c.grab('left', 1.5);
    c.update(1 / 72, 1.0, 0, 2.5);
    expect(c.height).toBeCloseTo(0.2); // at most 0.2 m a frame
    // What the clamp held back is lost (the hand's hold moved with it): a tracking glitch can't throw the player up.
    c.update(1 / 72, 1.2, 0, 2.5);
    expect(c.height).toBeCloseTo(0.2);
    c.update(1 / 72, 0.95, 0, 2.5);
    expect(c.height).toBeCloseTo(0.4);
    c.release('left');
    for (let f = 0; f < 50; f++) c.update(1 / 72, 0, 0, 2.5);
    expect(c.height).toBeCloseTo(0.4);
    expect(c.between).toBe(true);
    // Hold on and push up: down the ladder, and no lower than the deck.
    c.grab('right', 1.5);
    for (let f = 1; f <= 10; f++) c.update(1 / 72, 0, 1.5 + 0.1 * f, 2.5);
    expect(c.height).toBe(0);
    c.release('right');
    expect(c.between).toBe(false);
  });

  it('hands over to the other hand still on the ladder', () => {
    const c = new Climber();
    c.grab('left', 1.4);
    c.grab('right', 1.6);
    c.update(1 / 72, 1.4, 1.5, 2.5); // the right (the latest) climbs
    expect(c.height).toBeCloseTo(0.1);
    c.release('right');
    // The left takes over from where it is now: no jump.
    c.update(1 / 72, 1.5, 0, 2.5);
    expect(c.height).toBeCloseTo(0.1);
    c.update(1 / 72, 1.3, 0, 2.5);
    expect(c.height).toBeCloseTo(0.3);
  });

  it('steps up onto the loft when let go just below it', () => {
    const c = new Climber();
    c.height = 2.35;
    for (let f = 0; f < 30; f++) c.update(1 / 72, 0, 0, 2.48);
    expect(c.onLoft).toBe(true);
  });

  it('keeps the walking bounds on the loft', () => {
    expect(LOFT_WALK.x0).toBeGreaterThan(LOFT.x0);
    expect(LOFT_WALK.x1).toBeLessThan(LOFT.x1);
  });
});

describe("the envelope's underside over the loft", () => {
  const canvas = envelopeUnderside();

  it('is the modelled envelope, close to its ellipsoid', () => {
    for (const [x, z] of [[-0.5, 0], [-0.2, 0.55], [-0.8, 1.15]]) {
      expect(Math.abs(canvas(x, z) - ELLIPSOID_UNDERSIDE(x, z))).toBeLessThan(0.08);
    }
    // Measured before the compaction: 4.475 at (-0.5, 0), 4.488 at (-0.2, 0.55), 4.625 at (-0.8, 1.15).
    expect(canvas(-0.5, 0)).toBeCloseTo(4.475, 1);
    expect(canvas(-0.8, 1.15)).toBeCloseTo(4.625, 1);
  });

  it('puts every tear in reach overhead from the loft, over its floor', () => {
    for (const spot of TEAR_SPOTS) {
      for (const t of [0, 0.5, 1]) {
        const p = slitPoint(canvas, spot, TEAR_MAX, t, EDGE_DROP, point());
        expect(p.x).toBeGreaterThan(LOFT.x0 - 0.05);
        expect(p.x).toBeLessThan(LOFT.x1 + 0.05);
        expect(p.z).toBeGreaterThan(LOFT.z0 - 0.05);
        expect(p.z).toBeLessThan(LOFT.z1 + 0.05);
        // Above the eyes, but not out of reach.
        expect(p.y - LOFT_EYE).toBeGreaterThan(0.2);
        expect(p.y - LOFT_EYE).toBeLessThan(0.65);
      }
    }
  });

  it('keeps the patch box and the hammer in reach on the loft', () => {
    expect(PATCH_BOX[1] - LOFT_EYE).toBeGreaterThan(-1);
    expect(HAMMER_REST[1] + HAMMER_HEAD - LOFT_FLOOR).toBeLessThan(LOFT_EYE - LOFT_FLOOR);
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
    // Two hands far enough apart along it hold it shut, and it stops growing.
    sim.setHolds(0, [[0, 0.1]]);
    sim.setHolds(1, [[0, 0.9]]);
    expect(sim.tears[0].closed).toBe(true);
    const held = sim.leak;
    expect(held).toBeLessThan(fresh / 3);
    const length = sim.tears[0].length;
    sim.step(31, true, 10);
    expect(sim.tears[0].length).toBe(length);
    // Two hands close together don't.
    sim.setHolds(1, [[0, 0.2]]);
    expect(sim.tears[0].closed).toBe(false);
  });

  it('playing alone, are held shut by one hand, leaving the other for the patch and the hammer', () => {
    const sim = new EnvelopeSim(canvas);
    sim.reset(1);
    sim.open(1);
    sim.solo = true;
    expect(sim.tears[1].closed).toBe(false);
    sim.setHolds(0, [[1, 0.5]]);
    expect(sim.tears[1].closed).toBe(true);
    expect(sim.press(1)).toBe('held');
    for (let r = 0; r < RIVETS; r++) expect(sim.rivet(1, r)).toBe(true);
    expect(sim.tears[1].phase).toBe('sound');
    // With a crewmate, one hand isn't enough.
    sim.open(1);
    sim.solo = false;
    sim.setHolds(0, [[1, 0.5]]);
    expect(sim.tears[1].closed).toBe(false);
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

  it('a patch on a tear held shut waits for four rivets, then is sound', () => {
    const sim = new EnvelopeSim(canvas);
    sim.reset(1);
    sim.open(1);
    sim.setHolds(1, [[1, 0.15], [1, 0.85]]);
    expect(sim.press(1)).toBe('held');
    expect(sim.leak).toBe(0);
    expect(sim.tears[1].patchLength).toBe(patchLengthFor(TEAR_START));
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

  it('a patch let go of before its rivets are in turns rushed', () => {
    const sim = new EnvelopeSim(canvas);
    sim.reset(1);
    sim.open(2);
    sim.setHolds(0, [[2, 0.1], [2, 0.9]]);
    expect(sim.press(2)).toBe('held');
    sim.setHolds(0, []);
    sim.step(0, true, HOLD_GRACE / 2);
    expect(sim.tears[2].rushed).toBe(false);
    sim.step(1, true, HOLD_GRACE);
    expect(sim.tears[2].rushed).toBe(true);
    expect(sim.rivet(2, 0)).toBe(false);
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
    sim.setHolds(0, [[0, 0.1], [0, 0.9]]);
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
    host.setHolds(0, [[2, 0.1], [2, 0.9]]);
    host.press(2);
    host.rivet(2, 1);
    const guest = new EnvelopeSim(canvas);
    expect(guest.adopt(JSON.parse(JSON.stringify(host.toWire())))).toBe(true);
    expect(guest.toWire()).toEqual(host.toWire());
    // Held shut on the host: the guest can rivet it too.
    expect(guest.tears[2].closed).toBe(true);
    expect(guest.adopt({ r: 1, n: 0, s: [[0]] })).toBe(false);
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
    pose.feet = LOFT_FLOOR;
    const out = createAvatarPose();
    encodePose(buffer, 1, 0, pose);
    expect(decodePose(new DataView(buffer), { seq: 0, timeMs: 0 }, out)).toBe(true);
    expect(out.feet).toBeCloseTo(LOFT_FLOOR, 2);
    // From a page before repairs: on the deck.
    expect(decodePose(new DataView(buffer, 0, POSE_PACKET_BYTES - 1), { seq: 0, timeMs: 0 }, out)).toBe(true);
    expect(out.feet).toBe(0);
  });
});
