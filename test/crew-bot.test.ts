import { describe, expect, it } from 'vitest';
import {
  BOT_GRAVITY,
  crankFollowAngle,
  HaulRhythm,
  interceptPoint,
  ropeFollowAlong,
  stepTowards,
  throwVelocity,
} from '../src/sim/crew-bot.js';

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
});
