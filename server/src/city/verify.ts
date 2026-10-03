import type { Database } from '../db/pool'
import { checkAuthoritativeCity, STATE_VERSION, type CityMode, type InvariantCategory, type PropertyFacts } from '../engine'
import { CITY_ID } from './store'

/**
 * `city:verify`: is the city in this database one an authority may hold?
 *
 * READ-ONLY. Everything is read inside one REPEATABLE READ, READ ONLY transaction, so the
 * city row, its events, its properties and their eras are one consistent picture, and
 * nothing can be written even by mistake.
 *
 * It checks the state's own invariants, exact parity between buildings and normalized
 * property rows where the city may hold real properties, that the events account for the
 * sequence, and the ownership-era rules that can be seen from the rows.
 */
export type VerifyCategory = InvariantCategory | 'city' | 'events' | 'eras' | 'intents'

export interface VerifyViolation {
  category: VerifyCategory
  rule: string
  detail: string
}

export interface VerifyReport {
  ok: boolean
  /** null when no city is installed. */
  city: { id: string; instance: string; sequence: number; stateVersion: number; canonical: boolean; origin: string; activationRehearsal: boolean; mode: CityMode | null } | null
  counts: { buildings: number; users: number; events: number; properties: number; eras: number; openEras: number; intents: number; committedIntents: number }
  violations: VerifyViolation[]
}

const MAX_VIOLATIONS = 100

interface PropertyRow {
  id: string
  city_id: string
  city_instance_id: string
  token_id: string
  family_id: number
  district_id: string
  ward: number
  plot: number
  plot_id: string
  building_id: string
  activated_sequence: string
  activated_by_wallet_id: string
  activation_intent_id: string
  intent_status: string | null
  intent_property_id: string | null
}

interface EraRow {
  property_id: string
  era_number: number
  owner_address: string
  owner_wallet_id: string | null
  owner_user_id: string | null
  wallet_address: string | null
  wallet_user_id: string | null
  start_reason: string
  started_at: Date
  ended_at: Date | null
}

export async function verifyCity(db: Database): Promise<VerifyReport> {
  const violations: VerifyViolation[] = []
  const add = (category: VerifyCategory, rule: string, detail: string) => {
    if (violations.length < MAX_VIOLATIONS) violations.push({ category, rule, detail })
  }
  const counts = { buildings: 0, users: 0, events: 0, properties: 0, eras: 0, openEras: 0, intents: 0, committedIntents: 0 }

  const client = await db.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const row = (
      await client.query<{ id: string; instance_id: string; sequence: string; state_version: number; canonical: boolean; origin: string; activation_rehearsal: boolean; state: unknown }>(
        'SELECT id, instance_id, sequence, state_version, canonical, origin, activation_rehearsal, state FROM city WHERE id = $1',
        [CITY_ID],
      )
    ).rows[0]
    const events = (await client.query<{ city_id: string; sequence: string; type: string }>('SELECT city_id, sequence, type FROM city_events ORDER BY city_id, sequence')).rows
    const properties = (
      await client.query<PropertyRow>(
        `SELECT p.id, p.city_id, p.city_instance_id, p.token_id::text AS token_id, p.family_id, p.district_id, p.ward, p.plot, p.plot_id, p.building_id,
                p.activated_sequence, p.activated_by_wallet_id, p.activation_intent_id, i.status AS intent_status, i.property_id AS intent_property_id
           FROM properties p LEFT JOIN activation_intents i ON i.id = p.activation_intent_id
          ORDER BY p.activated_sequence, p.id`,
      )
    ).rows
    const eras = (
      await client.query<EraRow>(
        `SELECT e.property_id, e.era_number, e.owner_address, e.owner_wallet_id, e.owner_user_id, w.address AS wallet_address, w.user_id AS wallet_user_id, e.start_reason, e.started_at, e.ended_at
           FROM ownership_eras e LEFT JOIN wallets w ON w.id = e.owner_wallet_id
          ORDER BY e.property_id, e.era_number`,
      )
    ).rows
    const intents = (await client.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM activation_intents GROUP BY status')).rows

    counts.events = events.length
    counts.properties = properties.length
    counts.eras = eras.length
    counts.openEras = eras.filter((e) => e.ended_at === null).length
    counts.intents = intents.reduce((a, i) => a + i.n, 0)
    counts.committedIntents = intents.find((i) => i.status === 'committed')?.n ?? 0

    if (!row) {
      add('city', 'not-initialized', 'no city is installed in this database')
      if (events.length > 0) add('events', 'orphan-events', `${events.length} city events exist without a city`)
      if (properties.length > 0) add('properties', 'orphan-properties', `${properties.length} properties exist without a city`)
      return { ok: false, city: null, counts, violations }
    }

    const sequence = Number(row.sequence)
    const check = checkAuthoritativeCity({
      flags: { canonical: row.canonical, origin: row.origin, activationRehearsal: row.activation_rehearsal },
      state: row.state,
      properties: properties.filter((p) => p.city_id === row.id).map((p): PropertyFacts => ({ propertyId: p.id, tokenId: p.token_id, familyId: p.family_id, districtId: p.district_id, ward: p.ward, plot: p.plot, plotId: p.plot_id, buildingId: p.building_id })),
    })
    for (const v of check.violations) add(v.category, v.rule, v.detail)
    if (row.state_version !== STATE_VERSION) add('state', 'version', `the city is stored as state version ${row.state_version}; this build supports ${STATE_VERSION}`)
    const state = row.state as { buildings?: Record<string, { ownerId?: unknown } | undefined>; users?: unknown } | null
    counts.buildings = state && typeof state.buildings === 'object' && state.buildings ? Object.keys(state.buildings).length : 0
    counts.users = state && typeof state.users === 'object' && state.users ? Object.keys(state.users).length : 0

    // Events: exactly one per value the sequence has held, starting with the install.
    const own = events.filter((e) => e.city_id === row.id)
    if (own.length !== events.length) add('events', 'orphan-events', `${events.length - own.length} city events belong to no installed city`)
    if (own.length !== sequence) add('events', 'sequence', `the city is at sequence ${sequence} but has ${own.length} events`)
    if (own.some((e, i) => Number(e.sequence) !== i + 1)) add('events', 'sequence', 'the city events are not numbered 1, 2, 3 ... without a gap')
    if (own[0] && own[0].type !== 'city.initialized') add('events', 'first-event', `the first event is ${own[0].type}, not city.initialized`)
    if (own.filter((e) => e.type === 'city.initialized').length > 1) add('events', 'first-event', 'the city was initialized more than once')
    const activations = own.filter((e) => e.type === 'property.activated')
    if (activations.length !== properties.length) add('events', 'activation-events', `${activations.length} property.activated events but ${properties.length} properties`)

    // Properties: each belongs to this installation, at an event that records it, by a committed intent.
    for (const p of properties) {
      const label = `property ${p.id} (Friend ${p.token_id})`
      if (p.city_id !== row.id || p.city_instance_id !== row.instance_id) add('properties', 'city-instance', `${label} belongs to another city installation`)
      const at = own.find((e) => e.sequence === p.activated_sequence)
      if (!at || at.type !== 'property.activated' || Number(p.activated_sequence) > sequence) add('events', 'activation-events', `${label} is not recorded by a property.activated event at sequence ${p.activated_sequence}`)
      if (p.intent_status !== 'committed' || p.intent_property_id !== p.id) add('intents', 'property-intent', `${label} is not the property of a committed activation intent`)
    }
    if (counts.committedIntents !== properties.length) add('intents', 'committed-count', `${counts.committedIntents} committed activation intents but ${properties.length} properties`)
    if (check.mode === 'demo-fixture' && counts.intents > 0) add('intents', 'fixture-has-intents', `an ordinary demo fixture city has ${counts.intents} activation intents`)

    // Ownership eras: numbered from 1 without a gap, opened by the activation, at most one open and only the last.
    const byProperty = new Map<string, EraRow[]>()
    for (const e of eras) byProperty.set(e.property_id, [...(byProperty.get(e.property_id) ?? []), e])
    for (const p of properties) {
      const list = byProperty.get(p.id) ?? []
      const label = `property ${p.id} (Friend ${p.token_id})`
      if (list.length === 0) {
        add('eras', 'missing-era', `${label} has no ownership era`)
        continue
      }
      if (list.some((e, i) => e.era_number !== i + 1)) add('eras', 'numbering', `${label} has ownership eras that are not numbered 1, 2, 3 ...`)
      if (list[0].start_reason !== 'activation' || list[0].owner_wallet_id !== p.activated_by_wallet_id) add('eras', 'first-era', `${label} has a first era that is not the activating wallet's`)
      if (list.slice(0, -1).some((e) => e.ended_at === null)) add('eras', 'open-era', `${label} has an open era that is not its latest`)
      list.forEach((e, i) => {
        const next = list[i + 1]
        if (next && e.ended_at && e.ended_at.getTime() > next.started_at.getTime()) add('eras', 'overlap', `${label} has era ${e.era_number} ending after era ${next.era_number} begins`)
        if (e.owner_wallet_id && (e.wallet_address !== e.owner_address || e.wallet_user_id !== e.owner_user_id)) add('eras', 'owner-wallet', `${label} has era ${e.era_number} whose wallet, user and owner address are not one owner`)
      })
      // The city state projects the current owner: while an era is open for a known user, the building is theirs.
      const open = list.at(-1)
      const building = state?.buildings && Object.hasOwn(state.buildings, p.building_id) ? state.buildings[p.building_id] : undefined
      if (open && open.ended_at === null && open.owner_user_id !== null && building && building.ownerId !== open.owner_user_id)
        add('eras', 'owner-parity', `${label} belongs to user ${open.owner_user_id} in its open era, but its building is owned by "${String(building.ownerId)}" in the city state`)
    }
    for (const id of byProperty.keys()) if (!properties.some((p) => p.id === id)) add('eras', 'orphan-era', `ownership eras exist for unknown property ${id}`)

    return {
      ok: violations.length === 0,
      city: { id: row.id, instance: row.instance_id, sequence, stateVersion: row.state_version, canonical: row.canonical, origin: row.origin, activationRehearsal: row.activation_rehearsal, mode: check.mode },
      counts,
      violations,
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
  }
}
