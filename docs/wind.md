# Wind (Phase 3)

From the concept: "Gusts push the ship sideways; correct with rudder and crank together", and "Updrafts and downdrafts, shown as shimmer or cloud streaks, to ride or fight". On the difficulty curve, wind is step 4: "gusts and drafts interrupt procedures". The development plan asks for "gusts, updrafts and downdrafts with readable visuals". This first slice adds gusts that come at different times each run, one updraft and one downdraft at fixed places on the route, a way to see each of them coming, and a Practice button that sends a gust at once.

## How it plays

1. **The breeze** is as before: about 0.6 m/s, wandering slowly, so an uncranked ship drifts.
2. **Gusts.** Once the ship has lifted off island A, the first gust comes 25 to 40 seconds later, and after each one dies away there is a calm of 30 to 50 seconds before the next. Each run draws its own, so a route can be learned but the gusts can't. A gust comes from abeam of the ship (from port or starboard, give or take about 23°) as it heads when the gust is on its way, and blows the ship sideways: it builds up over 6 s, holds for 4 to 8 s at 1 to 1.6 m/s, and dies away over 6 s. Unopposed, that carries the ship 10 to 20 m sideways, which is enough to miss a ring (the rings leave about 10 m either side of the middle) or swing the ship off its line to B's post. One player cranking makes 2.4 m/s, so against a gust one player can only crab slowly across it: the crew turns into it and cranks together, which is the concept's "rudder and crank together". While made fast at B the line holds the ship, but the crate on the cargo line swings with it.
3. **Seeing a gust coming.** Five seconds before a gust blows, its front shows as white streaks of moving air across the sky upwind, flying towards the ship and on past it while it blows. The route board's bottom line turns red: GUST COMING FROM STBD (or PORT, AHEAD, ASTERN), then GUST FROM STBD! while it blows. The wind's noise swells as it arrives, louder and brighter the harder it blows, and the timbers creak as the gondola leans.
4. **How it feels on deck.** The ship takes up a gust's push gradually, as a big envelope does (at most 0.3 m/s², so a gust's push changes the ship's motion more gently than the crank can), and the gondola leans with it like a basket swung on its ropes: up to about 1.7°, starboard side down when pushed to starboard. The lantern swings and loose bricks feel the push.
5. **Updrafts and downdrafts.** Calm skies has two, fixed in the world so the crew can learn them:
   - **An updraft** on the way to ring 1, a little to starboard of the straight line (6 m off it, 16 m across at full strength, fading out over 8 m beyond). It lifts the ship at 1 m/s. Ring 1 is 16 m higher than island A; crossing the updraft with one player cranking lifts the ship about 12 m without a brick. It shows as warm gold streaks rising in a column, with a puffy cloud on top, as over a real thermal, so it can be seen from far off.
   - **A downdraft** on the straight line between the rings, 18 m across. It sinks the ship at 0.9 m/s. Fly straight through and the ship comes out several metres lower, which can put it under ring 2 (which is already a little lower than ring 1); burn early, or fly round it. It shows as slate blue streaks falling in a column.
   - Both run from 95 m to 170 m up (the route flies at 108 to 136 m). The ship takes up a draft's rise or fall at most 0.2 m/s², so flying in at full speed it eases in over a few seconds. The draft carries the ship without changing the envelope's heat, so the burner does the same job inside as outside: what changes is the climb. The board's bottom line says UPDRAFT ▲ 1.0 m/s or DOWNDRAFT ▼ 0.9 m/s while the ship is in one.
6. **Drift.** When neither of those is showing and the ship is drifting sideways over the ground at more than 0.6 m/s (after a gust, or with the breeze across the bow), the board says so: DRIFT 0.8 m/s PORT.
7. **Wind socks** stand on island A, across the pad from its flag, and on island B beside where the jetty leaves the island. Red and white, they point downwind, droop in light air (about 35° in the usual breeze) and stream straight out in a gust. At B, the sock shows what a gust is about to do to a ship coming in to the post.

## The wind setting

The game menu's **Practice → Wind** (Off, Half, Normal, Double) scales all of it: the breeze, the gusts' strength and the drafts. Off is still air with no gusts or drafts. At Double a gust blows at 2 to 3.2 m/s, stronger than one player can crank; at Half, 0.5 to 0.8 m/s. In a crew the host's choice counts, and the guest's board, streaks and sounds follow it.

## Practice

**Practice → Gusts: Send a gust now** sends a gust on its way at once, from abeam of the ship as it heads: the streaks and the board's warning show straight away, and it blows five seconds later. The automatic gusts carry on as well. In a crew, the guest's press asks the host (a `wind-gust` event). Practice → Docking or Cargo, then a gust, tries holding the ship on the line in one.

## Under the hood

- **`src/sim/wind.ts`** (engine-free): `WindSim`, the host's gusts (when the next one comes, which way and how hard, from a seed drawn fresh each run), each gust's build-up, hold and dying away (`gustStrength`), and `draftAt`, the vertical air at a point from the route's drafts.
- **`src/sim/flight.ts`**: the flight controls carry the gust's push (`gustX`, `gustZ`, world m/s) and the draft (`draft`, up m/s); `FlightSim` takes them up gradually (`gustFollow` 0.3 m/s², `draftFollow` 0.2 m/s²), adds them to the breeze and the climb, and leans the gondola with the gust's push the same way it banks into turns. `windX`/`windZ` are the wind blowing now (breeze and gust), which the crate's swing feels (`src/systems/cargo-system.ts`). The comfort caps on climb and tilt still hold.
- **`src/sim/route.ts`**: `Route.drafts`, with Calm skies' two.
- **`src/systems/ship-system.ts`**: on the host or solo, steps the gusts while the run is under way and passes the gust and draft to the flight model each frame.
- **`src/systems/wind-system.ts`**: draws the streaks, the updraft's cloud and the wind socks in the world, which moves with the ship like the sky. Each draft has 64 streaks; a gust's front has up to 48 at a time, spawned 30 to 46 m upwind and flying at 10 m/s, so the first reach the ship as the gust starts to blow. Streaks within 3.5 m of the ship's middle are hidden so none passes through the deck or a face.
- **`src/systems/route-system.ts`**: the board's wind line. **`src/sim/audio-cues.ts`**: `windSound` swells with a gust.
- **Network.** The host sends the gust (seven numbers: a count, when it starts to blow in ship time, heading, peak, build-up, hold, dying away) and its wind setting with the route event, straight away when a gust is on its way and once a second anyway, so a late joiner sees it. The guest's ship time follows the host's, so its streaks, board and sound line up with the push the host's ship shows. The drafts are part of the route, so nothing is sent for them.

## Cost

While flying: eight draw calls (two draft columns, the updraft's cloud, the gust streaks, two wind sock poles and two socks) and about 3,500 triangles, all transparent streaks drawn without writing depth. The streaks' instance matrices are written in place each frame (128 for the drafts, up to 48 for a gust); nothing is allocated per frame. A draft more than 400 m away isn't drawn.

## Tests

- Unit tests (`test/wind.test.ts`): a gust builds up smoothly, holds and dies away; gusts wait for lift-off, then come one after another, the first 25 to 40 s in, with at least 30 s of calm between, each from abeam, from both sides over a run; a fresh seed draws different gusts; none come in still air or with gusts turned off; Practice's gust warns for five seconds and blows at the wind setting; the guest takes the host's gust and ignores a repeat; a gust swells the wind's noise. Drafts are full strength inside, fade over 8 m, and stop above and below the column; Calm skies' drafts lie across its straight line at its height and are clear of the islands and rings. In the flight model: a 2 m/s crosswind gust carries an uncorrected ship more than 15 m sideways, no faster than 0.3 m/s², leaning it 0.5° to 2° the right way with the felt gravity still under the feet; steering into it with both players cranking holds the ship within 5 m of its line (one player alone can't); an updraft lifts and a downdraft sinks a ship at floating heat, taken up no faster than 0.2 m/s²; a ship resting on an island isn't blown off; and slamming every control and gusts and drafts back and forth for four minutes stays within the comfort caps. `test/flight.test.ts` still passes unchanged.
- Geometry (`test/z-fighting.test.ts`): the wind sock and its pole, at full droop and straight out, and both kinds of streak.
- Emulated headset (`npm run test:xr`): the menu's Practice gust shows GUST COMING on the board and streaks in the sky, then pushes the ship across the bow with the board saying GUST FROM, the wind louder and the socks streaming out; the updraft lifts the ship and the downdraft sinks it with the board saying which. Screenshots: `xr-wind-gust.png` (looking upwind at a gust's front), `xr-wind-updraft.png` (the updraft and its cloud from 50 m off). The other checks run with the automatic gusts off (`window.__wind.setAuto(false)`), so a gust doesn't push them about.
- Two players (`npm run test:net`, which loads both pages with `gusts=0`): the guest's Practice gust is sent by the host and both boards warn of it.

## Headset check

1. Restart from island A (game menu → Run → Restart from island A), with Practice → Wind on Normal.
2. Before lifting off, look at the wind sock across the pad from the green flag: it should droop a little and point downwind.
3. Lift off and crank for ring 1. Ahead and a little to starboard, look for a column of gold streaks rising under a puffy cloud. Fly through it: the board's bottom line says UPDRAFT and the ship climbs without a brick.
4. Open the game menu (Y) → Practice → Gusts: Send a gust now. Within a second the board's bottom line turns red (GUST COMING FROM …) and white streaks come across the sky from that side. Five seconds later the wind rises and the ship starts sliding sideways; the lantern swings a little and the deck leans. Turn into it with the tiller and crank to hold your line to ring 1.
5. After ring 1, look along the way to ring 2 for a column of slate blue streaks falling: the downdraft. Fly through it and watch the ship sink (the board says DOWNDRAFT), or burn early, or go round.
6. Gusts also come on their own every half minute or so. Try docking at B with one blowing (watch B's wind sock), and lowering the crate.
7. With a crewmate: both should see the same gust's streaks and board warning at the same time.

What would help: whether the streaks read as moving air and are easy to see coming (and whether they bother you when they fly past); whether a gust feels strong enough to matter but fair to correct; whether the lean and the sideways slide are comfortable; whether the updraft and downdraft are easy to spot and worth riding or avoiding; and whether gusts every half minute are too often or too rare.

## Later

- Gusts that also swing the bow round (the envelope weathervanes), and a gust's front reaching the bow before the stern.
- Rough air in the lee of islands, sinking air off their edges, and drafts at the islands where docking happens.
- Drafts and gust strength set per route, so later routes on the difficulty curve get windier; gusts timed to arrive during docking or cargo work.
- A controller buzz as a gust arrives, and clouds that drift with the wind.
- The practice crewmate calling out a gust it sees coming.
