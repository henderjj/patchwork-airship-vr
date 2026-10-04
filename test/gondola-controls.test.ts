import { describe, expect, it } from 'vitest';
import {
  BALLAST_BAG_KG,
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
});
