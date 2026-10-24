import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { verifyCity } from '../src/city/verify'
import { migrate } from '../src/db/migrations'
import { assetKey, type DistrictRuleMatch } from '../src/engine'
import type { OpenedPlaySession } from '../src/play/session'
import type { ActivationStep } from '../src/world/properties'
import { worldClaimWindowsOf } from '../src/world/rotation'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { ADA, BEA, GUILD_A, INSTALLATION_A, INSTALLATION_B } from './fakePlay'
import { district, DOC, keeper, player, refusalOf, ROTATION, sleep, ticketWorld, tide, type SetupOptions } from './ticketHarness'

/**
 * DISTRICT TICKET HARDENING (P1-C2-D2H, migration 0012) against a disposable Postgres. No policy changes: the database
 * now holds D1, D2 and D4 itself, where 0011 left them to the service.
 *
 *   LEGACY LEASES   a lease issued before 0011 (0010 allowed up to an hour) is cut, never lengthened, to 900 seconds after
 *                   its claim was first issued; one whose cut end has passed is ended (expired, slot freed, window lapsed);
 *                   upgrading from 0010 or from 0011, failing half way, re-applying and running beside live tickets.
 *   GATES           a rotation is exactly its governing configuration's unrestricted districts; an adoption leaves no live
 *                   ticket that configuration does not authorize; a ticket commits only against the configuration that
 *                   governs NOW. Proven against the database itself: direct SQL, and corruption injected after the
 *                   service's own checks have passed.
 *   ACTOR BINDING   (M22) nobody closes another player's claim window with a property their ticket did not become.
 *   OPEN DECISION   (L1, unchanged) a mixed city still gives a provisional fallback ticket to a player whose every NFT a
 *                   rule sends to a restricted district they do not qualify for; it still never activates.
 */
const CY = player(3, 'Cy')
const DEE = player(4, 'Dee')
const EVE = player(5, 'Eve')
const FAY = player(6, 'Fay')
const GUS = player(7, 'Gus')
const HAL = player(8, 'Hal')
const CAPTAINS: DistrictRuleMatch[] = [{ id: 'captains', district: 'compass-row' }]
const TO_DUNE: DistrictRuleMatch[] = [{ id: 'r1', district: 'dune' }]
const withRule = (key: string, verificationRuleId: number, label: string) => ({ ...DOC, districts: DOC.districts.map((d) => (d.key === key ? { ...d, proofyRule: { verificationRuleId, label } } : d)) })
/** Saltmarsh restricted: another default rotation, the same geometry. */
const SALT = withRule('saltmarsh', 48, 'Salt role')
/** Compass Row under another Proofy rule: the same rotation, a rule change only. */
const HARBOR_MASTER = withRule('compass-row', 47, 'Harbor Master role')
/** Presentation only. */
const RENAMED = { ...DOC, cityName: 'Harborlight Renamed' }
/** Another geometry: one more district (possible only before a world's first property). */
const REEF = { ...DOC, districts: [...DOC.districts, district('reef')] }

describe.skipIf(NO_TEST_DATABASE)('district ticket hardening (migration 0012) against a disposable Postgres', () => {
  const t = useTestSchema()
  const { setup, one, rotation, slotsOf, sequenceOf, statusOf } = ticketWorld(t)
  type Env = Awaited<ReturnType<typeof setup>>

  async function through(last: number, edit?: (sql: string) => string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'rc-hardening-'))
    for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort())
      if (Number(file.slice(0, 4)) <= last) await copyFile(join(MIGRATIONS_DIR, file), join(dir, file))
    if (edit) await writeFile(join(dir, '0012_district_ticket_hardening.sql'), edit(await readFile(join(MIGRATIONS_DIR, '0012_district_ticket_hardening.sql'), 'utf8')))
    return dir
  }

  /** One transaction on its own connection; rolled back if `work` throws. */
  async function txn<T>(work: (c: pg.PoolClient) => Promise<T>, replica = false): Promise<T> {
    const c = await t.db.connect()
    try {
      await c.query('BEGIN')
      if (replica) await c.query(`SET LOCAL session_replication_role = 'replica'`)
      const out = await work(c)
      await c.query('COMMIT')
      return out
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      c.release()
    }
  }

  /** TIME TRAVEL, for tests only, past the guards in this disposable schema: these tickets (and, once 0011 is applied, their holders' open windows) were issued `seconds` earlier. */
  async function age(ids: string[], seconds: number): Promise<void> {
    await txn(async (c) => {
      const windows = (await c.query<{ present: boolean }>(`SELECT to_regclass('world_claim_windows') IS NOT NULL AS present`)).rows[0].present
      if (windows)
        await c.query(
          `UPDATE world_claim_windows w SET opened_at = w.opened_at - make_interval(secs => $2), expires_at = w.expires_at - make_interval(secs => $2)
            WHERE w.closed_at IS NULL AND EXISTS (SELECT 1 FROM world_district_tickets t WHERE t.id = ANY($1::uuid[]) AND t.world_id = w.world_id AND t.actor_discord_user_id = w.actor_discord_user_id)`,
          [ids, seconds],
        )
      await c.query('UPDATE world_district_tickets SET issued_at = issued_at - make_interval(secs => $2), expires_at = expires_at - make_interval(secs => $2) WHERE id = ANY($1::uuid[])', [ids, seconds])
    }, true)
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // A populated 0010 database, written exactly as 0010's store wrote it
  // ---------------------------------------------------------------------------------------------------------------------

  const governingOf = (worldId: string, version?: number) =>
    one<{ version: number; config_hash: string; layout_geometry_fingerprint: string; districts: { key: string; geometryFingerprint: string }[] }>(
      `SELECT g.version, v.config_hash, g.layout_geometry_fingerprint, g.districts FROM world_config_geometries g JOIN world_config_versions v USING (world_id, version)
        WHERE g.world_id = $1 AND g.version = coalesce($2, (SELECT a.version FROM world_config_adoptions a WHERE a.world_id = $1 ORDER BY a.adoption_seq DESC LIMIT 1))`,
      [worldId, version ?? null],
    )

  /** A ticket issued the 0010 way: a fallback one from the rotation (its slot with it), or a rule one; its own lease of `lifetime` seconds, or a reissue's. */
  async function issue0010(c: pg.PoolClient, worldId: string, o: OpenedPlaySession, who: { discordUserId: string; coreUserId: string }, lifetime: number, rule?: { district: string; asset: string; ruleRef: string }, reissuedFrom?: string): Promise<string> {
    const r = (await c.query<{ epoch: number; basis_config_version: number; basis_config_hash: string; layout_geometry_fingerprint: string; districts: string[]; epoch_start_ordinal: string; high_water: string }>(
      'SELECT epoch, basis_config_version, basis_config_hash, layout_geometry_fingerprint, districts, epoch_start_ordinal, high_water FROM world_assignment_rotations WHERE world_id = $1 FOR UPDATE', [worldId])).rows[0]
    let ordinal: number | null = null
    let district = rule?.district ?? ''
    if (!rule) {
      ordinal = Number((await c.query<{ high_water: string }>('UPDATE world_assignment_rotations SET high_water = high_water + 1 WHERE world_id = $1 RETURNING high_water', [worldId])).rows[0].high_water) - 1
      district = r.districts[(ordinal - Number(r.epoch_start_ordinal)) % r.districts.length]
      await c.query(`INSERT INTO world_assignment_slots (world_id, ordinal, epoch, district_key, generation, state) VALUES ($1, $2, $3, $4, 1, 'held')`, [worldId, ordinal, r.epoch, district])
    }
    const g = (await c.query<{ districts: { key: string; geometryFingerprint: string }[] }>('SELECT districts FROM world_config_geometries WHERE world_id = $1 AND version = $2', [worldId, r.basis_config_version])).rows[0]
    return (
      await c.query<{ id: string }>(
        `INSERT INTO world_district_tickets (id, world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, actor_discord_user_id, actor_core_user_id, issued_in_play_session, kind, district_key,
                                             district_geometry_fingerprint, epoch, ordinal, generation, asset, rule_ref, config_version, config_hash, layout_geometry_fingerprint, status, issued_at, expires_at, reissued_from)
         VALUES (gen_random_uuid(), $1, 'dev', 'rare-city', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'active', clock_timestamp(),
                 coalesce((SELECT s.expires_at FROM world_district_tickets s WHERE s.id = $19), clock_timestamp() + make_interval(secs => $18)), $19)
         RETURNING id`,
        [worldId, INSTALLATION_A, GUILD_A, who.discordUserId, who.coreUserId, o.response.viewer.session.ref, rule ? 'rule' : 'fallback', district, g.districts.find((d) => d.key === district)!.geometryFingerprint,
          r.epoch, ordinal, rule ? null : 1, rule?.asset ?? null, rule?.ruleRef ?? null, r.basis_config_version, r.basis_config_hash, r.layout_geometry_fingerprint, lifetime, reissuedFrom ?? null],
      )
    ).rows[0].id
  }

  /**
   * The legacy city, at 0010: Gus's property placed before the world had a rotation, then his rule ticket committed to it
   * (no claim window will ever name it); a reissue chain (Fay: a one-hour lease issued 1000 s ago, superseded by a
   * rotation change and reissued, so her claim is older than the ticket she holds); and active leases of 5 s (Ada, issued
   * 10 s ago), 900 s (Bea, 300 s ago), 3600 s (Cy 1000 s ago, Dee 100 s ago) and a 3600 s rule ticket (Eve, 200 s ago).
   */
  async function legacyCity(options: SetupOptions = {}) {
    const dir = await through(10)
    try {
      await migrate(t.db, { dir, environment: 'local' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    const env = await setup({ ...options, migrated: true })
    const g = await env.open(INSTALLATION_A, GUS)
    const worldId = g.response.world.id
    const placed = await env.store.activate(await env.live(g), { asset: keeper(70), plotId: 'lantern-quay-w0-p0', geometryFingerprint: g.response.world.definition.geometryFingerprint }, { activeConfig: env.sessions.activeConfig(await env.live(g)) })
    env.p.publish(INSTALLATION_A, SALT)
    const [a, b, c, d, e, f] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY), await env.open(INSTALLATION_A, DEE), await env.open(INSTALLATION_A, EVE), await env.open(INSTALLATION_A, FAY)]
    const v2 = await governingOf(worldId)
    expect(v2.version).toBe(2)
    await txn((cl) =>
      cl.query(`INSERT INTO world_assignment_rotations (world_id, epoch, epoch_start_ordinal, high_water, committed_count, basis_config_version, basis_config_hash, layout_geometry_fingerprint, districts) VALUES ($1, 1, 0, 0, 0, $2, $3, $4, '["lantern-quay","tidewater","dune"]'::jsonb)`,
        [worldId, v2.version, v2.config_hash, v2.layout_geometry_fingerprint]),
    )
    const root = await txn((cl) => issue0010(cl, worldId, f, FAY, 3600))
    await age([root], 1000)
    // Version 1 governs again: 0010's rotation change, in one transaction: superseded, retired, the next epoch, reissued.
    const v1 = await governingOf(worldId, 1)
    const reissue = await txn(async (cl) => {
      await cl.query('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) SELECT $1, max(adoption_seq) + 1, 1 FROM world_config_adoptions WHERE world_id = $1', [worldId])
      await cl.query(`UPDATE world_district_tickets SET status = 'superseded', end_reason = 'rotation_changed' WHERE id = $1`, [root])
      await cl.query(`UPDATE world_assignment_slots SET state = 'retired' WHERE world_id = $1 AND state IN ('held', 'free')`, [worldId])
      await cl.query('UPDATE world_assignment_rotations SET epoch = epoch + 1, epoch_start_ordinal = high_water, basis_config_version = 1, basis_config_hash = $2, layout_geometry_fingerprint = $3, districts = $4::jsonb WHERE world_id = $1',
        [worldId, v1.config_hash, v1.layout_geometry_fingerprint, JSON.stringify(ROTATION)])
      return issue0010(cl, worldId, f, FAY, 0, undefined, root)
    })
    const gus = await txn(async (cl) => {
      const id = await issue0010(cl, worldId, g, GUS, 3600, { district: 'lantern-quay', asset: assetKey(keeper(70)), ruleRef: 'gus-rule' })
      await cl.query(`UPDATE world_district_tickets SET status = 'committed', end_reason = 'activated', property_id = $2, committed_sequence = (SELECT c.sequence FROM city c JOIN worlds w ON w.city_id = c.id WHERE w.id = $1) WHERE id = $3`, [worldId, placed.property.id, id])
      await cl.query('UPDATE world_assignment_rotations SET committed_count = committed_count + 1 WHERE world_id = $1', [worldId])
      return id
    })
    const ids = {
      fayRoot: root,
      fay: reissue,
      gus,
      ada: await txn((cl) => issue0010(cl, worldId, a, ADA, 5)),
      bea: await txn((cl) => issue0010(cl, worldId, b, BEA, 900)),
      cy: await txn((cl) => issue0010(cl, worldId, c, CY, 3600)),
      dee: await txn((cl) => issue0010(cl, worldId, d, DEE, 3600)),
      eve: await txn((cl) => issue0010(cl, worldId, e, EVE, 3600, { district: 'dune', asset: assetKey(tide(5)), ruleRef: 'r1' })),
    }
    for (const [id, s] of [[ids.ada, 10], [ids.bea, 300], [ids.cy, 1000], [ids.dee, 100], [ids.eve, 200]] as const) await age([id], s)
    return { env, worldId, ids, property: placed.property.id, sessions: { a, b, c, d, e, f, g } }
  }

  /** `legacy_expires_at`, or NULL on a database before 0012. */
  const legacyOf = async (alias: string) =>
    (await t.db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'legacy_expires_at'", [t.schema])).rowCount ? `${alias}.legacy_expires_at::text` : 'NULL::text'
  /** Each legacy lease as the database states it, exactly (intervals as text: no rounding). */
  const leases = async (worldId: string) =>
    Object.fromEntries(
      (
        await t.db.query<{ id: string; status: string; end_reason: string | null; lasts: string; expires_at: string; legacy: string | null; slot: string | null }>(
          `SELECT t.id, t.status, t.end_reason, (t.expires_at - t.issued_at)::text AS lasts, t.expires_at::text AS expires_at, ${await legacyOf('t')} AS legacy,
                  (SELECT s.state FROM world_assignment_slots s WHERE s.world_id = t.world_id AND s.ordinal = t.ordinal) AS slot
             FROM world_district_tickets t WHERE t.world_id = $1`,
          [worldId],
        )
      ).rows.map((r) => [r.id, r]),
    )
  /** Each holder's claim windows as the database states them. */
  const windowsBy = async (worldId: string, who: { discordUserId: string }) =>
    (
      await t.db.query<{ id: string; opened_by: string; lasts: string; legacy: string | null; close_reason: string | null }>(
        `SELECT w.id, w.opened_by, (w.expires_at - w.opened_at)::text AS lasts, ${await legacyOf('w')} AS legacy, w.close_reason FROM world_claim_windows w WHERE w.world_id = $1 AND w.actor_discord_user_id = $2 ORDER BY w.opened_at, w.id`,
        [worldId, who.discordUserId],
      )
    ).rows
  /** Every ticket that has ended. */
  const ended = async () => (await t.db.query<{ id: string }>("SELECT id FROM world_district_tickets WHERE status <> 'active'")).rows.map((r) => r.id)
  /** What 0012 must leave exactly as it was: every property, event, freeze, adoption, city, and the tickets `endedBefore` (those that had ended). */
  const history = async (endedBefore: string[]) =>
    JSON.stringify(
      await Promise.all([
        t.db.query('SELECT * FROM world_properties ORDER BY id'),
        t.db.query('SELECT * FROM city_events ORDER BY city_id, sequence'),
        t.db.query('SELECT * FROM world_geometry_freezes ORDER BY world_id'),
        t.db.query('SELECT * FROM world_config_adoptions ORDER BY world_id, adoption_seq'),
        t.db.query('SELECT * FROM city ORDER BY id'),
        t.db.query(
          `SELECT id, world_id, actor_discord_user_id, kind, district_key, epoch, ordinal, generation, asset, rule_ref, config_version, status, issued_at, expires_at, ended_at, end_reason, property_id, committed_sequence, reissued_from
             FROM world_district_tickets WHERE id = ANY($1::uuid[]) ORDER BY id`,
          [endedBefore],
        ),
      ]).then((rs) => rs.map((r) => r.rows)),
    )
  /** Every ticket's original end, and that its end now is no later. */
  const ends = async () =>
    (await t.db.query<{ id: string; was: string; later: boolean }>('SELECT id, coalesce(legacy_expires_at, expires_at)::text AS was, expires_at > coalesce(legacy_expires_at, expires_at) AS later FROM world_district_tickets ORDER BY id')).rows

  describe('legacy leases (L2)', () => {
    it('a populated 0010 database upgraded straight through 0011 and 0012: every lease cut to 900 s from its claim, never lengthened; ended claims expired, slots freed, windows lapsed; history untouched', async () => {
      const { env, worldId, ids, sessions } = await legacyCity()
      const before = await leases(worldId)
      const was = (await t.db.query<{ id: string; expires_at: string }>('SELECT id, expires_at::text AS expires_at FROM world_district_tickets ORDER BY id')).rows
      const endedBefore = await ended()
      const kept = await history(endedBefore)
      const slots = await slotsOf(worldId)

      expect(await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).toEqual({ applied: [11, 12, 13, 14], current: 14 })

      const after = await leases(worldId)
      // 5 s, issued 10 s ago: its own lease had run out; not cut (it was shorter), expired, slot freed.
      expect(after[ids.ada]).toMatchObject({ status: 'expired', end_reason: 'expired', lasts: before[ids.ada].lasts, expires_at: before[ids.ada].expires_at, legacy: null, slot: 'free' })
      // 900 s, issued 300 s ago: already within D2, left exactly as it was.
      expect(after[ids.bea]).toEqual({ ...before[ids.bea], legacy: null })
      // 3600 s, issued 1000 s ago: cut to 900 s, which have passed: expired, slot freed.
      expect(after[ids.cy]).toMatchObject({ status: 'expired', end_reason: 'expired', lasts: '00:15:00', legacy: before[ids.cy].expires_at, slot: 'free' })
      // 3600 s, issued 100 s ago: cut to 900 s, 800 left, still live.
      expect(after[ids.dee]).toMatchObject({ status: 'active', lasts: '00:15:00', legacy: before[ids.dee].expires_at, slot: 'held' })
      // A 3600 s rule ticket issued 200 s ago: cut the same way.
      expect(after[ids.eve]).toMatchObject({ status: 'active', lasts: '00:15:00', legacy: before[ids.eve].expires_at, slot: null })
      // A reissue: her claim began 1000 s ago with the ticket it replaced, so nothing was left of it; cut to the earliest end its CHECK allows, expired.
      expect(after[ids.fay]).toMatchObject({ status: 'expired', lasts: '00:00:00.000001', legacy: before[ids.fay].expires_at, slot: 'free' })
      // Never lengthened; ended tickets, Gus's committed one and his property, every event, freeze and adoption: exactly as they were.
      expect((await ends()).map((e) => [e.id, e.was, e.later])).toEqual(was.map((w) => [w.id, w.expires_at, false]))
      expect(await history(endedBefore)).toEqual(kept)
      expect((await slotsOf(worldId)).map((s) => [s.ordinal, s.generation, s.epoch, s.district_key])).toEqual(slots.map((s) => [s.ordinal, s.generation, s.epoch, s.district_key]))
      // The windows 0011 recorded for them, cut alike, lapsed where nothing is left.
      expect(await windowsBy(worldId, ADA)).toEqual([expect.objectContaining({ opened_by: 'migration-0011', lasts: before[ids.ada].lasts, legacy: null, close_reason: 'lapsed' })])
      expect(await windowsBy(worldId, BEA)).toEqual([expect.objectContaining({ lasts: before[ids.bea].lasts, legacy: null, close_reason: null })])
      expect(await windowsBy(worldId, CY)).toEqual([expect.objectContaining({ lasts: '00:15:00', legacy: before[ids.cy].expires_at, close_reason: 'lapsed' })])
      expect(await windowsBy(worldId, DEE)).toEqual([expect.objectContaining({ lasts: '00:15:00', legacy: before[ids.dee].expires_at, close_reason: null })])
      expect(await windowsBy(worldId, FAY)).toEqual([expect.objectContaining({ lasts: '00:00:00.000001', close_reason: 'lapsed' })])
      expect(await windowsBy(worldId, GUS)).toEqual([])
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })

      // (The trusted source still grants Eve her NFT and its rule, so her rule ticket stands until its cut lease runs out.)
      env.source.grant(EVE, [tide(5)])
      env.source.rules(tide(5), TO_DUNE)
      // Cy's claim ended: a fresh claim opens a new 900 s window, on the oldest freed slot (Fay's) at its next generation.
      const cy = await env.ticketOf(sessions.c, [keeper(3)])
      expect(cy).toMatchObject({ ordinal: 1, generation: 2, districtKey: 'lantern-quay' })
      expect(Date.parse(cy.expiresAt) - Date.parse(cy.issuedAt)).toBe(900_000)
      // Dee's claim: the same ticket; cancelling and entering again is assigned in the same, cut window, never renewed.
      const dee = await env.ticketOf(sessions.d, [keeper(4)])
      expect(dee.id).toBe(ids.dee)
      await env.release(sessions.d, dee)
      const again = await env.ticketOf(sessions.d, [keeper(4)])
      expect([again.id === dee.id, again.ordinal, again.expiresAt, again.claimWindow]).toEqual([false, 2, dee.expiresAt, (await worldClaimWindowsOf(t.db, worldId)).find((w) => w.actor.discordUserId === DEE.discordUserId)!.id])
      expect((await env.activate(sessions.d, again, keeper(4), `${again.districtKey}-w0-p1`)).fresh).toBe(true)
      // Eve's cut lease runs out like any other: the activation refuses it.
      expect(await statusOf(ids.eve)).toBe('active')
      await age([ids.eve], 800)
      expect(await refusalOf(env.activate(sessions.e, { id: ids.eve }, tide(5), 'dune-w0-p0', TO_DUNE))).toBe('ticket_expired')
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('an 0011 database whose legacy holders kept using their windows: each window and its live ticket cut; tickets that ended in it before stay as they ended', async () => {
      const { env, worldId, ids, sessions } = await legacyCity()
      const dir = await through(11)
      try {
        expect(await migrate(t.db, { dir, environment: 'local' })).toEqual({ applied: [11], current: 11 })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
      // Under 0011: Dee cancels her legacy ticket and enters twice more in her 'migration-0011' window (an hour long);
      // Bea places her NFT with her legacy ticket, closing her window.
      await env.release(sessions.d, { id: ids.dee })
      const first = await env.ticketOf(sessions.d, [keeper(4)])
      await env.release(sessions.d, first)
      const second = await env.ticketOf(sessions.d, [keeper(4)])
      expect(Date.parse(second.expiresAt) - Date.parse(second.issuedAt)).toBeGreaterThan(3000_000)
      expect((await env.activate(sessions.b, { id: ids.bea }, keeper(2), 'saltmarsh-w0-p0')).fresh).toBe(true)
      const before = await leases(worldId)
      const was = (await t.db.query<{ id: string; expires_at: string }>('SELECT id, expires_at::text AS expires_at FROM world_district_tickets ORDER BY id')).rows
      const endedBefore = await ended()
      const kept = await history(endedBefore)
      const [deeWindow] = await windowsBy(worldId, DEE)

      expect(await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).toEqual({ applied: [12, 13, 14], current: 14 })

      const after = await leases(worldId)
      // Dee's window: cut to 900 s after her legacy claim; her live ticket ends with it; the two she cancelled keep their ends.
      expect(await windowsBy(worldId, DEE)).toEqual([{ ...deeWindow, lasts: '00:15:00', legacy: before[second.id].expires_at }])
      expect(after[second.id]).toMatchObject({ status: 'active', legacy: before[second.id].expires_at })
      const deeWindowEnd = (await one<{ e: string }>('SELECT expires_at::text AS e FROM world_claim_windows WHERE id = $1', [deeWindow.id])).e
      expect(after[second.id].expires_at).toBe(deeWindowEnd)
      expect(after[first.id]).toEqual({ ...before[first.id], legacy: null })
      expect(after[ids.dee]).toEqual({ ...before[ids.dee], legacy: null })
      // Bea's committed ticket and closed window: history. The rest as in a straight upgrade.
      expect(after[ids.bea]).toEqual({ ...before[ids.bea], legacy: null })
      expect(await windowsBy(worldId, BEA)).toEqual([expect.objectContaining({ close_reason: 'activated', legacy: null })])
      expect(after[ids.cy]).toMatchObject({ status: 'expired', lasts: '00:15:00', slot: 'free' })
      expect(after[ids.fay]).toMatchObject({ status: 'expired', lasts: '00:00:00.000001', slot: 'free' })
      expect((await ends()).map((e) => [e.id, e.was, e.later])).toEqual(was.map((w) => [w.id, w.expires_at, false]))
      expect(await history(endedBefore)).toEqual(kept)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
      // Dee places within what is left of her claim.
      expect((await env.activate(sessions.d, second, keeper(4), `${second.districtKey}-w0-p1`)).fresh).toBe(true)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('a failure anywhere inside it, even while its two guards are off, leaves 0011 exactly as it was, guards on; it then applies, once', async () => {
      const { worldId } = await legacyCity()
      const dir11 = await through(11)
      try {
        await migrate(t.db, { dir: dir11, environment: 'local' })
      } finally {
        await rm(dir11, { recursive: true, force: true })
      }
      const state = async () =>
        JSON.stringify(
          await Promise.all([
            t.db.query('SELECT * FROM world_district_tickets ORDER BY id'),
            t.db.query('SELECT * FROM world_claim_windows ORDER BY id'),
            t.db.query('SELECT * FROM world_assignment_slots ORDER BY world_id, ordinal'),
            t.db.query('SELECT * FROM world_assignment_rotations ORDER BY world_id'),
            t.db.query(`SELECT p.proname, md5(p.prosrc) AS src, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 ORDER BY p.proname, md5(p.prosrc)`, [t.schema]),
            t.db.query(`SELECT c.relname, g.tgname, g.tgenabled FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT g.tgisinternal ORDER BY 1, 2`, [t.schema]),
          ]).then((rs) => rs.map((r) => r.rows)),
        )
      const before = await state()
      const ENABLE = 'ALTER TABLE world_claim_windows ENABLE TRIGGER world_claim_windows_guard;'
      for (const edit of [(sql: string) => sql.replace(ENABLE, `SELECT 1 / 0;\n${ENABLE}`), (sql: string) => `${sql}\nSELECT 1 / 0;\n`]) {
        const dir = await through(12, edit)
        try {
          await expect(migrate(t.db, { dir, environment: 'local' })).rejects.toThrow(/Migration 12 \(district_ticket_hardening\) failed and was rolled back: division by zero/)
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
        expect((await one<{ v: number }>('SELECT max(version)::int AS v FROM schema_migrations')).v).toBe(11)
        expect(await state()).toEqual(before)
        expect((await t.db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'legacy_expires_at'", [t.schema])).rowCount).toBe(0)
      }
      expect(await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).toEqual({ applied: [12, 13, 14], current: 14 })
      const applied = await leases(worldId)
      expect(await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).toEqual({ applied: [], current: 14 })
      expect(await leases(worldId)).toEqual(applied)
      const triggers = (await t.db.query<{ tgname: string; tgenabled: string }>(
        `SELECT g.tgname, g.tgenabled FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname IN ('world_claim_windows', 'world_district_tickets') AND NOT g.tgisinternal ORDER BY 1`, [t.schema])).rows
      expect(triggers).toEqual(['world_claim_window_opened_by_ticket', 'world_claim_windows_guard', 'world_district_ticket_ended_whole', 'world_district_tickets_guard'].map((tgname) => ({ tgname, tgenabled: 'O' })))
      const pinned = (await t.db.query<{ proname: string; proconfig: string[] | null }>(
        "SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname IN ('world_config_district_rules', 'world_config_default_districts', 'world_assignment_rotations_guard', 'world_claim_windows_guard', 'world_district_tickets_guard', 'world_config_adoption_moves_rotation') ORDER BY p.proname", [t.schema])).rows
      expect(pinned).toHaveLength(6)
      for (const p of pinned) expect(p.proconfig, p.proname).toEqual([`search_path=${t.schema}, pg_temp`])
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('waits for a ticket transaction in flight (it never interleaves with one), then applies', async () => {
      let resume!: () => void
      let reached!: () => void
      const atLock = new Promise<void>((r) => (reached = r))
      const gate = new Promise<void>((r) => (resume = r))
      let pause = false
      const { env, worldId } = await legacyCity({ onTicketStep: async (step) => { if (step === 'entry-locked' && pause) { pause = false; reached(); await gate } } })
      const dir11 = await through(11)
      try {
        await migrate(t.db, { dir: dir11, environment: 'local' })
      } finally {
        await rm(dir11, { recursive: true, force: true })
      }
      const h = await env.open(INSTALLATION_A, HAL)
      pause = true
      const entering = env.ticketOf(h, [keeper(8)])
      await atLock
      let done = false
      const migrating = migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' }).then((r) => ((done = true), r))
      await sleep(300)
      expect(done).toBe(false)
      resume()
      const hal = await entering
      expect(await migrating).toEqual({ applied: [12, 13, 14], current: 14 })
      expect(await statusOf(hal.id)).toBe('active')
      expect((await leases(worldId))[hal.id]).toMatchObject({ lasts: '00:15:00', legacy: null })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('a lease stretched past 900 s (corruption, past every guard) is never committed, though the service sees nothing wrong', async () => {
      const env = await setup()
      const [a, b] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA)]
      const worldId = a.response.world.id
      await env.activate(a, await env.ticketOf(a, [keeper(1)]), keeper(1), 'lantern-quay-w0-p0')
      const tb = await env.ticketOf(b, [keeper(2)])
      await txn(async (c) => {
        await c.query("UPDATE world_claim_windows SET expires_at = expires_at + interval '1 minute' WHERE world_id = $1 AND actor_discord_user_id = $2 AND closed_at IS NULL", [worldId, BEA.discordUserId])
        await c.query("UPDATE world_district_tickets SET expires_at = expires_at + interval '1 minute' WHERE id = $1", [tb.id])
      }, true)
      const before = await untouched(worldId)
      await expect(env.activate(b, tb, keeper(2), 'tidewater-w0-p0')).rejects.toThrow(/a district ticket is committed only within a claim window of at most 900 seconds/)
      expect(await untouched(worldId)).toEqual(before)
      expect(await sequenceOf(worldId)).toBe(2)
    })

    it('a lease can be neither cut nor restored by anyone after it: legacy_expires_at is never written on issue or changed', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const ta = await env.ticketOf(a)
      const w = (await worldClaimWindowsOf(t.db, ta.worldId))[0]
      await expect(t.db.query("UPDATE world_district_tickets SET legacy_expires_at = expires_at + interval '1 hour' WHERE id = $1", [ta.id])).rejects.toThrow(/keeps what it was issued as/)
      await expect(t.db.query("UPDATE world_district_tickets SET expires_at = expires_at - interval '1 second' WHERE id = $1", [ta.id])).rejects.toThrow(/keeps what it was issued as/)
      await expect(t.db.query("UPDATE world_claim_windows SET legacy_expires_at = expires_at + interval '1 hour' WHERE id = $1", [w.id])).rejects.toThrow(/never extended, never renewed/)
      await expect(t.db.query(`INSERT INTO world_claim_windows (id, world_id, actor_discord_user_id, actor_core_user_id, opened_at, expires_at, opened_by, legacy_expires_at) VALUES (gen_random_uuid(), $1, '933333333333333333', 'core-z', now(), now(), 'issuance', now() + interval '1 hour')`, [ta.worldId])).rejects.toThrow(/opened, open, only by the issuance of a ticket/)
      expect(await one('SELECT legacy_expires_at FROM world_district_tickets WHERE id = $1', [ta.id])).toEqual({ legacy_expires_at: null })
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------
  // Configuration gates (L3): the database's own, from persisted configuration only
  // ---------------------------------------------------------------------------------------------------------------------

  /**
   * A world that has seen six versions, each recorded and adopted by a launch before anyone entered: 1 DOC, 2 SALT
   * (saltmarsh restricted), 3 HARBOR_MASTER (compass-row under rule 47), 4 RENAMED, 5 REEF (another geometry), 6 DOC
   * again, which governs.
   */
  async function versionedCity(options: SetupOptions = {}) {
    const env = await setup(options)
    const a = await env.open(INSTALLATION_A, ADA)
    const worldId = a.response.world.id
    let n = 20
    for (const doc of [SALT, HARBOR_MASTER, RENAMED, REEF, DOC]) {
      env.p.publish(INSTALLATION_A, doc)
      await env.open(INSTALLATION_A, player(++n))
    }
    expect((await governingOf(worldId)).version).toBe(6)
    return { env, a, worldId }
  }

  /** Corruption, written past every guard by another session: an adoption of `version` that nothing followed. */
  const adoptUnguarded = (worldId: string, version: number) =>
    txn((c) => c.query('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) SELECT $1, max(adoption_seq) + 1, $2 FROM world_config_adoptions WHERE world_id = $1', [worldId, version]), true)

  /** The rows a refused activation must not have changed. */
  const untouched = async (worldId: string) =>
    JSON.stringify(
      await Promise.all([
        t.db.query('SELECT * FROM world_properties ORDER BY id'),
        t.db.query('SELECT * FROM city_events ORDER BY city_id, sequence'),
        t.db.query('SELECT * FROM world_district_tickets WHERE world_id = $1 ORDER BY id', [worldId]),
        t.db.query('SELECT * FROM world_assignment_slots WHERE world_id = $1 ORDER BY ordinal', [worldId]),
        t.db.query('SELECT * FROM world_claim_windows WHERE world_id = $1 ORDER BY id', [worldId]),
        t.db.query('SELECT world_id, epoch, high_water, committed_count, basis_config_version, districts FROM world_assignment_rotations WHERE world_id = $1', [worldId]),
      ]).then((rs) => rs.map((r) => r.rows)),
    )

  describe('configuration gates (L3)', () => {
    it('a rotation is created or moved only as exactly its governing configuration\'s unrestricted districts, in order', async () => {
      const env = await setup()
      const b = await env.open(INSTALLATION_B, BEA)
      const worldId = b.response.world.id
      const v = await governingOf(worldId)
      const create = (districts: string[]) =>
        t.db.query('INSERT INTO world_assignment_rotations (world_id, epoch, epoch_start_ordinal, high_water, committed_count, basis_config_version, basis_config_hash, layout_geometry_fingerprint, districts) VALUES ($1, 1, 0, 0, 0, $2, $3, $4, $5::jsonb)',
          [worldId, v.version, v.config_hash, v.layout_geometry_fingerprint, JSON.stringify(districts)])
      const NOT_DEFAULT = /exactly its governing configuration's unrestricted districts, in configuration order/
      // A restricted district admitted; the order changed; one left out; none at all.
      await expect(create(['lantern-quay', 'tidewater', 'saltmarsh', 'compass-row', 'dune'])).rejects.toThrow(NOT_DEFAULT)
      await expect(create(['tidewater', 'lantern-quay', 'saltmarsh', 'dune'])).rejects.toThrow(NOT_DEFAULT)
      await expect(create(['lantern-quay', 'tidewater', 'saltmarsh'])).rejects.toThrow(NOT_DEFAULT)
      await expect(create([])).rejects.toThrow(NOT_DEFAULT)
      await create(ROTATION)
      // A new epoch (nothing active, nothing reusable) may begin only on the same districts.
      const epoch = (districts: string[]) => t.db.query('UPDATE world_assignment_rotations SET epoch = 2, districts = $2::jsonb WHERE world_id = $1', [worldId, JSON.stringify(districts)])
      await expect(epoch([...ROTATION, 'compass-row'])).rejects.toThrow(NOT_DEFAULT)
      await expect(epoch(['dune', 'saltmarsh', 'tidewater', 'lantern-quay'])).rejects.toThrow(NOT_DEFAULT)
      await epoch(ROTATION)
      expect(await rotation(worldId)).toMatchObject({ epoch: 2, districts: ROTATION })
    })

    it('an adoption is refused unless every live ticket stands on it: a rule-only change must supersede exactly the affected rule tickets in its own transaction', async () => {
      const { env, a, worldId } = await versionedCity()
      const [b, c] = [await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY)]
      env.source.answer(GUILD_A, ADA, 41, true)
      const captain = (await env.assign(a, await env.ticketOf(a, [keeper(7)]), keeper(7), CAPTAINS)).ticket
      const fallback = await env.ticketOf(b, [keeper(2)])
      const dune = (await env.assign(c, await env.ticketOf(c, [tide(3)]), tide(3), TO_DUNE)).ticket
      const v3 = await governingOf(worldId, 3)
      const before = await untouched(worldId)
      // Version 3 (compass-row under rule 47) adopted directly, the rotation moved with it, Ada's ticket left live: refused at commit.
      const adopt3 = (c: pg.PoolClient) =>
        c.query('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) SELECT $1, max(adoption_seq) + 1, 3 FROM world_config_adoptions WHERE world_id = $1', [worldId])
          .then(() => c.query('UPDATE world_assignment_rotations SET basis_config_version = 3, basis_config_hash = $2 WHERE world_id = $1', [worldId, v3.config_hash]))
      await expect(txn(adopt3)).rejects.toThrow(/an adoption leaves no active district ticket its configuration does not authorize/)
      expect(await untouched(worldId)).toEqual(before)
      expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM world_config_adoptions WHERE world_id = $1', [worldId])).n).toBe(6)
      // The same, superseding Ada's rule ticket ('rules') in it: accepted; the fallback and the other rule ticket stand, whole.
      const whole = async () => (await t.db.query('SELECT * FROM world_district_tickets WHERE id = ANY($1::uuid[]) ORDER BY id', [[fallback.id, dune.id]])).rows
      const kept = await whole()
      await txn(async (cl) => {
        await adopt3(cl)
        await cl.query(`UPDATE world_district_tickets SET status = 'superseded', end_reason = 'rotation_changed', supersede_cause = 'rules' WHERE id = $1`, [captain.id])
      })
      expect(await whole()).toEqual(kept)
      expect(await rotation(worldId)).toMatchObject({ epoch: 1, basis_config_version: 3 })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('a version restricting a district of the rotation is adopted only with a new rotation: never by moving the basis under its fallback tickets', async () => {
      const { env, a, worldId } = await versionedCity()
      await env.ticketOf(a, [keeper(1)])
      const [b, c] = [await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY)]
      await env.ticketOf(b, [keeper(2)])
      const salt = await env.ticketOf(c, [keeper(3)])
      expect(salt.districtKey).toBe('saltmarsh')
      const v2 = await governingOf(worldId, 2)
      const before = await untouched(worldId)
      await expect(
        txn(async (cl) => {
          await cl.query('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) SELECT $1, max(adoption_seq) + 1, 2 FROM world_config_adoptions WHERE world_id = $1', [worldId])
          await cl.query('UPDATE world_assignment_rotations SET basis_config_version = 2, basis_config_hash = $2 WHERE world_id = $1', [worldId, v2.config_hash])
        }),
      ).rejects.toThrow(/exactly its governing configuration's unrestricted districts, in configuration order/)
      expect(await untouched(worldId)).toEqual(before)
      // Through the service, the same version begins a new epoch and nothing stands on saltmarsh.
      env.p.publish(INSTALLATION_A, SALT)
      await env.open(INSTALLATION_A, DEE)
      expect(await rotation(worldId)).toMatchObject({ epoch: 2, districts: ['lantern-quay', 'tidewater', 'dune'] })
      expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM world_district_tickets WHERE world_id = $1 AND status = 'active' AND district_key = 'saltmarsh'", [worldId])).n).toBe(0)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    describe('a ticket commits only against the configuration that governs NOW, even after the service judged it (corruption injected after the property is written)', () => {
      /** The world frozen by a first property; then `who` holds `ticket`; an activation of it whose transaction, once the property row is written, sees `version` adopted by a session that followed nothing. */
      async function injected(version: number, pick: (env: Env, worldId: string) => Promise<{ o: OpenedPlaySession; ticket: { id: string }; asset: ReturnType<typeof keeper>; plot: string; matches?: DistrictRuleMatch[] }>) {
        let inject: (() => Promise<void>) | null = null
        const { env, a, worldId } = await versionedCity({ onStep: async (step: ActivationStep) => { if (step === 'property' && inject) { const go = inject; inject = null; await go() } } })
        await env.activate(a, await env.ticketOf(a, [keeper(1)]), keeper(1), 'lantern-quay-w0-p0')
        const chosen = await pick(env, worldId)
        const before = await untouched(worldId)
        const sequence = await sequenceOf(worldId)
        inject = () => adoptUnguarded(worldId, version).then(() => undefined)
        const attempt = env.activate(chosen.o, chosen.ticket, chosen.asset, chosen.plot, chosen.matches ?? [])
        return { attempt, check: async () => {
          expect(inject).toBeNull()
          expect(await untouched(worldId)).toEqual(before)
          expect(await sequenceOf(worldId)).toBe(sequence)
          expect(await statusOf(chosen.ticket.id)).toBe('active')
        } }
      }

      it('a fallback ticket on a district the governing version restricts (M20 in the database)', async () => {
        const { attempt, check } = await injected(2, async (env) => {
          const [b, c] = [await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY)]
          await env.ticketOf(b, [keeper(2)])
          const ticket = await env.ticketOf(c, [keeper(3)])
          expect(ticket.districtKey).toBe('saltmarsh')
          return { o: c, ticket, asset: keeper(3), plot: 'saltmarsh-w0-p0' }
        })
        await expect(attempt).rejects.toThrow(/a fallback ticket is committed only on an unrestricted district of the rotation that governs/)
        await check()
      })

      it('a rule ticket whose district the governing version gates by another Proofy rule (M21 in the database)', async () => {
        const { attempt, check } = await injected(3, async (env) => {
          const b = await env.open(INSTALLATION_A, BEA)
          env.source.answer(GUILD_A, BEA, 41, true)
          const ticket = (await env.assign(b, await env.ticketOf(b, [keeper(7)]), keeper(7), CAPTAINS)).ticket
          expect(ticket.authorization).toEqual({ verificationRuleId: 41, source: 'local-fixture' })
          return { o: b, ticket, asset: keeper(7), plot: 'compass-row-w0-p0', matches: CAPTAINS }
        })
        await expect(attempt).rejects.toThrow(/a rule ticket is committed only while the configuration that governs names its district's Proofy rule as the ticket recorded it/)
        await check()
      })

      it('any ticket, on a geometry other than the governing version\'s', async () => {
        const { attempt, check } = await injected(5, async (env) => {
          const b = await env.open(INSTALLATION_A, BEA)
          const ticket = await env.ticketOf(b, [keeper(2)])
          return { o: b, ticket, asset: keeper(2), plot: 'tidewater-w0-p0' }
        })
        await expect(attempt).rejects.toThrow(/a district ticket is committed only on a district of the geometry that governs its world/)
        await check()
      })

      it('any ticket, while its rotation does not follow the governing version (a stale or superseded configuration)', async () => {
        const { attempt, check } = await injected(4, async (env) => {
          const b = await env.open(INSTALLATION_A, BEA)
          const ticket = await env.ticketOf(b, [keeper(2)])
          return { o: b, ticket, asset: keeper(2), plot: 'tidewater-w0-p0' }
        })
        await expect(attempt).rejects.toThrow(/a district ticket is committed only while its rotation follows the configuration that governs its world/)
        await check()
      })
    })

    it('compatible changes commit: a presentation-only version adopted between issue and commit, and a rule ticket whose rule agrees', async () => {
      const env = await setup()
      const [a, b] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA)]
      const worldId = a.response.world.id
      await env.activate(a, await env.ticketOf(a, [keeper(1)]), keeper(1), 'lantern-quay-w0-p0')
      env.source.answer(GUILD_A, BEA, 41, true)
      const captain = (await env.assign(b, await env.ticketOf(b, [keeper(7)]), keeper(7), [...CAPTAINS, { id: 'also-captains', district: 'compass-row' }])).ticket
      env.p.publish(INSTALLATION_A, RENAMED)
      await env.open(INSTALLATION_A, CY)
      expect(await rotation(worldId)).toMatchObject({ epoch: 1, basis_config_version: 2 })
      expect(captain.configVersion).toBe(1)
      const placed = await env.activate(b, captain, keeper(7), 'compass-row-w0-p0', [...CAPTAINS, { id: 'also-captains', district: 'compass-row' }])
      expect([placed.fresh, placed.ticketId]).toEqual([true, captain.id])
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('a forged issuance is refused even where the rotation itself was corrupted, and nothing is issued in a window longer than 900 s', async () => {
      const env = await setup()
      const [a, b] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA)]
      const worldId = a.response.world.id
      const ta = await env.ticketOf(a, [keeper(1)])
      // Dune dropped from the rotation past the guards; a fallback ticket forged on it, on a slot it does not hold.
      await txn((c) => c.query(`UPDATE world_assignment_rotations SET districts = '["lantern-quay","tidewater","saltmarsh"]'::jsonb WHERE world_id = $1`, [worldId]), true)
      await expect(
        t.db.query(
          `INSERT INTO world_district_tickets (id, world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, actor_discord_user_id, actor_core_user_id, issued_in_play_session, kind, district_key,
                                               district_geometry_fingerprint, epoch, ordinal, generation, config_version, config_hash, layout_geometry_fingerprint, status, issued_at, expires_at, claim_window)
           SELECT gen_random_uuid(), world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, actor_discord_user_id, actor_core_user_id, issued_in_play_session, 'fallback', 'dune',
                  (SELECT g.v ->> 'geometryFingerprint' FROM world_config_geometries c, jsonb_array_elements(c.districts) g(v) WHERE c.world_id = t.world_id AND c.version = 1 AND g.v ->> 'key' = 'dune'),
                  epoch, 0, 1, config_version, config_hash, layout_geometry_fingerprint, 'active', now(), expires_at, claim_window
             FROM world_district_tickets t WHERE id = $1`,
          [ta.id],
        ),
      ).rejects.toThrow(/a fallback ticket names a district of its rotation/)
      await txn((c) => c.query(`UPDATE world_assignment_rotations SET districts = $2::jsonb WHERE world_id = $1`, [worldId, JSON.stringify(ROTATION)]), true)
      // Bea's window stretched past 900 s: cancelling and entering again issues nothing in it.
      const tb = await env.ticketOf(b, [keeper(2)])
      await txn((c) => c.query("UPDATE world_claim_windows SET expires_at = expires_at + interval '1 minute' WHERE world_id = $1 AND actor_discord_user_id = $2", [worldId, BEA.discordUserId]), true)
      await env.release(b, tb)
      await expect(env.tickets.enter(await env.live(b))).rejects.toThrow(/a district ticket is issued only in a claim window of at most 900 seconds/)
      expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM world_district_tickets WHERE world_id = $1 AND actor_discord_user_id = $2 AND status = 'active'", [worldId, BEA.discordUserId])).n).toBe(0)
    })

    it('races: many entrants while an adoption restricts a district of the rotation; every entrant ends with one live ticket the new version authorizes', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const worldId = a.response.world.id
      await env.ticketOf(a, [keeper(1)])
      const players = Array.from({ length: 10 }, (_, i) => player(400 + i))
      const opened = await Promise.all(players.map((who) => env.open(INSTALLATION_A, who)))
      env.p.publish(INSTALLATION_A, SALT)
      const [entered] = await Promise.all([Promise.all(opened.map((o, i) => env.ticketOf(o, [keeper(400 + i)]))), env.open(INSTALLATION_A, BEA)])
      expect(entered).toHaveLength(10)
      expect(await rotation(worldId)).toMatchObject({ epoch: 2, districts: ['lantern-quay', 'tidewater', 'dune'] })
      const live = (await t.db.query<{ actor_discord_user_id: string; district_key: string; epoch: number }>("SELECT actor_discord_user_id, district_key, epoch FROM world_district_tickets WHERE world_id = $1 AND status = 'active'", [worldId])).rows
      expect(new Set(live.map((x) => x.actor_discord_user_id)).size).toBe(11)
      expect(live.every((x) => x.epoch === 2 && x.district_key !== 'saltmarsh')).toBe(true)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------
  // The claim window's actor binding (L4, mutant M22)
  // ---------------------------------------------------------------------------------------------------------------------

  describe('claim window actor binding (L4)', () => {
    it('nobody closes another player\'s window as activated with a historical property their ticket did not become; the refusal is the actor binding', async () => {
      const { env, worldId, ids, property } = await legacyCity()
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
      // Gus's property: committed from his legacy rule ticket before 0011, so no claim window names it.
      expect(await one('SELECT status, claim_window, property_id FROM world_district_tickets WHERE id = $1', [ids.gus])).toEqual({ status: 'committed', claim_window: null, property_id: property })
      expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM world_claim_windows WHERE property_id = $1', [property])).n).toBe(0)
      const h = await env.open(INSTALLATION_A, HAL)
      const hal = await env.ticketOf(h, [keeper(8)])
      const before = await untouched(worldId)
      const attack = (c: Pick<pg.PoolClient, 'query'>) => c.query(`UPDATE world_claim_windows SET close_reason = 'activated', property_id = $2 WHERE id = $1`, [hal.claimWindow, property])
      await expect(attack(t.db)).rejects.toThrow(/a claim window is closed by an activation only by the property one of its tickets became/)
      expect(await untouched(worldId)).toEqual(before)
      // Sensitivity, inside a transaction rolled back in this disposable schema: without the actor binding (M22) the same
      // statement would close Hal's window. The guard is exactly as it was afterwards.
      const def = async () => (await one<{ def: string }>(`SELECT pg_get_functiondef('world_claim_windows_guard'::regproc) AS def`)).def
      const guard = await def()
      const BOUND = "t.status = 'committed' AND t.world_id = OLD.world_id AND t.actor_discord_user_id = OLD.actor_discord_user_id"
      expect(guard.split(BOUND)).toHaveLength(2)
      const c = await t.db.connect()
      try {
        await c.query('BEGIN')
        await c.query(guard.replace(BOUND, "t.status = 'committed' AND t.world_id = OLD.world_id"))
        expect((await attack(c)).rowCount).toBe(1)
      } finally {
        await c.query('ROLLBACK')
        c.release()
      }
      expect(await def()).toBe(guard)
      expect(await untouched(worldId)).toEqual(before)
      expect((await worldClaimWindowsOf(t.db, worldId)).find((w) => w.id === hal.claimWindow)).toMatchObject({ closedAt: null, closeReason: null, propertyId: null })
      expect((await env.activate(h, hal, keeper(8), `${hal.districtKey}-w0-p1`)).fresh).toBe(true)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })
  })

  // ---------------------------------------------------------------------------------------------------------------------
  // L1: an OPEN owner decision, preserved unchanged
  // ---------------------------------------------------------------------------------------------------------------------

  describe('L1 (open owner decision, behaviour unchanged)', () => {
    it('a mixed city gives a provisional fallback ticket to a player whose only NFT a rule sends to a restricted district they do not qualify for; it holds a slot and opens a window, and never activates', async () => {
      const env = await setup()
      const [b, c, d] = [await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY), await env.open(INSTALLATION_A, DEE)]
      const worldId = b.response.world.id
      env.source.rules(keeper(8), CAPTAINS)
      env.source.answer(GUILD_A, BEA, 41, false)
      // Entry is eligibility by NFT alone (authenticated, an unplaced NFT of the city): a fallback ticket, at once.
      const tb = await env.ticketOf(b, [keeper(8)])
      expect(tb).toMatchObject({ kind: 'fallback', districtKey: 'lantern-quay', ordinal: 0 })
      expect(await worldClaimWindowsOf(t.db, worldId)).toEqual([expect.objectContaining({ closedAt: null })])
      // Every way to use it is refused, typed, before anything is written.
      expect(await refusalOf(env.assign(b, tb, keeper(8), CAPTAINS))).toBe('district_rule_unqualified')
      expect(await refusalOf(env.activate(b, tb, keeper(8), 'lantern-quay-w0-p0', CAPTAINS))).toBe('district_rule_unqualified')
      expect(await refusalOf(env.activate(b, tb, keeper(8), 'compass-row-w0-p0', CAPTAINS))).toBe('district_rule_unqualified')
      env.source.answer(GUILD_A, BEA, 41, null)
      expect(await refusalOf(env.activate(b, tb, keeper(8), 'lantern-quay-w0-p0', CAPTAINS))).toBe('district_rule_unverified')
      expect(await sequenceOf(worldId)).toBe(1)
      expect(await statusOf(tb.id)).toBe('active')
      // Meanwhile it holds slot 0: the next entrant is assigned past it, and gets it only once it is released (or expires).
      expect(await env.ticketOf(c, [keeper(3)])).toMatchObject({ ordinal: 1, districtKey: 'tidewater' })
      await env.release(b, tb)
      expect(await env.ticketOf(d, [keeper(4)])).toMatchObject({ ordinal: 0, generation: 2, districtKey: 'lantern-quay' })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })
  })
})
