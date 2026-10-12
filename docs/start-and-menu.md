# Start screen and game menu

John asked on 2026-10-10 to move choosing how to play from the browser page into VR, to show nothing in front of the player once a game has started (the old in-VR welcome dialog blocked the view), and to have a settings menu on a button press with exit, in-game settings and multiplayer settings such as muting yourself or the other player.

## Getting into a game

The browser page keeps only what has to happen in the browser: **Enter VR** with the line under it that says how a start is going (the PC VR hints from [spikes/s8-pcvr.md](spikes/s8-pcvr.md)), **Allow microphone** (a permission prompt inside VR is easy to miss), a line saying how the crew is doing, a **Game menu** button and the **Start-up settings** that reload the page.

When VR starts, the start screen (`public/ui/start.uikitml`, `src/systems/start-screen-system.ts`) stands a metre in front of the player, a little below eye level, and is picked with either controller's ray and trigger. It is drawn over the world, so the gondola's controls never cut through it, and if the player turns well away from it, it moves back in front of them. On a browser without a headset it shows on the page and takes the mouse, so a desktop crewmate or the practice crewmate's PC page uses the same screen.

- **Play solo** closes it and the game is on.
- **Solo with the practice crewmate** starts a crew and shows its code with a link (`?room=CODE&bot=1`) to open on a PC, which then plays the second player (see the README's practice crewmate section).
- **Start a crew** makes a four-letter code to give a friend.
- **Join a crew** shows a keypad of the 23 letters codes use; on a PC the keyboard types too. On a page without a headset, **Join as practice crewmate** reloads the page as the bot in that crew.

In a crew the crew page says what is happening (joining, waiting, connecting, full, or the lobby's error). Once the crewmate is aboard it says so for a moment and closes by itself; **Play while waiting** closes it without waiting, and **Leave crew** goes back. A page opened from a link with a crew code goes straight to the crew page, and the practice crewmate's page never shows the screen.

## The game menu

**Y** on the left controller opens and closes the game menu (`public/ui/menu.uikitml`, `src/systems/game-menu-system.ts`) in front of the player. The menu button (≡) does too where the browser passes it on, but John pointed out that SteamVR and others often keep that button, so Y is the one to rely on. On a PC page, **M** or the **Game menu** button opens it and **Escape** closes it. Nothing pauses while it is open.

### How it should look and work

John's first headset try (2026-10-11) found the menu worked but was hard to use: every setting was one button that stepped through its choices, so you couldn't see the choices, the coat colour was a name rather than a colour, and getting to a height meant pressing round a loop. The redesign follows a few rules:

- **See every choice, pick it in one press.** A controller ray is less precise and slower than a mouse, so each press should land where the player wants. Every setting with up to four choices shows them all as a row of buttons with the one in effect filled in. Nothing in the menu needs more than four, so there are no drop-down lists: a list needs two accurate presses, opens over the rows below it and can be left hanging open in VR.
- **Show things as what they are.** Coat colours are round swatches of the colour, with a dark ring round the one you wear. They have no hover outline: in John's headset try the ray's hover outline stayed on every swatch it had touched, which read as several selected.
- **Numbers step.** Character height is **−** and **+** in 5 cm steps (1.40 to 2.00 m) with the height between them, and a **Your own** button that goes back to your real height. From your own height the first press goes to the next 5 cm either side of it, and the box shows your measured height so you know where you are starting from.
- **Short labels, grouped.** Rows sit under three headings, **Crew** (only in a crew), **You** and **Sound and view**, with a label on the left and the choices in a column on the right, so the eye runs straight down the choices.
- **Changes apply at once and are kept.** There is no Save or Apply; each press takes effect while you watch and is kept in the browser for next time. Settings that need a reload stay on the page's **Start-up settings**.
- **Far enough to take in at a glance.** The menu opens 1.3 m in front of you (it was 0.9 m, which John found too close to see the whole panel), 0.2 m below eye level.
- **One panel, no pages.** All of it fits on one panel about as tall as the old one, so nothing is hidden behind a tab. If it grows past about a dozen rows, the next step is tabs along the top for the three groups.

The rows:

| Group | Setting | Choices |
| --- | --- | --- |
| Crew | My microphone | On, Muted (says Off or Unavailable instead when the microphone isn't open) |
| Crew | Crewmate's voice | On, Muted (for you only: their incoming audio is turned off) |
| You | Coat colour | Eight swatches |
| You | Playing | Standing, Seated (seated lifts your view to standing eye height) |
| You | Character height | − and + in 5 cm steps, Your own |
| Sound and view | Ship sounds | On, Off (off suspends the audio) |
| Sound and view | Control labels | Hold A, Always |
| Sound and view | Perf HUD (X) | On, Off (X does it too) |
| Sound and view | Frame rate (Hz) | 72, 80, 90, 120 (asked of the headset at once) |
| Sound and view | Foveation | Off, Half, Full |
| Sound and view | Comfort question | Never, 1 min, 2 min, 5 min |

Under **Practice**, **Start beside B's post** (Docking) starts a fresh run already under way beside island B's mooring post, both rings counted as flown, the deck level with the post's top and its port side 5 m off it, so docking can be tried without flying the route ([docking.md](docking.md)). In a crew, the guest's press asks the host, who flies the ship for both.

Below them, **Back to start screen** leaves any crew and shows the start screen, and **Exit VR** ends the session. A line at the bottom reminds the player of the controller buttons.

In code, the crew, Playing and live-setting rows are `CHOICE_ROWS` in the menu system; the live settings come from `LIVE_ITEMS` in `src/live-settings.ts`, applied by the system that owns each from `onSettingChange`. A new live setting is one `LIVE_ITEMS` entry (up to four choices) plus a `row-<key>` row in the panel. Height steps are `stepHeight` in `src/game-flow.ts`.

### Control labels

The painted signs on the gondola's controls (burner, vent, bell, mooring line, ballast, tiller, crank, fuel) are hidden unless **A** on the right controller (or **L** on a PC page) is held; John found the vent's sign distracting right in front of the start screen. **Control labels: Always** in the menu keeps them shown, for a first flight. The comfort question also answers with A, so holding A to answer it shows the labels for that moment.

Settings read once as the game loads (how the ship moves, the crewmate's voice mode, clouds, rain, shadows) stay under **Start-up settings** on the page, since changing them reloads it.

## Checks

Unit tests cover the words on the crew page and the menu, typing a code, the height steps, and saving the in-game settings. The emulated-headset test (`npm run test:xr`) checks the control signs are hidden until A is held, the start screen stands in front of the player when VR starts and a controller ray click on **Play solo** closes it, then that Y opens the menu in front of the player, the ray turns the ship's sounds off and on, picks seated and standing play, steps the height 5 cm and goes back to your own, and Y closes it. The two-player test (`npm run test:net`) checks a crew link's start screen closes once the crewmate is aboard, joining a crew from the keypad, muting yourself and the crewmate from the menu, picking a coat swatch, the sounds and character height settings saving at once, and the start-up settings keeping the menu's choices when they reload the page.

## Headset check

1. Open the game in Quest Browser (Ctrl+Shift+R on a PC if the old page shows) and press **Enter VR** on the page. The start screen should stand in front of you with no signs on the controls around it.
2. Hold **A** on the right controller: the signs should appear, and go when you let go. Point at **Play solo** and pull the trigger.
3. Press **Y** on the left controller. In the menu, try a coat swatch (your hands' cuffs change), **Seated** and **Standing**, **+** and **−** on the height (5 cm a press, the box shows the height) and **Your own**, **Control labels: Always**, and the frame rate (the wrist HUD shows the new Hz). Say whether anything is hard to hit with the ray or hard to read. Press Y again to close it.
4. With a second player or the practice crewmate, try **My microphone: Muted** and **Crewmate's voice: Muted**.
