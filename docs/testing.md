# Testing

## What there is

| Command | What it checks | Time on CI |
| --- | --- | --- |
| `npm run typecheck` | TypeScript for the game (and `npm run --prefix lobby typecheck` for the lobby) | seconds |
| `npm test` | Unit tests in `test/` (Vitest): simulation, networking, perf stats; no browser | seconds |
| `npm run build` | The production build | 15 s |
| `npm run test:xr` | `scripts/xr-smoke-test.mjs`: one emulated Quest 3 in the IWSDK dev runtime, driven through the IWSDK CLI (kept loaded in a worker thread with one open browser connection, `scripts/iwsdk-worker.mjs`; `IWSDK_SPAWN=1` starts a process per call as before): hands, walking, bricks, crank, line, tracked hands, flight, gondola controls, route, docking, bell, audio, frame rate | about 5 min, the longest job |
| `npm run test:net` | `scripts/net-test.mjs`: two Playwright browsers against `vite preview` and the local lobby: connection, voice, ship sync, controls, crank and haul in step, throws, presence, reconnects, lag, the practice crewmate (run `npm run build` first) | about 4 min |

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

## While developing

Run what covers the change, cheapest first, and leave the full run to CI:

1. Always: `npm run typecheck` and `npm test`. Add or update a unit test in `test/` for logic in `src/sim/` or `src/net/`; it runs in seconds.
2. Then the browser test whose checks touch what changed:
   - one player's hands, controls, physics, flight, route or docking: `npm run test:xr`;
   - anything sent between players, the lobby or the practice crewmate: `npm run build && npm run test:net`, narrowed while iterating with `ONLY_THROW=1` (or `=lag`), `ONLY_BOT=1` or `ONLY_LIFECYCLE=1`;
   - a change that only touches docs needs neither.
3. Before marking a pull request ready, run both browser tests if the change could reach either; CI runs them anyway, but a red run costs a full cycle.
