# Spike S2: the ship as a moving frame of reference

Status: **built and passing in the emulated headset; needs a headset session.** Started 2026-10-03.

## Question

Can players stand, walk, grab, toss and catch on a gondola that flies, turns, climbs and tilts, with IWSDK's locomotion, grabbing and Havok physics, without jitter or objects lagging behind the deck?

## Approach chosen: the ship stays still, the world moves

The plan listed this as the fallback; it turned out to be the simplest first choice, so it became the plan of record.

- The gondola sits at the world origin and never moves in the player's tracking space. IWSDK's locomotion, grabbing and physics all run in a static frame, which is what they were built for.
- `ShipSystem` advances the ship's world pose (position, heading, pitch, roll) and `SkyWorldSystem` draws everything outside the gondola (islands, clouds, sun) under a root object set to the inverse of that pose. The sky dome only rotates.
- Physics uses the **felt gravity** in ship space: true gravity minus the ship's acceleration, rotated into the ship frame (`updateFeltGravity` in `src/sim/ship-motion.ts`). IWSDK 1.0.1 exposes world gravity as a system config signal (`PhysicsSystem.config.gravity`), and changing it posts a `set-gravity` message to the Havok worker. We only send it when it moves by more than 0.01 m/s².
- Comfort: the deck never moves relative to the player's feet; only the horizon tilts and the world passes.

## Findings so far (emulator, 2026-10-03)

1. **Havok puts resting bodies to sleep, and a gravity change alone does not wake them.** A brick on the deck ignored a 60° tilt. Fix: when the felt gravity moves by more than 0.05 m/s², `ShipSystem` gives every loose dynamic body a negligible impulse (1e-5 N·s through `PhysicsManipulation`), which wakes it. Verified: at 40° the brick slides to starboard and stops against the wall.
2. **With normal friction, bricks don't slide at the few degrees of tilt the design allows.** Sliding needs tan(tilt) > friction; at friction 0.6 that is about 30°. Cargo that slides with trim therefore needs either low-friction cargo or a game-logic "slide" force, decided in Phase 3 (trim and cargo). Felt gravity is still right for anything airborne or rolling.
3. **IWSDK's held-object physics misbehaves when the physics worker takes several steps in one rendered frame.** IWSDK drives a held body with a target transform once per rendered frame, but the worker may take up to four fixed steps per frame, and only the first sees the target. In the emulator (15 fps) a brick held still had −6 m/s of velocity, was flung at 13 m/s on release, and once ended up under the deck. On a Quest at 90 Hz this would happen after any dropped frame. Fix: `ThrowSystem` (since spike S7 part of `ThrowablesSystem`) records the held object's positions, and on release puts the body back where the player sees it and sets its velocity from the least-squares slope of the last 80 ms of hand motion (capped at 12 m/s). This also gives the network layer the release velocity it needs for spike S7. Physics now steps at 90 Hz to match the display.
4. **Locomotion collides with every mesh tagged `LocomotionEnvironment`.** With the burner flue and ropes in the same mesh as the deck, the player rig was pushed sideways at spawn. The gondola is now two meshes: the walkable hull (deck, bulwarks, rails) and the rigging (everything else, not walkable).

## Motion profiles

Defined in `src/sim/ship-motion.ts` and selected with `?motion=` in the URL. All amplitudes ease in and out at capped rates, so neither a fresh start nor a profile change jolts the felt gravity (unit tests check acceleration and jerk).

| Profile | Cruise speed | Peak turn rate | Peak climb | Peak tilt | Gusts |
| --- | --- | --- | --- | --- | --- |
| gentle | 5 m/s | 3°/s | 0.8 m/s | 2° | 0.5 m/s |
| tour | 7 m/s | 6°/s | 1.5 m/s | 4° | 1.2 m/s |
| lively | 10 m/s | 10°/s | 2.5 m/s | 7° | 2.5 m/s |

These feed spike S3 (comfort), which turns the comfortable profile into hard limits for the flight model.

## Automated checks

`npm run test:xr` (emulated Quest 3): bricks settle in the crate; a squeeze grabs one; it follows the controller; released over the deck it lands on the deck; a 40° test tilt makes a resting brick slide to starboard and stop at the wall; flying the tour profile moves the ship while every brick stays aboard; no console errors.

## Still to test on a headset

- Grab, toss and catch bricks while flying `?motion=tour` and `?motion=lively`: no jitter, nothing lagging the deck, throws land where expected.
- Smooth and teleport locomotion on the deck; the walls keep the player aboard.
- Whether the tilting horizon and passing world feel right (this is also S3).
- The trim calculation (head position over the deck driving pitch and roll) is not built yet; it comes with the flight model.
