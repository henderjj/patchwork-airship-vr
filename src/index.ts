import { PhysicsSystem, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { PanelSystem } from './panel.js';
import { ComfortSystem } from './systems/comfort-system.js';
import { ControlsSystem } from './systems/controls-system.js';
import { RouteSystem } from './systems/route-system.js';
import { AudioSystem } from './systems/audio-system.js';
import { CrankSystem } from './systems/crank-system.js';
import { CrewStatusSystem } from './systems/crew-status-system.js';
import { DeckWalkSystem } from './systems/deck-walk-system.js';
import { FrameRateSystem } from './systems/frame-rate-system.js';
import { GondolaSystem } from './systems/gondola-system.js';
import { GripSystem } from './systems/grip-system.js';
import { NetSystem } from './systems/net-system.js';
import { OwnHandsSystem } from './systems/own-hands-system.js';
import { PerfHudSystem } from './systems/perf-hud-system.js';
import { PlatformSystem } from './systems/platform-system.js';
import { RopeSystem } from './systems/rope-system.js';
import { ShipSystem } from './systems/ship-system.js';
import { SignsSystem } from './systems/signs-system.js';
import { SkyWorldSystem } from './systems/sky-world-system.js';
import { ThrowablesSystem } from './systems/throwables-system.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  // The perf HUD runs first so it can time everything after it.
  world.registerSystem(PerfHudSystem, { priority: -100 });
  world.registerSystem(FrameRateSystem);
  world.registerSystem(ShipSystem, { priority: -10 });
  // Before the crank, rope and throwables, which read its grip state.
  world.registerSystem(GripSystem, { priority: -5 });
  world.registerSystem(SkyWorldSystem);
  world.registerSystem(ComfortSystem);
  world.registerSystem(GondolaSystem);
  world.registerSystem(NetSystem);
  world.registerSystem(DeckWalkSystem);
  world.registerSystem(OwnHandsSystem);
  // After NetSystem, which updates the crew presence it shows.
  world.registerSystem(CrewStatusSystem);
  // After NetSystem, so it sees the crewmate's pose drawn this frame.
  world.registerSystem(CrankSystem);
  world.registerSystem(RopeSystem);
  // After the crank and rope, so it knows which hands they hold; it also
  // sees the crewmate's pose for trim.
  world.registerSystem(ControlsSystem);
  world.registerSystem(RouteSystem);
  world.registerSystem(SignsSystem);
  // After the ship, crank and route have moved on this frame.
  world.registerSystem(AudioSystem);
  // After the crank, rope and controls, so it knows which hands they hold.
  world.registerSystem(ThrowablesSystem);
  world.registerSystem(PanelSystem);
  world.registerSystem(PlatformSystem);
  // Handles for the automated XR tests.
  (window as unknown as { __debug: unknown }).__debug = { world, PhysicsSystem };
});
