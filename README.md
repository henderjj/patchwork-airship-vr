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
| `speed`, `turn`, `climb`, `tilt`, `gust` | | Override one limit of the motion profile: cruise speed (m/s), peak turn rate (°/s), peak climb (m/s), peak tilt (°), gusts (m/s). The profile shows with a `*` in the logs, e.g. `motion=tour&tilt=2` |
| `comfort` | 0 | Ask for a comfort rating in VR every this many seconds, e.g. `comfort=60` (see [docs/spikes/s3-comfort.md](docs/spikes/s3-comfort.md)) |
| `label` | | A tag for the session (tester, variant) written into the perf and comfort CSVs |
| `seed` | 1 | World generation seed |
| `room` | | Crew code to join on load, e.g. `room=KXQT` |
| `lobby` | | Lobby URL (`wss://...`); defaults to the build's `VITE_LOBBY_URL`, else the page's own server |
| `name` | | Your name as the crewmate sees it |
| `netlag` | 0 | Testing: extra delay on received packets, ms |
| `netjitter` | 0 | Testing: extra random delay, 0 to this many ms |
| `netloss` | 0 | Testing: fraction of received packets dropped, 0 to 1 |
| `voice` | spatial | Crewmate voice: `spatial` (from their head), `plain` (not positioned) or `off` |
| `voiceloop` | 0 | `1` routes spatial voice through a local loopback so echo cancellation can hear it |
| `fist` | 0.6 | Tracked hands grip when the fingers' curl falls below this (1 straight, about 0.4 a fist) |
| `pinch` | 2 | Tracked hands also grip when thumb and index tips are closer than this, cm; `0` turns it off |

Example: `?islands=60&clouds=80&rain=1&motion=tour`.

## Controls

- **Perf HUD:** on the left wrist in VR, toggled with the **X** button; in a desktop browser it is the box in the bottom right, toggled with **H**. It shows frames per second against the refresh rate, a frame-time graph (green on budget, amber close, red dropped), main-thread time, draw calls, triangles, JS heap and network round trip. The last two lines describe this player's browser and headset runtime (`me`) and the crewmate's (`crew`); a `~` before the Hz means the rate was measured because the runtime didn't report it (see [docs/spikes/s8-pcvr.md](docs/spikes/s8-pcvr.md)).
- **Perf CSV:** one row per second is recorded. After leaving VR, click **CSV** in the desktop HUD to download it, or run `__perf.download()` in remote DevTools.
- **B** (right controller) or **P** (keyboard) stops the ship at once and starts it again.
- **Comfort question** (with `?comfort=60`): once a minute a sign asks how you feel from 0 (fine) to 20 (very sick). The right trigger raises the number, the left trigger lowers it, and **A** answers. After leaving VR, click **Comfort CSV** at the bottom left of the page to download the answers with the ship's peak motion for each minute.
- **Y** (left controller) or **Mic** on the crew panel mutes your microphone.
- **Fuel bricks:** squeeze the grip near a brick to pick it up and let go to throw it. With the grip already squeezed and the hand empty, a brick flying past within 20 cm is caught. Throwing to a crewmate works the same at up to 150 ms of network delay (see [docs/spikes/s7-throwing.md](docs/spikes/s7-throwing.md)).
- **Crank:** squeeze the grip near a wooden handle on the bow crank and turn it. Two players, one per handle, cranking in step shift it into high gear (see [docs/spikes/s6-crank.md](docs/spikes/s6-crank.md)).
- **Tracked hands:** put the controllers down and grip with a fist or a pinch wherever these controls say to squeeze the grip. The wrist HUD then shows a `hands` line for tuning (see [docs/spikes/s9-hand-tracking.md](docs/spikes/s9-hand-tracking.md)).
- **Mooring line:** squeeze the grip near the line along the port rail and haul it towards the stern hand over hand. Strokes started together by both players are heaves (see [docs/spikes/s6-rope.md](docs/spikes/s6-rope.md)).

## Testing on a headset

On Quest 3: open the GitHub Pages URL in the Quest Browser, press Enter XR, and check the HUD shows 90 Hz. For a local build, run `npm run dev`, connect the headset by USB with developer mode on, run `adb reverse tcp:8081 tcp:8081`, and open `https://localhost:8081/`. On the same Wi-Fi you can instead open the network URL from `npx iwsdk dev status` and accept the certificate warning.

On PC VR: make Meta Horizon Link the active OpenXR runtime, connect the Quest with Link or Air Link, and open the same URL in Chrome or Edge on Windows. Set-up steps are in [docs/spikes/s8-pcvr.md](docs/spikes/s8-pcvr.md).

## How the code is laid out

```
iwsdk.config.json          IWSDK project config (scene, features, physics at 90 Hz)
public/scenes/             scene composition (gondola hull and rigging, welcome panel)
src/index.ts               world creation and system registration
src/settings.ts            URL settings
src/scene-assets/          procedural low-poly assets (gondola, avatar, merge helpers)
src/world/                 sky dome, islands and clouds
src/sim/                   engine-free simulation: ship motion, world tiling, comfort log, release velocity, crank, rope haul, hand grip
src/net/                   lobby protocol, WebRTC session, packets, clock sync, jitter buffers, object ownership
src/perf/                  frame statistics and CSV, measured refresh rate, platform report
src/systems/               ECS systems: frame rate, perf HUD, platform report, grip (controllers and hands), ship, sky, comfort question, gondola, throws, network, crank, rope
lobby/                     crew lobby: Cloudflare Worker (deployed) and Node server (local)
test/                      unit tests (Vitest)
scripts/xr-smoke-test.mjs  emulated-headset test driven through the IWSDK CLI
scripts/net-test.mjs       two-player test in two browser profiles
```

Simulation code in `src/sim/` has no rendering or IWSDK imports, so the host's authoritative simulation could later move to a server if the plan needs it.

The gondola never moves in the player's tracking space. The world is drawn with the inverse of the ship's pose, and physics uses the felt gravity in ship space. See [docs/spikes/s2-moving-ship.md](docs/spikes/s2-moving-ship.md).

Players connect peer to peer over WebRTC after meeting in the lobby. See [docs/spikes/s4-networking.md](docs/spikes/s4-networking.md). Voice runs on the same connection; see [docs/spikes/s5-voice.md](docs/spikes/s5-voice.md). Loose objects are simulated by whoever last held them; see [docs/spikes/s7-throwing.md](docs/spikes/s7-throwing.md).

IWSDK conventions for this project are in [AGENTS.md](AGENTS.md).
