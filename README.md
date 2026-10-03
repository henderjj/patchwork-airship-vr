# Patchwork Airship VR

A two-player co-op VR airship game that runs in the browser, built with [IWSDK](https://iwsdk.dev) (Immersive Web SDK). Targets 90 Hz on Meta Quest 3 and also runs on PC VR through Meta Horizon Link. The design and plan live in the project's `docs/` folder (development plan, performance budget, network latency, tech stack).

This repository is at the start of Phase 0 and Phase 1 of the plan: foundations plus the early de-risking spikes. Spike write-ups are in [docs/spikes/](docs/spikes/).

## Run it

```sh
npm install
npm run dev        # IWSDK dev server + managed browser with an emulated Quest 3
npm test           # unit tests (simulation, perf stats)
npm run typecheck
npm run test:xr    # headless emulated-headset smoke test (screenshots in artifacts/)
npm run build      # static site in dist/
npm run lobby      # local crew lobby on port 8787 (the dev server proxies /parties to it)
npm run test:net   # two-player network test against the local lobby (run after build)
```

To play two-player locally, run `npm run lobby` next to `npm run dev`, then open the game in two browsers (or a browser and a headset) and use the crew panel in the top right: **New crew** makes a four-letter code and puts it in the address bar, and the other player types it and presses **Join**. The deployed lobby is a Cloudflare Worker; see [lobby/README.md](lobby/README.md).

Every push to `main` is built, tested and deployed to GitHub Pages by `.github/workflows/ci.yml`.

## Settings in the URL

Test builds are tuned from the address bar, so a headset can try variations without a rebuild. Defaults are in `src/settings.ts`.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `hz` | 90 | Requested refresh rate; the nearest supported rate at or below is used |
| `islands` | 30 | Floating islands (instanced, two levels of detail) |
| `clouds` | 40 | Cloud clusters (instanced) |
| `rain` | 0 | `1` adds instanced rain around the gondola |
| `shadows` | 0 | `1` adds one shadow-casting light limited to the gondola |
| `foveation` | 1 | Fixed foveated rendering, 0 (off) to 1 (maximum) |
| `fbscale` | 1 | WebXR framebuffer scale |
| `avatars` | 2 | Dummy crew avatars on the deck |
| `bricks` | 8 | Loose physics fuel bricks |
| `hud` | 1 | Show the perf HUD from the start |
| `motion` | still | Ship motion: `still`, `gentle`, `tour` or `lively` |
| `seed` | 1 | World generation seed |
| `room` | | Crew code to join on load, e.g. `room=KXQT` |
| `lobby` | | Lobby URL (`wss://...`); defaults to the build's `VITE_LOBBY_URL`, else the page's own server |
| `name` | | Your name as the crewmate sees it |
| `netlag` | 0 | Testing: extra delay on received packets, ms |
| `netjitter` | 0 | Testing: extra random delay, 0 to this many ms |
| `netloss` | 0 | Testing: fraction of received packets dropped, 0 to 1 |

Example: `?islands=60&clouds=80&rain=1&motion=tour`.

## Controls

- **Perf HUD:** on the left wrist in VR, toggled with the **X** button; in a desktop browser it is the box in the bottom right, toggled with **H**. It shows frames per second against the refresh rate, a frame-time graph (green on budget, amber close, red dropped), main-thread time, draw calls, triangles, JS heap and network round trip.
- **Perf CSV:** one row per second is recorded. After leaving VR, click **CSV** in the desktop HUD to download it, or run `__perf.download()` in remote DevTools.
- **P** pauses the ship's motion (desktop).
- Grab fuel bricks with the grip (squeeze) button.

## Testing on a headset

On Quest 3: open the GitHub Pages URL in the Quest Browser, press Enter XR, and check the HUD shows 90 Hz. For a local build, run `npm run dev`, connect the headset by USB with developer mode on, run `adb reverse tcp:8081 tcp:8081`, and open `https://localhost:8081/`. On the same Wi-Fi you can instead open the network URL from `npx iwsdk dev status` and accept the certificate warning.

On PC VR: make Meta Horizon Link the active OpenXR runtime, connect the Quest with Link or Air Link, and open the same URL in Chrome or Edge on Windows.

## How the code is laid out

```
iwsdk.config.json          IWSDK project config (scene, features, physics at 90 Hz)
public/scenes/             scene composition (gondola hull and rigging, welcome panel)
src/index.ts               world creation and system registration
src/settings.ts            URL settings
src/scene-assets/          procedural low-poly assets (gondola, avatar, merge helpers)
src/world/                 sky dome, islands and clouds
src/sim/                   engine-free simulation: ship motion, release velocity
src/net/                   lobby protocol, WebRTC session, pose packets, clock sync, jitter buffer
src/perf/                  frame statistics and CSV
src/systems/               ECS systems: frame rate, perf HUD, ship, sky, gondola, throws, network
lobby/                     crew lobby: Cloudflare Worker (deployed) and Node server (local)
test/                      unit tests (Vitest)
scripts/xr-smoke-test.mjs  emulated-headset test driven through the IWSDK CLI
scripts/net-test.mjs       two-player test in two browser profiles
```

Simulation code in `src/sim/` has no rendering or IWSDK imports, so the host's authoritative simulation could later move to a server if the plan needs it.

The gondola never moves in the player's tracking space. The world is drawn with the inverse of the ship's pose, and physics uses the felt gravity in ship space. See [docs/spikes/s2-moving-ship.md](docs/spikes/s2-moving-ship.md).

Players connect peer to peer over WebRTC after meeting in the lobby. See [docs/spikes/s4-networking.md](docs/spikes/s4-networking.md).

IWSDK conventions for this project are in [AGENTS.md](AGENTS.md).
