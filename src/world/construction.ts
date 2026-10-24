import {
  CONSTRUCTED_WORLD_CITY_STATE_VERSION,
  type ConstructedWorldCityState,
  type PropertiedWorldCityState,
  type WorldBuildingDevelopment,
  type WorldBuildingRecord,
  type WorldCityState,
} from './cityState'

/**
 * PROPERTY CONSTRUCTION, PURE (P1-C2-E3A): how a world's city moves from one stored state to the
 * next when something is built into one of its properties. Portable and deterministic: no clock,
 * no randomness, no database, no balance. The same state and request always give the same answer.
 *
 * As with activation (`gameplay.ts`), the steps are kept apart:
 *   propose   `proposePropertyConstruction`   the exact next state and the event that records it
 *   persist   (not here)                       the server writes a proposal only after its own
 *                                              authoritative checks (who may build, what it costs,
 *                                              that it was paid for), under the city's lock
 *
 * The caller names only WHICH building. The recipe decides everything else: how many units this
 * one action builds, and the tier that results. Nothing here accepts an amount, a tier or a state.
 *
 * EVERY RECIPE THIS BUILD HAS IS LOCAL REHEARSAL TUNING, in valueless TEST units. Recipes are
 * versioned, and a recipe's key is permanent: every construction record names the recipe that
 * computed it, and is read by that recipe forever.
 *   `local-test-tier1-v1` (P1-C2-E3A)  Tier 0 to Tier 1 in fixed steps; nothing above Tier 1. RETIRED:
 *                                     its records stay valid, nothing new is built by it.
 *   `local-test-tier2-v1` (P1-C2-E3B)  the CURRENT recipe: exactly tier1-v1 up to Tier 1, then on to
 *                                     Tier 2 in the same fixed steps; nothing above Tier 2.
 * A later recipe extends the one before it (same step, same thresholds, one more tier), so a city
 * built under an earlier recipe is read the same under the current one, and a Tier 1 building
 * simply continues. The numbers are provisional, chosen only so a local rehearsal shows real tier
 * changes in a few actions. They are not a price, not an exchange rate with any currency and not a
 * decision about final tiers: the ladder ends at the current recipe's highest tier
 * (`construction-complete`), on purpose.
 */
export const PROPERTY_CONSTRUCTED_EVENT = 'world.property.constructed'

export interface ConstructionRecipe {
  /** Permanent key: every construction record names the recipe that computed it. */
  key: string
  /** Units one action builds (and, in the local rehearsal, the TEST credits it costs), at most. */
  unitsPerAction: number
  /** Lifetime units that reach Tier 1, 2, ...: `tierThresholds[i]` starts tier i + 1. The last is the highest tier this recipe builds. */
  tierThresholds: readonly number[]
}

/** PROVISIONAL LOCAL REHEARSAL TUNING (P1-C2-E3A), RETIRED: read for its records only. Mirrored by migration 0013. */
export const LOCAL_TEST_TIER1_RECIPE: ConstructionRecipe = Object.freeze({ key: 'local-test-tier1-v1', unitsPerAction: 50, tierThresholds: Object.freeze([100]) })

/** PROVISIONAL LOCAL REHEARSAL TUNING (P1-C2-E3B), not product economics (see the top of this file). Mirrored by migration 0014. */
export const LOCAL_TEST_TIER2_RECIPE: ConstructionRecipe = Object.freeze({ key: 'local-test-tier2-v1', unitsPerAction: 50, tierThresholds: Object.freeze([100, 250]) })

/** The recipe every new construction is computed by. */
export const LOCAL_TEST_CONSTRUCTION_RECIPE: ConstructionRecipe = LOCAL_TEST_TIER2_RECIPE

/** The recipes this build can read, by key, oldest first: every record names one of them. */
export const CONSTRUCTION_RECIPES: Readonly<Record<string, ConstructionRecipe>> = Object.freeze({
  [LOCAL_TEST_TIER1_RECIPE.key]: LOCAL_TEST_TIER1_RECIPE,
  [LOCAL_TEST_TIER2_RECIPE.key]: LOCAL_TEST_TIER2_RECIPE,
})

/**
 * Whether `later` extends `earlier`: the same step, and every threshold of `earlier` unchanged at the start of `later`'s.
 * Then every amount `earlier` can build is at the same tier, and has the same next step, under `later`.
 */
export function recipeExtends(later: ConstructionRecipe, earlier: ConstructionRecipe): boolean {
  return later.unitsPerAction === earlier.unitsPerAction && later.tierThresholds.length >= earlier.tierThresholds.length && earlier.tierThresholds.every((t, i) => later.tierThresholds[i] === t)
}

/** The highest tier a recipe builds. */
export const recipeMaxTier = (recipe: ConstructionRecipe) => recipe.tierThresholds.length

/** The tier `built` lifetime units reach under a recipe. */
export function constructionTier(recipe: ConstructionRecipe, built: number): number {
  let tier = 0
  recipe.tierThresholds.forEach((threshold, i) => {
    if (built >= threshold) tier = i + 1
  })
  return tier
}

/** Lifetime units at which the next tier starts, or null at the recipe's highest tier. */
export function nextTierAt(recipe: ConstructionRecipe, built: number): number | null {
  const tier = constructionTier(recipe, built)
  return tier >= recipeMaxTier(recipe) ? null : recipe.tierThresholds[tier]
}

/**
 * The units the recipe's next action builds into a building with `built` units, or null when it is at the recipe's
 * highest tier. A step never passes the next tier's threshold: it stops exactly there, so every tier is reached by a
 * step of its own and none is skipped.
 */
export function constructionStep(recipe: ConstructionRecipe, built: number): number | null {
  const next = nextTierAt(recipe, built)
  return next === null ? null : Math.min(recipe.unitsPerAction, next - built)
}

/** What a building has had built into it in a stored state (nothing for a version 1 or 2 city). */
export function developmentOf(state: WorldCityState, buildingId: string): WorldBuildingDevelopment | null {
  if (state.version !== CONSTRUCTED_WORLD_CITY_STATE_VERSION) return null
  return Object.hasOwn(state.development, buildingId) ? state.development[buildingId] : null
}

/** What a `world.property.constructed` event records, besides what the caller adds (the action, the contributor's role). */
export interface PropertyConstructedEvent {
  propertyId: string
  buildingId: string
  recipe: string
  units: number
  builtBefore: number
  builtAfter: number
  tierBefore: number
  tierAfter: number
}

export type PropertyConstructionRefusal =
  /** The building is not a property of this city. */
  | 'unknown-property'
  /** The building already stands at the highest tier the recipe builds. */
  | 'construction-complete'

/** The exact change one construction makes: from the city at `from` to the city at `to`. */
export interface ConstructionTransition {
  from: number
  to: number
  buildingId: string
  propertyId: string
  recipe: string
  units: number
  builtBefore: number
  builtAfter: number
  tierBefore: number
  tierAfter: number
  /** The city's state at `to`, always version 3. */
  state: ConstructedWorldCityState
  event: PropertyConstructedEvent
}

export type ProposedConstruction = { ok: true; transition: ConstructionTransition } | { ok: false; reason: PropertyConstructionRefusal }

/**
 * Proposal: the next state of a city at `sequence` when one action of `recipe` builds into `buildingId`, and the event
 * that records it. Nothing is written. The action builds the recipe's step, or only what is left of the highest tier.
 * Development entries stay in the order of the buildings, so a state has one spelling and a replay rebuilds it byte for
 * byte.
 */
export function proposePropertyConstruction(state: WorldCityState, sequence: number, request: { buildingId: string; recipe: ConstructionRecipe }): ProposedConstruction {
  if (!Number.isSafeInteger(sequence) || sequence < 2) throw new Error(`Invalid city sequence ${sequence} for a construction`)
  const { buildingId, recipe } = request
  if (state.version === 1 || !Object.hasOwn(state.buildings, buildingId)) return { ok: false, reason: 'unknown-property' }
  const building = (state.buildings as Record<string, WorldBuildingRecord>)[buildingId]
  const before = developmentOf(state, buildingId)
  const builtBefore = before?.built ?? 0
  const tierBefore = constructionTier(recipe, builtBefore)
  const units = constructionStep(recipe, builtBefore)
  if (units === null) return { ok: false, reason: 'construction-complete' }
  const builtAfter = builtBefore + units
  const tierAfter = constructionTier(recipe, builtAfter)
  const to = sequence + 1
  const previous = state.version === CONSTRUCTED_WORLD_CITY_STATE_VERSION ? state.development : {}
  const development: Record<string, WorldBuildingDevelopment> = {}
  for (const key of Object.keys(state.buildings)) {
    if (key === buildingId) development[key] = { tier: tierAfter, built: builtAfter, sequence: to }
    else if (Object.hasOwn(previous, key)) development[key] = { ...previous[key] }
  }
  const populated = state as PropertiedWorldCityState
  const next: ConstructedWorldCityState = { version: CONSTRUCTED_WORLD_CITY_STATE_VERSION, buildings: { ...populated.buildings }, openWards: { ...populated.openWards }, development }
  const event: PropertyConstructedEvent = { propertyId: building.propertyId, buildingId, recipe: recipe.key, units, builtBefore, builtAfter, tierBefore, tierAfter }
  return { ok: true, transition: { from: sequence, to, buildingId, propertyId: building.propertyId, recipe: recipe.key, units, builtBefore, builtAfter, tierBefore, tierAfter, state: next, event } }
}

const MAX_PROBLEMS = 20

/**
 * Everything wrong with a stored state's development, or an empty list: every entry is a building of the city, built
 * after it was activated, at a tier its built units reach under the recipe this build has, no more units than that
 * recipe's highest tier, and no two constructions at one sequence or at an activation's. (Who built and how it was paid
 * for are the construction records'.)
 */
export function developmentProblems(state: WorldCityState, recipe: ConstructionRecipe = LOCAL_TEST_CONSTRUCTION_RECIPE): string[] {
  if (state.version !== CONSTRUCTED_WORLD_CITY_STATE_VERSION) return []
  const problems: string[] = []
  const add = (detail: string) => problems.length < MAX_PROBLEMS && problems.push(detail)
  const entries = Object.entries(state.development)
  if (entries.length === 0) add('a version 3 city records no development')
  const ceiling = recipe.tierThresholds[recipe.tierThresholds.length - 1]
  const activations = new Set(Object.values(state.buildings).map((b) => b.sequence))
  const seen = new Set<number>()
  for (const [key, d] of entries) {
    const b = Object.hasOwn(state.buildings, key) ? state.buildings[key] : undefined
    if (!b) add(`development ${key} is not a building of this city`)
    else if (d.sequence <= b.sequence) add(`building ${key} records construction at sequence ${d.sequence}, before its activation at ${b.sequence}`)
    if (d.built > ceiling) add(`building ${key} records ${d.built} units built; recipe ${recipe.key} builds at most ${ceiling}`)
    if (d.tier !== constructionTier(recipe, d.built)) add(`building ${key} records tier ${d.tier}; ${d.built} units make it tier ${constructionTier(recipe, d.built)}`)
    if (activations.has(d.sequence) || seen.has(d.sequence)) add(`building ${key} records construction at sequence ${d.sequence}, which another change of the city holds`)
    seen.add(d.sequence)
  }
  return problems
}
