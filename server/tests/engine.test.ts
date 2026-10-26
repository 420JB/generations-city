import { describe, expect, it } from 'vitest'
import { contribute } from '../../src/game/actions'
import { createSeedState } from '../../src/game/seed'
import * as engine from '../src/engine'
import { applyCityCommand, type CityCommand } from '../src/engine'

describe('shared engine under Node', () => {
  it('runs with no browser globals present', () => {
    expect('window' in globalThis).toBe(false)
    expect('document' in globalThis).toBe(false)
    const seed = createSeedState()
    expect(Object.keys(seed.buildings).length).toBeGreaterThan(0)
  })

  it('applies a command for a server-supplied actor exactly as the engine does directly', () => {
    const seed = createSeedState()
    const actor = Object.values(seed.buildings).find((b) => b.id !== 'b-812' && seed.wallets[b.ownerId] === undefined)!.ownerId
    const command: CityCommand = { type: 'contribute', buildingId: 'b-812', amount: 38 }
    const result = applyCityCommand(seed, actor, command)
    expect(result).toEqual(contribute(createSeedState(), 'b-812', actor, 38))
    expect(result.state.buildings['b-812'].patrons[actor]).toBe(38)
    expect(result.events.some((e) => e.type === 'tier-up')).toBe(true)
  })

  it('is deterministic: the same state and command give byte-identical results', () => {
    const run = () => JSON.stringify(applyCityCommand(createSeedState(), 'demo-player', { type: 'contribute', buildingId: 'b-288', amount: 63 }))
    expect(run()).toBe(run())
  })

  it('gives the server player intents only, never demo controls', () => {
    expect(Object.keys(engine).sort()).toEqual([
      'ACTIVATIONS_ENDPOINT',
      'ACTIVATION_DOMAIN_NAME',
      'ACTIVATION_DOMAIN_VERSION',
      'ACTIVATION_INTENTS_ENDPOINT',
      'ACTIVATION_PRIMARY_TYPE',
      'ACTIVATION_STATEMENT',
      'ACTIVATION_TYPES',
      'ANONYMOUS_VIEWER_RESPONSE',
      'AUTH_CHALLENGE_ENDPOINT',
      'AUTH_LOGOUT_ENDPOINT',
      'AUTH_VERIFY_ENDPOINT',
      'CITY_ENDPOINT',
      'CONSTRUCTED_WORLD_CITY_STATE_VERSION',
      'CONSTRUCTION_RECIPES',
      'CURRENT_DESIGN_CATALOG',
      'DESIGN_CATALOGS',
      'DESIGN_SLOTS',
      'DISTRICT_TICKET_LEASE_SECONDS',
      'FAMILY_DISTRICTS',
      'FRIENDS_ENDPOINT',
      'LOCAL_TEST_CONSTRUCTION_RECIPE',
      'MAX_RULE_REF_LENGTH',
      'PLAY_CITY_ENDPOINT',
      'PLAY_CONFIG_JSON_SCHEMA',
      'PLAY_CONFIG_SCHEMA_VERSION',
      'PLAY_GAME_KEY',
      'PLAY_LOGOUT_ENDPOINT',
      'PLAY_REHEARSAL_ACTIVATIONS_ENDPOINT',
      'PLAY_REHEARSAL_APPEARANCE_ENDPOINT',
      'PLAY_REHEARSAL_ARCHITECT_ENDPOINT',
      'PLAY_REHEARSAL_ASSETS_ENDPOINT',
      'PLAY_REHEARSAL_ASSIGNMENT_ENDPOINT',
      'PLAY_REHEARSAL_CONSTRUCTIONS_ENDPOINT',
      'PLAY_REHEARSAL_CONSTRUCTION_ENDPOINT',
      'PLAY_REHEARSAL_DESIGNS_ENDPOINT',
      'PLAY_REHEARSAL_DESIGN_ENDPOINT',
      'PLAY_REHEARSAL_ENTRY_ENDPOINT',
      'PLAY_REHEARSAL_LEGACY_ENDPOINT',
      'PLAY_REHEARSAL_RELEASE_ENDPOINT',
      'PLAY_REHEARSAL_TICKET_ENDPOINT',
      'PLAY_SESSION_ENDPOINT',
      'POPULATED_WORLD_CITY_STATE_VERSION',
      'PRESEASON',
      'PROPERTY_ACTIVATED_EVENT',
      'PROPERTY_CONSTRUCTED_EVENT',
      'RARE_FRIENDS_CHAIN',
      'RARE_FRIENDS_FAMILIES',
      'REHEARSAL_MARK',
      'RUN_TOKEN_PATTERN',
      'STATE_VERSION',
      'SUPPORTED_PLAY_SCHEMA_VERSIONS',
      'VIEWER_ENDPOINT',
      'WORLD_CITY_STATE_VERSION',
      'WORLD_CONFIG_JUDGE',
      'WORLD_CONFIG_JUDGE_V2',
      'activateFriend',
      'allocateSpecificPlot',
      'appearanceOf',
      'applyCityCommand',
      'assetKey',
      'checkAuthoritativeCity',
      'checkCityState',
      'checkPropertyParity',
      'cityMode',
      'compileBrandWorld',
      'constructionStep',
      'constructionTier',
      'createGenesisState',
      'defaultRotationDistricts',
      'developmentOf',
      'districtAuthorization',
      'districtForFamily',
      'emptyWorldCityState',
      'establishedCollections',
      'familyById',
      'familyForDistrict',
      'foundationOf',
      'geometryOf',
      'governingProblems',
      'isActivatable',
      'isCatalogChoice',
      'isCityStateShape',
      'judgeWorldConfig',
      'judgeWorldConfigAs',
      'nextTierAt',
      'nftAsset',
      'parseAssetKey',
      'parseCanonicalTokenId',
      'parseCityResponse',
      'parsePlayCityConfig',
      'parsePlotId',
      'parseWorldCityState',
      'parseWorldFoundation',
      'parseWorldGeometry',
      'plotId',
      'projectWorldDistricts',
      'proposePropertyActivation',
      'proposePropertyConstruction',
      'recipeMaxTier',
      'replayPropertyActivations',
      'replayWorldCity',
      'resolveDistrictRules',
      'rotationDistrict',
      'sameDesign',
      'sameFoundation',
      'sameGeometry',
      'wardCapacity',
      'worldBuildingId',
      'worldCityProblems',
      'worldCityStateText',
      'worldProperty',
    ])
    const seed = createSeedState()
    for (const type of ['faucet', 'rival', 'join', 'join-at', 'grow', 'reset', 'nonsense']) {
      const result = applyCityCommand(seed, 'demo-player', { type } as unknown as CityCommand)
      expect(result, type).toEqual({ state: seed, events: [], error: 'Unknown command' })
      expect(result.state).toBe(seed)
    }
  })
})
