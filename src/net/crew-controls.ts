import type { SessionState } from './net-session.js';

/**
 * The crew as the start screen and the in-game menu see it, and what they
 * can do about it, without reaching into NetSystem (which fills in the
 * actions as it starts and calls `changed()` whenever anything here moves).
 */
export const crewControls = {
  state: 'idle' as SessionState,
  /** The crew's code, '' when not in one. */
  room: '',
  detail: '',
  /** The crewmate's name, '' before one connects. */
  crewmate: '',
  /** This player's microphone is open (in a crew, allowed) and whether it is muted. */
  micOn: false,
  micMuted: false,
  micError: '',
  /** This player has turned the crewmate's voice off. */
  crewMuted: false,
  /** This player's coat colour. */
  color: 0,
  join: (_room: string): void => undefined,
  leave: (): void => undefined,
  toggleMute: (): void => undefined,
  setCrewMuted: (_muted: boolean): void => undefined,
  setColor: (_index: number): void => undefined,
  changed(): void {
    for (const listener of crewListeners) {
      listener();
    }
  },
};

const crewListeners = new Set<() => void>();

/** Call `listener` whenever the crew changes; returns the unsubscribe. */
export function onCrewChange(listener: () => void): () => void {
  crewListeners.add(listener);
  return () => crewListeners.delete(listener);
}
