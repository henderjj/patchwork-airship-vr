# Spike S4: networking transport

Status: built and tested between two browsers in the cloud. Not yet tested on two headsets in two homes, which is the real pass/fail test (steps at the end).

## What was built

- **Lobby** (`lobby/`, rules in `src/net/lobby-protocol.ts`). A player creates a crew and gets a four-letter code (no I, L or O, so it reads clearly aloud). Crews hold two players; the first to arrive is the host, and if the host leaves the other player becomes host. The lobby only relays the WebRTC offer, answer and network candidates; game traffic goes directly between the two browsers. Deployed version: a Cloudflare Worker with PartyServer, one Durable Object per room. Local version: a small Node WebSocket server with the same rules, reached through the game's dev server at `/parties`.
- **Peer connection** (`src/net/net-session.ts`). The host makes the offer. Two data channels: `u` is unordered with no retransmits (poses and pings, so a lost packet never delays newer ones) and `r` is reliable and ordered (grabs, releases and game events, used from S6 on). The lobby can hand out Cloudflare TURN credentials when the Worker has the TURN secrets; otherwise it gives Cloudflare's STUN server only.
- **Clock sync** (`src/net/clock-sync.ts`). A ping every 500 ms on the unreliable channel. The clock offset comes from the lowest-RTT sample of the last 16, which has the least queueing in it. RTT goes to the perf HUD and the CSV (`rtt_ms`).
- **Pose packets** (`src/net/pose-codec.ts`). Head and both grips, 47 bytes per packet: millimetre positions in 16-bit integers and "smallest three" quaternions (round-trip error under 0.01°). Sent at 45 Hz, which is about 50 kbit/s per direction once UDP, DTLS and SCTP headers are added (inferred from typical header sizes, not measured).
- **Jitter buffer** (`src/net/pose-buffer.ts`, `src/systems/net-system.ts`). The crewmate is drawn slightly in the past, interpolating between the two packets around that moment. The delay adapts: the measured one-way delay, plus one and a half packet intervals, plus three times the arrival jitter (the buffer part is kept between 30 and 200 ms). If a packet is late the pose extrapolates for up to 50 ms, then holds.
- **Remote avatar**: head with goggles, torso hanging below the head and turning with its yaw, and two gloved hands that show only while that hand is tracked. Four draw calls.
- **Network simulation for testing**: `?netlag=60&netjitter=20&netloss=0.01` delays and drops received packets, so the worst playable case from the latency research can be felt on one desk.

## Results in the cloud

`npm run test:net` (also in CI) opens the built game in two separate browser profiles on one machine, with software rendering at about 30 fps per page.

| Check | Result |
| --- | --- |
| Two players connect over a direct data channel | Pass, route host/host over UDP |
| Third player refused | Pass |
| Pose round trip accuracy | 0.00 mm position, 0.001° rotation |
| Packet rate and loss on a clean link | About 45 Hz minus the sender's frame drops; 0 lost |
| RTT on a clean link | 1–3 ms |
| Host leaves, other player becomes host, rejoin works | Pass |
| Simulated 60 ms each way, 0–20 ms jitter, 1% loss | RTT 142–154 ms; render delay settles at about 150 ms; motion smooth (no backward steps over 5 mm) |
| Time from joining to channels open | 2.7–3.8 s for the second player, but measured on pages that were still loading under software rendering, so it says little about a headset |

## Findings

1. **The render delay must include the one-way network delay.** The first version measured delay from the sender's clock and only allowed for jitter, so at 150 ms RTT the crewmate was drawn from extrapolation most of the time and jumped back 20 cm when packets arrived. Adding the smoothed one-way delay fixed it. Players will see each other about one-way delay plus 30–80 ms in the past, in line with the 60–120 ms estimate in the latency research.
2. **The packet interval follows the sender's frame rate.** Poses are sent from the frame loop, so a sender running below 45 fps sends less often. The buffer measures the real interval and widens itself, which kept motion smooth in the 30 fps test. On Quest at 72 or 90 Hz this is not expected to matter.
3. **Extrapolation should stay short.** Linear extrapolation overshoots on curved motion and when the sender hitches; 50 ms keeps the snap-back to a millimetre or two.
4. **Test poses must be stamped when sent.** Setting a moving test pose in a separate animation callback made each packet's pose one frame older than its timestamp, which looked like network judder. Tests now pass a function evaluated at send time.

## Not done yet

- **LiveKit comparison.** The plan asks for the same pose sync on LiveKit Cloud as a fallback comparison. It needs a LiveKit account, so it waits until the direct WebRTC results from two homes are in; if those pass, the comparison is optional.
- **Deployed lobby.** The Worker builds and runs under `wrangler dev`, but deploying it needs a Cloudflare account. CI deploys it on every push to `main` once the Cloudflare secrets are in the repository; the one-time setup is in [lobby/README.md](../../lobby/README.md).
- **Voice** is spike S5, on this same connection.

## Headset tests (needs two people)

Before these, the lobby must be deployed and the game hosted (GitHub Pages or elsewhere), which CI does on `main` once the Cloudflare secrets from [lobby/README.md](../../lobby/README.md) are set.

1. **Two homes, fibre.** Each player opens the game URL in the Quest Browser. One presses **New crew** in the top right panel and reads out the four-letter code; the other types it and presses **Join**. When the panel says "connected", both enter VR. Check that the crewmate's head and hands move smoothly and that the RTT on the wrist HUD (X button) is in the range the latency research predicts for your distance. Repeat ten times and note how many connect within five seconds.
2. **Forced relay.** One player uses a phone's mobile hotspot. In remote DevTools (or the console), the line `[Net] connected via relay/...` shows the TURN relay was used. This needs the TURN secrets on the Worker.
3. **One hour with streaming.** Leave a session running while someone streams video in each home. Afterwards, download the CSV from the desktop HUD on each headset and send it over; the `rtt_ms` column shows spikes.
4. **Simulated bad network.** Open the same crew link with `&netlag=60&netjitter=20&netloss=0.01` added to both players' URLs and check that the crewmate still looks smooth, just later.

Pass (from the plan): connects on at least 95% of attempts within 5 seconds; 95th-percentile RTT within the latency estimates; remote avatars look smooth.
