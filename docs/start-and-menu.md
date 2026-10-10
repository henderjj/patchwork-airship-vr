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

The menu button on the left controller (≡) opens and closes the game menu (`public/ui/menu.uikitml`, `src/systems/game-menu-system.ts`) in front of the player; a press of the left thumbstick does too, in case a browser keeps the menu button to itself. On a PC page, **M** or the **Game menu** button opens it and **Escape** closes it. Nothing pauses while it is open.

- In a crew: the crew's state, **My mic** (mute or unmute yourself; Y still does it too) and **Crewmate** (turn their voice off for you only, by disabling their incoming audio track).
- Coat colour, then the settings that apply straight away, each a button that steps through its choices: ship sounds (off suspends the audio), perf HUD (X does it too), frame rate (asked of the headset at once), foveation and the comfort question. The rows come from `LIVE_ITEMS` in `src/live-settings.ts`; adding an item there adds a row (the panel has eight), and the system that owns the setting applies it from `onSettingChange`. Choices are kept in the browser with the start-up settings.
- **Back to start screen** leaves any crew and shows the start screen; **Exit VR** ends the session.

Settings read once as the game loads (how the ship moves, the crewmate's voice mode, clouds, rain, shadows) stay under **Start-up settings** on the page, since changing them reloads it.

## Checks

Unit tests cover the words on the crew page and the menu, typing a code, and stepping and saving the in-game settings. The emulated-headset test (`npm run test:xr`) checks the start screen stands in front of the player when VR starts and that a controller ray click on **Play solo** closes it, then that the left thumbstick opens the menu in front of the player, the ray turns the ship's sounds off and on, and the thumbstick closes it. The two-player test (`npm run test:net`) checks a crew link's start screen closes once the crewmate is aboard, joining a crew from the keypad, muting yourself and the crewmate from the menu, the coat colour from the menu, the sounds setting saving at once, and the start-up settings keeping the menu's choices when they reload the page.

## Headset check

1. Open the game in Quest Browser and press **Enter VR** on the page. The start screen should stand in front of you; nothing else should float in view.
2. Point at **Play solo** and pull the trigger. The screen goes and the game is on.
3. Press the menu button (≡) on the left controller. The menu should open in front of you. Try **Ship sounds** and **Frame rate** (the wrist HUD shows the new Hz), then press the menu button again to close it. If the menu button does nothing, press the left thumbstick in instead and say so.
4. **Back to start screen**, then **Start a crew**, and join from a second device with **Join a crew** and the code. Both start screens should close by themselves once you're both aboard. In the menu, try **My mic** and **Crewmate** with the other player listening.
