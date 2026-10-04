#!/usr/bin/env node
/**
 * Two-player network test (spike S4). Builds nothing itself: run `npm run
 * build` first. Starts the local lobby and `vite preview` (which proxies
 * /parties to the lobby), opens the game in two separate browser profiles,
 * joins both to one crew, and checks:
 *
 * - both reach "connected" over a direct WebRTC data channel;
 * - a third player is turned away (two-player crews);
 * - a pose sent by one arrives intact at the other;
 * - the crewmate moves smoothly while the sender walks in a circle;
 * - the same at about 150 ms RTT with jitter and 1% loss (simulated);
 * - when the host leaves, the other player becomes host and can be rejoined;
 * - voice (spike S5): Chromium's fake microphone (a periodic beep) reaches the
 *   crewmate, muting silences it, and the loopback route starts;
 * - the two-person crank (spike S6): cranking in step reaches high gear and
 *   about three times the solo speed, out of step it does not, and the
 *   guest's crank stays with the host's, on a clean link and at 150 ms RTT;
 * - the hand-over-hand rope haul (spike S6): strokes together heave, strokes
 *   250 ms apart do not, also at 150 ms RTT;
 * - throwing and catching (spike S7): the two players throw a fuel brick back
 *   and forth across the deck; catches that look caught on the catcher's
 *   side stay caught, and the thrower sees the brick in the catcher's hand,
 *   on a clean link and at 150 ms RTT.
 *
 * Writes measured RTT, packet rate and route to artifacts/net-report.json.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const LOBBY_PORT = 8787;
const PREVIEW_PORT = 4173;
// The IWSDK Vite plugin serves HTTPS with a local development certificate.
const BASE = `https://localhost:${PREVIEW_PORT}/`;
const QUIET = 'islands=4&clouds=4&bricks=1&avatars=0&hud=0';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!pass && process.env.GITHUB_ACTIONS) {
    console.log(`::error title=Net check failed::${name}${detail ? ` (${detail})` : ''}`.replace(/\r?\n/g, ' '));
  }
}

const children = [];
function start(command, args, readyText) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: true });
    children.push(child);
    let output = '';
    const timer = setTimeout(() => reject(new Error(`${command} ${args.join(' ')} did not start:\n${output}`)), 30000);
    const onData = (data) => {
      output += data;
      if (output.includes(readyText)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`${command} exited with ${code}:\n${output}`)));
  });
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

const state = (page) => page.evaluate(() => window.__net?.session.state ?? 'loading');

async function openPlayer(browser, query) {
  // A small window keeps software rendering of four pages fast enough for the
  // frame-by-frame motion checks.
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 200 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (process.env.ONLY_THROW && /^\[Throw/.test(m.text())) console.log(`    ${query.slice(0, 18)} ${m.text()}`);
    if (/^\[(Net|Crank|Rope|Throw)\]/.test(m.text())) console.log(`    ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}?${QUIET}&${query}`);
  await waitFor('the game to load', async () => (await state(page)) !== 'loading', 60000);
  return { context, page, errors };
}

/**
 * Sender walks its head around a 0.5 m circle at 1 rad/s; the receiver
 * records what it draws each frame. A visible backward step reads as judder.
 */
async function measureMotion(sender, receiver, seconds) {
  await sender.page.evaluate(() => {
    const pose = {
      head: { px: 0, py: 1.6, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      left: { px: -0.2, py: 1.1, pz: -0.3, qx: 0, qy: 0, qz: 0, qw: 1 },
      right: { px: 0.2, py: 1.1, pz: -0.3, qx: 0, qy: 0, qz: 0, qw: 1 },
      flags: 3,
    };
    const t0 = performance.now();
    // Evaluated at send time, so each packet's timestamp matches its pose.
    window.__net.setTestPose((now) => {
      const t = (now - t0) / 1000;
      pose.head.px = 0.5 * Math.cos(t);
      pose.head.pz = 0.5 * Math.sin(t);
      return pose;
    });
  });
  await new Promise((r) => setTimeout(r, 600)); // fill the jitter buffer
  const samples = await receiver.page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const out = [];
        const end = performance.now() + ms;
        const frame = () => {
          const p = window.__net.remotePose();
          if (p) out.push([p.head.px, p.head.pz, performance.now(), window.__net.remoteAtMs]);
          if (performance.now() < end) requestAnimationFrame(frame);
          else resolve(out);
        };
        frame();
      }),
    seconds * 1000,
  );
  // Angle along the circle for each drawn frame; it should only ever advance,
  // at an even speed (1 rad/s) against the time the drawn pose describes.
  // That time, not when this callback ran: the test's frame callback can run
  // before or after the game's in a frame, and on a slow page frames take
  // 100 ms or more, so callback times would make even motion look jerky.
  const angles = samples.map(([x, z]) => Math.atan2(z, x));
  let backwards = 0;
  const backSteps = [];
  let maxRate = 0;
  let maxGapMs = 0;
  const rates = [];
  let last = 0;
  for (let i = 1; i < angles.length; i++) {
    let d = angles[i] - angles[last];
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    // Ignore backward steps under 15 mm: a sender frame hitch or a lost packet
    // can make the brief extrapolation overshoot by about a centimetre.
    if (d < -0.03) {
      backwards++;
      backSteps.push(`${i}:${d.toFixed(4)}`);
    }
    const dt = samples[i][3] - samples[last][3];
    maxGapMs = Math.max(maxGapMs, samples[i][2] - samples[i - 1][2]);
    if (dt < 8) continue; // the same game frame read twice; measure over the next
    rates.push((d * 1000) / dt);
    maxRate = Math.max(maxRate, (d * 1000) / dt);
    last = i;
  }
  const radiusError = Math.max(...samples.map(([x, z]) => Math.abs(Math.hypot(x, z) - 0.5)));
  rates.sort((a, b) => a - b);
  const median = rates[Math.floor(rates.length / 2)] ?? 0;
  return { frames: samples.length, backwards, backSteps, maxRate, median, maxGapMs, radiusError };
}

/** Loudest level of the crewmate's voice over `ms`. */
function peakVoiceLevel(page, ms) {
  return page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        let peak = 0;
        const end = performance.now() + duration;
        const tick = () => {
          peak = Math.max(peak, window.__net.voice.remoteLevel());
          if (performance.now() < end) setTimeout(tick, 10);
          else resolve(peak);
        };
        tick();
      }),
    ms,
  );
}

/**
 * Both players take a crank handle (host handle 0, guest handle 1) and crank
 * with scripted hands that speed up to `rate` rad/s over 3 s. The guest's
 * hand runs `guestLagS` seconds behind in its rhythm. Hands are timed from
 * the shared wall clock so the two pages are in phase.
 */
async function crankTogether(host, guest, rate, guestLagS, seconds) {
  // Let clock sync settle first: the offset comes from the best of several pings.
  await waitFor('clock sync', async () => {
    const n = await Promise.all([host, guest].map((p) => p.page.evaluate(() => window.__net.session.clock.stats.samples)));
    return n.every((x) => x >= 6);
  });
  for (const p of [host, guest]) await p.page.evaluate(() => window.__crank.reset());
  const t0 = Date.now() + 300;
  const script = ([handle, rateArg, lagS, start]) => {
    const offset = handle === 0 ? 0 : Math.PI;
    window.__crank.setTestHand(handle, () => {
      const tt = Math.max(0, (Date.now() - start) / 1000 - lagS);
      const ramp = 3;
      return offset + (tt < ramp ? (rateArg * tt * tt) / (2 * ramp) : rateArg * (tt - ramp / 2));
    });
  };
  await host.page.evaluate(script, [0, rate, 0, t0]);
  await guest.page.evaluate(script, [1, rate, guestLagS, t0]);
  const trace = process.env.DEBUG_CRANK
    ? setInterval(async () => {
        const h = await host.page.evaluate(() => { const s = window.__crank.sim; return [s.lead.map((x) => +x.toFixed(2)), +s.omega.toFixed(2), +s.gear.toFixed(2), +s.syncOffsetMs.toFixed(0), window.__crank.holders().sim, +window.__net.renderDelayMs.toFixed(0), window.__net.session.clock.stats.samples]; }).catch(() => null);
        console.log('    trace host', JSON.stringify(h));
      }, 300)
    : null;
  // Sample the last second.
  await new Promise((r) => setTimeout(r, (seconds - 1) * 1000));
  const sample = (p) =>
    p.page.evaluate(
      () =>
        new Promise((resolve) => {
          const out = { gearFrames: 0, frames: 0, maxError: 0, omega: 0, gear: 0, held: null, solo: 0 };
          const end = performance.now() + 1000;
          const tick = () => {
            const c = window.__crank;
            out.frames++;
            if (c.sim.gear > 0.95) out.gearFrames++;
            const e = c.hostError();
            if (Number.isFinite(e)) out.maxError = Math.max(out.maxError, Math.abs(e));
            out.omega = c.sim.omega;
            out.gear = c.sim.gear;
            out.held = c.holders().sim;
            out.solo = c.sim.soloTopSpeed;
            if (performance.now() < end) requestAnimationFrame(tick);
            else resolve(out);
          };
          tick();
        }),
    );
  const [h, g] = await Promise.all([sample(host), sample(guest)]);
  if (trace) clearInterval(trace);
  for (const p of [host, guest]) {
    await p.page.evaluate(() => {
      window.__crank.setTestHand(0, null);
      window.__crank.setTestHand(1, null);
    });
  }
  return { host: h, guest: g };
}

/**
 * Both players haul the mooring line hand over hand: each hand in turn pulls
 * 0.5 m over 0.5 s (eased), then lets go and reaches forward while the other
 * pulls. The guest's rhythm lags by `guestLagS`. Timed from the wall clock.
 */
async function haulTogether(host, guest, guestLagS, seconds, strokeS = 0.5) {
  for (const p of [host, guest]) await p.page.evaluate(() => window.__rope.reset());
  const t0 = Date.now() + 300;
  const script = ([lagS, start, stroke]) => {
    ['left', 'right'].forEach((side, sideIndex) => {
      window.__rope.setTestHand(side, () => {
        const tt = (Date.now() - start) / 1000 - lagS;
        if (tt < 0) return null;
        const n = Math.floor(tt / stroke);
        if (n % 2 !== sideIndex) return null;
        const phase = tt / stroke - n;
        return 0.4 + (0.5 * (1 - Math.cos(Math.PI * phase))) / 2;
      });
    });
  };
  await host.page.evaluate(script, [0, t0, strokeS]);
  await guest.page.evaluate(script, [guestLagS, t0, strokeS]);
  const trace = process.env.DEBUG_ROPE
    ? setInterval(async () => {
        const h = await host.page.evaluate(() => { const s = window.__rope.sim; return [s.stroking, s.strokeStart.map((x) => Math.round(x % 100000)), s.handSpeed.map((x) => +x.toFixed(2)), s.heave, s.heaves]; }).catch(() => null);
        console.log('    trace host', JSON.stringify(h));
      }, 100)
    : null;
  await new Promise((r) => setTimeout(r, seconds * 1000));
  if (trace) clearInterval(trace);
  const read = (p) =>
    p.page.evaluate(() => ({ hauled: window.__rope.sim.hauled, heaves: window.__rope.sim.heaves, error: window.__rope.hostError() }));
  const [h, g] = await Promise.all([read(host), read(guest)]);
  for (const p of [host, guest]) {
    await p.page.evaluate(() => {
      window.__rope.setTestHand('left', null);
      window.__rope.setTestHand('right', null);
    });
  }
  return { host: h, guest: g };
}

/**
 * The two players throw brick 0 back and forth with scripted right hands:
 * the host stands at the stern (starboard), the guest at the bow (port),
 * about 2.7 m apart (the deck's diagonal). Each throw aims within 8 cm of
 * the other player's catch spot with a 0.5 s flight; each catcher holds
 * its hand within 10 cm of its spot and squeezes when the brick, as drawn on
 * its own screen, comes within 60 cm, like a person reacting to what they
 * see. A brick that falls is picked up again by its owner.
 */
async function throwAndCatch(host, guest, seconds) {
  const HOST_SPOT = [0.6, 1.2, 1.2];
  const GUEST_SPOT = [-0.6, 1.3, -0.95];
  const script = ([mine, other, seed, first, durationMs]) => {
    let rnd = seed;
    const random = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
    const jitter = (p, r) => p.map((v) => v + (random() * 2 - 1) * r);
    const T = window.__throw;
    const N = window.__net;
    const me = N.session.isHost ? 0 : 1;
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const FLIGHT = 0.5, SWING_MS = 250, WINDUP_MS = 300;
    const endAt = performance.now() + durationMs;
    const s = { phase: 'ready', since: performance.now(), hand: jitter(mine, 0.1), squeeze: false, from: null, start: null, v: null,
      throws: 0, catches: 0, kept: 0, lost: 0, misses: 0, pickups: 0, remoteHeldSince: 0, maxHeldError: 0, heldChecks: 0, done: false };
    window.__throwScript = s;
    T.stats.maxHandoverOffset = 0;
    T.stats.handoverOffsets.length = 0;
    const set = (phase) => { s.phase = phase; s.since = performance.now(); };
    T.setTestHand('right', (now) => {
      const t = now - s.since;
      let p = s.hand;
      let squeeze = s.squeeze;
      if (s.phase === 'windup') {
        const k = Math.min(1, t / WINDUP_MS);
        p = s.from.map((v, i) => v + (s.start[i] - v) * k);
        squeeze = true;
      } else if (s.phase === 'swing') {
        const k = t / 1000; // keeps moving through the release, as a real arm does
        p = s.start.map((v, i) => v + s.v[i] * k);
        squeeze = t < SWING_MS;
      }
      return { x: p[0], y: p[1], z: p[2], squeeze };
    });
    if (first) {
      T.place(0, ...s.hand);
      s.squeeze = true;
    }
    const tick = () => {
      const now = performance.now();
      const o = T.objects()[0];
      const held = o.heldBy === 'right';
      const t = now - s.since;
      if (s.phase === 'ready') {
        if (held) {
          set('holding');
        } else if (o.remote && o.speed > 1.5 && !o.remoteHeld && dist(o.pos, s.hand) < 0.6) {
          s.squeeze = true;
          set('catching');
        } else if (o.owner === me && !o.remote && o.speed < 0.2 && t > 1500 && now < endAt) {
          // It fell: pick it up again.
          s.pickups++;
          T.place(0, ...s.hand);
          s.squeeze = true;
        }
      } else if (s.phase === 'catching') {
        if (held) {
          s.catches++;
          s.pendingCatch = true;
          set('holding');
        } else if (t > 700) {
          s.misses++;
          s.squeeze = false;
          set('ready');
        }
      } else if (s.phase === 'holding') {
        if (!held) {
          // The host had it first: the hand let go.
          if (s.pendingCatch) s.lost++;
          s.pendingCatch = false;
          s.squeeze = false;
          set('ready');
        } else {
          if (s.pendingCatch && t > 400) {
            s.pendingCatch = false;
            if (!o.pending && o.owner === me) s.kept++;
            else s.lost++;
          }
          if (t > 600 && now < endAt) {
            const target = jitter(other, 0.08);
            s.v = [0, 1, 2].map((i) => (target[i] - mine[i]) / FLIGHT + (i === 1 ? 0.5 * 9.81 * FLIGHT : 0));
            s.start = mine.map((v, i) => v - (s.v[i] * SWING_MS) / 1000);
            s.from = s.hand.slice();
            set('windup');
          }
        }
      } else if (s.phase === 'windup') {
        if (t > WINDUP_MS) set('swing');
      } else if (s.phase === 'swing') {
        if (t > SWING_MS) {
          s.throws++;
          s.squeeze = false;
          s.hand = jitter(mine, 0.1);
          set('ready');
        }
      }
      // Thrower's view: once the crewmate has held the brick for half a
      // second, it should be drawn in their drawn hand.
      if (o.remote && o.remoteHeld) {
        if (!s.remoteHeldSince) s.remoteHeldSince = now;
        const r = N.remotePose();
        if (r && now - s.remoteHeldSince > 500) {
          s.heldChecks++;
          const err = dist(o.pos, [r.right.px, r.right.py, r.right.pz]);
          if (err > s.maxHeldError) {
            s.maxHeldError = err;
            s.worstHeld = { brick: o.pos.map((v) => +v.toFixed(2)), hand: [r.right.px, r.right.py, r.right.pz].map((v) => +v.toFixed(2)), heldMs: Math.round(now - s.remoteHeldSince), phase: s.phase, epoch: o.epoch };
          }
        }
      } else {
        s.remoteHeldSince = 0;
      }
      if (now < endAt + 1500) requestAnimationFrame(tick);
      else {
        T.setTestHand('right', null);
        s.done = true;
      }
    };
    requestAnimationFrame(tick);
  };
  await host.page.evaluate(script, [HOST_SPOT, GUEST_SPOT, 12345, true, seconds * 1000]);
  await guest.page.evaluate(script, [GUEST_SPOT, HOST_SPOT, 54321, false, seconds * 1000]);
  await waitFor('the throwing to finish', async () =>
    (await Promise.all([host, guest].map((p) => p.page.evaluate(() => window.__throwScript.done)))).every(Boolean), (seconds + 15) * 1000);
  const read = (p) => p.page.evaluate(() => {
    const { done, phase, since, hand, squeeze, from, start, v, pendingCatch, remoteHeldSince, ...rest } = window.__throwScript;
    return { ...rest, handoverOffset: window.__throw.stats.maxHandoverOffset, handoverOffsets: window.__throw.stats.handoverOffsets.slice(), refused: window.__throw.stats.refused };
  });
  return { host: await read(host), guest: await read(guest) };
}

/** Checks for one throwAndCatch run. */
function checkThrows(label, r, maxSlide) {
  const catches = r.host.catches + r.guest.catches;
  const kept = r.host.kept + r.guest.kept;
  const throws = r.host.throws + r.guest.throws;
  const detail = `${throws} throws, ${catches} caught (host ${r.host.catches}, guest ${r.guest.catches}), ${kept} kept, ${r.host.misses + r.guest.misses} missed, ${r.host.pickups + r.guest.pickups} picked up off the deck`;
  check(`Throws are caught (${label})`, throws >= 6 && catches >= 0.6 * throws && r.host.catches > 0 && r.guest.catches > 0, detail);
  check(`Catches that look caught stay caught (${label})`, catches > 0 && kept >= 0.9 * catches, detail);
  const heldError = Math.max(r.host.maxHeldError, r.guest.maxHeldError);
  check(`The thrower sees the brick in the catcher's hand (${label})`, r.host.heldChecks > 0 && r.guest.heldChecks > 0 && heldError < 0.15,
    `largest gap ${(heldError * 100).toFixed(1)} cm`);
  // When the catch reaches the thrower, their view of the brick slides from
  // its own flight to the catcher's hand; it should be a nudge, not a jump.
  // Judged on the median hand-over: the worst one depends mostly on the frame
  // rate of the cloud's software-rendered pages (15-30 fps), which sets how
  // far a brick moves between the catcher's catch checks.
  const slides = [...r.host.handoverOffsets, ...r.guest.handoverOffsets].sort((a, b) => a - b);
  const median = slides.length ? slides[slides.length >> 1] : Number.POSITIVE_INFINITY;
  const worst = slides.length ? slides[slides.length - 1] : Number.NaN;
  check(`The hand-over looks smooth to the thrower (${label})`, median < maxSlide,
    `median slide ${(median * 100).toFixed(0)} cm (limit ${(maxSlide * 100).toFixed(0)} cm), worst ${(worst * 100).toFixed(0)} cm over ${slides.length} hand-overs`);
}

/** Spike S10: what one player sees of the crewmate, and the ship clock. */
const crew = (page) => page.evaluate(() => ({ status: window.__crew.status, paused: window.__crew.paused,
  signVisible: window.__crew.signVisible, message: window.__crew.message, shipTime: window.__ship.state.time }));

/** Make `page` look hidden (headset off or tab switched), or visible again, through the real visibilitychange path. */
function setPageHidden(page, hidden) {
  return page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** Wait for `page`'s crew status to become `status`; returns what it saw then. */
function waitForCrew(page, status, timeoutMs = 10000) {
  return waitFor(`crew status ${status}`, async () => {
    const c = await crew(page);
    return c.status === status ? c : null;
  }, timeoutMs).catch(() => null);
}

/** Ship time advanced over `ms` on `page`, s. */
async function shipAdvance(page, ms) {
  const t0 = (await crew(page)).shipTime;
  await page.waitForTimeout(ms);
  return (await crew(page)).shipTime - t0;
}

/**
 * Spike S10: the game pauses when the crewmate can't play and carries on
 * when they're back. `host` and `guest` are connected players.
 */
async function lifecycleChecks(host, guest) {
  // The guest takes off the headset: the host's game waits.
  await setPageHidden(guest.page, true);
  const away = await waitForCrew(host.page, 'away');
  const pausedFor = away ? await shipAdvance(host.page, 800) : -1;
  if (process.env.SHOT_DIR) {
    await host.page.setViewportSize({ width: 960, height: 600 });
    await host.page.evaluate(() => document.querySelectorAll("body > div:not(#scene-container)").forEach((e) => { e.style.display = "none"; }));
    await host.page.waitForTimeout(500);
    await host.page.screenshot({ path: `${process.env.SHOT_DIR}/crew-away.png` });
  }
  check('A crewmate who steps away pauses the game, with a sign saying so',
    away !== null && away.paused && away.signVisible && pausedFor === 0,
    away ? `"${away.message}", ship moved ${pausedFor.toFixed(2)} s in 0.8 s` : 'host never saw the crewmate away');
  await setPageHidden(guest.page, false);
  const back = await waitForCrew(host.page, 'together');
  const resumed = back ? await shipAdvance(host.page, 800) : 0;
  check('The game carries on when the crewmate is back', back !== null && !back.signVisible && resumed > 0.3,
    `ship moved ${resumed.toFixed(2)} s in 0.8 s`);

  // Nothing arrives from the guest for 3 s (a frozen page or a dying network).
  await host.page.evaluate(() => window.__net.session.blackout(3000));
  const silent = await waitForCrew(host.page, 'silent', 5000);
  const recovered = await waitForCrew(host.page, 'together', 8000);
  check('A crewmate who goes quiet pauses the game until packets flow again', silent !== null && silent.paused && recovered !== null,
    silent ? `"${silent.message}"` : 'never reported silent');

  // The guest's connection fails: both get back into the room on their own.
  // Reconnecting can take under a second, so look at each side's status history.
  const started = Date.now();
  const mark = (page) => page.evaluate(() => window.__crew.history.length);
  const [hostMark, guestMark] = [await mark(host.page), await mark(guest.page)];
  const since = (page, from) => page.evaluate((n) => window.__crew.history.slice(n), from);
  await guest.page.evaluate(() => window.__net.session.breakConnection());
  let reconnected = true;
  await waitFor('both reconnected', async () => (await state(host.page)) === 'connected' && (await state(guest.page)) === 'connected', 30000)
    .catch(() => { reconnected = false; });
  const seconds = (Date.now() - started) / 1000;
  const rejoins = await guest.page.evaluate(() => window.__net.session.rejoins);
  const after = reconnected ? await waitForCrew(host.page, 'together') : null;
  await waitForCrew(guest.page, 'together');
  const hostSaw = await since(host.page, hostMark);
  const guestSaw = await since(guest.page, guestMark);
  const pausedOn = (seen) => seen.some((st) => st === 'reconnecting' || st === 'waiting');
  check('A failed connection reconnects by itself and the game carries on',
    reconnected && rejoins >= 1 && pausedOn(hostSaw) && pausedOn(guestSaw) && after !== null,
    `guest saw ${guestSaw.join(' > ')}, host saw ${hostSaw.join(' > ')}, back in ${seconds.toFixed(1)} s after ${rejoins} rejoin(s)`);
}

async function netStats(page) {
  return page.evaluate(() => {
    const n = window.__net;
    return {
      srtt: n.session.clock.stats.srtt,
      jitter: n.session.clock.stats.jitter,
      received: n.received,
      sent: n.sent,
      lost: n.session.report.lost,
      route: n.session.report.candidates,
      connectMs: n.session.connectMs,
      renderDelayMs: n.renderDelayMs,
      packetIntervalMs: n.packetIntervalMs,
      arrivalJitterMs: n.arrivalJitterMs,
      lateFrames: n.lateFrames,
      host: n.session.isHost,
      audioJitterBufferMs: n.session.report.audioJitterBufferMs,
      audioLost: n.session.report.audioLost,
      audioConcealed: n.session.report.audioConcealed,
      audioBytesReceived: n.session.report.audioBytesReceived,
      audioContext: n.voice.audioState,
    };
  });
}

async function main() {
  console.log('Starting the local lobby and the preview server...');
  await start(process.execPath, ['--experimental-strip-types', '--no-warnings', 'lobby/dev-server.ts'], 'listening');
  await start('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], 'Local');

  const browser = await chromium.launch({
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      // A fake microphone that beeps, granted without a prompt, and audio without a click.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const report = {};
  try {
    const room = 'TEST';
    // ONLY_THROW=lag runs the quick throwing loop at about 150 ms RTT.
    const quickLag = process.env.ONLY_THROW === 'lag' ? '&netlag=60&netjitter=20&netloss=0.01' : '';
    const a = await openPlayer(browser, `room=${room}&name=Ann${quickLag}`);
    await waitFor('Ann waiting in the lobby', async () => (await state(a.page)) === 'waiting');
    const b = await openPlayer(browser, `room=${room}&name=Bo${quickLag}`);
    await waitFor('both connected', async () => (await state(a.page)) === 'connected' && (await state(b.page)) === 'connected');
    check('Two players connect over WebRTC', true);
    if (process.env.ONLY_LIFECYCLE) {
      // Quick loop for spike S10: just pausing and reconnecting.
      await lifecycleChecks(a, b);
      return;
    }
    if (process.env.ONLY_THROW) {
      // Quick loop for tuning spike S7: just the throwing.
      const r = await throwAndCatch(a, b, 10);
      console.log(JSON.stringify(r, null, 1));
      checkThrows('only', r, quickLag ? 0.25 : 0.12);
      return;
    }

    const c = await openPlayer(browser, `room=${room}&name=Cy`);
    const cState = await waitFor('the third player to be refused', async () => {
      const s = await state(c.page);
      return s === 'full' ? s : null;
    });
    check('A third player is turned away', cState === 'full');
    await c.context.close();

    // A still pose arrives intact.
    const sent = {
      head: { px: 0.3, py: 1.52, pz: -0.45, qx: 0, qy: Math.sin(Math.PI / 12), qz: 0, qw: Math.cos(Math.PI / 12) },
      left: { px: 0.05, py: 1.1, pz: -0.7, qx: 0.2, qy: 0, qz: 0, qw: Math.sqrt(0.96) },
      right: { px: 0.55, py: 1.05, pz: -0.7, qx: 0, qy: 0, qz: -0.3, qw: Math.sqrt(0.91) },
      flags: 3,
    };
    await a.page.evaluate((pose) => window.__net.setTestPose(pose), sent);
    await new Promise((r) => setTimeout(r, 800));
    const got = await b.page.evaluate(() => window.__net.remotePose());
    let posErr = Infinity;
    let rotDot = 0;
    if (got) {
      posErr = 0;
      rotDot = 1;
      for (const k of ['head', 'left', 'right']) {
        posErr = Math.max(posErr, Math.hypot(got[k].px - sent[k].px, got[k].py - sent[k].py, got[k].pz - sent[k].pz));
        const dot = Math.abs(got[k].qx * sent[k].qx + got[k].qy * sent[k].qy + got[k].qz * sent[k].qz + got[k].qw * sent[k].qw);
        rotDot = Math.min(rotDot, dot);
      }
    }
    check('Head and hand poses arrive intact', posErr < 0.002 && rotDot > 0.9999 && got?.flags === 3,
      `position error ${(posErr * 1000).toFixed(2)} mm, rotation error ${((Math.acos(Math.min(1, rotDot)) * 2 * 180) / Math.PI).toFixed(3)}°`);
    const visible = await b.page.evaluate(() =>
      ['Crew 2 Head', 'Crew 2 Torso', 'Crew 2 Left Hand', 'Crew 2 Right Hand'].every(
        (name) => window.__debug.world.scene.getObjectByName(name)?.visible,
      ),
    );
    check('Crewmate avatar is drawn', visible);

    // Voice: the fake microphone beeps about once a second.
    const voicePeak = await peakVoiceLevel(b.page, 2500);
    check('Crewmate voice arrives', voicePeak > 0.01, `peak level ${voicePeak.toFixed(3)}`);
    await a.page.evaluate(() => document.getElementById('crew-mute').click());
    await new Promise((r) => setTimeout(r, 500));
    const mutedPeak = await peakVoiceLevel(b.page, 2500);
    check('Mute silences the microphone', mutedPeak < 0.002, `peak level ${mutedPeak.toFixed(4)}`);
    await a.page.evaluate(() => document.getElementById('crew-mute').click());

    // Spike S8: each player sees the other's platform report, with the microphone named.
    const crews = await waitFor('platform reports', async () => {
      const r = await Promise.all([a, b].map((p) => p.page.evaluate(() => window.__platform?.crew)));
      return r.every((c) => c && c.mic !== 'not open') ? r : null;
    }, 10000).catch(() => null);
    check('Players swap platform reports', crews !== null, crews ? `Ann sees "${crews[0].browser} on ${crews[0].os}, mic ${crews[0].mic}"` : '');

    const motion = await measureMotion(a, b, 3);
    report.local = { ...(await netStats(b.page)), motion };
    check('Crewmate moves smoothly (local network)',
      motion.frames >= 20 && motion.backwards === 0 && motion.maxRate < Math.max(3, motion.median * 4) && motion.radiusError < 0.02,
      `${motion.frames} frames, ${motion.backwards} backward steps ${motion.backSteps.join(' ')}, fastest ${motion.maxRate.toFixed(2)} rad/s vs median ${motion.median.toFixed(2)}, longest frame ${motion.maxGapMs.toFixed(0)} ms, off circle by ${(motion.radiusError * 1000).toFixed(1)} mm`);
    const s = report.local;
    check('Round trip measured', Number.isFinite(s.srtt) && s.srtt < 50, `RTT ${s.srtt?.toFixed(1)} ms, route ${s.route}, connected in ${s.connectMs.toFixed(0)} ms`);
    check('Pose packets arrive at about 45 Hz with no loss', s.lost === 0 && s.received > 100, `${s.received} received, ${s.lost} lost`);

    // Host leaves: Bo becomes host and Ann can come back.
    await a.context.close();
    await waitFor('Bo to be told the crewmate left', async () => (await state(b.page)) === 'waiting');
    const boHost = await b.page.evaluate(() => window.__net.session.isHost);
    check('The remaining player becomes host', boHost);
    const left = await waitForCrew(b.page, 'waiting');
    check('The game waits for a crewmate who left', left !== null && left.paused && left.signVisible, left ? `"${left.message}"` : '');
    const a2 = await openPlayer(browser, `room=${room}&name=Ann`);
    await waitFor('reconnected', async () => (await state(a2.page)) === 'connected' && (await state(b.page)) === 'connected');
    check('A player can rejoin', true);

    // Spike S6: the two-person crank. Bo is host now and Ann the guest.
    const together = await crankTogether(b, a2, 8.5, 0, 6);
    report.crankInStep = together;
    check('Cranking in step engages high gear on the host',
      together.host.gearFrames / together.host.frames > 0.9 && together.host.omega > 2.5 * together.host.solo,
      `${(together.host.omega / (2 * Math.PI)).toFixed(2)} turns/s (solo top ${(together.host.solo / (2 * Math.PI)).toFixed(2)}), high gear ${((100 * together.host.gearFrames) / together.host.frames).toFixed(0)}% of frames, handles held ${JSON.stringify(together.host.held)}`);
    check('Guest crank stays with the host', together.guest.maxError < 0.35 && Math.abs(together.guest.omega - together.host.omega) < 1.5,
      `largest gap ${((together.guest.maxError * 180) / Math.PI).toFixed(1)}°, guest ${(together.guest.omega / (2 * Math.PI)).toFixed(2)} turns/s`);
    const apart = await crankTogether(b, a2, 6, 0.25, 6);
    report.crankOutOfStep = apart;
    check('Cranking 250 ms out of step stays in low gear', apart.host.gearFrames === 0 && Math.abs(apart.host.omega) < 1.6 * apart.host.solo,
      `${(apart.host.omega / (2 * Math.PI)).toFixed(2)} turns/s, high gear ${apart.host.gearFrames} frames`);

    const hauled = await haulTogether(b, a2, 0, 6);
    report.haulInStep = hauled;
    check('Hauling in step heaves together', hauled.host.heaves >= 5 && hauled.host.hauled > 1.5,
      `${hauled.host.heaves} heaves, ${hauled.host.hauled.toFixed(2)} m hauled in 6 s; guest sees ${hauled.guest.hauled.toFixed(2)} m`);
    check('Guest line stays with the host', Math.abs(hauled.guest.hauled - hauled.host.hauled) < 0.15,
      `host ${hauled.host.hauled.toFixed(2)} m, guest ${hauled.guest.hauled.toFixed(2)} m`);
    // Strokes of 0.7 s, half a stroke apart: 350 ms out of step, well outside
    // the 150 ms heave window even when a slow test page sees a stroke start
    // a frame or two late.
    const ragged = await haulTogether(b, a2, 0.35, 6, 0.7);
    report.haulOutOfStep = ragged;
    check('Hauling 350 ms out of step never heaves', ragged.host.heaves === 0,
      `${ragged.host.heaves} heaves, ${ragged.host.hauled.toFixed(2)} m hauled`);

    const throwsLocal = await throwAndCatch(b, a2, 14);
    report.throwsLocal = throwsLocal;
    checkThrows('local network', throwsLocal, 0.12);
    await lifecycleChecks(b, a2);
    await a2.context.close();
    await b.context.close();

    // The plan's worst playable case: about 150 ms RTT (60 ms each way plus
    // 0 to 20 ms jitter on each side, which also reorders packets) and 1% loss.
    const lag = 'netlag=60&netjitter=20&netloss=0.01&voiceloop=1';
    const d = await openPlayer(browser, `room=LAGS&name=Di&${lag}`);
    const e = await openPlayer(browser, `room=LAGS&name=Ed&${lag}`);
    await waitFor('lagged pair connected', async () => (await state(d.page)) === 'connected' && (await state(e.page)) === 'connected');
    await new Promise((r) => setTimeout(r, 2500)); // let RTT and jitter settle
    const lagMotion = await measureMotion(d, e, 3);
    report.lagged = { ...(await netStats(e.page)), motion: lagMotion };
    const l = report.lagged;
    check('RTT reflects simulated lag', l.srtt > 115 && l.srtt < 200, `RTT ${l.srtt.toFixed(1)} ms, arrival jitter ${l.arrivalJitterMs.toFixed(1)} ms, packet interval ${l.packetIntervalMs.toFixed(1)} ms, render delay ${l.renderDelayMs.toFixed(0)} ms`);
    check('Crewmate moves smoothly (simulated lag and jitter)',
      lagMotion.frames >= 20 && lagMotion.backwards === 0 && lagMotion.maxRate < Math.max(3, lagMotion.median * 4) && lagMotion.radiusError < 0.02,
      `${lagMotion.frames} frames, ${lagMotion.backwards} backward steps ${lagMotion.backSteps.join(' ')}, fastest ${lagMotion.maxRate.toFixed(2)} rad/s vs median ${lagMotion.median.toFixed(2)}, longest frame ${lagMotion.maxGapMs.toFixed(0)} ms`);

    const loopVoice = await peakVoiceLevel(e.page, 2500);
    const loopActive = await e.page.evaluate(() => window.__net.voice.loopbackActive);
    check('Voice through the loopback route', loopActive && loopVoice > 0.01, `loopback ${loopActive}, peak level ${loopVoice.toFixed(3)}`);

    const lagCrank = await crankTogether(d, e, 8.5, 0, 6);
    report.crankLagged = lagCrank;
    check('Cranking in step reaches high gear at 150 ms RTT',
      lagCrank.host.gearFrames / lagCrank.host.frames > 0.9 && lagCrank.host.omega > 2.5 * lagCrank.host.solo,
      `${(lagCrank.host.omega / (2 * Math.PI)).toFixed(2)} turns/s, high gear ${((100 * lagCrank.host.gearFrames) / lagCrank.host.frames).toFixed(0)}% of frames`);
    check('Guest crank stays with the host at 150 ms RTT', lagCrank.guest.maxError < 0.5,
      `largest gap ${((lagCrank.guest.maxError * 180) / Math.PI).toFixed(1)}°`);

    const lagHaul = await haulTogether(d, e, 0, 6);
    report.haulLagged = lagHaul;
    check('Hauling in step heaves at 150 ms RTT', lagHaul.host.heaves >= 5,
      `${lagHaul.host.heaves} heaves, ${lagHaul.host.hauled.toFixed(2)} m hauled`);

    const throwsLagged = await throwAndCatch(d, e, 14);
    report.throwsLagged = throwsLagged;
    checkThrows('150 ms RTT', throwsLagged, 0.25);

    const errors = [...a.errors, ...b.errors, ...d.errors, ...e.errors].filter(
      (m) => !m.includes('net::ERR_') && !m.includes('Failed to load resource'),
    );
    check('No console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    mkdirSync('artifacts', { recursive: true });
    writeFileSync('artifacts/net-report.json', JSON.stringify({ report, results }, null, 2));
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(`ERROR  ${error.message}`);
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::error title=Net test aborted::${error.message}`.replace(/\r?\n/g, ' '));
    }
    process.exitCode = 1;
  })
  .finally(() => {
    // Each server runs in its own process group so npx's children stop too.
    for (const child of children) {
      try {
        process.kill(-child.pid);
      } catch {
        // already gone
      }
    }
  });
