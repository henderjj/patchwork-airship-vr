import { createSettingsMenu } from '../settings-menu.js';
import type { SessionState } from './net-session.js';

export interface LobbyUiOptions {
  /** The player asked to allow the microphone. */
  onAllowMic: () => void;
  /** The player asked to enter VR. */
  onEnterVr: () => void;
  /** The player asked for the game's menu (shown on the flat page). */
  onMenu: () => void;
}

/**
 * Small 2D panel on the flat page (top right). How to play (solo, the
 * practice crewmate, or a crew) is chosen on the start screen in the game
 * itself, in VR or on this page (src/systems/start-screen-system.ts), and
 * settings that apply straight away are in the game's menu. This panel keeps
 * what has to happen in the browser before VR:
 *
 * - an Enter VR button: the browser's own offer (Quest Browser) can be
 *   withdrawn once a crew connects and the microphone opens, so the page
 *   always has a button of its own. Under it, a line says how a press is
 *   going (a PC browser over Link can take most of a minute) or why VR didn't
 *   start (src/vr-start.ts);
 * - the microphone, asked for up front because a permission prompt inside
 *   VR is easy to miss;
 * - a line saying how the crew is doing, a button for the game's menu, and
 *   the start-up settings that reload the page (src/settings-menu.ts).
 */
export class LobbyUi {
  private root = document.createElement('div');
  private status = document.createElement('div');
  private mic = document.createElement('div');
  private micText = document.createElement('span');
  private allowMic: HTMLButtonElement;
  private enterVr: HTMLButtonElement;
  private vrNote = document.createElement('div');
  private vrSupportNote = '';
  private vrStartNote = '';

  constructor(options: LobbyUiOptions) {
    this.root.id = 'crew-panel';
    this.enterVr = button('Enter VR', options.onEnterVr);
    this.enterVr.id = 'crew-enter-vr';
    this.enterVr.style.fontWeight = '600';
    this.enterVr.style.padding = '6px 10px';
    this.enterVr.style.display = 'none';
    this.vrNote.id = 'crew-vr-status';
    this.vrNote.style.cssText = 'color:#fcd34d;display:none';
    this.root.style.cssText =
      'position:fixed;top:8px;right:8px;z-index:10;padding:8px 10px;border-radius:8px;background:rgba(20,24,32,.82);' +
      'color:#e5e7eb;font:13px system-ui,sans-serif;display:flex;flex-direction:column;gap:6px;max-width:260px;max-height:calc(100vh - 16px);overflow:auto';
    this.status.id = 'crew-status';
    const menu = button('Game menu (M)', options.onMenu);
    menu.id = 'crew-menu';

    // Microphone, asked for up front.
    this.mic.id = 'crew-mic';
    this.mic.style.cssText = 'color:#94a3b8;display:flex;gap:6px;align-items:center';
    this.allowMic = button('Allow microphone', options.onAllowMic);
    this.allowMic.id = 'crew-allow-mic';
    this.mic.append(this.micText, this.allowMic);
    this.root.append(this.enterVr, this.vrNote, this.status, this.mic, menu, createSettingsMenu());
    document.body.appendChild(this.root);
    this.setStatus('Playing solo.');
    this.setMic({ muted: false, error: '', on: false, permitted: false });
  }

  /**
   * Offer the Enter VR button or not, with a note when the browser sees no
   * headset (see `vrSupportNote`).
   */
  showEnterVr(button: boolean, note = ''): void {
    this.enterVr.style.display = button ? '' : 'none';
    this.vrSupportNote = note;
    this.showVrNote();
  }

  /** Show how the last press of Enter VR is going: `message` ('' for nothing), and whether it is still starting. */
  setVrStart(message: string, starting: boolean): void {
    this.enterVr.disabled = starting;
    this.enterVr.textContent = starting ? 'Starting VR...' : 'Enter VR';
    this.vrStartNote = message;
    this.showVrNote();
  }

  private showVrNote(): void {
    const text = this.vrStartNote || this.vrSupportNote;
    this.vrNote.textContent = text;
    this.vrNote.style.display = text ? '' : 'none';
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
          ? 'Microphone muted (in the game menu).'
          : 'Microphone on (the game menu mutes it).'
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
