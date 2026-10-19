import type { AppMode } from '../config'
import { assetKey, parseAssetKey, REHEARSAL_MARK, type NftAsset, type RehearsalActivationResponse, type RehearsalAssetsResponse, type RehearsalErrorCode } from '../engine'
import { PlaySessionError, type PlaySessionService } from '../play/session'
import { createPropertyActivationService, WorldPropertyRefusal, type WorldPropertyRefusalCode, type WorldPropertyStore } from './properties'

/**
 * THE LOCAL PROPERTY REHEARSAL (P1-C2-B2B): the whole player flow of placing a Tier 0 property,
 * end to end, against the real session, world store and property store, in a LOCAL deployment.
 * NOT a production authorization, and not a path to one:
 *
 *   - It exists only when the server runs with APP_MODE=local AND LOCAL_PROPERTY_REHEARSAL_FILE
 *     (config refuses the file in any other mode; the app mounts no route without it; this module
 *     refuses to be built for any other mode). The property store refuses any mode or database but
 *     local, and the database refuses a world property anywhere but a local database (0007).
 *   - WHICH NFTs a player may place is the file, keyed by the Discord user id Proofy Play redeemed
 *     for the session. It is TEST DATA: no contract can say what a Proofy player holds (a fresh
 *     Core NFT / role / collection eligibility contract does not exist). The browser only names one
 *     of the NFTs listed for it, and that is checked again here; nothing it asserts is believed.
 *   - Districts with a Proofy rule are refused: no contract can check one.
 *   - Who acts is `requireActor`: the cookie's live session must be exactly the one the page drew
 *     (session, world, player), and Play must answer `active` now (no cache, no grace).
 *
 * Manual district choice is rehearsal-only test behavior: a live city assigns each player's default
 * district (locked policy, not implemented). Still open, and not replaced here: F5 (browser-bound launch), F7 (fresh membership and
 * entitlement), F3 (Play game status), Core NFT eligibility and a separate non-owner database role.
 * (Each property's original activator is recorded permanently since migration 0008.)
 */

/** The rehearsal file's `kind`. */
export const REHEARSAL_FILE_KIND = 'rare-city/local-property-rehearsal-v1'
const MAX_PLAYERS = 200
const MAX_ASSETS_PER_PLAYER = 200
const DISCORD_ID = /^[0-9]{15,25}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PLOT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-w(?:0|[1-9][0-9]{0,5})-p(?:0|[1-9][0-9]{0,5})$/
const REQUEST_KEYS = ['asset', 'discordUserId', 'plotId', 'sessionRef', 'worldId']

/** Which test NFTs each player may place, by Discord user id. */
export type RehearsalGrants = ReadonlyMap<string, readonly NftAsset[]>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The rehearsal file, strictly: `{ "kind": "rare-city/local-property-rehearsal-v1", "players": { "<discord user id>":
 * ["<CAIP-19 asset id>", …] } }`, every asset id in its one canonical spelling. Throws with the reason otherwise.
 */
export function parseRehearsalGrants(raw: unknown): RehearsalGrants {
  if (!isRecord(raw) || Object.keys(raw).sort().join() !== 'kind,players' || raw.kind !== REHEARSAL_FILE_KIND || !isRecord(raw.players))
    throw new Error(`a local rehearsal file is exactly { "kind": "${REHEARSAL_FILE_KIND}", "players": { … } }`)
  const entries = Object.entries(raw.players)
  if (entries.length > MAX_PLAYERS) throw new Error(`a local rehearsal file lists at most ${MAX_PLAYERS} players`)
  const grants = new Map<string, readonly NftAsset[]>()
  for (const [player, list] of entries) {
    if (!DISCORD_ID.test(player)) throw new Error(`"${player}" is not a Discord user id`)
    if (!Array.isArray(list) || list.length > MAX_ASSETS_PER_PLAYER) throw new Error(`player ${player} must list at most ${MAX_ASSETS_PER_PLAYER} assets`)
    const assets: NftAsset[] = []
    for (const key of list) {
      const asset = parseAssetKey(key)
      if (!asset) throw new Error(`player ${player} lists ${JSON.stringify(key)}, which is not a canonical ERC-721 CAIP-19 asset id`)
      if (assets.some((a) => assetKey(a) === key)) throw new Error(`player ${player} lists ${key} twice`)
      assets.push(asset)
    }
    grants.set(player, Object.freeze(assets))
  }
  return grants
}

/** A refusal of the rehearsal routes, as the status and `{ "error": code }` it is answered with. */
export class RehearsalRefusal extends Error {
  readonly status: number
  readonly code: RehearsalErrorCode | 'invalid_request'
  constructor(status: number, code: RehearsalErrorCode | 'invalid_request', message: string = code) {
    super(message)
    this.name = 'RehearsalRefusal'
    this.status = status
    this.code = code
  }
}

/** How each store refusal is answered. `session_ended` is the session layer's own answer. */
const REFUSALS: Record<Exclude<WorldPropertyRefusalCode, 'session_ended' | 'world_unavailable'>, [number, RehearsalErrorCode]> = {
  'invalid-asset': [400, 'invalid_asset'],
  'asset-not-in-world': [422, 'asset_not_in_world'],
  'asset-already-placed': [409, 'asset_already_placed'],
  'unknown-plot': [422, 'unknown_plot'],
  'plot-unavailable': [409, 'plot_unavailable'],
  'district-rule-unverified': [403, 'district_rule_unverified'],
  mutations_held: [403, 'mutations_held'],
  sequence_conflict: [409, 'sequence_conflict'],
}

export interface LocalPropertyRehearsal {
  /** The test NFTs the cookie's player may place. Throws PlaySessionError (401 without a live session). */
  assets(presented: string | null): Promise<RehearsalAssetsResponse>
  /** Place one, for exactly the actor the page names. Throws RehearsalRefusal or PlaySessionError. */
  activate(presented: string | null, body: Record<string, unknown>): Promise<RehearsalActivationResponse>
}

export interface LocalPropertyRehearsalOptions {
  mode: AppMode
  grants: RehearsalGrants
  sessions: Pick<PlaySessionService, 'session' | 'requireActor'>
  store: WorldPropertyStore
}

export function createLocalPropertyRehearsal({ mode, grants, sessions, store }: LocalPropertyRehearsalOptions): LocalPropertyRehearsal {
  if (mode !== 'local') throw new Error(`the local property rehearsal runs only with APP_MODE=local, not ${mode}`)
  const service = createPropertyActivationService({ sessions, store })
  const granted = (player: string, key: string) => (grants.get(player) ?? []).some((a) => assetKey(a) === key)

  return {
    async assets(presented) {
      const session = await sessions.session(presented)
      const assets = (grants.get(session.player.discordUserId) ?? []).map((a) => ({ asset: assetKey(a), chain: a.chain, contract: a.contract, tokenId: a.tokenId }))
      return { rehearsal: REHEARSAL_MARK, assets }
    },

    async activate(presented, body) {
      if (Object.keys(body).sort().join() !== REQUEST_KEYS.join()) throw new RehearsalRefusal(400, 'invalid_request')
      const { sessionRef, worldId, discordUserId, asset: key, plotId } = body
      if (typeof sessionRef !== 'string' || !UUID.test(sessionRef) || typeof worldId !== 'string' || !UUID.test(worldId) || typeof discordUserId !== 'string' || !DISCORD_ID.test(discordUserId))
        throw new RehearsalRefusal(400, 'invalid_request')
      const asset = parseAssetKey(key)
      if (!asset) throw new RehearsalRefusal(400, 'invalid_asset')
      if (typeof plotId !== 'string' || !PLOT_ID.test(plotId)) throw new RehearsalRefusal(422, 'unknown_plot')

      let result
      try {
        result = await service.activate(
          presented,
          { sessionRef, worldId, discordUserId },
          { asset, plotId },
          {
            refuseRuleGatedDistricts: true,
            // The player Proofy Play redeemed for the session, never one the request names, must be listed for this NFT.
            authorize: (actor) => {
              if (!granted(actor.player.discordUserId, assetKey(asset))) throw new RehearsalRefusal(403, 'rehearsal_asset_not_granted')
            },
          },
        )
      } catch (err) {
        if (!(err instanceof WorldPropertyRefusal)) throw err
        if (err.code === 'session_ended') throw new PlaySessionError(401, 'play_session_required', err.message)
        if (err.code === 'world_unavailable') throw new PlaySessionError(503, 'world_unavailable', err.message)
        const [status, code] = REFUSALS[err.code]
        throw new RehearsalRefusal(status, code, err.message)
      }
      const p = result.property
      return {
        rehearsal: REHEARSAL_MARK,
        fresh: result.fresh,
        sequence: result.sequence,
        property: { id: p.id, buildingId: p.buildingId, asset: p.asset, collection: p.collection, plotId: p.plotId, districtKey: p.districtKey, ward: p.ward, plot: p.plot, sequence: p.sequence, configVersion: p.configVersion, activatedAt: p.activatedAt },
      }
    },
  }
}
