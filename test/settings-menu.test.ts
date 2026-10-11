import { describe, expect, it } from 'vitest';
import { LIVE_ITEMS, MENU_ROWS, nextOption, optionLabel, withSetting } from '../src/live-settings.js';
import { MENU_ITEMS, menuQuery } from '../src/settings-menu.js';
import { mergeSettings, parseSettings } from '../src/settings.js';

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
  const audio = LIVE_ITEMS.find((item) => item.key === 'audio')!;
  const hz = LIVE_ITEMS.find((item) => item.key === 'hz')!;

  it('fit the menu', () => {
    expect(LIVE_ITEMS.length).toBeLessThanOrEqual(MENU_ROWS);
  });

  it('step through their choices and wrap round', () => {
    expect(nextOption(audio, '1')).toBe('0');
    expect(nextOption(audio, '0')).toBe('1');
    expect(nextOption(hz, '90')).toBe('120');
    expect(nextOption(hz, '120')).toBe('72');
    // A value from a link that isn't offered steps to the first choice.
    expect(nextOption(hz, '60')).toBe('72');
    expect(optionLabel(hz, '60')).toBe('60');
    expect(optionLabel(hz, '90')).toBe('90 Hz');
  });

  it('are saved with the others, and dropped when back to the default', () => {
    expect(withSetting('motion=tour', 'audio', '0', '1')).toBe('motion=tour&audio=0');
    expect(withSetting('motion=tour&audio=0', 'audio', '1', '1')).toBe('motion=tour');
    const s = parseSettings(mergeSettings(withSetting('', 'comfort', '120', '0'), ''));
    expect(s.comfort).toBe(120);
  });
});
