import { createSettingsMenu } from '../settings-menu.js';
import { makeRoomCode, normaliseRoomCode } from './lobby-protocol.js';
import type { SessionState } from './net-session.js';

export interface LobbyUiOptions {
  onJoin: (room: string) => void;
  onLeave: () => void;
  onMute: () => void;
  /** The player asked to allow the microphone. */
  onAllowMic: () => void;
  /** The player picked coat colour `index`. */
  onColor: (index: number) => void;
  /** The player asked to enter VR. */
  onEnterVr: () => void;
  /** Coat colours to offer, with names, and the one picked. */
  colors: readonly number[];
  colorNames: readonly string[];
  color: number;
}

/**
 * Small 2D crew panel on the flat page (top right): create a crew, which
 * makes a four-letter code and puts it in the address bar, or type a
 * crewmate's code to join. Set up the crew before entering VR; the page
 * reloads nothing, so the link with `?room=CODE` can be shared as is.
 *
 * Also here, before VR: the coat colour your crewmate sees you in, the
 * microphone, which is asked for up front because a permission prompt
 * inside VR is easy to miss, and an Enter VR button. The browser's own Enter
 * VR offer (Quest Browser) can be withdrawn once a crew connects and the
 * microphone opens, so the page always has a button of its own. Last, the
 * Settings menu (src/settings-menu.ts).
 */
export class LobbyUi {
  private root = document.createElement('div');
  private status = document.createElement('div');
  private input = document.createElement('input');
  private mic = document.createElement('div');
  private micText = document.createElement('span');
  private allowMic: HTMLButtonElement;
  private enterVr: HTMLButtonElement;
  private swatches: HTMLButtonElement[] = [];
  private onJoin: (room: string) => void;
  private onLeave: () => void;

  constructor(options: LobbyUiOptions) {
    const { onJoin, onLeave, onMute } = options;
    this.onJoin = onJoin;
    this.onLeave = onLeave;
    this.root.id = 'crew-panel';
    this.enterVr = button('Enter VR', options.onEnterVr);
    this.enterVr.id = 'crew-enter-vr';
    this.enterVr.style.fontWeight = '600';
    this.enterVr.style.padding = '6px 10px';
    this.enterVr.style.display = 'none';
    this.root.style.cssText =
      'position:fixed;top:8px;right:8px;z-index:10;padding:8px 10px;border-radius:8px;background:rgba(20,24,32,.82);' +
      'color:#e5e7eb;font:13px system-ui,sans-serif;display:flex;flex-direction:column;gap:6px;max-width:260px;max-height:calc(100vh - 16px);overflow:auto';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center';
    const create = button('New crew', () => this.join(makeRoomCode()));
    create.id = 'crew-create';
    this.input.placeholder = 'CODE';
    this.input.maxLength = 4;
    this.input.id = 'crew-code';
    this.input.style.cssText =
      'width:4.5em;text-transform:uppercase;font:inherit;padding:3px 5px;border-radius:4px;border:1px solid #475569;background:#0f172a;color:inherit';
    const join = button('Join', () => {
      const code = normaliseRoomCode(this.input.value);
      if (code) {
        this.join(code);
      } else {
        this.setStatus('Crew codes are four letters.');
      }
    });
    join.id = 'crew-join';
    const leave = button('Leave', () => {
      this.onLeave();
      const url = new URL(location.href);
      url.searchParams.delete('room');
      history.replaceState(null, '', url);
    });
    const mute = button('Mic', onMute);
    mute.id = 'crew-mute';
    row.append(create, this.input, join, leave, mute);
    this.status.id = 'crew-status';

    // Coat colour.
    const colors = document.createElement('div');
    colors.style.cssText = 'display:flex;gap:4px;align-items:center;flex-wrap:wrap';
    const label = document.createElement('span');
    label.textContent = 'Coat';
    label.style.cssText = 'color:#94a3b8;margin-right:2px';
    colors.append(label);
    options.colors.forEach((hex, i) => {
      const swatch = document.createElement('button');
      swatch.id = `crew-color-${i}`;
      swatch.title = options.colorNames[i] ?? '';
      swatch.setAttribute('aria-label', `${options.colorNames[i] ?? 'Colour'} coat`);
      swatch.style.cssText = `width:20px;height:20px;border-radius:50%;cursor:pointer;padding:0;background:#${hex.toString(16).padStart(6, '0')}`;
      swatch.addEventListener('click', () => {
        this.setColor(i);
        options.onColor(i);
      });
      this.swatches.push(swatch);
      colors.append(swatch);
    });
    this.setColor(options.color);

    // Microphone, asked for up front.
    this.mic.id = 'crew-mic';
    this.mic.style.cssText = 'color:#94a3b8;display:flex;gap:6px;align-items:center';
    this.allowMic = button('Allow microphone', options.onAllowMic);
    this.allowMic.id = 'crew-allow-mic';
    this.mic.append(this.micText, this.allowMic);
    this.root.append(this.enterVr, row, this.status, colors, this.mic, createSettingsMenu());
    document.body.appendChild(this.root);
    this.setStatus('Playing solo.');
    this.setMic({ muted: false, error: '', on: false, permitted: false });
  }

  /** Offer the Enter VR button, on a browser and device that can run VR. */
  showEnterVr(supported: boolean): void {
    this.enterVr.style.display = supported ? '' : 'none';
  }

  /** Show coat colour `index` as picked. */
  setColor(index: number): void {
    this.swatches.forEach((swatch, i) => {
      swatch.style.border = i === index ? '2px solid #f8fafc' : '2px solid transparent';
      swatch.style.outline = i === index ? '1px solid #0f172a' : 'none';
    });
  }

  join(code: string): void {
    this.input.value = code;
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    history.replaceState(null, '', url);
    this.onJoin(code);
  }

  show(visible: boolean): void {
    this.root.style.display = visible ? 'flex' : 'none';
  }

  update(state: SessionState, room: string, detail?: string): void {
    const messages: Record<SessionState, string> = {
      idle: 'Playing solo.',
      lobby: `Joining crew ${room}...`,
      waiting: `Crew ${room}: waiting for a crewmate. Share this code or the page link.`,
      connecting: `Crew ${room}: connecting to your crewmate...`,
      connected: `Crew ${room}: connected.`,
      full: `Crew ${room} already has two players.`,
      closed: 'Left the crew. Playing solo.',
      error: `Crew ${room}: ${detail ?? 'connection problem'}.`,
    };
    this.setStatus(detail && state !== 'error' ? `${messages[state]} (${detail})` : messages[state]);
  }

  /** Show the microphone's state: allowed or not yet, on (in a crew) or muted, or why it can't be used. */
  setMic(mic: { muted: boolean; error: string; on: boolean; permitted: boolean }): void {
    this.micText.textContent = mic.error
      ? `Microphone unavailable (${mic.error}); you can still hear your crewmate.`
      : mic.on
        ? mic.muted
          ? 'Microphone muted (Mic button, or Y in VR).'
          : 'Microphone on (Mic button, or Y in VR, mutes).'
        : mic.permitted
          ? 'Microphone allowed; it turns on in a crew.'
          : 'Voice chat needs the microphone:';
    this.allowMic.style.display = mic.on || mic.permitted || mic.error ? 'none' : '';
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
  }

  dispose(): void {
    this.root.remove();
  }
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText =
    'font:inherit;padding:3px 8px;border-radius:4px;border:1px solid #64748b;background:#1e293b;color:inherit;cursor:pointer';
  b.addEventListener('click', onClick);
  return b;
}
