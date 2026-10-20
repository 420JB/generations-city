import type { PoolClient } from 'pg'
import { defaultRotationDistricts, resolveDistrictRules, rotationDistrict, type AssignableDistrict, type DistrictRuleMatch, type World } from '../engine'
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
  /** Every district of the city has a Proofy rule: there is no default district to assign. */
  | 'no_default_district'
  /** No such live ticket of this player in this world (unknown, someone else's, released or already committed). */
  | 'ticket_not_live'
  /** The ticket's lease ran out. */
  | 'ticket_expired'
  /** The city's rotation changed (its districts or their geometry): the ticket was superseded, and reissued if it had time left. */
  | 'ticket_superseded'
  /** Explicit rules matching the NFT name different districts, and no precedence is approved. */
  | 'district_rule_ambiguous'
  /** An explicit rule assigns the NFT to a district with a Proofy rule, which nothing can check yet. */
  | 'district_rule_unverified'
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
}

/** What a rotation follows: the governing configuration, its geometry, and its default districts in order. */
export interface RotationBasis {
  configVersion: number
  configHash: string
  layoutGeometryFingerprint: string
  districts: string[]
}

/** The rotation basis of a governing configuration. */
export function rotationBasis(configVersion: number, configHash: string, world: World, config: { districts: readonly AssignableDistrict[] }): RotationBasis {
  return { configVersion, configHash, layoutGeometryFingerprint: world.layout.geometryFingerprint, districts: defaultRotationDistricts(config.districts) }
}

/** A superseded ticket is reissued only if it has at least this long left. */
const REISSUE_MIN_MS = 2_000

export interface TicketRow {
  id: string
  world_id: string
  play_installation_id: string
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
  /** Computed by the database at read time: the lease has run out. */
  lapsed: boolean
}

export const TICKET_COLUMNS = `id, world_id, play_installation_id, actor_discord_user_id, actor_core_user_id, issued_in_play_session, kind, district_key, district_geometry_fingerprint, epoch, ordinal, generation,
  asset, rule_ref, config_version, config_hash, layout_geometry_fingerprint, status, issued_at, expires_at, ended_at, end_reason, property_id, committed_sequence, reissued_from,
  (expires_at <= clock_timestamp()) AS lapsed`

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
})

/** Every ticket of a world, in issue order. Read only; for verification and tests. */
export async function worldTicketsOf(client: Pick<PoolClient, 'query'>, worldId: string): Promise<DistrictTicket[]> {
  return (await client.query<TicketRow>(`SELECT ${TICKET_COLUMNS} FROM world_district_tickets WHERE world_id = $1 ORDER BY issued_at, id`, [worldId])).rows.map(ticketOf)
}

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i])

/** The world's rotation row, locked FOR UPDATE, or null if nobody has entered the world through a build that issues tickets. */
export async function lockRotation(client: PoolClient, worldId: string): Promise<RotationRow | null> {
  return (await client.query<RotationRow>(`SELECT ${ROTATION_COLUMNS} FROM world_assignment_rotations WHERE world_id = $1 FOR UPDATE`, [worldId])).rows[0] ?? null
}

/** End every active ticket of the world whose lease has run out, and return its fallback slots to the gap pool. Rotation locked. */
export async function expireLapsed(client: PoolClient, worldId: string): Promise<number> {
  const ended = (
    await client.query<{ ordinal: string | null }>(
      `UPDATE world_district_tickets SET status = 'expired', end_reason = 'expired' WHERE world_id = $1 AND status = 'active' AND expires_at <= clock_timestamp() RETURNING ordinal`,
      [worldId],
    )
  ).rows
  const ordinals = ended.flatMap((r) => (r.ordinal === null ? [] : [r.ordinal]))
  if (ordinals.length > 0) await client.query(`UPDATE world_assignment_slots SET state = 'free' WHERE world_id = $1 AND ordinal = ANY($2::bigint[]) AND state = 'held'`, [worldId, ordinals])
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
  /** Seconds from now, or an absolute instant (a reissue or a reassignment keeps the lease it had). */
  lease: { seconds: number } | { until: Date }
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
  slot: { kind: 'fallback'; ordinal: string; generation: number; district: string } | { kind: 'rule'; district: string; asset: string; ruleRef: string },
): Promise<TicketRow> {
  const [expiry, lease] = 'seconds' in issue.lease ? ['clock_timestamp() + make_interval(secs => $20::double precision)', issue.lease.seconds] : ['$20::timestamptz', issue.lease.until]
  return (
    await client.query<TicketRow>(
      `INSERT INTO world_district_tickets (id, world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, actor_discord_user_id, actor_core_user_id, issued_in_play_session,
                                           kind, district_key, district_geometry_fingerprint, epoch, ordinal, generation, asset, rule_ref, config_version, config_hash, layout_geometry_fingerprint,
                                           status, issued_at, expires_at, reissued_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $21, 'active', clock_timestamp(), ${expiry}, $22)
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
        lease,
        rotation.layout_geometry_fingerprint,
        issue.reissuedFrom ?? null,
      ],
    )
  ).rows[0]
}

/**
 * Issue a fallback ticket from the rotation: the oldest (lowest ordinal) free slot of the current epoch at its next
 * generation, or else the next ordinal, advancing the high-water mark. Rotation locked.
 */
export async function issueFallback(client: PoolClient, rotation: RotationRow, issue: Issue): Promise<TicketRow> {
  if (rotation.districts.length === 0) throw new DistrictTicketRefusal('no_default_district', 'Every district of this city has a Proofy rule, so there is no default district to assign.')
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

/**
 * Bring a world's rotation to the governing configuration `basis` (of `world`), if the world has a rotation. Called in
 * every transaction that adopts a configuration, with the city locked, and by every ticket transaction. A new basis with
 * the same default districts and geometry only records the version; anything else begins a new epoch: every active
 * ticket is superseded, every unconsumed slot of the old epoch retired, and each superseded fallback ticket that still
 * has time left is reissued to its holder, in the old order, for no longer than it had. Returns the rotation, locked.
 */
export async function syncAssignmentRotation(client: PoolClient, scope: WorldScope, world: World, basis: RotationBasis): Promise<RotationRow | null> {
  const rotation = await lockRotation(client, scope.worldId)
  if (!rotation) return null
  const sameGround = rotation.layout_geometry_fingerprint === basis.layoutGeometryFingerprint && sameOrder(rotation.districts, basis.districts)
  if (sameGround && rotation.basis_config_version === basis.configVersion && rotation.basis_config_hash === basis.configHash) return rotation
  if (sameGround) {
    return (
      await client.query<RotationRow>(`UPDATE world_assignment_rotations SET basis_config_version = $2, basis_config_hash = $3 WHERE world_id = $1 RETURNING ${ROTATION_COLUMNS}`, [scope.worldId, basis.configVersion, basis.configHash])
    ).rows[0]
  }

  await expireLapsed(client, scope.worldId)
  const superseded = (
    await client.query<TicketRow & { reissuable: boolean }>(
      `UPDATE world_district_tickets SET status = 'superseded', end_reason = 'rotation_changed' WHERE world_id = $1 AND status = 'active'
       RETURNING ${TICKET_COLUMNS}, (expires_at > clock_timestamp() + make_interval(secs => $2::double precision)) AS reissuable`,
      [scope.worldId, REISSUE_MIN_MS / 1000],
    )
  ).rows
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
    for (const t of reissue)
      await issueFallback(client, next, {
        scope,
        actor: { discordUserId: t.actor_discord_user_id, coreUserId: t.actor_core_user_id },
        sessionRef: t.issued_in_play_session,
        world,
        lease: { until: t.expires_at },
        reissuedFrom: t.id,
      })
  return next
}

/** The ticket a page names, locked, if it is this player's live ticket in this world; otherwise the refusal. Lapsed tickets count as expired. */
export async function namedTicket(client: PoolClient, worldId: string, ticketId: string, player: { discordUserId: string; coreUserId: string }): Promise<TicketRow | DistrictTicketRefusal> {
  const t = (await client.query<TicketRow>(`SELECT ${TICKET_COLUMNS} FROM world_district_tickets WHERE id = $1 AND world_id = $2 FOR UPDATE`, [ticketId, worldId])).rows[0]
  if (!t || t.actor_discord_user_id !== player.discordUserId || t.actor_core_user_id !== player.coreUserId) return new DistrictTicketRefusal('ticket_not_live', 'That is not a district ticket of yours in this city.')
  if (t.status === 'expired' || (t.status === 'active' && t.lapsed)) return new DistrictTicketRefusal('ticket_expired', 'Your district ticket expired.')
  if (t.status === 'superseded') return new DistrictTicketRefusal('ticket_superseded', 'The city\'s districts changed, so your district ticket was replaced.')
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

export type TicketPlacementRefusal = 'ticket_superseded' | 'plot_outside_assignment' | 'district_rule_applies' | 'district_rule_ambiguous' | 'ticket_asset_mismatch'

/** Why a locked live ticket may not place this NFT on a plot of this district, or null. Judged on the governing world under the city lock. */
export function ticketPlacementRefusal(t: TicketRow, read: Pick<LockedWorld, 'world'>, placement: { districtKey: string; asset: string; matches: readonly DistrictRuleMatch[] }): TicketPlacementRefusal | null {
  const district = read.world.districts.find((d) => d.key === t.district_key)
  if (t.layout_geometry_fingerprint !== read.world.layout.geometryFingerprint || !district || district.geometryFingerprint !== t.district_geometry_fingerprint) return 'ticket_superseded'
  if (t.kind === 'rule' && t.asset !== placement.asset) return 'ticket_asset_mismatch'
  const decided = resolveDistrictRules(placement.matches, new Set(read.world.districts.map((d) => d.key)))
  if (decided.kind === 'ambiguous') return 'district_rule_ambiguous'
  if (t.kind === 'fallback' && decided.kind === 'rule') return 'district_rule_applies'
  if (t.kind === 'rule' && (decided.kind !== 'rule' || decided.district !== t.district_key)) return 'ticket_superseded'
  if (placement.districtKey !== t.district_key) return 'plot_outside_assignment'
  return null
}

/** Consume a locked live ticket by the property just written, in the same transaction: committed, its slot consumed, counted. */
export async function consumeTicket(client: PoolClient, t: TicketRow, propertyId: string, sequence: number): Promise<void> {
  await client.query(`UPDATE world_district_tickets SET status = 'committed', end_reason = 'activated', property_id = $2, committed_sequence = $3 WHERE id = $1`, [t.id, propertyId, sequence])
  if (t.kind === 'fallback') await client.query(`UPDATE world_assignment_slots SET state = 'consumed' WHERE world_id = $1 AND ordinal = $2 AND state = 'held'`, [t.world_id, t.ordinal])
  await client.query('UPDATE world_assignment_rotations SET committed_count = committed_count + 1 WHERE world_id = $1', [t.world_id])
}
