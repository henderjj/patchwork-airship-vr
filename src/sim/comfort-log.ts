/**
 * Comfort log for spike S3: the ship's peak motion between comfort ratings,
 * and the ratings themselves, as CSV. The rating is the Fast Motion Sickness
 * scale (0 = no sickness at all, 20 = frank sickness), asked about once a
 * minute. Pure TypeScript, no allocation per frame.
 */

export const COMFORT_CSV_HEADER =
  'seconds,motion,rating,peak_tilt_deg,peak_turn_dps,peak_accel_h,peak_accel_v,peak_climb,speed,label';

/** The ship values the log reads each frame (a subset of `ShipState`). */
export interface ShipMotionSample {
  yaw: number;
  pitch: number;
  roll: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
}

export const RATING_MAX = 20;

export class ComfortLog {
  readonly rows: string[] = [COMFORT_CSV_HEADER];
  /** Peaks since the last rating. */
  peakTiltDeg = 0;
  peakTurnDps = 0;
  peakAccelH = 0;
  peakAccelV = 0;
  peakClimb = 0;
  speed = 0;
  label = '';
  private lastYaw = Number.NaN;

  /** Track the ship's motion over `dt` seconds. */
  sample(s: ShipMotionSample, dt: number): void {
    const tilt = (Math.max(Math.abs(s.pitch), Math.abs(s.roll)) * 180) / Math.PI;
    this.peakTiltDeg = Math.max(this.peakTiltDeg, tilt);
    if (!Number.isNaN(this.lastYaw) && dt > 0) {
      let dYaw = s.yaw - this.lastYaw;
      dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
      this.peakTurnDps = Math.max(this.peakTurnDps, (Math.abs(dYaw) / dt) * (180 / Math.PI));
    }
    this.lastYaw = s.yaw;
    this.peakAccelH = Math.max(this.peakAccelH, Math.hypot(s.ax, s.az));
    this.peakAccelV = Math.max(this.peakAccelV, Math.abs(s.ay));
    this.peakClimb = Math.max(this.peakClimb, Math.abs(s.vy));
    this.speed = Math.hypot(s.vx, s.vz);
  }

  /** Write a row for a rating (null when the player didn't answer) and start the next interval. */
  rate(seconds: number, motion: string, rating: number | null): void {
    this.rows.push(
      [
        seconds.toFixed(0),
        motion,
        rating === null ? '' : String(rating),
        this.peakTiltDeg.toFixed(1),
        this.peakTurnDps.toFixed(1),
        this.peakAccelH.toFixed(2),
        this.peakAccelV.toFixed(2),
        this.peakClimb.toFixed(2),
        this.speed.toFixed(1),
        this.label.replace(/[,\n]/g, ' '),
      ].join(','),
    );
    this.peakTiltDeg = this.peakTurnDps = this.peakAccelH = this.peakAccelV = this.peakClimb = 0;
  }

  csv(): string {
    return this.rows.join('\n') + '\n';
  }
}

/** Clamp a rating to the scale's whole numbers. */
export function clampRating(value: number): number {
  return Math.min(RATING_MAX, Math.max(0, Math.round(value)));
}
