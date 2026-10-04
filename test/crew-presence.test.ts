import { describe, expect, it } from 'vitest';
import { CrewPresence, SILENT_MS } from '../src/net/crew-presence.js';

describe('CrewPresence', () => {
  it('never pauses a player who has had no crewmate', () => {
    const p = new CrewPresence();
    for (const state of ['idle', 'connecting', 'waiting', 'error'] as const) {
      p.update(state, false, false, 0);
      expect(p.status).toBe('solo');
      expect(p.paused).toBe(false);
    }
  });

  it('pauses while the crewmate is away or silent and resumes when they are back', () => {
    const p = new CrewPresence();
    expect(p.update('connected', false, false, 10)).toBe('together');
    expect(p.paused).toBe(false);
    expect(p.update('connected', false, true, 10)).toBe('away');
    expect(p.message()).toMatch(/stepped away/);
    expect(p.update('connected', false, false, SILENT_MS + 1)).toBe('silent');
    expect(p.paused).toBe(true);
    expect(p.update('connected', false, false, 20)).toBe('together');
    expect(p.paused).toBe(false);
  });

  it('tells a dropped connection from a crewmate who left', () => {
    const p = new CrewPresence();
    p.update('connected', false, false, 0);
    expect(p.update('connecting', true, false, 0)).toBe('reconnecting');
    expect(p.update('waiting', true, false, 0)).toBe('reconnecting');
    expect(p.update('waiting', false, false, 0)).toBe('waiting');
    expect(p.message()).toMatch(/left/);
    expect(p.update('error', false, false, 0)).toBe('lost');
    expect(p.paused).toBe(true);
  });

  it('forgets the crew when this player leaves the room', () => {
    const p = new CrewPresence();
    p.update('connected', false, false, 0);
    expect(p.update('idle', false, false, 0)).toBe('solo');
    expect(p.update('waiting', false, false, 0)).toBe('solo');
    expect(p.hadCrew).toBe(false);
  });
});
