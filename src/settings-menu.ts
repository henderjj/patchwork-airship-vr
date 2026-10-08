import { DEFAULT_SETTINGS, SAVED_SETTINGS_KEY, type Settings, settings } from './settings.js';

/** One choice in the Settings menu: a URL setting, its label and the values offered. */
export interface MenuItem {
  key: string;
  label: string;
  options: readonly (readonly [value: string, label: string])[];
  /** The value in effect, as the URL would spell it. */
  current: (s: Settings) => string;
}

const onOff = (s: boolean) => (s ? '1' : '0');

export const MENU_ITEMS: readonly MenuItem[] = [
  {
    key: 'bot',
    label: 'This page plays as',
    options: [
      ['0', 'Me'],
      ['1', 'Practice crewmate (a bot)'],
    ],
    current: (s) => onOff(s.bot),
  },
  {
    key: 'motion',
    label: 'Ship',
    options: [
      ['flight', 'Fly it yourselves'],
      ['still', 'Held still'],
      ['gentle', 'Scripted, gentle'],
      ['tour', 'Scripted, tour'],
      ['lively', 'Scripted, lively'],
    ],
    current: (s) => s.motion,
  },
  {
    key: 'hz',
    label: 'Frame rate',
    options: [
      ['72', '72 Hz'],
      ['80', '80 Hz'],
      ['90', '90 Hz'],
      ['120', '120 Hz'],
    ],
    current: (s) => String(s.hz),
  },
  { key: 'audio', label: 'Ship sounds', options: [['1', 'On'], ['0', 'Off']], current: (s) => onOff(s.audio) },
  {
    key: 'voice',
    label: "Crewmate's voice",
    options: [
      ['spatial', 'From where they stand'],
      ['plain', 'Not positioned'],
      ['off', 'Off'],
    ],
    current: (s) => s.voice,
  },
  {
    key: 'comfort',
    label: 'Comfort question',
    options: [
      ['0', 'Never'],
      ['60', 'Every minute'],
      ['120', 'Every 2 minutes'],
      ['300', 'Every 5 minutes'],
    ],
    current: (s) => String(s.comfort),
  },
  { key: 'hud', label: 'Perf HUD', options: [['1', 'Shown'], ['0', 'Hidden']], current: (s) => onOff(s.hud) },
  {
    key: 'clouds',
    label: 'Clouds',
    options: [
      ['10', 'Few'],
      ['40', 'Normal'],
      ['80', 'Many'],
    ],
    current: (s) => String(s.clouds),
  },
  { key: 'rain', label: 'Rain', options: [['0', 'Off'], ['1', 'On']], current: (s) => onOff(s.rain) },
  { key: 'shadows', label: 'Deck shadows', options: [['0', 'Off'], ['1', 'On']], current: (s) => onOff(s.shadows) },
  {
    key: 'foveation',
    label: 'Foveation',
    options: [
      ['0', 'Off'],
      ['0.5', 'Half'],
      ['1', 'Full'],
    ],
    current: (s) => String(s.foveation),
  },
];

/**
 * The query string the menu saves: only the choices that differ from the
 * defaults, so a later change of default still reaches players who never
 * picked that setting.
 */
export function menuQuery(values: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams();
  for (const item of MENU_ITEMS) {
    const value = values[item.key];
    if (value !== undefined && value !== item.current(DEFAULT_SETTINGS)) {
      params.set(item.key, value);
    }
  }
  return params.toString();
}

/**
 * The Settings menu on the crew panel, so players set the game up before
 * entering VR rather than editing the page URL. Saving keeps the choices in
 * this browser and reloads the page with them (settings are read once at
 * load); the crew code stays in the URL, so a crew is rejoined. A setting
 * still given in the URL wins over the saved one, for testing.
 */
export function createSettingsMenu(): HTMLElement {
  const details = document.createElement('details');
  details.id = 'settings-menu';
  const summary = document.createElement('summary');
  summary.textContent = 'Settings';
  summary.style.cssText = 'cursor:pointer;color:#cbd5e1';
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:4px 8px;align-items:center;margin-top:6px';
  const selects = new Map<string, HTMLSelectElement>();
  for (const item of MENU_ITEMS) {
    const label = document.createElement('label');
    label.textContent = item.label;
    label.htmlFor = `setting-${item.key}`;
    label.style.color = '#94a3b8';
    const select = document.createElement('select');
    select.id = `setting-${item.key}`;
    select.style.cssText = 'font:inherit;padding:2px 4px;border-radius:4px;border:1px solid #475569;background:#0f172a;color:inherit';
    const current = item.current(settings);
    const options = item.options.some(([value]) => value === current) ? item.options : [...item.options, [current, `${current} (from the link)`] as const];
    for (const [value, text] of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.value = current;
    selects.set(item.key, select);
    grid.append(label, select);
  }
  const note = document.createElement('div');
  note.textContent = "In a crew, the ship flies as the crew's first player has it set.";
  note.style.cssText = 'color:#94a3b8;font-size:12px;margin-top:4px';
  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:6px;margin-top:6px';
  const save = menuButton('Save and reload', () => {
    const values: Record<string, string> = {};
    selects.forEach((select, key) => {
      values[key] = select.value;
    });
    reloadWith(menuQuery(values));
  });
  save.id = 'settings-save';
  const reset = menuButton('Defaults', () => reloadWith(''));
  reset.id = 'settings-reset';
  buttons.append(save, reset);
  details.append(summary, grid, note, buttons);
  (window as { __settings?: Settings }).__settings = settings;
  return details;
}

/** Keep `query` as the saved settings and reload, dropping the menu's settings from the URL so the saved ones apply. */
function reloadWith(query: string): void {
  const url = new URL(location.href);
  for (const item of MENU_ITEMS) {
    url.searchParams.delete(item.key);
  }
  try {
    if (query) {
      localStorage.setItem(SAVED_SETTINGS_KEY, query);
    } else {
      localStorage.removeItem(SAVED_SETTINGS_KEY);
    }
  } catch {
    // Private browsing: keep the choices in the URL instead.
    new URLSearchParams(query).forEach((value, key) => url.searchParams.set(key, value));
  }
  location.replace(url);
}

function menuButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText =
    'font:inherit;padding:3px 8px;border-radius:4px;border:1px solid #64748b;background:#1e293b;color:inherit;cursor:pointer';
  b.addEventListener('click', onClick);
  return b;
}
