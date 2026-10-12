import { describe, expect, it } from 'vitest';
import { LIVE_ITEMS, MAX_OPTIONS, withSetting } from '../src/live-settings.js';
import { MENU_ITEMS, menuQuery } from '../src/settings-menu.js';
import { DEFAULT_SETTINGS, mergeSettings, parseSettings } from '../src/settings.js';

describe('start-up settings', () => {
  it('saves only the choices that differ from the defaults', () => {
    expect(menuQuery({ motion: 'flight', rain: '1', clouds: '40' })).toBe('rain=1');
    expect(menuQuery({ motion: 'flight', clouds: '40' })).toBe('');
  });

  it('keeps the in-game settings saved before', () => {
    expect(menuQuery({ motion: 'tour', rain: '0' }, 'audio=0&rain=1&hz=72')).toBe('audio=0&hz=72&motion=tour');
  });

  it('lets the URL win over the saved settings', () => {
    const merged = mergeSettings('audio=0&motion=tour', '?motion=still&room=ABCD');
    const s = parseSettings(merged);
    expect(s.audio).toBe(false);
    expect(s.motion).toBe('still');
    expect(s.room).toBe('ABCD');
  });

  it('are not also in the game menu', () => {
    const live = new Set(LIVE_ITEMS.map((item) => item.key));
    expect(MENU_ITEMS.filter((item) => live.has(item.key as never))).toEqual([]);
  });
});

describe('in-game settings', () => {
  it('fit a row of the menu', () => {
    for (const item of LIVE_ITEMS) {
      expect(item.options.length).toBeLessThanOrEqual(MAX_OPTIONS);
      expect(item.options.map(([value]) => value)).toContain(item.current(DEFAULT_SETTINGS));
    }
  });

  it('are saved with the others, and dropped when back to the default', () => {
    expect(withSetting('motion=tour', 'audio', '0', '1')).toBe('motion=tour&audio=0');
    expect(withSetting('motion=tour&audio=0', 'audio', '1', '1')).toBe('motion=tour');
    const s = parseSettings(mergeSettings(withSetting('', 'comfort', '120', '0'), ''));
    expect(s.comfort).toBe(120);
  });
});
