# Spike S3: comfort

Status: test tools built and checked in the emulated headset. The spike itself is a playtest: people in the headset, rating how they feel while the ship flies. The protocol and the exact steps are below. The plan's pass mark: a motion profile that most testers rate comfortable, written down as hard limits for the flight model (maximum tilt, acceleration and turn rate), plus a decision on how players move around the deck.

## What was built

- **A rating in the headset** (`src/systems/comfort-system.ts`). With `?comfort=60` in the address, a sign appears once a minute asking "how do you feel?" on the Fast Motion Sickness scale: 0 means no sickness at all and 20 means about to be sick. This one-number scale, asked every minute, is the standard quick measure for VR sickness and takes a few seconds to answer. The right trigger raises the number, the left trigger lowers it, and **A** answers. It starts at the last answer, so "no change" is one press of A. If nobody answers within 20 s the question goes away; a number the player changed but didn't confirm is still kept.
- **A comfort log** (`src/sim/comfort-log.ts`). Each answer is stored with the ship's peak motion during that minute: peak tilt, peak turn rate, peak horizontal and vertical acceleration, peak climb rate and speed. After leaving VR, the **Comfort CSV** link at the bottom left of the page downloads it. This turns "felt fine" into numbers that can become the flight model's hard limits.
- **A stop button.** **B** on the right controller stops the ship instantly and starts it again; the log marks those minutes as stopped. Testers should know about it before they start.
- **Limits between the named profiles.** `?speed=`, `?turn=`, `?climb=`, `?tilt=` and `?gust=` override one limit of the chosen profile, for example `?motion=tour&tilt=2` flies the tour with half the tilt.
- **A world that doesn't run out.** The islands and clouds now repeat every 2 km in each direction (`src/sim/world-tile.ts`). Before, the gentle and tour profiles flew about 4 km in 15 minutes and left every island and cloud behind after about 3 minutes, so the later minutes of a comfort test would have been an empty sky, with no motion cues at all. Each island is moved to the far side only where the fog already hides it, so nothing pops.
- **Session labels.** `?label=Sam-tour` writes "Sam-tour" into every row of both the comfort and the perf CSV, so files from several testers stay apart.

## The profiles

Measured over 15 minutes of flight with the comfort log:

| Profile | Speed | Peak tilt | Peak turn rate | Peak horizontal acceleration | Peak climb |
| --- | --- | --- | --- | --- | --- |
| gentle | 5 m/s | 2° | 3°/s | 0.5 m/s² | 0.8 m/s |
| tour | 7 m/s | 4° | 6°/s | 1.0 m/s² | 1.5 m/s |
| lively | 10 m/s | 7° | 10°/s | 2.4 m/s² | 2.5 m/s |

The gondola never moves under the player's feet; only the world outside moves and the horizon tilts. What can make people sick is seeing that motion without feeling it, mostly turning and changes of speed.

## Protocol

- **Testers:** five or more, including at least one person who gets carsick or has felt sick in VR before. Nobody should test while unwell, tired or after alcohol.
- **One profile per session, 15 minutes, seated or standing as the tester prefers.** Start everyone on `gentle`. A tester who stays at 0–2 throughout moves to `tour` in their next session, then `lively`. Leave at least an hour between sessions for the same person, and preferably a day, because sickness carries over.
- **Stop rule:** a rating of 10 or more, or any wish to stop, ends the session: press B, take the headset off and sit down. Record the minute.
- **Read the result as:** a profile is comfortable for a tester if they never rated above 4 and ended below 3. The profile passes if most testers, including the sensitive one, find it comfortable.

## Headset steps

1. On the Quest, open this address in the Quest Browser, with the tester's name in place of NAME: `https://henderjj.github.io/patchwork-airship-vr/?motion=gentle&comfort=60&label=NAME-gentle`. Use `motion=tour` or `motion=lively` and change the label to match for later sessions.
2. Before entering VR, tell the tester: once a minute a sign asks how they feel from 0 to 20; the right trigger goes up, the left trigger goes down and A answers; B stops the ship at once.
3. Enter VR and fly for 15 minutes. In the middle, ask the tester to walk around the deck for a minute, then to move with the left thumbstick, then to teleport with the right thumbstick (push up, aim, release), and say which felt best while the ship was moving. That answers the plan's open question on how players get around the deck.
4. After 15 minutes, leave VR, click **Comfort CSV** at the bottom left of the page, and send me the file along with anything the tester said. The perf **CSV** link in the bottom-right box is worth sending too.
5. To compare framing, run a session with `&clouds=100` (more clouds passing close) and see if ratings change against the same profile.

When the files are in, I'll turn the most comfortable profile into hard limits for the flight model, update the plan, and write the decision here.
