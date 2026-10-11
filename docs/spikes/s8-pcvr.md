# Spike S8: PC VR through Meta Horizon Link

Status: passed. On 2026-10-10 John (Quest Browser) played a crew game with a second player on an Oculus Rift (PC VR): voice worked with no echo and voice and movement latency were good, which is the plan's cross-play pass test. On 2026-10-11 John played in Chrome over Air Link on his PC and the game held 90 fps at 90 Hz, after Chrome's graphics acceleration was turned on (see "Solved" below). Wired Link, Edge and hand tracking over Link haven't been tried; they run the same code, so they are only worth checking if someone plays that way.

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

1. **Solo on PC (wired Link).** Connect the Quest with a USB-C cable and accept **Enable Link** in the headset. From the Link home, open the desktop view, start Chrome on the PC, open `https://henderjj.github.io/patchwork-airship-vr/` and click **Enter XR**. Press **X** for the wrist HUD. Note its `me` line (for example `PC Chrome 141, ~90 Hz, no multiview`) and whether fps keeps up with the Hz. Pick up and throw a brick, turn the crank and haul the line. Press **Y** for the game menu, press **My mic** and check it says muted.
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

### Third try: the graphics context was lost (2026-10-10)

In Chrome (before the permission hint was live) the browser asked for the VR permission, John allowed it, and the console showed what happened next:

```
[VR] Session granted after 83.2 s
WebGL: CONTEXT_LOST_WEBGL: loseContext: context lost
[XR] Failed to acquire reference space: InvalidStateError: An attempt was made to use an object that is not, or is no longer, usable.
THREE.WebGLRenderer: Context Lost.
[VR] The session ended before its first frame
Uncaught TypeError: Cannot read properties of null (reading 'cancelAnimationFrame')
THREE.WebGLRenderer: Context Restored.
```

So the permission prompt and Link's slow start were both real, and the session did arrive. It then died because three.js calls `gl.makeXRCompatible()` when a session starts, and on a PC whose WebGL context is on a different graphics adapter from the headset's, the browser makes it compatible by losing the context and restoring it on the right adapter. three.js carries straight on and creates the XR layer on the lost context, which throws `InvalidStateError`; IWSDK reports every failure there as "Failed to acquire reference space" and ends the session. The `cancelAnimationFrame` error is three.js tidying up a session that never started, and is harmless. This happens on PCs with two graphics adapters: most laptops, and desktops with the CPU's graphics enabled, where browsers put WebGL on the low-power one by default while Link renders on the card the headset uses.

The fix has three parts:

- **Start on the right card.** `src/gpu-preference.ts` makes WebGL contexts ask for `powerPreference: 'high-performance'` (three.js passes `'default'`, and IWSDK doesn't say), so on a two-GPU PC the game starts on the discrete card, the one Link uses.
- **Make the context VR-ready early.** As soon as the browser reports a headset, `prepareVr` in `src/vr-start.ts` calls `makeXRCompatible()` in the background, so any move between cards happens at page load, where three.js recovers from it, rather than in the middle of starting a session.
- **Say so if it still happens.** If the context is lost while a session starts, the line under Enter VR says the graphics moved to the headset's card and to press Enter VR again. The restored context is on the right card, so the second try should start.

### Fourth try: still the old build, and a software renderer (2026-10-10 17:51)

John's next log failed the same way (granted after 55.5 s, then the context was lost), but it came from the cached old bundle, before the fix deployed at 17:44; a hard reload (Ctrl+Shift+R) picks up the new one, which logs `[VR] Graphics ready for VR` soon after load. The same log's platform line names the GPU as `ANGLE (Microsoft, Microsoft Basic Render Driver ...)`: Chrome was drawing with Windows' software renderer, which is why the flat page ran at 40 to 50 fps and why starting VR had to move the context to the real graphics card (after the move the page ran at 134 fps). Worth fixing at the source: `chrome://gpu` shows whether Chrome is in software-only mode, Chrome's Settings → System → "Use graphics acceleration when available" must be on, and Windows Settings → System → Display → Graphics can set Chrome to High performance.

### Fifth try: the move still killed the session (2026-10-10 17:58)

With the new build, the early `makeXRCompatible` at page load lost and restored the context but was rejected (`InvalidStateError`), and the context stayed on the software renderer (still about 48 fps). Chrome only seems to learn which card the headset uses once Link's runtime is running, which over Link 207 is about when the session arrives. So the session was granted (55.5 s, and 33.4 s on a second press) and the context was lost again as three.js took it, both times. After the second loss the page ran at 128 fps, on the real card.

The game now holds a granted session back from IWSDK until the graphics are ready (`makeGraphicsReady` in `src/vr-start.ts`). It calls `makeXRCompatible` itself; if the context is lost, it waits for the restore and calls again, up to four times, and only then hands the session over, so three.js's own call is a no-op and the session survives the move. A session waits happily for that second or two. Faked in a browser (the first `makeXRCompatible` loses the context and restores it 0.7 s later), IWSDK got the session only after the context was back. The crew panel also says when a PC browser is drawing with a software renderer, with the settings to change.

### Solved: graphics acceleration was off (2026-10-10 18:03)

John turned on Chrome's Settings → System → "Use graphics acceleration when available", and the game entered VR over Air Link. With acceleration off, Chrome drew with Windows' software renderer, so every VR start had to move the context to the real card, and the session died in that move. The steps below still apply to anyone else; the crew panel now names the setting when it sees a software renderer.

### Result: 90 fps over Air Link (2026-10-11)

With acceleration on and PRs #44 and #47 live, John played in Chrome over Air Link and fps held at 90 at 90 Hz. Starting VR still takes about a minute through Link 207, after the browser's VR permission prompt on the PC screen; the crew panel says both.

### Result: cross-play with an Oculus Rift (2026-10-10)

John, in the Quest Browser, played a crew game with a second player on an Oculus Rift through a PC browser. Voice had no echo, and voice and movement latency were good. They turned the crank together. This needed no platform-specific code beyond feature detection, so S8 passes. The design notes from that game (arms, player height, seated play, keeping in step on the crank and the rope) are design input for later features, not part of this spike.

### What to try

1. Make sure the browser uses the graphics card: Chrome's or Edge's Settings → System → **Use graphics acceleration when available** must be on (`chrome://gpu` should not say "Software only"). Start Link or Air Link first, so the Link home shows in the headset, then open the game in Chrome or Edge on the PC (not Firefox, which has no WebXR on Windows).
2. Press **Enter VR** on the crew panel, then look at the browser window on the PC screen (lift the headset, or use the desktop view in the Link home): if it asks to use your virtual reality devices, click **Allow while visiting the site**. Then keep the headset on for up to a minute. The line under the button counts the seconds.
3. If the line shows a reason instead, send it. If it says the browser sees no VR headset, check that Meta Horizon Link is still the active OpenXR runtime (Link app → Settings → General); another VR app such as SteamVR or Virtual Desktop can take it over.
4. If the Link app shows a screen about content from unknown sources, turn on **Settings → General → Unknown Sources** in the Link app.
5. If VR started once and won't start again, close every browser window and start the browser again; a second session over Link has hung in other WebXR apps until the browser restarted.
6. If it still hangs, open `chrome://webxr-internals` (or `edge://webxr-internals`) in a new tab on the PC and send a picture of it. It shows whether the browser found the OpenXR runtime and what happened to each session request.
