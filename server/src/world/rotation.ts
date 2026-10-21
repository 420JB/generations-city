import type { PoolClient } from 'pg'
import {
  assetKey,
  defaultRotationDistricts,
  districtAuthorization,
  parseAssetKey,
  resolveDistrictRules,
  rotationDistrict,
  type DistrictRuleMatch,
  type NftAsset,
  type RuleAnswer,
  type World,
} from '../engine'
import { uuidv7 } from './ids'
import type { LockedWorld, WorldScope } from './store'

/**
 * THE ROTATION, ITS SLOTS AND TICKETS, in SQL (migration 0010): the pieces every transaction that
 * touches district tickets shares. The ticket store (`tickets.ts`) issues, reassigns and releases
 * with them; the world store (`store.ts`) keeps the rotation on the governing configuration in every
 * adoption's transaction; the property store (`properties.ts`) consumes a ticket in the activation's
 * transaction. Every function here runs on its caller's transaction and takes the rotation row's
 * lock before any ticket or slot (after the city's, when the caller holds it). See `tickets.ts` for
 * the whole lifecycle.
 */
export type DistrictTicketRefusalCode =
  /** This deployment or database does not issue tickets (anything but local). */
  | 'mutations_held'
  /** The world could not be read as one this build wrote. */
  | 'world_unavailable'
  /** The play session ended before anything could be written. */
  | 'session_ended'
  /** The player has no unplaced NFT of this city that the caller's eligibility check admits. No ticket was issued. */
  | 'not_eligible'
  /**
   * There is no default district to assign: every district of the city is restricted (has a Proofy rule), and the NFT
   * selected has no explicit rule that could authorize one.
   */
  | 'no_default_district'
  /** No such live ticket of this player in this world (unknown, someone else's, released or already committed). */
  | 'ticket_not_live'
  /** The ticket's lease ran out. */
  | 'ticket_expired'
  /** The city's rotation changed (its districts or their geometry): the ticket was superseded, and reissued if it had time left. */
  | 'ticket_superseded'
  /** Explicit rules matching the NFT name different districts, and no precedence is approved. */
  | 'district_rule_ambiguous'
  /** Explicit rules matching the NFT agree, but their ids together are longer than a ticket can record (`MAX_RULE_REF_LENGTH`). */
  | 'district_rule_ref_too_long'
  /** An explicit rule assigns the NFT to a restricted district, and there is no answer (missing, unknown or conflicting) to its Proofy rule for the player. */
  | 'district_rule_unverified'
  /** An explicit rule assigns the NFT to a restricted district, and its Proofy rule answered that the player does not qualify. */
  | 'district_rule_unqualified'
  | 'asset-not-in-world'
  | 'asset-already-placed'

export class DistrictTicketRefusal extends Error {
  readonly code: DistrictTicketRefusalCode
  constructor(code: DistrictTicketRefusalCode, message: string = code) {
    super(message)
    this.name = 'DistrictTicketRefusal'
    this.code = code
  }
}

export type DistrictTicketStatus = 'active' | 'released' | 'expired' | 'superseded' | 'committed'

/** A ticket as stored. `actor` and `sessionRef` are internal provenance: never answered to a browser. */
export interface DistrictTicket {
  id: string
  worldId: string
  installationId: string
  actor: { discordUserId: string; coreUserId: string }
  sessionRef: string
  kind: 'fallback' | 'rule'
  districtKey: string
  districtGeometryFingerprint: string
  epoch: number
  ordinal: number | null
  generation: number | null
  asset: string | null
  ruleRef: string | null
  configVersion: number
  configHash: string
  layoutGeometryFingerprint: string
  status: DistrictTicketStatus
  issuedAt: string
  expiresAt: string
  endedAt: string | null
  endReason: string | null
  propertyId: string | null
  committedSequence: number | null
  reissuedFrom: string | null
  /** The claim window it was issued in (0011); null only for a ticket issued before 0011. */
  claimWindow: string | null
  /** A rule ticket on a restricted district: the district's Proofy rule, and where the positive answer came from. */
  authorization: { verificationRuleId: number; source: string } | null
  /** Why a superseded ticket was: a rotation change, or a rule change that affected it (null otherwise, or before 0011). */
  supersedeCause: 'rotation' | 'rules' | null
}

/** A configuration's districts, as far as assignment needs: each key, and its Proofy rule if it is restricted. */
export interface AssignmentConfig {
  districts: readonly { key: string; gate: { verificationRuleId: number } | null }[]
}

/** The Proofy verification rule a configuration names for a district (a restricted district), or null (unrestricted, or not a district of it). */
export function districtRule(config: AssignmentConfig, key: string): number | null {
  return config.districts.find((d) => d.key === key)?.gate?.verificationRuleId ?? null
}

/** What a rotation follows: the governing configuration, its geometry, its default districts in order, and its restricted districts' rules. */
export interface RotationBasis {
  configVersion: number
  configHash: string
  layoutGeometryFingerprint: string
  districts: string[]
  config: AssignmentConfig
}

/** The rotation basis of a governing configuration. */
export function rotationBasis(configVersion: number, configHash: string, world: World, config: AssignmentConfig): RotationBasis {
  return { configVersion, configHash, layoutGeometryFingerprint: world.layout.geometryFingerprint, districts: defaultRotationDistricts(config.districts), config }
}

/**
 * Who may hold which NFT, which explicit rules match an NFT, and how a restricted district's Proofy rule answers for a
 * player: the caller's server-trusted source, never a browser. Only the local rehearsal's fixture exists (`source`
 * 'local-fixture'), TEST DATA standing in for Proofy Core: never reported as verified.
 */
export interface TicketEligibility {
  source: 'local-fixture'
  /** The NFTs the player may place (in any city; the store keeps this city's). */
  assets(player: { discordUserId: string }): readonly NftAsset[]
  /** The explicit district rules that match an NFT. */
  matches(asset: NftAsset): readonly DistrictRuleMatch[]
  /** A Proofy verification rule's answer for a player of a Discord server: only `true` qualifies. */
  ruleAnswer(where: { guildId: string; discordUserId: string }, verificationRuleId: number): RuleAnswer
}

/** A superseded ticket is reissued only if it has at least this long left. */
const REISSUE_MIN_MS = 2_000

export interface TicketRow {
  id: string
  world_id: string
  play_installation_id: string
  discord_guild_id: string
  actor_discord_user_id: string
  actor_core_user_id: string
  issued_in_play_session: string
  kind: 'fallback' | 'rule'
  district_key: string
  district_geometry_fingerprint: string
  epoch: number
  ordinal: string | null
  generation: number | null
  asset: string | null
  rule_ref: string | null
  config_version: number
  config_hash: string
  layout_geometry_fingerprint: string
  status: DistrictTicketStatus
  issued_at: Date
  expires_at: Date
  ended_at: Date | null
  end_reason: string | null
  property_id: string | null
  committed_sequence: string | null
  reissued_from: string | null
  claim_window: string | null
  gate_rule_id: string | null
  authorization_source: string | null
  supersede_cause: 'rotation' | 'rules' | null
  /** Computed by the database at read time: the lease has run out. */
  lapsed: boolean
}

export const TICKET_COLUMNS = `id, world_id, play_installation_id, discord_guild_id, actor_discord_user_id, actor_core_user_id, issued_in_play_session, kind, district_key, district_geometry_fingerprint, epoch, ordinal, generation,
  asset, rule_ref, config_version, config_hash, layout_geometry_fingerprint, status, issued_at, expires_at, ended_at, end_reason, property_id, committed_sequence, reissued_from,
  claim_window, gate_rule_id, authorization_source, supersede_cause, (expires_at <= clock_timestamp()) AS lapsed`

export interface RotationRow {
  world_id: string
  epoch: number
  epoch_start_ordinal: string
  high_water: string
  committed_count: string
  basis_config_version: number
  basis_config_hash: string
  layout_geometry_fingerprint: string
  districts: string[]
}

const ROTATION_COLUMNS = 'world_id, epoch, epoch_start_ordinal, high_water, committed_count, basis_config_version, basis_config_hash, layout_geometry_fingerprint, districts'

export const ticketOf = (r: TicketRow): DistrictTicket => ({
  id: r.id,
  worldId: r.world_id,
  installationId: r.play_installation_id,
  actor: { discordUserId: r.actor_discord_user_id, coreUserId: r.actor_core_user_id },
  sessionRef: r.issued_in_play_session,
  kind: r.kind,
  districtKey: r.district_key,
  districtGeometryFingerprint: r.district_geometry_fingerprint,
  epoch: r.epoch,
  ordinal: r.ordinal === null ? null : Number(r.ordinal),
  generation: r.generation,
  asset: r.asset,
  ruleRef: r.rule_ref,
  configVersion: r.config_version,
  configHash: r.config_hash,
  layoutGeometryFingerprint: r.layout_geometry_fingerprint,
  status: r.status,
  issuedAt: r.issued_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  endedAt: r.ended_at?.toISOString() ?? null,
  endReason: r.end_reason,
  propertyId: r.property_id,
  committedSequence: r.committed_sequence === null ? null : Number(r.committed_sequence),
  reissuedFrom: r.reissued_from,
  claimWindow: r.claim_window,
  authorization: r.gate_rule_id === null || r.authorization_source === null ? null : { verificationRuleId: Number(r.gate_rule_id), source: r.authorization_source },
  supersedeCause: r.supersede_cause,
})

/** A player's claim window in a world (0011): every ticket issued to them while it is open ends when it ends. */
export interface ClaimWindow {
  id: string
  worldId: string
  actor: { discordUserId: string; coreUserId: string }
  openedAt: string
  expiresAt: string
  openedBy: string
  closedAt: string | null
  closeReason: string | null
  propertyId: string | null
}

interface WindowRow {
  id: string
  world_id: string
  actor_discord_user_id: string
  actor_core_user_id: string
  opened_at: Date
  expires_at: Date
  opened_by: string
  closed_at: Date | null
  close_reason: string | null
  property_id: string | null
}

const WINDOW_COLUMNS = 'id, world_id, actor_discord_user_id, actor_core_user_id, opened_at, expires_at, opened_by, closed_at, close_reason, property_id'

const windowOf = (r: WindowRow): ClaimWindow => ({
  id: r.id,
  worldId: r.world_id,
  actor: { discordUserId: r.actor_discord_user_id, coreUserId: r.actor_core_user_id },
  openedAt: r.opened_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  openedBy: r.opened_by,
  closedAt: r.closed_at?.toISOString() ?? null,
  closeReason: r.close_reason,
  propertyId: r.property_id,
})

/** Every claim window of a world, in the order they opened. Read only; for verification and tests. */
export async function worldClaimWindowsOf(client: Pick<PoolClient, 'query'>, worldId: string): Promise<ClaimWindow[]> {
  return (await client.query<WindowRow>(`SELECT ${WINDOW_COLUMNS} FROM world_claim_windows WHERE world_id = $1 ORDER BY opened_at, id`, [worldId])).rows.map(windowOf)
}

/** The player's open claim window in the world, locked, or null. Rotation locked. */
async function openWindowOf(client: PoolClient, worldId: string, player: { discordUserId: string }): Promise<WindowRow | null> {
  return (await client.query<WindowRow>(`SELECT ${WINDOW_COLUMNS} FROM world_claim_windows WHERE world_id = $1 AND actor_discord_user_id = $2 AND closed_at IS NULL FOR UPDATE`, [worldId, player.discordUserId])).rows[0] ?? null
}

/**
 * The window a player's next ticket is issued in: their open one (a re-entry after cancelling, a switch, a reissue: the
 * same end, never renewed), or, only when `open` is allowed and they have none, a new one, which this database opens for
 * exactly 900 seconds. Rotation locked, after `expireLapsed` (which closes windows that ran out).
 */
export async function claimWindowFor(client: PoolClient, worldId: string, player: { discordUserId: string; coreUserId: string }, open: boolean): Promise<string> {
  const held = await openWindowOf(client, worldId, player)
  if (held) {
    if (held.actor_core_user_id !== player.coreUserId) throw new DistrictTicketRefusal('ticket_not_live', 'This Discord account holds a claim window under another Proofy identity.')
    return held.id
  }
  if (!open) throw new DistrictTicketRefusal('world_unavailable', `player ${player.discordUserId} holds a live ticket in world ${worldId} without an open claim window`)
  const opened = (
    await client.query<{ id: string }>(
      `INSERT INTO world_claim_windows (id, world_id, actor_discord_user_id, actor_core_user_id, opened_at, expires_at, opened_by) VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp(), 'issuance') RETURNING id`,
      [uuidv7(), worldId, player.discordUserId, player.coreUserId],
    )
  ).rows[0]
  return opened.id
}

/** Every ticket of a world, in issue order. Read only; for verification and tests. */
export async function worldTicketsOf(client: Pick<PoolClient, 'query'>, worldId: string): Promise<DistrictTicket[]> {
  return (await client.query<TicketRow>(`SELECT ${TICKET_COLUMNS} FROM world_district_tickets WHERE world_id = $1 ORDER BY issued_at, id`, [worldId])).rows.map(ticketOf)
}

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i])

/** The world's rotation row, locked FOR UPDATE, or null if nobody has entered the world through a build that issues tickets. */
export async function lockRotation(client: PoolClient, worldId: string): Promise<RotationRow | null> {
  return (await client.query<RotationRow>(`SELECT ${ROTATION_COLUMNS} FROM world_assignment_rotations WHERE world_id = $1 FOR UPDATE`, [worldId])).rows[0] ?? null
}

/**
 * End every active ticket of the world whose lease has run out and return its fallback slots to the gap pool; then close
 * every claim window that has run out (its holder's next claim opens a new one). Rotation locked.
 */
export async function expireLapsed(client: PoolClient, worldId: string): Promise<number> {
  const ended = (
    await client.query<{ ordinal: string | null }>(
      `UPDATE world_district_tickets SET status = 'expired', end_reason = 'expired' WHERE world_id = $1 AND status = 'active' AND expires_at <= clock_timestamp() RETURNING ordinal`,
      [worldId],
    )
  ).rows
  const ordinals = ended.flatMap((r) => (r.ordinal === null ? [] : [r.ordinal]))
  if (ordinals.length > 0) await client.query(`UPDATE world_assignment_slots SET state = 'free' WHERE world_id = $1 AND ordinal = ANY($2::bigint[]) AND state = 'held'`, [worldId, ordinals])
  await client.query(
    `UPDATE world_claim_windows w SET close_reason = 'lapsed' WHERE w.world_id = $1 AND w.closed_at IS NULL AND w.expires_at <= clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM world_district_tickets t WHERE t.world_id = w.world_id AND t.actor_discord_user_id = w.actor_discord_user_id AND t.status = 'active')`,
    [worldId],
  )
  return ended.length
}

/** End one active ticket by its holder's choice and, for a fallback ticket, return its slot to the gap pool. Rotation locked. */
export async function releaseTicket(client: PoolClient, t: TicketRow, reason: 'cancel' | 'reassigned'): Promise<TicketRow> {
  const row = (await client.query<TicketRow>(`UPDATE world_district_tickets SET status = 'released', end_reason = $2 WHERE id = $1 RETURNING ${TICKET_COLUMNS}`, [t.id, reason])).rows[0]
  if (t.kind === 'fallback') await client.query(`UPDATE world_assignment_slots SET state = 'free' WHERE world_id = $1 AND ordinal = $2 AND state = 'held'`, [t.world_id, t.ordinal])
  return row
}

/** Who a ticket is issued to, and on what. */
export interface Issue {
  scope: WorldScope
  actor: { discordUserId: string; coreUserId: string }
  sessionRef: string
  world: World
  /** The holder's claim window (`claimWindowFor`): the ticket ends exactly when it ends. */
  window: string
  reissuedFrom?: string
}

/** The district geometry fingerprint of a district of the governing world. */
function districtFingerprint(world: World, key: string): string {
  const d = world.districts.find((x) => x.key === key)
  if (!d) throw new DistrictTicketRefusal('world_unavailable', `district ${key} is not a district of the governing configuration`)
  return d.geometryFingerprint
}

/** Insert an active ticket on the rotation as it governs now. Rotation locked; for a fallback ticket, its slot is held at `generation`. */
export async function insertTicket(
  client: PoolClient,
  rotation: RotationRow,
  issue: Issue,
  slot:
    | { kind: 'fallback'; ordinal: string; generation: number; district: string }
    | { kind: 'rule'; district: string; asset: string; ruleRef: string; authorization: { verificationRuleId: number; source: TicketEligibility['source'] } | null },
): Promise<TicketRow> {
  // The window's end, read in SQL: a timestamp never passes through JavaScript, which would round it to milliseconds.
  return (
    await client.query<TicketRow>(
      `INSERT INTO world_district_tickets (id, world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, actor_discord_user_id, actor_core_user_id, issued_in_play_session,
                                           kind, district_key, district_geometry_fingerprint, epoch, ordinal, generation, asset, rule_ref, config_version, config_hash, layout_geometry_fingerprint,
                                           status, issued_at, expires_at, reissued_from, claim_window, gate_rule_id, authorization_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $21, 'active', clock_timestamp(),
               (SELECT w.expires_at FROM world_claim_windows w WHERE w.id = $20), $22, $20, $23, $24)
       RETURNING ${TICKET_COLUMNS}`,
      [
        uuidv7(),
        issue.scope.worldId,
        issue.scope.environment,
        issue.scope.gameKey,
        issue.scope.installationId,
        issue.scope.discordGuildId,
        issue.actor.discordUserId,
        issue.actor.coreUserId,
        issue.sessionRef,
        slot.kind,
        slot.district,
        districtFingerprint(issue.world, slot.district),
        rotation.epoch,
        slot.kind === 'fallback' ? slot.ordinal : null,
        slot.kind === 'fallback' ? slot.generation : null,
        slot.kind === 'rule' ? slot.asset : null,
        slot.kind === 'rule' ? slot.ruleRef : null,
        rotation.basis_config_version,
        rotation.basis_config_hash,
        issue.window,
        rotation.layout_geometry_fingerprint,
        issue.reissuedFrom ?? null,
        slot.kind === 'rule' ? (slot.authorization?.verificationRuleId ?? null) : null,
        slot.kind === 'rule' ? (slot.authorization?.source ?? null) : null,
      ],
    )
  ).rows[0]
}

/**
 * Issue a fallback ticket from the rotation: the oldest (lowest ordinal) free slot of the current epoch at its next
 * generation, or else the next ordinal, advancing the high-water mark. Rotation locked.
 */
export async function issueFallback(client: PoolClient, rotation: RotationRow, issue: Issue): Promise<TicketRow> {
  if (rotation.districts.length === 0) throw new DistrictTicketRefusal('no_default_district', 'Every district of this city is restricted, so there is no default district to assign.')
  const reused = (
    await client.query<{ ordinal: string; generation: number; district_key: string }>(
      `UPDATE world_assignment_slots SET state = 'held', generation = generation + 1
        WHERE world_id = $1 AND ordinal = (SELECT ordinal FROM world_assignment_slots WHERE world_id = $1 AND epoch = $2 AND state = 'free' ORDER BY ordinal LIMIT 1 FOR UPDATE)
        RETURNING ordinal, generation, district_key`,
      [rotation.world_id, rotation.epoch],
    )
  ).rows[0]
  if (reused) return insertTicket(client, rotation, issue, { kind: 'fallback', ordinal: reused.ordinal, generation: reused.generation, district: reused.district_key })

  const advanced = (await client.query<{ high_water: string }>('UPDATE world_assignment_rotations SET high_water = high_water + 1 WHERE world_id = $1 RETURNING high_water', [rotation.world_id])).rows[0]
  rotation.high_water = advanced.high_water
  const ordinal = BigInt(advanced.high_water) - 1n
  const district = rotationDistrict(rotation.districts, Number(rotation.epoch_start_ordinal), Number(ordinal))
  if (district === null) throw new DistrictTicketRefusal('world_unavailable', `the rotation of world ${rotation.world_id} names no district for ordinal ${ordinal}`)
  await client.query(`INSERT INTO world_assignment_slots (world_id, ordinal, epoch, district_key, generation, state) VALUES ($1, $2, $3, $4, 1, 'held')`, [rotation.world_id, ordinal.toString(), rotation.epoch, district])
  return insertTicket(client, rotation, issue, { kind: 'fallback', ordinal: ordinal.toString(), generation: 1, district })
}

/** End one active ticket because a change superseded it: 'rotation' (a new epoch is begun with it) or 'rules' (a rule ticket a rule change affected). */
async function supersede(client: PoolClient, worldId: string, cause: 'rotation' | 'rules', ids?: readonly string[]): Promise<(TicketRow & { reissuable: boolean })[]> {
  // end_reason stays 0010's 'rotation_changed' (its CHECK is permanent); supersede_cause (0011) says which change it was.
  return (
    await client.query<TicketRow & { reissuable: boolean }>(
      `UPDATE world_district_tickets SET status = 'superseded', end_reason = 'rotation_changed', supersede_cause = $2
        WHERE world_id = $1 AND status = 'active' AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
       RETURNING ${TICKET_COLUMNS}, (expires_at > clock_timestamp() + make_interval(secs => $4::double precision)) AS reissuable`,
      [worldId, cause, ids ?? null, REISSUE_MIN_MS / 1000],
    )
  ).rows
}

/**
 * Bring a world's rotation to the governing configuration `basis` (of `world`), if the world has a rotation. Called in
 * every transaction that adopts a configuration, with the city locked, and by every ticket transaction.
 *
 *   SAME ROTATION (D4)   the same default districts in the same order on the same geometry: only the basis is recorded,
 *                        and every fallback ticket stands, whole (identity, district, ordinal, generation, expiry): it
 *                        names no NFT and no rule, and an NFT's rules are judged again when it is placed. Of the rule
 *                        tickets, exactly those whose district's Proofy rule the new version names differently (added,
 *                        removed or another rule) are superseded ('rules'); their holders keep their claim window and
 *                        are assigned again only through a new, fully checked request of their own.
 *   ANOTHER ROTATION     anything else begins a new epoch: every active ticket is superseded ('rotation'), every
 *                        unconsumed slot of the old epoch retired, and each superseded fallback ticket that still has
 *                        time left is reissued to its holder, in the old order, in their claim window (never longer).
 * Returns the rotation, locked.
 */
export async function syncAssignmentRotation(client: PoolClient, scope: WorldScope, world: World, basis: RotationBasis): Promise<RotationRow | null> {
  const rotation = await lockRotation(client, scope.worldId)
  if (!rotation) return null
  const sameGround = rotation.layout_geometry_fingerprint === basis.layoutGeometryFingerprint && sameOrder(rotation.districts, basis.districts)
  if (sameGround && rotation.basis_config_version === basis.configVersion && rotation.basis_config_hash === basis.configHash) return rotation
  if (sameGround) {
    const moved = (
      await client.query<RotationRow>(`UPDATE world_assignment_rotations SET basis_config_version = $2, basis_config_hash = $3 WHERE world_id = $1 RETURNING ${ROTATION_COLUMNS}`, [scope.worldId, basis.configVersion, basis.configHash])
    ).rows[0]
    await expireLapsed(client, scope.worldId)
    const rules = (await client.query<TicketRow>(`SELECT ${TICKET_COLUMNS} FROM world_district_tickets WHERE world_id = $1 AND status = 'active' AND kind = 'rule' FOR UPDATE`, [scope.worldId])).rows
    const affected = rules.filter((t) => (t.gate_rule_id === null ? null : Number(t.gate_rule_id)) !== districtRule(basis.config, t.district_key)).map((t) => t.id)
    if (affected.length > 0) await supersede(client, scope.worldId, 'rules', affected)
    return moved
  }

  await expireLapsed(client, scope.worldId)
  const superseded = await supersede(client, scope.worldId, 'rotation')
  await client.query(`UPDATE world_assignment_slots SET state = 'retired' WHERE world_id = $1 AND state IN ('held', 'free')`, [scope.worldId])
  const next = (
    await client.query<RotationRow>(
      `UPDATE world_assignment_rotations SET epoch = epoch + 1, epoch_start_ordinal = high_water, basis_config_version = $2, basis_config_hash = $3, layout_geometry_fingerprint = $4, districts = $5::jsonb
        WHERE world_id = $1 RETURNING ${ROTATION_COLUMNS}`,
      [scope.worldId, basis.configVersion, basis.configHash, basis.layoutGeometryFingerprint, JSON.stringify(basis.districts)],
    )
  ).rows[0]
  // In the order the holders were assigned: fallback tickets by ordinal. A rule ticket is not reissued: the player selects the NFT again.
  const reissue = superseded.filter((t) => t.kind === 'fallback' && t.reissuable).sort((a, b) => (BigInt(a.ordinal!) < BigInt(b.ordinal!) ? -1 : 1))
  if (next.districts.length > 0)
    for (const t of reissue) {
      const actor = { discordUserId: t.actor_discord_user_id, coreUserId: t.actor_core_user_id }
      await issueFallback(client, next, { scope, actor, sessionRef: t.issued_in_play_session, world, window: await claimWindowFor(client, scope.worldId, actor, false), reissuedFrom: t.id })
    }
  return next
}

/** The ticket a page names, locked, if it is this player's live ticket in this world; otherwise the refusal. Lapsed tickets count as expired. */
export async function namedTicket(client: PoolClient, worldId: string, ticketId: string, player: { discordUserId: string; coreUserId: string }): Promise<TicketRow | DistrictTicketRefusal> {
  const t = (await client.query<TicketRow>(`SELECT ${TICKET_COLUMNS} FROM world_district_tickets WHERE id = $1 AND world_id = $2 FOR UPDATE`, [ticketId, worldId])).rows[0]
  if (!t || t.actor_discord_user_id !== player.discordUserId || t.actor_core_user_id !== player.coreUserId) return new DistrictTicketRefusal('ticket_not_live', 'That is not a district ticket of yours in this city.')
  if (t.status === 'expired' || (t.status === 'active' && t.lapsed)) return new DistrictTicketRefusal('ticket_expired', 'Your district ticket expired.')
  if (t.status === 'superseded') return new DistrictTicketRefusal('ticket_superseded', t.supersede_cause === 'rules' ? 'The city\'s district rules changed, so your district ticket was withdrawn.' : 'The city\'s districts changed, so your district ticket was replaced.')
  if (t.status !== 'active') return new DistrictTicketRefusal('ticket_not_live', 'That district ticket has ended.')
  return t
}

/**
 * For the property store, inside an activation's transaction (city locked FOR UPDATE, session locked): the ticket the
 * activation names, locked after the rotation, if it is the activator's live ticket of the current epoch; otherwise the
 * refusal, and nothing is written.
 */
export async function lockTicketForCommit(client: PoolClient, worldId: string, ticketId: string, player: { discordUserId: string; coreUserId: string }): Promise<TicketRow | DistrictTicketRefusal> {
  const rotation = await lockRotation(client, worldId)
  if (!rotation) return new DistrictTicketRefusal('ticket_not_live', 'That is not a district ticket of yours in this city.')
  const named = await namedTicket(client, worldId, ticketId, player)
  if (named instanceof DistrictTicketRefusal) return named
  if (named.epoch !== rotation.epoch) return new DistrictTicketRefusal('ticket_superseded', 'The city\'s districts changed, so your district ticket was replaced.')
  return named
}

/** What decides one NFT's district now: its explicit rules (D3), and, for a restricted district, its Proofy rule's answer for the player (D1). */
export type NftDistrictDecision =
  | { kind: 'default' }
  | { kind: 'rule'; district: string; ruleRef: string; authorization: { verificationRuleId: number; source: TicketEligibility['source'] } | null }
  | { kind: 'refused'; code: 'district_rule_ambiguous' | 'district_rule_ref_too_long' | 'district_rule_unqualified' | 'district_rule_unverified'; detail: string }

/**
 * An NFT's district, decided on the governing configuration under the city lock, from the trusted source only. Ambiguity
 * is decided first and refused whatever the districts' rules say: no rule order, id or type is a priority, and a
 * browser never names a district. A rule naming a restricted district authorizes it only with a positive answer.
 */
export function decideNftDistrict(
  read: Pick<LockedWorld, 'world' | 'config'>,
  matches: readonly DistrictRuleMatch[],
  answer: (verificationRuleId: number) => RuleAnswer,
  source: TicketEligibility['source'],
): NftDistrictDecision {
  const decided = resolveDistrictRules(matches, new Set(read.world.districts.map((d) => d.key)))
  if (decided.kind === 'none') return { kind: 'default' }
  if (decided.kind === 'ambiguous') return { kind: 'refused', code: 'district_rule_ambiguous', detail: decided.districts.join(', ') }
  if (decided.kind === 'overlong') return { kind: 'refused', code: 'district_rule_ref_too_long', detail: String(decided.ruleRef.length) }
  const gate = districtRule(read.config, decided.district)
  const authorized = districtAuthorization(gate === null ? null : { verificationRuleId: gate }, gate === null ? undefined : answer(gate))
  if (authorized.kind === 'unqualified') return { kind: 'refused', code: 'district_rule_unqualified', detail: decided.district }
  if (authorized.kind === 'unverified') return { kind: 'refused', code: 'district_rule_unverified', detail: decided.district }
  return { kind: 'rule', district: decided.district, ruleRef: decided.ruleRef, authorization: authorized.kind === 'qualified' ? { verificationRuleId: authorized.verificationRuleId, source } : null }
}

/**
 * Whether a live rule ticket is still exactly what the trusted source and the governing configuration decide now (D4):
 * its holder still holds the NFT; the NFT's explicit rules still name its district with exactly the same rule ids; its
 * district's Proofy rule is the one it recorded; and, for a restricted district, that rule still answers `true` for the
 * holder, from the same source. Anything else, or anything that cannot be read, is a reason: the ticket does not stand.
 */
export function ruleTicketChange(t: TicketRow, read: Pick<LockedWorld, 'world' | 'config'>, eligibility: TicketEligibility): string | null {
  if (t.kind !== 'rule' || t.asset === null) return null
  const asset = parseAssetKey(t.asset)
  if (!asset) return 'its NFT cannot be read'
  if (!eligibility.assets({ discordUserId: t.actor_discord_user_id }).some((a) => assetKey(a) === t.asset)) return 'its holder no longer holds its NFT'
  const now = decideNftDistrict(read, eligibility.matches(asset), (rule) => eligibility.ruleAnswer({ guildId: t.discord_guild_id, discordUserId: t.actor_discord_user_id }, rule), eligibility.source)
  if (now.kind === 'refused') return `its NFT is now refused (${now.code})`
  if (now.kind === 'default') return 'no explicit rule assigns its NFT any more'
  if (now.district !== t.district_key || now.ruleRef !== t.rule_ref) return 'its NFT\'s explicit rules changed'
  const recorded = t.gate_rule_id === null ? null : { verificationRuleId: Number(t.gate_rule_id), source: t.authorization_source }
  if (JSON.stringify(recorded) !== JSON.stringify(now.authorization)) return 'its district\'s Proofy rule or its answer changed'
  return null
}

/**
 * Supersede ('rules') every live rule ticket of the world that no longer stands (`ruleTicketChange`), in this
 * transaction; every other ticket is left exactly as it is. Rotation locked, after `expireLapsed`.
 */
export async function supersedeChangedRuleTickets(client: PoolClient, worldId: string, read: Pick<LockedWorld, 'world' | 'config'>, eligibility: TicketEligibility): Promise<{ id: string; reason: string }[]> {
  const live = (await client.query<TicketRow>(`SELECT ${TICKET_COLUMNS} FROM world_district_tickets WHERE world_id = $1 AND status = 'active' AND kind = 'rule' FOR UPDATE`, [worldId])).rows
  const changed = live.flatMap((t) => {
    const reason = ruleTicketChange(t, read, eligibility)
    return reason === null ? [] : [{ id: t.id, reason }]
  })
  if (changed.length > 0) await supersede(client, worldId, 'rules', changed.map((c) => c.id))
  return changed
}

export type TicketPlacementRefusal =
  | 'ticket_superseded'
  | 'plot_outside_assignment'
  | 'district_rule_applies'
  | 'district_rule_ambiguous'
  | 'district_rule_ref_too_long'
  | 'district_rule_unqualified'
  | 'district_rule_unverified'
  | 'ticket_asset_mismatch'

/**
 * Why a locked live ticket may not place this NFT on a plot of this district, or null. Judged on the governing world
 * under the city lock, with the trusted source's rules for the NFT and the activator's answers, asked again now (D1, D3,
 * D4): the permission the ticket was issued on must hold exactly as it did.
 */
export function ticketPlacementRefusal(
  t: TicketRow,
  read: Pick<LockedWorld, 'world' | 'config'>,
  placement: { districtKey: string; asset: string; matches: readonly DistrictRuleMatch[]; answer: (verificationRuleId: number) => RuleAnswer; source: TicketEligibility['source'] },
): TicketPlacementRefusal | null {
  const district = read.world.districts.find((d) => d.key === t.district_key)
  if (t.layout_geometry_fingerprint !== read.world.layout.geometryFingerprint || !district || district.geometryFingerprint !== t.district_geometry_fingerprint) return 'ticket_superseded'
  if (t.kind === 'rule' && t.asset !== placement.asset) return 'ticket_asset_mismatch'
  const decided = decideNftDistrict(read, placement.matches, placement.answer, placement.source)
  if (decided.kind === 'refused') return decided.code
  if (t.kind === 'fallback') {
    if (decided.kind === 'rule') return 'district_rule_applies'
    // A fallback ticket names only an unrestricted district (0011); one that is restricted now no longer authorizes it.
    if (districtRule(read.config, t.district_key) !== null) return 'ticket_superseded'
  } else {
    const recorded = t.gate_rule_id === null ? null : { verificationRuleId: Number(t.gate_rule_id), source: t.authorization_source }
    if (decided.kind !== 'rule' || decided.district !== t.district_key || decided.ruleRef !== t.rule_ref || JSON.stringify(recorded) !== JSON.stringify(decided.authorization)) return 'ticket_superseded'
  }
  if (placement.districtKey !== t.district_key) return 'plot_outside_assignment'
  return null
}

/**
 * Consume a locked live ticket by the property just written, in the same transaction: committed, its slot consumed,
 * counted, and its holder's claim window closed by it (their next claim opens a new one).
 */
export async function consumeTicket(client: PoolClient, t: TicketRow, propertyId: string, sequence: number): Promise<void> {
  await client.query(`UPDATE world_district_tickets SET status = 'committed', end_reason = 'activated', property_id = $2, committed_sequence = $3 WHERE id = $1`, [t.id, propertyId, sequence])
  if (t.kind === 'fallback') await client.query(`UPDATE world_assignment_slots SET state = 'consumed' WHERE world_id = $1 AND ordinal = $2 AND state = 'held'`, [t.world_id, t.ordinal])
  await client.query('UPDATE world_assignment_rotations SET committed_count = committed_count + 1 WHERE world_id = $1', [t.world_id])
  await client.query(`UPDATE world_claim_windows SET close_reason = 'activated', property_id = $3 WHERE world_id = $1 AND actor_discord_user_id = $2 AND closed_at IS NULL`, [t.world_id, t.actor_discord_user_id, propertyId])
}
