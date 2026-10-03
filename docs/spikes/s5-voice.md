# Spike S5: voice

Status: built and tested between two browsers in the cloud with Chromium's fake microphone. Echo, mouth-to-ear delay and CPU cost can only be judged on headsets (steps at the end).

## What was built

- **Microphone** (`src/net/voice.ts`): captured with the browser's echo cancellation, noise suppression and automatic gain on. The browser asks for permission when the player creates or joins a crew. If permission is refused, the player can still hear the crewmate. The track is sent with Opus, WebRTC's default voice codec, which already has in-band error correction turned on.
- **Same connection as S4** (`src/net/net-session.ts`): the host's offer includes one two-way audio transceiver, and each side attaches its microphone with `replaceTrack`. Muting or granting the microphone late never renegotiates the connection.
- **Spatial playback**: the crewmate's voice goes through a Web Audio HRTF panner placed 8 cm below and 6 cm in front of their head (their mouth). The listener follows this player's head every frame. Positions are smoothed over about 20 ms so head movement doesn't click.
- **Three playback modes** for the headset comparison the plan asks for:
  - `?voice=spatial` (default) is the spatial playback above.
  - `?voice=plain` plays through an ordinary audio element with no positioning. This is the fail plan.
  - `?voice=off` turns voice off.
- **Loopback workaround** (`?voiceloop=1`): Chromium's echo canceller only removes sound it played itself through WebRTC's output. Spatial voice played straight from Web Audio is invisible to it, so a headset's speakers could feed the crewmate's voice back into its microphones. The workaround sends the Web Audio mix through a peer connection inside the same page and plays it from an audio element, which the echo canceller does see. Opus is asked for stereo on that local link so the HRTF panning survives.
- **Mute**: the **Y** button on the left controller in VR, or **Mic** on the crew panel.
- **Stats** every five seconds in the console: the voice jitter-buffer delay, lost audio packets and the share of audio the decoder had to conceal, next to the RTT and pose stats.

## Results in the cloud

From `npm run test:net`, with two browser profiles on one machine and software rendering:

| Check | Result |
| --- | --- |
| The crewmate's voice arrives | Pass; peak level about 0.6 from the fake microphone's beep |
| Mute silences it | Pass; level 0.0000 |
| Loopback route plays | Pass |
| Voice jitter buffer | About 110 ms on a clean link and 120 ms at a simulated 150 ms RTT. Both are inflated by four software-rendered pages sharing one CPU. On a headset, expect the 20–60 ms the latency research assumes |
| Concealed audio | 0.8% on a clean link, 1.9% under simulated lag. The simulation only delays data-channel packets, so this is also CPU load, not the network |

## Not measurable in the cloud

- **Echo.** It needs real speakers next to real microphones.
- **Mouth-to-ear delay.** The pass mark is under 200 ms. The estimate is about 15 ms capture, 20 ms Opus frame, half the RTT, 20–60 ms jitter buffer and about 20–40 ms output, so roughly 80–150 ms on a good connection. This is an estimate, not a measurement.
- **Main-thread cost.** The audio processing runs on the audio thread. The main thread only sets twelve audio parameters per frame, so it should be far under the 0.5 ms budget. Check it on the headset with the perf HUD by comparing CPU ms with voice on and with `?voice=off`.

## Headset tests (needs two headsets)

1. **Echo, spatial.** Two players in different rooms (or homes) join one crew. With speakers at normal volume, each takes a turn talking. The listener should not hear their own voice coming back. Repeat with `&voiceloop=1` added to both URLs, then with `&voice=plain`. Note which of the three has no echo.
2. **Direction.** With spatial voice, one player walks around the other on the deck while talking. The voice should come from where they stand.
3. **Mouth-to-ear (clap test).** Put both headsets in one room, each on a different network (for example one on a phone hotspot), with players far enough apart not to hear each other directly, or one in the next room with the door shut. Record both headsets on a phone video while player A claps once near their headset. The gap between the clap and its sound from B's headset speaker, read off the video's audio track, is the mouth-to-ear delay. Do it five times.
4. **CPU.** Compare the perf HUD's CPU ms with voice on and with `?voice=off` for a minute each.

Pass (from the plan): no audible echo, under 200 ms mouth to ear, under 0.5 ms main-thread cost per frame. Fail plan: unspatialised voice (`?voice=plain`), or LiveKit audio.
