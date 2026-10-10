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

## If the game doesn't go into VR on PC (2026-10-08)

John's first Air Link try (Meta Horizon Link set as the OpenXR runtime) didn't enter VR. The game asks the browser for a plain VR session with no required features, so a desktop browser over Link should accept it. Two things made a failure, or a slow start, look like nothing happening:

- **Meta Horizon Link 207 makes Chrome wait about 55 seconds** before the session starts. Chrome runs its VR service in a sandbox, and Link 207's runtime retries a connection the sandbox blocks for about 11 seconds at a time before it gets through ([Meta's bug report](https://developers.meta.com/horizon/feedback/vr/investigations/1070515512504086/), opened September 2026, still under investigation). The session does start in the end. Edge has the same sandbox, so it probably waits too. Running Chrome with `--no-sandbox` avoids the wait but turns off a browser safety feature, so it isn't recommended.
- **The game said nothing.** IWSDK only logs a refused request to the console, and while a request is pending further presses do nothing. The page also hid its Enter VR button when the browser reported no headset at load, for example when the page was opened before Link was running, and never looked again.

The crew panel now says what is happening under Enter VR (`src/vr-start.ts`, `src/vr-messages.ts`): "Starting VR..." with the seconds counting, an explanation after 8 s that Link can take about a minute, "the headset accepted, waiting for the first picture" once the browser hands over a session, a suggestion to restart the browser after 90 s, and the browser's reason if it refuses, with the Link checks on a PC. On a PC the button stays even when the browser reports no headset, with a note to start Link first, and the check is repeated when the browser reports a device change or the window regains focus. A PC browser without WebXR (Firefox, Safari) is told to use Chrome or Edge. The console gets `[VR]` lines with the time to the session and to the first frame.

### Second try: still waiting after 90 s (2026-10-10)

With the status line live, John's next try (Edge first; on 2026-10-08 he had tried Edge and Firefox) counted past 90 seconds and still didn't start, also after closing every browser window. A request that never settles, rather than one refused at once, fits two causes:

- **The browser's VR permission prompt.** Chrome and Edge have a per-site **Virtual reality** permission (Chrome help: [site settings](https://support.google.com/chrome/answer/114662)). On a PC the request shows as a bubble on the browser window on the monitor, which someone already wearing the headset can't see, and the session request waits until it is answered. A site that was set to "Never allow" would be refused at once instead, which the line would show as a reason.
- **Meta's runtime holding the session.** Unknown Sources being off in the Link app, or the Link 207 sandbox bug above failing for good rather than after 55 s.

The line under Enter VR now tells a PC player from the first second to look at the browser window on the PC screen and click Allow if it asks to use virtual reality devices. After 90 s it adds the Unknown Sources check and asks for a picture of `chrome://webxr-internals` (`edge://webxr-internals` in Edge), the browser's own WebXR page, which lists the runtimes it found and each session request.

### What to try

1. Start Link or Air Link first, so the Link home shows in the headset, then open the game in Chrome or Edge on the PC (not Firefox, which has no WebXR on Windows).
2. Press **Enter VR** on the crew panel, then look at the browser window on the PC screen (lift the headset, or use the desktop view in the Link home): if it asks to use your virtual reality devices, click **Allow while visiting the site**. Then keep the headset on for up to a minute. The line under the button counts the seconds.
3. If the line shows a reason instead, send it. If it says the browser sees no VR headset, check that Meta Horizon Link is still the active OpenXR runtime (Link app → Settings → General); another VR app such as SteamVR or Virtual Desktop can take it over.
4. If the Link app shows a screen about content from unknown sources, turn on **Settings → General → Unknown Sources** in the Link app.
5. If VR started once and won't start again, close every browser window and start the browser again; a second session over Link has hung in other WebXR apps until the browser restarted.
6. If it still hangs, open `chrome://webxr-internals` (or `edge://webxr-internals`) in a new tab on the PC and send a picture of it. It shows whether the browser found the OpenXR runtime and what happened to each session request.
