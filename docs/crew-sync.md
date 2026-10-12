# Keeping in step on the crank and the line

John's two-player playtest (2026-10-10, with a crewmate on an Oculus Rift) found that the pair could turn the crank together but couldn't tell how fast the other was cranking, and that hauling the mooring line together was hard to coordinate without feeling the line's resistance. Hands are drawn locked onto the crank handles and the line, so neither player can see who is pushing harder or lagging, and controllers can't push back like a real handle. The practice crewmate copies the player's crank hand exactly, so solo testing never showed it.

This adds cues to see, feel and hear the other player's effort. None of them changes the rules: high gear still needs both hands leading their handles by the same time within 150 ms, and a heave still needs both strokes to start within 150 ms. The sums are in `src/sim/crew-sync.ts` (unit tested in `test/crew-sync.test.ts`).

## The crank

- **Balance bar on the sign.** With both players on the crank, each page's sign shows that player's own balance against the crewmate's on a bar along its bottom: a green in-step zone in the middle (one sync window either side) and a marker that sits left when the crewmate is pushing harder and right when this player is. Above it the sign says "<< push harder" or "ease off >>" as soon as the balance drifts past 60% of the sync window (before the pair drops out of high gear), and "in step..." or "HIGH GEAR" otherwise. Each page draws its own copy, so the two players see opposite advice.
- **Advice in the hand.** "Push harder" is also a quick light flutter in the controller (the handle is pulling away from the hand); "ease off" is a slow heavy throb every 0.28 s (doing more than your share). The ratchet clicks, the high-gear double pulse and the out-of-step shudder are unchanged.
- **The balance** is the same measure the crank uses for sync (the difference between the two hands' leads over their handles, divided by the crank's speed), with a sign, smoothed over 0.2 s so the advice follows the pair's effort rather than each wobble of a hand. It needs a little hysteresis: advice starts at 60% of the window and stops inside 40%.

## The line

- **The haul call.** While both players have a hand on the line, a drum beats "heave" once a second at the hauling run, with a soft wooden tock on the off-beat to reach forward. It keeps time on the host's clock, which both pages share through clock sync, so both players hear each heave at the same moment whatever the network delay. Starting a stroke on the heave lands both strokes inside the 150 ms heave window. It keeps going for 2.5 s after one of the pair lets go, so it doesn't stop between strokes. A small lamp in a brass cup on the port rail top, halfway along the run, flashes on each heave and glows brighter towards the next; both controllers tick with the beat while the player is hauling.
- **The line's pull in the hand.** The creak while the line moves is replaced by a buzz that grows with how hard the hand pulls on the line (how far it is ahead of its bit of rope), steeply near the point where the line slips through, with a faint creak added while the line runs. A slack line lying still doesn't buzz. When the crewmate pulls too, the line comes in faster, the hand gets less far ahead of it and the buzz eases: the line goes light, as it does on a real haul.
- **The practice crewmate hauls on the call**: a stroke on every heave, hands in turn, beside the player's hands. A player who strokes on the call heaves with it; one who ignores the call heaves only by chance, as with a person. With no call to go by (before clock sync), it keeps time with the player's own strokes as before. It now waits 1.5 s, not 0.4 s, before deciding the player has let go of the line, because hauling on the call leaves both hands off it between strokes.

The haul call is shared with docking: it plays whenever two players haul the mooring line, including hauling the ship in to the post at island B. Docking's own rules (load, made fast, tear-off) are untouched.

## Results in the cloud

| Test | Result |
| --- | --- |
| Unit tests (`test/crew-sync.test.ts`, `test/crew-bot.test.ts`) | Equal effort reads even and reaches high gear; the harder pusher is told to ease off and the other to push; advice starts inside the window and doesn't flicker. The line's buzz grows with pull and is strongest just before a slip. Two pages with different local clocks get the same heaves; the call starts on the next half beat after the pair meet, alternates heave and reach, and stops 2.5 s after they part. The bot strokes on every heave, hands in turn |
| Two browsers, scripted hands cranking in step | Both signs read in step for every frame of the last second, in high gear |
| Two browsers, player hauling 0.5 s strokes on each heave with the practice crewmate | 7 heaves in 7 s, about 5.3 m hauled, call sounding |

## Headset check (two people, or one with the practice crewmate)

1. **Crank.** Each take a handle and crank. Glance at the sign: it should say "in step..." then "HIGH GEAR" with your marker in the green. Have one player push harder: they should see "ease off >>" and feel a slow throb, while the other sees "<< push harder" and feels a quick flutter. Do the bar and the buzz make it easier to settle into high gear and stay there?
2. **Line.** Both take the line. You should hear a drum "heave" once a second (and a soft tock between) and see the rail lamp flash. Start each stroke on the drum: the sign should flash "HEAVE!" most strokes. Pull hard alone and feel the buzz build before the line slips; then have the crewmate pull with you and feel it lighten.
3. **Say** whether the call's tempo (one heave a second) suits hand-over-hand hauling, and whether the buzzes are too strong, too weak or confusing.

## Tuning knobs

In `src/sim/crew-sync.ts`: `HAUL_CALL_PERIOD_MS` (1000, the call's tempo), `HAUL_CALL_LINGER_MS` (2500), the advice thresholds (60% on, 40% off), and the buzz curve in `ropeBuzz`. In `src/systems/crank-system.ts`: `BALANCE_SMOOTHING` (0.2 s) and the push/ease pulse gaps. The drum is `haulCall` in `src/audio/ship-sounds.ts`.

## Not done (would change the rules)

If the cues aren't enough: judge each player against the call rather than against each other (each stroke within, say, 100 ms of the heave), widen the sync windows, or let one player set the crank's pace with the other's handle following. These change how the game plays, so they wait for John's headset check.
