/**
 * Where the gondola's flight controls are and how a hand works them (Phase 2).
 * Engine-free, so the geometry, the interaction and the host's simulation
 * share one set of numbers and can be unit tested.
 *
 * Gondola space: deck surface at y = 0, bow towards -Z, starboard +X.
 *
 * - Burner: a fuel brick let go in or on the hopper mouth is burned.
 * - Vent cord: hangs mid-ship on the port side; pulling its toggle down
 *   opens the vent, and it springs closed when let go.
 * - Tiller: a bar at the stern, pivoting on the rudder post. Like a boat's,
 *   pushing it to one side turns the ship the other way. It stays where it
 *   is left.
 * - Ballast: sandbags hanging outside the starboard rail at the stern.
 *   Lifting one off its hook and letting go drops it overboard.
 * - Trim: where the crew stands tips the ship a little and, once it is
 *   moving, a nose-down trim makes it descend.
 */

import { BURNER_POSITION, BURNER_SIZE, DECK_LENGTH, DECK_WIDTH } from './gondola-layout.js';

/** Hopper mouth: a brick whose centre comes within this region and isn't held is burned. */
export const HOPPER = {
  x: BURNER_POSITION[0],
  z: BURNER_POSITION[2],
  /** Horizontal reach from the hopper's centre line, m (the burner top is 0.42 m across). */
  radius: 0.22,
  /** From just above the burner's top (where a dropped brick comes to rest) to well above it, m. */
  yMin: BURNER_SIZE[1] - 0.02,
  yMax: BURNER_SIZE[1] + 0.35,
} as const;

export function inHopper(x: number, y: number, z: number): boolean {
  return y > HOPPER.yMin && y < HOPPER.yMax && Math.hypot(x - HOPPER.x, z - HOPPER.z) < HOPPER.radius;
}

/** Vent cord toggle at rest (closed), m. */
export const VENT_TOGGLE = [-0.3, 1.55, -0.3] as const;
/** Pulling the toggle this far down opens the vent fully, m. */
export const VENT_PULL = 0.3;
/** Where the cord is tied off above, m. */
export const VENT_CORD_TOP = 4.4;
/** A hand this close to the toggle can take it, m. */
export const VENT_REACH = 0.12;

/** Vent opening for the toggle pulled down to `toggleY`. */
export function ventFromToggle(toggleY: number): number {
  return Math.min(1, Math.max(0, (VENT_TOGGLE[1] - toggleY) / VENT_PULL));
}

/** The toggle's height for a hand at `handY` holding it `offset` above the toggle (the cord can't be pushed up). */
export function toggleFromHand(handY: number, offset: number): number {
  return Math.min(VENT_TOGGLE[1], Math.max(VENT_TOGGLE[1] - VENT_PULL, handY - offset));
}

/** Tiller: the rudder post at the stern, and the bar's length forward to the handle, m. */
export const TILLER_PIVOT = [0, 0.86, DECK_LENGTH / 2 - 0.15] as const;
export const TILLER_LENGTH = 0.6;
/** The bar swings this far either side, degrees. */
export const TILLER_MAX_DEG = 35;
/** A hand this close to the handle (the bar's last 15 cm) can take it, m. */
export const TILLER_REACH = 0.13;
const TILLER_MAX = (TILLER_MAX_DEG * Math.PI) / 180;

/** Bar angle for a rudder setting: positive swings the handle to starboard, which puts the rudder to port. */
export function tillerAngle(rudder: number): number {
  return -Math.max(-1, Math.min(1, rudder)) * TILLER_MAX;
}

/** The rudder setting for a hand at (x, z) holding the tiller. */
export function rudderFromHand(x: number, z: number): number {
  const forward = TILLER_PIVOT[2] - z;
  if (forward < 0.05) {
    // A hand behind the post can't sensibly steer; hold the middle.
    return 0;
  }
  const angle = Math.atan2(x - TILLER_PIVOT[0], forward);
  return Math.max(-1, Math.min(1, -angle / TILLER_MAX));
}

/** Handle (the bar's end) position for a rudder setting. */
export function tillerHandle(rudder: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const a = tillerAngle(rudder);
  out.x = TILLER_PIVOT[0] + Math.sin(a) * TILLER_LENGTH;
  out.y = TILLER_PIVOT[1] + 0.04;
  out.z = TILLER_PIVOT[2] - Math.cos(a) * TILLER_LENGTH;
  return out;
}

/** Ballast bags hanging outside the starboard rail, stern end; each one's centre, m. */
export const BALLAST_BAGS: readonly (readonly [number, number, number])[] = [0.55, 0.78, 1.01, 1.24].map(
  (z) => [DECK_WIDTH / 2 + 0.16, 0.78, z] as const,
);
export const BALLAST_BAG_KG = 20;
/** A hand this close to a bag can take it, m. */
export const BALLAST_REACH = 0.16;

/** Let go here and the bag falls overboard; anywhere else it goes back on its hook. */
export function overboard(x: number, z: number): boolean {
  return Math.abs(x) > DECK_WIDTH / 2 || Math.abs(z) > DECK_LENGTH / 2;
}

export function ballastDropped(mask: number): number {
  let n = 0;
  for (let i = 0; i < BALLAST_BAGS.length; i++) {
    if (mask & (1 << i)) n++;
  }
  return n * BALLAST_BAG_KG;
}

/** Lean per metre of a crew member's offset from the deck centre, radians. */
export const TRIM_PER_METRE = 0.015;

/**
 * Trim from where the crew stands: nose-up pitch and starboard-down roll,
 * radians. Each person standing towards the bow pushes the nose down; each
 * one to starboard pushes that side down.
 */
export function trimFromCrew(xs: readonly number[], zs: readonly number[], count: number, out: { pitch: number; roll: number }): void {
  let sx = 0;
  let sz = 0;
  for (let i = 0; i < count; i++) {
    sx += Math.max(-DECK_WIDTH / 2, Math.min(DECK_WIDTH / 2, xs[i]));
    sz += Math.max(-DECK_LENGTH / 2, Math.min(DECK_LENGTH / 2, zs[i]));
  }
  // Bow is -Z, so standing at the bow (negative z) gives a negative (nose-down) pitch.
  out.pitch = TRIM_PER_METRE * sz;
  out.roll = TRIM_PER_METRE * sx;
}

/**
 * The ship's bell (Phase 2 route): hung from a bracket over the port bow
 * corner post. Like a ship's bell, the bell itself is fixed and its clapper
 * swings: an iron ball on a shaft hung from a pivot up inside the bell's
 * crown. The lanyard is tied to a ring at the clapper's tail, below the
 * bell's lip, so pulling the lanyard's end to one side swings the ball
 * against that side of the bell. Pull it from side to side and it rings
 * on each side in turn.
 */
export const BELL_HOOK = [-0.78, 1.7, -1.3] as const;
/** The bell's middle, below its hook. */
export const BELL_CENTER = [BELL_HOOK[0], BELL_HOOK[1] - 0.12, BELL_HOOK[2]] as const;
/** The bell's inside: radius at its crown and at its lip, and their depths below the hook, m. */
export const BELL_MOUTH = { crownY: -0.04, crownRadius: 0.035, lipY: -0.18, lipRadius: 0.085 } as const;
/** Where the clapper hangs from, up inside the crown. */
export const BELL_PIVOT = [BELL_HOOK[0], BELL_HOOK[1] - 0.045, BELL_HOOK[2]] as const;
/** The clapper: its ball's centre and radius, and the ring the lanyard is tied to, below the pivot, m. */
export const CLAPPER_BALL = 0.12;
export const CLAPPER_BALL_RADIUS = 0.024;
export const CLAPPER_TAIL = 0.17;
/** The lanyard, from the clapper's tail to its wooden toggle, m. */
export const BELL_LANYARD_LENGTH = 0.305;
/** The lanyard's end (a wooden toggle) hanging at rest, at chest height. */
export const BELL_LANYARD_END = [BELL_PIVOT[0], BELL_PIVOT[1] - CLAPPER_TAIL - BELL_LANYARD_LENGTH, BELL_PIVOT[2]] as const;
/** A hand this close to the lanyard's end can take it, m. */
export const BELL_LANYARD_REACH = 0.12;
/** Pulled this far from where it hangs, the lanyard slips out of the hand, m. */
export const BELL_LANYARD_SLIP = 0.45;

/** The bell's inside radius at `y` below the hook (a straight flare from crown to lip). */
function mouthRadius(y: number): number {
  const m = BELL_MOUTH;
  const t = Math.min(1, Math.max(0, (y - m.crownY) / (m.lipY - m.crownY)));
  return m.crownRadius + t * (m.lipRadius - m.crownRadius);
}

/** How far the clapper swings from hanging straight before its ball meets the bell, rad. */
export const BELL_STRIKE_ANGLE = (() => {
  const pivotY = BELL_PIVOT[1] - BELL_HOOK[1];
  let angle = 0.4;
  for (let i = 0; i < 20; i++) {
    const y = pivotY - CLAPPER_BALL * Math.cos(angle);
    angle = Math.asin((mouthRadius(y) - CLAPPER_BALL_RADIUS) / CLAPPER_BALL);
  }
  return angle;
})();

/** The clapper as a pendulum: gravity's pull (g over its length), and damping, per second. */
const CLAPPER_OMEGA2 = 9.81 / CLAPPER_BALL;
const CLAPPER_DAMPING = 2.5;
/** A held lanyard pulls the clapper towards the hand like a stiff spring, with some give. */
const LANYARD_STIFFNESS = 400;
const LANYARD_DAMPING = 3;
/** How far a hand pulling the lanyard aside tips the clapper, rad per metre: about 4.5 cm aside holds the ball against the bell. */
const LANYARD_TIP = 10;
/** The furthest past the bell's side a hand can pull the clapper, rad. */
const LANYARD_OVERPULL = 0.3;
/** How much of its speed the ball keeps bouncing off the bell. */
const CLAPPER_BOUNCE = 0.15;
/** The ball must meet the bell at least this fast to ring it, m/s (slower, it just rests against it). */
export const BELL_STRIKE_SPEED = 0.1;
/** The ball chattering against the same side this soon after a strike doesn't ring it again, s. */
const CLAPPER_CHATTER = 0.15;
/** The pendulum steps in fixed slices this long, s, so a resting ball never seems to strike. */
const CLAPPER_STEP = 1 / 240;

/**
 * The bell's clapper: a damped pendulum swung by the lanyard, which strikes
 * whenever its ball meets the bell fast enough. Its tilt is kept as a small
 * rotation, rad, towards +X (`x`) and +Z (`z`), the way the ball has swung.
 */
export class BellClapper {
  x = 0;
  z = 0;
  vx = 0;
  vz = 0;
  /** Strikes so far, and the widest it has swung, rad. */
  strikes = 0;
  peak = 0;
  /** The last strike's direction from the bell's middle (unit X and Z) and ball speed, m/s. */
  readonly lastStrike = { x: 0, z: 0, speed: 0 };
  /** Seconds left in which strikes make no sound (after a knock shown from elsewhere). */
  private quiet = 0;
  /** Seconds since the last strike. */
  private since = Number.POSITIVE_INFINITY;
  private carry = 0;

  /**
   * Swing for `dt` seconds with the lanyard's end held at (`hx`, `hz`), or let
   * go (`held` false). Returns the hardest strike's ball speed, m/s, or 0.
   */
  step(dt: number, held: boolean, hx = 0, hz = 0): number {
    // Where the hand pulls the clapper to: tipped towards the hand.
    let tx = 0;
    let tz = 0;
    if (held) {
      const dx = hx - BELL_LANYARD_END[0];
      const dz = hz - BELL_LANYARD_END[2];
      const pull = Math.hypot(dx, dz);
      if (pull > 1e-6) {
        const angle = Math.min(pull * LANYARD_TIP, BELL_STRIKE_ANGLE + LANYARD_OVERPULL);
        tx = (dx / pull) * angle;
        tz = (dz / pull) * angle;
      }
    }
    const k = held ? LANYARD_STIFFNESS : 0;
    const c = CLAPPER_DAMPING + (held ? LANYARD_DAMPING : 0);
    let hardest = 0;
    this.carry = Math.min(this.carry + dt, 0.1);
    while (this.carry >= CLAPPER_STEP) {
      this.carry -= CLAPPER_STEP;
      const h = CLAPPER_STEP;
      this.vx += (-CLAPPER_OMEGA2 * this.x + k * (tx - this.x) - c * this.vx) * h;
      this.vz += (-CLAPPER_OMEGA2 * this.z + k * (tz - this.z) - c * this.vz) * h;
      this.x += this.vx * h;
      this.z += this.vz * h;
      this.since += h;
      this.quiet = Math.max(0, this.quiet - h);
      const angle = Math.hypot(this.x, this.z);
      this.peak = Math.max(this.peak, Math.min(angle, BELL_STRIKE_ANGLE));
      if (angle <= BELL_STRIKE_ANGLE) {
        continue;
      }
      // The ball meets the bell: stop it there, and bounce it back if it came in hard.
      const nx = this.x / angle;
      const nz = this.z / angle;
      this.x = nx * BELL_STRIKE_ANGLE;
      this.z = nz * BELL_STRIKE_ANGLE;
      const inward = this.vx * nx + this.vz * nz;
      if (inward <= 0) {
        continue;
      }
      const speed = inward * CLAPPER_BALL;
      const hard = speed >= BELL_STRIKE_SPEED;
      const lose = inward * (hard ? 1 + CLAPPER_BOUNCE : 1);
      this.vx -= nx * lose;
      this.vz -= nz * lose;
      const chatter = this.since < CLAPPER_CHATTER && nx * this.lastStrike.x + nz * this.lastStrike.z > 0.7;
      if (hard && !chatter && (held || this.quiet <= 0)) {
        this.since = 0;
        this.lastStrike.x = nx;
        this.lastStrike.z = nz;
        this.lastStrike.speed = speed;
        hardest = Math.max(hardest, speed);
      }
    }
    if (hardest > 0) {
      this.strikes++;
    }
    return hardest;
  }

  /**
   * Show a strike that happened elsewhere (the crewmate's bell, or a key):
   * the ball is at the bell's side towards (`nx`, `nz`) and bounces back,
   * without sounding again for a moment.
   */
  knock(nx: number, nz: number, speed: number): void {
    const length = Math.hypot(nx, nz) || 1;
    const ux = nx / length;
    const uz = nz / length;
    this.x = ux * BELL_STRIKE_ANGLE;
    this.z = uz * BELL_STRIKE_ANGLE;
    const back = (CLAPPER_BOUNCE * speed) / CLAPPER_BALL;
    this.vx = -ux * back;
    this.vz = -uz * back;
    this.peak = BELL_STRIKE_ANGLE;
    this.quiet = 1;
  }

  /** Where the clapper's tail is, from the pivot, m (for drawing the lanyard). */
  tail(out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const angle = Math.hypot(this.x, this.z);
    const s = angle > 1e-6 ? Math.sin(angle) / angle : 1;
    out.x = this.x * s * CLAPPER_TAIL;
    out.y = -Math.cos(angle) * CLAPPER_TAIL;
    out.z = this.z * s * CLAPPER_TAIL;
    return out;
  }
}
