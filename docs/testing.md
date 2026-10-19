# Testing

## What there is

| Command | What it checks | Time on CI |
| --- | --- | --- |
| `npm run typecheck` | TypeScript for the game (and `npm run --prefix lobby typecheck` for the lobby) | seconds |
| `npm test` | Unit tests in `test/` (Vitest): simulation, networking, perf stats, and the geometry check for faces that flicker ([below](#z-fighting)); no browser | seconds |
| `npm run build` | The production build | 15 s |
| `npm run test:xr` | `scripts/xr-smoke-test.mjs`: one emulated Quest 3 in the IWSDK dev runtime, driven through the IWSDK CLI (kept loaded in a worker thread with one open browser connection, `scripts/iwsdk-worker.mjs`; `IWSDK_SPAWN=1` starts a process per call as before): hands, walking, bricks, crank, line, tracked hands, flight, gondola controls, route, cargo loading, docking, cargo, wind, climbing and repairs, narrow passages, bell, audio, frame rate | about 5 min, the longest job |
| `npm run test:net` | `scripts/net-test.mjs`: two Playwright browsers against `vite preview` and the local lobby: connection, voice, ship sync, controls, crank and haul in step, throws, presence, reconnects, lag, a gust sent from the guest, two players carrying a crate, the practice crewmate (including holding a tear shut while the player patches it, and looking out at a passage) (run `npm run build` first) | about 4 min |

## How CI runs them

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

- **plan** decides what to run (below).
- **quick** (typecheck, unit tests, build, lobby typecheck), **xr** and **net** run at the same time, each on its own runner, so a run takes as long as the slowest of them instead of all of them in a row.
- **check** passes only if every test job passed (or was skipped on purpose). It is the status check the `main` ruleset requires, so auto-merge waits for it. Keep the job's name.
- On `main`, **lobby** and **deploy** then publish the lobby Worker and the game.

What gets skipped, and why it is safe:

- A pull request that changes only Markdown, `docs/` or `LICENSE` skips **xr** and **net**: nothing they load changed.
- When a pull request passes, **check** records the exact files it tested (the git tree of the pull request merged into `main`) as an artifact named `tested-tree-<tree>`. When that pull request is merged and `main` didn't move in between, the merge on `main` has exactly the same files, so `main` skips the tests and deploys straight away. If another pull request merged first, the files differ and `main` runs everything before it deploys.

The Chromium download for the browser tests is kept in the Actions cache, keyed on the Playwright version.

Both browser tests keep the wind's automatic gusts off so a gust doesn't push their other checks about (the XR test with `window.__wind.setAuto(false)`, the net test by loading its pages with `gusts=0`); their wind checks send one from the game menu's Practice → Gusts. In the same way both keep the envelope from tearing on its own (the XR test with `window.__repairs.setRate('off')`, the net test with `tears=off`); their repair checks tear it themselves.

## While developing

Run what covers the change, cheapest first, and leave the full run to CI:

1. Always: `npm run typecheck` and `npm test`. Add or update a unit test in `test/` for logic in `src/sim/` or `src/net/`; it runs in seconds.
2. Then the browser test whose checks touch what changed:
   - one player's hands, controls, physics, flight, route or docking: `npm run test:xr`;
   - anything sent between players, the lobby or the practice crewmate: `npm run build && npm run test:net`, narrowed while iterating with `ONLY_THROW=1` (or `=lag`), `ONLY_BOT=1` or `ONLY_LIFECYCLE=1`;
   - a change that only touches docs needs neither.
3. Before marking a pull request ready, run both browser tests if the change could reach either; CI runs them anyway, but a red run costs a full cycle.

## Z-fighting

Two faces of different colours that face the same way, lie in (nearly) the same plane and overlap flicker through each other in the headset as the head moves: the depth buffer can't tell which is in front. The brick box's edges, the jetty's root, the crate's edges and the cargo hatch's edges all did, and an emulator screenshot rarely shows it. `test/z-fighting.test.ts` looks for such pairs in the built geometry (the helper is `test/support/coplanar.ts`): the gondola with the cargo gear in place, each prop that moves about the deck, the crew, the route's jetty, landing islands, rings and beacons, the narrow passages (the Cleft and the Arch), and the scenery islands (at their smallest size) and clouds. A failure lists each pair: how far apart, how much overlaps, where (in the mesh's own space) and which way it faces.

The rule it checks: keep faces like that at least 3 mm apart on and around the deck (seen from 0.3 to 3 m), and 8 mm in the world (seen from 5 m on). Make the trim stand proud (a batten 4 mm out from the planks, a band 4 mm out from the battens), end one part inside another rather than flush with its face, or give the two faces the same colour. Faces flat on the deck, facing down into it, are never seen and aren't counted.

When you add a new model, add it to that test. The camera's near plane (`render.near` in `iwsdk.config.json`) is 5 cm: the depth buffer's precision goes with it, so don't lower it to fix clipping close to the face without rerunning the test with smaller gaps in mind.

