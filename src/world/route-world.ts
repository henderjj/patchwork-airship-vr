import type { GroundAt } from '../sim/cargo.js';
import { KEEL_DEPTH } from '../sim/gondola-layout.js';
import { groundBelow, layoutIslands } from '../sim/islands.js';
import { CALM_SKIES, distanceFromRoute, JETTY_TOP, onJetty, onLoadingStage, routeIslands } from '../sim/route.js';
import { wrapNear } from '../sim/world-tile.js';
import { settings } from '../settings.js';

/** The route this build flies (Phase 2 has one). */
export const ROUTE = CALM_SKIES;
export const ROUTE_ISLANDS = routeIslands(ROUTE);
/**
 * The route's islands the ship itself can rest on and run into: not the
 * cargo stage, which only fends the ship off (`fendOff` in src/sim/islands.ts).
 * Crates, the grapple and a hanging line still land on it (ROUTE_ISLANDS).
 */
export const SHIP_ISLANDS = ROUTE_ISLANDS.filter((island) => island !== ROUTE.cargo);

/** Scenery islands stay this far (plus their radius) from the route's path, m. */
const ROUTE_CLEARANCE = 45;

/**
 * The scenery islands, laid out once from the URL's seed and count, clear of
 * the route. The sky draws them and the ship can rest on or run into them,
 * so host and guest must use the same `?seed=` and `?islands=`.
 */
export const sceneryIslands = layoutIslands(settings.seed, settings.islands, (x, z, radius) => distanceFromRoute(ROUTE, x, z) > radius + ROUTE_CLEARANCE);

/**
 * What is under a point in the world for a crate (Phase 3 cargo): the
 * route's islands (B's top and the cargo stage are where crates are
 * delivered), the scenery islands, B's jetty and A's loading stage.
 */
export const cargoGround: GroundAt = (x, z, fromY, out) => {
  out.y = Number.NEGATIVE_INFINITY;
  out.delivery = false;
  for (const island of ROUTE_ISLANDS) {
    const r = island.radius * 0.92;
    if ((x - island.x) ** 2 + (z - island.z) ** 2 < r * r && island.y <= fromY && island.y > out.y) {
      out.y = island.y;
      out.delivery = island === ROUTE.finish || island === ROUTE.cargo;
    }
  }
  const scenery = groundBelow(sceneryIslands, x, z, fromY + KEEL_DEPTH, wrapNear) - KEEL_DEPTH;
  if (scenery > out.y) {
    out.y = scenery;
    out.delivery = false;
  }
  const jetty = ROUTE.dock.y + JETTY_TOP;
  if (jetty <= fromY && jetty > out.y && onJetty(ROUTE, x, z)) {
    out.y = jetty;
    out.delivery = true;
  }
  const stage = ROUTE.loading;
  if (stage.top <= fromY && stage.top > out.y && onLoadingStage(stage, x, z)) {
    out.y = stage.top;
    out.delivery = false;
  }
};
