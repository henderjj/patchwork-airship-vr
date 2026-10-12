import type { SessionState } from './net/net-session.js';

/**
 * How the player chose to play on the start screen
 * (src/systems/start-screen-system.ts). Pure TypeScript, so the words can be
 * tested.
 *
 * - `solo`: on their own.
 * - `practice`: a crew whose second player is the practice crewmate, a bot
 *   played by a page on a PC.
 * - `host`: started a crew for a friend to join.
 * - `join`: joined a friend's crew by its code.
 * - `link`: opened a link with a crew code in it.
 */
export type PlayMode = 'solo' | 'practice' | 'host' | 'join' | 'link';

/** The start screen's pages. */
export type StartPage = 'home' | 'join' | 'crew';

/** What the start screen's crew page says. */
export interface CrewScreen {
  title: string;
  status: string;
  help: string;
  /** The crewmate is here: the game starts by itself. */
  ready: boolean;
}

/**
 * The crew page's words for crew `room` in session state `state` (with the
 * session's `detail`), for a crew made or joined as `mode`. `gameUrl` is the
 * game's address without the scheme, for the practice crewmate's page.
 */
export function crewScreen(mode: PlayMode, state: SessionState, room: string, detail: string, crewmate: string, gameUrl: string): CrewScreen {
  const title = `Crew ${room}`;
  const practiceHelp = `On a PC, open ${gameUrl}/?room=${room}&bot=1 or open the game, choose Join a crew, type ${room} and press Join as practice crewmate.`;
  const hostHelp = `Tell your crewmate the code ${room}. They choose Join a crew and type it in.`;
  switch (state) {
    case 'connected':
      return { title, status: `${crewmate || 'Your crewmate'} is aboard.`, help: 'Starting...', ready: true };
    case 'full':
      return { title, status: `Crew ${room} already has two players.`, help: 'Check the code, or start a crew of your own.', ready: false };
    case 'error':
      return { title, status: `Couldn't reach crew ${room}: ${detail || 'connection problem'}.`, help: 'Go back and try again.', ready: false };
    case 'connecting':
      return { title, status: detail?.startsWith('reconnecting') ? 'Reconnecting to your crewmate...' : 'Connecting to your crewmate...', help: '', ready: false };
    case 'waiting':
      return {
        title,
        status: mode === 'practice' ? 'Waiting for the practice crewmate.' : 'Waiting for your crewmate.',
        help: mode === 'practice' ? practiceHelp : mode === 'join' || mode === 'link' ? `Your crewmate can join with the code ${room}.` : hostHelp,
        ready: false,
      };
    case 'lobby':
      return { title, status: `Joining crew ${room}...`, help: '', ready: false };
    case 'idle':
    case 'closed':
      return { title, status: 'Not in a crew.', help: '', ready: false };
  }
}

/** The code typed so far on the join page, with blanks for the letters still to come. */
export function codeShown(typed: string): string {
  return [0, 1, 2, 3].map((i) => typed[i] ?? '_').join(' ');
}

/** `typed` with key `key` pressed: a letter is added (up to four), 'del' removes the last. */
export function typeCode(typed: string, key: string): string {
  if (key === 'del') {
    return typed.slice(0, -1);
  }
  return typed.length < 4 && /^[A-Z]$/.test(key) ? typed + key : typed;
}

/** The menu's line about the crew, '' when playing solo. */
export function menuCrewLine(state: SessionState, room: string, crewmate: string, practice: boolean): string {
  if (!room || state === 'idle' || state === 'closed') {
    return '';
  }
  const who = crewmate || (practice ? 'the practice crewmate' : 'your crewmate');
  switch (state) {
    case 'connected':
      return `Crew ${room}: playing with ${who}.`;
    case 'waiting':
      return `Crew ${room}: waiting for ${practice ? 'the practice crewmate' : 'a crewmate'}.`;
    case 'connecting':
    case 'lobby':
      return `Crew ${room}: connecting...`;
    case 'full':
      return `Crew ${room} already has two players.`;
    case 'error':
      return `Crew ${room}: connection problem.`;
  }
}

/** The game menu's character height steps, m. */
export const HEIGHT_STEP = 0.05;

/**
 * The character height after one press of the menu's + (`direction` 1) or
 * − (-1): the next 5 cm step above or below, between `min` and `max`. From
 * "your own" (0) it steps from the player's own height `own` (NaN before it
 * is measured, then from `fallback`).
 */
export function stepHeight(height: number, own: number, direction: 1 | -1, min: number, max: number, fallback: number): number {
  const from = (height > 0 ? height : Number.isFinite(own) ? own : fallback) / HEIGHT_STEP;
  const steps = direction > 0 ? Math.floor(from + 1e-6) + 1 : Math.ceil(from - 1e-6) - 1;
  const stepped = Math.min(max, Math.max(min, steps * HEIGHT_STEP));
  return Number(stepped.toFixed(2));
}

/** What the menu shows for character height `height` (0 for their own, measured as `own` m or NaN). */
export function heightShown(height: number, own: number): string {
  if (height > 0) {
    return `${height.toFixed(2)} m`;
  }
  return Number.isFinite(own) ? `${own.toFixed(2)} m` : '-';
}
