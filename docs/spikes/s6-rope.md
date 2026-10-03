# Spike S6, part 2: the hand-over-hand rope haul

Status: built and tested in the emulated headset and between two networked browsers with scripted hands, at clean and simulated 150 ms RTT. How it feels needs two people in headsets (steps at the end). Part 1, the crank, is in [s6-crank.md](s6-crank.md).

## How it works

- **The mooring line** comes aboard through a brass fairlead at the bow end of the port rail. It runs along the inside of the rail to the stern, where it drops to a coil on the deck. Outboard it runs off towards the dock. Red marker bands on the line show it moving.
- **Hauling.** Stand at the port rail and squeeze the grip within 10 cm of the line to take hold. Pull towards the stern, let go, reach forward with the other hand and repeat. The hand holds the bit of rope under it and pulls it like a stiff spring. Each player's total pull, from both hands together, is capped. The dock pulls the line back out with a steady load, so if nobody holds it, it runs out.
- **Solo vs crew.**
  - **One player** can haul alone, but only slowly, up to about 0.5 m/s. Pulling harder than that makes the line slip through their hands.
  - **Two players** can pull twice as hard.
  - **A heave:** when two players' strokes start within the 150 ms sync window, both pull 1.6 times harder for that stroke, the way crews heave together on a call. The sign says "HEAVE!" and the controllers give a double pulse.
- **What counts as a stroke.** Each grab can start one stroke, when the hand first pulls inboard briskly within 0.3 s of grabbing. If the line slips through a hand and the hand catches it again mid-pull, that doesn't count as a new stroke. Without this rule, slipping hands made ragged hauling look like heaves.
- **Latency.** As with the crank, every hand input carries the time the hand was there. It is measured against where the line was at that moment, and stroke starts are timed by the hand's own time, so a crewmate's delay doesn't spoil the rhythm.
- **Network.** The host runs the line and sends a 16-byte state 45 times a second. The guest predicts and blends towards it. A player's grip on the line travels in two more spare bits of the pose packet.
- **The sign** at the stern end of the run shows metres hauled out of 8 and the heave count, and "DOCKED!" when the whole line is in.

## Results in the cloud

| Test | Result |
| --- | --- |
| Emulated headset: squeeze on the line, pull the controller 0.5 m sternwards over 1.4 s, let go | Took hold; hauled 0.49 m; released |
| Unit tests (`test/rope-haul.test.ts`) | Short easy strokes haul alone without slipping. Hard solo pulling slips. Two in rhythm heave more than 10 times in 8 s and haul over twice as fast as one. Heaves still happen with the crewmate's hands 75 ms late. Strokes 250 ms apart never heave. Eight metres in docks the ship |
| Two browsers, clean link, scripted strokes of 0.5 m every 0.5 s | 11–12 heaves in 6 s and about 3–5 m hauled; the guest's line within 1 cm of the host's |
| Same, strokes 250 ms apart | 0 heaves, about 2–2.5 m hauled |
| Two browsers at about 150 ms RTT with jitter and 1% loss | 10–11 heaves in 6 s, about 2.5–4.8 m hauled |

## Findings

1. **A soft line feels mushy.** The first tuning (heavy line, soft hand spring) let the line lag the hand by a third of a metre and bounce. The line is now light and stiff, so it answers the hand within about a tenth of a second, and the weight comes from the capped pull against the dock's load.
2. **Stroke detection must ignore slips.** Detecting strokes from hand speed alone counted every slip-and-catch as a new stroke. Out-of-step hauling then "heaved" as often as in-step hauling. Tying strokes to fresh grabs fixed it.
3. **Scripted hands must be stamped when sent**, the same lesson as the crank. A scripted hand that has let go also has to stay put rather than jump back to the start of the line, or the crewmate sees a phantom pull.

## Headset tests (two people)

1. **Solo.** Alone, stand at the port rail, take the line and haul hand over hand. Note whether it feels like a heavy line: it should move, but slowly, and slip if you yank it.
2. **Together.** Both players stand at the port rail, one behind the other, and haul. Try calling "heave!" and starting strokes together: the sign should flash "HEAVE!" with a double pulse in the controllers, and the line should come in noticeably faster. Note how easy the rhythm is to find, and whether 150 ms feels too strict or too loose.
3. **With latency.** Repeat with `&netlag=60&netjitter=20&netloss=0.01` on both URLs, and between two homes.
4. **Dock.** Haul all 8 m in; the sign says "DOCKED!". Reload the page to start again.

## Tuning knobs

`DEFAULT_ROPE` in `src/sim/rope-haul.ts`:

- `load` (0.6) and `maxPlayerForce` (1) set how hard solo hauling is.
- `heaveBoost` (1.6) and `syncWindowMs` (150) set the reward for rhythm.
- `slipDistance` (0.25 m) sets how far a hand can get ahead of the line before it slips.
- `length` (8 m) is how much line must come in to dock.
