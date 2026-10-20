import { createSystem } from '@iwsdk/core';
import { type BodyChoice, clampCharacterHeight, glide, rigOffset, targetEyeHeight, UprightEye } from '../sim/body-height.js';
import { saveSettings, settings } from '../settings.js';
import { climb } from './climb-system.js';
import { netLink } from './net-system.js';

/** Character height and seated play, for the HUD and menus. */
export const body = {
  /** The player's choice in effect. */
  choice: { height: settings.height, seated: settings.seated } as BodyChoice,
  /** How far the player's rig is raised (+) or lowered (-), m. */
  offset: 0,
  /** This player's upright eye height on the deck, offset included, m (NaN until measured in VR). */
  eye: Number.NaN,
  /** The crewmate's upright eye height on the deck, as drawn, m (NaN with no crewmate). */
  crewEye: Number.NaN,
  /** Set by chooseBody: measure again and move straight to the new height. */
  changed: false,
};

/**
 * Change the character height (m, 0 for the player's own) or seated play
 * while playing, from an in-game menu. Takes effect at once and is kept for
 * the next visit, as the Settings menu's choices are.
 */
export function chooseBody(choice: BodyChoice): void {
  const height = clampCharacterHeight(choice.height);
  body.choice = { height, seated: choice.seated };
  body.changed = true;
  settings.height = height;
  settings.seated = choice.seated;
  saveSettings({ height: height > 0 ? String(height) : null, seated: choice.seated ? '1' : null });
}

/**
 * Puts the player's eyes at their character's height (src/sim/body-height.ts)
 * by raising or lowering the player rig, which carries the view and both
 * hands, and raises it further by however far they have climbed the rigging
 * to the envelope (ClimbSystem). Only in VR; the flat page's camera is
 * left alone. Runs before anything reads the head or hands this frame.
 */
export class BodyHeightSystem extends createSystem({}) {
  private own = new UprightEye();
  private crew = new UprightEye();
  private inVr = false;
  /** Jump to the next offset rather than glide (a new session or a new choice). */
  private snap = true;

  init(): void {
    (window as { __body?: unknown }).__body = {
      state: body,
      choose: chooseBody,
      upright: () => this.own.upright,
    };
  }

  update(delta: number): void {
    this.measureCrew(delta);
    const player = this.player;
    if (!this.world.session) {
      if (this.inVr) {
        this.inVr = false;
        player.position.y = 0;
        body.offset = 0;
        body.eye = Number.NaN;
      }
      return;
    }
    if (!this.inVr || body.changed) {
      // Someone else may be wearing the headset now, or they've just sat down: measure afresh.
      this.inVr = true;
      body.changed = false;
      this.own.reset();
      this.snap = true;
    }
    this.own.push(player.head.position.y, delta);
    if (Number.isNaN(this.own.upright)) {
      player.position.y = body.offset + climb.height;
      return;
    }
    const want = rigOffset(targetEyeHeight(body.choice), this.own.upright);
    body.offset = this.snap ? want : glide(body.offset, want, delta);
    this.snap = false;
    player.position.y = body.offset + climb.height;
    body.eye = this.own.upright + body.offset;
  }

  /** The crewmate's upright eye height as they're drawn, for the HUD. */
  private measureCrew(delta: number): void {
    if (!netLink.haveRemote) {
      if (!Number.isNaN(this.crew.upright)) {
        this.crew.reset();
        body.crewEye = Number.NaN;
      }
      return;
    }
    // Measured from their feet, which are higher up the rigging.
    this.crew.push(netLink.remote.head.py - netLink.remote.feet, delta);
    body.crewEye = this.crew.upright;
  }
}
