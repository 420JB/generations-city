/**
 * The server's single doorway into the code it shares with the client: the deterministic
 * engine (`src/game`, `src/config`) and the wire contract (`src/protocol`).
 *
 * Everything the service reuses is re-exported here, so the surface the server depends on
 * stays visible in one place and is type-checked without DOM types. Demo fixtures (the seed
 * city, the demo player, demo-only commands) are off limits here, and lint enforces it: a
 * server authority never applies them. The one exception is the explicit staging fixture
 * in `fixtures/demoCity.ts`.
 */
export { activateFriend, type ActivationOutcome, type ActivationRefusal, type FriendActivation } from '../../src/game/activation'
export { allocateSpecificPlot, type PlotAddress } from '../../src/game/allocation'
export { applyCityCommand, type CityCommand } from '../../src/game/commands'
export { createGenesisState, PRESEASON } from '../../src/game/genesis'
export { checkAuthoritativeCity, checkCityState, checkPropertyParity, cityMode, isActivatable, type AuthoritativeCityCheck, type CityFlags, type CityMode, type InvariantCategory, type PropertyFacts, type Violation } from '../../src/game/invariants'
export { isCityStateShape, STATE_VERSION } from '../../src/game/stateSchema'
export type { ActionResult, Building, CityUser, GameEvent, GameState } from '../../src/game/types'
export { plotId, wardCapacity } from '../../src/game/world'
export type { DistrictId } from '../../src/config/districts'
export { districtForFamily, FAMILY_DISTRICTS, familyForDistrict } from '../../src/config/familyDistricts'
export { CITY_ENDPOINT, parseCityResponse, type CityErrorCode, type CityMeta, type CityOrigin, type CityResponse } from '../../src/protocol/city'
export { familyById, RARE_FRIENDS_CHAIN, RARE_FRIENDS_FAMILIES, type Family, type HexAddress } from '../../src/config/rareFriends'
export {
  ACTIVATION_DOMAIN_NAME,
  ACTIVATION_DOMAIN_VERSION,
  ACTIVATION_INTENTS_ENDPOINT,
  ACTIVATION_PRIMARY_TYPE,
  ACTIVATION_STATEMENT,
  ACTIVATION_TYPES,
  ACTIVATIONS_ENDPOINT,
  parseCanonicalTokenId,
  parsePlotId,
  type ActivationCommitResponse,
  type ActivationErrorCode,
  type ActivationIntentResponse,
  type ActivationTypedData,
  type FriendPropertyDto,
  type ParsedPlot,
} from '../../src/protocol/activation'
export {
  ANONYMOUS_VIEWER_RESPONSE,
  AUTH_CHALLENGE_ENDPOINT,
  AUTH_LOGOUT_ENDPOINT,
  AUTH_VERIFY_ENDPOINT,
  FRIENDS_ENDPOINT,
  VIEWER_ENDPOINT,
  type AuthenticatedViewer,
  type ChallengeResponse,
  type FriendsResponse,
  type IdentityErrorCode,
  type ViewerResponse,
} from '../../src/protocol/identity'
