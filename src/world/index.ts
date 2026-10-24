/**
 * THE GENERIC WORLD ENGINE (P1-B2 S2-A): pure, configuration-driven foundations for
 * configurable cities. Portable: no browser, Node, database or chain dependency.
 *
 * What exists:
 *   identity    world ids, permanent keys, uint256 token ids, CAIP-2 chains, addresses
 *   asset       canonical NFT identity (CAIP-19), independent of any collection's name
 *   definition  world definitions (districts, collections, layout) -> validated, deep-frozen
 *               `World`; resource limits; geometry fingerprints
 *   layout      ward bands, plot rows, capacities, expansion limits, plot positions
 *   plots       plot ids, world-scoped plot keys, occupancy validation, availability, plot choice
 *   property    world-scoped property and building identity (V1 legacy, V2 brand worlds)
 *   rareCity    the legacy Rare Friends city as the first compatibility fixture
 *   cityState   the stored state of a world's city (version 1: founded empty; version 2: with properties;
 *               version 3: with construction)
 *   gameplay    pure property activation on an exact plot: discover, validate, propose, replay
 *   construction  pure property construction by one recipe (local rehearsal tuning only): propose, check
 *   assignment  the default district rotation's order and explicit-rule resolution (MCD 46B), pure
 *
 * What does not, on purpose:
 *   - No live route writes through this yet. The server's world property store (migration
 *     0007) persists `gameplay` proposals for internal test harnesses only. The legacy engine
 *     in `src/game` remains the authority for the Rare Friends city.
 *   - A populated world (`WorldCityState` version 2) records properties and wards only; version 3
 *     adds what has been built into each (tier and lifetime units), by one LOCAL TEST recipe. No
 *     ownership, economy, price or time, which wait on their own product decisions.
 *   - No allocator state: `assignment` says what a rotation is; issuing, reusing and consuming
 *     district tickets is the server's (migration 0010). Nothing here chooses a plot for anyone.
 *   - No district count or layout topology, and no explicit district/collection rule source:
 *     `assignment` resolves rules a trusted caller supplies, and refuses conflicting ones.
 *   - No persistence: geometry fingerprints and property ids are computed, never stored, here.
 */
export * from './asset'
export * from './assignment'
export * from './cityState'
export * from './construction'
export * from './definition'
export * from './gameplay'
export * from './identity'
export * from './layout'
export * from './plots'
export * from './property'
export * from './rareCity'
