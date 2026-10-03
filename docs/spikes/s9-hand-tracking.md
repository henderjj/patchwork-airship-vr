# Spike S9: hand tracking

Status: built, unit-tested, and tested in the emulated headset with tracked hands. Whether gripping the crank and the line with real hands is reliable enough can only be judged on a headset (steps at the end). The plan's default until then: controllers first, hand tracking if this spike passes.

## What was built

- **Grip without a button** (`src/sim/hand-grip.ts`, `src/systems/grip-system.ts`). With hand tracking there is no grip button, so a tracked hand grips when it:
  - **makes a fist**: the average curl of the index, middle and ring fingers drops below 0.6 (1 is a straight finger, about 0.4 a closed fist), and lets go once it rises above 0.72; or
  - **pinches**: the thumb and index fingertips come within 2 cm, and lets go once they are 4 cm apart.
  The gap between the grip and release thresholds stops the grip flickering on and off. The joints come from WebXR's `fillPoses` into one reused buffer, so this adds no per-frame allocation.
- **One grip for everything.** The crank, the mooring line and the fuel bricks now read the grip from this system instead of the controller's grip button. A controller's grip button still works exactly as before, and both work if a player switches mid-session.
- **Tuning from the URL.** `?fist=0.65` changes the fist threshold and `?pinch=3` the pinch distance in cm (`?pinch=0` turns pinch-to-grip off), so thresholds can be tried on the headset without a rebuild.
- **On the wrist HUD**, when hands are tracked, a `hands` line shows each hand's curl and pinch gap, with a `*` while it grips. This is what to read when tuning.

## Results in the cloud

| Test | Result |
| --- | --- |
| Unit tests (`test/hand-grip.test.ts`) | A straight finger reads 1 and a fist 0.25–0.5. A fist grips and a half-relaxed hand doesn't; the grip holds between the thresholds and lets go when the hand opens. Pinch grips at 1 cm, holds at 3 cm and lets go at 5 cm |
| Emulated Quest 3 with tracked hands (pinching; the emulator's hands can't make a fist) | Pinch takes a crank handle, turning the hand turns the crank a full turn, and opening the pinch lets go. A pinching left hand hauls the line 0.49 m and lets go. A pinching hand lifts a brick off the deck. All 21 earlier checks still pass |

## Open questions for the headset

1. **Tracking loss.** When a hand is lost (hands overlapping, a hand outside the cameras' view, or fingers hidden behind the crank handle), the grip ends and the hand lets go. That is safe but may feel like dropping things. If it happens often while cranking, the fix is to keep a lost hand's grip for a short time.
2. **Fist or pinch.** A fist is natural for the crank and the line; a pinch is natural for picking up a brick but may trigger by accident. Try both and say which feels right.
3. **Throwing with hands.** A throw starts when the hand opens. Opening takes longer than letting go of a button, so throws may come out late or weak.
4. **No buttons.** With hands, the X (wrist HUD) and Y (mute) buttons don't exist. If hands are supported at launch, both need a gesture or a panel button.

## Headset tests

1. In the Quest Browser, open `https://henderjj.github.io/patchwork-airship-vr/` and enter XR. Put the controllers down; your hands appear after a moment.
2. **Crank.** Make a fist around a crank handle and turn it for a while, including fast. Say whether it ever lets go by itself, and whether it lets go cleanly when you open your hand.
3. **Line.** Haul the mooring line hand over hand with fists. Say whether each hand grabs and lets go when you expect.
4. **Bricks.** Pick a brick out of the crate with a pinch, then with a fist. Throw a few. Say whether the throws go where you aim.
5. **Tuning.** If grips start too early or too late, read the `hands` line on the wrist HUD while you make a loose fist and a tight fist, and tell me the numbers. Holding the controllers again brings the X button back to toggle the HUD.

Pass: the crank and the line can be worked with hands alone without accidental releases in normal use. Decision options: hands supported (hands and controllers equal), hands optional (works, but controllers recommended), or controllers only for launch.
