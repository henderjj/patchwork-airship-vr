import { createSystem, Quaternion, Vector3, VisibilityState } from '@iwsdk/core';
import { ShipSounds } from '../audio/ship-sounds.js';
import { CreakTimer, ratchetClicks, strain, type StrainLimits, touchedDown, windSound } from '../sim/audio-cues.js';
import { DEFAULT_FLIGHT_LIMITS } from '../sim/flight.js';
import { BELL_CENTER } from '../sim/gondola-controls.js';
import { BURNER_POSITION, DECK_LENGTH, DECK_WIDTH } from '../sim/gondola-layout.js';
import { CRANK_AXLE_HEIGHT, CRANK_POSITION } from '../scene-assets/gondola.scene-asset.js';
import { settings } from '../settings.js';
import { crankInfo } from './crank-system.js';
import { flightInfo, route, ship } from './ship-system.js';

const DEG = Math.PI / 180;
const LIMITS: StrainLimits = {
  tiltRate: DEFAULT_FLIGHT_LIMITS.maxTiltRateDeg * DEG,
  yawRate: DEFAULT_FLIGHT_LIMITS.maxYawRateDeg * DEG,
  accel: DEFAULT_FLIGHT_LIMITS.maxAccel,
};
/** At most this many ratchet clicks a frame (a slow frame mustn't burst). */
const MAX_CLICKS_PER_FRAME = 2;

/** Where the timbers creak: the rail posts round the deck, at rail height. */
const hw = DECK_WIDTH / 2 - 0.03;
const hl = DECK_LENGTH / 2 - 0.03;
const CREAK_PLACES: [number, number, number][] = [
  [-hw, 0.8, -hl], [hw, 0.8, -hl], [-hw, 0.8, hl], [hw, 0.8, hl],
  [-hw, 0.8, 0], [hw, 0.8, 0], [0, 4.4, 0],
];

/** The ship's sounds, shared so other systems can ring the bell. */
export const sounds = new ShipSounds(
  {
    burner: [BURNER_POSITION[0], 0.7, BURNER_POSITION[2]],
    crank: [CRANK_POSITION[0], CRANK_AXLE_HEIGHT, CRANK_POSITION[2]],
    bell: [BELL_CENTER[0], BELL_CENTER[1], BELL_CENTER[2]],
  },
  settings.audio,
);

/**
 * Phase 2 audio: drives the ship's sounds (src/audio/ship-sounds.ts) from
 * the ship's state each frame. The burner roars while lit, the wind follows
 * the airspeed, the ratchet clicks as the crank turns, the timbers creak more
 * as the gondola tilts, turns and changes speed, a ring flown through chimes,
 * and touching down thumps. Everyone hears their own copy, driven by the
 * ship state they already share. `?audio=0` turns it off.
 */
export class AudioSystem extends createSystem({}) {
  private headPos = new Vector3();
  private headQuat = new Quaternion();
  private forward = new Vector3();
  private up = new Vector3();
  private creaks = new CreakTimer();
  private prev = { roll: 0, pitch: 0, yaw: 0, speed: 0, vy: 0, crank: 0, rings: 0, set: false };

  init(): void {
    if (!sounds.enabled) {
      return;
    }
    // Browsers start audio only after a gesture: a click or key on the page, or entering VR.
    const wake = () => sounds.resume();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    this.cleanupFuncs.push(
      () => window.removeEventListener('pointerdown', wake),
      () => window.removeEventListener('keydown', wake),
      this.world.visibilityState.subscribe((v) => {
        if (v === VisibilityState.Visible) {
          wake();
        }
      }),
      () => sounds.dispose(),
    );
    (window as { __audio?: unknown }).__audio = {
      sounds,
      level: () => sounds.level(),
      loops: () => sounds.loops(),
      played: sounds.played,
      get running() { return sounds.running; },
    };
  }

  update(delta: number): void {
    if (!sounds.enabled) {
      return;
    }
    const dt = Math.min(delta, 0.1);
    const p = this.prev;
    if (!p.set) {
      Object.assign(p, { roll: ship.roll, pitch: ship.pitch, yaw: ship.yaw, speed: ship.speed, vy: ship.vy, crank: crankInfo.angle, rings: route.ringMask, set: true });
      return;
    }

    // The listener: this player's head, in ship space.
    this.player.head.getWorldPosition(this.headPos);
    this.player.head.getWorldQuaternion(this.headQuat);
    this.forward.set(0, 0, -1).applyQuaternion(this.headQuat);
    this.up.set(0, 1, 0).applyQuaternion(this.headQuat);
    const h = this.headPos;
    sounds.setListener(h.x, h.y, h.z, this.forward.x, this.forward.y, this.forward.z, this.up.x, this.up.y, this.up.z);

    const wind = windSound(ship.speed, ship.vy);
    sounds.setLoops(flightInfo.flying && flightInfo.burner ? 1 : 0, wind.gain, wind.cutoff);

    const clicks = Math.min(MAX_CLICKS_PER_FRAME, ratchetClicks(p.crank, crankInfo.angle));
    for (let i = 0; i < clicks; i++) {
      sounds.ratchet(Math.min(1, Math.abs(crankInfo.speed) / 6));
    }

    if (dt > 0) {
      const load = strain((ship.roll - p.roll) / dt, (ship.pitch - p.pitch) / dt, (ship.yaw - p.yaw) / dt, (ship.speed - p.speed) / dt, LIMITS);
      if (this.creaks.step(dt, load)) {
        sounds.creak(CREAK_PLACES[Math.floor(Math.random() * CREAK_PLACES.length)], load);
      }
    }

    if (route.ringMask !== p.rings && (route.ringMask & ~p.rings) !== 0) {
      sounds.chime();
    }
    if (touchedDown(p.vy, ship.vy)) {
      sounds.thump(-p.vy);
    }

    p.roll = ship.roll;
    p.pitch = ship.pitch;
    p.yaw = ship.yaw;
    p.speed = ship.speed;
    p.vy = ship.vy;
    p.crank = crankInfo.angle;
    p.rings = route.ringMask;
  }
}
