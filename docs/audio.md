# Ship sounds (Phase 2)

Every sound is made in the browser with Web Audio rather than recorded, so the download stays small (no audio files at all). The sounds are in `src/audio/ship-sounds.ts`; when they play and how loud is worked out in `src/sim/audio-cues.ts`, which has unit tests, and `src/systems/audio-system.ts` drives them from the ship's state every frame. `?audio=0` turns them off; the crewmate's voice is separate (`?voice=`).

| Sound | What it follows | How it's made |
| --- | --- | --- |
| Burner | Roars while the burner is lit; catches quickly and dies away a little slower | Looped noise through a band-pass (the breathy roar) over a low-passed rumble, placed at the burner |
| Wind | Louder and brighter with airspeed and climb; a faint breeze at rest | Looped noise through a low-pass whose cutoff rises from 250 Hz to about 1.6 kHz with speed |
| Timber creaks | Now and then at rest (about one every 15 s), up to about one a second while the gondola tilts, turns or changes speed at its limits, never closer than 0.6 s | A sliding sawtooth with a fast wobble through a narrow band-pass, at a random rail post or the load ring |
| Crank ratchet | One click per eighth of a turn, matching the haptic clicks | A 25 ms burst of high-passed noise at the crank |
| Ship's bell | Rung by hand (or N) | Four out-of-tune sine partials, each dying away at its own rate, like struck brass |
| Ring chime | A ring flown through | Two rising notes |
| Touchdown | The ship settling onto an island | A falling low thump, harder with a faster descent |

The gondola doesn't move in the player's tracking space, so each source stays where it is on deck and only the listener (the player's head) moves. Panning is equal-power rather than HRTF, which costs less on a headset and suits sounds this broad. Each player hears their own copy, driven by the ship state both already share, so nothing extra goes over the network.

Browsers only start audio after a click or key on the page, or on entering VR, so the sounds start then.

## Trying it

On a headset, with `?motion=flight`:

1. Drop a brick in the hopper: the burner roars, and goes quiet when its time runs out.
2. Turn the crank: the ratchet clicks at the bow, faster as you crank faster. Turn your head: the clicks stay at the crank.
3. Fly at speed and swing the tiller: the wind rises and the timbers creak more as the deck leans into the turn.
4. Fly through a ring for the chime, land on island B for the thump, and ring the bell.

What would help most from a headset run: whether any sound is too loud or tiring over a few minutes (the burner and wind especially), and whether the creaks sound like wood.
