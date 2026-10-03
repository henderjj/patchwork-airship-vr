import { makeRoomCode, normaliseRoomCode } from './lobby-protocol.js';
import type { SessionState } from './net-session.js';

/**
 * Small 2D crew panel on the flat page (top right): create a crew, which
 * makes a four-letter code and puts it in the address bar, or type a
 * crewmate's code to join. Set up the crew before entering VR; the page
 * reloads nothing, so the link with `?room=CODE` can be shared as is.
 */
export class LobbyUi {
  private root = document.createElement('div');
  private status = document.createElement('div');
  private input = document.createElement('input');
  private mic = document.createElement('div');
  private onJoin: (room: string) => void;
  private onLeave: () => void;

  constructor(onJoin: (room: string) => void, onLeave: () => void, onMute: () => void) {
    this.onJoin = onJoin;
    this.onLeave = onLeave;
    this.root.id = 'crew-panel';
    this.root.style.cssText =
      'position:fixed;top:8px;right:8px;z-index:10;padding:8px 10px;border-radius:8px;background:rgba(20,24,32,.82);' +
      'color:#e5e7eb;font:13px system-ui,sans-serif;display:flex;flex-direction:column;gap:6px;max-width:260px';
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
    this.mic.id = 'crew-mic';
    this.mic.style.cssText = 'color:#94a3b8';
    this.root.append(row, this.status, this.mic);
    document.body.appendChild(this.root);
    this.setStatus('Playing solo.');
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

  setMic(muted: boolean, error: string): void {
    this.mic.textContent = error
      ? `Microphone unavailable (${error}); you can still hear your crewmate.`
      : muted
        ? 'Microphone muted (Mic button, or Y in VR).'
        : 'Microphone on (Mic button, or Y in VR, mutes).';
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
