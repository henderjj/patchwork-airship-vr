import { layoutIslands } from '../sim/islands.js';
import { CALM_SKIES, distanceFromRoute, routeIslands } from '../sim/route.js';
import { settings } from '../settings.js';

/** The route this build flies (Phase 2 has one). */
export const ROUTE = CALM_SKIES;
export const ROUTE_ISLANDS = routeIslands(ROUTE);

/** Scenery islands stay this far (plus their radius) from the route's path, m. */
const ROUTE_CLEARANCE = 45;

/**
 * The scenery islands, laid out once from the URL's seed and count, clear of
 * the route. The sky draws them and the ship can rest on or run into them,
 * so host and guest must use the same `?seed=` and `?islands=`.
 */
export const sceneryIslands = layoutIslands(settings.seed, settings.islands, (x, z, radius) => distanceFromRoute(ROUTE, x, z) > radius + ROUTE_CLEARANCE);
