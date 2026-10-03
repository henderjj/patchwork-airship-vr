import { PhysicsSystem, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { PanelSystem } from './panel.js';
import { FrameRateSystem } from './systems/frame-rate-system.js';
import { GondolaSystem } from './systems/gondola-system.js';
import { NetSystem } from './systems/net-system.js';
import { PerfHudSystem } from './systems/perf-hud-system.js';
import { ShipSystem } from './systems/ship-system.js';
import { SkyWorldSystem } from './systems/sky-world-system.js';
import { ThrowSystem } from './systems/throw-system.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  // The perf HUD runs first so it can time everything after it.
  world.registerSystem(PerfHudSystem, { priority: -100 });
  world.registerSystem(FrameRateSystem);
  world.registerSystem(ShipSystem, { priority: -10 });
  world.registerSystem(SkyWorldSystem);
  world.registerSystem(GondolaSystem);
  world.registerSystem(ThrowSystem);
  world.registerSystem(NetSystem);
  world.registerSystem(PanelSystem);
  // Handles for the automated XR tests.
  (window as unknown as { __debug: unknown }).__debug = { world, PhysicsSystem };
});
