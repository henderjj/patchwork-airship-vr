import { type BufferGeometry, Mesh, MeshLambertMaterial, type Object3D, Vector3 } from '@iwsdk/core';
import { describe, expect, it } from 'vitest';
import * as avatar from '../src/scene-assets/avatar.scene-asset.js';
import * as cargo from '../src/scene-assets/cargo.scene-asset.js';
import * as controls from '../src/scene-assets/controls.scene-asset.js';
import * as crank from '../src/scene-assets/crank.scene-asset.js';
import * as pump from '../src/scene-assets/pump.scene-asset.js';
import * as repairs from '../src/scene-assets/repairs.scene-asset.js';
import * as gondola from '../src/scene-assets/gondola.scene-asset.js';
import * as rope from '../src/scene-assets/rope.scene-asset.js';
import { HATCH, HATCH_CENTER, LEVER_PIVOT, TRUNK_DEPTH, WINCH_AXLE } from '../src/sim/cargo.js';
import { PATCH_MAX, PATCH_MIN, RIVETS, rivetPoint, TEAR_MAX, TEAR_SPOTS, TEAR_START } from '../src/sim/envelope.js';
import { HAMMER_REST } from '../src/sim/rigging.js';
import { PUMP_PIVOT, PUMP_SWING } from '../src/sim/gondola-layout.js';
import { WATER_DEPTHS } from '../src/sim/weather.js';
import { CALM_SKIES } from '../src/sim/route.js';
import * as passages from '../src/world/passage-assets.js';
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

  it('on the bilge pump, with its lever up, level and down (storms)', () => {
    for (const angle of [-PUMP_SWING, 0, PUMP_SWING]) {
      const lever = pump.createPumpLever();
      lever.position.set(...PUMP_PIVOT);
      lever.rotation.z = -angle;
      const rod = pump.createPumpRod();
      rod.position.set(PUMP_PIVOT[0] + pump.ROD_ARM * Math.cos(angle), PUMP_PIVOT[1] - pump.ROD_ARM * Math.sin(angle), PUMP_PIVOT[2]);
      lever.updateMatrixWorld();
      rod.updateMatrixWorld();
      expectNone([...gondolaAtRest(), pump.createPumpBody(), lever, rod], DECK_GAP, onDeck);
    }
  });

  it('on the water lying on deck in a storm, at each depth it is drawn at', () => {
    for (const depth of WATER_DEPTHS) {
      const water = pump.createDeckWater();
      water.position.y = depth;
      water.updateMatrixWorld();
      expectNone([...gondolaAtRest(), pump.createPumpBody(), water], DECK_GAP, onDeck);
    }
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
      repairs.createHammer(),
      repairs.createPatchInHand(),
      pump.createPumpLever(),
      pump.createPumpRod(),
    ];
    for (const prop of props) {
      expectNone([prop], DECK_GAP);
    }
  });

  it('on the envelope: tears, patches, rivets and their marks on its belly, and the hammer on its pegs', () => {
    const canvas = repairs.envelopeUnderside();
    const rigging = gondola.createGondolaRigging();
    const hammer = repairs.createHammer();
    hammer.position.set(...HAMMER_REST);
    hammer.updateMatrixWorld();
    expectNone([rigging, hammer], DECK_GAP, onDeck);
    for (let i = 0; i < TEAR_SPOTS.length; i++) {
      for (const [length, held] of [[TEAR_START, 0], [TEAR_MAX, 0], [TEAR_MAX, 1]]) {
        const tear = repairs.createTear();
        repairs.layTear(tear, canvas, TEAR_SPOTS[i], { length, held, time: 0.3 });
        expectNone([rigging, tear], DECK_GAP, onDeck);
      }
      for (const patchLength of [PATCH_MIN, PATCH_MAX]) {
        const patch = repairs.createPatch();
        repairs.layPatch(patch, canvas, TEAR_SPOTS[i], patchLength, 0);
        // Its rivets, set, as RepairSystem draws them, and the rings round them before they are set.
        const rivets: Mesh[] = [];
        const marks: Mesh[] = [];
        const at = { x: 0, y: 0, z: 0 };
        const down = new Vector3();
        for (let r = 0; r < RIVETS; r++) {
          const rivet = new Mesh(repairs.createRivets().geometry, material);
          rivetPoint(canvas, TEAR_SPOTS[i], patchLength, r, at);
          rivet.position.set(at.x, at.y, at.z);
          rivet.updateMatrixWorld();
          rivets.push(rivet);
          const e = 0.02;
          down.set((canvas(at.x + e, at.z) - canvas(at.x - e, at.z)) / (2 * e), -1, (canvas(at.x, at.z + e) - canvas(at.x, at.z - e)) / (2 * e)).normalize();
          const mark = new Mesh(repairs.createRivetMarks().geometry, material);
          mark.position.set(at.x, at.y, at.z).addScaledVector(down, repairs.MARK_DROP);
          mark.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), down);
          mark.updateMatrixWorld();
          marks.push(mark);
        }
        expectNone([rigging, patch, ...rivets], DECK_GAP, onDeck);
        expectNone([rigging, patch, ...marks], DECK_GAP, onDeck);
      }
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

  it("on the route's lamps (storms and night), where they stand on the rings, passages, islands and mooring post", () => {
    const lamps = route.routeLamps(CALM_SKIES);
    const placed = (m: Mesh, x: number, y: number, z: number, yaw = 0) => {
      m.position.set(x, y, z);
      m.rotation.y = yaw;
      return m;
    };
    const jetty = route.jettyPlacement(CALM_SKIES);
    const dock = CALM_SKIES.dock;
    const a = CALM_SKIES.start;
    const objects: Object3D[] = [
      mesh(route.createRouteLampIronGeometry(lamps), 'Lamp Iron'),
      mesh(route.createRouteLampGlassGeometry(lamps), 'Lamp Glass'),
      ...CALM_SKIES.rings.map((ring, i) => placed(mesh(route.createRingGeometry(ring.radius), `Ring ${i + 1}`), ring.x, ring.y, ring.z, ring.yaw)),
      ...CALM_SKIES.passages.map((p) => placed(mesh(passages.createPassageGeometry(p), p.name), p.x, passages.passageBase(p), p.z, p.yaw)),
      placed(mesh(route.createLandingIslandGeometry(a, 0xc8402c, 1, CALM_SKIES.loading), 'Island A'), a.x, a.y, a.z),
      placed(mesh(route.createJettyGeometry(jetty.length, dock.height, jetty.stage), 'Jetty'), dock.x, dock.y, dock.z, jetty.turn),
    ];
    expectNone(objects, WORLD_GAP);
  });

  it('on the passages: the Cleft and the Arch, with its painted band', () => {
    for (const passage of CALM_SKIES.passages) {
      expectNone([mesh(passages.createPassageGeometry(passage), passage.name)], WORLD_GAP);
    }
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
