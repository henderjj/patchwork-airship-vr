import { type BufferGeometry, Mesh, MeshLambertMaterial, type Object3D, type Vector3 } from '@iwsdk/core';
import { describe, expect, it } from 'vitest';
import * as avatar from '../src/scene-assets/avatar.scene-asset.js';
import * as cargo from '../src/scene-assets/cargo.scene-asset.js';
import * as controls from '../src/scene-assets/controls.scene-asset.js';
import * as crank from '../src/scene-assets/crank.scene-asset.js';
import * as gondola from '../src/scene-assets/gondola.scene-asset.js';
import * as rope from '../src/scene-assets/rope.scene-asset.js';
import { HATCH, HATCH_CENTER, LEVER_PIVOT, TRUNK_DEPTH, WINCH_AXLE } from '../src/sim/cargo.js';
import { CALM_SKIES } from '../src/sim/route.js';
import * as route from '../src/world/route-assets.js';
import * as sky from '../src/world/sky-assets.js';
import * as windAssets from '../src/world/wind-assets.js';
import { coplanarOverlaps, describeOverlaps, trianglesOf } from './support/coplanar.js';

/**
 * Z-fighting: two differently coloured faces facing the same way, in (nearly)
 * the same plane and overlapping, flicker through each other in the headset
 * as the head moves (the brick box's edges, the jetty's root, the crate's
 * edges and the hatch's edges all did). Keep faces like that at least this
 * far apart: 3 mm on and around the deck (seen from 0.3 to 3 m), 8 mm out in
 * the world (seen from 5 m and further). Docs: docs/testing.md#z-fighting.
 */
const DECK_GAP = 0.003;
const WORLD_GAP = 0.008;

const material = new MeshLambertMaterial({ vertexColors: true });
function mesh(geometry: BufferGeometry, name: string): Mesh {
  const m = new Mesh(geometry, material);
  m.name = name;
  return m;
}

/** Faces flat on the deck, facing down into it, can never be seen. */
const onDeck = (at: Vector3, n: Vector3) => n.y < -0.99 && Math.abs(at.y) < 0.005;

function expectNone(objects: Object3D[], gap: number, ignore?: (at: Vector3, n: Vector3) => boolean): void {
  const found = coplanarOverlaps(objects.flatMap((o) => trianglesOf(o)), gap, 2e-5, ignore);
  expect(found.length, `faces sharing a plane:\n${describeOverlaps(found)}`).toBe(0);
}

/** The gondola as it stands at the start of a run, with the cargo gear at rest where CargoSystem puts it. */
function gondolaAtRest(): Object3D[] {
  const crate = cargo.createCrate();
  crate.position.set(HATCH_CENTER[0], 0, HATCH_CENTER[1]);
  const door = cargo.createHatchDoor();
  door.position.set(HATCH.x0, -TRUNK_DEPTH, HATCH_CENTER[1]);
  const drum = cargo.createWinchDrum();
  drum.position.set(...WINCH_AXLE);
  const lever = cargo.createHatchLever();
  lever.position.set(...LEVER_PIVOT);
  return [gondola.createGondolaHull(), gondola.createGondolaRigging(), crate, door, drum, lever];
}

describe('no faces that flicker through each other (z-fighting)', () => {
  it('on the gondola, with the cargo gear in place', () => {
    expectNone(gondolaAtRest(), DECK_GAP, onDeck);
  });

  it('in each prop that moves about the deck', () => {
    const props: Object3D[] = [
      cargo.createCrate(),
      cargo.createHatchDoor(),
      cargo.createWinchDrum(),
      cargo.createHatchLever(),
      cargo.createCargoHook(),
      cargo.createTagToggle(),
      controls.createTillerBar(),
      controls.createVentToggle(),
      controls.createSandbag(0),
      controls.createLantern(),
      controls.createBell(),
      controls.createBellClapper(),
      controls.createBellToggle(),
      crank.createCrank(),
      crank.createPropeller(),
      rope.createGrapple(),
      gondola.createFuelBrick(),
    ];
    for (const prop of props) {
      expectNone([prop], DECK_GAP);
    }
  });

  it('on the crew', () => {
    for (const index of [0, 1]) {
      expectNone([avatar.createAvatarHead(index)], DECK_GAP);
      expectNone([avatar.createAvatarTorso(index)], DECK_GAP);
      expectNone([avatar.createAvatarLegs(index)], DECK_GAP);
    }
  });

  it('on the route: the jetty with its cargo stage, the landing islands, rings and beacons', () => {
    const jetty = route.jettyPlacement(CALM_SKIES);
    expectNone([mesh(route.createJettyGeometry(jetty.length, CALM_SKIES.dock.height, jetty.stage), 'Jetty')], WORLD_GAP);
    expectNone([mesh(route.createLandingIslandGeometry(CALM_SKIES.start, 0xc8402c, 1, CALM_SKIES.loading), 'Island A')], WORLD_GAP);
    expectNone([mesh(route.createLandingIslandGeometry(CALM_SKIES.finish, 0x3a6fc8, 2), 'Island B')], WORLD_GAP);
    expectNone([mesh(route.createRingGeometry(4), 'Ring')], WORLD_GAP);
    expectNone([mesh(route.createBeaconMastGeometry(6), 'Mast'), mesh(route.createBeaconLampGeometry(), 'Lamp')], WORLD_GAP);
  });

  it('on the wind: the wind socks (seen from the deck at island A) and the streaks of moving air', () => {
    const sock = mesh(windAssets.createWindSockGeometry(), 'Wind Sock');
    sock.position.y = windAssets.SOCK_POLE + 0.1;
    for (const droop of [0, windAssets.SOCK_MAX_DROOP]) {
      sock.rotation.z = -droop;
      sock.updateMatrixWorld();
      expectNone([mesh(windAssets.createWindSockPoleGeometry(), 'Wind Sock Pole'), sock], DECK_GAP);
    }
    expectNone([mesh(windAssets.createStreakGeometry(5, 0.4, 0xffc65c, true), 'Draft Streak')], WORLD_GAP);
    expectNone([mesh(windAssets.createStreakGeometry(6, 0.2, 0xffffff, false), 'Gust Streak')], WORLD_GAP);
  });

  it('on the scenery islands and clouds', () => {
    // Unit-sized shapes, drawn at least 8 m across and 6.4 m high (src/sim/islands.ts).
    const smallest = (m: Mesh) => (m.scale.set(8, 6.4, 8), m);
    for (let seed = 1; seed <= 8; seed++) {
      const variant = sky.createIslandVariant(seed);
      expectNone([smallest(mesh(variant.high, `Island ${seed}`))], WORLD_GAP);
      expectNone([smallest(mesh(variant.low, `Island ${seed} far`))], WORLD_GAP);
      expectNone([mesh(sky.createCloudGeometry(seed), `Cloud ${seed}`)], WORLD_GAP);
    }
  });

  it('catches two boxes painted different colours sharing a face', async () => {
    const { BoxGeometry } = await import('@iwsdk/core');
    const { mergeParts } = await import('../src/scene-assets/lowpoly.js');
    const flush = mesh(mergeParts([
      { geometry: new BoxGeometry(1, 0.1, 1), color: 0x804020, position: [0, -0.05, 0] },
      { geometry: new BoxGeometry(0.2, 0.1, 0.2), color: 0x202020, position: [0, -0.05, 0] },
    ]), 'flush');
    expect(coplanarOverlaps(trianglesOf(flush), DECK_GAP).length).toBeGreaterThan(0);
    const proud = mesh(mergeParts([
      { geometry: new BoxGeometry(1, 0.1, 1), color: 0x804020, position: [0, -0.05, 0] },
      { geometry: new BoxGeometry(0.2, 0.108, 0.2), color: 0x202020, position: [0, -0.05, 0] },
    ]), 'proud');
    expect(coplanarOverlaps(trianglesOf(proud), DECK_GAP).length).toBe(0);
  });
});
