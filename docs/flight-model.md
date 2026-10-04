# Flight model (Phase 2)

The crew flies the ship with `?motion=flight`. The scripted motion profiles (`still`, `gentle`, `tour`, `lively`) stay for comfort playtests. The model is in `src/sim/flight.ts`; it has no rendering or IWSDK code, so the host's simulation could move to a server.

## How the ship flies

| Control | Effect | Feel |
| --- | --- | --- |
| Burner | Heats the envelope. Holding height takes about 40% flame, so the crew feeds it in pulses. One fuel brick gives 20 s of full flame | Lift builds over tens of seconds; an untended ship sinks gently |
| Vent | Dumps hot air, about fifteen times faster than the envelope cools on its own | A quick descent, even with the burner lit |
| Ballast | Dropping a 20 kg sandbag lowers the heat the ship needs to float, at once | Instant lift; four bags per flight |
| Crank | The only thrust. Airspeed settles at 0.75 m/s per rad/s of crank speed over about 6 s | One player cranking gives about 2.4 m/s; two in step reach the 7 m/s limit |
| Rudder | Sets the turn rate, up to 6°/s at full rudder once the ship is moving at 3 m/s; a quarter of that standing still | Steering needs the crank |
| Wind | A gentle breeze of about 0.6 m/s that wanders slowly | The ship drifts if nobody cranks |

The gondola leans into turns and lifts its nose a little as it speeds up, as a basket hanging under an envelope does, so the deck's tilt cancels most of the push a turn or a speed change makes.

Trim: where the crew stands leans the deck by about 0.9° per metre each person is off-centre (towards the bow tips the nose down, towards starboard tips that side down). Both players at the bow tip it about 2° nose-down, one at each end keeps it level. A ship trimmed nose-down flies slightly downhill once it moves: about 0.25 m/s of descent at full speed with both at the bow.

## The gondola's controls

| Control | Where | How |
| --- | --- | --- |
| Burner | Mid-ship, starboard | Drop or throw a fuel brick into the hopper on top. Each brick gives 20 s of flame (up to 60 s stored); a fresh brick appears in the crate at the stern |
| Vent cord | Red cord hanging mid-ship, port side, with a wooden toggle at head height | Squeeze the grip on the toggle and pull it down; 30 cm opens the vent fully. It closes when let go |
| Tiller | The bar on the rudder post at the stern | Squeeze the grip on the handle and swing it. Like a boat's tiller, pushing it to starboard turns the ship to port. It stays where it is left |
| Ballast | Four sandbags hanging outside the starboard rail, stern end | Squeeze the grip on a bag to lift it off its hook and let go outside the rail to drop it. Let go inside the rail and it goes back on its hook |

The instrument board on the burner flue shows height, climb or descent, airspeed, burner time left and the sandbags left. A lantern hangs from the rigging near the stern; it hangs along the gravity the crew feels, so it shows which way the deck leans and swings when the ship turns or changes speed. Flames show in the hopper and at the envelope's mouth while the burner is lit.

With a crewmate, the vent opens as far as either player pulls it, and whoever holds the tiller steers (the host if both do). The guest's hands reach the host 20 times a second in a 9-byte packet; bricks burned and sandbags dropped are reliable events. Everyone sees the tiller, vent and bags as the host's ship state says, except a control in their own hand.

## Comfort limits

Whatever the crew does, the model caps the motion at the `tour` comfort profile until the S3 playtests set the real limits: 7 m/s airspeed, 0.4 m/s² change of speed, 6°/s turns (changing by at most 2°/s each second), 1.5 m/s climb (0.25 m/s² change), and 4° of tilt (3°/s change). They are `DEFAULT_FLIGHT_LIMITS` in `src/sim/flight.ts`, and a unit test drives every control back and forth for four minutes to check none is exceeded.

## Two players

The host flies the ship and sends its state 20 times a second (an 86-byte packet: position, heading, tilt, velocity, acceleration, turn rate, heat, airspeed, rudder, vent, burner time and ballast). The guest moves its own copy on at the host's velocity every frame and steers it gently onto the host's latest state, moved on by that state's age, so the sky neither stutters at the packet rate nor jumps when a packet is late. A disagreement of more than 25 m or about 30° snaps instead. The guest's B button (P on a keyboard) asks the host to stop or start the ship.

This applies to the scripted profiles too: before, each player's browser flew its own copy of the scripted path, so the two skies drifted apart.

Measured in the cloud test (`npm run test:net`, two browsers on one machine): the guest's ship stayed within 1.6 cm and 0.04° of the host's. Unit tests at 150 ms round trip with jitter and one packet in seven lost keep it within 30 cm and free of jolts.

## Trying it

On a headset, open the game with `?motion=flight`:

1. Throw or drop two fuel bricks from the crate into the burner's hopper. The flames light and the board's BURNER line counts down. After 20 to 30 s the board shows a climb.
2. Turn the crank and watch the islands start to slide past. With a crewmate cranking in step the ship reaches full speed.
3. Swing the tiller and watch the ship turn, the lantern swing and the deck lean into the turn.
4. Pull the vent cord down and hold it: the climb turns into a descent within a few seconds.
5. Lift a sandbag off its hook and let it go over the side: the climb picks up at once.
6. Walk to the bow, then the stern, and watch the lantern lean.

For two players, the host's page needs `?motion=flight`; the guest's ship follows whatever the host flies. On a desktop browser the keyboard stands in for the controls: **B** feeds the burner one brick, **V** held opens the vent, and **,** and **.** held swing the rudder.
