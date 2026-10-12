# Cargo (Phase 3)

From the concept: "One cranks the winch; the other guides the swinging crate by a tag rope. Both lift it aboard and choose where to stow it", and "fragile cargo that breaks on hard docking or heavy tilt". Each run is a delivery, scored on time, cargo condition and fuel. This first slice carries one crate from island A to island B and lowers it through a hatch in the deck once the ship is made fast at B's post ([docking.md](docking.md)). Loading a crate, carrying it about the deck to stow it, and trim from where it is stowed come in the next slice (see "Later").

## How it plays

1. **The crate rides in the hatch.** A 0.5 m square cargo hatch in the deck on the starboard side, between the burner and the tiller, opens into a short wooden trunk through the hull with a door at its bottom. The crate (40 cm square, 36 cm tall, rope-handled, stencilled FRAGILE) rides in the trunk on the closed door, its top level with the deck, hooked to the hoist line. The line runs from the hook up to a block on a small derrick arm above the hatch, across to the derrick post in the stern starboard corner, and down to the winch drum on the post's foot.
2. **Coming in.** Fly the route and make fast at B's post as before. The crate is delivered to the cargo stage: a plank platform on a small floating rock 6 m below the end of B's jetty, big enough that the hatch of a ship made fast at the post is always over it. Setting the crate down on the jetty also counts.
3. **Opening the hatch.** The hatch lever stands at the hatch's forward starboard corner. Pull it back towards the stern and the door drops open under the crate, which now hangs on the line. With slack in the line (the winch turned the lowering way while the door was shut), the crate drops onto the line with a jolt and is knocked. Push the lever forward to shut the door again; it only shuts once the crate is back up in the trunk or has been delivered.
4. **The winch.** One handle on the drum, beside the derrick post. Squeeze on its grip and turn it: towards the stern over the top lowers away, the other way hoists. The drum is pawled, so the line only moves while the handle turns, at most about 0.6 m a second. The cargo sign on the derrick post says how much further the crate has to go, whether it is swinging, and its condition.
5. **The tag line.** A light line from the crate's corner, its end a wooden toggle hung on a brass ring at the hatch's forward port corner. Take the toggle and hold it over the hatch: the line steadies the crate and draws it gently towards the point under your hand. Let go and the toggle goes back on its ring (the line pays out freely from there and doesn't steady anything).
6. **Below the hull,** eddies in the wind round B's rock buffet the crate, so it swings on a long line, more the stronger the wind (the game menu's Practice → Wind). Without a hand on the tag line it keeps swinging; held still over the hatch, the line damps it in a few seconds. The crate also swings while it passes through the trunk if the ship moves; scraping the trunk's sides knocks it.
7. **Setting it down.** Lower it slowly onto the stage. Touching down faster than 0.2 m/s, or swinging faster than 0.15 m/s sideways, knocks it. Once it rests on the stage (or the jetty), pay out a little more line (30 cm of slack) and the hook slips out of its sling: delivered. The ship is 60 kg lighter from then on.
8. **Finishing.** The run finishes once the ship has been made fast for 3 s and the crate has been delivered, in either order. The board says "LOWER THE CRATE" while the ship is fast and the crate isn't down yet.

One person can do all of it (a hand on the winch, the other on the tag line, both within reach from the winch's place beside the tiller post), but it is far easier as a pair: one winches, the other watches the crate through the hatch and steadies it.

## Condition and score

The crate starts at 100%. Each knock takes off a share for how hard it was: a touchdown 100 points per m/s over 0.2 m/s going down and 60 per m/s over 0.15 m/s sideways; a scrape in the trunk 40 per m/s over 0.15 m/s; a drop onto the line (opening the door on slack line) 60 per m of slack over 10 cm. The board shows the condition. The score loses 4 points per percent lost (a smashed crate costs 400): 1000, less 2 per second, 15 per fuel brick, 150 per missed ring, 100 per tear-off and 4 per percent of the crate lost. Stars as before (three from 600, two from 450, one from 250).

## Under the hood

- **`src/sim/cargo.ts`** (engine-free): the gondola's cargo fittings (hatch, trunk, block, winch, lever, tag ring), the winch (a handle that follows the hand around its axle, limited in speed, pawled), and `CargoSim`: the crate as a weight on a line from the block, simulated in ship space under the felt gravity (so the ship's turns and speed changes swing it), with air drag from the wind relative to the ship, eddies below the keel scaled by the wind setting, the tag line's pull, the trunk's walls and the door, touchdown on whatever is below (islands, the cargo stage, the jetty), knocks and the condition they cost, and delivery.
- **`src/systems/cargo-system.ts`**: the hands (winch handle, lever, tag toggle), stepping the sim on the host, drawing the crate, door, line, hook, tag line and winch, the cargo sign, sounds (winch clicks, thumps on knocks, creaks while it swings) and controller pulses.
- **Network.** The host runs the crate and sends it 30 times a second (a 35-byte cargo packet: phase, door, winch and lever angles, the crate's ship-space position and sideways velocity, condition, a knock count so the guest hears each knock, and a restart count). The guest sends its hands on the gear 30 times a second while it holds any of it (a 16-byte packet: which gear it holds, its winch and lever angles, where its hand on the tag line is); the host takes the guest's winch and lever unless its own hand is on them. The guest's own winch handle and lever follow its hand at once and ease back to the host's when let go. Each player's pose packet also says which gear each hand holds (three more hold kinds: 7 winch, 8 tag line, 9 hatch lever), so the crewmate's hands are drawn on it and the other player can't take the same handle.
- **Route.** `RouteRun.step` takes whether the crate has been delivered and its condition; `scoreRun` counts the condition. The cargo stage is one more island of the route (`CALM_SKIES.cargo`), so the ship and the grapple can land on it or run into it.
- **Trim.** While aboard (in the trunk or on the line) the crate leans the ship like a crew member of 0.8 times the weight standing over the hatch; delivered, it is gone.

## Cost

On deck: the crate (about 100 triangles), the hatch door, the winch drum and handle, the hoist line below the block, the tag line, the hook, the tag line's toggle and the lever: eight draw calls, plus the cargo sign. The derrick, block, trunk and coaming are merged into the gondola's two static meshes. In the world, the cargo stage and its rock are merged into the jetty's mesh. Nothing is allocated per frame.

## Tests

- Unit tests (`test/cargo.test.ts`): the crate starts aboard at 100%; the winch follows the hand no faster than it turns and lets go of a hand that runs away; it can't be lowered through a shut door, and opening the door on slack line knocks it while on a taut line it doesn't; lowered steadily it lands softly on the cargo stage and is delivered once the line is slack (and not before); lowered fast it is knocked; it swings in the eddies, more in stronger wind, and a hand on the tag line steadies it; a swinging crate scrapes the trunk when hoisted; the hatch of a ship made fast at the post is over the stage whichever way round the post it lies. `test/route.test.ts`: made fast without the crate delivered doesn't finish; with it, it does, and the score counts its condition. `test/net.test.ts`: both cargo packets round-trip.
- Emulated headset (`npm run test:xr`): made fast, the run waits and the board says to lower the crate; a real emulated hand pulls the lever aft and the door opens; scripted hands on the winch and tag line lower the crate onto the stage and it is delivered; the run finishes with "DELIVERED!" and the crate's condition on the board; the menu's practice cargo start puts the ship made fast at B with the crate aboard. Screenshots: `xr-cargo-gear.png`, `xr-cargo-lowering.png`.
- Two players (`npm run test:net`): the guest's hand on the lever opens the hatch on the host; the guest winds the crate down while the host holds the tag line, both pages agree on where it is, and both see the run finish with the same condition.

## Practice

The game menu (Y on the left controller) has **Practice → Cargo: Start made fast at B**: a fresh run, both rings counted, the ship already made fast at B's post (line 1.2 m, level), the crate aboard. Lower it to finish the run. In a crew, the guest's press asks the host (a `route-cargo` event).

## Headset check

1. Game menu → Practice → Cargo: Start made fast at B (or fly the route and make fast).
2. Find the hatch on the starboard side between the burner and the tiller, with the crate in it. Stand beside the tiller post facing the hatch: the winch handle is at your right hand by the derrick post, the tag line's toggle on its ring at the hatch's forward port corner.
3. Pull the hatch lever (forward starboard corner of the hatch) back towards the stern: the door drops open.
4. Take the tag line's toggle in your left hand and hold it over the hatch. Turn the winch handle (top towards the stern) with your right to lower away; watch the crate through the hatch and the cargo sign.
5. Slow down for the last metre (the sign counts down), set it on the stage, and turn a little more until the hook slips free. The board shows the score with the crate's condition.
6. Try it again without the tag line and with the wind on Double, to see the swing.

What would help: whether the hatch, lever, winch and tag line read clearly as what they are; whether lowering feels heavy enough; whether the swing is fair at Normal wind; and whether the condition costs feel right.

## Later

- Loading at A: a crate on A's pad to winch up while holding the ship over it, then lift it out of the hatch together and stow it.
- Carrying and stowing crates on deck (a two-handed lift, heavy enough to want two people), lashing them, and trim from where they're stowed; loose crates sliding in hard turns.
- Fragile cargo knocked by a hard landing or a heavy tilt, and contracts with more than one crate.
- The practice crewmate taking the tag line while the player winches.
