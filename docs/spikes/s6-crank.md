# Spike S6, part 1: the two-person crank

Status: the crank is built and tested in the emulated headset and between two networked browsers with scripted hands, at clean and simulated 150 ms RTT. Whether it feels solid can only be judged by two people in headsets (steps at the end). The hand-over-hand rope haul, the second half of S6, comes next.

## How it works

- **The crank** sits on the pedestal at the bow. It is an axle across the gondola with a handle at each end, half a turn apart. The two players stand side by side behind it facing forward: the left player takes handle 0 and the right player handle 1. To take a handle, squeeze the grip within 12 cm of it, and let go to release. Turning the top of the crank towards the bow drives the ship forward.
- **Simulation** (`src/sim/crank.ts`, engine-free). Each hand on a handle pulls it like a stiff spring, but only up to a maximum force, because a player can only push so hard. The propeller loads the crank with drag that grows with the square of its speed, so one player alone tops out at about half a turn a second. If the hand gets more than about 22 cm ahead of or behind its handle, it slips off.
- **Sprinting together.** When the two handles are held by different players and their hands lead their handles by the same amount of time, within the 150 ms sync window, the crank shifts into "high gear" over 0.4 s. In high gear the propeller load drops so that two players reach about three times the solo speed, roughly 1.4 to 1.5 turns a second. One player holding both handles never gets high gear. If one player's hand trails while the other's leads, they pull against each other: the crank slows, the controllers shudder and the sign says "out of step!".
- **Latency.** Each hand input carries the local time the hand was there. The crank keeps a short history of its own angle, so the crewmate's hand, which arrives late, is compared against where the crank was at that moment. Their rhythm is judged fairly and the delay itself isn't counted against them.
- **Network** (`src/systems/crank-system.ts`). The host runs the authoritative crank, using its own hands now and the crewmate's hands as they arrive in the pose packets (two spare flag bits say which hand holds the crank). It sends a 15-byte crank state 45 times a second. The guest runs the same simulation as a prediction, so the handle answers its own hand immediately, and blends 12% per frame towards the host's state, moved forward by the state's age.
- **Feedback.** The controller gives a ratchet click every eighth of a turn, stronger under strain. High gear engaging gives a double pulse, and pulling out of step makes it shudder. The brass-framed sign above the axle shows turns per second and the gear.

## Results in the cloud

| Test | Result |
| --- | --- |
| Emulated headset: squeeze at the handle, move the controller round a circle, let go | Handle taken by the right hand, crank turned exactly one turn, released on letting go |
| Unit tests (`test/crank.test.ts`) | Solo cranking is steady at a comfortable pace. One player can't sprint (the handle slips). Two in sync reach over 2.6 times the solo top speed. One player on both handles gets no high gear. Sync still holds with the crewmate's hand 75 ms late. Hands 250 ms out of step never reach high gear |
| Two browsers, clean link, scripted hands speeding up to 1.35 turns/s | High gear on the host for 100% of the last second, at 2.7 times the solo top speed. Guest crank within 1–5° of the host's |
| Same with hands 250 ms out of step | No high gear; hands slip off |
| Two browsers at about 150 ms RTT with jitter and 1% loss | High gear for 100% of the last second, at 1.35 turns/s. Guest crank within 9–19° of the host's |

## Findings

1. **The crank must be stepped in fixed small steps.** The first version clamped a slow frame's time step, so under load the crank fell behind real time and the hands slipped. It now takes as many 1/90 s steps as the frame needs.
2. **Clock sync has to restart for each new crewmate.** When the host left and someone else joined, the old clock offset (from a different browser's clock) stayed in use, so every timestamp from the new player was misplaced. This is a bug in S4's networking and its fix belongs on that pull request too. Sync also needs a few pings to settle after joining.
3. **"Driving" needs a little tolerance.** Requiring both hands to be strictly ahead of their handles kept high gear from engaging, because a hand right at its handle wobbles either side. A hand up to 0.15 rad (3 cm) behind still counts.
4. **The guest's view drifts further from the host's at 150 ms RTT** (up to about 19° at 1.35 turns/s). This is the gap the plan's "visual blending" question is about. It's small next to a handle's 22 cm reach, but on a headset, check whether your own hand and the handle seem to part company.
5. **Sprint speed is at the edge of the force limit.** At 1.4 turns/s both hands are pushing at full strength, which is the intended sprint feel. Scripted hands that push past it slip off. Real hands follow the handle, so this should feel like a hard ceiling, not a slip. That needs confirming in a headset.

## Headset tests (two people)

1. **Solo feel.** Alone, take a handle (squeeze the grip near the wooden handle) and crank. The sign should settle around 0.4–0.5 turns/s, with a light ratchet click in the controller. Try to crank faster: the handle should feel heavy, and eventually it slips out of your hand.
2. **Sprint together.** Each player takes one handle, standing side by side. Crank slowly together, then speed up. When you're in step, the sign says "in step..." and then "HIGH GEAR", and both controllers give a double pulse. See whether you can hold high gear at 1.2 turns/s or more, and how easy it is to find the rhythm.
3. **Out of step.** Deliberately crank at different speeds. The sign should say "out of step!" and the controllers should shudder.
4. **With latency.** Repeat test 2 with `&netlag=60&netjitter=20&netloss=0.01` added to both players' URLs, and between two homes. Say whether the crank still feels solid or whether the handle seems to lag or jump. Note which.

Pass (from the plan): playtesters reach sprint speed together at 150 ms RTT, say the crank feels solid, and see no jitter. Fail plan: widen the window, add a visible beat, or drop simultaneous holds for this station.

## Tuning knobs

All in `DEFAULT_CRANK` in `src/sim/crank.ts`: `syncWindowMs` (150), `syncDragDivisor` (4.5, which sets the sprint multiple), `maxTorque` and `drag` (solo top speed), `slipAngle` (1.0 rad), `syncRampSeconds` (0.4). The guest's blend rate is `BLEND_RATE` in `src/systems/crank-system.ts`.
