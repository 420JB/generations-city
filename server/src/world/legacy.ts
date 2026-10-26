import type { PoolClient } from 'pg'
import type { Database } from '../db/pool'
import { withTransaction } from '../db/transaction'
import { constructionTier, nextTierAt, parseAssetKey, recipeMaxTier, type ConstructionRecipe, type DesignChoice } from '../engine'
import type { LivePlaySession } from '../play/session'
import { WorldConstructionRefusal, type ConstructionAuthority, type ConstructionRole } from './construction'
import { choiceOf, revisionsOf } from './designs'
import { WorldRefusal } from './store'

/**
 * PROPERTY LEGACY (P1-C2-E5A). READ ONLY: one property's whole history as a viewer of its world may see it, from the
 * records that already exist and nothing else. Nothing here is written, locked, counted again or kept: no rank, level,
 * XP, badge, reward or credit exists, and none is implied.
 *
 *   - FOUNDING: the property's original activator (`world_properties`, 0008), permanent: the viewer, someone else (never
 *     named), or never recorded (placed before 0008). Founding is never control, and a transfer never changes it.
 *   - CONTROL: whom the trusted source (`ConstructionAuthority`, locally the rehearsal file: TEST DATA, never verified
 *     ownership) names as the NFT's current controller now: the viewer, someone else, or nobody.
 *   - CONTROL ERAS: every era the construction records saw (`world_property_control_eras`, 0013), newest first, each with
 *     the units built in it by its controller (owner units) and by patrons, and whether it is the current one (its
 *     controller is still the one the source names) and the viewer's own. Nobody is named; an earlier controller's units
 *     stay theirs, in their era, and a later controller inherits none of them.
 *   - INVESTMENT: the property's lifetime units split exactly as the construction view splits them: the current
 *     controller's (owner units of the current era), previous controllers' (every other owner unit) and the community's
 *     (every patron unit, whichever era). The three always add up to the lifetime units the city stores.
 *   - YOURS: what the viewer built on THIS property, by role: their personal record, apart from the property's total.
 *   - DESIGNS: the property's saved revisions (`world_property_designs`, 0015 to 0017), newest first, each read by the
 *     catalog it names and attributed only by relation: saved by the viewer or not, and by the controller the source names
 *     now or under earlier control (only the controller of the day can save, 0015). A design is not construction: it adds
 *     no unit, tier or credit, and is never counted in any total here.
 *
 * Who the viewer is comes from their play session alone (the player Proofy Play redeemed for it, both ids), never from
 * anything a request names; the property must be one of exactly the world the session names, through its whole binding.
 */
export interface PropertyLegacyEra {
  era: number
  /** Its controller is the one the source names now. */
  current: boolean
  /** Its controller is the viewer. */
  yours: boolean
  /** Units its controller built in it, as the owner. */
  ownerUnits: number
  /** Units patrons built while it was the property's era. */
  patronUnits: number
  actions: number
  tierBefore: number
  tierAfter: number
  firstSequence: number
  lastSequence: number
}

export interface PropertyLegacyRevision extends DesignChoice {
  revision: number
  catalog: string
  by: 'viewer' | 'other'
  /** Whether the player who saved it is the NFT's controller the source names now, or controlled it earlier. */
  savedBy: 'current-controller' | 'earlier-controller'
  atCitySequence: number
  at: string
}

export interface PropertyLegacy {
  recipe: ConstructionRecipe
  property: { propertyId: string; buildingId: string; tier: number; built: number; nextTierAt: number | null; maxTier: number; activatedSequence: number; foundingOrder: number }
  founding: 'viewer' | 'other' | 'unrecorded'
  /** Whether the trusted source has any data for this city (without it nobody controls, builds or designs here). */
  open: boolean
  control: 'viewer' | 'other' | 'unknown'
  investment: { currentController: number; previousControllers: number; community: number; total: number }
  yours: { ownerUnits: number; currentEraOwnerUnits: number; earlierEraOwnerUnits: number; patronUnits: number; actions: number }
  /** Newest first, at most LEGACY_ERA_LIMIT, and how many there are. */
  eras: PropertyLegacyEra[]
  eraCount: number
  /** Patron units built while no controller was named (no era). */
  unattributed: { patronUnits: number; actions: number }
  contributors: { owners: number; patrons: number }
  /** Newest first, at most LEGACY_REVISION_LIMIT, and how many there are. */
  designs: PropertyLegacyRevision[]
  designCount: number
}

export const LEGACY_ERA_LIMIT = 20
export const LEGACY_REVISION_LIMIT = 20

const STATEMENT_TIMEOUT = '8s'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface LegacyPropertyRow {
  id: string
  building_id: string
  chain: string
  standard: string
  contract: string
  token_id: string
  activated_sequence: string
  activator_core_user_id: string | null
  activator_discord_user_id: string | null
  founding_order: string
}

interface LegacyConstructionRow {
  sequence: string
  role: ConstructionRole
  contributor_core_user_id: string
  contributor_discord_user_id: string
  control_era_seq: number | null
  units: number
  built_after: number
  tier_before: number
  tier_after: number
}

const sumUnits = (rows: readonly { units: number }[]) => rows.reduce((n, r) => n + r.units, 0)

/** One property's legacy as `viewer` may see it. Read only: one snapshot, no lock, nothing written. */
export async function readPropertyLegacy(db: Database, recipe: ConstructionRecipe, viewer: LivePlaySession, propertyIdInput: unknown, authority: ConstructionAuthority): Promise<PropertyLegacy> {
  if (typeof propertyIdInput !== 'string' || !UUID.test(propertyIdInput)) throw new WorldConstructionRefusal('unknown_property')
  const propertyId = propertyIdInput
  const who = viewer.player
  const where = { guildId: viewer.scope.discordGuildId }
  const s = viewer.scope
  const isRefusal = (err: unknown) => err instanceof WorldConstructionRefusal || err instanceof WorldRefusal
  try {
    return await withTransaction(db, isRefusal, async (client: PoolClient) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
      // A property of exactly the world the session names, through its whole binding: nothing of another world or installation.
      const p = (
        await client.query<LegacyPropertyRow>(
          `SELECT p.id, p.building_id, p.chain, p.standard, p.contract, p.token_id, p.activated_sequence, p.activator_core_user_id, p.activator_discord_user_id,
                  (SELECT count(*) FROM world_properties o WHERE o.world_id = p.world_id AND o.activated_sequence <= p.activated_sequence) AS founding_order
             FROM world_properties p JOIN world_play_bindings b ON b.world_id = p.world_id
            WHERE p.id = $1 AND p.world_id = $2 AND b.play_environment = $3 AND b.play_game_key = $4 AND b.play_installation_id = $5 AND b.discord_guild_id = $6`,
          [propertyId, s.worldId, s.environment, s.gameKey, s.installationId, s.discordGuildId],
        )
      ).rows[0]
      const asset = p && parseAssetKey(`${p.chain}/${p.standard}:${p.contract}/${p.token_id}`)
      if (!p || !asset) throw new WorldConstructionRefusal('unknown_property', 'That is not a property of this city.')

      const rows = (
        await client.query<LegacyConstructionRow>(
          `SELECT sequence, role, contributor_core_user_id, contributor_discord_user_id, control_era_seq, units, built_after, tier_before, tier_after
             FROM world_property_constructions WHERE world_id = $1 AND property_id = $2 ORDER BY sequence`,
          [s.worldId, p.id],
        )
      ).rows
      const eraRows = (
        await client.query<{ era_seq: number; controller_discord_user_id: string }>('SELECT era_seq, controller_discord_user_id FROM world_property_control_eras WHERE world_id = $1 AND property_id = $2 ORDER BY era_seq', [
          s.worldId,
          p.id,
        ])
      ).rows
      const revisions = await revisionsOf(client, p.id)

      // Who controls the NFT now, as the trusted source says it today: never the founder, never the browser.
      const controller = authority.controllerOf(where, asset)
      const latest = eraRows.at(-1)
      // The current era is the latest, while the source still names its controller (exactly as the construction view says it).
      const currentEra = latest && controller !== null && latest.controller_discord_user_id === controller ? latest.era_seq : null
      const isMine = (r: LegacyConstructionRow) => r.contributor_discord_user_id === who.discordUserId && r.contributor_core_user_id === who.coreUserId
      const owner = rows.filter((r) => r.role === 'owner')
      const patron = rows.filter((r) => r.role === 'patron')
      const currentController = currentEra === null ? 0 : sumUnits(owner.filter((r) => r.control_era_seq === currentEra))
      const mine = rows.filter(isMine)
      const mineOwner = mine.filter((r) => r.role === 'owner')
      const mineCurrent = currentEra === null ? 0 : sumUnits(mineOwner.filter((r) => r.control_era_seq === currentEra))
      const built = rows.at(-1)?.built_after ?? 0

      const eras: PropertyLegacyEra[] = eraRows
        .map((e) => {
          const here = rows.filter((r) => r.control_era_seq === e.era_seq)
          return {
            era: e.era_seq,
            current: e.era_seq === currentEra,
            yours: e.controller_discord_user_id === who.discordUserId,
            ownerUnits: sumUnits(here.filter((r) => r.role === 'owner')),
            patronUnits: sumUnits(here.filter((r) => r.role === 'patron')),
            actions: here.length,
            tierBefore: here[0]?.tier_before ?? 0,
            tierAfter: here.at(-1)?.tier_after ?? 0,
            firstSequence: here.length ? Number(here[0].sequence) : 0,
            lastSequence: here.length ? Number(here.at(-1)!.sequence) : 0,
          }
        })
        // Every era began with a construction (0013), so none is empty; one that were would say nothing and is left out.
        .filter((e) => e.actions > 0)
        .reverse()
      const before = rows.filter((r) => r.control_era_seq === null)
      const distinct = (list: readonly LegacyConstructionRow[]) => new Set(list.map((r) => `${r.contributor_discord_user_id}/${r.contributor_core_user_id}`)).size

      return {
        recipe,
        property: {
          propertyId: p.id,
          buildingId: p.building_id,
          tier: constructionTier(recipe, built),
          built,
          nextTierAt: nextTierAt(recipe, built),
          maxTier: recipeMaxTier(recipe),
          activatedSequence: Number(p.activated_sequence),
          foundingOrder: Number(p.founding_order),
        },
        founding:
          p.activator_core_user_id === null || p.activator_discord_user_id === null ? 'unrecorded' : p.activator_discord_user_id === who.discordUserId && p.activator_core_user_id === who.coreUserId ? 'viewer' : 'other',
        open: authority.opensIn(where),
        control: controller === null ? 'unknown' : controller === who.discordUserId ? 'viewer' : 'other',
        investment: { currentController, previousControllers: sumUnits(owner) - currentController, community: sumUnits(patron), total: built },
        yours: {
          ownerUnits: sumUnits(mineOwner),
          currentEraOwnerUnits: mineCurrent,
          earlierEraOwnerUnits: sumUnits(mineOwner) - mineCurrent,
          patronUnits: sumUnits(mine.filter((r) => r.role === 'patron')),
          actions: mine.length,
        },
        eras: eras.slice(0, LEGACY_ERA_LIMIT),
        eraCount: eras.length,
        unattributed: { patronUnits: sumUnits(before), actions: before.length },
        contributors: { owners: distinct(owner), patrons: distinct(patron) },
        designs: revisions.slice(0, LEGACY_REVISION_LIMIT).map((r) => ({
          revision: r.revision,
          catalog: r.catalog,
          ...choiceOf(r),
          by: r.designer_discord_user_id === who.discordUserId && r.designer_core_user_id === who.coreUserId ? ('viewer' as const) : ('other' as const),
          savedBy: controller !== null && r.designer_discord_user_id === controller ? ('current-controller' as const) : ('earlier-controller' as const),
          atCitySequence: Number(r.at_city_sequence),
          at: r.designed_at.toISOString(),
        })),
        designCount: revisions.length,
      }
    })
  } catch (err) {
    // A design this build cannot read (a world it did not write): the property's legacy cannot be told whole.
    if (err instanceof WorldRefusal) throw new WorldConstructionRefusal('world_unavailable', err.message)
    throw err
  }
}
