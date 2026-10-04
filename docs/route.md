# The route: "Calm skies" (Phase 2)

With `?motion=flight` the ship starts resting on island A, and the crew flies a short route: lift off, fly through two marker rings, and land on island B. The run is timed, and the board on deck shows a score at the end. The layout and rules are in `src/sim/route.ts` and `src/sim/islands.ts`; like the flight model, they have no rendering code.

## The course

| Point | Where | Notes |
| --- | --- | --- |
| Island A | The start, 120 m up | The ship rests on a plank pad with a green flag. While it waits there, the ground crew keeps the envelope just below floating heat, so one or two bricks lift it off within a few seconds |
| Ring 1 | 165 m ahead, 16 m higher | Red and cream stripes, 28 m across. It turns green once flown through |
| Ring 2 | 200 m on, about 35° to port, a little lower | |
| Island B | 170 m on, about 30° to port, below the start | A plank pad with a red flag, and a beacon mast whose lamp shows through the haze |

About 550 m in all: roughly three minutes with one player cranking, under two with both. Scenery islands are kept at least 45 m (plus their size) from the path.

## Rules

- **Ready check:** with a crewmate, the ship stays moored to island A, however hot the envelope, until both players have rung the bell there. The board shows who is ready, then "CAST OFF!". Solo, the ship casts off as soon as it has lift.
- **The clock starts** when the ship lifts off island A.
- **A ring counts** when the middle of the ship passes through it at least 4 m inside the rim, in either direction. Rings can be flown in any order.
- **The run finishes** after the ship has rested on island B for 3 seconds.
- **The run is lost** if the ship runs into an island's rock (resting on any island's top is fine), sinks below 40 m into the haze, or strays more than 450 m from the route. The ship stops where it is.
- **Restart** by ringing the ship's bell, on a bracket over the port bow corner (squeeze the grip on it). Mid-run it takes two rings within 3 seconds, so a knock doesn't throw a good run away. On a keyboard, **N** rings the bell.

The ship can now rest on any island: its keel settles on the grass, and while it rests it can't drift, turn or be cranked along; it needs lift to rise again. A heavily vented ship takes a minute or two of burning to recover.

## Score

1000 points, less 2 per second, 15 per fuel brick, 150 per missed ring, 10 per metre the ship stops from the middle of island B's pad, and 200 per m/s of touchdown faster than 0.6 m/s. Three stars from 600, two from 450, one from 250. The best score is kept in the browser.

These weights are a first guess, in `scoreRun()` in `src/sim/route.ts`.

## The board

The route board is on the bow side of the burner flue, back to back with the instrument board, facing the crank. Before lift-off it explains the route; in flight it shows the time, rings passed, the next target's distance, bearing (degrees to port or starboard of the bow) and height difference, and the fuel used; at the end it shows the score or why the run was lost.

## Cost

Measured in the emulated headset: showing the route adds about 8 draw calls and 2,600 triangles per eye (the two islands, two rings, the beacon, the bell and the route board), taking the scene to about 39 draw calls and 28,000 triangles per eye, well inside the budget of about 100 draw calls and 300,000 triangles. The route's pieces are hidden when the ship flies a scripted comfort profile.

## Two players

The host runs the route and sends its state (phase, rings, clock start, result) as a reliable event whenever it changes, and once a second while a guest is connected, so someone who joins mid-run catches up. The guest's bell asks the host to restart, or on island A says the guest is ready. Both browsers must use the same `?seed=` and `?islands=` (the defaults do), since the scenery islands are now things the ship can hit.

## Trying it

On a headset, open the game with `?motion=flight`:

1. Look over the side: the gondola rests on island A's pad. The route board (walk to the bow side of the burner) says "Waiting on island A" (with a crewmate, "Moored on island A": both ring the bell at the bow to cast off).
2. Drop a brick in the hopper. Within a few seconds the ship lifts off and the board's clock starts.
3. Crank and steer for ring 1 straight ahead. Fly through it and watch it turn green; the board then points to ring 2.
4. Fly through ring 2, then find island B by its beacon. Vent to come down onto it and wait 3 seconds: the board shows the score.
5. Ring the bell at the bow to fly again. Try running into an island's side, or venting down into the haze, to see a run lost.

What would help most from a headset run: whether the rings and island B are easy to find, whether the bell is easy to reach, whether landing feels gentle enough, and how long a run takes with one and two players.
