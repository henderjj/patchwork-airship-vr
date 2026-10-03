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
 * - when the host leaves, the other player becomes host and can be rejoined.
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
const QUIET = 'islands=4&clouds=4&bricks=0&avatars=0&hud=0';

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
    if (m.text().startsWith('[Net]')) console.log(`    ${m.text()}`);
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
          if (p) out.push([p.head.px, p.head.pz]);
          if (performance.now() < end) requestAnimationFrame(frame);
          else resolve(out);
        };
        frame();
      }),
    seconds * 1000,
  );
  // Angle along the circle for each drawn frame; it should only ever advance.
  const angles = samples.map(([x, z]) => Math.atan2(z, x));
  let backwards = 0;
  const backSteps = [];
  let maxStep = 0;
  const steps = [];
  for (let i = 1; i < angles.length; i++) {
    let d = angles[i] - angles[i - 1];
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    // Ignore backward steps under 5 mm: a sender frame hitch can make the
    // brief extrapolation overshoot by a millimetre or two, which is invisible.
    if (d < -0.01) {
      backwards++;
      backSteps.push(`${i}:${d.toFixed(4)}`);
    }
    steps.push(d);
    maxStep = Math.max(maxStep, d);
  }
  const radiusError = Math.max(...samples.map(([x, z]) => Math.abs(Math.hypot(x, z) - 0.5)));
  steps.sort((a, b) => a - b);
  const median = steps[Math.floor(steps.length / 2)] ?? 0;
  return { frames: samples.length, backwards, backSteps, maxStep, median, radiusError };
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
    };
  });
}

async function main() {
  console.log('Starting the local lobby and the preview server...');
  await start(process.execPath, ['--experimental-strip-types', '--no-warnings', 'lobby/dev-server.ts'], 'listening');
  await start('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], 'Local');

  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const report = {};
  try {
    const room = 'TEST';
    const a = await openPlayer(browser, `room=${room}&name=Ann`);
    await waitFor('Ann waiting in the lobby', async () => (await state(a.page)) === 'waiting');
    const b = await openPlayer(browser, `room=${room}&name=Bo`);
    await waitFor('both connected', async () => (await state(a.page)) === 'connected' && (await state(b.page)) === 'connected');
    check('Two players connect over WebRTC', true);

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

    const motion = await measureMotion(a, b, 3);
    report.local = { ...(await netStats(b.page)), motion };
    check('Crewmate moves smoothly (local network)',
      motion.frames > 60 && motion.backwards === 0 && motion.maxStep < Math.max(0.12, motion.median * 4) && motion.radiusError < 0.02,
      `${motion.frames} frames, ${motion.backwards} backward steps ${motion.backSteps.join(' ')}, max step ${motion.maxStep.toFixed(3)} rad vs median ${motion.median.toFixed(3)}, off circle by ${(motion.radiusError * 1000).toFixed(1)} mm`);
    const s = report.local;
    check('Round trip measured', Number.isFinite(s.srtt) && s.srtt < 50, `RTT ${s.srtt?.toFixed(1)} ms, route ${s.route}, connected in ${s.connectMs.toFixed(0)} ms`);
    check('Pose packets arrive at about 45 Hz with no loss', s.lost === 0 && s.received > 100, `${s.received} received, ${s.lost} lost`);

    // Host leaves: Bo becomes host and Ann can come back.
    await a.context.close();
    await waitFor('Bo to be told the crewmate left', async () => (await state(b.page)) === 'waiting');
    const boHost = await b.page.evaluate(() => window.__net.session.isHost);
    check('The remaining player becomes host', boHost);
    const a2 = await openPlayer(browser, `room=${room}&name=Ann`);
    await waitFor('reconnected', async () => (await state(a2.page)) === 'connected' && (await state(b.page)) === 'connected');
    check('A player can rejoin', true);
    await a2.context.close();
    await b.context.close();

    // The plan's worst playable case: about 150 ms RTT (60 ms each way plus
    // 0 to 20 ms jitter on each side, which also reorders packets) and 1% loss.
    const lag = 'netlag=60&netjitter=20&netloss=0.01';
    const d = await openPlayer(browser, `room=LAGS&name=Di&${lag}`);
    const e = await openPlayer(browser, `room=LAGS&name=Ed&${lag}`);
    await waitFor('lagged pair connected', async () => (await state(d.page)) === 'connected' && (await state(e.page)) === 'connected');
    await new Promise((r) => setTimeout(r, 2500)); // let RTT and jitter settle
    const lagMotion = await measureMotion(d, e, 3);
    report.lagged = { ...(await netStats(e.page)), motion: lagMotion };
    const l = report.lagged;
    check('RTT reflects simulated lag', l.srtt > 115 && l.srtt < 200, `RTT ${l.srtt.toFixed(1)} ms, arrival jitter ${l.arrivalJitterMs.toFixed(1)} ms, packet interval ${l.packetIntervalMs.toFixed(1)} ms, render delay ${l.renderDelayMs.toFixed(0)} ms`);
    check('Crewmate moves smoothly (simulated lag and jitter)',
      lagMotion.frames > 60 && lagMotion.backwards === 0 && lagMotion.maxStep < Math.max(0.12, lagMotion.median * 4) && lagMotion.radiusError < 0.02,
      `${lagMotion.frames} frames, ${lagMotion.backwards} backward steps ${lagMotion.backSteps.join(' ')}, max step ${lagMotion.maxStep.toFixed(3)} rad vs median ${lagMotion.median.toFixed(3)}`);

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
