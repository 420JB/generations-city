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
// Brand cities opened from Proofy Play: the configuration contract and the one brand validator, and the world engine that compiles them.
export { compileBrandWorld } from '../../src/brand/core/layout'
export { PLAY_CONFIG_JSON_SCHEMA, PLAY_CONFIG_SCHEMA_VERSION, PLAY_GAME_KEY, parsePlayCityConfig, SUPPORTED_PLAY_SCHEMA_VERSIONS, type PlayEnvironment } from '../../src/brand/core/playConfig'
export {
  PLAY_CITY_ENDPOINT,
  PLAY_LOGOUT_ENDPOINT,
  PLAY_SESSION_ENDPOINT,
  RUN_TOKEN_PATTERN,
  type PlayCityResponse,
  type PlayCitySource,
  type PlayErrorBody,
  type PlayErrorCode,
  type PlayFact,
  type PlaySessionResponse,
  type PlayViewer,
  type PlayWorld,
  type PlayWorldDistrict,
  projectWorldDistricts,
} from '../../src/protocol/play'
// The local property rehearsal: its routes and answers (local deployments only, see server/src/world/rehearsal.ts).
export {
  PLAY_REHEARSAL_ACTIVATIONS_ENDPOINT,
  PLAY_REHEARSAL_APPEARANCE_ENDPOINT,
  PLAY_REHEARSAL_ARCHITECT_ENDPOINT,
  PLAY_REHEARSAL_ASSETS_ENDPOINT,
  PLAY_REHEARSAL_ASSIGNMENT_ENDPOINT,
  PLAY_REHEARSAL_CONSTRUCTION_ENDPOINT,
  PLAY_REHEARSAL_CONSTRUCTIONS_ENDPOINT,
  PLAY_REHEARSAL_DESIGN_ENDPOINT,
  PLAY_REHEARSAL_DESIGNS_ENDPOINT,
  PLAY_REHEARSAL_ENTRY_ENDPOINT,
  PLAY_REHEARSAL_RELEASE_ENDPOINT,
  PLAY_REHEARSAL_TICKET_ENDPOINT,
  REHEARSAL_MARK,
  type RehearsalActivationResponse,
  type RehearsalAppearanceResponse,
  type RehearsalArchitectView,
  type RehearsalAssetsResponse,
  type RehearsalConstructionResponse,
  type RehearsalConstructionView,
  type RehearsalDesignCatalog,
  type RehearsalDesignResponse,
  type RehearsalDesignView,
  type RehearsalErrorCode,
  type RehearsalRouteErrorCode,
  type RehearsalTicket,
  type RehearsalTicketResponse,
} from '../../src/protocol/playRehearsal'
// Persistent brand cities: how a world's configuration may change, and the state its city is stored with.
export {
  establishedCollections,
  foundationOf,
  geometryOf,
  governingProblems,
  judgeWorldConfig,
  judgeWorldConfigAs,
  parseWorldFoundation,
  parseWorldGeometry,
  sameFoundation,
  sameGeometry,
  WORLD_CONFIG_JUDGE,
  WORLD_CONFIG_JUDGE_V2,
  type FoundationCollection,
  type WorldConfigJudgement,
  type WorldFoundation,
  type WorldGeometry,
} from '../../src/brand/core/evolution'
export {
  CONSTRUCTED_WORLD_CITY_STATE_VERSION,
  emptyWorldCityState,
  parseWorldCityState,
  POPULATED_WORLD_CITY_STATE_VERSION,
  WORLD_CITY_STATE_VERSION,
  worldBuildingId,
  worldCityStateText,
  type WorldBuildingDevelopment,
  type WorldBuildingRecord,
  type WorldCityState,
} from '../../src/world/cityState'
// Property construction, pure: the one LOCAL TEST recipe, its tiers, and the proposal the server persists (server/src/world/construction.ts).
export {
  CONSTRUCTION_RECIPES,
  constructionStep,
  constructionTier,
  developmentOf,
  LOCAL_TEST_CONSTRUCTION_RECIPE,
  nextTierAt,
  PROPERTY_CONSTRUCTED_EVENT,
  proposePropertyConstruction,
  recipeMaxTier,
  type ConstructionRecipe,
  type ConstructionTransition,
  type PropertyConstructedEvent,
  type PropertyConstructionRefusal,
} from '../../src/world/construction'
// Architect property design, pure: the versioned catalogs of facade, roof, window and lighting identifiers a save may name (server/src/world/designs.ts).
export { appearanceOf, CURRENT_DESIGN_CATALOG, DESIGN_CATALOGS, isCatalogChoice, sameDesign, type DesignCatalog, type DesignChoice, type PropertyDesign } from '../../src/world/design'
// Persistent city gameplay, pure: discover plots, validate and propose a property activation on an exact plot, replay a city.
export {
  PROPERTY_ACTIVATED_EVENT,
  proposePropertyActivation,
  replayPropertyActivations,
  replayWorldCity,
  worldCityProblems,
  type PropertyActivatedEvent,
  type PropertyActivationRefusal,
  type PropertyActivationRequest,
  type PropertyTransition,
  type RecordedActivation,
  type RecordedCityChange,
} from '../../src/world/gameplay'
export { assetKey, nftAsset, parseAssetKey, type NftAsset } from '../../src/world/asset'
export { worldProperty, type WorldProperty } from '../../src/world/property'
// Default district assignment, pure: the rotation's district order and explicit-rule resolution (persisted in server/src/world/rotation.ts).
export {
  defaultRotationDistricts,
  DISTRICT_TICKET_LEASE_SECONDS,
  districtAuthorization,
  MAX_RULE_REF_LENGTH,
  resolveDistrictRules,
  rotationDistrict,
  type AssignableDistrict,
  type DistrictAuthorization,
  type DistrictRuleMatch,
  type DistrictRuleResolution,
  type RuleAnswer,
} from '../../src/world/assignment'
export type { World } from '../../src/world/definition'
