import { describe, expect, it } from 'vitest';
import {
  BOT_GRAVITY,
  BOT_LADDER,
  crankFollowAngle,
  HaulRhythm,
  interceptPoint,
  ropeFollowAlong,
  stepTowards,
  tearStand,
  throwVelocity,
  viaLadder,
} from '../src/sim/crew-bot.js';
import { TEAR_SPOTS } from '../src/sim/envelope.js';
import { LOFT_HATCH, LOFT_WALK } from '../src/sim/loft.js';

describe('practice crewmate', () => {
  it('holds the other crank handle, moved on by the time since the player was seen', () => {
    expect(crankFollowAngle(0.5, 0, 100)).toBeCloseTo(0.5 + Math.PI);
    expect(crankFollowAngle(0.5, 6, 100)).toBeCloseTo(0.5 + Math.PI + 0.6);
  });

  it('copies a stroke beside the player, within the line', () => {
    expect(ropeFollowAlong(0.5, 1, 100, 0.6, 2.1)).toBeCloseTo(1.2);
    expect(ropeFollowAlong(2.0, 1, 100, 0.6, 2.1)).toBe(2.1);
  });

  it('meets a brick on its falling path, and lets one go past out of reach', () => {
    const out: [number, number, number] = [0, 0, 0];
    // Thrown level at 4 m/s from 2 m away: after 0.5 s it is at the hand, 1.23 m lower.
    const rest: [number, number, number] = [0, 1.2 - 0.5 * BOT_GRAVITY * 0.25, -2];
    expect(interceptPoint([0, 1.2, 0], [0, 0, -4], rest, out)).toBe(true);
    expect(Math.hypot(out[0] - rest[0], out[1] - rest[1], out[2] - rest[2])).toBeLessThan(0.05);
    expect(interceptPoint([3, 1.2, 0], [0, 0, -4], rest, out)).toBe(false);
  });

  it('throws so the brick arrives where it aims', () => {
    const v: [number, number, number] = [0, 0, 0];
    const from: [number, number, number] = [0, 1.2, 0];
    const to: [number, number, number] = [1, 1.1, -2];
    throwVelocity(from, to, 0.5, v);
    const t = 0.5;
    expect(from[0] + v[0] * t).toBeCloseTo(to[0]);
    expect(from[1] + v[1] * t - 0.5 * BOT_GRAVITY * t * t).toBeCloseTo(to[1]);
    expect(from[2] + v[2] * t).toBeCloseTo(to[2]);
  });

  it('walks at a limited speed', () => {
    const p: [number, number, number] = [0, 0, 0];
    expect(stepTowards(p, [1, 0, 0], 0.25)).toBeCloseTo(0.75);
    expect(p[0]).toBeCloseTo(0.25);
    expect(stepTowards(p, [1, 0, 0], 1)).toBe(0);
    expect(p[0]).toBe(1);
  });

  it("hauls on the ship's call: a stroke on every heave, hands in turn", () => {
    const rhythm = new HaulRhythm(2.1);
    const period = 1000;
    const starts: number[] = [];
    const sides: string[] = [];
    let botStarted = Number.NEGATIVE_INFINITY;
    for (let ms = 0; ms < 5000; ms += 10) {
      rhythm.setCall(ms + (period - (ms % period)) % period, period);
      rhythm.update(ms);
      if (rhythm.botStartMs !== botStarted) {
        botStarted = rhythm.botStartMs;
        starts.push(botStarted);
        sides.push(rhythm.botSide);
      }
    }
    expect(starts.length).toBeGreaterThanOrEqual(4);
    for (const start of starts) {
      expect(start % period).toBe(0);
    }
    expect(new Set(starts).size).toBe(starts.length);
    expect(sides[0]).not.toBe(sides[1]);
    // It holds the line through the stroke that starts on the heave.
    expect(rhythm.botAlong(rhythm.botSide, rhythm.botStartMs + 200)).not.toBeNull();
    // Without a call it goes back to keeping time with the player (none yet: it waits).
    rhythm.setCall(Number.NaN, 0);
    expect(rhythm.rhythmic(5000)).toBe(false);
  });

  it('keeps time with a player hauling hand over hand, and strokes when their next stroke is due', () => {
    const rhythm = new HaulRhythm(2.1);
    // The player strokes every 0.5 s, each hand in turn, 0.4 m to 0.9 m.
    const along = (t: number) => 0.4 + (0.5 * (1 - Math.cos(Math.PI * t))) / 2;
    const starts: number[] = [];
    let botStarted = Number.NEGATIVE_INFINITY;
    for (let ms = 0; ms < 3000; ms += 20) {
      const n = Math.floor(ms / 500);
      const phase = ms / 500 - n;
      for (const [i, side] of (['left', 'right'] as const).entries()) {
        const holding = n % 2 === i;
        rhythm.observe(side, holding, holding ? along(phase) : 0.9, ms);
      }
      rhythm.update(ms);
      if (rhythm.botStartMs !== botStarted) {
        botStarted = rhythm.botStartMs;
        starts.push(botStarted);
      }
    }
    expect(rhythm.period).toBeGreaterThan(480);
    expect(rhythm.period).toBeLessThan(520);
    // Once the rhythm is known, each of the bot's strokes starts with one of the player's.
    expect(starts.length).toBeGreaterThanOrEqual(3);
    for (const start of starts) {
      const off = ((start % 500) + 500) % 500;
      expect(Math.min(off, 500 - off)).toBeLessThan(60);
    }
    // The bot holds the line beside the player's hands (inboard of them), never on top.
    const held = rhythm.botAlong(rhythm.botSide, rhythm.botStartMs + 200);
    expect(held).not.toBeNull();
    expect(held!).toBeGreaterThan(0.9);
  });

  it('goes up and down the ladder to reach the patch loft', () => {
    type V = [number, number, number];
    const out: V = [0, 0, 0];
    // Same level: straight there.
    expect(viaLadder([0.5, 1.6, 0], [0, 1.6, 1], 1.6, 4.1, out)).toEqual([0, 1.6, 1]);
    // On the deck, wanting the loft: to the ladder first, then up it.
    expect(viaLadder([0.5, 1.6, 0], [-0.3, 4.1, 1], 1.6, 4.1, out)).toEqual([BOT_LADDER[0], 1.6, BOT_LADDER[1]]);
    expect(viaLadder([BOT_LADDER[0], 1.6, BOT_LADDER[1]], [-0.3, 4.1, 1], 1.6, 4.1, out)).toEqual([BOT_LADDER[0], 4.1, BOT_LADDER[1]]);
    // Partway up, wanting the deck: down.
    expect(viaLadder([BOT_LADDER[0], 3, BOT_LADDER[1]], [0.5, 1.6, 0], 1.6, 4.1, out)).toEqual([BOT_LADDER[0], 1.6, BOT_LADDER[1]]);
    // On the loft, wanting the deck: back to the ladder along the loft.
    expect(viaLadder([-0.3, 4.1, 1], [0.5, 1.6, 0], 1.6, 4.1, out)).toEqual([BOT_LADDER[0], 4.1, BOT_LADDER[1]]);
    // Walked step by step, it gets there by the ladder.
    const head: V = [0.5, 1.6, -0.5];
    for (let i = 0; i < 500; i++) stepTowards(head, viaLadder(head, [-0.3, 4.1, 1], 1.6, 4.1, out), 0.03);
    expect(head).toEqual([-0.3, 4.1, 1]);
  });

  it('stands beside each tear on the loft, clear of the hatch and away from the player', () => {
    const out: [number, number] = [0, 0];
    for (const spot of TEAR_SPOTS) {
      for (const player of [[spot.x - 0.3, spot.z - 0.3], [spot.x + 0.3, spot.z + 0.3]]) {
        const [x, z] = tearStand(spot, player[0], player[1], out);
        expect(x).toBeGreaterThanOrEqual(LOFT_WALK.x0);
        expect(x).toBeLessThanOrEqual(LOFT_WALK.x1);
        expect(z).toBeGreaterThanOrEqual(LOFT_WALK.z0);
        expect(z).toBeLessThanOrEqual(LOFT_WALK.z1);
        const overHatch = x < LOFT_HATCH.x1 && z > LOFT_HATCH.z0 && z < LOFT_HATCH.z1;
        expect(overHatch).toBe(false);
        // Within arm's reach of the slit's middle.
        expect(Math.hypot(x - spot.x, z - spot.z)).toBeLessThan(0.4);
      }
    }
    // Of the two sides of the across-the-loft tear forward of the hatch, the one further from the player.
    const fore = TEAR_SPOTS[0];
    expect(tearStand(fore, fore.x, fore.z + 0.5, out)[1]).toBeLessThan(fore.z);
  });
});
