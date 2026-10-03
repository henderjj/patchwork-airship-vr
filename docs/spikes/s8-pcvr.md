# Spike S8: PC VR through Meta Horizon Link

Status: built and tested in the cloud with the emulated headset, including a run with the frame-rate API removed as a desktop browser may have it. Whether Chrome and Edge on Windows with Link behave as expected can only be checked on a PC with a Quest (steps at the end).

## What was built

- **No PC code path.** The game runs the same code in the Quest Browser and in a desktop browser over Link. The two places where the runtimes are known to differ are handled by feature detection:
  - **Refresh rate.** On the Quest the game asks for 90 Hz with `updateTargetFrameRate`. Over Link the rate is set in the Meta Horizon Link app on the PC, and the desktop browser may not offer the call or report `frameRate`. The game then skips the request, and the perf HUD measures the rate from frame times instead (`src/perf/refresh-rate.ts`, shown with a `~`, for example `~90 Hz`). Before this, the HUD assumed 72 Hz whenever the rate wasn't reported, which would have made a 90 Hz PC session look fine when it was dropping frames.
  - **Multiview.** three.js draws both eyes in one pass when the browser offers `OCULUS_multiview` (the Quest Browser does) and falls back to two passes when it doesn't (expected on desktop Chrome and Edge). Nothing in the game depends on which; the HUD's draw-call count doubles without it, which a PC handles easily.
- **Platform report** (`src/perf/platform-report.ts`, `src/systems/platform-system.ts`). Each player's game describes its browser and headset runtime: browser and OS, GPU, refresh rate and where it came from, the supported rates, whether the rate can be set, multiview, WebXR layers, foveation, eye-buffer size, granted features (such as hand tracking), each input source (controller or hand, and its input profile, the name the browser gives the controller model) and the microphone voice is using. The two players swap reports when they connect. Both are shown as two lines at the bottom of the wrist HUD (`me` and `crew`), logged to the console as `[Platform]` lines, and readable from `window.__platform`.

## Results in the cloud

| Test | Result |
| --- | --- |
| Emulated Quest 3, normal session | The report shows 90 Hz reported and settable, two `meta-quest-touch-plus` controllers, hand tracking granted. The emulator runs in desktop Chromium, so it also shows no multiview and a small buffer; a real Quest should show multiview |
| Same, with `frameRate`, `supportedFrameRates` and `updateTargetFrameRate` removed before entering VR | The game requests no rate, measures the rate instead and marks it measured on the HUD (about 17 Hz in the cloud's software renderer) |
| Two browsers connected | Each sees the other's report, including the microphone's name. All 33 network checks still pass |
| Unit tests | User-agent parsing for the Quest Browser, Chrome and Edge on Windows; the measured rate snaps to 72, 80, 90 and 120 Hz through jittery frame times and a few dropped frames, and reads 45 Hz under SpaceWarp |

## Expected differences on PC (to confirm)

- The refresh rate comes from the Link app's setting, not from the game.
- No multiview, so twice the draw calls; fine on a PC GPU.
- Link's Asynchronous SpaceWarp halves the game's rate when the PC can't keep up. The HUD then reads about 45 Hz, which is what the game is really getting.
- Link compresses and streams the picture to the headset, which adds latency the game can't see or control. It doesn't affect the network between players.
- The microphone and speakers are whatever Windows uses as its defaults, which may not be the headset's.
- Hand tracking over Link may need the Link app's developer runtime features turned on.

## Headset tests (PC and Quest)

### Setting up the PC (once)

1. Install the **Meta Horizon Link** app on the Windows PC from meta.com and sign in with the same Meta account as the Quest.
2. In the Link app, open **Settings → General** and, next to **OpenXR Runtime**, click **Set Meta Horizon Link as active**.
3. In **Devices**, select the Quest 3, then **Graphics Preferences**, and set the refresh rate to **90 Hz**.
4. For hand tracking: **Settings → Beta**, turn on **Developer runtime features**.
5. In Windows sound settings, set the default microphone to **Headset Microphone (Oculus Virtual Audio Device)** and the default output to **Headphones (Oculus Virtual Audio Device)**. Chrome and Edge use the Windows defaults.

### Tests

1. **Solo on PC (wired Link).** Connect the Quest with a USB-C cable and accept **Enable Link** in the headset. From the Link home, open the desktop view, start Chrome on the PC, open `https://henderjj.github.io/patchwork-airship-vr/` and click **Enter XR**. Press **X** for the wrist HUD. Note its `me` line (for example `PC Chrome 141, ~90 Hz, no multiview`) and whether fps keeps up with the Hz. Pick up and throw a brick, turn the crank and haul the line. Press **Y** and check the mute indicator on the crew panel.
2. **Hands on PC.** Put the controllers down and look at your hands. Say whether the hands appear, and whether `hands` shows on the HUD's `me` line.
3. **Cross-play.** On the PC, add `?room=TEST` to the URL (any four letters). A second player in the Quest Browser opens the same URL with the same room code. Each HUD's `crew` line should show the other player's platform. Talk both ways, crank together and throw a brick to each other.
4. **Air Link.** Repeat test 1 over Air Link (Quest **Settings → Link**, the PC wired to the router, the Quest on 5 GHz or 6 GHz Wi-Fi).
5. **Edge.** Repeat test 1 in Microsoft Edge.

For each test, please send a photo or a description of both HUD lines and anything that behaved differently from the Quest Browser. The full report is the `[Platform]` lines in the PC browser's console (F12).

Pass (from the plan): a cross-play session between one Quest standalone player and one PCVR player works without platform-specific code beyond feature detection.
