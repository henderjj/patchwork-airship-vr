# Flight model (Phase 2)

The crew flies the ship with `?motion=flight`. The scripted motion profiles (`still`, `gentle`, `tour`, `lively`) stay for comfort playtests. The model is in `src/sim/flight.ts`; it has no rendering or IWSDK code, so the host's simulation could move to a server.

## How the ship flies

| Control | Effect | Feel |
| --- | --- | --- |
| Burner | Heats the envelope. Holding height takes about 40% flame, so the crew feeds it in pulses. One fuel brick gives 20 s of full flame | Lift builds over tens of seconds; an untended ship sinks gently |
| Vent | Dumps hot air, about fifteen times faster than the envelope cools on its own | A quick descent, even with the burner lit |
| Ballast | Dropping sandbags lowers the heat the ship needs to float, at once | Instant lift (sandbags arrive with the gondola controls) |
| Crank | The only thrust. Airspeed settles at 0.75 m/s per rad/s of crank speed over about 6 s | One player cranking gives about 2.4 m/s; two in step reach the 7 m/s limit |
| Rudder | Sets the turn rate, up to 6°/s at full rudder once the ship is moving at 3 m/s; a quarter of that standing still | Steering needs the crank |
| Wind | A gentle breeze of about 0.6 m/s that wanders slowly | The ship drifts if nobody cranks |

The gondola leans into turns and lifts its nose a little as it speeds up, as a basket hanging under an envelope does, so the deck's tilt cancels most of the push a turn or a speed change makes. Where the crew stands will add a small lean once trim arrives with the gondola controls.

## Comfort limits

Whatever the crew does, the model caps the motion at the `tour` comfort profile until the S3 playtests set the real limits: 7 m/s airspeed, 0.4 m/s² change of speed, 6°/s turns (changing by at most 2°/s each second), 1.5 m/s climb (0.25 m/s² change), and 4° of tilt (3°/s change). They are `DEFAULT_FLIGHT_LIMITS` in `src/sim/flight.ts`, and a unit test drives every control back and forth for four minutes to check none is exceeded.

## Two players

The host flies the ship and sends its state 20 times a second (a 70-byte packet: position, heading, tilt, velocity, acceleration, turn rate, heat and airspeed). The guest moves its own copy on at the host's velocity every frame and steers it gently onto the host's latest state, moved on by that state's age, so the sky neither stutters at the packet rate nor jumps when a packet is late. A disagreement of more than 25 m or about 30° snaps instead. The guest's B button (P on a keyboard) asks the host to stop or start the ship.

This applies to the scripted profiles too: before, each player's browser flew its own copy of the scripted path, so the two skies drifted apart.

Measured in the cloud test (`npm run test:net`, two browsers on one machine): the guest's ship stayed within 1.6 cm and 0.04° of the host's. Unit tests at 150 ms round trip with jitter and one packet in seven lost keep it within 30 cm and free of jolts.

## Trying it

Until the gondola's controls work, a keyboard stands in for them on a desktop browser: **B** feeds the burner one brick, **V** held opens the vent, and **,** and **.** held swing the rudder. The crank works in VR as before and now drives the ship.

On a headset: open the game with `?motion=flight`, turn the crank and watch the islands start to slide past; crank with a crewmate in step and the ship reaches full speed. For two players, the host's page needs `?motion=flight`; the guest's ship follows whatever the host flies.
