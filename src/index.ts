import { PhysicsSystem, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { PanelSystem } from './panel.js';
import { CrankSystem } from './systems/crank-system.js';
import { FrameRateSystem } from './systems/frame-rate-system.js';
import { GondolaSystem } from './systems/gondola-system.js';
import { GripSystem } from './systems/grip-system.js';
import { NetSystem } from './systems/net-system.js';
import { PerfHudSystem } from './systems/perf-hud-system.js';
import { PlatformSystem } from './systems/platform-system.js';
import { RopeSystem } from './systems/rope-system.js';
import { ShipSystem } from './systems/ship-system.js';
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
  world.registerSystem(GondolaSystem);
  world.registerSystem(NetSystem);
  // After NetSystem, so it sees the crewmate's pose drawn this frame.
  world.registerSystem(CrankSystem);
  world.registerSystem(RopeSystem);
  // After the crank and rope, so it knows which hands they hold.
  world.registerSystem(ThrowablesSystem);
  world.registerSystem(PanelSystem);
  world.registerSystem(PlatformSystem);
  // Handles for the automated XR tests.
  (window as unknown as { __debug: unknown }).__debug = { world, PhysicsSystem };
});
