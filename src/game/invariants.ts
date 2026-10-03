import { DISTRICT_IDS, type DistrictId } from '../config/districts'
import { districtForFamily } from '../config/familyDistricts'
import { MONUMENTS } from '../config/monuments'
import { STATE_VERSION } from './stateSchema'
import type { GameState } from './types'
import { plotId, wardCapacity } from './world'

/**
 * AUTHORITATIVE CITY INVARIANTS.
 *
 * `isCityStateShape` says a state can be drawn. This says a state is one an authority may
 * hold: every building sits on a real, open, unshared plot under the id its Friend gives
 * it, and (in a city that holds real properties) the buildings are exactly the normalized
 * property rows, no more and no fewer.
 *
 * Pure, with no database or browser dependency. The server runs it before it installs or
 * changes a city and from `city:verify`. A `CityUser.friendId` is never consulted for
 * authority here or anywhere: it is an avatar.
 */
export type InvariantCategory = 'mode' | 'state' | 'buildings' | 'users' | 'properties'

export interface Violation {
  category: InvariantCategory
  /** Stable short name of the rule that failed. */
  rule: string
  detail: string
}

/**
 * What kind of city this is. Only these three exist:
 * - `canonical`     the real city (production genesis).
 * - `rehearsal`     a disposable city in which real activation is rehearsed.
 * - `demo-fixture`  the ordinary simulated demo city. Its buildings are not properties.
 */
export type CityMode = 'canonical' | 'rehearsal' | 'demo-fixture'

export interface CityFlags {
  canonical: unknown
  origin: unknown
  activationRehearsal: unknown
}

/** The mode these flags describe, or null when they describe no city this build knows. Never guesses. */
export function cityMode(flags: CityFlags): CityMode | null {
  const { canonical, origin, activationRehearsal } = flags
  if (canonical === true && origin === 'genesis' && activationRehearsal === false) return 'canonical'
  if (canonical === false && origin === 'demo-fixture' && activationRehearsal === true) return 'rehearsal'
  if (canonical === false && origin === 'demo-fixture' && activationRehearsal === false) return 'demo-fixture'
  return null
}

/** A city that may hold real properties, and whose buildings must therefore match them exactly. */
export const isActivatable = (mode: CityMode): boolean => mode === 'canonical' || mode === 'rehearsal'

/** What a normalized property row says about a building. Token ids are decimal strings (uint256 in the database). */
export interface PropertyFacts {
  propertyId: string
  tokenId: string
  familyId: number
  districtId: string
  ward: number
  plot: number
  plotId: string
  buildingId: string
}

/** A report is capped so a badly corrupted state cannot produce an unbounded one. */
const MAX_VIOLATIONS = 100

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isDistrict = (v: unknown): v is DistrictId => typeof v === 'string' && (DISTRICT_IDS as readonly string[]).includes(v)
/** A user id is a plain token. Every lookup by id here is an own-property lookup, so a name that also exists on Object.prototype finds nothing. */
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MONUMENT_IDS: readonly string[] = MONUMENTS.map((m) => m.id)

class Report {
  readonly violations: Violation[] = []
  add(category: InvariantCategory, rule: string, detail: string) {
    if (this.violations.length < MAX_VIOLATIONS) this.violations.push({ category, rule, detail })
  }
}

/**
 * Deep check of a city state's own semantics. Takes untyped data: nothing is assumed about
 * what the database or a caller handed over. An empty list means the state is internally sound.
 */
export function checkCityState(value: unknown): Violation[] {
  const r = new Report()
  if (!isRecord(value)) return [{ category: 'state', rule: 'state-object', detail: 'the state is not an object' }]
  const s = value

  if (s.version !== STATE_VERSION) r.add('state', 'version', `state version is ${String(s.version)}, this build supports ${STATE_VERSION}`)
  for (const key of ['clock', 'rivalCursor', 'residentSeq']) if (!isCount(s[key])) r.add('state', 'counter', `${key} is not a non-negative integer`)
  for (const key of ['users', 'buildings', 'wallets', 'badges', 'counters', 'monuments', 'monumentHistory', 'capital', 'crown', 'wards', 'season']) if (!isRecord(s[key])) r.add('state', 'collection', `${key} is not an object`)
  for (const key of ['radio', 'alertKeys', 'capitalHistory', 'crownHistory']) if (!Array.isArray(s[key])) r.add('state', 'collection', `${key} is not a list`)
  // Nothing below can be read safely from a state whose collections are the wrong kind.
  if (r.violations.length > 0) return r.violations

  const users = s.users as Record<string, unknown>
  const buildings = s.buildings as Record<string, unknown>
  const wards = s.wards as Record<string, unknown>

  // Wards: every district, and only districts, with at least its founding ward open.
  for (const d of DISTRICT_IDS) if (!isCount(wards[d]) || wards[d] < 1) r.add('state', 'wards', `district ${d} does not have a positive whole number of open wards`)
  for (const d of Object.keys(wards)) if (!isDistrict(d)) r.add('state', 'district', `wards names an unknown district "${d}"`)
  for (const entry of s.radio as unknown[]) if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.headline !== 'string') r.add('state', 'radio', 'a radio entry is not an entry with an id and a headline')
  for (const key of s.alertKeys as unknown[]) if (typeof key !== 'string') r.add('state', 'radio', 'an alert key is not text')

  // What is held, and by whom.
  const monuments = s.monuments as Record<string, unknown>
  const monumentHistory = s.monumentHistory as Record<string, unknown>
  for (const m of MONUMENTS) {
    const held = Object.hasOwn(monuments, m.id) ? monuments[m.id] : undefined
    if (!isRecord(held) || !(held.holder === null || isDistrict(held.holder)) || !isCount(held.sinceClock)) r.add('state', 'holding', `monument ${m.id} is not held by a district or by nobody, since a known clock`)
    if (!Array.isArray(monumentHistory[m.id])) r.add('state', 'collection', `monumentHistory.${m.id} is not a list`)
  }
  for (const key of [...Object.keys(monuments), ...Object.keys(monumentHistory)]) if (!MONUMENT_IDS.includes(key)) r.add('state', 'holding', `"${key}" is not a monument of this city`)
  const capital = s.capital as Record<string, unknown>
  if (!(capital.holder === null || isDistrict(capital.holder)) || !isCount(capital.sinceClock)) r.add('state', 'holding', 'the Capital is not held by a district or by nobody, since a known clock')
  const crown = s.crown as Record<string, unknown>
  if (!(crown.holder === null || (typeof crown.holder === 'string' && Object.hasOwn(buildings, crown.holder))) || !isCount(crown.sinceClock)) r.add('state', 'holding', 'the Crown is not held by an existing building or by nobody, since a known clock')

  // Users: presentation records only.
  for (const [key, raw] of Object.entries(users)) {
    if (!isRecord(raw)) {
      r.add('users', 'user-shape', `user "${key}" is not an object`)
      continue
    }
    if (!USER_ID.test(key)) r.add('users', 'user-id', `"${key}" is not a well-formed user id`)
    if (raw.id !== key) r.add('users', 'user-key', `user "${key}" carries the id "${String(raw.id)}"`)
    if (typeof raw.handle !== 'string' || raw.handle === '') r.add('users', 'user-shape', `user "${key}" has no handle`)
    if (!isCount(raw.friendId)) r.add('users', 'user-avatar', `user "${key}" has an avatar Friend id that is not a non-negative safe integer`)
    if (typeof raw.hue !== 'number' || !Number.isFinite(raw.hue)) r.add('users', 'user-shape', `user "${key}" has no hue`)
  }
  for (const [key, balance] of Object.entries(s.wallets as Record<string, unknown>)) {
    if (!Object.hasOwn(users, key)) r.add('users', 'wallet-user', `a simulated wallet belongs to unknown user "${key}"`)
    if (!isAmount(balance)) r.add('users', 'wallet-balance', `the simulated wallet of "${key}" is not a non-negative amount`)
  }

  // Buildings: identity, location, occupancy, owner.
  const friends = new Map<number, string>()
  const occupied = new Map<string, string>()
  /** Highest occupied ward per district, to check that no ward stands open beyond an empty one. */
  const outermost = new Map<string, number>()
  for (const [key, raw] of Object.entries(buildings)) {
    if (!isRecord(raw)) {
      r.add('buildings', 'building-shape', `building "${key}" is not an object`)
      continue
    }
    const b = raw
    if (b.id !== key) r.add('buildings', 'building-key', `building "${key}" carries the id "${String(b.id)}"`)
    if (!isCount(b.friendId)) {
      r.add('buildings', 'friend-id', `building "${key}" has a Friend id that is not a non-negative safe integer`)
    } else {
      if (b.id !== `b-${b.friendId}`) r.add('buildings', 'building-id', `building "${key}" is not named b-${b.friendId} after its Friend`)
      const other = friends.get(b.friendId)
      if (other !== undefined) r.add('buildings', 'friend-unique', `Friend ${b.friendId} has two buildings: "${other}" and "${key}"`)
      else friends.set(b.friendId, key)
    }

    if (!isDistrict(b.districtId)) {
      r.add('buildings', 'district', `building "${key}" is in an unknown district "${String(b.districtId)}"`)
    } else if (!isCount(b.ward) || !isCount(b.plot)) {
      if (!isCount(b.ward)) r.add('buildings', 'ward', `building "${key}" has a ward that is not a non-negative integer`)
      if (!isCount(b.plot)) r.add('buildings', 'plot', `building "${key}" has a plot that is not a non-negative integer`)
    } else {
      const open = wards[b.districtId]
      if (isCount(open) && b.ward >= open) r.add('buildings', 'ward-open', `building "${key}" stands in ward ${b.ward} of ${b.districtId}, which has ${open} open`)
      if (b.plot >= wardCapacity(b.ward)) r.add('buildings', 'plot-capacity', `building "${key}" stands on plot ${b.plot} of a ward that holds ${wardCapacity(b.ward)}`)
      const at = plotId(b.districtId, b.ward, b.plot)
      const other = occupied.get(at)
      if (other !== undefined) r.add('buildings', 'plot-unique', `plot ${at} is occupied by both "${other}" and "${key}"`)
      else occupied.set(at, key)
      outermost.set(b.districtId, Math.max(outermost.get(b.districtId) ?? 0, b.ward))
    }

    if (typeof b.ownerId !== 'string' || !Object.hasOwn(users, b.ownerId)) r.add('buildings', 'owner-user', `building "${key}" is owned by "${String(b.ownerId)}", who is not a user of this city`)
    if (!isAmount(b.ownerBuilt)) r.add('buildings', 'building-shape', `building "${key}" has an owner build that is not a non-negative amount`)
    if (!isRecord(b.patrons) || !Object.values(b.patrons).every(isAmount)) r.add('buildings', 'building-shape', `building "${key}" has patron contributions that are not non-negative amounts`)
    else for (const patron of Object.keys(b.patrons)) if (!Object.hasOwn(users, patron)) r.add('buildings', 'patron-user', `building "${key}" records a contribution by "${patron}", who is not a user of this city`)
    if (!isRecord(b.architecture) || !Array.isArray(b.fixtures) || !Array.isArray(b.landscapeSlots) || !isRecord(b.landscapeInventory) || !isRecord(b.billboard) || !Array.isArray(b.milestones)) {
      r.add('buildings', 'building-shape', `building "${key}" is missing part of its structure`)
    } else {
      const billboard = b.billboard
      const parts =
        Object.values(b.architecture).every((v) => typeof v === 'string') &&
        b.fixtures.every((v) => typeof v === 'string') &&
        b.landscapeSlots.every((v) => v === null || typeof v === 'string') &&
        Object.values(b.landscapeInventory).every(isCount) &&
        (billboard.image === null || typeof billboard.image === 'string') &&
        b.milestones.every((m) => isRecord(m) && isCount(m.tier) && isCount(m.clock) && typeof m.byUserId === 'string')
      if (!parts) r.add('buildings', 'building-shape', `building "${key}" has a part that is not the kind of thing it should be`)
    }
  }
  // A ward opens when a Friend moves into it, so the outermost open ward of a district is never empty.
  for (const d of DISTRICT_IDS) {
    const open = wards[d]
    if (isCount(open) && open > 1 && (outermost.get(d) ?? 0) < open - 1) r.add('state', 'wards', `district ${d} has ${open} wards open but nothing beyond ward ${outermost.get(d) ?? 0}`)
  }

  // Season: a neutral container is valid; whatever it names must exist.
  const season = s.season as Record<string, unknown>
  if (typeof season.id !== 'string' || typeof season.name !== 'string' || !isCount(season.number)) r.add('state', 'season', 'the season has no id, name or number')
  for (const key of ['representatives', 'activity', 'joinedClock']) if (!isRecord(season[key])) r.add('state', 'season', `season.${key} is not an object`)
  if (isRecord(season.representatives))
    for (const [userId, raw] of Object.entries(season.representatives)) {
      const rep = isRecord(raw) ? raw : {}
      const building = typeof rep.buildingId === 'string' && Object.hasOwn(buildings, rep.buildingId) ? buildings[rep.buildingId] : undefined
      if (!Object.hasOwn(users, userId)) r.add('state', 'season', `a Representative is recorded for unknown user "${userId}"`)
      if (!isRecord(building) || !isDistrict(rep.districtId) || building.districtId !== rep.districtId || building.ownerId !== userId)
        r.add('state', 'season', `the Representative of "${userId}" is not a building that user owns, in the district recorded for it`)
    }

  return r.violations
}

/**
 * Exact parity between a state's buildings and the normalized property rows of an
 * activatable city: the same set, and the same Friend, district, ward and plot for each.
 */
export function checkPropertyParity(state: Pick<GameState, 'buildings'>, properties: readonly PropertyFacts[]): Violation[] {
  const r = new Report()
  const buildings = state.buildings
  const seen = new Set<string>()
  if (properties.length !== Object.keys(buildings).length) r.add('properties', 'count', `${properties.length} properties but ${Object.keys(buildings).length} buildings`)

  for (const p of properties) {
    const label = `property ${p.propertyId} (Friend ${p.tokenId})`
    if (seen.has(p.buildingId)) r.add('properties', 'building-shared', `${label} shares building "${p.buildingId}" with another property`)
    seen.add(p.buildingId)

    // A property row must itself be coherent before it is compared with anything.
    if (!/^(0|[1-9][0-9]*)$/.test(p.tokenId) || !Number.isSafeInteger(Number(p.tokenId))) r.add('properties', 'token', `${label} has a token id outside the supported range`)
    if (p.buildingId !== `b-${p.tokenId}`) r.add('properties', 'building-id', `${label} names building "${p.buildingId}", not b-${p.tokenId}`)
    if (districtForFamily(p.familyId) !== p.districtId) r.add('properties', 'family-district', `${label} puts family ${p.familyId} in ${p.districtId}; that family lives in ${districtForFamily(p.familyId) ?? 'no district'}`)
    if (!isDistrict(p.districtId) || !isCount(p.ward) || !isCount(p.plot) || p.plotId !== plotId(p.districtId, p.ward, p.plot)) r.add('properties', 'plot-id', `${label} has a plot id that does not match its district, ward and plot`)

    const b = Object.hasOwn(buildings, p.buildingId) ? buildings[p.buildingId] : undefined
    if (!b) {
      r.add('properties', 'property-without-building', `${label} has no building "${p.buildingId}" in the city state`)
      continue
    }
    if (String(b.friendId) !== p.tokenId) r.add('properties', 'token-mismatch', `${label} but its building belongs to Friend ${b.friendId}`)
    if (b.districtId !== p.districtId) r.add('properties', 'district-mismatch', `${label} is in ${p.districtId} but its building is in ${b.districtId}`)
    if (b.ward !== p.ward || b.plot !== p.plot) r.add('properties', 'plot-mismatch', `${label} is on ward ${p.ward} plot ${p.plot} but its building is on ward ${b.ward} plot ${b.plot}`)
  }
  for (const key of Object.keys(buildings)) if (!seen.has(key)) r.add('properties', 'building-without-property', `building "${key}" has no property row`)
  return r.violations
}

export interface AuthoritativeCityCheck {
  /** null = the flags describe no city this build knows; nothing about it is accepted. */
  mode: CityMode | null
  violations: Violation[]
}

/**
 * Everything an authority must hold true of a city: a known mode, a sound state, and for
 * an activatable city exact parity with its property rows. An ordinary demo fixture is
 * recognised as such: its simulated buildings are not properties, so it must have none
 * and parity is not asked of it.
 */
export function checkAuthoritativeCity(input: { flags: CityFlags; state: unknown; properties: readonly PropertyFacts[] }): AuthoritativeCityCheck {
  const mode = cityMode(input.flags)
  if (mode === null) return { mode, violations: [{ category: 'mode', rule: 'unknown-mode', detail: `canonical=${String(input.flags.canonical)}, origin=${String(input.flags.origin)}, activation_rehearsal=${String(input.flags.activationRehearsal)} is not a kind of city this build knows` }] }
  const violations = checkCityState(input.state)
  if (!isActivatable(mode)) {
    if (input.properties.length > 0) violations.push({ category: 'properties', rule: 'fixture-has-properties', detail: `an ordinary demo fixture city has ${input.properties.length} property rows; its simulated buildings are never properties` })
    return { mode, violations }
  }
  // Parity is only meaningful over a state whose buildings could be read.
  if (!violations.some((v) => v.rule === 'state-object' || v.rule === 'collection')) {
    const state = input.state as GameState
    // Simulated RF belongs to the demo. A city that may hold real properties has none.
    const simulated = Object.keys(state.wallets).length
    if (simulated > 0) violations.push({ category: 'state', rule: 'simulated-wallet', detail: `${simulated} simulated wallet(s) in a city that may hold real properties` })
    violations.push(...checkPropertyParity(state, input.properties))
  }
  return { mode, violations: violations.slice(0, MAX_VIOLATIONS) }
}
