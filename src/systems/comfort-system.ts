import { createSystem, InputComponent, VisibilityState } from '@iwsdk/core';
import { clampRating, ComfortLog, RATING_MAX } from '../sim/comfort-log.js';
import { settings } from '../settings.js';
import { drawSignBackground, FloatingSign } from './floating-sign.js';
import { ship, shipInfo } from './ship-system.js';

/** How long the question stays up before it counts as unanswered, s. */
const ANSWER_S = 20;

interface ComfortDebug {
  log: ComfortLog;
  csv(): string;
  download(): void;
  /** Ask now instead of waiting for the interval. */
  ask(): void;
  readonly asking: boolean;
  readonly value: number;
}

/**
 * Spike S3: with `?comfort=60`, asks the player in VR every 60 s how they
 * feel on the Fast Motion Sickness scale (0 = fine, 20 = very sick). The
 * right trigger raises the number, the left trigger lowers it and A answers.
 * Each answer is logged with the ship's peak motion since the last one; the
 * log downloads as a CSV from the page after leaving VR.
 */
export class ComfortSystem extends createSystem({}) {
  private log = new ComfortLog();
  private sign!: FloatingSign;
  private immersiveS = 0;
  private nextAskS = 0;
  private askedAtS = 0;
  private asking = false;
  private changed = false;
  private value = 0;
  private link: HTMLAnchorElement | null = null;

  init(): void {
    this.log.label = settings.label;
    this.nextAskS = settings.comfort;
    this.sign = new FloatingSign('Comfort Question', 0.55, [512, 256], 1.1, 0.15);
    this.world.createTransformEntity(this.sign.mesh);

    const self = this;
    const debug: ComfortDebug = {
      log: this.log,
      csv: () => this.log.csv(),
      download: () => this.download(),
      ask: () => this.ask(),
      get asking() { return self.asking; },
      get value() { return self.value; },
    };
    (window as { __comfort?: ComfortDebug }).__comfort = debug;

    if (settings.comfort > 0) {
      const link = document.createElement('a');
      link.textContent = 'Comfort CSV';
      link.href = '#';
      link.style.cssText =
        'position:fixed;left:8px;bottom:8px;z-index:10;font:12px monospace;background:rgba(10,14,20,.8);color:#93c5fd;padding:6px 8px;border-radius:6px';
      link.onclick = (event) => {
        event.preventDefault();
        this.download();
      };
      document.body.appendChild(link);
      this.link = link;
      this.cleanupFuncs.push(() => this.link?.remove());
    }
  }

  update(delta: number): void {
    const visibility = this.world.visibilityState.peek();
    if (visibility !== VisibilityState.Visible) {
      return;
    }
    this.immersiveS += delta;
    this.log.sample(ship, delta);
    if (settings.comfort > 0 && !this.asking && this.immersiveS >= this.nextAskS) {
      this.ask();
    }
    if (!this.asking) {
      return;
    }
    const left = this.input.xr.gamepads.left;
    const right = this.input.xr.gamepads.right;
    let step = 0;
    if (right?.getButtonDown(InputComponent.Trigger)) step++;
    if (left?.getButtonDown(InputComponent.Trigger)) step--;
    if (step !== 0) {
      this.value = clampRating(this.value + step);
      this.changed = true;
      this.draw();
    }
    if (right?.getButtonDown(InputComponent.A_Button)) {
      this.answer(this.value);
    } else if (this.immersiveS - this.askedAtS > ANSWER_S) {
      // No answer: keep a number the player chose but didn't confirm.
      this.answer(this.changed ? this.value : null);
    } else {
      this.sign.follow(this.player.head, delta);
    }
  }

  private ask(): void {
    this.asking = true;
    this.changed = false;
    this.askedAtS = this.immersiveS;
    this.draw();
    this.sign.setVisible(true);
  }

  private answer(rating: number | null): void {
    this.log.rate(this.immersiveS, shipInfo.paused ? `${shipInfo.motion} (stopped)` : shipInfo.motion, rating);
    console.info(`[Comfort] ${this.log.rows[this.log.rows.length - 1]}`);
    this.asking = false;
    this.sign.setVisible(false);
    this.nextAskS = this.immersiveS + settings.comfort;
  }

  private draw(): void {
    const { ctx, width, height } = this.sign;
    drawSignBackground(ctx, width, height);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f3e3c3';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(`Minute ${Math.max(1, Math.round(this.immersiveS / 60))}: how do you feel?`, width / 2, 50, width - 30);
    ctx.font = 'bold 84px sans-serif';
    ctx.fillText(String(this.value), width / 2, 140);
    // A bar from green (fine) to red (very sick) under the number.
    const barX = 56;
    const barW = width - 112;
    for (let i = 0; i <= RATING_MAX; i++) {
      const hue = 120 - (120 * i) / RATING_MAX;
      ctx.fillStyle = i === this.value ? '#ffffff' : `hsl(${hue}, 60%, 45%)`;
      ctx.fillRect(barX + (i * barW) / (RATING_MAX + 1) + 1, 158, barW / (RATING_MAX + 1) - 2, i === this.value ? 22 : 14);
    }
    ctx.font = '20px sans-serif';
    ctx.fillStyle = '#c9b48a';
    ctx.textAlign = 'left';
    ctx.fillText('0 fine', barX, 206);
    ctx.textAlign = 'right';
    ctx.fillText('20 very sick', barX + barW, 206);
    ctx.textAlign = 'center';
    ctx.fillText('Triggers: right up, left down.  A: answer', width / 2, 238, width - 30);
    this.sign.refresh();
  }

  private download(): void {
    const blob = new Blob([this.log.csv()], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `patchwork-comfort-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
