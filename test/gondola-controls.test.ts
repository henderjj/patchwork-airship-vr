import { describe, expect, it } from 'vitest';
import {
  BALLAST_BAG_KG,
  BELL_HOOK,
  BELL_LANYARD_END,
  BELL_MOUTH,
  BELL_PIVOT,
  BELL_STRIKE_ANGLE,
  BellClapper,
  CLAPPER_BALL,
  CLAPPER_BALL_RADIUS,
  BALLAST_BAGS,
  ballastDropped,
  HOPPER,
  inHopper,
  overboard,
  rudderFromHand,
  TILLER_PIVOT,
  tillerHandle,
  toggleFromHand,
  trimFromCrew,
  VENT_PULL,
  VENT_TOGGLE,
  ventFromToggle,
} from '../src/sim/gondola-controls.js';

describe('gondola controls', () => {
  it('burns a brick resting on the burner top or dropped into the hopper, not one beside it', () => {
    expect(inHopper(HOPPER.x, 0.64, HOPPER.z)).toBe(true);
    expect(inHopper(HOPPER.x + 0.15, 0.8, HOPPER.z - 0.1)).toBe(true);
    expect(inHopper(HOPPER.x, 0.3, HOPPER.z)).toBe(false);
    expect(inHopper(HOPPER.x + 0.35, 0.64, HOPPER.z)).toBe(false);
    expect(inHopper(HOPPER.x, 1.2, HOPPER.z)).toBe(false);
  });

  it('opens the vent as the toggle is pulled down, and never pushes it up', () => {
    expect(ventFromToggle(VENT_TOGGLE[1])).toBe(0);
    expect(ventFromToggle(VENT_TOGGLE[1] - VENT_PULL / 2)).toBeCloseTo(0.5, 6);
    expect(ventFromToggle(VENT_TOGGLE[1] - 1)).toBe(1);
    // Grabbed 2 cm above the toggle: the hand rising doesn't lift the toggle past rest.
    expect(toggleFromHand(VENT_TOGGLE[1] + 0.3, 0.02)).toBe(VENT_TOGGLE[1]);
    expect(toggleFromHand(VENT_TOGGLE[1] - 0.1 + 0.02, 0.02)).toBeCloseTo(VENT_TOGGLE[1] - 0.1, 6);
    expect(toggleFromHand(0, 0.02)).toBeCloseTo(VENT_TOGGLE[1] - VENT_PULL, 6);
  });

  it('turns the ship away from the side the tiller is pushed to, like a boat', () => {
    const h = { x: 0, y: 0, z: 0 };
    expect(rudderFromHand(TILLER_PIVOT[0], TILLER_PIVOT[2] - 0.6)).toBeCloseTo(0, 6);
    // Handle pushed to starboard: rudder to port (negative).
    expect(rudderFromHand(TILLER_PIVOT[0] + 0.2, TILLER_PIVOT[2] - 0.5)).toBeLessThan(-0.5);
    expect(rudderFromHand(TILLER_PIVOT[0] - 0.2, TILLER_PIVOT[2] - 0.5)).toBeGreaterThan(0.5);
    expect(rudderFromHand(5, TILLER_PIVOT[2] - 0.1)).toBe(-1);
    // The handle's position round-trips through the hand.
    for (const r of [-1, -0.4, 0, 0.7, 1]) {
      tillerHandle(r, h);
      expect(rudderFromHand(h.x, h.z)).toBeCloseTo(r, 6);
    }
  });

  it('drops a bag let go outside the rail and counts its weight', () => {
    const [x, , z] = BALLAST_BAGS[0];
    expect(overboard(x, z)).toBe(true);
    expect(overboard(0.6, z)).toBe(false);
    expect(ballastDropped(0)).toBe(0);
    expect(ballastDropped(0b1010)).toBe(2 * BALLAST_BAG_KG);
  });

  it('trims nose-down with the crew at the bow and level with one at each end', () => {
    const out = { pitch: 0, roll: 0 };
    trimFromCrew([0, 0], [-1.2, -1.0], 2, out);
    expect(out.pitch).toBeLessThan(-0.02);
    trimFromCrew([0.3, -0.3], [-1.2, 1.2], 2, out);
    expect(out.pitch).toBeCloseTo(0, 6);
    expect(out.roll).toBeCloseTo(0, 6);
    trimFromCrew([0.8], [0], 1, out);
    expect(out.roll).toBeGreaterThan(0);
  });

  describe('ship\'s bell', () => {
    const [x0, , z0] = BELL_LANYARD_END;
    const dt = 1 / 90;
    /** Swing the clapper for `seconds` with the hand at `hand(t)` (null: let go); returns each strike as [time, side]. */
    const swing = (clapper: BellClapper, seconds: number, hand: (t: number) => [number, number] | null) => {
      const strikes: [number, string][] = [];
      for (let t = 0; t < seconds; t += dt) {
        const h = hand(t);
        if (clapper.step(dt, h !== null, h?.[0], h?.[1]) > 0) {
          const s = clapper.lastStrike;
          strikes.push([t, Math.abs(s.x) > Math.abs(s.z) ? (s.x > 0 ? 'starboard' : 'port') : s.z > 0 ? 'aft' : 'fore']);
        }
      }
      return strikes;
    };

    it('stops the clapper\'s ball where it meets the inside of the bell', () => {
      const ballY = BELL_PIVOT[1] - BELL_HOOK[1] - CLAPPER_BALL * Math.cos(BELL_STRIKE_ANGLE);
      const t = (ballY - BELL_MOUTH.crownY) / (BELL_MOUTH.lipY - BELL_MOUTH.crownY);
      const wall = BELL_MOUTH.crownRadius + t * (BELL_MOUTH.lipRadius - BELL_MOUTH.crownRadius);
      expect(CLAPPER_BALL * Math.sin(BELL_STRIKE_ANGLE) + CLAPPER_BALL_RADIUS).toBeCloseTo(wall, 4);
      expect(BELL_STRIKE_ANGLE).toBeGreaterThan(0.3);
      expect(BELL_STRIKE_ANGLE).toBeLessThan(0.6);
    });

    it('hangs still and silent until the lanyard is pulled', () => {
      const clapper = new BellClapper();
      expect(swing(clapper, 2, () => null)).toEqual([]);
      expect(swing(clapper, 2, () => [x0, z0])).toEqual([]);
      expect(clapper.peak).toBeLessThan(0.01);
    });

    it('swings the ball against the side the lanyard is pulled to, once, then rests there', () => {
      const clapper = new BellClapper();
      const strikes = swing(clapper, 2, (t) => [x0 + 0.08 * Math.min(1, t / 0.15), z0]);
      expect(strikes.map(([, side]) => side)).toEqual(['starboard']);
      expect(strikes[0][0]).toBeLessThan(0.25);
      expect(clapper.x).toBeCloseTo(BELL_STRIKE_ANGLE, 3);
      // Fore and aft too.
      const other = new BellClapper();
      expect(swing(other, 1, (t) => [x0, z0 - 0.06 * Math.min(1, t / 0.1)]).map(([, side]) => side)).toEqual(['fore']);
    });

    it('rings on each side in turn when pulled from side to side', () => {
      for (const hz of [1, 2, 3]) {
        const clapper = new BellClapper();
        const strikes = swing(clapper, 3, (t) => [x0 + 0.07 * Math.sin(2 * Math.PI * hz * t), z0]);
        expect(strikes.length).toBe(Math.round(3 * hz * 2));
        strikes.forEach(([, side], i) => expect(side).toBe(i % 2 === 0 ? 'starboard' : 'port'));
      }
    });

    it('leans the ball against the bell without ringing when pulled very slowly', () => {
      const clapper = new BellClapper();
      expect(swing(clapper, 2, (t) => [x0 + 0.08 * Math.min(1, t / 1.5), z0])).toEqual([]);
      expect(clapper.x).toBeCloseTo(BELL_STRIKE_ANGLE, 3);
    });

    it('swings back to hang straight when let go', () => {
      const clapper = new BellClapper();
      swing(clapper, 1, (t) => [x0 + 0.08 * Math.min(1, t / 0.15), z0]);
      swing(clapper, 4, () => null);
      expect(Math.abs(clapper.x)).toBeLessThan(0.02);
      expect(Math.abs(clapper.vx)).toBeLessThan(0.1);
    });

    it('shows a strike from elsewhere without sounding it again', () => {
      const clapper = new BellClapper();
      clapper.knock(-1, 0, 1);
      expect(clapper.x).toBeCloseTo(-BELL_STRIKE_ANGLE, 6);
      expect(swing(clapper, 0.9, () => null)).toEqual([]);
      expect(clapper.strikes).toBe(0);
    });
  });
});
