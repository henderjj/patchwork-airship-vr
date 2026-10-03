# IWSDK App

This project uses `iwsdk.config.json` for declarative scene, asset, component,
XR, and emulator configuration. Application systems remain explicit in
`src/index.ts`.

```sh
npm install
npm run dev
```

Use the Runtime and Editor controls in the managed browser to switch between
the running experience and its authored scene.

## Starter content

The robot and welcome panel are small examples of authored scene content plus
runtime systems. The robot turns toward the player's head and plays a sound
when pressed. To remove the robot, delete its scene node, its `RobotSystem`
registration from `src/index.ts` or `src/index.js`, and its `Robot` registration
from `src/components.ts` or `src/components.js`; you can then delete the unused
robot component and system files. To remove the welcome panel, delete its scene
node and its `PanelSystem` registration from the application entry point.

- Minimal scene walkthrough: https://iwsdk.dev/guides/01b-minimal-scene.html
- XR-enabled projects — IWER emulator controls: https://iwsdk.dev/guides/02-testing-experience.html#iwer-controls

## Grab/physics test bench

In front of the player's spawn point is a small bench with two cubes and a ball. All three have physics and can be picked up with the squeeze (grip) button. An invisible floor collider stops thrown props from falling forever. The props are defined in `src/scene-assets/test-bench.scene-asset.ts` and placed in `public/scenes/main.iwsdk.scene.json`. Keep each prop's mesh size and its `PhysicsShape` dimensions in step.

## Automated XR smoke test

```sh
npm run test:xr
```

This starts or reuses the headless dev runtime, which runs an emulated Meta Quest 3 in Chromium. It then reloads the app, enters XR, checks that every prop settled on the bench, uses the right controller to grab the blue cube, lifts it, releases it, checks that it lands back on the bench, and checks that no console errors appeared. It saves `artifacts/xr-smoke.png` and exits with code 1 if any check fails. Stop the runtime with `npm run dev:down`.

## On a real Quest 3

1. Turn on developer mode for the headset in the Meta Horizon phone app, connect it by USB and accept the debugging prompt.
2. Run `npm run dev`, then `adb reverse tcp:8081 tcp:8081`.
3. Open `https://localhost:8081/` in the Quest browser. Alternatively, on the same Wi-Fi network, open the network URL printed by `npx @iwsdk/cli dev status` and accept the certificate warning.

Note: when Claude runs inside the Claude desktop app on Windows, AppData writes are redirected, so Playwright's Chromium must live elsewhere. `.claude/settings.local.json` sets `PLAYWRIGHT_BROWSERS_PATH` for that case. A normal terminal doesn't need it.
