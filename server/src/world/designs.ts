import pg, { type PoolClient } from 'pg'
import { environmentStamp } from '../city/store'
import type { AppMode } from '../config'
import type { Database } from '../db/pool'
import { withTransaction } from '../db/transaction'
import { appearanceOf, CURRENT_DESIGN_CATALOG, DESIGN_CATALOGS, DESIGN_SLOTS, isCatalogChoice, parseAssetKey, sameDesign, type DesignCatalog, type DesignChoice } from '../engine'
import type { Logger } from '../log'
import type { ExpectedActor, LivePlaySession, PlaySessionService } from '../play/session'
import type { ConstructionAuthority } from './construction'
import { lockWorldForChange, WorldRefusal, type ActivatorIdentity, type WorldScope } from './store'

/**
 * ARCHITECT PROPERTY DESIGN, AUTHORITATIVE PERSISTENCE (P1-C2-E4A, P1-C2-E4B, P1-C2-E4C). LOCAL ONLY, LOCAL TEST CONTROL
 * ONLY, FREE.
 *
 * What a property's current NFT controller can CHOOSE about how its building is drawn: a facade finish, a roof
 * silhouette, a window treatment, an exterior lighting treatment, an entrance treatment and a landscaping treatment from
 * the engine's current design catalog (`CURRENT_DESIGN_CATALOG`, `src/world/design.ts`; migrations 0015 to 0017).
 * Identifiers only, each one the standard renderer already draws. Nothing here spends a test credit, builds a unit,
 * changes a tier, a founder, a plot, a district or a city sequence, or touches RF, Proofy Points or any economy. The one caller outside tests is the
 * local rehearsal (`rehearsal.ts`), whose routes exist only in a local deployment started with an explicit rehearsal
 * file; like construction it refuses any mode or database but a local one, and so does the database (migration 0015).
 *
 * WHAT THE BROWSER DECIDES: which property, which choices of which catalog, the revision it was editing on, and the id
 * of this one save. Nothing else, and nothing it sends is drawn as sent: the server stores only identifiers the
 * catalog lists, and the page draws them through the city's own art.
 *
 * WHO MAY SAVE. Only the player the trusted source (`ConstructionAuthority`, locally the rehearsal file: TEST DATA, never
 * verified ownership) names, by the Discord user Proofy Play redeemed for their session, as the NFT's current controller
 * in this world's Discord server, asked again for every save under the city lock. Founding the property authorizes
 * nothing; a patron, the founder, a former controller and anyone else may look but not change it. A city whose Discord
 * server the trusted source has no data for at all saves nothing (`design_not_open`); saved designs are read everywhere.
 *
 * TRANSFER. A design belongs to the property: when the source names another controller, the saved design stays and is
 * drawn as before, the former controller can no longer change it, and the new one can. Nothing is cleared. (Public owner
 * media, which has its own transfer rules, is not a design and is not here.)
 *
 * REVISIONS. Every save is the property's next revision, append-only (`world_property_designs`); the latest is its design,
 * and a later save can restore any earlier one. A save names the revision it was made on (`baseRevision`, 0 for a property
 * never designed): if the property has moved on since, it is refused (`design_stale`) and nothing is written, so two
 * editors never overwrite each other unseen. A save identical to the current design is refused (`design_unchanged`).
 *
 * ONE TRANSACTION, or nothing, on the city row's lock (FOR UPDATE, as constructions, activations and adoptions take it),
 * so every save is judged on the property as the one before left it; the play session is locked FOR SHARE and must be
 * live. The city row itself is not changed.
 *
 * IDEMPOTENCY. The page names each save with a fresh UUID (`actionId`), unique per world. The same player repeating it,
 * for exactly the same property, catalog, choices and base revision, gets the design it saved back (`fresh: false`) and
 * saves nothing more; any other use of that id is refused (`action_conflict`), so a lost answer can never apply a
 * different design under it.
 *
 * CATALOG VERSIONS. Every saved design is read by the catalog it names, forever: an `architect-design-v1` design (a facade
 * and a roof, no other treatment) and an `architect-design-v2` design (no entrance or landscaping treatment) are answered
 * exactly as they were saved, and drawn with the treatments they were saved with. New designs are chosen from the current
 * catalog only. A save named in an earlier catalog is still answered from its row if it was recorded (the same id,
 * exactly as first sent: its original receipt); if it never was, it is refused (`design_retired`) and nothing is written,
 * so a page left open on an earlier editor never saves a different design than the one it showed (a v2 save would
 * otherwise drop the property's current entrance and landscaping unseen).
 */
export type WorldDesignRefusalCode =
  /** This deployment does not save designs (anything but a local database). */
  | 'mutations_held'
  /** The trusted source has no data at all for this Discord server's city: nobody can be its controller here. */
  | 'design_not_open'
  /** The world could not be read as one this build wrote, or its storage failed. */
  | 'world_unavailable'
  /** Another save was written at the same moment (should not happen under its lock). Nothing was written by this one. */
  | 'sequence_conflict'
  /** The play session ended before the design could be written. Nothing was. */
  | 'session_ended'
  /** The property is not one of this world's. */
  | 'unknown_property'
  /** The trusted source names someone else as the NFT's current controller. */
  | 'not_current_controller'
  /** The trusted source names nobody as the NFT's current controller. */
  | 'control_unverified'
  /** Not exactly a choice of a catalog this build has (every slot it chooses, and no other). */
  | 'design_unsupported'
  /** A choice of an earlier catalog, never recorded under this id: new designs are chosen from the current catalog only. Nothing was written. */
  | 'design_retired'
  /** The property's design changed after the revision this save was made on. Nothing was written. */
  | 'design_stale'
  /** The save is exactly the property's current design. Nothing was written. */
  | 'design_unchanged'
  /** The action id already names another save (another player's, property's, revision's or design's). */
  | 'action_conflict'

export class WorldDesignRefusal extends Error {
  readonly code: WorldDesignRefusalCode
  constructor(code: WorldDesignRefusalCode, message: string = code) {
    super(message)
    this.name = 'WorldDesignRefusal'
    this.code = code
  }
}

/** What a save names. Untyped: checked here. */
export interface DesignInput {
  propertyId: unknown
  actionId: unknown
  baseRevision: unknown
  catalog: unknown
  facade: unknown
  roof: unknown
  /** Absent in a save of a catalog without windows or lighting (v1): exactly what such a save names. */
  windows?: unknown
  lighting?: unknown
  /** Absent in a save of a catalog without an entrance or landscaping (v1, v2): exactly what such a save names. */
  entrance?: unknown
  landscaping?: unknown
}

/** A saved design, as stored: null for each slot its catalog does not have (v1: all four treatments; v2: entrance and landscaping). */
export interface DesignRecord extends DesignChoice {
  propertyId: string
  buildingId: string
  revision: number
  actionId: string
  catalog: string
  designer: ActivatorIdentity
  /** The city's sequence when it was saved. */
  atCitySequence: number
  designedAt: string
}

export interface DesignResult {
  /** false when this action had already saved: nothing was written. */
  fresh: boolean
  design: DesignRecord
}

/** A property's design as `viewer` may see it. */
export interface DesignOverview {
  catalog: DesignCatalog
  property: { propertyId: string; buildingId: string }
  /** The latest saved revision, or null: drawn with the catalog's default. */
  saved: (DesignChoice & { revision: number; catalog: string; atCitySequence: number; at: string }) | null
  /** Who the trusted source names as the NFT's current controller, as the viewer may know it. Never verified. */
  control: 'viewer' | 'other' | 'unknown'
  /** Whether the trusted source has data for this city at all (where it has none, nobody can save). */
  open: boolean
  /** Saved revisions, newest first (at most DESIGN_HISTORY_LIMIT), and how many there are. `by` says only whether it was the viewer. */
  history: (DesignChoice & { revision: number; catalog: string; by: 'viewer' | 'other'; at: string })[]
  historyCount: number
}

/** The saved design of one property, as the whole city draws it. */
export interface CityDesign extends DesignChoice {
  propertyId: string
  buildingId: string
  revision: number
  catalog: string
}

export const DESIGN_HISTORY_LIMIT = 20

/** Points inside the write at which a test may make it fail, or act, to prove nothing is left half-written. */
export type DesignStep = 'locked' | 'checked' | 'designed'

export interface WorldDesignStore {
  /** Save one design for a session `requireActor` returned. LOCAL ONLY: see the top of this file. */
  save(actor: LivePlaySession, input: DesignInput, authority: ConstructionAuthority): Promise<DesignResult>
  /** A property's design as `viewer` may see it. Read only: one snapshot, no lock, nothing written. */
  overview(viewer: LivePlaySession, propertyId: unknown, authority: ConstructionAuthority): Promise<DesignOverview>
  /** The saved design of every property of the viewer's world that has one, in activation order. Read only. */
  city(viewer: LivePlaySession): Promise<CityDesign[]>
}

export interface WorldDesignStoreOptions {
  mode: AppMode
  log: Logger
  onStep?: (step: DesignStep) => void | Promise<void>
}

/** What `world_property_designs_guard` (0015) raises when the session is not live. */
const GUARD_SESSION_NOT_LIVE = 'a design is saved only in a live play session of its world'
const RAISE_EXCEPTION = 'P0001'
const UNIQUE_VIOLATION = '23505'

const LOCK_TIMEOUT = '5s'
const STATEMENT_TIMEOUT = '8s'
const IDLE_IN_TRANSACTION_TIMEOUT = '15s'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Revisions a save can name: far beyond any property's, well inside Postgres `integer`. */
const MAX_REVISION = 1_000_000

export interface DesignRow {
  property_id: string
  building_id: string
  revision: number
  action_id: string
  catalog: string
  facade: string
  roof: string
  windows: string | null
  lighting: string | null
  entrance: string | null
  landscaping: string | null
  designer_core_user_id: string
  designer_discord_user_id: string
  at_city_sequence: string
  designed_at: Date
}

const DESIGN_COLUMNS =
  'd.property_id, p.building_id, d.revision, d.action_id, d.catalog, d.facade, d.roof, d.windows, d.lighting, d.entrance, d.landscaping, d.designer_core_user_id, d.designer_discord_user_id, d.at_city_sequence, d.designed_at'

/** A stored row's choice, exactly: its six identifiers (null for a slot its catalog does not have). */
export const choiceOf = (r: Pick<DesignRow, 'facade' | 'roof' | 'windows' | 'lighting' | 'entrance' | 'landscaping'>): DesignChoice => ({
  facade: r.facade,
  roof: r.roof,
  windows: r.windows,
  lighting: r.lighting,
  entrance: r.entrance,
  landscaping: r.landscaping,
})

/** A stored row this build can read: its catalog one this build has, and its choices exactly that catalog's. Anything else is a world this build did not write. */
function readable(r: DesignRow): DesignRow {
  if (!Object.hasOwn(DESIGN_CATALOGS, r.catalog) || !isCatalogChoice(DESIGN_CATALOGS[r.catalog], choiceOf(r)))
    throw new WorldRefusal('world_unavailable', `property ${r.property_id} has a design (${r.catalog} ${DESIGN_SLOTS.map((s) => r[s]).join(' / ')}) this build does not draw`)
  return r
}

const recordOf = (r: DesignRow): DesignRecord => ({
  propertyId: r.property_id,
  buildingId: r.building_id,
  revision: r.revision,
  actionId: r.action_id,
  catalog: r.catalog,
  ...choiceOf(r),
  designer: { coreUserId: r.designer_core_user_id, discordUserId: r.designer_discord_user_id },
  atCitySequence: Number(r.at_city_sequence),
  designedAt: r.designed_at.toISOString(),
})

interface PropertyRef {
  id: string
  building_id: string
  chain: string
  standard: string
  contract: string
  token_id: string
}

/** A property of exactly the world `scope` names, through its whole binding. */
async function propertyIn(client: Pick<PoolClient, 'query'>, scope: WorldScope, propertyId: string): Promise<PropertyRef | null> {
  return (
    (
      await client.query<PropertyRef>(
        `SELECT p.id, p.building_id, p.chain, p.standard, p.contract, p.token_id
           FROM world_properties p JOIN world_play_bindings b ON b.world_id = p.world_id
          WHERE p.id = $1 AND p.world_id = $2 AND b.play_environment = $3 AND b.play_game_key = $4 AND b.play_installation_id = $5 AND b.discord_guild_id = $6`,
        [propertyId, scope.worldId, scope.environment, scope.gameKey, scope.installationId, scope.discordGuildId],
      )
    ).rows[0] ?? null
  )
}

const assetOf = (p: PropertyRef) => parseAssetKey(`${p.chain}/${p.standard}:${p.contract}/${p.token_id}`)

/** A property's saved revisions, newest first, each one this build can read (else `WorldRefusal`). Also read by the property legacy (`legacy.ts`). */
export const revisionsOf = async (client: Pick<PoolClient, 'query'>, propertyId: string) =>
  (await client.query<DesignRow>(`SELECT ${DESIGN_COLUMNS} FROM world_property_designs d JOIN world_properties p ON p.id = d.property_id WHERE d.property_id = $1 ORDER BY d.revision DESC`, [propertyId])).rows.map(readable)

export function createWorldDesignStore(db: Database, { mode, log, onStep }: WorldDesignStoreOptions): WorldDesignStore {
  const isRefusal = (err: unknown) => err instanceof WorldDesignRefusal || err instanceof WorldRefusal
  const catalog = CURRENT_DESIGN_CATALOG

  async function save(actor: LivePlaySession, input: DesignInput, authority: ConstructionAuthority): Promise<DesignResult> {
    // The service's own hold, before anything is read. The database holds the same line (0015).
    if (mode !== 'local') throw new WorldDesignRefusal('mutations_held', 'Designs are written only in a local database until live player mutations are authorized.')
    const { propertyId, actionId, baseRevision } = input
    if (typeof propertyId !== 'string' || !UUID.test(propertyId) || typeof actionId !== 'string' || !UUID.test(actionId)) throw new WorldDesignRefusal('unknown_property', 'The save names no property or action this server can read.')
    if (!Number.isSafeInteger(baseRevision) || (baseRevision as number) < 0 || (baseRevision as number) >= MAX_REVISION) throw new WorldDesignRefusal('design_stale', 'The save names no revision of this property.')
    // Exactly a choice of a catalog this build has, judged by the catalog the save names: only identifiers it lists, never
    // a color, markup or anything the browser made up. A save of a catalog without a slot names none for it.
    const named = typeof input.catalog === 'string' && Object.hasOwn(DESIGN_CATALOGS, input.catalog) ? DESIGN_CATALOGS[input.catalog] : null
    const slot = (v: unknown) => (v === undefined ? null : v)
    const choice = { facade: input.facade, roof: input.roof, windows: slot(input.windows), lighting: slot(input.lighting), entrance: slot(input.entrance), landscaping: slot(input.landscaping) }
    if (!named || !isCatalogChoice(named, choice)) throw new WorldDesignRefusal('design_unsupported', `That is not a design of ${catalog.key}.`)
    const base = baseRevision as number
    const where = { guildId: actor.scope.discordGuildId }
    if (!authority.opensIn(where)) throw new WorldDesignRefusal('design_not_open', 'Property design is not open in this city on this local server.')

    return withTransaction(db, isRefusal, async (client) => {
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT}'`)
      const stamp = await environmentStamp(client)
      if (stamp !== 'local') throw new WorldDesignRefusal('mutations_held', `the database is stamped "${stamp ?? 'unstamped'}"; designs are written only in a local database`)

      // The world exactly as the session names it, its city locked FOR UPDATE: every save of this world queues here.
      const read = await lockWorldForChange(client, actor.scope)
      await onStep?.('locked')
      // The session, locked until this transaction ends: its row names the designer, as Proofy Play's redeemed run named them.
      const live = (
        await client.query<{ core_user_id: string; discord_user_id: string }>(
          'SELECT core_user_id, discord_user_id FROM play_sessions WHERE id = $1 AND world_id = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR SHARE',
          [actor.id, actor.scope.worldId],
        )
      ).rows
      if (live.length !== 1) throw new WorldDesignRefusal('session_ended', 'The play session ended before the design was saved.')
      const designer: ActivatorIdentity = { coreUserId: live[0].core_user_id, discordUserId: live[0].discord_user_id }

      // The same save again: the design it saved, for the player who saved it, and only for exactly that. A save recorded from
      // an earlier catalog is answered so too, from its row, exactly as it was saved.
      const done = (
        await client.query<DesignRow>(`SELECT ${DESIGN_COLUMNS} FROM world_property_designs d JOIN world_properties p ON p.id = d.property_id WHERE d.world_id = $1 AND d.action_id = $2`, [actor.scope.worldId, actionId])
      ).rows[0]
      if (done) {
        const same =
          done.property_id === propertyId &&
          done.catalog === named.key &&
          DESIGN_SLOTS.every((s) => done[s] === choice[s]) &&
          done.revision === base + 1 &&
          done.designer_core_user_id === designer.coreUserId &&
          done.designer_discord_user_id === designer.discordUserId
        if (!same) throw new WorldDesignRefusal('action_conflict', 'This action id already names another design save.')
        return { fresh: false, design: recordOf(readable(done)) }
      }
      // Never recorded, and not of the current catalog: it is not saved now as anything else.
      if (named.key !== catalog.key)
        throw new WorldDesignRefusal('design_retired', `That design was chosen from ${named.key}, which no longer takes new saves; designs are chosen from ${catalog.key} now.`)

      const property = await propertyIn(client, actor.scope, propertyId)
      const asset = property && assetOf(property)
      if (!property || !asset) throw new WorldDesignRefusal('unknown_property', 'That is not a property of this city.')

      // Who controls the NFT now, as the trusted source says it today: never the founder, never the browser.
      const controller = authority.controllerOf(where, asset)
      if (controller === null) throw new WorldDesignRefusal('control_unverified', 'Nobody is named as this NFT\'s current controller, so nobody can change its design.')
      if (controller !== designer.discordUserId) throw new WorldDesignRefusal('not_current_controller', 'You are not named as this NFT\'s current controller.')

      const [latest] = await revisionsOf(client, property.id)
      if ((latest?.revision ?? 0) !== base) throw new WorldDesignRefusal('design_stale', `This property's design is at revision ${latest?.revision ?? 0}; the save was made on revision ${base}.`)
      if (sameDesign(latest ? appearanceOf(choiceOf(latest)) : catalog.default, appearanceOf(choice))) throw new WorldDesignRefusal('design_unchanged', 'That is already this property\'s design.')
      await onStep?.('checked')

      const row = (
        await client.query<Omit<DesignRow, 'building_id'>>(
          `INSERT INTO world_property_designs (world_id, city_id, city_instance_id, property_id, revision, action_id, catalog, facade, roof, windows, lighting, entrance, landscaping,
                                              designer_core_user_id, designer_discord_user_id, designed_in_play_session, authority, at_city_sequence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'local-fixture-controller', $17)
           RETURNING property_id, revision, action_id, catalog, facade, roof, windows, lighting, entrance, landscaping, designer_core_user_id, designer_discord_user_id, at_city_sequence, designed_at`,
          [
            actor.scope.worldId,
            read.cityId,
            read.instance,
            property.id,
            base + 1,
            actionId,
            catalog.key,
            choice.facade,
            choice.roof,
            choice.windows,
            choice.lighting,
            choice.entrance,
            choice.landscaping,
            designer.coreUserId,
            designer.discordUserId,
            actor.id,
            read.sequence,
          ],
        )
      ).rows[0]
      await onStep?.('designed')
      return { fresh: true, design: recordOf({ ...row, building_id: property.building_id }) }
    })
  }

  return {
    async save(actor, input, authority) {
      let result: DesignResult
      try {
        result = await save(actor, input, authority)
      } catch (err) {
        if (err instanceof WorldDesignRefusal) throw err
        if (err instanceof WorldRefusal) throw new WorldDesignRefusal('world_unavailable', err.message)
        if (err instanceof pg.DatabaseError && err.code === RAISE_EXCEPTION && err.message === GUARD_SESSION_NOT_LIVE) throw new WorldDesignRefusal('session_ended', 'The play session ended before the design was saved.')
        // Only past the lock this store always takes could another writer have taken the action id or the revision first;
        // answering a repeat needs a fresh read, so the caller is told to ask again (nothing was written by this one).
        if (err instanceof pg.DatabaseError && err.code === UNIQUE_VIOLATION) throw new WorldDesignRefusal('sequence_conflict', 'Another design was saved at the same moment; nothing was written by this one.')
        throw err
      }
      if (result.fresh) log.info('world property designed', { world: actor.scope.worldId, property: result.design.propertyId, revision: result.design.revision, catalog: result.design.catalog })
      return result
    },

    async overview(viewer, propertyIdInput, authority) {
      if (typeof propertyIdInput !== 'string' || !UUID.test(propertyIdInput)) throw new WorldDesignRefusal('unknown_property')
      const propertyId = propertyIdInput
      const who = viewer.player
      const where = { guildId: viewer.scope.discordGuildId }
      try {
        return await withTransaction(db, isRefusal, async (client) => {
          await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
          await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
          const property = await propertyIn(client, viewer.scope, propertyId)
          const asset = property && assetOf(property)
          if (!property || !asset) throw new WorldDesignRefusal('unknown_property', 'That is not a property of this city.')
          const rows = await revisionsOf(client, property.id)
          const controller = authority.controllerOf(where, asset)
          const latest = rows[0]
          return {
            catalog,
            property: { propertyId: property.id, buildingId: property.building_id },
            saved: latest ? { revision: latest.revision, catalog: latest.catalog, ...choiceOf(latest), atCitySequence: Number(latest.at_city_sequence), at: latest.designed_at.toISOString() } : null,
            control: controller === null ? 'unknown' : controller === who.discordUserId ? 'viewer' : 'other',
            open: authority.opensIn(where),
            history: rows.slice(0, DESIGN_HISTORY_LIMIT).map((r) => ({
              revision: r.revision,
              catalog: r.catalog,
              ...choiceOf(r),
              by: r.designer_discord_user_id === who.discordUserId && r.designer_core_user_id === who.coreUserId ? ('viewer' as const) : ('other' as const),
              at: r.designed_at.toISOString(),
            })),
            historyCount: rows.length,
          }
        })
      } catch (err) {
        if (err instanceof WorldRefusal) throw new WorldDesignRefusal('world_unavailable', err.message)
        throw err
      }
    },

    async city(viewer) {
      const s = viewer.scope
      try {
        return await withTransaction(db, isRefusal, async (client) => {
          await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
          await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
          // The latest revision of every property of exactly the world the session names, through its whole binding.
          const rows = (
            await client.query<DesignRow>(
              `SELECT DISTINCT ON (p.activated_sequence) ${DESIGN_COLUMNS}
                 FROM world_property_designs d JOIN world_properties p ON p.id = d.property_id AND p.world_id = d.world_id
                 JOIN world_play_bindings b ON b.world_id = p.world_id
                WHERE p.world_id = $1 AND b.play_environment = $2 AND b.play_game_key = $3 AND b.play_installation_id = $4 AND b.discord_guild_id = $5
                ORDER BY p.activated_sequence, d.revision DESC`,
              [s.worldId, s.environment, s.gameKey, s.installationId, s.discordGuildId],
            )
          ).rows.map(readable)
          return rows.map((r) => ({ propertyId: r.property_id, buildingId: r.building_id, revision: r.revision, catalog: r.catalog, ...choiceOf(r) }))
        })
      } catch (err) {
        if (err instanceof WorldRefusal) throw new WorldDesignRefusal('world_unavailable', err.message)
        throw err
      }
    },
  }
}

/**
 * The only composition a design save may use: `requireActor` (the cookie's live session must be exactly the one the page
 * drew, and Play must answer `active` now), then the store, with the trusted source.
 */
export function createDesignService({ sessions, store, authority }: { sessions: Pick<PlaySessionService, 'requireActor'>; store: WorldDesignStore; authority: ConstructionAuthority }) {
  return {
    async save(presented: string | null, expected: ExpectedActor, input: DesignInput): Promise<DesignResult> {
      const actor = await sessions.requireActor(presented, expected)
      return store.save(actor, input, authority)
    },
  }
}
