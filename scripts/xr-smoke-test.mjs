#!/usr/bin/env node
/**
 * Headless XR smoke test for the gondola.
 *
 * Drives the IWSDK managed browser (an emulated Meta Quest 3, through IWER,
 * IWSDK's browser-based XR emulator) with the @iwsdk/cli surface:
 *
 *  1. reloads the app and enters an immersive session;
 *  2. checks the 90 Hz request ran;
 *  3. checks the fuel bricks settled in the crate;
 *  4. grabs a brick with the right controller's squeeze, lifts and drops it,
 *     and checks it lands on the deck;
 *  5. tilts the ship 40° (test hook) and checks the bricks slide to starboard,
 *     which proves felt gravity reaches the physics worker and wakes bodies;
 *  6. flies the scripted "tour" for a few seconds and checks the bricks stay
 *     aboard while the world moves;
 *  7. checks the perf CSV has rows and no console errors were logged.
 *
 * Usage: npm run test:xr   (starts the dev runtime headless if needed)
 * Exit code 0 = all checks passed. Screenshots go to artifacts/.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../node_modules/@iwsdk/cli/dist/cli.js', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Mirrors src/scene-assets/gondola.scene-asset.ts.
const DECK_HALF_WIDTH = 1.0;
const DECK_HALF_LENGTH = 1.5;
const CRATE = { x: -0.55, z: 1.1, halfW: 0.3, halfD: 0.225, height: 0.32 };
const BRICK_COUNT = 8;
const SQUEEZE = 1; // gamepad button index for proximity grab

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function iwsdk(args, input) {
  const argv = [CLI, ...args];
  if (input !== undefined) argv.push('--input-json', JSON.stringify(input));
  let stdout;
  try {
    stdout = execFileSync(process.execPath, argv, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    stdout = error.stdout ?? '';
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`iwsdk ${args.join(' ')}: unparseable output\n${stdout}`);
  }
  if (!parsed.ok) {
    throw new Error(`iwsdk ${args.join(' ')} failed: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.data;
}

/** Evaluate an expression in the app frame (needs --allow-browser-automation). */
function evalInApp(expression) {
  const file = 'artifacts/.eval.mjs';
  writeFileSync(
    `${ROOT}/${file}`,
    `export default async function run({ page, frame }) {\n` +
      `  const target = frame ?? page;\n` +
      `  return await target.evaluate(() => (${expression}));\n}\n`,
  );
  try {
    const data = iwsdk(['browser', 'run', file, '--timeout', '20000']);
    return data.result?.value ?? data.result;
  } finally {
    rmSync(`${ROOT}/${file}`, { force: true });
  }
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function waitFor(label, fn, timeoutMs = 60000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function findEntity(name) {
  const { result } = iwsdk(['ecs', 'find'], { namePattern: name, limit: 5 });
  return result.entities.find((entity) => entity.name === name);
}

function position(entityIndex) {
  const { result } = iwsdk(['ecs', 'query'], { entityIndex, components: ['Transform'] });
  return result.components.find((c) => c.componentId === 'Transform').values.position;
}

function grabbedNames() {
  const { result } = iwsdk(['ecs', 'find'], { withComponents: ['Grabbed'], limit: 10 });
  return result.entities.map((entity) => entity.name);
}

/**
 * Controller poses are in the XR origin's space; the origin can drift from the
 * world origin (locomotion), so convert world targets into it.
 */
function toOrigin(p) {
  const o = evalInApp('window.__debug.world.player.position.toArray()');
  return { x: p[0] - o[0], y: p[1] - o[1], z: p[2] - o[2] };
}

const fmt = (p) => p.map((v) => v.toFixed(3)).join(', ');
const inCrate = (p) =>
  Math.abs(p[0] - CRATE.x) < CRATE.halfW && Math.abs(p[2] - CRATE.z) < CRATE.halfD && p[1] > 0 && p[1] < CRATE.height + 0.2;
const aboard = (p) =>
  Math.abs(p[0]) < DECK_HALF_WIDTH + 0.05 && Math.abs(p[2]) < DECK_HALF_LENGTH + 0.05 && p[1] > -0.02 && p[1] < 2.5;

async function ensureRuntime() {
  console.log('Starting (or attaching to) the headless dev runtime...');
  iwsdk(['dev', 'up', '--headless', '--allow-browser-automation', '--timeout', '120000']);
  await waitFor('managed browser', () => iwsdk(['dev', 'status']).state?.browserCommandReady === true, 180000, 2000);
  try {
    evalInApp('1');
  } catch (error) {
    if (!String(error.message).includes('automation')) throw error;
    console.log('Restarting the runtime with browser automation enabled...');
    iwsdk(['dev', 'down']);
    iwsdk(['dev', 'up', '--headless', '--allow-browser-automation', '--timeout', '120000']);
    await waitFor('managed browser', () => iwsdk(['dev', 'status']).state?.browserCommandReady === true, 180000, 2000);
  }
}

async function main() {
  mkdirSync(`${ROOT}/artifacts`, { recursive: true });
  await ensureRuntime();
  const startedAt = Date.now();

  iwsdk(['browser', 'reload'], {});
  await waitFor('XR offer after reload', () => {
    const { result } = iwsdk(['xr', 'status'], {});
    return result.sessionOffered || result.sessionActive;
  });
  if (!iwsdk(['xr', 'status'], {}).result.sessionActive) {
    iwsdk(['xr', 'enter'], {});
  }
  // Reset the emulated headset and controllers (buttons, poses) left over
  // from any earlier session.
  iwsdk(['xr', 'set-device-state'], {});
  iwsdk(['xr', 'set-gamepad-state'], { device: 'controller-right', buttons: [{ index: SQUEEZE, value: 0 }] });
  check('XR session active', iwsdk(['xr', 'status'], {}).result.sessionActive);

  // 2. The frame-rate system ran when the session started.
  const rateLog = await waitFor(
    'frame-rate log',
    () => iwsdk(['browser', 'logs'], { count: 200, since: startedAt }).result.find((e) => e.message.includes('[FrameRate]')),
    15000,
  ).catch(() => null);
  check('90 Hz requested on session start', rateLog !== null, rateLog?.message);

  // 3. Bricks settle inside the crate.
  const bricks = [];
  for (let i = 1; i <= BRICK_COUNT; i++) {
    bricks.push(await waitFor(`Fuel Brick ${i}`, () => findEntity(`Fuel Brick ${i}`)));
  }
  await sleep(2500);
  const settled = bricks.map((b) => position(b.entityIndex));
  const allInCrate = settled.every(inCrate);
  check('Fuel bricks rest in the crate', allInCrate, allInCrate ? '' : settled.map(fmt).join(' | '));

  // 4. Grab a brick from the top of the stack, lift it, drop it on the open deck.
  const topY = Math.max(...settled.map((p) => p[1]));
  const start = settled.find((p) => p[1] === topY);
  iwsdk(['xr', 'animate-to'], { device: 'controller-right', position: toOrigin(start), duration: 0.4 });
  iwsdk(['xr', 'set-gamepad-state'], { device: 'controller-right', buttons: [{ index: SQUEEZE, value: 1 }] });
  const grabbedName = await waitFor('Grabbed tag', () => grabbedNames().find((n) => n.startsWith('Fuel Brick')), 3000).catch(() => null);
  check('Squeeze grabs a fuel brick', grabbedName !== null, `grabbed: [${grabbedNames().join(', ')}]`);
  const brick = (bricks.find((b) => b.name === grabbedName) ?? bricks[BRICK_COUNT - 1]).entityIndex;
  const lift = { x: 0.1, y: 1.2, z: -0.6 };
  iwsdk(['xr', 'animate-to'], { device: 'controller-right', position: toOrigin([lift.x, lift.y, lift.z]), duration: 0.6 });
  await sleep(500);
  const held = position(brick);
  // The grab keeps the brick's offset from the grip point, so allow 20 cm.
  check('Held brick follows the controller', Math.hypot(held[0] - lift.x, held[1] - lift.y, held[2] - lift.z) < 0.2, `pos ${fmt(held)}`);
  iwsdk(['xr', 'look-at'], { device: 'headset', target: { x: 0, y: 0.6, z: -0.6 } });
  iwsdk(['browser', 'screenshot', '--output-file', 'artifacts/xr-holding-brick.png'], {});
  // Lower it over the open deck and let go with the hand still.
  iwsdk(['xr', 'animate-to'], { device: 'controller-right', position: toOrigin([0.1, 0.5, -0.6]), duration: 0.6 });
  await sleep(800);
  iwsdk(['xr', 'set-gamepad-state'], { device: 'controller-right', buttons: [{ index: SQUEEZE, value: 0 }] });
  await sleep(300);
  iwsdk(['xr', 'animate-to'], { device: 'controller-right', position: { x: 0.3, y: 1.0, z: 0.2 }, duration: 0.6 });
  const landed = await waitFor(
    'brick to land',
    () => {
      const p = position(brick);
      return p[1] < 0.12 && aboard(p) ? p : null;
    },
    5000,
  ).catch(() => null);
  check('Released brick is no longer grabbed', !grabbedNames().includes(grabbedName));
  check('Released brick lands on the deck', landed !== null, `pos ${fmt(landed ?? position(brick))}`);

  // 5. Tilt the ship hard (test only): a resting brick must wake up and slide
  //    to starboard, then stop at the starboard wall.
  evalInApp(`(() => {
    const { world, PhysicsSystem } = window.__debug;
    const entity = world.entityManager.getEntityByIndex(${brick});
    world.getSystem(PhysicsSystem).setBodyTransform(entity, { position: [0.2, 0.2, -0.6], quaternion: [0, 0, 0, 1] });
  })()`);
  await sleep(2500);
  const before = position(brick);
  evalInApp('window.__ship.setFixedTilt(40, 0)');
  await sleep(3000);
  const after = position(brick);
  check(
    'Ship tilt wakes resting bricks and they slide to starboard',
    after[0] > before[0] + 0.3 && aboard(after),
    `x ${before[0].toFixed(3)} -> ${after[0].toFixed(3)}`,
  );
  evalInApp('window.__ship.clearFixedTilt()');
  await sleep(1500);

  // 5b. Take the right crank handle and turn it once by hand.
  const R = 0.22;
  const AXLE = { x: 0.42, y: 1.0, z: -1.2 };
  const onCircle = (a) => [AXLE.x, AXLE.y + R * Math.cos(a), AXLE.z - R * Math.sin(a)];
  // Handle 1 starts at the bottom (half a turn from handle 0 at the top).
  iwsdk(['xr', 'animate-to'], { device: 'controller-right', position: toOrigin(onCircle(Math.PI)), duration: 0.5 });
  await sleep(700);
  iwsdk(['xr', 'set-gamepad-state'], { device: 'controller-right', buttons: [{ index: SQUEEZE, value: 1 }] });
  await sleep(300);
  const crankHolder = evalInApp('window.__crank.holders().local[1]');
  check('Squeeze takes the crank handle', crankHolder === 'right', `handle 1 held by ${crankHolder}`);
  const crankStart = evalInApp('window.__crank.sim.angle');
  for (let i = 1; i <= 16; i++) {
    iwsdk(['xr', 'animate-to'], { device: 'controller-right', position: toOrigin(onCircle(Math.PI + (i * Math.PI) / 8)), duration: 0.12 });
  }
  await sleep(400);
  const crankTurned = evalInApp('window.__crank.sim.angle') - crankStart;
  const stillHeld = evalInApp('window.__crank.holders().local[1]');
  check('Turning the hand turns the crank', crankTurned > 1.5 * Math.PI && stillHeld === 'right', `turned ${(crankTurned / (2 * Math.PI)).toFixed(2)} turns, held by ${stillHeld}`);
  iwsdk(['xr', 'look-at'], { device: 'headset', target: { x: 0, y: 1.0, z: -1.2 } });
  iwsdk(['browser', 'screenshot', '--output-file', 'artifacts/xr-crank.png'], {});
  iwsdk(['xr', 'set-gamepad-state'], { device: 'controller-right', buttons: [{ index: SQUEEZE, value: 0 }] });
  await sleep(300);
  check('Letting go releases the crank', evalInApp('window.__crank.holders().local[1]') === null);
  iwsdk(['xr', 'animate-to'], { device: 'controller-right', position: { x: 0.3, y: 1.0, z: 0.2 }, duration: 0.4 });

  // 6. Fly the tour profile; bricks stay aboard while the world moves.
  const shipStart = evalInApp('[window.__ship.state.x, window.__ship.state.z]');
  evalInApp("window.__ship.setProfile('tour')");
  await sleep(6000);
  const shipEnd = evalInApp('[window.__ship.state.x, window.__ship.state.z]');
  const travelled = Math.hypot(shipEnd[0] - shipStart[0], shipEnd[1] - shipStart[1]);
  check('Ship flies the tour profile', travelled > 1, `${travelled.toFixed(1)} m`);
  const positions = bricks.map((b) => position(b.entityIndex));
  check('All bricks stay aboard while flying', positions.every(aboard), positions.filter((p) => !aboard(p)).map(fmt).join(' | '));
  iwsdk(['xr', 'look-at'], { device: 'headset', target: { x: 0, y: 1.4, z: -3 } });
  iwsdk(['browser', 'screenshot', '--output-file', 'artifacts/xr-flying.png'], {});

  // 7. Perf log and console.
  const rows = evalInApp('window.__perf.recorder.rows.length');
  check('Perf CSV is recording', rows > 2, `${rows - 1} rows`);
  const { result: logs } = iwsdk(['browser', 'logs'], { level: 'error', count: 20, since: startedAt });
  // Controller models come from a CDN the cloud test runner can't reach; a
  // headset can. Ignore only those fetch failures.
  const errors = logs
    .map((entry) => entry.message)
    .filter((m) => !(m.includes('ERR_TUNNEL_CONNECTION_FAILED') || m.includes('webxr-input-profiles')))
    // Module requests cancelled by the page reload at the start of the test.
    .filter((m) => !m.includes('net::ERR_ABORTED'));
  check('No console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`ERROR  ${error.message}`);
  process.exitCode = 1;
});
