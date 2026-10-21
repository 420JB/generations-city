import type { PoolClient } from 'pg'
import { defaultRotationDistricts, judgeWorldConfig, rotationDistrict } from '../engine'

/**
 * `city:verify` for district tickets (migration 0010): is every world's rotation, slot and ticket one
 * an authority may hold? READ-ONLY, on the caller's REPEATABLE READ, READ ONLY transaction.
 *
 * Per world with a rotation:
 *   rotation  follows the governing configuration (its latest adoption): that version and hash, the
 *             layout geometry recorded for it, and exactly its default districts in order (every
 *             district without a Proofy rule); its high-water mark is the number of slots, its
 *             committed count the number of committed tickets;
 *   slots     ordinals 0 .. high-water - 1, each once; a slot of the current epoch is on the district
 *             its position names; one of an older epoch is retired or consumed; held exactly when the
 *             ticket of its current generation is active, consumed exactly when that ticket is committed;
 *             each generation 1 .. current was issued exactly once (no stale generation, none skipped);
 *   tickets   at most one active per player; none of an epoch the rotation has not reached; an active
 *             ticket is of the current epoch and its lease has not run out, on its rotation's layout geometry (or it is merely waiting for the next ticket transaction to expire it, which is
 *             reported as a count, not a violation); a committed one names a property of its world on
 *             its district and geometry, at the sequence it records, activated by its holder (and, for a
 *             rule ticket, its NFT); no property consumed two tickets;
 *   coverage  every property activated since the world's rotation began consumed a ticket.
 *
 * And, once migration 0011 is applied (policies D1, D2, D4):
 *   windows   at most one open claim window per player per world; one opened by an issuance lasts
 *             exactly 900 seconds and opened with a ticket issued at that instant; every ticket in a
 *             window is its holder's and ends exactly when it ends; every ticket issued since 0011 is
 *             in one; an active ticket's window is open; a lapsed window closed only after it ran out;
 *             an activated one by a property one of its tickets became, and a committed ticket's
 *             window is closed by its property;
 *   rules     a fallback ticket names an unrestricted district of its configuration; a rule ticket
 *             records exactly the Proofy rule its configuration names for its district, a restricted
 *             district's authorization only from 'local-fixture'; a ticket superseded since 0011 says
 *             why, and a rule change superseded only rule tickets (of the epoch that governed then: the
 *             rotation's, or an earlier one if a rotation change followed).
 *
 * And, once migration 0012 is applied (the same policies, held by the database):
 *   leases    no open claim window and no active ticket lasts longer than 900 seconds (a legacy lease
 *             0012 cut records the end it had before; a ticket that ended in a window before 0012 cut
 *             it ends at the window's former end);
 *   governing an active ticket issued since 0011 stands on the configuration that governs NOW: a
 *             fallback one on a district of the rotation that it leaves unrestricted, a rule one
 *             recording exactly the Proofy rule it names for its district.
 */
export interface TicketVerifyReport {
  epoch: number
  highWater: number
  committed: number
  active: number
  /** Active tickets whose lease has run out, waiting for the next ticket transaction to expire them. */
  lapsed: number
  free: number
  /** Open claim windows (0011), and those of them that ran out, waiting for the next ticket transaction to close them. */
  windows: number
  lapsedWindows: number
}

type AddViolation = (rule: string, detail: string) => void

interface RotationRow {
  world_id: string
  epoch: number
  epoch_start_ordinal: string
  high_water: string
  committed_count: string
  basis_config_version: number
  basis_config_hash: string
  layout_geometry_fingerprint: string
  districts: unknown
  created_at: Date
}

interface SlotRow {
  world_id: string
  ordinal: string
  epoch: number
  district_key: string
  generation: number
  state: string
}

interface TicketRow {
  id: string
  world_id: string
  actor_discord_user_id: string
  actor_core_user_id: string
  kind: string
  district_key: string
  district_geometry_fingerprint: string
  layout_geometry_fingerprint: string
  epoch: number
  ordinal: string | null
  generation: number | null
  asset: string | null
  status: string
  lapsed: boolean
  property_id: string | null
  committed_sequence: string | null
  claim_window: string | null
  gate_rule_id: string | null
  authorization_source: string | null
  supersede_cause: string | null
  /** The Proofy rule the ticket's configuration names for its district (0011's world_config_district_rule). */
  district_rule: string | null
  /** Issued since migration 0011 was applied: it must be in a claim window. */
  since_0011: boolean
  /** Ends at most 900 seconds after it was issued (checked once 0012 is applied). */
  within_lease: boolean
  /** The Proofy rule the GOVERNING configuration (the world's latest adoption) names for its district (0012). */
  governing_rule: string | null
}

interface WindowRow {
  id: string
  world_id: string
  actor_discord_user_id: string
  actor_core_user_id: string
  opened_by: string
  close_reason: string | null
  property_id: string | null
  open: boolean
  ran_out: boolean
  exact: boolean
  closed_after_expiry: boolean | null
  opened_by_ticket: boolean
  /** Tickets in the window whose holder or end is not the window's. */
  strays: number
  /** Ends at most 900 seconds after it opened (checked once 0012 is applied). */
  within_lease: boolean
}

interface PropertyRow {
  id: string
  world_id: string
  district_key: string
  district_geometry_fingerprint: string
  activated_sequence: string
  activator_core_user_id: string | null
  activator_discord_user_id: string | null
  asset: string
  activated_at: Date
}

/** True when this database has the ticket tables (migration 0010). */
export async function hasTicketTables(client: PoolClient): Promise<boolean> {
  return (await client.query<{ present: boolean }>(`SELECT to_regclass('world_district_tickets') IS NOT NULL AS present`)).rows[0].present
}

/** True when this database has claim windows and the ticket policy columns (migration 0011). */
async function hasTicketPolicy(client: PoolClient): Promise<boolean> {
  return (await client.query<{ present: boolean }>(`SELECT to_regclass('world_claim_windows') IS NOT NULL AS present`)).rows[0].present
}

/** True when this database's guards hold the ticket policies themselves (migration 0012: legacy leases cut, configuration gates). */
async function hasTicketHardening(client: PoolClient): Promise<boolean> {
  return (
    await client.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('world_claim_windows') AND a.attname = 'legacy_expires_at' AND NOT a.attisdropped) AS present`,
    )
  ).rows[0].present
}

export async function verifyDistrictTickets(client: PoolClient, add: AddViolation): Promise<Map<string, TicketVerifyReport>> {
  const reports = new Map<string, TicketVerifyReport>()
  if (!(await hasTicketTables(client))) return reports
  const rotations = (
    await client.query<RotationRow>('SELECT world_id, epoch, epoch_start_ordinal, high_water, committed_count, basis_config_version, basis_config_hash, layout_geometry_fingerprint, districts, created_at FROM world_assignment_rotations ORDER BY world_id')
  ).rows
  const slots = (await client.query<SlotRow>('SELECT world_id, ordinal, epoch, district_key, generation, state FROM world_assignment_slots ORDER BY world_id, ordinal')).rows
  const policy = await hasTicketPolicy(client)
  const hardened = policy && (await hasTicketHardening(client))
  const governingRule = hardened
    ? `world_config_district_rule(t.world_id, (SELECT a.version FROM world_config_adoptions a WHERE a.world_id = t.world_id ORDER BY a.adoption_seq DESC LIMIT 1), t.district_key)`
    : 'NULL'
  const tickets = (
    await client.query<TicketRow>(
      policy
        ? `SELECT id, world_id, actor_discord_user_id, actor_core_user_id, kind, district_key, district_geometry_fingerprint, layout_geometry_fingerprint, epoch, ordinal, generation, asset, status,
                  (expires_at <= clock_timestamp()) AS lapsed, property_id, committed_sequence, claim_window, gate_rule_id, authorization_source, supersede_cause,
                  world_config_district_rule(world_id, config_version, district_key) AS district_rule,
                  issued_at >= (SELECT m.applied_at FROM schema_migrations m WHERE m.version = 11) AS since_0011,
                  (expires_at <= issued_at + interval '900 seconds') AS within_lease, ${governingRule} AS governing_rule
             FROM world_district_tickets t ORDER BY world_id, issued_at, id`
        : `SELECT id, world_id, actor_discord_user_id, actor_core_user_id, kind, district_key, district_geometry_fingerprint, layout_geometry_fingerprint, epoch, ordinal, generation, asset, status,
                  (expires_at <= clock_timestamp()) AS lapsed, property_id, committed_sequence, NULL AS claim_window, NULL AS gate_rule_id, NULL AS authorization_source, NULL AS supersede_cause,
                  NULL AS district_rule, false AS since_0011, true AS within_lease, NULL AS governing_rule
             FROM world_district_tickets ORDER BY world_id, issued_at, id`,
    )
  ).rows
  // A window 0012 cut (legacy_expires_at): a ticket that had ended in it before ends at the window's former end, and one
  // 0012 cut ends at its new end (or, issued after the cut end, one microsecond after its issuance, as 0012 cut it).
  const strayEnd = hardened
    ? `(t.expires_at <> w.expires_at AND NOT (w.legacy_expires_at IS NOT NULL
          AND ((t.legacy_expires_at IS NULL AND t.status <> 'active' AND t.expires_at = w.legacy_expires_at)
               OR (t.legacy_expires_at IS NOT NULL AND t.expires_at = greatest(w.expires_at, t.issued_at + interval '1 microsecond')))))`
    : 't.expires_at <> w.expires_at'
  const windows = policy
    ? (
        await client.query<WindowRow>(
          `SELECT w.id, w.world_id, w.actor_discord_user_id, w.actor_core_user_id, w.opened_by, w.close_reason, w.property_id,
                  (w.closed_at IS NULL) AS open, (w.expires_at <= clock_timestamp()) AS ran_out, (w.expires_at - w.opened_at = interval '900 seconds') AS exact,
                  (CASE WHEN w.closed_at IS NULL THEN NULL ELSE w.closed_at >= w.expires_at END) AS closed_after_expiry,
                  EXISTS (SELECT 1 FROM world_district_tickets t WHERE t.claim_window = w.id AND t.issued_at = w.opened_at) AS opened_by_ticket,
                  (SELECT count(*)::int FROM world_district_tickets t WHERE t.claim_window = w.id
                      AND (t.world_id <> w.world_id OR t.actor_discord_user_id <> w.actor_discord_user_id OR t.actor_core_user_id <> w.actor_core_user_id
                           OR ${strayEnd})) AS strays,
                  (w.expires_at <= w.opened_at + interval '900 seconds') AS within_lease
             FROM world_claim_windows w ORDER BY w.world_id, w.opened_at, w.id`,
        )
      ).rows
    : []
  const properties = (
    await client.query<PropertyRow>(
      `SELECT id, world_id, district_key, district_geometry_fingerprint, activated_sequence, activator_core_user_id, activator_discord_user_id,
              chain || '/' || standard || ':' || contract || '/' || token_id AS asset, activated_at
         FROM world_properties ORDER BY world_id, activated_sequence`,
    )
  ).rows

  for (const t of tickets) if (!rotations.some((r) => r.world_id === t.world_id)) add('tickets', `ticket ${t.id} names world ${t.world_id}, which has no rotation`)

  for (const r of rotations) {
    const label = `world ${r.world_id}'s district rotation`
    const highWater = Number(r.high_water)
    const epochStart = Number(r.epoch_start_ordinal)
    const mineSlots = slots.filter((s) => s.world_id === r.world_id)
    const mineTickets = tickets.filter((t) => t.world_id === r.world_id)
    const report: TicketVerifyReport = {
      epoch: r.epoch,
      highWater,
      committed: Number(r.committed_count),
      active: mineTickets.filter((t) => t.status === 'active').length,
      lapsed: mineTickets.filter((t) => t.status === 'active' && t.lapsed).length,
      free: mineSlots.filter((s) => s.state === 'free').length,
      windows: windows.filter((w) => w.world_id === r.world_id && w.open).length,
      lapsedWindows: windows.filter((w) => w.world_id === r.world_id && w.open && w.ran_out).length,
    }
    reports.set(r.world_id, report)

    // The rotation follows the governing configuration, exactly.
    const latest = (await client.query<{ version: number }>('SELECT version FROM world_config_adoptions WHERE world_id = $1 ORDER BY adoption_seq DESC LIMIT 1', [r.world_id])).rows[0]
    if (!latest || latest.version !== r.basis_config_version) add('rotation', `${label} follows configuration version ${r.basis_config_version}; version ${latest?.version ?? 'none'} governs the world`)
    const copy = (await client.query<{ config_canonical: string; config_hash: string }>('SELECT config_canonical, config_hash FROM world_config_versions WHERE world_id = $1 AND version = $2', [r.world_id, r.basis_config_version])).rows[0]
    const judged = copy ? judgeWorldConfig(JSON.parse(copy.config_canonical), r.world_id, null) : null
    if (!copy || copy.config_hash !== r.basis_config_hash) add('rotation', `${label} names configuration hash ${r.basis_config_hash}, not the copy's`)
    if (!judged || judged.verdict !== 'accepted') add('rotation', `${label} follows a configuration version this build does not read as a city`)
    else {
      if (judged.world.layout.geometryFingerprint !== r.layout_geometry_fingerprint) add('rotation', `${label} records another layout geometry than its configuration draws`)
      if (JSON.stringify(defaultRotationDistricts(judged.config.districts)) !== JSON.stringify(r.districts)) add('rotation', `${label} is not its configuration's default districts in order`)
    }
    if (mineSlots.length !== highWater || mineSlots.some((s, i) => Number(s.ordinal) !== i)) add('slots', `${label} has high-water mark ${highWater} but slots ${mineSlots.map((s) => s.ordinal).join(',') || 'none'}`)
    const committed = mineTickets.filter((t) => t.status === 'committed')
    if (committed.length !== report.committed) add('rotation', `${label} counts ${report.committed} committed tickets; ${committed.length} are committed`)

    // Slots.
    const districts = Array.isArray(r.districts) ? (r.districts as string[]) : []
    for (const s of mineSlots) {
      const sLabel = `${label} slot ${s.ordinal}`
      const ordinal = Number(s.ordinal)
      if (s.epoch === r.epoch && (ordinal < epochStart || rotationDistrict(districts, epochStart, ordinal) !== s.district_key)) add('slots', `${sLabel} is not on the district its position in epoch ${r.epoch} names`)
      if (s.epoch > r.epoch || (s.epoch < r.epoch && s.state !== 'retired' && s.state !== 'consumed')) add('slots', `${sLabel} of epoch ${s.epoch} is ${s.state} in epoch ${r.epoch}`)
      const own = mineTickets.filter((t) => t.kind === 'fallback' && t.ordinal === s.ordinal)
      const generations = own.map((t) => t.generation!).sort((a, b) => a - b)
      if (generations.length !== s.generation || generations.some((g, i) => g !== i + 1)) add('slots', `${sLabel} is at generation ${s.generation} but was issued as generations ${generations.join(',') || 'none'}`)
      const current = own.find((t) => t.generation === s.generation)
      if (own.some((t) => t.generation !== s.generation && (t.status === 'active' || t.status === 'committed'))) add('slots', `${sLabel} has an earlier generation still active or committed`)
      if ((s.state === 'held') !== (current?.status === 'active')) add('slots', `${sLabel} is ${s.state} but its current generation's ticket is ${current?.status ?? 'missing'}`)
      if ((s.state === 'consumed') !== (current?.status === 'committed')) add('slots', `${sLabel} is ${s.state} but its current generation's ticket is ${current?.status ?? 'missing'}`)
      if (current && current.district_key !== s.district_key) add('slots', `${sLabel} is on ${s.district_key}; its ticket names ${current.district_key}`)
    }

    // Tickets.
    const holders = mineTickets.filter((t) => t.status === 'active').map((t) => t.actor_discord_user_id)
    if (new Set(holders).size !== holders.length) add('tickets', `${label} has a player holding two active tickets`)
    for (const t of mineTickets) {
      const tLabel = `world ${r.world_id} ticket ${t.id}`
      if (t.status === 'active' && t.epoch !== r.epoch) add('tickets', `${tLabel} is active in epoch ${t.epoch}; the rotation is in epoch ${r.epoch}`)
      // Issued in its rotation's epoch, which only ever moves on: no ticket, however it ended, names one not reached yet.
      if (t.status !== 'active' && t.epoch > r.epoch) add('tickets', `${tLabel} names epoch ${t.epoch}; its rotation has reached only epoch ${r.epoch}`)
      if (t.status === 'active' && t.layout_geometry_fingerprint !== r.layout_geometry_fingerprint) add('tickets', `${tLabel} is active on another layout geometry than its rotation's`)
      if (t.status !== 'committed') continue
      const p = properties.find((x) => x.id === t.property_id)
      if (!p || p.world_id !== t.world_id || p.district_key !== t.district_key || p.district_geometry_fingerprint !== t.district_geometry_fingerprint || p.activated_sequence !== t.committed_sequence)
        add('tickets', `${tLabel} is committed, but not by a property of its world on its district at the sequence it records`)
      else if (p.activator_core_user_id !== t.actor_core_user_id || p.activator_discord_user_id !== t.actor_discord_user_id) add('tickets', `${tLabel} was consumed by a property another player activated`)
      else if (t.kind === 'rule' && p.asset !== t.asset) add('tickets', `${tLabel} is a rule ticket for ${t.asset} but became ${p.asset}`)
    }
    const consumed = committed.map((t) => t.property_id)
    if (new Set(consumed).size !== consumed.length) add('tickets', `${label} has a property that consumed two tickets`)

    if (policy) verifyTicketPolicy(r, mineTickets, windows.filter((w) => w.world_id === r.world_id), properties, add)
    if (hardened) verifyTicketHardening(r, mineTickets, windows.filter((w) => w.world_id === r.world_id), add)

    // Coverage: since the rotation began, every property consumed a ticket.
    for (const p of properties.filter((x) => x.world_id === r.world_id && x.activated_at >= r.created_at))
      if (!committed.some((t) => t.property_id === p.id)) add('tickets', `world ${r.world_id} property ${p.id} was activated after its rotation began without consuming a ticket`)
  }
  return reports
}

/** The claim windows and rule provenance of one world (0011). */
function verifyTicketPolicy(r: RotationRow, mine: readonly TicketRow[], windows: readonly WindowRow[], properties: readonly PropertyRow[], add: AddViolation): void {
  const label = `world ${r.world_id}'s claim windows`
  const open = windows.filter((w) => w.open).map((w) => w.actor_discord_user_id)
  if (new Set(open).size !== open.length) add('windows', `${label}: a player holds two open claim windows`)
  for (const w of windows) {
    const wLabel = `world ${r.world_id} claim window ${w.id}`
    if (w.strays > 0) add('windows', `${wLabel} holds ${w.strays} ticket(s) of another holder, or ending at another time`)
    if (w.opened_by === 'issuance' && !w.exact) add('windows', `${wLabel} does not last exactly 900 seconds`)
    if (w.opened_by === 'issuance' && !w.opened_by_ticket) add('windows', `${wLabel} did not open with a ticket issued at that instant`)
    if (w.opened_by !== 'issuance' && w.opened_by !== 'migration-0011') add('windows', `${wLabel} was opened by ${w.opened_by}`)
    if (w.close_reason === 'lapsed' && w.closed_after_expiry !== true) add('windows', `${wLabel} lapsed before it ran out`)
    if (w.close_reason === 'activated') {
      const p = properties.find((x) => x.id === w.property_id)
      const by = mine.find((t) => t.status === 'committed' && t.property_id === w.property_id && t.actor_discord_user_id === w.actor_discord_user_id && (t.claim_window === w.id || t.claim_window === null))
      if (!p || !by) add('windows', `${wLabel} was closed by an activation, but not by a property one of its tickets became`)
    }
    if (w.close_reason !== null && w.close_reason !== 'lapsed' && w.close_reason !== 'activated') add('windows', `${wLabel} closed ${w.close_reason}`)
  }
  for (const t of mine) {
    const tLabel = `world ${r.world_id} ticket ${t.id}`
    const window = windows.find((w) => w.id === t.claim_window)
    if (t.since_0011 && !t.claim_window) add('windows', `${tLabel} was issued after migration 0011 outside a claim window`)
    if (t.claim_window && !window) add('windows', `${tLabel} names claim window ${t.claim_window}, which is not of its world`)
    if (t.status === 'active' && window && !window.open) add('windows', `${tLabel} is active in a closed claim window`)
    if (t.status === 'committed' && window && !(window.close_reason === 'activated' && window.property_id === t.property_id)) add('windows', `${tLabel} is committed, but its claim window was not closed by its property`)
    if (t.kind === 'fallback' && t.district_rule !== null) add('rules', `${tLabel} is a fallback ticket on a restricted district`)
    if (t.kind === 'rule' && t.since_0011 && t.gate_rule_id !== t.district_rule) add('rules', `${tLabel} records Proofy rule ${t.gate_rule_id ?? 'none'}; its configuration names ${t.district_rule ?? 'none'} for its district`)
    if (t.authorization_source !== null && t.authorization_source !== 'local-fixture') add('rules', `${tLabel} is authorized by ${t.authorization_source}, not local test data`)
    if (t.status === 'superseded' && t.since_0011 && t.supersede_cause !== 'rotation' && t.supersede_cause !== 'rules') add('rules', `${tLabel} was superseded without saying why`)
    // Withdrawn while active, so in the epoch that governed then (0011's commit check): a later rotation change leaves it in an earlier one.
    if (t.supersede_cause === 'rules' && (t.kind !== 'rule' || t.epoch > r.epoch)) add('rules', `${tLabel} was superseded by a rule change, but is not a rule ticket of an epoch its rotation has reached`)
    if (t.supersede_cause === 'rotation' && t.epoch >= r.epoch) add('rules', `${tLabel} was superseded by a rotation change, but its rotation is still in its epoch`)
  }
}

/** The 900-second bound on every open lease, and live tickets against the configuration that governs now (0012). */
function verifyTicketHardening(r: RotationRow, mine: readonly TicketRow[], windows: readonly WindowRow[], add: AddViolation): void {
  const districts = Array.isArray(r.districts) ? (r.districts as string[]) : []
  for (const w of windows) if (w.open && !w.within_lease) add('windows', `world ${r.world_id} claim window ${w.id} is open and lasts longer than 900 seconds`)
  for (const t of mine) {
    if (t.status !== 'active') continue
    const tLabel = `world ${r.world_id} ticket ${t.id}`
    if (!t.within_lease) add('windows', `${tLabel} is active and lasts longer than 900 seconds`)
    if (!t.since_0011) continue
    if (t.kind === 'fallback' && (t.governing_rule !== null || !districts.includes(t.district_key))) add('rules', `${tLabel} is an active fallback ticket on a district the governing configuration does not leave in its rotation`)
    if (t.kind === 'rule' && t.gate_rule_id !== t.governing_rule) add('rules', `${tLabel} records Proofy rule ${t.gate_rule_id ?? 'none'}; the governing configuration names ${t.governing_rule ?? 'none'} for its district`)
  }
}
