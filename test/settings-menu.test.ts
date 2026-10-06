import { describe, expect, it } from 'vitest';
import { menuQuery } from '../src/settings-menu.js';
import { mergeSettings, parseSettings } from '../src/settings.js';

describe('settings menu', () => {
  it('saves only the choices that differ from the defaults', () => {
    expect(menuQuery({ motion: 'flight', hz: '90', audio: '0', comfort: '60' })).toBe('audio=0&comfort=60');
    expect(menuQuery({ motion: 'flight', hz: '90' })).toBe('');
  });

  it('lets the URL win over the saved settings', () => {
    const merged = mergeSettings('audio=0&motion=tour', '?motion=still&room=ABCD');
    const s = parseSettings(merged);
    expect(s.audio).toBe(false);
    expect(s.motion).toBe('still');
    expect(s.room).toBe('ABCD');
  });
});
