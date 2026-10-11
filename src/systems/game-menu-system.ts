import { createSystem, InputComponent, type UIKitMLAsset, VisibilityState } from '@iwsdk/core';
import { heightShown, menuCrewLine, stepHeight } from '../game-flow.js';
import { changeSetting, LIVE_ITEMS, MAX_OPTIONS, onSettingChange } from '../live-settings.js';
import { crewControls, onCrewChange } from '../net/crew-controls.js';
import { CREW_COLORS } from '../scene-assets/avatar.scene-asset.js';
import { settings } from '../settings.js';
import { DEFAULT_CHARACTER_HEIGHT, EYES_BELOW_TOP, MAX_CHARACTER_HEIGHT, MIN_CHARACTER_HEIGHT } from '../sim/body-height.js';
import { body, chooseBody } from './body-height-system.js';
import { OPEN_MENU_EVENT } from './net-system.js';
import { PanelUi } from './panel-ui.js';
import { startScreen } from './start-screen-system.js';

/** Where the menu stands in VR when opened: ahead of the head and a little below the eyes, m. */
const DISTANCE = 0.9;
const DROP = 0.2;

/** The ring round the coat colour in effect, and round the others. */
const SWATCH_ON = '#1d1d1d';
const SWATCH_OFF = 'rgba(0, 0, 0, 0)';

/**
 * A row of choice buttons in the menu (`row-<id>-0` to `-3` in
 * public/ui/menu.uikitml): its choices, the one in effect, and what picking
 * one does.
 */
interface ChoiceRow {
  id: string;
  label: string;
  options: readonly (readonly [value: string, label: string])[];
  current: () => string;
  choose: (value: string) => void;
}

const yesNo = (on: boolean) => (on ? '1' : '0');

/** The rows of choice buttons: the crew's, standing or seated play, then the live settings. */
const CHOICE_ROWS: readonly ChoiceRow[] = [
  {
    id: 'mic',
    label: 'My microphone',
    options: [
      ['0', 'On'],
      ['1', 'Muted'],
    ],
    current: () => yesNo(crewControls.micMuted),
    choose: (value) => {
      if ((value === '1') !== crewControls.micMuted) {
        crewControls.toggleMute();
      }
    },
  },
  {
    id: 'crew',
    label: "Crewmate's voice",
    options: [
      ['0', 'On'],
      ['1', 'Muted'],
    ],
    current: () => yesNo(crewControls.crewMuted),
    choose: (value) => crewControls.setCrewMuted(value === '1'),
  },
  {
    id: 'seated',
    label: 'Playing',
    options: [
      ['0', 'Standing'],
      ['1', 'Seated'],
    ],
    current: () => yesNo(body.choice.seated),
    choose: (value) => chooseBody({ height: body.choice.height, seated: value === '1' }),
  },
  ...LIVE_ITEMS.map(
    (item): ChoiceRow => ({
      id: item.key,
      label: item.label,
      options: item.options,
      current: () => item.current(settings),
      choose: (value) => changeSetting(item, value),
    }),
  ),
];

/** The player's own height, m, from their upright eyes in VR (NaN before it is measured). */
function ownHeight(): number {
  return body.eye - body.offset + EYES_BELOW_TOP;
}

interface GameMenuDebug {
  readonly open: boolean;
  toggle(open?: boolean): void;
  click(id: string): boolean;
  text(id: string): string | undefined;
  shown(id: string): boolean;
  /** Whether choice button or swatch `id` shows as the one in effect. */
  selected(id: string): boolean;
  position(): number[];
}

/**
 * The game menu, opened and closed with Y on the left controller (the menu
 * button, ≡, does it too where the browser passes it on; SteamVR and others
 * often keep it), or M or the panel's Game menu button on the flat page.
 * Nothing pauses while it is open. It stands in front of the player where
 * they were looking when they opened it. Every setting shows all its
 * choices, the one in effect highlighted, so one press picks any of them:
 *
 * - Crew (only in a crew): the crew's state, this player's microphone on or
 *   muted, and the crewmate's voice on or muted (for this player only);
 * - You: coat colour as swatches, standing or seated play, and character
 *   height in 5 cm steps or the player's own;
 * - Sound and view: the settings that apply straight away (LIVE_ITEMS,
 *   src/live-settings.ts), kept in this browser;
 * - Back to start screen (leaves any crew) and Exit VR.
 */
export class GameMenuSystem extends createSystem({}) {
  private ui: PanelUi | null = null;
  private open = false;
  private selected = new Map<string, boolean>();

  init(): void {
    const asset = this.world.getSceneObject<UIKitMLAsset>('menu-panel');
    const entity = this.world.getSceneEntity('menu-panel');
    if (asset == null || entity == null) {
      console.warn('[Menu] no game menu in the scene');
      return;
    }
    const ui = new PanelUi(asset, entity, 'menu-root', this.cleanupFuncs);
    this.ui = ui;

    ui.on('menu-close', () => this.setOpen(false));
    for (const row of CHOICE_ROWS) {
      ui.setText(`row-${row.id}-label`, row.label);
      for (let i = 0; i < MAX_OPTIONS; i++) {
        const option = row.options[i];
        ui.show(`row-${row.id}-${i}`, option !== undefined);
        if (option === undefined) {
          continue;
        }
        ui.setText(`row-${row.id}-${i}`, option[1]);
        ui.on(`row-${row.id}-${i}`, () => {
          if (row.current() !== option[0]) {
            row.choose(option[0]);
          }
          this.render();
        });
      }
    }
    CREW_COLORS.forEach((color, i) => {
      asset.getElementById(`coat-${i}-dot`)?.setProperties({ backgroundColor: `#${color.toString(16).padStart(6, '0')}` });
      ui.on(`coat-${i}`, () => {
        crewControls.setColor(i);
        this.render();
      });
    });
    const step = (direction: 1 | -1) => {
      const height = stepHeight(body.choice.height, ownHeight(), direction, MIN_CHARACTER_HEIGHT, MAX_CHARACTER_HEIGHT, DEFAULT_CHARACTER_HEIGHT);
      chooseBody({ height, seated: body.choice.seated });
      this.render();
    };
    ui.on('height-down', () => step(-1));
    ui.on('height-up', () => step(1));
    ui.on('height-own', () => {
      chooseBody({ height: 0, seated: body.choice.seated });
      this.render();
    });
    ui.on('menu-start', () => {
      this.setOpen(false);
      startScreen.show();
    });
    ui.on('menu-exit', () => {
      this.setOpen(false);
      this.world.exitXR();
    });

    const onOpenEvent = () => this.setOpen(true);
    window.addEventListener(OPEN_MENU_EVENT, onOpenEvent);
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as Element | null)?.closest?.('input, textarea, select') || event.repeat) {
        return;
      }
      if (event.key === 'm' || event.key === 'M') {
        this.setOpen(!this.open);
      } else if (event.key === 'Escape' && this.open) {
        this.setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    this.cleanupFuncs.push(
      () => window.removeEventListener(OPEN_MENU_EVENT, onOpenEvent),
      () => window.removeEventListener('keydown', onKey),
      onCrewChange(() => this.render()),
      onSettingChange(() => this.render()),
      this.world.visibilityState.subscribe((visibility) => {
        const immersive = visibility !== VisibilityState.NonImmersive;
        ui.show('menu-exit', immersive);
        if (!immersive) {
          // Back on the flat page: a menu opened in VR closes with it.
          this.setOpen(false);
        }
      }),
    );
    ui.setVisible(false);
    this.render();

    const self = this;
    (window as unknown as { __gameMenu: GameMenuDebug }).__gameMenu = {
      get open() { return self.open; },
      toggle: (open) => this.setOpen(open ?? !this.open),
      click: (id) => ui.click(id),
      text: (id) => ui.text(id),
      shown: (id) => ui.isShown(id),
      selected: (id) => this.selected.get(id) ?? false,
      position: () => ui.object.position.toArray(),
    };
  }

  update(): void {
    const left = this.input.xr.gamepads.left;
    if (left && (left.getButtonDown(InputComponent.Y_Button) || left.getButtonDown(InputComponent.Menu))) {
      this.setOpen(!this.open);
    }
  }

  private setOpen(open: boolean): void {
    const ui = this.ui;
    if (ui == null || open === this.open) {
      return;
    }
    this.open = open;
    if (open) {
      this.render();
      if (this.world.visibilityState.peek() !== VisibilityState.NonImmersive) {
        ui.place(this.player.head, DISTANCE, DROP);
      }
    }
    ui.setVisible(open);
    console.info(`[Menu] ${open ? 'opened' : 'closed'}`);
  }

  private render(): void {
    const ui = this.ui;
    if (ui == null) {
      return;
    }
    const c = crewControls;
    const crewLine = menuCrewLine(c.state, c.room, c.crewmate, settings.bot);
    ui.show('menu-crew', crewLine !== '');
    ui.setText('menu-crew-status', crewLine);
    // Mute is offered only while the microphone is open.
    const micNote = c.micError ? 'Unavailable' : !c.micOn ? 'Off (allow it on the page)' : '';
    ui.show('row-mic-note', micNote !== '');
    ui.setText('row-mic-note', micNote);
    for (const row of CHOICE_ROWS) {
      const current = row.current();
      row.options.forEach(([value], i) => {
        const id = `row-${row.id}-${i}`;
        ui.show(id, row.id !== 'mic' || micNote === '');
        this.select(id, value === current);
      });
    }
    CREW_COLORS.forEach((_, i) => this.select(`coat-${i}`, i === c.color));
    const own = body.choice.height <= 0;
    ui.setText('height-value', heightShown(body.choice.height, ownHeight()));
    this.select('height-own', own);
  }

  /** Show choice `id` as the one in effect, or not. */
  private select(id: string, on: boolean): void {
    if (this.selected.get(id) === on) {
      return;
    }
    this.selected.set(id, on);
    const element = this.ui?.asset.getElementById(id);
    if (id.startsWith('coat-')) {
      element?.setProperties({ borderColor: on ? SWATCH_ON : SWATCH_OFF });
    } else {
      element?.setProperties({ variant: on ? 'primary' : 'secondary' } as never);
    }
  }
}
