# Spike S10: session lifecycle

Status: built and tested in the cloud with two browser players, including a simulated network blackout and a failed connection. What a real headset does when it is taken off, put to sleep or loses Wi-Fi can only be seen on a headset (steps at the end). The plan's pass mark: the game pauses cleanly with a "waiting for crewmate" state and resumes, or reconnects within 10 seconds.

## What was built

- **Crew presence** (`src/net/crew-presence.ts`). Each player works out, every frame, whether the crewmate can play. The states are: together, away (the crewmate's headset or tab isn't showing the game), not responding (connected, but nothing has arrived for 1.5 s), reconnecting, left (waiting for them to rejoin), and lost (reconnecting gave up after 60 s). A player who has never had a crewmate in this room is solo and nothing pauses.
- **Telling the crewmate you've stepped away** (`src/systems/net-system.ts`). When the page is hidden, the headset reports the session hidden (headset off, asleep) or blurred (Meta button, a system menu over the game), the player sends a reliable `presence` event saying so, and another when they're back. These browser events still fire while the headset has stopped drawing the game's frames.
- **Pause and sign.** While the crewmate can't play, the ship stops (`ShipSystem`) and a sign floats 1.2 m in front of the player saying why, for example "Your crewmate stepped away" with "The ship waits until you are both back" beneath (`src/systems/crew-status-system.ts`). It follows the player's heading slowly rather than sticking to their face, and is drawn over the gondola so nothing hides it. It goes away and the ship carries on as soon as the crewmate is back.
- **Reconnecting by itself** (`src/net/net-session.ts`). If the direct connection drops briefly, WebRTC is given 6 s to recover on its own. If it fails, a data channel closes, or the lobby connection drops, the player goes back through the lobby into the same room and connects again, retrying every 2 s for up to 60 s. Each page keeps a random player key, so the lobby replaces a player's dead connection with the new one instead of finding the room full (`src/net/lobby-protocol.ts`).
- **Lobby keepalive.** While the players are connected directly, nothing else goes over the lobby connection, so a network proxy could close it as idle and the crewmate would be told the player left. The page now sends a small `ping` to the lobby every 30 s, which the lobby ignores.

The host still runs the shared simulation in their browser. Whoever stays in the room becomes host when the other leaves, as before.

## Results in the cloud

Two Chromium players on the local lobby, `npm run test:net` (quick loop: `ONLY_LIFECYCLE=1`).

| Case | How it was simulated | Result |
| --- | --- | --- |
| Crewmate takes the headset off | The guest's page reports itself hidden | The host's sign reads "Your crewmate stepped away" and the ship stops dead (0.00 s of flight in 0.8 s). When the guest is back the sign goes and the ship carries on |
| Network freezes (frozen page, Wi-Fi dropping) | Everything from the guest is held back for 3 s | "Your crewmate is not responding" after 1.5 s, back to normal once packets flow again |
| Connection fails | The guest's WebRTC connection is closed | Both players show "Reconnecting to your crewmate", then reconnect by themselves through the lobby in 0.6–0.8 s |
| Host closes the tab | The host's browser profile is closed | The other player becomes host and sees "Your crewmate left. Waiting for them to rejoin"; the host reopens the page and both are connected again |
| Single player | XR smoke test in the emulated headset | Nothing pauses; all 28 checks pass |

Unit tests cover each presence state and the lobby replacing a stale connection for the same player.

## Open questions for the headset

1. **Headset off.** The Quest should report the session hidden when the proximity sensor sees no face. If it doesn't, the crewmate would see "not responding" after 1.5 s instead of "stepped away", which still pauses the game.
2. **Sleep.** After a few minutes off, the Quest sleeps and may suspend the browser. Whether the page reconnects on wake, or needs a reload, decides whether a longer break needs anything more.
3. **Wi-Fi drop of 10 s.** The plan asks for recovery within 10 s. The connection waits up to 6 s to recover on its own before going back through the lobby, so the expected total is about 7 s after Wi-Fi returns.

## Headset tests

Use the Quest for one player and a desktop browser for the crewmate. The desktop shows the same sign in its window.

1. On the computer, open `https://henderjj.github.io/patchwork-airship-vr/?room=TEST`. On the Quest, open the same address in the Quest Browser and enter VR. Wait until the computer's panel says connected.
2. **Headset off.** Take the headset off for 10 seconds, watching the computer. Say what its sign says, and whether everything carries on when you put the headset back on.
3. **Meta button.** Press the Meta button so the system menu opens, wait 10 seconds, and go back to the game. Same question.
4. **Sleep.** Take the headset off for 5 minutes so it sleeps, then put it back on. Say whether the two reconnect by themselves, and how long it takes.
5. **Wi-Fi.** Turn the Quest's Wi-Fi off for 10 seconds from the quick settings, then on again. Say what the sign says in the headset and on the computer, and how long after Wi-Fi returns the game carries on.
6. **Tab closed.** Close the game's tab on the computer. The headset's sign should say your crewmate left. Reopen the address on the computer and check both connect again.

Pass: each case pauses with a sign that says why and the game carries on, by itself, within 10 seconds of the player or the network coming back. Fail plan (from the development plan): move the shared simulation to a room server.
