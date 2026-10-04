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
 *  7. checks the perf CSV has rows and no console errors were logged;
 *  7b. switches to tracked hands (spike S9) and turns the crank and hauls
 *     the line with a pinch, and picks up a brick;
 *  8. checks the platform report (spike S8), then re-enters XR with the
 *     frame-rate API removed, as desktop Chrome and Edge over Link may have
 *     it, and checks the game measures the refresh rate instead.
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
  if (!pass && process.env.GITHUB_ACTIONS) {
    // An annotation shows on the run summary without needing the full log.
    console.log(`::error title=XR check failed::${name}${detail ? ` (${detail})` : ''}`.replace(/\r?\n/g, ' '));
  }
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

  // 2b. The platform report (spike S8) describes the emulated Quest 3.
  const platform = await waitFor(
    'platform report',
    () => evalInApp('window.__platform.mine && window.__platform.mine.inputs.length > 0 ? window.__platform.mine : null'),
    10000,
  ).catch(() => null);
  check(
    'Platform report lists the session',
    platform !== null && platform.hzSource === 'reported' && platform.canSetRate && platform.inputs.some((i) => i.includes('controller')),
    platform ? `${platform.hz} Hz ${platform.hzSource}, multiview ${platform.multiview}, layers ${platform.layers}, ${platform.buffer}, [${platform.inputs.join('; ')}], features [${platform.features.join(', ')}]` : 'none',
  );

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

  // 5c. Take the mooring line along the port rail with the left hand and haul it in.
  const ROPE = { x: -0.85, y: 0.95, z0: -1.35 };
  const onRope = (along) => [ROPE.x, ROPE.y, ROPE.z0 + along];
  iwsdk(['xr', 'animate-to'], { device: 'controller-left', position: toOrigin(onRope(0.3)), duration: 0.5 });
  await sleep(700);
  iwsdk(['xr', 'set-gamepad-state'], { device: 'controller-left', buttons: [{ index: SQUEEZE, value: 1 }] });
  await sleep(300);
  check('Squeeze takes hold of the mooring line', evalInApp('window.__rope.holding().left') === true);
  const ropeStart = evalInApp('window.__rope.sim.hauled');
  iwsdk(['xr', 'animate-to'], { device: 'controller-left', position: toOrigin(onRope(0.8)), duration: 1.4 });
  await sleep(1700);
  const hauledIn = evalInApp('window.__rope.sim.hauled') - ropeStart;
  check('Pulling the hand hauls the line in', hauledIn > 0.25 && evalInApp('window.__rope.holding().left') === true, `hauled ${hauledIn.toFixed(2)} m`);
  iwsdk(['xr', 'look-at'], { device: 'headset', target: { x: -0.85, y: 0.9, z: -0.5 } });
  iwsdk(['browser', 'screenshot', '--output-file', 'artifacts/xr-rope.png'], {});
  iwsdk(['xr', 'set-gamepad-state'], { device: 'controller-left', buttons: [{ index: SQUEEZE, value: 0 }] });
  await sleep(300);
  check('Letting go releases the line', evalInApp('window.__rope.holding().left') === false);
  iwsdk(['xr', 'animate-to'], { device: 'controller-left', position: { x: -0.3, y: 1.0, z: 0.2 }, duration: 0.4 });

  // 5c2. Spike S3: the comfort question. Triggers set the number, A answers,
  //      and B stops the ship and starts it again.
  const press = async (device, index) => {
    iwsdk(['xr', 'set-gamepad-state'], { device, buttons: [{ index, value: 1 }] });
    await sleep(250);
    iwsdk(['xr', 'set-gamepad-state'], { device, buttons: [{ index, value: 0 }] });
    await sleep(250);
  };
  // The emulator numbers its own buttons (trigger, squeeze, thumbstick, A/X,
  // B/Y, thumbrest), without the gamepad's empty touchpad slot.
  const TRIGGER = 0;
  const A_OR_X = 3;
  const B_OR_Y = 4;
  evalInApp('window.__comfort.ask()');
  await sleep(300);
  for (let i = 0; i < 3; i++) await press('controller-right', TRIGGER);
  await press('controller-left', TRIGGER);
  const shown = evalInApp('window.__comfort.value');
  await press('controller-right', A_OR_X);
  const comfortCsv = evalInApp('window.__comfort.csv()').trim().split('\n');
  const comfortRow = comfortCsv[comfortCsv.length - 1].split(',');
  check('The comfort question takes a rating from the triggers and A',
    shown === 2 && comfortRow[2] === '2' && evalInApp('window.__comfort.asking') === false,
    `showed ${shown}, logged ${comfortCsv[comfortCsv.length - 1]}`);
  await press('controller-right', B_OR_Y);
  const stoppedAt = evalInApp('window.__ship.state.time');
  await sleep(800);
  const stoppedFor = evalInApp('window.__ship.state.time') - stoppedAt;
  await press('controller-right', B_OR_Y);
  const goingAt = evalInApp('window.__ship.state.time');
  await sleep(800);
  const goingFor = evalInApp('window.__ship.state.time') - goingAt;
  check('B stops the ship and starts it again', stoppedFor === 0 && goingFor > 0, `${stoppedFor.toFixed(2)} s then ${goingFor.toFixed(2)} s of flight`);

  // 5d. Spike S9: the same with tracked hands, gripping by pinching (the
  //     emulator's hands can pinch but not make a fist; fists are unit-tested).
  iwsdk(['xr', 'set-input-mode'], { mode: 'hand' });
  await sleep(500);
  const handOffset = (side) => {
    const { result } = iwsdk(['xr', 'get-transform'], { device: `hand-${side}` });
    const grip = evalInApp(`window.__debug.world.player.gripSpaces.${side}.getWorldPosition(window.__debug.world.player.position.clone()).toArray()`);
    const o = toOrigin(grip);
    return { x: result.position.x - o.x, y: result.position.y - o.y, z: result.position.z - o.z };
  };
  const handTo = (side, target, duration, offset) => {
    const o = toOrigin(target);
    iwsdk(['xr', 'animate-to'], { device: `hand-${side}`, position: { x: o.x + offset.x, y: o.y + offset.y, z: o.z + offset.z }, duration });
  };
  const rightOffset = handOffset('right');
  handTo('right', onCircle(Math.PI), 0.5, rightOffset);
  await sleep(700);
  iwsdk(['xr', 'set-select-value'], { device: 'hand-right', value: 1 });
  await sleep(300);
  const handCrank = evalInApp('window.__crank.holders().local[1]');
  check('A pinching hand takes the crank handle', handCrank === 'right', `handle 1 held by ${handCrank}, grip ${JSON.stringify(evalInApp('window.__grip.state.right'))}`);
  const handCrankStart = evalInApp('window.__crank.sim.angle');
  for (let i = 1; i <= 16; i++) {
    handTo('right', onCircle(Math.PI + (i * Math.PI) / 8), 0.12, rightOffset);
  }
  await sleep(400);
  const handTurned = evalInApp('window.__crank.sim.angle') - handCrankStart;
  check('Turning a tracked hand turns the crank', handTurned > 1.5 * Math.PI, `turned ${(handTurned / (2 * Math.PI)).toFixed(2)} turns`);
  iwsdk(['xr', 'look-at'], { device: 'headset', target: { x: 0, y: 1.0, z: -1.2 } });
  iwsdk(['browser', 'screenshot', '--output-file', 'artifacts/xr-hand-crank.png'], {});
  iwsdk(['xr', 'set-select-value'], { device: 'hand-right', value: 0 });
  await sleep(300);
  check('Opening the pinch releases the crank', evalInApp('window.__crank.holders().local[1]') === null);
  handTo('right', [0.3, 1.0, 0.2], 0.4, rightOffset);

  const leftOffset = handOffset('left');
  handTo('left', onRope(0.3), 0.5, leftOffset);
  await sleep(700);
  iwsdk(['xr', 'set-select-value'], { device: 'hand-left', value: 1 });
  await sleep(300);
  const handRopeStart = evalInApp('window.__rope.sim.hauled');
  handTo('left', onRope(0.8), 1.4, leftOffset);
  await sleep(1700);
  const handHauled = evalInApp('window.__rope.sim.hauled') - handRopeStart;
  check('A pinching hand hauls the line', handHauled > 0.25 && evalInApp('window.__rope.holding().left') === true, `hauled ${handHauled.toFixed(2)} m`);
  iwsdk(['xr', 'set-select-value'], { device: 'hand-left', value: 0 });
  await sleep(300);
  check('Opening the pinch releases the line', evalInApp('window.__rope.holding().left') === false);
  handTo('left', [-0.3, 1.0, 0.2], 0.4, leftOffset);

  const looseBrick = bricks.map((b) => ({ b, p: position(b.entityIndex) })).find(({ p }) => aboard(p) && p[1] < 0.3);
  handTo('right', looseBrick.p, 0.5, rightOffset);
  await sleep(700);
  iwsdk(['xr', 'set-select-value'], { device: 'hand-right', value: 1 });
  await sleep(300);
  handTo('right', [0.1, 1.2, -0.6], 0.6, rightOffset);
  await sleep(800);
  const handBrick = position(looseBrick.b.entityIndex);
  check('A pinching hand picks up a brick', handBrick[1] > 0.8, `brick at ${fmt(handBrick)}`);
  iwsdk(['xr', 'set-select-value'], { device: 'hand-right', value: 0 });
  await sleep(1500);
  iwsdk(['xr', 'set-input-mode'], { mode: 'controller' });
  await sleep(300);

  // 6. Fly the tour profile; bricks stay aboard while the world moves.
  const shipStart = evalInApp('[window.__ship.state.x, window.__ship.state.z]');
  evalInApp("window.__ship.setProfile('tour')");
  // Watch the bricks in the page for the whole flight (each CLI call is slow),
  // noting the first moment each one is off the deck.
  const strays = evalInApp(`new Promise((resolve) => {
    const t0 = performance.now();
    const seen = new Map();
    const id = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      for (const o of window.__throw.objects()) {
        const [x, y, z] = o.pos;
        const off = Math.abs(x) > ${DECK_HALF_WIDTH + 0.05} || Math.abs(z) > ${DECK_HALF_LENGTH + 0.05} || y < -0.02 || y > 2.5;
        if (off && !seen.has(o.id)) {
          seen.set(o.id, 'brick ' + o.id + ' at ' + t.toFixed(1) + ' s: ' + o.pos.map((v) => v.toFixed(2)).join(', ') + ' speed ' + o.speed.toFixed(1) + (o.heldBy ? ' held by ' + o.heldBy : ''));
        }
      }
      if (t > 6) {
        clearInterval(id);
        resolve([...seen.values()]);
      }
    }, 100);
  })`);
  const shipEnd = evalInApp('[window.__ship.state.x, window.__ship.state.z]');
  const travelled = Math.hypot(shipEnd[0] - shipStart[0], shipEnd[1] - shipStart[1]);
  check('Ship flies the tour profile', travelled > 1, `${travelled.toFixed(1)} m`);
  const positions = bricks.map((b) => position(b.entityIndex));
  check('All bricks stay aboard while flying', positions.every(aboard) && strays.length === 0,
    [...positions.filter((p) => !aboard(p)).map(fmt), ...strays].join(' | '));
  iwsdk(['xr', 'look-at'], { device: 'headset', target: { x: 0, y: 1.4, z: -3 } });
  iwsdk(['browser', 'screenshot', '--output-file', 'artifacts/xr-flying.png'], {});

  // 6b. Phase 2 flight model, driven from the keyboard (each CLI call takes
  //     a second or two, so the fuel left is only roughly known):
  //     B feeds the burner, V (held) opens the vent, . (held) swings the rudder to starboard.
  const key = (type, k) => evalInApp(`window.dispatchEvent(new KeyboardEvent('${type}', { key: '${k}' }))`);
  // Aloft, clear of island A (the flight starts resting on it).
  evalInApp('window.__ship.fly()');
  evalInApp('window.__ship.place(0, 135, -60)');
  const heat0 = evalInApp('window.__ship.info.heat');
  key('keydown', 'b');
  key('keyup', 'b');
  key('keydown', 'b');
  key('keyup', 'b');
  key('keydown', '.');
  await sleep(4000);
  key('keyup', '.');
  const burning = evalInApp('({ ...window.__ship.info, rudder: window.__ship.controls.rudder, yaw: window.__ship.state.yaw })');
  check('Fuel heats the envelope and the rudder turns the ship',
    burning.burner && burning.heat > heat0 + 1 && burning.burnLeft > 20 && burning.burnLeft < 40 && burning.rudder > 0.5 && burning.yaw < -0.002,
    `heat ${heat0.toFixed(1)} → ${burning.heat.toFixed(1)} °C, ${burning.burnLeft.toFixed(0)} s of fuel left, rudder ${burning.rudder.toFixed(2)}, heading ${((burning.yaw * 180) / Math.PI).toFixed(1)}°`);
  key('keydown', 'v');
  await sleep(2000);
  const venting = evalInApp('window.__ship.info');
  key('keyup', 'v');
  check('The vent dumps heat even with the burner lit', venting.vent && venting.heat < burning.heat,
    `heat ${burning.heat.toFixed(1)} → ${venting.heat.toFixed(1)} °C`);
  const flownBricks = bricks.map((b) => position(b.entityIndex));
  check('All bricks stay aboard under the flight model', flownBricks.every(aboard), flownBricks.filter((p) => !aboard(p)).map(fmt).join(' | '));
  // 6c. Phase 2 gondola controls, by hand.
  evalInApp('window.__ship.fly()');
  const move = async (p, duration = 0.4) => {
    iwsdk(['xr', 'animate-to'], { device: 'controller-right', position: toOrigin(p), duration });
    await sleep(duration * 1000 + 300);
  };
  const squeeze = async (value) => {
    iwsdk(['xr', 'set-gamepad-state'], { device: 'controller-right', buttons: [{ index: SQUEEZE, value }] });
    await sleep(300);
  };
  const controlHeld = () => evalInApp("window.__controls.local().held.right");
  // Tiller: the handle starts straight ahead of the rudder post.
  await move([0, 0.9, 0.75]);
  await squeeze(1);
  const tillerHeld = controlHeld();
  await move([0.28, 0.9, 0.8], 0.6);
  const steered = evalInApp('window.__ship.controls.rudder');
  await squeeze(0);
  await sleep(300);
  const leftAt = evalInApp('window.__ship.controls.rudder');
  check('The tiller is taken by hand and steers', tillerHeld === 'tiller' && steered < -0.5 && Math.abs(leftAt - steered) < 0.05,
    `held by ${tillerHeld}, pushed to starboard gives rudder ${steered.toFixed(2)} (port), stays at ${leftAt.toFixed(2)} when let go`);
  iwsdk(['xr', 'look-at'], { device: 'headset', target: { x: 0.3, y: 0.9, z: 0.6 } });
  iwsdk(['browser', 'screenshot', '--output-file', 'artifacts/xr-tiller.png'], {});
  // Vent cord: pull the toggle down.
  await move([0.1, 1.5, 0]);
  await move([-0.3, 1.56, -0.3]);
  await squeeze(1);
  const ventHeld = controlHeld();
  await move([-0.3, 1.3, -0.3], 0.5);
  const pulled = evalInApp('window.__ship.info.ventOpen');
  await squeeze(0);
  await sleep(300);
  const released = evalInApp('window.__ship.info.ventOpen');
  check('Pulling the vent cord opens the vent, and it closes when let go', ventHeld === 'vent' && pulled > 0.6 && released === 0,
    `held by ${ventHeld}, open ${(pulled * 100).toFixed(0)}% pulled, ${(released * 100).toFixed(0)}% let go`);
  // Ballast: lift the first bag off its hook outside the starboard rail and let go.
  await move([0.6, 1.1, 0.5]);
  await move([1.16, 0.8, 0.55]);
  await squeeze(1);
  const bagHeld = controlHeld();
  await move([1.25, 1.0, 0.55], 0.3);
  await squeeze(0);
  await sleep(500);
  const ballast = evalInApp('({ mask: window.__ship.info.ballastMask, kg: window.__ship.controls.ballastDropped })');
  check('A sandbag let go over the side is dropped', bagHeld === 'bag0' && ballast.mask === 1 && ballast.kg === 20,
    `held by ${bagHeld}, dropped mask ${ballast.mask}, ${ballast.kg} kg gone`);
  await move([0.3, 1.0, 0.2]);
  // Burner: a brick let go over the hopper is burned and a fresh one appears in the crate.
  const burnedBefore = evalInApp('window.__ship.info.bricksBurned');
  evalInApp('window.__throw.place(0, 0.55, 0.85, 0.05)');
  await sleep(1500);
  const fed = evalInApp('({ burned: window.__ship.info.bricksBurned, left: window.__ship.info.burnLeft })');
  const brick0 = evalInApp('window.__throw.objects()[0].pos');
  check('A brick dropped in the hopper feeds the burner', fed.burned === burnedBefore + 1 && fed.left > 15 && inCrate(brick0),
    `${fed.burned - burnedBefore} burned, ${fed.left.toFixed(0)} s of flame, brick back at ${fmt(brick0)}`);
  // Read the instrument board while the brick still burns (slow CI runners
  // take many seconds over the steps below).
  const board = evalInApp('window.__controls.boardText()');
  check('The instrument board shows the flight', board.length === 5 && board[3].startsWith('BURNER') && !board[3].endsWith('out'), board.join(' | '));
  iwsdk(['xr', 'look-at'], { device: 'headset', target: { x: 0.55, y: 1.2, z: 0.05 } });
  iwsdk(['browser', 'screenshot', '--output-file', 'artifacts/xr-burner.png'], {});
  // Lantern: hangs towards the low side of a tilted deck.
  evalInApp('window.__ship.setFixedTilt(4, 0)');
  await sleep(3000);
  const swing = evalInApp('window.__controls.lantern()');
  evalInApp('window.__ship.clearFixedTilt()');
  check('The lantern swings towards the low side of the deck', swing.z > 0.03, `swung ${((swing.z * 180) / Math.PI).toFixed(1)}° to starboard with the deck 4° starboard-down`);

  // 6d. Phase 2 route: rest on island A, lift off, fly through a ring, land
  //     on island B for a score, ring the bell to start again, and lose a run.
  //     The ship is moved between the route's points to keep the test short.
  evalInApp('window.__ship.fly()');
  const route = evalInApp('window.__route.run.route');
  const atStart = evalInApp('({ phase: window.__route.run.phase, grounded: window.__ship.flight.grounded, y: window.__ship.state.y, board: window.__route.boardText() })');
  // The keel sits on the grass, about half a metre below the deck.
  const keelGap = atStart.y - route.start.y;
  check('The flight starts resting on island A', atStart.phase === 'ready' && atStart.grounded && keelGap > 0.4 && keelGap < 0.7 && atStart.board[1] === 'Waiting on island A',
    `${atStart.phase}, deck at ${atStart.y.toFixed(2)} m on a top at ${route.start.y} m, board: ${atStart.board.join(' | ')}`);
  iwsdk(['xr', 'set-transform'], { device: 'headset', position: toOrigin([0.3, 1.6, 1.2]) });
  iwsdk(['xr', 'look-at'], { device: 'headset', target: { x: -20, y: -4, z: -60 } });
  await sleep(800);
  iwsdk(['browser', 'screenshot', '--output-file', 'artifacts/xr-island-a.png'], {});
  evalInApp('window.__ship.feedFuel()');
  evalInApp('window.__ship.feedFuel()');
  const lifted = await waitFor('lift-off from island A', () => evalInApp("window.__route.run.phase === 'flying' ? { y: window.__ship.state.y } : null"), 30000).catch(() => null);
  await sleep(1500);
  const timer = evalInApp('window.__route.run.seconds');
  check('Burning fuel lifts the ship off and starts the clock', lifted !== null && timer > 0.5, lifted ? `aloft at ${lifted.y.toFixed(1)} m, ${timer.toFixed(1)} s on the clock` : 'never lifted off');
  const ring = route.rings[0];
  evalInApp(`window.__ship.place(${ring.x}, ${ring.y - 5}, ${ring.z + 30}, 0)`);
  iwsdk(['xr', 'set-transform'], { device: 'headset', position: toOrigin([0, 1.6, -0.8]) });
  iwsdk(['xr', 'look-at'], { device: 'headset', target: { x: 0, y: 6, z: -30 } });
  await sleep(800);
  iwsdk(['browser', 'screenshot', '--output-file', 'artifacts/xr-ring.png'], {});
  evalInApp(`(window.__ship.place(${ring.x}, ${ring.y - 5}, ${ring.z + 2}, 0), window.__ship.flight.airspeed = 4)`);
  const passed = await waitFor('ring 1', () => evalInApp('window.__route.run.ringMask & 1'), 10000).catch(() => 0);
  const flyingBoard = evalInApp('window.__route.boardText()');
  check('Flying through a ring counts it, and the board points to the next', passed === 1 && flyingBoard[1] === 'RINGS 1 of 2' && flyingBoard[2].startsWith('NEXT Ring 2'),
    flyingBoard.join(' | '));
  const b = route.finish;
  evalInApp(`(window.__ship.place(${b.x + 2}, ${b.y + 1.2}, ${b.z + 3}), window.__ship.flight.heat = 40, window.__ship.info.burnLeft = 0)`);
  const finished = await waitFor('landing on island B', () => evalInApp("window.__route.run.phase === 'finished' ? window.__route.run.result : null"), 30000).catch(() => null);
  const scoreBoard = evalInApp('window.__route.boardText()');
  check('Resting on island B finishes the run with a score', finished !== null && finished.rings === 1 && finished.score > 0 && scoreBoard[0].startsWith('LANDED'),
    scoreBoard.join(' | '));
  iwsdk(['xr', 'set-transform'], { device: 'headset', position: toOrigin([0.45, 1.55, -0.55]) });
  iwsdk(['xr', 'look-at'], { device: 'headset', target: { x: 0.55, y: 1.5, z: -0.05 } });
  await sleep(800);
  iwsdk(['browser', 'screenshot', '--output-file', 'artifacts/xr-score.png'], {});
  // The bell, by hand.
  await move([-0.4, 1.4, -0.8]);
  await move([-0.78, 1.58, -1.3]);
  await squeeze(1);
  await sleep(300);
  const rung = evalInApp('({ phase: window.__route.run.phase, x: window.__ship.state.x, y: window.__ship.state.y, z: window.__ship.state.z, bell: window.__route.bell().peak })');
  await squeeze(0);
  await move([-0.3, 1.2, -0.5]);
  check('Ringing the bell starts again from island A', rung.phase === 'ready' && rung.x === route.start.x && rung.y === atStart.y && rung.z === route.start.z && rung.bell > 0.01,
    `${rung.phase} at ${fmt([rung.x, rung.y, rung.z])}, bell swung ${((rung.bell * 180) / Math.PI).toFixed(0)}°`);
  // Mid-run, one ring only asks; sinking into the haze loses the run; N (the keyboard's bell) restarts.
  evalInApp('window.__ship.place(0, 126, -40)');
  await waitFor('flying', () => evalInApp("window.__route.run.phase === 'flying'"), 5000).catch(() => null);
  // In one call, since each CLI call takes long enough for the second-ring window to pass.
  const asked = evalInApp(`(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' })),
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'n' })),
    new Promise((resolve) => setTimeout(() => resolve({ phase: window.__route.run.phase, board: window.__route.boardText() }), 400)))`);
  evalInApp('window.__ship.place(0, 35, -60)');
  const lost = await waitFor('lost run', () => evalInApp("window.__route.run.phase === 'lost' ? window.__route.boardText() : null"), 5000).catch(() => null);
  key('keydown', 'n');
  key('keyup', 'n');
  const again = evalInApp('window.__route.run.phase');
  check('Mid-run the bell asks first, a sunk run is lost, and the bell restarts it',
    asked.phase === 'flying' && asked.board[5] === 'Ring again to restart' && lost?.[1] === 'Sank into the haze' && again === 'ready',
    `one ring: ${asked.phase} "${asked.board[5]}", then ${lost ? lost.slice(0, 2).join(' / ') : 'not lost'}, then ${again}`);
  iwsdk(['xr', 'set-transform'], { device: 'headset', position: toOrigin([0, 1.6, 0]) });
  evalInApp("window.__ship.setProfile('tour')");

  // 7. Perf log.
  const rows = evalInApp('window.__perf.recorder.rows.length');
  check('Perf CSV is recording', rows > 2, `${rows - 1} rows`);

  // 8. A runtime without the frame-rate API (desktop browsers over Link may
  //    lack it): the game skips the request and measures the rate instead.
  iwsdk(['xr', 'exit'], {});
  await waitFor('XR session to end', () => !iwsdk(['xr', 'status'], {}).result.sessionActive, 10000);
  await sleep(2500);
  const flatHz = evalInApp("window.__perf.recorder.rows.at(-1).split(',')[1]");
  check('Leaving VR stops budgeting frames at the headset rate', flatHz === '60', `latest perf row at ${flatHz} Hz`);
  evalInApp(`(() => {
    const proto = Object.getPrototypeOf(window.__debug.world.session ?? {}) ?? {};
    const target = window.XRSession?.prototype ?? proto;
    Object.defineProperty(target, 'frameRate', { configurable: true, get: () => undefined });
    Object.defineProperty(target, 'supportedFrameRates', { configurable: true, get: () => undefined });
    Object.defineProperty(target, 'updateTargetFrameRate', { configurable: true, value: undefined });
  })()`);
  const pcStart = Date.now();
  await waitFor('XR offer', () => iwsdk(['xr', 'status'], {}).result.sessionOffered, 10000);
  iwsdk(['xr', 'enter'], {});
  const pcRateLog = await waitFor(
    'frame-rate log',
    () => iwsdk(['browser', 'logs'], { count: 200, since: pcStart }).result.find((e) => e.message.includes('[FrameRate] supported')),
    15000,
  ).catch(() => null);
  check('No rate request without the frame-rate API', pcRateLog?.message.includes('requesting=none') === true, pcRateLog?.message);
  const pcPlatform = await waitFor(
    'measured platform report',
    () => evalInApp("window.__platform.mine && window.__platform.mine.hzSource === 'measured' ? window.__platform.mine : null"),
    12000,
  ).catch(() => null);
  check(
    'Refresh rate is measured instead',
    pcPlatform !== null && pcPlatform.hz > 0 && !pcPlatform.canSetRate,
    pcPlatform ? `~${pcPlatform.hz} Hz` : `report ${JSON.stringify(evalInApp('window.__platform.mine'))}`,
  );
  // Hold the left wrist up to see the HUD's platform lines.
  iwsdk(['xr', 'animate-to'], { device: 'controller-left', position: toOrigin([-0.03, 1.38, -0.3]), duration: 0.3 });
  iwsdk(['xr', 'look-at'], { device: 'headset', target: { x: -0.03, y: 1.4, z: -0.3 } });
  await sleep(800);
  iwsdk(['browser', 'screenshot', '--output-file', 'artifacts/xr-pcvr-hud.png'], {});

  // Console.
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
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error title=XR test aborted::${error.message}`.replace(/\r?\n/g, ' '));
  }
  process.exitCode = 1;
});
