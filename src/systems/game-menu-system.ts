import { createSystem, InputComponent, type UIKitMLAsset, VisibilityState } from '@iwsdk/core';
import { menuCrewLine } from '../game-flow.js';
import { changeSetting, LIVE_ITEMS, type LiveItem, MENU_ROWS, nextOption, optionLabel } from '../live-settings.js';
import { crewControls, onCrewChange } from '../net/crew-controls.js';
import { CREW_COLOR_NAMES } from '../scene-assets/avatar.scene-asset.js';
import { settings } from '../settings.js';
import { body, chooseBody } from './body-height-system.js';
import { OPEN_MENU_EVENT } from './net-system.js';
import { PanelUi } from './panel-ui.js';
import { startScreen } from './start-screen-system.js';

/** Where the menu stands in VR when opened: ahead of the head and a little below the eyes, m. */
const DISTANCE = 0.9;
const DROP = 0.2;

/** A menu row: a live setting, or one with its own way of applying a choice. */
interface MenuRow extends LiveItem {
  apply?: (value: string) => void;
}

/**
 * The player's body (src/systems/body-height-system.ts), shown first:
 * `chooseBody` moves the view at once and keeps the choice.
 */
const BODY_ROWS: readonly MenuRow[] = [
  {
    key: 'seated',
    label: 'Playing',
    options: [
      ['0', 'Standing'],
      ['1', 'Seated'],
    ],
    current: (s) => (s.seated ? '1' : '0'),
    apply: (value) => chooseBody({ height: body.choice.height, seated: value === '1' }),
  },
  {
    key: 'height',
    label: 'Character height',
    options: [
      ['0', 'Your own'],
      ['1.5', '1.50 m'],
      ['1.6', '1.60 m'],
      ['1.7', '1.70 m'],
      ['1.8', '1.80 m'],
      ['1.9', '1.90 m'],
    ],
    current: (s) => String(s.height),
    apply: (value) => chooseBody({ height: Number(value), seated: body.choice.seated }),
  },
];

/** The menu's setting rows, in order (at most MENU_ROWS). */
export const MENU_SETTING_ROWS: readonly MenuRow[] = [...BODY_ROWS, ...LIVE_ITEMS];

interface GameMenuDebug {
  readonly open: boolean;
  toggle(open?: boolean): void;
  click(id: string): boolean;
  text(id: string): string | undefined;
  shown(id: string): boolean;
  position(): number[];
}

/**
 * The game menu, opened and closed with Y on the left controller (the menu
 * button, ≡, does it too where the browser passes it on; SteamVR and others
 * often keep it), or M or the panel's Game menu button on the flat page. Nothing pauses while it is open. It stands in front of the
 * player where they were looking when they opened it, and holds:
 *
 * - in a crew, the crew's state, buttons to mute this player's microphone
 *   or the crewmate's voice, and nothing else crew-only:
 *   leaving is "Back to start screen";
 * - the coat colour, standing or seated play, character height and the
 *   settings that apply straight away (LIVE_ITEMS, src/live-settings.ts), each a button that steps through
 *   its choices and keeps the choice in this browser;
 * - Back to start screen (leaves any crew) and Exit VR.
 */
export class GameMenuSystem extends createSystem({}) {
  private ui: PanelUi | null = null;
  private open = false;

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
    ui.on('menu-mute-me', () => crewControls.toggleMute());
    ui.on('menu-mute-crew', () => crewControls.setCrewMuted(!crewControls.crewMuted));
    ui.on('menu-coat', () => crewControls.setColor((crewControls.color + 1) % CREW_COLOR_NAMES.length));
    for (let row = 0; row < MENU_ROWS; row++) {
      const item = MENU_SETTING_ROWS[row];
      ui.show(`menu-row-${row}`, item !== undefined);
      if (item === undefined) {
        continue;
      }
      ui.setText(`menu-row-${row}-label`, item.label);
      ui.on(`menu-row-${row}-value`, () => {
        const next = nextOption(item, item.current(settings));
        if (item.apply) {
          item.apply(next);
        } else {
          changeSetting(item, next);
        }
        this.render();
      });
    }
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
    ui.setText(
      'menu-mute-me',
      c.micError ? 'My mic: unavailable' : !c.micOn ? 'My mic: off' : c.micMuted ? 'My mic: muted' : 'My mic: on',
    );
    ui.setText('menu-mute-crew', c.crewMuted ? 'Crewmate: muted' : 'Crewmate: on');
    ui.setText('menu-coat', CREW_COLOR_NAMES[c.color] ?? '');
    for (let row = 0; row < MENU_ROWS && row < MENU_SETTING_ROWS.length; row++) {
      const item = MENU_SETTING_ROWS[row];
      ui.setText(`menu-row-${row}-value`, optionLabel(item, item.current(settings)));
    }
  }
}
