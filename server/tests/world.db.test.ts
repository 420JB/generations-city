import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyCity } from '../src/city/verify'
import type { AppMode } from '../src/config'
import { migrate } from '../src/db/migrations'
import { createPool } from '../src/db/pool'
import { WORLD_CONFIG_JUDGE, type PlayEnvironment } from '../src/engine'
import { installDemoFixture } from '../src/fixtures/demoCity'
import { createLogger, silentLogger } from '../src/log'
import { canonicalJson as canonical } from '../src/play/canonical'
import { createPlayLaunchService, PlayLaunchError } from '../src/play/launch'
import type { PlayGameReader } from '../src/play/client'
import { createWorldStore, type FoundingStep, type VerifiedLaunch, type WorldStore } from '../src/world/store'
import { snapshot, unguarded } from './activationFixtures'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { DOC_A, DOC_B, fakePlay, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'

const INSTALLATION_C = '01a14800-0000-7000-8000-00000000000c'
const PLAY_ENV: Record<AppMode, PlayEnvironment> = { local: 'dev', staging: 'staging', production: 'live' }
const WORLD_TABLES = ['worlds', 'world_play_bindings', 'world_config_versions', 'world_config_adoptions']
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const GULLS = { key: 'gulls', chain: 'eip155:1', contract: '0x000000000000000000000000000000000000b002', displayName: 'Gulls' }
/** DOC_A with a second collection. */
const WITH_GULLS = { ...DOC_A, collections: [...DOC_A.collections, GULLS] }
/** DOC_A with its one collection replaced (and its monument, which named it, removed). */
const DROPPED = { ...DOC_A, collections: [{ key: 'gulls', chain: 'eip155:1', contract: '0x000000000000000000000000000000000000b002', displayName: 'Gulls' }], districts: DOC_A.districts.map((d) => ({ ...d, monument: null })) }

async function refusal(work: Promise<unknown>): Promise<PlayLaunchError> {
  const err = await work.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(PlayLaunchError)
  return err as PlayLaunchError
}

describe.skipIf(NO_TEST_DATABASE)('persistent brand cities: one world per Play installation, against a disposable Postgres', () => {
  const t = useTestSchema()

  /** A migrated database, a Play with installations A and B (each with one active version), and a launch service. */
  async function setup(
    options: {
      mode?: AppMode
      storeMode?: AppMode
      environment?: PlayEnvironment
      onFoundingStep?: (step: FoundingStep) => void | Promise<void>
      logs?: string[]
      /** Stand between the launch path and the store, e.g. to hold a launch after it has asked Play. */
      wrapStore?: (store: WorldStore) => WorldStore
      /** Stand between the launch path and Play. */
      wrapPlay?: (play: PlayGameReader) => PlayGameReader
      activeConfirmMs?: number
    } = {},
  ) {
    const mode = options.mode ?? 'local'
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: mode })
    const p = fakePlay()
    p.install(INSTALLATION_A, GUILD_A)
    p.install(INSTALLATION_B, GUILD_B)
    p.publish(INSTALLATION_A, DOC_A)
    p.publish(INSTALLATION_B, DOC_B)
    const log = options.logs ? createLogger((line) => void options.logs!.push(line)) : silentLogger
    const service = (db = t.db) =>
      createPlayLaunchService({
        play: options.wrapPlay ? options.wrapPlay(p.play) : p.play,
        environment: options.environment ?? PLAY_ENV[mode],
        gameKey: 'rare-city',
        worlds: (options.wrapStore ?? ((x) => x))(createWorldStore(db, { mode: options.storeMode ?? mode, log, onFoundingStep: options.onFoundingStep })),
        activeConfirmMs: options.activeConfirmMs,
      })
    const s = service()
    const open = (installation: string, name: string) => s.open({ runToken: p.launch(installation, name) })
    return { p, s, service, open }
  }

  const count = async (table: string, where = 'true', params: unknown[] = []) => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n
  const worldRows = async () => Object.fromEntries(await Promise.all([...WORLD_TABLES, 'city', 'city_events'].map(async (table) => [table, await count(table)])))
  /** Everything stored about one world: its rows in every world table, its city row and its events. */
  async function worldSnapshot(worldId: string) {
    const city = `world:${worldId}`
    const q = async (sql: string, params: unknown[]) => JSON.stringify((await t.db.query(sql, params)).rows)
    return {
      world: await q('SELECT * FROM worlds WHERE id = $1', [worldId]),
      binding: await q('SELECT * FROM world_play_bindings WHERE world_id = $1', [worldId]),
      versions: await q('SELECT * FROM world_config_versions WHERE world_id = $1 ORDER BY version', [worldId]),
      adoptions: await q('SELECT * FROM world_config_adoptions WHERE world_id = $1 ORDER BY adoption_seq', [worldId]),
      city: await q('SELECT id, instance_id, sequence, state_version, state::text AS state, canonical, origin, activation_rehearsal, created_at, updated_at FROM city WHERE id = $1', [city]),
      events: await q('SELECT * FROM city_events WHERE city_id = $1 ORDER BY sequence', [city]),
    }
  }
  const governing = async (worldId: string) => (await t.db.query<{ version: number }>('SELECT version FROM world_config_adoptions WHERE world_id = $1 ORDER BY adoption_seq DESC LIMIT 1', [worldId])).rows[0]?.version
  const verdicts = async (worldId: string) => (await t.db.query<{ version: number; verdict: string; code: string | null }>(`SELECT version, verdict, rejection->>'code' AS code FROM world_config_versions WHERE world_id = $1 ORDER BY version`, [worldId])).rows

  describe('founding and returning', () => {
    it('founds one world on the first launch, atomically, with every record the schema requires', async () => {
      const { open } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      expect(a.world).toMatchObject({ provisioned: true, created: true, sequence: 1, state: { version: 1, buildings: {}, openWards: {} }, definition: { foundingConfigVersion: 1, governingConfigVersion: 1, layoutKey: 'standard-radial-even' } })
      expect(a.world.id).toMatch(UUID_V7)
      const id = a.world.id
      const city = (await t.db.query(`SELECT id, sequence, state_version, state::text AS state, canonical, origin, activation_rehearsal FROM city WHERE id <> 'main'`)).rows
      // Outside production 0005 founds a world only on a rehearsal-shaped city: non-canonical, demo-fixture origin, rehearsal flag.
      expect(city).toEqual([{ id: `world:${id}`, sequence: '1', state_version: 1, state: '{"version":1,"buildings":{},"openWards":{}}', canonical: false, origin: 'demo-fixture', activation_rehearsal: true }])
      expect((await t.db.query('SELECT play_environment, play_game_key, play_installation_id, discord_guild_id FROM world_play_bindings')).rows).toEqual([
        { play_environment: 'dev', play_game_key: 'rare-city', play_installation_id: INSTALLATION_A, discord_guild_id: GUILD_A },
      ])
      const event = (await t.db.query<{ sequence: string; type: string; payload: Record<string, unknown> }>('SELECT sequence, type, payload FROM city_events WHERE city_id = $1', [`world:${id}`])).rows
      expect(event).toHaveLength(1)
      expect(event[0]).toMatchObject({ sequence: '1', type: 'city.initialized', payload: { stateVersion: 1, environment: 'local', activationRehearsal: true, world: { id, play: { environment: 'dev', gameKey: 'rare-city', installationId: INSTALLATION_A, discordGuildId: GUILD_A }, foundingConfig: { version: 1, configHash: a.play.configHash, schemaVersion: 1 } } } })
      expect((event[0].payload.world as { foundation: { districts: { key: string }[] } }).foundation.districts.map((d) => d.key)).toEqual(['lantern-quay', 'tidewater', 'compass-row'])
      const versions = (await t.db.query('SELECT version, play_installation_id, schema_version, config_hash, config_canonical, verdict, rejection, judged_by FROM world_config_versions')).rows
      expect(versions).toEqual([{ version: 1, play_installation_id: INSTALLATION_A, schema_version: 1, config_hash: a.play.configHash, config_canonical: expect.any(String), verdict: 'accepted', rejection: null, judged_by: 'rare-city/play-config-v1+world-evolution-v2' }])
      expect(sha256(versions[0].config_canonical)).toBe(a.play.configHash)
      expect(await governing(id)).toBe(1)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, city: null, worlds: [{ id, city: `world:${id}`, sequence: 1, foundingConfigVersion: 1, governingConfigVersion: 1, configVersions: { accepted: 1, rejected: 0 } }], violations: [] })
    })

    it('returns the same world on every later launch, writing nothing new', async () => {
      const { open } = await setup()
      const first = await open(INSTALLATION_A, 'a1')
      const before = await worldSnapshot(first.world.id)
      for (const name of ['a2', 'a3', 'a4']) {
        const again = await open(INSTALLATION_A, name)
        expect(again.world).toEqual({ ...first.world, created: false })
      }
      expect(await worldSnapshot(first.world.id)).toEqual(before)
    })

    it('gives installation B its own world, and each keeps its own on relaunch', async () => {
      const { open } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      const b = await open(INSTALLATION_B, 'b1')
      expect(b.world.id).not.toBe(a.world.id)
      expect(b.world.created).toBe(true)
      expect((await open(INSTALLATION_A, 'a2')).world.id).toBe(a.world.id)
      expect((await open(INSTALLATION_B, 'b2')).world.id).toBe(b.world.id)
      expect(await worldRows()).toEqual({ worlds: 2, world_play_bindings: 2, world_config_versions: 2, world_config_adoptions: 2, city: 2, city_events: 2 })
      const report = await verifyCity(t.db)
      expect(report.ok).toBe(true)
      expect(report.worlds.map((w) => [w.id, w.play?.installationId, w.play?.discordGuildId])).toEqual([
        [a.world.id, INSTALLATION_A, GUILD_A],
        [b.world.id, INSTALLATION_B, GUILD_B],
      ])
    })

    it('founds exactly one world when the first launches race', async () => {
      const { p, s } = await setup()
      const tokens = Array.from({ length: 8 }, (_, i) => p.launch(INSTALLATION_A, `race-${i}`))
      const opened = await Promise.all(tokens.map((runToken) => s.open({ runToken })))
      expect(new Set(opened.map((o) => o.world.id)).size).toBe(1)
      expect(opened.filter((o) => o.world.created)).toHaveLength(1)
      // The losers rolled back the city, event and world they had written: nothing is left over.
      expect(await worldRows()).toEqual({ worlds: 1, world_play_bindings: 1, world_config_versions: 1, world_config_adoptions: 1, city: 1, city_events: 1 })
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('founds exactly one world each when two installations\' first launches race together', async () => {
      const { p, s } = await setup()
      const tokens = Array.from({ length: 16 }, (_, i) => [i % 2 ? INSTALLATION_B : INSTALLATION_A, p.launch(i % 2 ? INSTALLATION_B : INSTALLATION_A, `mixed-${i}`)] as const)
      const opened = await Promise.all(tokens.map(([installation, runToken]) => s.open({ runToken }).then((o) => [installation, o.world.id, o.world.created] as const)))
      const ids = (installation: string) => new Set(opened.filter((o) => o[0] === installation).map((o) => o[1]))
      expect(ids(INSTALLATION_A).size).toBe(1)
      expect(ids(INSTALLATION_B).size).toBe(1)
      expect([...ids(INSTALLATION_A)][0]).not.toBe([...ids(INSTALLATION_B)][0])
      expect(opened.filter((o) => o[2])).toHaveLength(2)
      expect(await worldRows()).toEqual({ worlds: 2, world_play_bindings: 2, world_config_versions: 2, world_config_adoptions: 2, city: 2, city_events: 2 })
    })

    it('when two installations on one Discord server race, one city is founded and the other launch is refused', async () => {
      const { p, s } = await setup()
      p.install(INSTALLATION_C, GUILD_A)
      p.publish(INSTALLATION_C, DOC_A)
      const tokens = Array.from({ length: 10 }, (_, i) => p.launch(i % 2 ? INSTALLATION_C : INSTALLATION_A, `guild-${i}`))
      const outcomes = await Promise.all(tokens.map((runToken) => s.open({ runToken }).then((o) => o.play.installationId, (e: PlayLaunchError) => e.code)))
      const winners = new Set(outcomes.filter((o) => o === INSTALLATION_A || o === INSTALLATION_C))
      expect(winners.size).toBe(1)
      expect(outcomes.filter((o) => o === [...winners][0])).toHaveLength(5)
      expect(outcomes.filter((o) => o === 'world_binding_conflict')).toHaveLength(5)
      expect(await worldRows()).toEqual({ worlds: 1, world_play_bindings: 1, world_config_versions: 1, world_config_adoptions: 1, city: 1, city_events: 1 })
    })

    it('records a new version once and adopts it once when its launches race', async () => {
      const { p, s, open } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      p.publish(INSTALLATION_A, { ...DOC_A, cityName: 'Harborlight Reach' })
      const tokens = Array.from({ length: 6 }, (_, i) => p.launch(INSTALLATION_A, `v2-${i}`))
      const opened = await Promise.all(tokens.map((runToken) => s.open({ runToken })))
      expect(opened.every((o) => o.world.id === a.world.id && !o.world.created && o.world.definition.governingConfigVersion === 2)).toBe(true)
      expect(await verdicts(a.world.id)).toEqual([
        { version: 1, verdict: 'accepted', code: null },
        { version: 2, verdict: 'accepted', code: null },
      ])
      expect((await t.db.query('SELECT adoption_seq, version FROM world_config_adoptions ORDER BY adoption_seq')).rows).toEqual([
        { adoption_seq: 1, version: 1 },
        { adoption_seq: 2, version: 2 },
      ])
    })

    it('serialises the launches that change one world on its city row, so versions and adoptions are written in order', async () => {
      const { p, open, s } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      p.publish(INSTALLATION_A, { ...DOC_A, cityName: 'Harborlight Reach' })
      const holder = await t.db.connect()
      try {
        // Another launch of this world, mid-transaction, holding the city's row lock.
        await holder.query('BEGIN')
        await holder.query('SELECT 1 FROM city WHERE id = $1 FOR UPDATE', [`world:${a.world.id}`])
        const pending = s.open({ runToken: p.launch(INSTALLATION_A, 'queued') })
        let waiting = 0
        for (let i = 0; i < 200 && waiting === 0; i++) {
          waiting = (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM city WHERE id = $1 FOR UPDATE%' AND pid <> pg_backend_pid()`)).rows[0].n
          if (waiting === 0) await new Promise((r) => setTimeout(r, 25))
        }
        expect(waiting).toBe(1)
        // Nothing of the new version is written while it waits.
        expect(await verdicts(a.world.id)).toEqual([{ version: 1, verdict: 'accepted', code: null }])
        await holder.query('COMMIT')
        expect((await pending).world.definition.governingConfigVersion).toBe(2)
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        holder.release()
      }
    })

    it('keeps both worlds across a restart: a new pool and a new service find them', async () => {
      const { p, open, service } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      const b = await open(INSTALLATION_B, 'b1')
      const before = [await worldSnapshot(a.world.id), await worldSnapshot(b.world.id)]
      const url = (t.db as unknown as { options: { connectionString: string } }).options.connectionString
      const fresh = createPool(url, silentLogger, { searchPath: t.schema })
      try {
        const restarted = service(fresh)
        expect((await restarted.open({ runToken: p.launch(INSTALLATION_A, 'after-restart-a') })).world).toEqual({ ...a.world, created: false })
        expect((await restarted.open({ runToken: p.launch(INSTALLATION_B, 'after-restart-b') })).world).toEqual({ ...b.world, created: false })
      } finally {
        await fresh.end()
      }
      expect([await worldSnapshot(a.world.id), await worldSnapshot(b.world.id)]).toEqual(before)
    })
  })

  describe('isolation between installations', () => {
    it('nothing installation A does reaches installation B\'s world', async () => {
      const { p, open } = await setup()
      const b = await open(INSTALLATION_B, 'b1')
      const bBefore = await worldSnapshot(b.world.id)
      const a = await open(INSTALLATION_A, 'a1')
      // A publishes B's very document, an incompatible one and an invalid one; none of it touches B.
      p.publish(INSTALLATION_A, { ...DOC_B })
      expect((await refusal(open(INSTALLATION_A, 'a-as-b'))).code).toBe('config_incompatible')
      p.publish(INSTALLATION_A, { ...DOC_A, worldId: b.world.id })
      expect((await refusal(open(INSTALLATION_A, 'a-names-b'))).code).toBe('config_invalid')
      p.activate(INSTALLATION_A, 1)
      expect((await open(INSTALLATION_A, 'a-again')).world.id).toBe(a.world.id)
      expect(await worldSnapshot(b.world.id)).toEqual(bBefore)
      // The request can never name a world.
      const s = createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city', worlds: createWorldStore(t.db, { mode: 'local', log: silentLogger }) })
      expect((await refusal(s.open({ runToken: p.launch(INSTALLATION_A, 'x'), worldId: b.world.id }))).code).toBe('invalid_request')
      expect(await worldSnapshot(b.world.id)).toEqual(bBefore)
      expect((await verifyCity(t.db)).ok).toBe(true)
    })
  })

  describe('configuration evolution', () => {
    it('a new presentation keeps the city: same world, same geometry, the new version governs', async () => {
      const { p, open } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      const cityBefore = (await worldSnapshot(a.world.id)).city
      p.publish(INSTALLATION_A, { ...DOC_A, cityName: 'Harborlight Reach', districts: DOC_A.districts.map((d) => ({ ...d, name: `${d.name} Old Town`, accent: '#123456' })) })
      const v2 = await open(INSTALLATION_A, 'a2')
      expect(v2.world).toMatchObject({ id: a.world.id, created: false, sequence: 1, definition: { foundingConfigVersion: 1, governingConfigVersion: 2, geometryFingerprint: a.world.definition.geometryFingerprint } })
      expect((v2.config as { cityName: string }).cityName).toBe('Harborlight Reach')
      expect((await worldSnapshot(a.world.id)).city).toBe(cityBefore)
      // A collection may be added: several collections share the city.
      p.publish(INSTALLATION_A, { ...DOC_A, collections: [...DOC_A.collections, { key: 'gulls', chain: 'eip155:1', contract: '0x000000000000000000000000000000000000b002', displayName: 'Gulls' }] })
      expect((await open(INSTALLATION_A, 'a3')).world.definition.governingConfigVersion).toBe(3)
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('a run pinned before a publish is drawn with its own version, and does not turn the city back', async () => {
      const { p, open, s } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      const pinnedToV1 = p.launch(INSTALLATION_A, 'old')
      p.publish(INSTALLATION_A, { ...DOC_A, cityName: 'Harborlight Reach' })
      expect((await open(INSTALLATION_A, 'new')).world.definition.governingConfigVersion).toBe(2)
      const old = await s.open({ runToken: pinnedToV1 })
      expect(old.play.configVersion).toBe(1)
      expect((old.config as { cityName: string }).cityName).toBe('Harborlight')
      expect(old.world).toMatchObject({ id: a.world.id, definition: { governingConfigVersion: 2 } })
      expect(await governing(a.world.id)).toBe(2)
      // Play re-activating version 1 makes it govern again, by a new adoption.
      p.activate(INSTALLATION_A, 1)
      expect((await open(INSTALLATION_A, 'reactivated')).world.definition.governingConfigVersion).toBe(1)
      expect((await t.db.query('SELECT adoption_seq, version FROM world_config_adoptions ORDER BY adoption_seq')).rows.map((r) => [r.adoption_seq, r.version])).toEqual([
        [1, 1],
        [2, 2],
        [3, 1],
      ])
    })

    const incompatible: [string, Record<string, unknown>][] = [
      ['reordered districts', { ...DOC_A, districts: [...DOC_A.districts].reverse() }],
      ['an added district', { ...DOC_A, districts: [...DOC_A.districts, { key: 'reef', name: 'Reef', accent: '#aaaaaa', monument: null, proofyRule: null }] }],
      ['a renamed district key', { ...DOC_A, districts: DOC_A.districts.map((d, i) => (i === 1 ? { ...d, key: 'tides' } : d)) }],
      ['a removed collection', { ...DOC_A, collections: [{ key: 'gulls', chain: 'eip155:1', contract: '0x000000000000000000000000000000000000b002', displayName: 'Gulls' }], districts: DOC_A.districts.map((d) => ({ ...d, monument: null })) }],
      ['a repointed collection', { ...DOC_A, collections: [{ ...DOC_A.collections[0], contract: '0x000000000000000000000000000000000000a00f' }] }],
    ]
    for (const [label, document] of incompatible) {
      it(`refuses ${label} without moving anything, records the verdict, and stays refused`, async () => {
        const { p, open } = await setup()
        const a = await open(INSTALLATION_A, 'a1')
        const before = await worldSnapshot(a.world.id)
        p.publish(INSTALLATION_A, document)
        const err = await refusal(open(INSTALLATION_A, 'bad'))
        expect([err.status, err.code]).toEqual([409, 'config_incompatible'])
        expect(err.problems?.length).toBeGreaterThan(0)
        const after = await worldSnapshot(a.world.id)
        expect({ ...after, versions: before.versions }).toEqual(before)
        expect(await verdicts(a.world.id)).toEqual([
          { version: 1, verdict: 'accepted', code: null },
          { version: 2, verdict: 'rejected', code: 'config_incompatible' },
        ])
        // Asked again, the recorded verdict answers; nothing new is written.
        const again = await refusal(open(INSTALLATION_A, 'bad-again'))
        expect([again.code, again.problems]).toEqual([err.code, err.problems])
        expect(await worldSnapshot(a.world.id)).toEqual(after)
        // A compatible version after it is accepted and governs.
        p.publish(INSTALLATION_A, { ...DOC_A, cityName: 'Harborlight Again' })
        expect((await open(INSTALLATION_A, 'fixed')).world).toMatchObject({ id: a.world.id, definition: { governingConfigVersion: 3 } })
        expect((await verifyCity(t.db)).ok).toBe(true)
      })
    }

    it('records an invalid version for an existing world as rejected, and changes nothing else', async () => {
      const { p, open } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      p.publish(INSTALLATION_A, { ...DOC_A, roads: 'gold' })
      const err = await refusal(open(INSTALLATION_A, 'bad'))
      expect([err.status, err.code, err.problems]).toEqual([422, 'config_invalid', [{ path: 'roads', detail: 'is not a configurable field' }]])
      expect(await verdicts(a.world.id)).toEqual([
        { version: 1, verdict: 'accepted', code: null },
        { version: 2, verdict: 'rejected', code: 'config_invalid' },
      ])
      expect(await governing(a.world.id)).toBe(1)
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('logs what it wrote once it is committed, and never a run token', async () => {
      const logs: string[] = []
      const { p, s } = await setup({ logs })
      const first = p.launch(INSTALLATION_A, 'a1')
      const a = await s.open({ runToken: first })
      p.publish(INSTALLATION_A, { ...DOC_A, districts: [...DOC_A.districts].reverse() })
      const second = p.launch(INSTALLATION_A, 'a2')
      await refusal(s.open({ runToken: second }))
      const lines = logs.map((l) => JSON.parse(l) as Record<string, unknown>)
      expect(lines.map((l) => l.message)).toEqual(['world founded', 'world configuration version recorded'])
      expect(lines[0]).toMatchObject({ world: a.world.id, installation: INSTALLATION_A, guild: GUILD_A, playEnvironment: 'dev', configVersion: 1 })
      expect(lines[1]).toMatchObject({ world: a.world.id, version: 2, verdict: 'rejected', code: 'config_incompatible' })
      for (const token of [first, second]) expect(logs.join('\n')).not.toContain(token)
    })

    it('a change of plan or a suspension never touches the world: it is refused by Play, then the same world returns', async () => {
      const { p, open } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      const before = await worldSnapshot(a.world.id)
      p.setStatus(INSTALLATION_A, 'suspended')
      expect((await refusal(open(INSTALLATION_A, 'suspended'))).code).toBe('installation_not_active')
      expect(await worldSnapshot(a.world.id)).toEqual(before)
      p.setStatus(INSTALLATION_A, 'active')
      expect((await open(INSTALLATION_A, 'resumed')).world).toEqual({ ...a.world, created: false })
      // Nothing about a world depends on a plan: no column names one.
      const columns = (await t.db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2)`, [t.schema, WORLD_TABLES])).rows.map((r) => r.column_name)
      expect(columns.filter((c) => /plan|trial|paid|entitle|tier/.test(c))).toEqual([])
    })
  })

  describe('collections stay established, verdicts do not depend on launch order, adoptions follow Play', () => {
    /** Holds the first launch `which` picks, after it has heard from Play and before the store opens it, until released. */
    function holdStore(which: (launch: VerifiedLaunch) => boolean) {
      let release: () => void = () => undefined
      let arrived: () => void = () => undefined
      const arrival = new Promise<void>((r) => (arrived = r))
      let holding = true
      const wrap = (inner: WorldStore): WorldStore => ({
        read: (scope) => inner.read(scope),
        async open(launch, confirmActive) {
          if (holding && which(launch)) {
            holding = false
            await new Promise<void>((r) => {
              release = r
              arrived()
            })
          }
          return inner.open(launch, confirmActive)
        },
      })
      return { wrap, arrival: () => arrival, release: () => release() }
    }
    const rows = async (worldId: string) => (await t.db.query('SELECT adoption_seq, version FROM world_config_adoptions WHERE world_id = $1 ORDER BY adoption_seq', [worldId])).rows.map((r) => [r.adoption_seq, r.version])

    it('never lets a version without an established collection govern: not re-activated, not re-published, not pinned', async () => {
      const { p, s, open } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      const pinnedToV1 = p.launch(INSTALLATION_A, 'old-v1')
      p.publish(INSTALLATION_A, WITH_GULLS)
      expect((await open(INSTALLATION_A, 'a2')).world.definition.governingConfigVersion).toBe(2)
      const before = await worldSnapshot(a.world.id)

      // Play re-activates version 1, which never had gulls.
      p.activate(INSTALLATION_A, 1)
      const reactivated = await refusal(open(INSTALLATION_A, 'react-v1'))
      expect([reactivated.status, reactivated.code]).toEqual([409, 'config_incompatible'])
      expect(reactivated.problems).toEqual([{ path: 'collections', detail: 'collection gulls is part of this city and cannot be removed' }])
      // The same document published again as version 3: the same answer. Its verdict is about the foundation, which
      // it keeps, so it is recorded as accepted; it still cannot govern.
      p.publish(INSTALLATION_A, DOC_A)
      expect((await refusal(open(INSTALLATION_A, 'v3'))).code).toBe('config_incompatible')
      // A run pinned to version 1 before gulls existed is refused too: it would draw the city without them.
      expect((await refusal(s.open({ runToken: pinnedToV1 }))).code).toBe('config_incompatible')
      // Nothing about the city or what governs it moved; only version 3's copy was recorded.
      const after = await worldSnapshot(a.world.id)
      expect({ ...after, versions: before.versions }).toEqual(before)
      expect(await verdicts(a.world.id)).toEqual([
        { version: 1, verdict: 'accepted', code: null },
        { version: 2, verdict: 'accepted', code: null },
        { version: 3, verdict: 'accepted', code: null },
      ])
      expect(await rows(a.world.id)).toEqual([[1, 1], [2, 2]])
      // Keeping gulls (and adding another) governs again.
      p.publish(INSTALLATION_A, { ...WITH_GULLS, cityName: 'Harborlight Again', collections: [...WITH_GULLS.collections, { ...GULLS, key: 'terns', contract: '0x000000000000000000000000000000000000b004', displayName: 'Terns' }] })
      expect((await open(INSTALLATION_A, 'v4')).world.definition.governingConfigVersion).toBe(4)
      // Re-activating version 2 now drops terns: refused. Collections only ever accumulate.
      p.activate(INSTALLATION_A, 2)
      expect((await refusal(open(INSTALLATION_A, 'react-v2'))).problems).toEqual([{ path: 'collections', detail: 'collection terns is part of this city and cannot be removed' }])
      expect(await rows(a.world.id)).toEqual([[1, 1], [2, 2], [3, 4]])
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('re-activating an older version that keeps every established collection still governs again', async () => {
      const { p, open } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      p.publish(INSTALLATION_A, WITH_GULLS)
      await open(INSTALLATION_A, 'a2')
      p.publish(INSTALLATION_A, { ...WITH_GULLS, cityName: 'Harborlight Reach' })
      await open(INSTALLATION_A, 'a3')
      p.activate(INSTALLATION_A, 2)
      expect((await open(INSTALLATION_A, 'react-v2')).world.definition.governingConfigVersion).toBe(2)
      expect(await rows(a.world.id)).toEqual([[1, 1], [2, 2], [3, 3], [4, 2]])
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('records the same verdicts and the same city whatever order pinned launches are redeemed in', async () => {
      const permutations = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])))
      const { p, s, open } = await setup()
      const orders = permutations([2, 3, 4, 5])
      const outcomes = new Set<string>()
      for (const [n, order] of orders.entries()) {
        const installation = `01a14800-0000-7000-8000-${String(0x100 + n).padStart(12, '0')}`
        p.install(installation, String(910000000000000000n + BigInt(n)))
        p.publish(installation, DOC_A)
        const founded = await open(installation, `found-${n}`)
        // Each version is published, and a run pinned to it issued, while it is the active one.
        const tokens = new Map<number, string>()
        for (const [version, document] of [
          [2, { ...DOC_A, cityName: 'Presentation only' }],
          [3, WITH_GULLS],
          [4, { ...DOC_A, cityName: 'Without gulls' }],
          [5, { ...DOC_A, districts: [...DOC_A.districts].reverse() }],
        ] as const) {
          p.publish(installation, document)
          tokens.set(version, p.launch(installation, `p${n}-v${version}`))
        }
        const answers: string[] = []
        for (const version of order) {
          const opened = await s.open({ runToken: tokens.get(version)! }).then(
            (o) => `v${version}:drawn:governed-by-v${o.world.definition.governingConfigVersion}`,
            (e: PlayLaunchError) => `v${version}:${e.code}`,
          )
          answers.push(opened)
        }
        outcomes.add(JSON.stringify({ verdicts: await verdicts(founded.world.id), answers: answers.sort(), adoptions: await rows(founded.world.id) }))
      }
      expect(orders).toHaveLength(24)
      // One outcome for all 24 orders: every compatible version accepted, the one that moves the districts rejected,
      // nothing adopted (Play's active version, 5, cannot govern), and the city still governed by version 1.
      expect([...outcomes].map((o) => JSON.parse(o))).toEqual([
        {
          verdicts: [
            { version: 1, verdict: 'accepted', code: null },
            { version: 2, verdict: 'accepted', code: null },
            { version: 3, verdict: 'accepted', code: null },
            { version: 4, verdict: 'accepted', code: null },
            { version: 5, verdict: 'rejected', code: 'config_incompatible' },
          ],
          answers: ['v2:drawn:governed-by-v1', 'v3:drawn:governed-by-v1', 'v4:drawn:governed-by-v1', 'v5:config_incompatible'],
          adoptions: [[1, 1]],
        },
      ])
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('a stale report of the active version does not adopt it: the earlier P3 race', async () => {
      const hold = holdStore((l) => l.pinned.version === 2)
      const logs: string[] = []
      const { p, s, open } = await setup({ wrapStore: hold.wrap, logs })
      const a = await open(INSTALLATION_A, 'a1')
      p.publish(INSTALLATION_A, { ...DOC_A, cityName: 'Version two' })
      // This launch has heard from Play that version 2 is active, then waits.
      const slow = s.open({ runToken: p.launch(INSTALLATION_A, 'slow-v2') })
      await hold.arrival()
      // The admin goes back to version 1, and a launch of it writes nothing (version 1 already governs).
      p.activate(INSTALLATION_A, 1)
      expect((await open(INSTALLATION_A, 'fast-v1')).world.definition.governingConfigVersion).toBe(1)
      hold.release()
      const late = await slow
      // Drawn as pinned (a compatible presentation), but version 2 is not adopted: Play no longer confirms it.
      expect([late.play.configVersion, late.world.definition.governingConfigVersion]).toEqual([2, 1])
      expect(await rows(a.world.id)).toEqual([[1, 1]])
      expect(logs.some((l) => l.includes('world configuration adoption deferred'))).toBe(true)
      // When Play has version 2 active again, the next launch adopts it.
      p.activate(INSTALLATION_A, 2)
      expect((await open(INSTALLATION_A, 'v2-again')).world.definition.governingConfigVersion).toBe(2)
      expect(await rows(a.world.id)).toEqual([[1, 1], [2, 2]])
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('a stale report cannot turn the city back over a newer adoption either', async () => {
      const hold = holdStore((l) => l.pinned.version === 2)
      const { p, s, open } = await setup({ wrapStore: hold.wrap })
      const a = await open(INSTALLATION_A, 'a1')
      p.publish(INSTALLATION_A, { ...DOC_A, cityName: 'Two' })
      const slow = s.open({ runToken: p.launch(INSTALLATION_A, 'slow-v2') })
      await hold.arrival()
      p.publish(INSTALLATION_A, { ...DOC_A, cityName: 'Three' })
      expect((await open(INSTALLATION_A, 'v3')).world.definition.governingConfigVersion).toBe(3)
      hold.release()
      expect((await slow).world.definition.governingConfigVersion).toBe(3)
      expect(await rows(a.world.id)).toEqual([[1, 1], [2, 3]])
    })

    it('founds nothing on a stale report: the first launch is refused as superseded, and the next founds on what is active', async () => {
      const hold = holdStore((l) => l.pinned.version === 1 && l.installationId === INSTALLATION_A)
      const { p, s, open } = await setup({ wrapStore: hold.wrap })
      const first = s.open({ runToken: p.launch(INSTALLATION_A, 'first') })
      await hold.arrival()
      p.publish(INSTALLATION_A, { ...DOC_A, cityName: 'Two' })
      hold.release()
      expect((await refusal(first)).code).toBe('config_superseded')
      expect(await worldRows()).toEqual({ worlds: 0, world_play_bindings: 0, world_config_versions: 0, world_config_adoptions: 0, city: 0, city_events: 0 })
      const founded = await open(INSTALLATION_A, 'second')
      expect(founded.world.definition.foundingConfigVersion).toBe(2)
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('asks Play at most once under the lock, within its deadline; silence adopts and founds nothing, and the lock is released', async () => {
      let silent = false
      const asked: string[] = []
      const wrapPlay = (play: PlayGameReader): PlayGameReader => ({
        ...play,
        getInstallation: async (id) => {
          asked.push(id)
          // The launch path's own read answers; the store's confirmation goes unanswered while `silent`.
          if (silent && asked.length % 2 === 0) return new Promise(() => undefined)
          return play.getInstallation(id)
        },
      })
      const { p, open } = await setup({ wrapPlay, activeConfirmMs: 100 })
      const a = await open(INSTALLATION_A, 'a1')
      expect(asked).toEqual([INSTALLATION_A, INSTALLATION_A])
      // A launch that adopts nothing asks Play nothing under the lock.
      await open(INSTALLATION_A, 'a2')
      expect(asked).toHaveLength(3)
      p.publish(INSTALLATION_A, { ...DOC_A, cityName: 'Two' })
      silent = true
      asked.length = 0
      const started = Date.now()
      const late = await open(INSTALLATION_A, 'unconfirmed')
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(asked).toHaveLength(2)
      expect(late.world.definition.governingConfigVersion).toBe(1)
      expect(await rows(a.world.id)).toEqual([[1, 1]])
      // The city row is not left locked.
      const probe = await t.db.connect()
      try {
        await probe.query('BEGIN')
        await probe.query(`SET LOCAL lock_timeout = '1s'`)
        await probe.query('SELECT 1 FROM city WHERE id = $1 FOR UPDATE', [`world:${a.world.id}`])
        await probe.query('ROLLBACK')
      } finally {
        probe.release()
      }
      // Founding: an installation whose confirmation goes unanswered founds nothing.
      asked.length = 0
      expect((await refusal(open(INSTALLATION_B, 'b-unconfirmed'))).code).toBe('config_superseded')
      expect(await count('world_play_bindings', 'play_installation_id = $1', [INSTALLATION_B])).toBe(0)
      silent = false
      expect((await open(INSTALLATION_B, 'b-confirmed')).world.created).toBe(true)
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('adopts exactly once, with one confirmation, when many launches of a newly active version race', async () => {
      let confirmations = 0
      const wrapPlay = (play: PlayGameReader): PlayGameReader => ({ ...play, getInstallation: async (id) => (confirmations++, play.getInstallation(id)) })
      const { p, s, open } = await setup({ wrapPlay })
      const a = await open(INSTALLATION_A, 'a1')
      p.publish(INSTALLATION_A, WITH_GULLS)
      confirmations = 0
      const opened = await Promise.all(Array.from({ length: 10 }, (_, i) => s.open({ runToken: p.launch(INSTALLATION_A, `race-${i}`) })))
      expect(opened.every((o) => o.world.definition.governingConfigVersion === 2)).toBe(true)
      // Ten reads by the launch path, and one confirmation by the one launch that adopted.
      expect(confirmations).toBe(11)
      expect(await rows(a.world.id)).toEqual([[1, 1], [2, 2]])
    })
  })

  describe('fails closed', () => {
    it('founds nothing from an invalid first configuration', async () => {
      const { p, open } = await setup()
      p.publish(INSTALLATION_A, { ...DOC_A, camera: { zoom: 3 } })
      expect((await refusal(open(INSTALLATION_A, 'bad'))).code).toBe('config_invalid')
      expect(await worldRows()).toEqual({ worlds: 0, world_play_bindings: 0, world_config_versions: 0, world_config_adoptions: 0, city: 0, city_events: 0 })
    })

    it('founds nothing from a run pinned to a version that is no longer active, then founds on the next launch', async () => {
      const { p, open, s } = await setup()
      const stale = p.launch(INSTALLATION_A, 'stale')
      p.publish(INSTALLATION_A, { ...DOC_A, districts: [...DOC_A.districts].reverse() })
      const err = await refusal(s.open({ runToken: stale }))
      expect([err.status, err.code]).toEqual([409, 'config_superseded'])
      expect(await count('worlds')).toBe(0)
      const fresh = await open(INSTALLATION_A, 'fresh')
      expect(fresh.world).toMatchObject({ created: true, definition: { foundingConfigVersion: 2 } })
    })

    it('never founds a second city for a Discord server bound to another installation', async () => {
      const { p, open } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      // Play shows a different installation on the same server (a reinstall Play did not keep, or a Play database reset).
      p.install(INSTALLATION_C, GUILD_A)
      p.publish(INSTALLATION_C, DOC_A)
      const err = await refusal(open(INSTALLATION_C, 'c1'))
      expect([err.status, err.code]).toEqual([409, 'world_binding_conflict'])
      expect(await count('worlds')).toBe(1)
      expect((await open(INSTALLATION_A, 'a2')).world.id).toBe(a.world.id)
    })

    it('refuses an installation that Play now reports on another Discord server', async () => {
      const { p, open } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      const before = await worldSnapshot(a.world.id)
      p.tamper.run = { discordGuildId: '900000000000000009' }
      p.tamper.installation = { discordGuildId: '900000000000000009' }
      expect((await refusal(open(INSTALLATION_A, 'moved'))).code).toBe('world_binding_conflict')
      expect(await worldSnapshot(a.world.id)).toEqual(before)
    })

    it('refuses a version Play serves with a different hash than the world recorded', async () => {
      const { p, open } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      const before = await worldSnapshot(a.world.id)
      // Play's versions are immutable; a version 1 that comes back different is not the one this world saw.
      p.install(INSTALLATION_A, GUILD_A)
      p.publish(INSTALLATION_A, { ...DOC_A, cityName: 'Rewritten History' })
      const err = await refusal(open(INSTALLATION_A, 'rewritten'))
      expect([err.status, err.code]).toEqual([502, 'config_binding_mismatch'])
      expect(await worldSnapshot(a.world.id)).toEqual(before)
    })

    it('refuses to write when the database belongs to another environment, or Play to another', async () => {
      const staged = await setup({ mode: 'local', storeMode: 'staging', environment: 'staging' })
      const err = await refusal(staged.open(INSTALLATION_A, 'a1'))
      // The store refuses before writing anything; the database's binding guard would refuse the binding too.
      expect([err.code, err.message]).toEqual(['world_unavailable', 'the database is stamped "local", not "staging"'])
      expect(await worldRows()).toEqual({ worlds: 0, world_play_bindings: 0, world_config_versions: 0, world_config_adoptions: 0, city: 0, city_events: 0 })
    })

    it('refuses a Play environment the deployment does not serve', async () => {
      const wrong = await setup({ mode: 'local', environment: 'live' })
      expect((await refusal(wrong.open(INSTALLATION_A, 'a1'))).code).toBe('world_unavailable')
      expect(await count('worlds')).toBe(0)
    })

    for (const step of ['city', 'event', 'world', 'binding', 'version', 'adopted'] as const) {
      it(`leaves nothing behind when founding fails after "${step}", and founds cleanly next time`, async () => {
        let fail = true
        const { open } = await setup({
          onFoundingStep: (at) => {
            if (fail && at === step) throw new Error(`injected failure at ${at}`)
          },
        })
        const err = await refusal(open(INSTALLATION_A, 'a1'))
        expect(err.code).toBe('world_unavailable')
        expect(await worldRows()).toEqual({ worlds: 0, world_play_bindings: 0, world_config_versions: 0, world_config_adoptions: 0, city: 0, city_events: 0 })
        fail = false
        expect((await open(INSTALLATION_A, 'a2')).world.created).toBe(true)
        expect((await verifyCity(t.db)).ok).toBe(true)
      })
    }

    it('refuses to open a world whose stored city this build cannot read, and draws nothing', async () => {
      const { open } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      await unguarded(t.db, () => t.db.query(`UPDATE city SET state = '{"version":1,"buildings":{"b-1":{}},"openWards":{}}' WHERE id = $1`, [`world:${a.world.id}`]))
      expect((await refusal(open(INSTALLATION_A, 'a2'))).code).toBe('world_unavailable')
    })
  })

  describe('beside the Rare Friends city', () => {
    it('leaves the legacy city, its events and its verification exactly as they were', async () => {
      const { open } = await setup()
      await installDemoFixture(t.db, 'local')
      const legacy = async () => ({ city: await snapshot(t.db, `(SELECT id, instance_id, sequence, state::text AS state, updated_at FROM city WHERE id = 'main') x`, 'id'), events: await snapshot(t.db, `(SELECT * FROM city_events WHERE city_id = 'main') x`, 'sequence') })
      const before = await legacy()
      const reportBefore = await verifyCity(t.db)
      expect(reportBefore).toMatchObject({ ok: true, city: { id: 'main', mode: 'demo-fixture' }, worlds: [] })
      const a = await open(INSTALLATION_A, 'a1')
      await open(INSTALLATION_B, 'b1')
      await open(INSTALLATION_A, 'a2')
      expect(await legacy()).toEqual(before)
      const reportAfter = await verifyCity(t.db)
      expect(reportAfter.ok).toBe(true)
      expect({ city: reportAfter.city, counts: reportAfter.counts }).toEqual({ city: reportBefore.city, counts: reportBefore.counts })
      expect(reportAfter.worlds.map((w) => w.id)).toContain(a.world.id)
    })
  })

  describe('in staging and production', () => {
    it('founds a staging world bound to staging Play', async () => {
      const { open } = await setup({ mode: 'staging' })
      const a = await open(INSTALLATION_A, 'a1')
      expect((await t.db.query('SELECT play_environment FROM world_play_bindings')).rows).toEqual([{ play_environment: 'staging' }])
      expect((await verifyCity(t.db)).worlds[0]).toMatchObject({ id: a.world.id, play: { environment: 'staging' } })
    })

    it('founds a production world on a canonical genesis city bound to live Play', async () => {
      const { open } = await setup({ mode: 'production' })
      const a = await open(INSTALLATION_A, 'a1')
      expect((await t.db.query('SELECT canonical, origin, activation_rehearsal FROM city WHERE id = $1', [`world:${a.world.id}`])).rows).toEqual([{ canonical: true, origin: 'genesis', activation_rehearsal: false }])
      expect((await t.db.query('SELECT play_environment FROM world_play_bindings')).rows).toEqual([{ play_environment: 'live' }])
      expect((await verifyCity(t.db)).ok).toBe(true)
    })
  })

  describe('city:verify sees every world', () => {
    /** Change rows the way a bug or a hand edit would: with every guard of every table involved switched off. */
    async function tamper(sql: string, params: unknown[] = []) {
      const tables = ['app_meta', 'city', 'city_events', ...WORLD_TABLES]
      for (const table of tables) await t.db.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
      try {
        await t.db.query(sql, params)
      } finally {
        for (const table of tables) await t.db.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`)
      }
    }
    async function founded() {
      const { open } = await setup()
      const a = await open(INSTALLATION_A, 'a1')
      const b = await open(INSTALLATION_B, 'b1')
      expect((await verifyCity(t.db)).ok).toBe(true)
      return { a: a.world.id, b: b.world.id }
    }
    const failing = async () => {
      const report = await verifyCity(t.db)
      expect(report.ok).toBe(false)
      return report.violations.map((v) => `${v.category}/${v.rule}`)
    }

    it('verifies a database from before migration 0005 exactly as it always did', async () => {
      const dir = await t.migrationsPlus([])
      const { readdir, rm } = await import('node:fs/promises')
      for (const f of await readdir(dir)) if (Number(f.slice(0, 4)) >= 5) await rm(`${dir}/${f}`)
      await migrate(t.db, { dir, environment: 'staging' })
      await installDemoFixture(t.db, 'staging')
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, city: { id: 'main', mode: 'demo-fixture' }, worlds: [], violations: [] })
    })

    const corruptions: [string, (ids: { a: string; b: string }) => Promise<unknown>, string][] = [
      ['a configuration copy that is not Play\'s canonical text (though it hashes)', ({ a }) => tamper(`UPDATE world_config_versions SET config_canonical = config_canonical || ' ', config_hash = encode(sha256(convert_to(config_canonical || ' ', 'UTF8')), 'hex') WHERE world_id = $1`, [a]), 'worlds/configs'],
      ['an accepted copy that would move the districts', ({ a }) => tamper(`INSERT INTO world_config_versions (world_id, version, play_installation_id, schema_version, config_hash, config_canonical, verdict, judged_by) VALUES ($1, 2, $2, 1, $3, $4, 'accepted', 'hand')`, [a, INSTALLATION_A, sha256(canonical({ ...DOC_A, districts: [...DOC_A.districts].reverse() })), canonical({ ...DOC_A, districts: [...DOC_A.districts].reverse() })]), 'worlds/geometry'],
      ['an accepted copy that drops a founding collection', ({ a }) => tamper(`INSERT INTO world_config_versions (world_id, version, play_installation_id, schema_version, config_hash, config_canonical, verdict, judged_by) VALUES ($1, 2, $2, 1, $3, $4, 'accepted', 'hand')`, [a, INSTALLATION_A, sha256(canonical(DROPPED)), canonical(DROPPED)]), 'worlds/collections'],
      ['a rejected copy without a reason', ({ a }) => tamper(`INSERT INTO world_config_versions (world_id, version, play_installation_id, schema_version, config_hash, config_canonical, verdict, rejection, judged_by) VALUES ($1, 2, $2, 1, $3, $4, 'rejected', '{}', 'hand')`, [a, INSTALLATION_A, sha256(canonical(DOC_A)), canonical(DOC_A)]), 'worlds/configs'],
      ['a world city that has advanced past what this build supports', ({ a }) => tamper(`WITH c AS (UPDATE city SET sequence = 2 WHERE id = $1 RETURNING id) INSERT INTO city_events (city_id, sequence, type) SELECT id, 2, 'test.advance' FROM c`, [`world:${a}`]), 'worlds/state'],
      ['a world city holding a building', ({ a }) => tamper(`UPDATE city SET state = '{"version":1,"buildings":{"b-1":{}},"openWards":{}}' WHERE id = $1`, [`world:${a}`]), 'worlds/state'],
      ['a founding record naming another installation', ({ a }) => tamper(`UPDATE city_events SET payload = jsonb_set(payload, '{world,play,installationId}', to_jsonb($2::text)) WHERE city_id = $1`, [`world:${a}`, INSTALLATION_B]), 'worlds/founding'],
      ['a founding record naming another world', ({ a, b }) => tamper(`UPDATE city_events SET payload = jsonb_set(payload, '{world,id}', to_jsonb($2::text)) WHERE city_id = $1`, [`world:${a}`, b]), 'worlds/founding'],
      ['a founding record with a foundation it was not founded on', ({ a }) => tamper(`UPDATE city_events SET payload = jsonb_set(payload, '{world,foundation,collections,0,key}', '"other"') WHERE city_id = $1`, [`world:${a}`]), 'worlds/foundation'],
      ['a binding to a Play environment this database does not serve', () => tamper(`UPDATE app_meta SET value = 'staging' WHERE key = 'environment'`), 'worlds/environment'],
      ['a production stamp over worlds founded as rehearsals', () => tamper(`UPDATE app_meta SET value = 'production' WHERE key = 'environment'`), 'worlds/city'],
      ['a city row that is neither the Rare Friends city nor a world\'s', () => tamper(`INSERT INTO city (id, canonical, origin, state_version, sequence, state) VALUES ('stray', false, 'demo-fixture', 1, 1, '{"version":1,"buildings":{},"openWards":{}}')`), 'city/unknown-city'],
      ['events of no known city', () => tamper(`WITH c AS (INSERT INTO city (id, canonical, origin, state_version, sequence, state) VALUES ('stray', false, 'demo-fixture', 1, 1, '{"version":1,"buildings":{},"openWards":{}}') RETURNING id) INSERT INTO city_events (city_id, sequence, type) SELECT id, 1, 'city.initialized' FROM c`), 'events/orphan-events'],
      ['a first adoption that is not the founding version', ({ a }) => tamper(`WITH v AS (INSERT INTO world_config_versions (world_id, version, play_installation_id, schema_version, config_hash, config_canonical, verdict, judged_by) VALUES ($1, 2, $2, 1, $3, $4, 'accepted', 'hand') RETURNING world_id) UPDATE world_config_adoptions SET version = 2 WHERE world_id = $1`, [a, INSTALLATION_A, sha256(canonical({ ...DOC_A, cityName: 'X' })), canonical({ ...DOC_A, cityName: 'X' })]), 'worlds/adoptions'],
      ['an adoption that drops a collection an earlier adoption established', async ({ a }) => {
        const v2 = canonical(WITH_GULLS)
        const v3 = canonical({ ...DOC_A, cityName: 'Gulls gone' })
        await tamper(`INSERT INTO world_config_versions (world_id, version, play_installation_id, schema_version, config_hash, config_canonical, verdict, judged_by) VALUES ($1, 2, $2, 1, $3, $4, 'accepted', 'hand'), ($1, 3, $2, 1, $5, $6, 'accepted', 'hand')`, [a, INSTALLATION_A, sha256(v2), v2, sha256(v3), v3])
        await tamper('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) VALUES ($1, 2, 2), ($1, 3, 3)', [a])
      }, 'worlds/adoptions'],
      ['an adoption of the version that already governs', ({ a }) => tamper('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) VALUES ($1, 2, 1)', [a]), 'worlds/adoptions'],
      ['a founding record of a canonical genesis city on a rehearsal row', ({ a }) => tamper(`UPDATE city_events SET payload = payload || '{"origin":"genesis","canonical":true}' WHERE city_id = $1`, [`world:${a}`]), 'worlds/founding'],
      ['a founding record without the rehearsal flag its row has', ({ a }) => tamper(`UPDATE city_events SET payload = payload - 'activationRehearsal' WHERE city_id = $1`, [`world:${a}`]), 'worlds/founding'],
      ['a founding record of another environment', ({ a }) => tamper(`UPDATE city_events SET payload = jsonb_set(payload, '{environment}', '"production"') WHERE city_id = $1`, [`world:${a}`]), 'worlds/founding'],
      ['a founding record of another state version', ({ a }) => tamper(`UPDATE city_events SET payload = jsonb_set(payload, '{stateVersion}', '2') WHERE city_id = $1`, [`world:${a}`]), 'worlds/founding'],
      ['a founding record of another configuration schema version', ({ a }) => tamper(`UPDATE city_events SET payload = jsonb_set(payload, '{world,foundingConfig,schemaVersion}', '7') WHERE city_id = $1`, [`world:${a}`]), 'worlds/founding'],
      ['a founding record naming no configuration schema version', ({ a }) => tamper(`UPDATE city_events SET payload = payload #- '{world,foundingConfig,schemaVersion}' WHERE city_id = $1`, [`world:${a}`]), 'worlds/founding'],
      ['a rejected copy this build\'s rules accept', ({ a }) => tamper(`INSERT INTO world_config_versions (world_id, version, play_installation_id, schema_version, config_hash, config_canonical, verdict, rejection, judged_by) VALUES ($1, 2, $2, 1, $3, $4, 'rejected', '{"code":"config_incompatible","problems":[]}', $5)`, [a, INSTALLATION_A, sha256(canonical({ ...DOC_A, cityName: 'Fine' })), canonical({ ...DOC_A, cityName: 'Fine' }), WORLD_CONFIG_JUDGE]), 'worlds/verdict'],
      ['a rejected copy recorded with another reason than this build\'s rules give', ({ a }) => tamper(`INSERT INTO world_config_versions (world_id, version, play_installation_id, schema_version, config_hash, config_canonical, verdict, rejection, judged_by) VALUES ($1, 2, $2, 1, $3, $4, 'rejected', '{"code":"config_invalid","problems":[]}', $5)`, [a, INSTALLATION_A, sha256(canonical(DROPPED)), canonical(DROPPED), WORLD_CONFIG_JUDGE]), 'worlds/verdict'],
    ]
    for (const [label, corrupt, expected] of corruptions) {
      it(`reports ${label}`, async () => {
        const ids = await founded()
        await corrupt(ids)
        expect(await failing()).toContain(expected)
      })
    }

    it('passes accepted copies that never governed, even ones that drop or rename a non-founding collection', async () => {
      const { p, open } = await setup()
      await open(INSTALLATION_A, 'a1')
      p.publish(INSTALLATION_A, WITH_GULLS)
      await open(INSTALLATION_A, 'a2')
      p.publish(INSTALLATION_A, DOC_A)
      await refusal(open(INSTALLATION_A, 'a3'))
      p.publish(INSTALLATION_A, { ...DOC_A, collections: [...DOC_A.collections, { ...GULLS, contract: '0x000000000000000000000000000000000000b009' }] })
      await refusal(open(INSTALLATION_A, 'a4'))
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, violations: [], worlds: [{ configVersions: { accepted: 4, rejected: 0 }, governingConfigVersion: 2 }] })
    })

    it('reports a world without its binding and a world whose city is missing, without stopping', async () => {
      const { a, b } = await founded()
      await tamper('DELETE FROM world_config_adoptions WHERE world_id = $1', [a])
      await tamper('DELETE FROM world_config_versions WHERE world_id = $1', [a])
      await tamper('DELETE FROM world_play_bindings WHERE world_id = $1', [a])
      await tamper('ALTER TABLE worlds DROP CONSTRAINT worlds_city')
      await tamper('DELETE FROM city_events WHERE city_id = $1', [`world:${b}`])
      await tamper('DELETE FROM city WHERE id = $1', [`world:${b}`])
      const rules = await failing()
      expect(rules).toContain('worlds/binding')
      expect(rules).toContain('worlds/city')
    })
  })
})
