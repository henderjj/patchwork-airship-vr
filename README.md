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

To play two-player locally, run `npm run lobby` next to `npm run dev`, then open the game in two browsers (or a browser and a headset). How to play is chosen on the start screen, which stands in front of you when VR starts (and shows on the page itself in a browser without a headset): **Play solo**, **Solo with the practice crewmate**, **Start a crew** (makes a four-letter code to give a friend) or **Join a crew** (type their code on its keypad, or on the keyboard on a PC). In a crew it waits until your crewmate is aboard, then gets out of the way; **Play while waiting** doesn't wait. A link with `?room=CODE` joins that crew straight away. The page's small panel at the top right keeps what has to happen in the browser: **Enter VR** (use it if the browser's own Enter VR offer goes away, which Quest Browser does once a crew connects), and **Allow microphone**, so the permission prompt comes before VR rather than inside it; the microphone itself only turns on in a crew. See [docs/start-and-menu.md](docs/start-and-menu.md). The deployed lobby is a Cloudflare Worker; see [lobby/README.md](lobby/README.md).

Every pull request is tested and every push to `main` is tested and deployed to GitHub Pages by `.github/workflows/ci.yml`. How the tests are split and which to run while developing: [docs/testing.md](docs/testing.md).

## Settings

Settings that apply straight away are in the game menu, opened with **Y** on the left controller (or its menu button, where the browser passes it on) in VR, or **M** or **Game menu** on a PC page: coat colour, standing or seated play, character height, ship sounds, control labels, the perf HUD, frame rate, foveation and the comfort question, plus muting yourself or your crewmate in a crew, **Start beside B's post** to practise docking, **Send a gust now** and the wind's strength ([docs/wind.md](docs/wind.md)), the weather with **Lightning now** and **Flood the deck** ([docs/storms-and-night.md](docs/storms-and-night.md)), **Back to start screen** and **Exit VR**. Settings read once as the game loads (how the ship moves, the crewmate's voice, clouds, rain and shadows) are under **Start-up settings** on the page's panel: pick, then **Save and reload**. Both are kept in the browser; **Defaults** clears the start-up ones. Every setting can also be given in the address bar, which wins over the saved ones, so a headset can try variations without a rebuild. Defaults are in `src/settings.ts`.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `hz` | 90 | Requested refresh rate; the nearest supported rate at or below is used |
| `islands` | 30 | Floating islands (instanced, two levels of detail) |
| `clouds` | 40 | Cloud clusters (instanced) |
| `rain` | 0 | `1` shows the storm's rain round the gondola in any weather (the S1 stress test) |
| `weather` | clear | The weather a run is flown in: `clear`, `storm`, `night` or `nightstorm` (also in the game menu) |
| `shadows` | 0 | `1` adds one shadow-casting light limited to the gondola |
| `foveation` | 1 | Fixed foveated rendering, 0 (off) to 1 (maximum) |
| `fbscale` | 1 | WebXR framebuffer scale |
| `avatars` | 0 | Dummy crew avatars on the deck (for draw-call stress tests) |
| `bricks` | 8 | Loose physics fuel bricks |
| `hud` | 1 | Show the perf HUD from the start |
| `labels` | 0 | 1 keeps the signs on the controls shown; 0 shows them while A (or L) is held |
| `motion` | flight | Ship motion: `flight` (the crew flies the ship; see [docs/flight-model.md](docs/flight-model.md)), or `still`, `gentle`, `tour` or `lively` (scripted paths for comfort tests) |
| `speed`, `turn`, `climb`, `tilt`, `gust` | | Override one limit of the motion profile: cruise speed (m/s), peak turn rate (°/s), peak climb (m/s), peak tilt (°), gusts (m/s). The profile shows with a `*` in the logs, e.g. `motion=tour&tilt=2` |
| `audio` | 1 | The ship's sounds (burner, wind, timber creaks, crank ratchet, bell); `audio=0` turns them off. The crewmate's voice is separate (`voice`) |
| `wind` | 1 | The wind's strength (breeze, gusts, updrafts and downdrafts): `0` still air, `0.5`, `1`, `2` (also in the game menu) |
| `gusts` | 1 | `0` stops gusts coming on their own (the browser tests); the game menu's **Send a gust now** still sends one |
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
| `bot` | 0 | `1` makes this page the practice crewmate (see [Testing alone](#testing-alone-the-practice-crewmate)) |

Example: `?islands=60&clouds=80&rain=1&motion=tour`.

## Controls

- **Walking:** walk in your room, or push the left thumbstick to walk the deck the way you face; the right thumbstick snap turns 45° about your head. The thumbstick stops your head a quarter of a metre inside the rails, wherever you stand in your room (`src/sim/deck-walk.ts`).
- **Perf HUD:** on the left wrist in VR, toggled with the **X** button; in a desktop browser it is the box in the bottom right, toggled with **H**. It shows frames per second against the refresh rate, a frame-time graph (green on budget, amber close, red dropped), main-thread time, draw calls, triangles, JS heap and network round trip. The last two lines describe this player's browser and headset runtime (`me`) and the crewmate's (`crew`), then one line per controller with its trigger and grip and which touch sensors feel a finger; a `~` before the Hz means the rate was measured because the runtime didn't report it (see [docs/spikes/s8-pcvr.md](docs/spikes/s8-pcvr.md)).
- **Perf CSV:** one row per second is recorded. After leaving VR, click **CSV** in the desktop HUD to download it, or run `__perf.download()` in remote DevTools.
- **B** (right controller) or **P** (keyboard) stops the ship at once and starts it again. The guest's button stops the host's ship, which both players share.
- **Flying** (the default): drop fuel bricks into the burner's hopper for lift, pull the red vent cord down to descend, swing the tiller at the stern to steer (pushing it to starboard turns to port, like a boat), turn the crank for speed, and drop sandbags from outside the starboard rail for instant lift. The instrument board on the burner flue shows height, climb, speed, burner time and ballast; the lantern shows which way the deck leans. On a desktop keyboard, **B** feeds the burner one brick, **V** held opens the vent, and **,** and **.** held swing the rudder. See [docs/flight-model.md](docs/flight-model.md).
- **The route** (the default): lift off from island A, fly through two striped rings, then throw the grapple onto the mooring post on island B's jetty and haul the ship in until it is made fast, for a score ([docs/docking.md](docs/docking.md)). The route board on the bow side of the burner shows the clock, the way to the next ring and the score; the game menu's **Restart from island A** starts again. On the way, gusts push the ship sideways (the board warns of each one and streaks of air fly in from its side), an updraft lifts it and a downdraft sinks it ([docs/wind.md](docs/wind.md)). The game menu's **Practice → Weather** flies it in a storm (rain, murk, lightning and thunder, harder gusts, and a bilge filling with rainwater to pump out over the side with the pump at the starboard rail), at night (a dark sky with stars, and lamps on the route) or both ([docs/storms-and-night.md](docs/storms-and-night.md)). The bell at the port bow corner rings when you tug its lanyard to one side, which swings the clapper against the bell (tug it from side to side to ring it again and again), or press **N**. With a crewmate, the ship stays moored on island A until both have rung the bell. See [docs/route.md](docs/route.md).
- **Comfort question** (with `?comfort=60`): once a minute a sign asks how you feel from 0 (fine) to 20 (very sick). The right trigger raises the number, the left trigger lowers it, and **A** answers. After leaving VR, click **Comfort CSV** at the bottom left of the page to download the answers with the ship's peak motion for each minute.
- **Game menu:** **Y** on the left controller (or its menu button, ≡, where the browser passes it on) opens and closes it in front of you; nothing pauses while it is open. On a PC page, **M** or the **Game menu** button.
- **My microphone** in the game menu mutes your microphone; **Crewmate's voice** turns your crewmate's voice off for you. Every setting shows all its choices; pick one with the ray (see [docs/start-and-menu.md](docs/start-and-menu.md)).
- **Control labels:** signs saying what each control does show while **A** on the right controller (or **L** on a PC page) is held, or always with **Control labels: Always** in the game menu.
- **Fuel bricks:** squeeze the grip near a brick to pick it up and let go to throw it. With the grip already squeezed and the hand empty, a brick flying past within 20 cm is caught. Throwing to a crewmate works the same at up to 150 ms of network delay (see [docs/spikes/s7-throwing.md](docs/spikes/s7-throwing.md)).
- **Crank:** squeeze the grip near a wooden handle on the bow crank and turn it. One player cranking flies the ship at about 3.2 m/s, or 4.8 m/s playing alone. Two players, one per handle, cranking in step shift it into high gear and sprint at 7 m/s (see [docs/spikes/s6-crank.md](docs/spikes/s6-crank.md)).
- **Signs** on the burner, vent cord, bell, mooring line, ballast, tiller, crank and fuel crate say what each one does. The burner's fire glows behind its door grate while it burns.
- **Your hands** are drawn as gloves and sleeves in your coat colour (pick it in the game menu), holding the controllers or at your tracked hands; the controllers themselves aren't drawn. The fingers follow yours: lift your index finger off the trigger to point, let go of the grip for a flat hand, lift your thumb off the stick and buttons for a thumbs-up; your crewmate sees the same. While you hold the crank, the mooring line, the tiller, the vent cord or the bell lanyard, your hand is drawn closed on its handle, and it lets go if your real hand strays more than 25 cm from it. Without the controllers, tracked fingers pose the hands directly. In VR the wrist HUD shows what each controller's touch sensors report, one line per hand (see [docs/hands.md](docs/hands.md)).
- **Tracked hands:** put the controllers down and grip with a fist or a pinch wherever these controls say to squeeze the grip. The wrist HUD then shows a `hands` line for tuning (see [docs/spikes/s9-hand-tracking.md](docs/spikes/s9-hand-tracking.md)).
- **When the crewmate can't play** (headset off, Meta button, headset asleep, network down, tab closed), the ship stops and a sign in front of you says why; it carries on when they're back. A dropped connection reconnects by itself (see [docs/spikes/s10-session-lifecycle.md](docs/spikes/s10-session-lifecycle.md)).
- **Mooring line and grapple:** the grapple on the line's end hangs on a hook at the port bow; squeeze on its shank to take it and throw it overhand (at island B's mooring post). Squeeze the grip near the line along the port rail and haul it towards the stern hand over hand. Strokes started together by both players are heaves (see [docs/spikes/s6-rope.md](docs/spikes/s6-rope.md) and [docs/docking.md](docs/docking.md)).

## Testing on a headset

On Quest 3: open the GitHub Pages URL in the Quest Browser, press Enter XR, and check the HUD shows 90 Hz. For a local build, run `npm run dev`, connect the headset by USB with developer mode on, run `adb reverse tcp:8081 tcp:8081`, and open `https://localhost:8081/`. On the same Wi-Fi you can instead open the network URL from `npx iwsdk dev status` and accept the certificate warning.

On PC VR: make Meta Horizon Link the active OpenXR runtime, connect the Quest with Link or Air Link, and open the same URL in Chrome or Edge on Windows. Set-up steps are in [docs/spikes/s8-pcvr.md](docs/spikes/s8-pcvr.md).

## Testing alone: the practice crewmate

The crank's high gear, heaving the mooring line and throwing to each other need two players. To try them alone, choose **Solo with the practice crewmate** on the start screen in the headset. It starts a crew and shows its code and a link: open the link on a PC, or open the game on the PC, choose **Join a crew**, type the code and press **Join as practice crewmate**. (`?bot=1` in the address does the same.) The PC page then plays the second player, with no microphone:

- On island A it rings the bell once you have, so the ship casts off.
- When you take a crank handle, it walks to the other one and turns in step with you, so the crank clicks into high gear.
- When you haul the mooring line, it hauls beside you. After your first two strokes it has your rhythm and starts each stroke with yours, so you heave together.
- Approaching a narrow passage in the rock, it goes to the bow, looks out and calls the way through (up, down, port, starboard or steady) with a whistle and a bubble over its head ([docs/passages.md](docs/passages.md)).
- With water in the bilge (25 litres or more, in a storm or after Practice → Flood the deck), it works the bilge pump until it is nearly dry; with 60 litres it pumps rather than crank ([docs/storms-and-night.md](docs/storms-and-night.md)).
- Otherwise it stands at the bow (or the stern, if you're at the bow) facing you. Throw a brick near its hand and it catches it, then throws it back to your chest.

Keep the PC page showing: a hidden tab counts as a crewmate who stepped away and pauses the ship. Opening the game again without the link's `bot=1` makes the page a player again. The code is `src/systems/crew-bot-system.ts`; `npm run test:net` checks all four against a scripted player (`ONLY_BOT=1` runs just those).

## How the code is laid out

```
iwsdk.config.json          IWSDK project config (scene, features, physics at 90 Hz)
public/scenes/             scene composition (gondola hull and rigging, start screen, game menu)
public/ui/                 the start screen and game menu panels (UIKitML)
src/index.ts               world creation and system registration
src/settings.ts            URL settings
src/live-settings.ts       settings the game menu changes while playing
src/game-flow.ts           the start screen's and game menu's words (solo or crew)
src/scene-assets/          procedural low-poly assets (gondola, avatar, posed hands, merge helpers)
src/world/                 sky dome, islands and clouds
src/sim/                   engine-free simulation: deck walking, ship motion, flight model, gondola controls and trim, world tiling, comfort log, release velocity, crank, rope haul, docking, hand grip, finger poses
src/net/                   lobby protocol, WebRTC session and reconnection, packets, clock sync, jitter buffers, object ownership, crew presence, following the host's ship
src/perf/                  frame statistics and CSV, measured refresh rate, platform report
src/systems/               ECS systems: deck walking, frame rate, perf HUD, platform report, grip (controllers and hands), ship, sky, comfort question, gondola, flight controls, throws, network, own hands, control signs, crew status sign, crank, rope, grapple, start screen, game menu
lobby/                     crew lobby: Cloudflare Worker (deployed) and Node server (local)
test/                      unit tests (Vitest)
scripts/xr-smoke-test.mjs  emulated-headset test driven through the IWSDK CLI
scripts/net-test.mjs       two-player test in two browser profiles
```

Simulation code in `src/sim/` has no rendering or IWSDK imports, so the host's authoritative simulation could later move to a server if the plan needs it.

The gondola never moves in the player's tracking space. The world is drawn with the inverse of the ship's pose, and physics uses the felt gravity in ship space. See [docs/spikes/s2-moving-ship.md](docs/spikes/s2-moving-ship.md).

Players connect peer to peer over WebRTC after meeting in the lobby. See [docs/spikes/s4-networking.md](docs/spikes/s4-networking.md). Voice runs on the same connection; see [docs/spikes/s5-voice.md](docs/spikes/s5-voice.md). Loose objects are simulated by whoever last held them; see [docs/spikes/s7-throwing.md](docs/spikes/s7-throwing.md).

IWSDK conventions for this project are in [AGENTS.md](AGENTS.md).
