# Hands

Written 2026-10-07 after John's solo Quest 3 playtest. It covers what changed in the gloves now, and the design for the posed low-poly hands and grip locking that come later in the plan (development plan, Phase 3 step 0).

## What changed now

**Controller models.** IWSDK draws the WebXR input-profile model of each controller (and a generic hand model for tracked hands) at its grip pose. PR #25 turned these off with `toggleVisual(false)`, but IWSDK 1.0.1's input manager sets the model visible again every frame (`visualAdapter.visual.model.visible = isPrimary` in `XRInputManager.updateControllersAndHands`), so once the models finished downloading from the CDN they showed inside the gloves. `OwnHandsSystem` now stops the adapters loading a model at all. On Quest 3 that saves two Meta Quest Touch Plus models of 4,470 triangles in six draw calls each (12 draw calls and about 8,900 triangles against our budget of 100 and 300k), a 430 KB download at the start of each session, and the per-frame animation of their buttons. Every IWSDK code path that uses the model already allows for it missing, since a download can fail. The emulated-headset test now checks the models stay unloaded.

**Arm angle.** The glove was modelled with its sleeve along the grip space's +Z axis. In WebXR the grip space's origin is the middle of the fist, -Z runs along the controller's handle towards the thumb and +X points out of the back of a right hand ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/XRInputSource/gripSpace)). So +Z runs down the handle to the little finger, and the sleeve pointed down out of the bottom of the controller: held naturally, forearms angled about 50° down. The glove is now modelled as a hand in its own wrist frame and placed in grip space with IWSDK's own wrist pose for a hand squeezing a controller (`AnimatedControllerHand.pressedPose`), so the forearm leaves the fist up and back along the real arm. Left hands are the right one mirrored, as the grip spaces are. The crewmate's gloves use the same geometry, so they changed too.

## Posed low-poly hands (later)

John wants proper low-poly hands with basic poses from the Quest controllers: a fist, pointing and a flat hand.

### What the controllers report

Quest Touch Plus controllers (Quest 3) use the `meta-quest-touch-plus` input profile ([registry](https://github.com/immersive-web/webxr-input-profiles/blob/main/packages/registry/profiles/meta/meta-quest-touch-plus.json)) with the `xr-standard` gamepad mapping:

| Index | Control | Gives |
| --- | --- | --- |
| 0 | Trigger | value 0–1, touched |
| 1 | Grip (squeeze) | value 0–1 |
| 3 | Thumbstick | pressed, touched, axes 2–3 |
| 4, 5 | A/B (right) or X/Y (left) | pressed, touched |
| 6 | Thumb rest | touched |

IWSDK exposes these as `getButtonValue(id)` and `getButtonTouched(id)` on `this.input.xr.gamepads[side]`. The trigger, thumbstick, face buttons and thumb rest have capacitive sensors, which is what Meta's own apps use to pose hands on controllers. The grip has only its pull value. The touched flags need a quick check on the headset before relying on them (a HUD line showing each one), because the profile lists them but the browser's behaviour isn't documented.

### Poses from the inputs

Each hand has three finger groups, each with a curl from 0 (open) to 1 (closed), smoothed over about 50 ms so they don't snap:

- **Index finger:** 0.25 when the trigger is not touched (lifted off, so it points), 0.4 when resting on it, rising to 1 with the trigger's pull.
- **Middle, ring and little fingers:** the grip's pull, from a relaxed 0.2 to 1.
- **Thumb:** down on the controller when the thumbstick, either face button or the thumb rest is touched; lifted and straight when none is.

That gives the named poses for free: a flat hand (nothing held), a fist (grip and trigger pulled, thumb down), pointing (grip pulled, finger off the trigger) and a thumbs-up (grip pulled, thumb lifted). With tracked hands, the same three curls come from the joints, which `src/sim/hand-grip.ts` already measures for fist grips (spike S9), so one hand model serves both.

### The model

A procedurally built, flat-shaded skinned mesh per hand, like the rest of the game's low-poly models: a palm block, three box segments per finger and three for the thumb, each segment weighted fully to one bone (rigid skinning, which keeps the faceted look and needs no weight painting). About 16 bones and 400–600 triangles, one draw call per hand, coloured by vertex like the avatars. Built in code rather than loaded, so there is nothing to download and it can't fail to arrive. The cuff and sleeve stay as they are now, and the fist pose is posed to match today's glove so nothing else moves.

The CPU cost is setting about 16 bone rotations per hand per frame from three numbers (well under 0.05 ms); skinning runs on the GPU. The crewmate's hands need the three curls too: three bytes per hand in the pose packet, so six bytes per packet.

Alternatives considered: morph targets per finger group (cheap, but blending straight lines between open and closed shortens fingers mid-curl), swapping between pre-built pose meshes (no smooth transitions) and the input-profile hand models (realistic rather than low-poly, a CDN download, and the same per-frame re-show bug as the controllers).

### Steps

1. A HUD line showing each control's touched state and value, and a check on the Quest 3 (John).
2. The skinned hand model and its three-curl pose function, with unit tests on the pose function and a screenshot of each named pose.
3. Drive own hands from the controllers and tracked hands; send the curls to the crewmate.
4. Grip locking (below).

## Locking hands to what they hold (later, after posed hands)

While a hand grips the crank, the mooring line, the tiller, the vent cord or the bell lanyard, draw the hand on the handle instead of at the controller, in a closed pose shaped to it. Each grippable control declares a grip frame (where the palm goes and which way the handle runs), and the drawn hand takes that position with the controller's twist about the handle. On grab and release the drawn hand eases between the controller and the handle over about 80 ms, and the sleeve follows the drawn hand. The crewmate sees the same, since who holds what is already synced. Today a grip only ends when the grip button is let go; with locking it should also end when the real hand gets more than about 25 cm from the handle, so the drawn hand never stretches far from the player's own.
