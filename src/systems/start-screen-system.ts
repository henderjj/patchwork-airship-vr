import { createSystem, type UIKitMLAsset, VisibilityState } from '@iwsdk/core';
import { codeShown, crewScreen, type PlayMode, type StartPage, typeCode } from '../game-flow.js';
import { crewControls, onCrewChange } from '../net/crew-controls.js';
import { makeRoomCode, normaliseRoomCode } from '../net/lobby-protocol.js';
import { settings } from '../settings.js';
import { PanelUi } from './panel-ui.js';

/** Where the start screen stands in VR: ahead of the head and a little below the eyes, m. */
const DISTANCE = 1.0;
const DROP = 0.2;
/** Turned further than this from the screen, the player gets it put back in front of them, rad. */
const REPLACE_ANGLE = 1.2;
/** How long "your crewmate is aboard" shows before the game starts, ms. */
const READY_MS = 1500;
const KEYS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const PAGE_IDS: Record<StartPage, string> = { home: 'start-home', join: 'start-join-page', crew: 'start-crew-page' };

interface StartScreenDebug {
  readonly page: StartPage | null;
  readonly mode: PlayMode | null;
  readonly visible: boolean;
  readonly typed: string;
  click(id: string): boolean;
  text(id: string): string | undefined;
  shown(id: string): boolean;
  /** Where the screen stands in VR, ship space. */
  position(): number[];
}

/** Lets the game menu bring the start screen back. */
export const startScreen = {
  show: (): void => undefined,
};

/**
 * The start screen: how to play, chosen in VR with a controller ray (or on
 * the flat page with the mouse) instead of on the browser page before VR.
 *
 * - Play solo.
 * - Solo with the practice crewmate: starts a crew and says how to bring the
 *   practice crewmate (a bot page on a PC, src/systems/crew-bot-system.ts)
 *   into it.
 * - Start a crew: makes a four-letter code to give a friend.
 * - Join a crew: a keypad for the friend's code (letters on a keyboard type
 *   it on the flat page). On the flat page, the code can also be joined as
 *   the practice crewmate, which reloads the page as the bot.
 *
 * In a crew it waits on the crew page until the crewmate is aboard, then
 * gets out of the way by itself; "Start playing" doesn't wait. Once a game
 * has started nothing is shown in front of the player; the game menu (the
 * left controller's menu button) can bring this screen back. A page opened
 * from a link with a crew code goes straight to the crew page, and the
 * practice crewmate's own page never shows it.
 */
export class StartScreenSystem extends createSystem({}) {
  private ui: PanelUi | null = null;
  private page: StartPage | null = 'home';
  private mode: PlayMode | null = null;
  private typed = '';
  private needsPlace = true;
  private readySince = 0;

  init(): void {
    const asset = this.world.getSceneObject<UIKitMLAsset>('start-panel');
    const entity = this.world.getSceneEntity('start-panel');
    if (asset == null || entity == null) {
      console.warn('[Start] no start screen in the scene');
      return;
    }
    const ui = new PanelUi(asset, entity, 'start-root', this.cleanupFuncs);
    this.ui = ui;

    ui.on('start-solo', () => this.playAs('solo'));
    ui.on('start-practice', () => this.startCrew('practice'));
    ui.on('start-host', () => this.startCrew('host'));
    ui.on('start-join', () => {
      this.typed = '';
      this.showJoinError(false);
      this.go('join');
    });
    for (const key of KEYS) {
      ui.on(`key-${key}`, () => this.type(key));
    }
    ui.on('key-del', () => this.type('del'));
    ui.on('start-join-back', () => this.go('home'));
    ui.on('start-join-go', () => this.joinTyped(false));
    ui.on('start-join-bot', () => this.joinTyped(true));
    ui.on('start-crew-back', () => {
      crewControls.leave();
      this.mode = null;
      this.go('home');
    });
    ui.on('start-crew-play', () => this.close());

    startScreen.show = () => {
      if (crewControls.room) {
        crewControls.leave();
      }
      this.mode = null;
      this.go('home');
    };

    // Typing a crew code on the flat page. Captured ahead of the game's own
    // keys (P, B, V and the rest), which would otherwise act on the letters.
    const onKey = (event: KeyboardEvent) => {
      if (this.page !== 'join' || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const key = event.key.toUpperCase();
      if (key === 'BACKSPACE') {
        this.type('del');
      } else if (key === 'ENTER') {
        this.joinTyped(false);
      } else if (key === 'ESCAPE') {
        this.go('home');
      } else if (/^[A-Z]$/.test(key)) {
        this.type(key);
      } else {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, { capture: true });

    this.cleanupFuncs.push(
      () => window.removeEventListener('keydown', onKey, { capture: true }),
      onCrewChange(() => this.showCrew()),
      this.world.visibilityState.subscribe((visibility) => {
        // Put the screen in front of the player each time VR starts.
        this.needsPlace = true;
        ui.show('start-join-bot', visibility === VisibilityState.NonImmersive);
      }),
    );

    if (settings.bot) {
      // The practice crewmate's page plays from the PC; there's no one to choose.
      this.page = null;
    } else if (crewControls.room) {
      // Opened from a link with a crew code: NetSystem has joined it already.
      this.mode = 'link';
      this.page = 'crew';
    }
    this.render();

    const self = this;
    (window as unknown as { __startScreen: StartScreenDebug }).__startScreen = {
      get page() { return self.page; },
      get mode() { return self.mode; },
      get visible() { return ui.visible; },
      get typed() { return self.typed; },
      click: (id) => ui.click(id),
      text: (id) => ui.text(id),
      shown: (id) => ui.isShown(id),
      position: () => ui.object.position.toArray(),
    };
  }

  update(): void {
    const ui = this.ui;
    if (ui == null || this.page === null) {
      return;
    }
    if (this.readySince > 0 && performance.now() - this.readySince > READY_MS) {
      this.close();
      return;
    }
    if (this.world.visibilityState.peek() !== VisibilityState.Visible) {
      return;
    }
    const head = this.player.head;
    if (this.needsPlace || ui.angleFromHead(head) > REPLACE_ANGLE) {
      this.needsPlace = false;
      ui.place(head, DISTANCE, DROP);
    }
  }

  private playAs(mode: PlayMode): void {
    this.mode = mode;
    console.info(`[Start] playing ${mode}`);
    this.close();
  }

  private startCrew(mode: 'practice' | 'host'): void {
    this.mode = mode;
    console.info(`[Start] ${mode === 'practice' ? 'practice crewmate' : 'new crew'}`);
    crewControls.join(makeRoomCode());
    this.go('crew');
  }

  private type(key: string): void {
    this.typed = typeCode(this.typed, key);
    this.showJoinError(false);
    this.ui?.setText('start-code', codeShown(this.typed));
  }

  private joinTyped(asBot: boolean): void {
    const code = normaliseRoomCode(this.typed);
    if (code === null) {
      this.showJoinError(true);
      return;
    }
    if (asBot) {
      // The practice crewmate is set up as the page loads.
      const url = new URL(location.href);
      url.searchParams.set('room', code);
      url.searchParams.set('bot', '1');
      location.replace(url);
      return;
    }
    this.mode = 'join';
    crewControls.join(code);
    this.go('crew');
  }

  private showJoinError(visible: boolean): void {
    this.ui?.show('start-join-error', visible);
  }

  private close(): void {
    this.page = null;
    this.readySince = 0;
    this.render();
  }

  private go(page: StartPage): void {
    this.page = page;
    this.readySince = 0;
    this.render();
  }

  private render(): void {
    const ui = this.ui;
    if (ui == null) {
      return;
    }
    if (this.page === null) {
      ui.setVisible(false);
      return;
    }
    if (!ui.visible) {
      this.needsPlace = true;
    }
    ui.setVisible(true);
    for (const page of Object.keys(PAGE_IDS) as StartPage[]) {
      ui.show(PAGE_IDS[page], page === this.page);
    }
    if (this.page === 'join') {
      ui.setText('start-code', codeShown(this.typed));
    }
    this.showCrew();
  }

  /** Fill in the crew page, and start the game once the crewmate is aboard. */
  private showCrew(): void {
    const ui = this.ui;
    if (ui == null || this.page !== 'crew') {
      return;
    }
    const c = crewControls;
    const screen = crewScreen(this.mode ?? 'link', c.state, c.room, c.detail, c.crewmate, `${location.host}${location.pathname.replace(/\/$/, '')}`);
    ui.setText('start-crew-title', screen.title);
    ui.setText('start-crew-status', screen.status);
    ui.setText('start-crew-help', screen.help);
    ui.show('start-crew-help', screen.help !== '');
    ui.setText('start-crew-play', screen.ready ? 'Start playing' : 'Play while waiting');
    if (screen.ready && this.readySince === 0) {
      this.readySince = performance.now();
    } else if (!screen.ready) {
      this.readySince = 0;
    }
  }
}
