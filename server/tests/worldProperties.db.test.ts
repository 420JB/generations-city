import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { uuidV8FromText } from '../../src/world/property'
import { verifyCity } from '../src/city/verify'
import type { AppMode } from '../src/config'
import { migrate } from '../src/db/migrations'
import { createPool } from '../src/db/pool'
import { nftAsset, proposePropertyActivation, worldCityStateText, type NftAsset, type PlayEnvironment } from '../src/engine'
import { installDemoFixture } from '../src/fixtures/demoCity'
import { silentLogger } from '../src/log'
import { createPlayLaunchService } from '../src/play/launch'
import { createPlaySessionService, createPlaySessionStore, PlaySessionError, type OpenedPlaySession } from '../src/play/session'
import { createPropertyActivationService, createWorldPropertyStore, worldPropertiesOf, WorldPropertyRefusal, type ActivationStep, type PropertyActivationResult } from '../src/world/properties'
import { createWorldStore, lockWorldForChange } from '../src/world/store'
import { addIdentity, snapshot } from './activationFixtures'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema, withPre0008StandIns } from './dbHarness'
import { ADA, BEA, fakePlay, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'

const INSTALLATION_C = '01a14800-0000-7000-8000-00000000000c'
const GUILD_C = '900000000000000003'
const PLAY_ENV: Record<AppMode, PlayEnvironment> = { local: 'dev', staging: 'staging', production: 'live' }
const contract = (n: number) => `0x${'0'.repeat(36)}${n.toString(16).padStart(4, '0')}`
const district = (key: string) => ({ key, name: key.replace(/-/g, ' '), accent: '#5aa9ff', monument: null, proofyRule: null })
/** Four districts, two collections on two chains. */
const DOC_4 = {
  cityName: 'Harborlight',
  brand: { name: 'Harborlight', logo: null },
  capital: { name: 'Beacon Hall', crest: null },
  collections: [
    { key: 'harbor-keepers', chain: 'eip155:8453', contract: contract(0xa001), displayName: 'Harbor Keepers' },
    { key: 'tide-pass', chain: 'eip155:1', contract: contract(0xa002), displayName: 'Tide Pass' },
  ],
  districts: ['lantern-quay', 'tidewater', 'saltmarsh', 'compass-row'].map(district),
}
/** Six districts, three collections on three chains. */
const DOC_6 = {
  ...DOC_4,
  cityName: 'Neon Orchard',
  collections: [
    { key: 'orchard-sprites', chain: 'eip155:8453', contract: contract(0xb001), displayName: 'Orchard Sprites' },
    { key: 'neon-seeds', chain: 'eip155:42161', contract: contract(0xb002), displayName: 'Neon Seeds' },
    { key: 'grove-pass', chain: 'eip155:1', contract: contract(0xb003), displayName: 'Grove Pass' },
  ],
  districts: ['plum', 'citrus', 'fig', 'pear', 'kiwi', 'cherry'].map(district),
}
const keeper = (id: number | string) => ({ chain: 'eip155:8453', contract: contract(0xa001), tokenId: String(id) })
const tide = (id: number | string) => ({ chain: 'eip155:1', contract: contract(0xa002), tokenId: String(id) })
const sprite = (id: number | string) => ({ chain: 'eip155:8453', contract: contract(0xb001), tokenId: String(id) })
const seed = (id: number | string) => ({ chain: 'eip155:42161', contract: contract(0xb002), tokenId: String(id) })
const grove = (id: number | string) => ({ chain: 'eip155:1', contract: contract(0xb003), tokenId: String(id) })
const asNft = (a: { chain: string; contract: string; tokenId: string }): NftAsset => nftAsset(a)!

/** Every table a world's gameplay touches, as rows. */
const TABLES = {
  app_meta: 'key',
  city: 'id',
  city_events: 'city_id, sequence',
  worlds: 'id',
  world_play_bindings: 'world_id',
  world_config_versions: 'world_id, version',
  world_config_geometries: 'world_id, version',
  world_config_adoptions: 'world_id, adoption_seq',
  world_geometry_freezes: 'world_id',
  world_properties: 'id',
}
/** Tables with guards a corruption test switches off. */
const GUARDED = ['city', 'city_events', 'world_properties']

async function refusalOf(work: Promise<unknown>): Promise<string> {
  const err = await work.then(
    () => null,
    (e: unknown) => e,
  )
  if (err instanceof WorldPropertyRefusal || err instanceof PlaySessionError) return err.code
  throw err ?? new Error('expected a refusal, got success')
}

describe.skipIf(NO_TEST_DATABASE)('world properties (migration 0007) against a disposable Postgres', () => {
  const t = useTestSchema()
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  async function migrationsThrough(last: number): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'rc-world-properties-'))
    dirs.push(dir)
    for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()) if (Number(file.slice(0, 4)) <= last) await copyFile(join(MIGRATIONS_DIR, file), join(dir, file))
    return dir
  }

  /** Play with installations A (four districts) and B (six), the real launch path, world store, session service and property store. */
  async function setup(options: { mode?: AppMode; migrated?: boolean; db?: pg.Pool; onStep?: (step: ActivationStep) => void | Promise<void>; play?: ReturnType<typeof fakePlay>; now?: () => Date } = {}) {
    const mode = options.mode ?? 'local'
    const db = options.db ?? t.db
    if (!options.migrated) await migrate(db, { dir: MIGRATIONS_DIR, environment: mode })
    const p = options.play ?? fakePlay()
    if (!options.play) {
      p.install(INSTALLATION_A, GUILD_A)
      p.install(INSTALLATION_B, GUILD_B)
      p.install(INSTALLATION_C, GUILD_C)
      p.publish(INSTALLATION_A, DOC_4)
      p.publish(INSTALLATION_B, DOC_6)
      p.publish(INSTALLATION_C, DOC_4)
    }
    const environment = PLAY_ENV[mode]
    const worlds = createWorldStore(db, { mode, log: silentLogger })
    const launch = createPlayLaunchService({ play: p.play, environment, gameKey: 'rare-city', worlds })
    const sessions = createPlaySessionService({ store: createPlaySessionStore(db), worlds, play: p.play, environment, gameKey: 'rare-city', log: silentLogger, installationCacheMs: 0, now: options.now })
    const store = createWorldPropertyStore(db, { mode, log: silentLogger, onStep: options.onStep })
    const activation = createPropertyActivationService({ sessions, store })
    let runs = 0
    /** As POST /v1/play/session does; `presented` is the cookie the browser arrives with. */
    const open = async (installation: string, player = ADA, presented: string | null = null, runExpiresAt?: string) =>
      sessions.open(await launch.open({ runToken: p.launch(installation, `run-${installation.slice(-1)}-${++runs}-${randomUUID()}`, { player, runExpiresAt }) }), presented)
    const actorOf = (o: OpenedPlaySession) => ({ sessionRef: o.response.viewer.session.ref, worldId: o.response.world.id, discordUserId: o.response.viewer.player.discordUserId })
    const activate = (o: OpenedPlaySession, asset: { chain: string; contract: string; tokenId: string }, plotId: string): Promise<PropertyActivationResult> => activation.activate(o.token, actorOf(o), { asset, plotId })
    const read = async (o: OpenedPlaySession) => sessions.city(await sessions.session(o.token))
    return { p, worlds, launch, sessions, store, activation, open, actorOf, activate, read }
  }

  const rows = async (db: pg.Pool = t.db) => Object.fromEntries(await Promise.all(Object.entries(TABLES).map(async ([table, order]) => [table, await snapshot(db, table, order)])))
  const count = async (table: string, where = 'true', params: unknown[] = []) => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n
  async function inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>, db: pg.Pool = t.db): Promise<T> {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const out = await work(client)
      await client.query('COMMIT')
      return out
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
  async function unguarded<T>(work: () => Promise<T>): Promise<T> {
    for (const table of GUARDED) await t.db.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
    try {
      return await work()
    } finally {
      for (const table of GUARDED) await t.db.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`)
    }
  }

  /**
   * Write an activation by hand, as the store does, with one thing changed. Proves the DATABASE refuses it, whatever
   * the service would have done.
   */
  async function rawActivate(
    o: OpenedPlaySession,
    asset: NftAsset,
    plotId: string,
    tweak: {
      state?: (s: Record<string, unknown>) => unknown
      event?: (e: Record<string, unknown>) => unknown
      /** The geometry freeze a world's first property writes (0008), as the store writes it. */
      freeze?: (f: Record<string, unknown>) => Record<string, unknown> | null
      row?: (r: Record<string, unknown>) => Record<string, unknown>
      skipProperty?: boolean
      /** Write it as 0007 did, on a schema before 0008: no freeze, no original activator. */
      pre0008?: boolean
      db?: pg.Pool
    } = {},
  ) {
    const scope = { worldId: o.response.world.id, environment: o.response.play.environment, gameKey: o.response.play.gameKey, installationId: o.response.play.installationId, discordGuildId: o.response.play.discordGuildId }
    return inTransaction(async (client) => {
      const locked = await lockWorldForChange(client, scope)
      const proposed = proposePropertyActivation(locked.world, locked.state, locked.sequence, { asset, plotId })
      if (!proposed.ok) throw new Error(proposed.reason)
      const tr = proposed.transition
      const state = tweak.state ? tweak.state(structuredClone(tr.state) as never) : tr.state
      await client.query('UPDATE city SET state = $1::json, state_version = 2, sequence = $2 WHERE id = $3', [JSON.stringify(state), tr.to, locked.cityId])
      const event = { ...tr.event, configVersion: locked.governingVersion, adoption: locked.governingAdoption }
      await client.query(`INSERT INTO city_events (city_id, sequence, type, payload) VALUES ($1, $2, 'world.property.activated', $3::jsonb)`, [locked.cityId, tr.to, JSON.stringify(tweak.event ? tweak.event(event) : event)])
      if (!locked.freeze && !tweak.pre0008) {
        const g = (await client.query('SELECT layout_key, layout_geometry_fingerprint, districts FROM world_config_geometries WHERE world_id = $1 AND version = $2', [scope.worldId, locked.governingVersion])).rows[0]
        const base = { world_id: scope.worldId, city_id: locked.cityId, frozen_at_sequence: tr.to, adoption_seq: locked.governingAdoption, config_version: locked.governingVersion, ...g, districts: JSON.stringify(g.districts), frozen_by: 'first-property' }
        const freeze = tweak.freeze ? tweak.freeze(base) : base
        if (freeze) {
          const cols = Object.keys(freeze)
          await client.query(`INSERT INTO world_geometry_freezes (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(freeze))
        }
      }
      if (tweak.skipProperty) return
      const base: Record<string, unknown> = {
        id: tr.property.propertyId,
        world_id: scope.worldId,
        city_id: locked.cityId,
        city_instance_id: locked.instance,
        chain: asset.chain,
        standard: asset.standard,
        contract: asset.contract,
        token_id: asset.tokenId,
        collection_key: tr.property.collection.key,
        district_key: tr.plot.districtKey,
        ward: tr.plot.ward,
        plot: tr.plot.plot,
        plot_id: tr.plot.plotId,
        building_id: tr.property.buildingId,
        district_geometry_fingerprint: tr.districtGeometryFingerprint,
        activated_sequence: tr.to,
        activated_adoption_seq: locked.governingAdoption,
        activated_config_version: locked.governingVersion,
        activated_in_play_session: o.response.viewer.session.ref,
        ...(tweak.pre0008 ? {} : { activator_core_user_id: o.response.viewer.player.coreUserId, activator_discord_user_id: o.response.viewer.player.discordUserId }),
      }
      const row = tweak.row ? tweak.row(base) : base
      const cols = Object.keys(row)
      await client.query(`INSERT INTO world_properties (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row))
    }, tweak.db)
  }

  describe('an installed city', () => {
    it('stays empty: no property and no seeded building, every district offering exactly its founding ward', async () => {
      const { open, read } = await setup()
      const a = await open(INSTALLATION_A)
      const b = await open(INSTALLATION_B)
      for (const [o, n] of [[a, 4], [b, 6]] as const) {
        expect(o.response.world).toMatchObject({ created: true, sequence: 1, state: { version: 1, buildings: {}, openWards: {} } })
        expect(o.response.world.districts).toHaveLength(n)
        for (const d of o.response.world.districts) {
          expect(d.openWards).toBe(1)
          expect(d.wards).toEqual([{ ward: 0, capacity: d.candidates.plotIds.length, occupied: 0 }])
          expect(d.candidates).toEqual({ plotIds: Array.from({ length: d.wards[0].capacity }, (_, i) => `${d.key}-w0-p${i}`), newWard: false })
          expect(d.spanDeg).toBe(360 / n)
        }
        const again = await read(o)
        expect(again.world).toEqual({ ...o.response.world, created: false })
      }
      // Relaunching changes nothing: nothing is seeded on any later launch either.
      const before = await rows()
      expect((await open(INSTALLATION_A)).response.world.sequence).toBe(1)
      expect(await rows()).toEqual(before)
      expect(await count('world_properties')).toBe(0)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ sequence: 1, properties: 0 }, { sequence: 1, properties: 0 }] })
    })
  })

  describe('property identity', () => {
    it('is derived by the database exactly as the engine derives it (golden vector and random vectors)', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
      const golden = (await t.db.query<{ id: string }>(`SELECT world_property_id_v2('01890a5d-ac96-774b-bcce-b302099a8057', $1)::text AS id`, [`eip155:8453/erc721:0x${'a1'.repeat(20)}/812`])).rows[0].id
      expect(golden).toBe('cc965359-c42b-8708-8d24-70c89a5d34fe')
      for (let i = 0; i < 64; i++) {
        const world = randomUUID()
        const asset = `eip155:${1 + i}/erc721:0x${randomUUID().replace(/-/g, '').padEnd(40, '7').slice(0, 40)}/${(BigInt(i) ** 40n).toString()}`
        const db = (await t.db.query<{ id: string }>('SELECT world_property_id_v2($1, $2)::text AS id', [world, asset])).rows[0].id
        expect(db).toBe(uuidV8FromText(`proofy-world:property:v2|world=${world}|asset=${asset}`))
      }
    })
  })

  describe('a test-only activation', () => {
    it('advances the city one sequence with its event and its property, and every read shows exactly that', async () => {
      const { open, activate, read } = await setup()
      const a = await open(INSTALLATION_A)
      const result = await activate(a, keeper(812), 'tidewater-w0-p7')
      expect(result).toMatchObject({ fresh: true, sequence: 2, property: { plotId: 'tidewater-w0-p7', collection: 'harbor-keepers', asset: `eip155:8453/erc721:${contract(0xa001)}/812`, sequence: 2, adoption: 1, configVersion: 1, sessionRef: a.response.viewer.session.ref } })
      const id = result.property.id
      const city = (await t.db.query(`SELECT sequence, state_version, state::text AS state FROM city WHERE id = $1`, [`world:${a.response.world.id}`])).rows[0]
      expect(city).toEqual({ sequence: '2', state_version: 2, state: worldCityStateText(result.transition!.state) })
      const event = (await t.db.query(`SELECT type, payload FROM city_events WHERE city_id = $1 AND sequence = 2`, [`world:${a.response.world.id}`])).rows[0]
      expect(event).toEqual({ type: 'world.property.activated', payload: { ...result.transition!.event, configVersion: 1, adoption: 1 } })
      expect(await worldPropertiesOf(t.db, a.response.world.id)).toEqual([result.property])

      const now = await read(a)
      expect(now.world.sequence).toBe(2)
      expect(now.world.state.buildings).toEqual({ [`b-${id}`]: { propertyId: id, asset: result.property.asset, collection: 'harbor-keepers', districtKey: 'tidewater', ward: 0, plot: 7, sequence: 2 } })
      const tidewater = now.world.districts.find((d) => d.key === 'tidewater')!
      expect(tidewater.wards[0].occupied).toBe(1)
      expect(tidewater.candidates.plotIds).not.toContain('tidewater-w0-p7')
      expect(tidewater.candidates.plotIds).toHaveLength(tidewater.wards[0].capacity - 1)
      // A relaunch reads the populated city too (the launch path locks and reads it).
      const relaunch = await open(INSTALLATION_A)
      expect(relaunch.response.world).toMatchObject({ created: false, sequence: 2, state: now.world.state, districts: now.world.districts })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, violations: [], worlds: [{ id: a.response.world.id, sequence: 2, properties: 1 }] })
    })

    it('survives a restart of the service and every connection: same city, same session, same verdict', async () => {
      const first = await setup()
      const a = await first.open(INSTALLATION_A)
      await first.activate(a, keeper(1), 'lantern-quay-w0-p0')
      await first.activate(a, tide(1), 'compass-row-w0-p3')
      const before = await rows()
      // A new pool and new services: nothing in memory survives, only the database.
      const db = createPool(process.env.TEST_DATABASE_URL!, silentLogger, { searchPath: t.schema })
      try {
        const second = await setup({ db, migrated: true, play: first.p })
        const again = await second.read(a)
        expect(again.world.sequence).toBe(3)
        expect(Object.values(again.world.state.buildings).map((b) => [b.districtKey, b.plot, b.collection])).toEqual([
          ['lantern-quay', 0, 'harbor-keepers'],
          ['compass-row', 3, 'tide-pass'],
        ])
        expect(await rows(db)).toEqual(before)
        expect(await verifyCity(db)).toMatchObject({ ok: true, worlds: [{ sequence: 3, properties: 2 }] })
        // And it keeps going from where it was.
        expect((await second.activate(a, keeper(2), 'lantern-quay-w0-p1')).sequence).toBe(4)
      } finally {
        await db.end()
      }
    })
  })

  describe('several collections, several installations', () => {
    it('holds properties of every collection of one city, each with its own id and collection key', async () => {
      const { open, activate } = await setup()
      const b = await open(INSTALLATION_B)
      const out = [await activate(b, sprite(1), 'plum-w0-p0'), await activate(b, seed(1), 'plum-w0-p1'), await activate(b, grove(1), 'cherry-w0-p0'), await activate(b, seed(2), 'kiwi-w0-p4')]
      expect(out.map((r) => r.property.collection)).toEqual(['orchard-sprites', 'neon-seeds', 'grove-pass', 'neon-seeds'])
      expect(new Set(out.map((r) => r.property.id)).size).toBe(4)
      // Token number 1 in three collections on three chains: three properties.
      expect(out.slice(0, 3).map((r) => r.property.asset.split('/')[0])).toEqual(['eip155:8453', 'eip155:42161', 'eip155:1'])
      // A token of a collection the city does not have is not a property of it.
      expect(await refusalOf(activate(b, keeper(1), 'plum-w0-p2'))).toBe('asset-not-in-world')
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ properties: 4, sequence: 5 }] })
    })

    it('keeps installations apart: the same NFT is a different property in each, and no session reaches another world', async () => {
      const { open, activate, activation, actorOf, read } = await setup()
      const a = await open(INSTALLATION_A)
      const c = await open(INSTALLATION_C)
      const b = await open(INSTALLATION_B)
      const inA = await activate(a, keeper(7), 'tidewater-w0-p0')
      const inC = await activate(c, keeper(7), 'tidewater-w0-p0')
      expect(inA.property.id).not.toBe(inC.property.id)
      expect(inA.property.worldId).toBe(a.response.world.id)
      expect(inC.property.worldId).toBe(c.response.world.id)
      // B's plot ids name nothing in A, and A's session cannot act in B, whatever the page claims.
      expect(await refusalOf(activate(a, keeper(8), 'plum-w0-p0'))).toBe('unknown-plot')
      expect(await refusalOf(activation.activate(a.token, { ...actorOf(a), worldId: b.response.world.id }, { asset: sprite(1), plotId: 'plum-w0-p0' }))).toBe('play_actor_mismatch')
      expect(await refusalOf(activation.activate(a.token, actorOf(b), { asset: sprite(1), plotId: 'plum-w0-p0' }))).toBe('play_actor_mismatch')
      expect((await read(b)).world.sequence).toBe(1)
      expect(await count('world_properties', 'world_id = $1', [b.response.world.id])).toBe(0)
      // The database refuses a property of A written into B's city.
      await expect(
        rawActivate(b, asNft(sprite(1)), 'plum-w0-p0', { row: (r) => ({ ...r, world_id: a.response.world.id }) }),
      ).rejects.toThrow(/belongs to its world's own city|violates foreign key/)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })
  })

  describe('idempotency and concurrency', () => {
    it('repeating an activation writes nothing; the same NFT elsewhere, and a taken plot, are refused', async () => {
      const { open, activate } = await setup()
      const a = await open(INSTALLATION_A)
      const first = await activate(a, keeper(1), 'saltmarsh-w0-p2')
      const before = await rows()
      const again = await activate(a, keeper(1), 'saltmarsh-w0-p2')
      expect(again).toEqual({ fresh: false, property: first.property, sequence: 2 })
      expect(await refusalOf(activate(a, keeper(1), 'saltmarsh-w0-p3'))).toBe('asset-already-placed')
      expect(await refusalOf(activate(a, tide(1), 'saltmarsh-w0-p2'))).toBe('plot-unavailable')
      expect(await rows()).toEqual(before)
    })

    it('answers a repeat as success only to the player who activated it; anyone else learns nothing of who, or which session (L2)', async () => {
      const { open, activate, sessions } = await setup()
      const ada = await open(INSTALLATION_A, ADA)
      const bea = await open(INSTALLATION_A, BEA)
      const first = await activate(ada, keeper(1), 'saltmarsh-w0-p2')
      const before = await rows()
      // Another player of the same world, the same NFT on the same plot: refused, and the refusal carries no provenance.
      const err = await activate(bea, keeper(1), 'saltmarsh-w0-p2').then(
        () => null,
        (e: unknown) => e as WorldPropertyRefusal,
      )
      expect(err).toBeInstanceOf(WorldPropertyRefusal)
      expect(err!.code).toBe('asset-already-placed')
      expect(`${err!.message} ${JSON.stringify(err)}`).not.toContain(ada.response.viewer.session.ref)
      // Ada again, from a later launch (a new session): still her property, nothing written.
      const relaunched = await open(INSTALLATION_A, ADA)
      expect(await activate(relaunched, keeper(1), 'saltmarsh-w0-p2')).toMatchObject({ fresh: false, property: { id: first.property.id }, sequence: 2 })
      expect(await rows()).toEqual(before)
      // The original activator is recorded on the property (0008): once the activating session is signed out and its
      // row tidied, Ada is still its activator, and Bea still is not.
      await sessions.logout(ada.token)
      await t.db.query('DELETE FROM play_sessions WHERE id = $1', [ada.response.viewer.session.ref])
      expect(await activate(relaunched, keeper(1), 'saltmarsh-w0-p2')).toMatchObject({ fresh: false, property: { id: first.property.id, activator: { discordUserId: ADA.discordUserId, coreUserId: ADA.coreUserId } } })
      expect(await refusalOf(activate(bea, keeper(1), 'saltmarsh-w0-p2'))).toBe('asset-already-placed')
      expect(await rows()).toEqual(before)
    })

    it('queues concurrent activations on the city: one plot gives exactly one property', async () => {
      const { open, activate } = await setup()
      const a = await open(INSTALLATION_A)
      const n = 12
      const racers = await Promise.allSettled(Array.from({ length: n }, (_, i) => activate(a, keeper(100 + i), 'lantern-quay-w0-p4')))
      const won = racers.filter((r) => r.status === 'fulfilled')
      expect(won).toHaveLength(1)
      expect(racers.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(Array(n - 1).fill('plot-unavailable'))
      // The same NFT on the same plot, many times at once: one activation, the rest see it already done.
      const repeats = await Promise.all(Array.from({ length: n }, () => activate(a, tide(5), 'lantern-quay-w0-p5')))
      expect(repeats.filter((r) => r.fresh)).toHaveLength(1)
      expect(new Set(repeats.map((r) => r.property.id)).size).toBe(1)
      // The same NFT on different plots at once: one plot, the rest refused.
      const spread = await Promise.allSettled(Array.from({ length: n }, (_, i) => activate(a, tide(6), `compass-row-w0-p${i}`)))
      expect(spread.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(new Set(spread.flatMap((r) => (r.status === 'rejected' ? [r.reason.code] : [])))).toEqual(new Set(['asset-already-placed']))
      // Different NFTs on different plots at once: all of them, one sequence each, in some order.
      const all = await Promise.all(Array.from({ length: n }, (_, i) => activate(a, keeper(500 + i), `tidewater-w0-p${i}`)))
      expect(all.map((r) => r.sequence).sort((x, y) => x - y)).toEqual(Array.from({ length: n }, (_, i) => 5 + i))
      expect(await count('world_properties')).toBe(3 + n)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ sequence: 4 + n, properties: 3 + n }] })
    })
  })

  describe('ward progression', () => {
    it('persists: filling the founding ward offers the next, which opens only on a player\'s exact choice in it', async () => {
      const { open, activate, read } = await setup()
      const b = await open(INSTALLATION_B)
      const plum = b.response.world.districts.find((d) => d.key === 'plum')!
      const capacity = plum.wards[0].capacity
      for (let i = 0; i < capacity; i++) await activate(b, sprite(1000 + i), `plum-w0-p${capacity - 1 - i}`)
      const full = (await read(b)).world
      const fullPlum = full.districts.find((d) => d.key === 'plum')!
      expect(fullPlum).toMatchObject({ openWards: 1, wards: [{ ward: 0, capacity, occupied: capacity }], candidates: { newWard: true } })
      expect(fullPlum.candidates.plotIds.every((p) => p.startsWith('plum-w1-'))).toBe(true)
      expect(full.state.openWards).toEqual({})
      expect(await refusalOf(activate(b, grove(1), 'plum-w2-p0'))).toBe('plot-unavailable')
      const opened = await activate(b, grove(1), 'plum-w1-p3')
      expect(opened.transition!.event).toMatchObject({ openedWard: true, openWards: 2, plotId: 'plum-w1-p3' })
      const after = (await read(b)).world
      expect(after.state.openWards).toEqual({ plum: 2 })
      expect(after.districts.find((d) => d.key === 'plum')).toMatchObject({ openWards: 2, candidates: { newWard: false } })
      expect(after.districts.filter((d) => d.key !== 'plum').every((d) => d.openWards === 1 && d.wards[0].occupied === 0)).toBe(true)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ sequence: capacity + 2, properties: capacity + 1 }] })
    })
  })

  describe('who may act', () => {
    it('goes through requireActor every time: a stale page, another player or a silent Play changes nothing', async () => {
      const { p, open, activate, activation, actorOf } = await setup()
      const a = await open(INSTALLATION_A)
      const before = await rows()
      expect(await refusalOf(activation.activate(null, actorOf(a), { asset: keeper(1), plotId: 'tidewater-w0-p0' }))).toBe('play_session_required')
      expect(await refusalOf(activation.activate(a.token, { ...actorOf(a), sessionRef: randomUUID() }, { asset: keeper(1), plotId: 'tidewater-w0-p0' }))).toBe('play_actor_mismatch')
      expect(await refusalOf(activation.activate(a.token, { ...actorOf(a), discordUserId: BEA.discordUserId }, { asset: keeper(1), plotId: 'tidewater-w0-p0' }))).toBe('play_actor_mismatch')
      p.tamper.fail = { method: 'getInstallation', status: 503, code: 'unavailable' }
      expect(await refusalOf(activate(a, keeper(1), 'tidewater-w0-p0'))).toBe('installation_unverified')
      p.tamper.fail = undefined
      expect(await rows()).toEqual(before)
      // A relaunch by the same player replaces the session: the old page is stale.
      const relaunched = await open(INSTALLATION_A, ADA, a.token)
      expect(await refusalOf(activate(a, keeper(1), 'tidewater-w0-p0'))).toBe('play_session_required')
      expect((await activate(relaunched, keeper(1), 'tidewater-w0-p0')).fresh).toBe(true)
      // Play saying the installation is no longer active ends the session, and nothing is written.
      p.setStatus(INSTALLATION_A, 'suspended')
      const held = await rows()
      expect(await refusalOf(activate(relaunched, keeper(2), 'tidewater-w0-p1'))).toBe('installation_not_active')
      expect(await rows()).toEqual({ ...held })
    })

    it('a session ended during an activation is a typed refusal, rolled back, never a database error (L1)', async () => {
      let during: ((step: ActivationStep) => Promise<void>) | null = null
      const s = await setup({ onStep: (step) => during?.(step) })
      const a = await s.open(INSTALLATION_A)
      // Signed out after the city was locked but before the activation reached the session: refused, nothing written.
      const before = await rows()
      const reached: ActivationStep[] = []
      during = async (step) => {
        reached.push(step)
        if (step === 'locked') await t.db.query('UPDATE play_sessions SET revoked_at = now() WHERE id = $1', [a.response.viewer.session.ref])
      }
      expect(await refusalOf(s.activate(a, keeper(1), 'tidewater-w0-p0'))).toBe('session_ended')
      // Refused by the store's own check, before the city was written, not only by the database's guard at the end.
      expect(reached).toEqual(['locked'])
      expect(await rows()).toEqual(before)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })

      // Signed out once the activation holds the session: the sign-out waits for it, and the property is whole.
      const b = await s.open(INSTALLATION_A, BEA)
      let signedOut: Promise<unknown> | null = null
      const order: string[] = []
      during = async (step) => {
        if (step !== 'city') return
        signedOut = t.db.query('UPDATE play_sessions SET revoked_at = now() WHERE id = $1', [b.response.viewer.session.ref]).then(() => order.push('signed out'))
        await new Promise((r) => setTimeout(r, 300))
        order.push('still writing')
      }
      const done = await s.activate(b, keeper(2), 'tidewater-w0-p1')
      order.push('committed')
      await signedOut
      during = null
      expect(done).toMatchObject({ fresh: true, sequence: 2 })
      expect(order).toEqual(['still writing', 'committed', 'signed out'])
      expect(await count('play_sessions', 'id = $1 AND revoked_at IS NOT NULL', [b.response.viewer.session.ref])).toBe(1)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ sequence: 2, properties: 1 }] })
    })

    it('a session that expires between the store\'s check and the database\'s is the same typed refusal (L1)', async () => {
      let during: ((step: ActivationStep) => Promise<void>) | null = null
      // A session clock 59 s behind, so a run ending 2 s from now still opens a session (the minimum is 60 s): it really expires in 2 s.
      const s = await setup({ onStep: (step) => during?.(step), now: () => new Date(Date.now() - 59_000) })
      const a = await s.open(INSTALLATION_A, ADA, null, new Date(Date.now() + 2_000).toISOString())
      const before = await rows()
      during = async (step) => {
        if (step === 'event') await new Promise((r) => setTimeout(r, 2_500))
      }
      expect(await refusalOf(s.activate(a, keeper(1), 'tidewater-w0-p0'))).toBe('session_ended')
      expect(await rows()).toEqual(before)
    })

    it('the database refuses a property whose session is not live, or not of its world', async () => {
      const { open, sessions } = await setup()
      const a = await open(INSTALLATION_A)
      const c = await open(INSTALLATION_C)
      await expect(rawActivate(a, asNft(keeper(1)), 'tidewater-w0-p0', { row: (r) => ({ ...r, activated_in_play_session: c.response.viewer.session.ref }) })).rejects.toThrow('a world property is activated only in a live play session of its world')
      await expect(rawActivate(a, asNft(keeper(1)), 'tidewater-w0-p0', { row: (r) => ({ ...r, activated_in_play_session: randomUUID() }) })).rejects.toThrow('a world property is activated only in a live play session of its world')
      await sessions.logout(a.token)
      await expect(rawActivate(a, asNft(keeper(1)), 'tidewater-w0-p0')).rejects.toThrow('a world property is activated only in a live play session of its world')
      expect(await count('world_properties')).toBe(0)
    })
  })

  describe('atomicity', () => {
    for (const step of ['city', 'event', 'freeze', 'property'] as const)
      it(`leaves nothing written when the activation fails after its ${step} write`, async () => {
        let fail = true
        const { open, activate } = await setup({
          onStep: (s) => {
            if (fail && s === step) throw new Error(`stop after ${s}`)
          },
        })
        const a = await open(INSTALLATION_A)
        const before = await rows()
        await expect(activate(a, keeper(1), 'tidewater-w0-p0')).rejects.toThrow(`stop after ${step}`)
        expect(await rows()).toEqual(before)
        fail = false
        expect((await activate(a, keeper(1), 'tidewater-w0-p0')).sequence).toBe(2)
        expect(await verifyCity(t.db)).toMatchObject({ ok: true })
      })
  })

  describe('districts with a Proofy rule', () => {
    it('a caller that cannot verify rules may refuse them: judged on the governing configuration, under the lock, nothing written', async () => {
      const p = fakePlay()
      p.install(INSTALLATION_A, GUILD_A)
      p.publish(INSTALLATION_A, { ...DOC_4, districts: DOC_4.districts.map((d) => (d.key === 'compass-row' ? { ...d, proofyRule: { verificationRuleId: 41, label: 'Verified Captain role' } } : d)) })
      const { open, store, sessions } = await setup({ play: p })
      const a = await open(INSTALLATION_A)
      const actor = await sessions.requireActor(a.token, { sessionRef: a.response.viewer.session.ref, worldId: a.response.world.id, discordUserId: ADA.discordUserId })
      const before = await rows()
      expect(await refusalOf(store.activate(actor, { asset: keeper(1), plotId: 'compass-row-w0-p0' }, { refuseRuleGatedDistricts: true }))).toBe('district-rule-unverified')
      expect(await rows()).toEqual(before)
      expect(await store.activate(actor, { asset: keeper(1), plotId: 'tidewater-w0-p0' }, { refuseRuleGatedDistricts: true })).toMatchObject({ fresh: true, sequence: 2 })
    })
  })

  describe('held outside a local database', () => {
    it('the service writes nothing anywhere but a local database', async () => {
      const { open, sessions } = await setup({ mode: 'staging' })
      const a = await open(INSTALLATION_A)
      const actor = await sessions.requireActor(a.token, { sessionRef: a.response.viewer.session.ref, worldId: a.response.world.id, discordUserId: ADA.discordUserId })
      // Configured for staging: refused before anything is read.
      expect(await refusalOf(createWorldPropertyStore(t.db, { mode: 'staging', log: silentLogger }).activate(actor, { asset: keeper(1), plotId: 'tidewater-w0-p0' }))).toBe('mutations_held')
      expect(await refusalOf(createWorldPropertyStore(t.db, { mode: 'production', log: silentLogger }).activate(actor, { asset: keeper(1), plotId: 'tidewater-w0-p0' }))).toBe('mutations_held')
      // Misconfigured as local against a staging database: the stamp is checked inside the transaction.
      // (The opposite misconfiguration, staging against a local database, is refused by the configuration: see below.)
      expect(await refusalOf(createWorldPropertyStore(t.db, { mode: 'local', log: silentLogger }).activate(actor, { asset: keeper(1), plotId: 'tidewater-w0-p0' }))).toBe('mutations_held')
      expect(await count('world_properties')).toBe(0)
    })

    it('a service not configured as local writes nothing even to a local database', async () => {
      const { open, sessions } = await setup()
      const a = await open(INSTALLATION_A)
      const actor = await sessions.requireActor(a.token, { sessionRef: a.response.viewer.session.ref, worldId: a.response.world.id, discordUserId: ADA.discordUserId })
      for (const mode of ['staging', 'production'] as const)
        expect(await refusalOf(createWorldPropertyStore(t.db, { mode, log: silentLogger }).activate(actor, { asset: keeper(1), plotId: 'tidewater-w0-p0' }))).toBe('mutations_held')
      expect(await count('world_properties')).toBe(0)
    })

    it('the database refuses a property in a staging database, and a world city there can never advance', async () => {
      const { open } = await setup({ mode: 'staging' })
      const a = await open(INSTALLATION_A)
      await expect(rawActivate(a, asNft(keeper(1)), 'tidewater-w0-p0')).rejects.toThrow('world properties are not enabled in this database')
      await expect(rawActivate(a, asNft(keeper(1)), 'tidewater-w0-p0', { skipProperty: true })).rejects.toThrow("a world's city advances only by activating a property")
      expect((await t.db.query(`SELECT sequence FROM city WHERE id = $1`, [`world:${a.response.world.id}`])).rows).toEqual([{ sequence: '1' }])
    })
  })

  describe('the database accepts only exactly the recorded activation', () => {
    const cases: [string, Parameters<typeof rawActivate>[3], RegExp | string][] = [
      ['a building the city state does not hold', { state: (s) => ({ ...s, buildings: {} }) }, /state|building its city has just recorded/],
      ['a state that records another plot', { row: (r) => ({ ...r, plot: 9, plot_id: 'tidewater-w0-p9' }) }, 'a world property must be the building its city has just recorded'],
      ['another collection key than the state', { row: (r) => ({ ...r, collection_key: 'tide-pass' }) }, 'a world property must be the building its city has just recorded'],
      ['no event for it', { event: (e) => ({ ...e, propertyId: randomUUID() }) }, 'world.property.activated event'],
      ['another district geometry than the frozen one', { row: (r) => ({ ...r, district_geometry_fingerprint: 'f'.repeat(64) }), event: (e) => ({ ...e, districtGeometryFingerprint: 'f'.repeat(64) }) }, 'the geometry its world froze at its first property'],
      ['another original activator than the player of its session', { row: (r) => ({ ...r, activator_discord_user_id: BEA.discordUserId, activator_core_user_id: BEA.coreUserId }) }, "a world property's original activator is the player of the play session that activates it"],
      ['an original activator half recorded', { row: (r) => ({ ...r, activator_core_user_id: undefined }) }, /original activator|wp_activator/],
      ['no original activator', { row: (r) => ({ ...r, activator_core_user_id: undefined, activator_discord_user_id: undefined }) }, /original activator|wp_activator/],
      ['another token standard', { row: (r) => ({ ...r, standard: 'erc1155' }) }, 'a world property is an ERC-721 NFT'],
      ['a non-canonical token id', { row: (r) => ({ ...r, token_id: '01' }) }, /wp_token_shape|V2 property id/],
      ['a city advanced with no property at all', { skipProperty: true }, "a world's city advances only by activating a property"],
    ]
    // Each on a world whose first property has already frozen its geometry: what the property guard alone refuses.
    for (const [label, tweak, message] of cases)
      it(`refuses ${label}`, async () => {
        const { open, activate } = await setup()
        const a = await open(INSTALLATION_A)
        await activate(a, tide(9), 'saltmarsh-w0-p0')
        const before = await rows()
        const run = rawActivate(a, asNft(keeper(1)), 'tidewater-w0-p0', { ...tweak, row: tweak?.row && ((r) => Object.fromEntries(Object.entries(tweak.row!(r)).filter(([, v]) => v !== undefined))) })
        await expect(run).rejects.toThrow(message)
        expect(await rows()).toEqual(before)
      })

    // A world's first property and the geometry freeze written with it (0008): the freeze guard's own refusals.
    const firsts: [string, Parameters<typeof rawActivate>[3], RegExp | string][] = [
      ['a first property with no freeze', { freeze: () => null }, 'the geometry its world froze at its first property'],
      ['a freeze of another geometry than the governing version draws', { freeze: (f) => ({ ...f, layout_geometry_fingerprint: 'f'.repeat(64) }) }, 'exactly the geometry recorded for its governing version'],
      ['a freeze whose districts the first property does not stand on', { freeze: (f) => ({ ...f, districts: JSON.stringify([{ key: 'nowhere', geometryFingerprint: 'f'.repeat(64) }]) }) }, 'frozen by the world.property.activated event that stands on it'],
      ['a freeze at another sequence', { freeze: (f) => ({ ...f, frozen_at_sequence: 3 }) }, /sequence 2|wgf_event|foreign key/],
      ['a freeze under another configuration version', { freeze: (f) => ({ ...f, config_version: 9 }) }, /frozen by the world.property.activated event|wgf_/],
      ['a freeze recorded as a migration\'s', { freeze: (f) => ({ ...f, frozen_by: 'migration-0008' }) }, 'frozen by its first property'],
      ['a property on a district the freeze does not hold', { row: (r) => ({ ...r, district_geometry_fingerprint: 'f'.repeat(64) }), event: (e) => ({ ...e, districtGeometryFingerprint: 'f'.repeat(64) }) }, /frozen by the world.property.activated event|froze at its first property/],
    ]
    it('refuses a freeze under an adoption that no longer governs, even when the event agrees with it', async () => {
      const { p, open } = await setup()
      await open(INSTALLATION_A)
      p.publish(INSTALLATION_A, { ...DOC_4, cityName: 'Harborlight Two' })
      const v2 = await open(INSTALLATION_A)
      const before = await rows()
      const stale = { adoption_seq: 1, config_version: 1 }
      await expect(
        rawActivate(v2, asNft(keeper(1)), 'tidewater-w0-p0', { event: (e) => ({ ...e, adoption: 1, configVersion: 1 }), freeze: (f) => ({ ...f, ...stale }), row: (r) => ({ ...r, activated_adoption_seq: 1, activated_config_version: 1 }) }),
      ).rejects.toThrow('frozen under the configuration version that governs it')
      expect(await rows()).toEqual(before)
    })

    for (const [label, tweak, message] of firsts)
      it(`refuses ${label}, freezing nothing`, async () => {
        const { open } = await setup()
        const a = await open(INSTALLATION_A)
        const before = await rows()
        await expect(rawActivate(a, asNft(keeper(1)), 'tidewater-w0-p0', tweak)).rejects.toThrow(message)
        expect(await rows()).toEqual(before)
        expect(await count('world_geometry_freezes')).toBe(0)
      })

    it('refuses an id that is not the V2 property id of its NFT, even when state, event and row all agree on it', async () => {
      const { open } = await setup()
      const a = await open(INSTALLATION_A)
      const forged = randomUUID()
      const rename = (s: Record<string, unknown>) => {
        const buildings = s.buildings as Record<string, Record<string, unknown>>
        const [[, b]] = Object.entries(buildings)
        return { ...s, buildings: { [`b-${forged}`]: { ...b, propertyId: forged } } }
      }
      await expect(
        rawActivate(a, asNft(keeper(1)), 'tidewater-w0-p0', { state: rename, event: (e) => ({ ...e, propertyId: forged, buildingId: `b-${forged}` }), row: (r) => ({ ...r, id: forged, building_id: `b-${forged}` }) }),
      ).rejects.toThrow('a world property id is the V2 property id of its world and NFT')
      expect(await count('world_properties')).toBe(0)
    })

    it('refuses a configuration version that does not govern the world now', async () => {
      const { p, open, activate } = await setup()
      await activate(await open(INSTALLATION_A), tide(9), 'saltmarsh-w0-p0')
      p.publish(INSTALLATION_A, { ...DOC_4, cityName: 'Harborlight Two' })
      const v2 = await open(INSTALLATION_A)
      expect(v2.response.world.definition.governingConfigVersion).toBe(2)
      await expect(rawActivate(v2, asNft(keeper(1)), 'tidewater-w0-p0', { row: (r) => ({ ...r, activated_config_version: 1 }), event: (e) => ({ ...e, configVersion: 1 }) })).rejects.toThrow('the configuration version that governs its world')
      // Adoption 1 did govern once, with version 1, but adoption 2 governs now.
      await expect(rawActivate(v2, asNft(keeper(1)), 'tidewater-w0-p0', { row: (r) => ({ ...r, activated_config_version: 1, activated_adoption_seq: 1 }), event: (e) => ({ ...e, configVersion: 1, adoption: 1 }) })).rejects.toThrow('the configuration version that governs its world')
      expect((await rawActivate(v2, asNft(keeper(1)), 'tidewater-w0-p0').then(() => worldPropertiesOf(t.db, v2.response.world.id)))[1]).toMatchObject({ adoption: 2, configVersion: 2 })
    })

    it('requires an original activator on every new property even with the guards off (wp_activator_required, wp_activator_shape)', async () => {
      const { open, activate } = await setup()
      const a = await open(INSTALLATION_A)
      await activate(a, tide(9), 'saltmarsh-w0-p0')
      for (const [row, message] of [
        [(r: Record<string, unknown>) => ({ ...r, activator_core_user_id: undefined, activator_discord_user_id: undefined }), /wp_activator_required/],
        [(r: Record<string, unknown>) => ({ ...r, activator_discord_user_id: 'ada' }), /wp_activator_shape/],
      ] as const) {
        await t.db.query('ALTER TABLE world_properties DISABLE TRIGGER USER')
        try {
          await expect(rawActivate(a, asNft(keeper(1)), 'tidewater-w0-p0', { row: (r) => Object.fromEntries(Object.entries(row(r)).filter(([, v]) => v !== undefined)) })).rejects.toThrow(message)
        } finally {
          await t.db.query('ALTER TABLE world_properties ENABLE TRIGGER USER')
        }
      }
      expect(await count('world_properties')).toBe(1)
    })

    it('keeps a property permanent and one per plot, whatever is written', async () => {
      const { open, activate } = await setup()
      const a = await open(INSTALLATION_A)
      const first = await activate(a, keeper(1), 'tidewater-w0-p0')
      await expect(t.db.query(`UPDATE world_properties SET plot = 1, plot_id = 'tidewater-w0-p1' WHERE id = $1`, [first.property.id])).rejects.toThrow('a world property is permanent: it cannot be changed')
      await expect(t.db.query('DELETE FROM world_properties WHERE id = $1', [first.property.id])).rejects.toThrow('a world property is permanent: it cannot be removed')
      // A second property on the same plot, even with a state forged to hold both.
      await expect(
        rawActivate(a, asNft(keeper(2)), 'tidewater-w0-p1', {
          state: (s) => {
            const buildings = s.buildings as Record<string, { plot: number }>
            for (const b of Object.values(buildings)) b.plot = 0
            return s
          },
          row: (r) => ({ ...r, plot: 0, plot_id: 'tidewater-w0-p0' }),
          event: (e) => ({ ...e, plot: 0, plotId: 'tidewater-w0-p0' }),
        }),
      ).rejects.toThrow(/wp_one_per_plot/)
      expect(await count('world_properties')).toBe(1)
    })
  })

  describe('tampering is detected', () => {
    async function populated() {
      const s = await setup()
      const a = await s.open(INSTALLATION_A)
      const r1 = await s.activate(a, keeper(1), 'tidewater-w0-p0')
      const r2 = await s.activate(a, tide(2), 'tidewater-w0-p1')
      return { ...s, a, r1, r2, cityId: `world:${a.response.world.id}` }
    }
    const rules = async () => (await verifyCity(t.db)).violations.filter((v) => v.category === 'worlds').map((v) => v.rule)

    it('a state that lost a building: every read refuses the city, and verify reports it', async () => {
      const { a, read, open, r2, cityId } = await populated()
      await unguarded(async () => {
        const state = JSON.parse((await t.db.query<{ s: string }>('SELECT state::text AS s FROM city WHERE id = $1', [cityId])).rows[0].s)
        delete state.buildings[r2.property.buildingId]
        await t.db.query('UPDATE city SET state = $1::json WHERE id = $2', [JSON.stringify(state), cityId])
      })
      expect(await refusalOf(read(a))).toBe('world_unavailable')
      await expect(open(INSTALLATION_A)).rejects.toMatchObject({ code: 'world_unavailable' })
      expect(await rules()).toEqual(expect.arrayContaining(['properties', 'replay']))
    })

    it('an event that does not say what the engine did', async () => {
      const { r1, cityId } = await populated()
      await unguarded(() => t.db.query(`UPDATE city_events SET payload = jsonb_set(payload, '{openedWard}', 'true') WHERE city_id = $1 AND sequence = 2`, [cityId]))
      expect(r1.sequence).toBe(2)
      expect(await rules()).toEqual(['replay'])
    })

    it('a sequence with no event, or an event of another kind', async () => {
      const { cityId } = await populated()
      await unguarded(() => t.db.query(`UPDATE city_events SET type = 'world.test' WHERE city_id = $1 AND sequence = 3`, [cityId]))
      expect(await rules()).toEqual(expect.arrayContaining(['events']))
    })

    it('a property and state forged consistently onto a plot the engine never offered', async () => {
      const { r2, cityId, a, read } = await populated()
      await unguarded(async () => {
        const state = JSON.parse((await t.db.query<{ s: string }>('SELECT state::text AS s FROM city WHERE id = $1', [cityId])).rows[0].s)
        state.buildings[r2.property.buildingId].ward = 1
        state.buildings[r2.property.buildingId].plot = 0
        state.openWards = { tidewater: 2 }
        await t.db.query('UPDATE city SET state = $1::json WHERE id = $2', [JSON.stringify(state), cityId])
        await t.db.query(`UPDATE world_properties SET ward = 1, plot = 0, plot_id = 'tidewater-w1-p0' WHERE id = $1`, [r2.property.id])
      })
      // Parity holds and the shape is possible; only the replay knows ward 1 could not open with ward 0 nearly empty.
      expect(await rules()).toEqual(['replay'])
      expect((await read(a)).world.sequence).toBe(3)
    })

    it('a governing version forced past the freeze onto other districts: nothing draws the city until a version on the frozen geometry governs again, and verify reports it', async () => {
      const { p, open, a, read } = await populated()
      p.publish(INSTALLATION_A, { ...DOC_4, districts: [...DOC_4.districts, district('reef')] })
      await expect(open(INSTALLATION_A)).rejects.toMatchObject({ code: 'config_incompatible' })
      await t.db.query('ALTER TABLE world_config_adoptions DISABLE TRIGGER USER')
      try {
        await t.db.query('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) VALUES ($1, 2, 2)', [a.response.world.id])
      } finally {
        await t.db.query('ALTER TABLE world_config_adoptions ENABLE TRIGGER USER')
      }
      expect(await refusalOf(read(a))).toBe('world_unavailable')
      // A launch pinned to it is refused too: never drawn. Re-activating a version on the frozen geometry adopts it
      // again (the database allows that adoption), and the city reads again; the forced adoption stays on record.
      await expect(open(INSTALLATION_A)).rejects.toMatchObject({ code: 'config_incompatible' })
      p.activate(INSTALLATION_A, 1)
      expect((await open(INSTALLATION_A)).response.world.definition.governingConfigVersion).toBe(1)
      expect((await read(a)).world.sequence).toBe(3)
      expect(await rules()).toEqual(['adoptions'])
    })

    it('a geometry freeze rewritten to another adoption than its first property\'s', async () => {
      const { p, open, a } = await populated()
      p.publish(INSTALLATION_A, { ...DOC_4, cityName: 'Harborlight Two' })
      await open(INSTALLATION_A)
      await t.db.query('ALTER TABLE world_geometry_freezes DISABLE TRIGGER USER')
      try {
        await t.db.query('UPDATE world_geometry_freezes SET adoption_seq = 2, config_version = 2 WHERE world_id = $1', [a.response.world.id])
      } finally {
        await t.db.query('ALTER TABLE world_geometry_freezes ENABLE TRIGGER USER')
      }
      expect(await rules()).toEqual(['freeze'])
    })

    it('a property that claims a configuration version which did not govern the world when it was activated', async () => {
      const { p, open, cityId, r1 } = await populated()
      p.publish(INSTALLATION_A, { ...DOC_4, cityName: 'Harborlight Two' })
      expect((await open(INSTALLATION_A)).response.world.definition.governingConfigVersion).toBe(2)
      expect(await rules()).toEqual([])
      await unguarded(async () => {
        await t.db.query('UPDATE world_properties SET activated_config_version = 2 WHERE id = $1', [r1.property.id])
        await t.db.query(`UPDATE city_events SET payload = jsonb_set(payload, '{configVersion}', '2') WHERE city_id = $1 AND sequence = 2`, [cityId])
      })
      // The first property's freeze still records version 1, so the freeze no longer matches it either.
      expect(await rules()).toEqual(['freeze', 'properties'])
    })

    it('activations that name adoptions out of order', async () => {
      const { p, open, cityId, r1 } = await populated()
      p.publish(INSTALLATION_A, { ...DOC_4, cityName: 'Harborlight Two' })
      await open(INSTALLATION_A)
      // The first property claims adoption 2 (which did adopt version 2), the second still names adoption 1: adoptions went backwards.
      await unguarded(async () => {
        await t.db.query('UPDATE world_properties SET activated_config_version = 2, activated_adoption_seq = 2 WHERE id = $1', [r1.property.id])
        await t.db.query(`UPDATE city_events SET payload = payload || '{"configVersion": 2, "adoption": 2}'::jsonb WHERE city_id = $1 AND sequence = 2`, [cityId])
      })
      const violations = (await verifyCity(t.db)).violations
      expect(violations.map((v) => v.rule)).toEqual(['freeze', 'properties'])
      expect(violations[1].detail).toMatch(/older than the adoption of the property before it/)
    })

    it('a property record whose sequence was rewritten: every read refuses the city, and verify reports it (L3)', async () => {
      const { a, read, open, worlds, r2, cityId } = await populated()
      const scope = { worldId: a.response.world.id, environment: a.response.play.environment, gameKey: a.response.play.gameKey, installationId: a.response.play.installationId, discordGuildId: a.response.play.discordGuildId }
      // Only the second property's recorded sequence changes (3 -> 4, with an event there so its foreign key holds): its
      // state, plot and position are untouched, so only the read path's sequence check can see it.
      await unguarded(async () => {
        await t.db.query(`INSERT INTO city_events (city_id, sequence, type, payload) SELECT city_id, 4, type, payload FROM city_events WHERE city_id = $1 AND sequence = 3`, [cityId])
        await t.db.query('UPDATE world_properties SET activated_sequence = 4 WHERE id = $1', [r2.property.id])
      })
      await expect(worlds.read(scope)).rejects.toThrow(`property ${r2.property.id} records sequence 4, not 3`)
      expect(await refusalOf(read(a))).toBe('world_unavailable')
      await expect(open(INSTALLATION_A)).rejects.toMatchObject({ code: 'world_unavailable' })
      expect(await refusalOf(read(a))).toBe('world_unavailable')
      expect(await rules()).toEqual(expect.arrayContaining(['properties']))
    })

    it('a property record that went missing', async () => {
      const { r2, a, read } = await populated()
      await unguarded(() => t.db.query('DELETE FROM world_properties WHERE id = $1', [r2.property.id]))
      expect(await refusalOf(read(a))).toBe('world_unavailable')
      expect(await rules()).toEqual(expect.arrayContaining(['properties']))
    })
  })

  describe('beside the Rare Friends city', () => {
    it('leaves legacy semantics alone: main is not a world, its tables refuse world cities, world properties refuse main', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
      await installDemoFixture(t.db, 'local')
      await addIdentity(t.db)
      const mainRow = async () => (JSON.parse(await snapshot(t.db, 'city', 'id')) as { id: string }[]).filter((r) => r.id === 'main')
      const main = await mainRow()
      const { open, activate } = await setup({ migrated: true })
      const a = await open(INSTALLATION_A)
      await activate(a, keeper(1), 'tidewater-w0-p0')
      expect(await mainRow()).toEqual(main)
      const report = await verifyCity(t.db)
      expect(report.ok).toBe(true)
      expect(report.city?.id).toBe('main')
      expect(report.worlds).toMatchObject([{ properties: 1, sequence: 2 }])
      await expect(
        t.db.query(
          `INSERT INTO world_properties (id, world_id, city_id, city_instance_id, chain, standard, contract, token_id, collection_key, district_key, ward, plot, plot_id, building_id, district_geometry_fingerprint, activated_sequence, activated_config_version, activated_in_play_session)
           SELECT gen_random_uuid(), $1, 'main', instance_id, 'eip155:4663', 'erc721', $2, '1', 'rf', 'd1', 0, 0, 'd1-w0-p0', 'b-x', $3, 2, 1, $4 FROM city WHERE id = 'main'`,
          [a.response.world.id, contract(1), 'a'.repeat(64), a.response.viewer.session.ref],
        ),
      ).rejects.toThrow(/belongs to its world's own city|wp_building_shape/)
    })
  })

  describe('district geometry freezes at the first property (0008)', () => {
    /** DOC_4 with two more districts: the same collections, six wedges instead of four. */
    const DOC_4_SIX = { ...DOC_4, districts: [...DOC_4.districts, district('reef'), district('dune')] }
    const freezeOf = async (worldId: string) =>
      (await t.db.query('SELECT frozen_at_sequence, adoption_seq, config_version, layout_key, layout_geometry_fingerprint, districts, frozen_by FROM world_geometry_freezes WHERE world_id = $1', [worldId])).rows[0] ?? null
    const geometryOfVersion = async (worldId: string, version: number) =>
      (await t.db.query('SELECT layout_key, layout_geometry_fingerprint, districts FROM world_config_geometries WHERE world_id = $1 AND version = $2', [worldId, version])).rows[0]
    const adoptions = async (worldId: string) => (await t.db.query('SELECT adoption_seq, version FROM world_config_adoptions WHERE world_id = $1 ORDER BY adoption_seq', [worldId])).rows.map((r) => [r.adoption_seq, r.version])
    /** Resolves once `n` transactions are queued on a city row lock. */
    async function cityLockWaiters(n: number) {
      for (let i = 0; i < 400; i++) {
        const waiting = (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM city WHERE id = $1 FOR UPDATE%' AND pid <> pg_backend_pid()`)).rows[0].n
        if (waiting >= n) return
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error(`never saw ${n} transactions waiting for a city lock`)
    }
    /** Hold a world's city row lock on a connection of its own, as any change to the city does, until released. */
    async function holdCity(worldId: string) {
      const holder = await t.db.connect()
      await holder.query('BEGIN')
      await holder.query('SELECT 1 FROM city WHERE id = $1 FOR UPDATE', [`world:${worldId}`])
      return {
        release: async () => {
          await holder.query('COMMIT')
          holder.release()
        },
      }
    }

    it('lets an empty city go from 4 districts to 6: the same world, valid, nothing frozen', async () => {
      const { p, open, read } = await setup()
      const a = await open(INSTALLATION_A)
      expect(a.response.world.districts.map((d) => d.key)).toEqual(['lantern-quay', 'tidewater', 'saltmarsh', 'compass-row'])
      p.publish(INSTALLATION_A, DOC_4_SIX)
      const six = await open(INSTALLATION_A)
      expect(six.response.world).toMatchObject({ id: a.response.world.id, created: false, sequence: 1, definition: { foundingConfigVersion: 1, governingConfigVersion: 2, districtGeometry: { frozen: false } } })
      expect(six.response.world.districts.map((d) => d.key)).toEqual(['lantern-quay', 'tidewater', 'saltmarsh', 'compass-row', 'reef', 'dune'])
      expect(six.response.world.districts.every((d) => d.spanDeg === 60)).toBe(true)
      expect((await read(six)).world.definition.geometryFingerprint).toBe(six.response.world.definition.geometryFingerprint)
      expect(six.response.world.definition.geometryFingerprint).not.toBe(a.response.world.definition.geometryFingerprint)
      expect(await count('world_geometry_freezes')).toBe(0)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, violations: [], worlds: expect.arrayContaining([expect.objectContaining({ id: a.response.world.id, governingConfigVersion: 2, geometryFrozenAt: null })]) })
    })

    it('freezes exactly the geometry that governed the first successful property, in its transaction', async () => {
      const { p, open, activate, read } = await setup()
      const a = await open(INSTALLATION_A)
      p.publish(INSTALLATION_A, DOC_4_SIX)
      const six = await open(INSTALLATION_A)
      const first = await activate(six, keeper(1), 'dune-w0-p0')
      const worldId = a.response.world.id
      expect(await freezeOf(worldId)).toEqual({ frozen_at_sequence: '2', adoption_seq: 2, config_version: 2, ...(await geometryOfVersion(worldId, 2)), frozen_by: 'first-property' })
      expect((await geometryOfVersion(worldId, 2)).layout_geometry_fingerprint).toBe(six.response.world.definition.geometryFingerprint)
      expect(first.property).toMatchObject({ districtKey: 'dune', adoption: 2, configVersion: 2, districtGeometryFingerprint: six.response.world.districts.find((d) => d.key === 'dune')!.geometryFingerprint })
      expect((await read(six)).world.definition.districtGeometry).toEqual({ frozen: true, atSequence: 2, configVersion: 2 })
      // A second property freezes nothing more.
      await activate(six, keeper(2), 'reef-w0-p0')
      expect(await count('world_geometry_freezes')).toBe(1)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, violations: [], worlds: expect.arrayContaining([expect.objectContaining({ id: worldId, properties: 2, geometryFrozenAt: 2 })]) })
    })

    it('freezes nothing for a refused or rolled-back activation, and the geometry may still change after one', async () => {
      let fail = false
      const { p, open, activate } = await setup({
        onStep: (s) => {
          if (fail && s === 'freeze') throw new Error('stop after freeze')
        },
      })
      const a = await open(INSTALLATION_A)
      const before = await rows()
      for (const [asset, plot, code] of [
        [keeper(1), 'nowhere-w0-p0', 'unknown-plot'],
        [keeper(1), 'tidewater-w9-p0', 'plot-unavailable'],
        [sprite(1), 'tidewater-w0-p0', 'asset-not-in-world'],
      ] as const)
        expect(await refusalOf(activate(a, asset, plot))).toBe(code)
      fail = true
      await expect(activate(a, keeper(1), 'tidewater-w0-p0')).rejects.toThrow('stop after freeze')
      expect(await rows()).toEqual(before)
      expect(await count('world_geometry_freezes')).toBe(0)
      // Still editable: the six-district version governs.
      p.publish(INSTALLATION_A, DOC_4_SIX)
      expect((await open(INSTALLATION_A)).response.world.definition.governingConfigVersion).toBe(2)
    })

    it('race: an activation holding the city first freezes the old geometry, and the six-district launch queued behind it is refused', async () => {
      const { p, open, activate } = await setup()
      const a = await open(INSTALLATION_A)
      const worldId = a.response.world.id
      p.publish(INSTALLATION_A, DOC_4_SIX)
      const sixRun = p.launch(INSTALLATION_A, 'six-queued')
      const held = await holdCity(worldId)
      const activation = activate(a, keeper(1), 'tidewater-w0-p0')
      await cityLockWaiters(1)
      const relaunch = setup({ migrated: true, play: p }).then((s2) => s2.launch.open({ runToken: sixRun }))
      await cityLockWaiters(2)
      await held.release()
      expect(await activation).toMatchObject({ fresh: true, sequence: 2, property: { adoption: 1, configVersion: 1 } })
      await expect(relaunch).rejects.toMatchObject({ code: 'config_incompatible' })
      // Version 2 is recorded as accepted (a verdict does not depend on the city), but it cannot govern a frozen city.
      expect(await adoptions(worldId)).toEqual([[1, 1]])
      expect(await freezeOf(worldId)).toMatchObject({ config_version: 1, adoption_seq: 1, layout_geometry_fingerprint: a.response.world.definition.geometryFingerprint })
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('race: a six-district adoption holding the city first governs, and the activation queued behind it freezes six districts', async () => {
      const { p, open, activate } = await setup()
      const a = await open(INSTALLATION_A)
      const worldId = a.response.world.id
      p.publish(INSTALLATION_A, DOC_4_SIX)
      const sixRun = p.launch(INSTALLATION_A, 'six-first')
      const held = await holdCity(worldId)
      const relaunch = setup({ migrated: true, play: p }).then((s2) => s2.launch.open({ runToken: sixRun }))
      await cityLockWaiters(1)
      const activation = activate(a, keeper(1), 'tidewater-w0-p0')
      await cityLockWaiters(2)
      await held.release()
      expect((await relaunch).world.definition.governingConfigVersion).toBe(2)
      const placed = await activation
      expect(placed).toMatchObject({ fresh: true, sequence: 2, property: { adoption: 2, configVersion: 2 } })
      expect(await freezeOf(worldId)).toMatchObject({ config_version: 2, adoption_seq: 2, ...(await geometryOfVersion(worldId, 2)) })
      expect((await freezeOf(worldId)).districts).toHaveLength(6)
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('after the first property refuses any version that moves the districts, at launch and in the database; nothing moves', async () => {
      const { p, open, activate, read } = await setup()
      const a = await open(INSTALLATION_A)
      const worldId = a.response.world.id
      const first = await activate(a, keeper(1), 'tidewater-w0-p0')
      const before = await rows()
      for (const document of [DOC_4_SIX, { ...DOC_4, districts: [...DOC_4.districts].reverse() }, { ...DOC_4, districts: DOC_4.districts.map((d, i) => (i === 1 ? { ...d, key: 'tides' } : d)) }]) {
        p.publish(INSTALLATION_A, document)
        const err = await open(INSTALLATION_A).then(
          () => null,
          (e: { code?: string; problems?: { detail: string }[] }) => e,
        )
        expect(err?.code).toBe('config_incompatible')
        expect(err?.problems?.map((x) => x.detail).join(' | ')).toMatch(/first property/)
      }
      // Each version was recorded (accepted: verdicts do not depend on the city) with its geometry; none adopted.
      expect(await adoptions(worldId)).toEqual([[1, 1]])
      expect((await t.db.query(`SELECT version, verdict FROM world_config_versions WHERE world_id = $1 ORDER BY version`, [worldId])).rows.map((r) => r.verdict)).toEqual(['accepted', 'accepted', 'accepted', 'accepted'])
      // The database refuses the adoption on its own.
      await expect(t.db.query('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) VALUES ($1, 2, 2)', [worldId])).rejects.toThrow('adopts only a configuration version that draws exactly that geometry')
      // And a freeze can never be written again, changed or removed.
      await expect(t.db.query(`UPDATE world_geometry_freezes SET frozen_by = 'migration-0008' WHERE world_id = $1`, [worldId])).rejects.toThrow('frozen district geometry is permanent')
      await expect(t.db.query('DELETE FROM world_geometry_freezes WHERE world_id = $1', [worldId])).rejects.toThrow('frozen district geometry is permanent')
      expect({ ...(await rows()), world_config_versions: before.world_config_versions, world_config_geometries: before.world_config_geometries }).toEqual(before)
      expect((await read(a)).world.state.buildings[first.property.buildingId]).toMatchObject({ districtKey: 'tidewater', ward: 0, plot: 0 })
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('after the first property still takes presentation changes and new collections; every property stays on its plot', async () => {
      const { p, open, activate, read } = await setup()
      const a = await open(INSTALLATION_A)
      const worldId = a.response.world.id
      const first = await activate(a, keeper(1), 'tidewater-w0-p0')
      const firstRow = await snapshot(t.db, 'world_properties', 'id')
      const freeze = await freezeOf(worldId)
      p.publish(INSTALLATION_A, {
        ...DOC_4,
        cityName: 'Harborlight Reach',
        brand: { name: 'Harborlight Reach', logo: null },
        collections: [...DOC_4.collections, { key: 'gulls', chain: 'eip155:10', contract: contract(0xa003), displayName: 'Gulls' }],
        districts: DOC_4.districts.map((d, i) => ({ ...d, name: `District ${i + 1}`, accent: '#123456', proofyRule: i === 3 ? { verificationRuleId: 7, label: 'Holder' } : null })),
      })
      const v2 = await open(INSTALLATION_A)
      expect(v2.response.world.definition).toMatchObject({ governingConfigVersion: 2, districtGeometry: { frozen: true, atSequence: 2, configVersion: 1 }, geometryFingerprint: a.response.world.definition.geometryFingerprint })
      expect((v2.response.config as { cityName: string }).cityName).toBe('Harborlight Reach')
      const gull = await activate(v2, { chain: 'eip155:10', contract: contract(0xa003), tokenId: '5' }, 'saltmarsh-w0-p1')
      expect(gull.property).toMatchObject({ collection: 'gulls', adoption: 2, configVersion: 2 })
      expect(await freezeOf(worldId)).toEqual(freeze)
      expect(await snapshot(t.db, 'world_properties', 'id').then((all) => JSON.parse(all).filter((r: { id: string }) => r.id === first.property.id))).toEqual(JSON.parse(firstRow))
      expect((await read(v2)).world.state.buildings[first.property.buildingId]).toMatchObject({ districtKey: 'tidewater', ward: 0, plot: 0, sequence: 2 })
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('freezes each world on its own: a frozen city beside one whose districts may still change', async () => {
      const { p, open, activate } = await setup()
      const a = await open(INSTALLATION_A)
      const b = await open(INSTALLATION_B)
      const c = await open(INSTALLATION_C)
      // The same NFT in A and C is a different property in each, and each first property freezes only its own world.
      const inA = await activate(a, keeper(1), 'tidewater-w0-p0')
      const inC = await activate(c, keeper(1), 'tidewater-w0-p0')
      expect(inA.property.id).not.toBe(inC.property.id)
      await activate(b, seed(4), 'fig-w0-p0')
      expect(await count('world_geometry_freezes')).toBe(3)
      // A fourth installation with no property still changes its districts.
      const INSTALLATION_D = '01a14800-0000-7000-8000-00000000000d'
      p.install(INSTALLATION_D, '900000000000000004')
      p.publish(INSTALLATION_D, DOC_4)
      await open(INSTALLATION_D)
      p.publish(INSTALLATION_D, DOC_4_SIX)
      expect((await open(INSTALLATION_D)).response.world.districts).toHaveLength(6)
      expect(await count('world_geometry_freezes')).toBe(3)
      expect((await verifyCity(t.db)).ok).toBe(true)
    })
  })

  describe('the original activator (0008)', () => {
    it('is the session\'s player, recorded with the property, and outlives sign-out, session tidying and relaunch', async () => {
      const { open, activate, read, sessions } = await setup()
      const ada = await open(INSTALLATION_A, ADA)
      const placed = await activate(ada, keeper(1), 'tidewater-w0-p0')
      expect(placed.property.activator).toEqual({ coreUserId: ADA.coreUserId, discordUserId: ADA.discordUserId })
      expect((await t.db.query('SELECT activator_core_user_id, activator_discord_user_id FROM world_properties')).rows).toEqual([{ activator_core_user_id: ADA.coreUserId, activator_discord_user_id: ADA.discordUserId }])
      expect((await read(ada)).viewer.originalActivations).toEqual([placed.property.id])
      await sessions.logout(ada.token)
      // Tidying ended sessions removes the activating session's row; the activator stays.
      await createPlaySessionStore(t.db).tidy(new Date(Date.now() + 1_000))
      expect(await count('play_sessions', 'id = $1', [ada.response.viewer.session.ref])).toBe(0)
      expect((await worldPropertiesOf(t.db, ada.response.world.id))[0].activator).toEqual({ coreUserId: ADA.coreUserId, discordUserId: ADA.discordUserId })
      const again = await open(INSTALLATION_A, ADA)
      expect(again.response.viewer.originalActivations).toEqual([placed.property.id])
      expect((await read(again)).viewer.originalActivations).toEqual([placed.property.id])
      expect(await activate(again, keeper(1), 'tidewater-w0-p0')).toMatchObject({ fresh: false, property: { id: placed.property.id } })
      // Immutable in the database.
      await expect(t.db.query(`UPDATE world_properties SET activator_discord_user_id = $1`, [BEA.discordUserId])).rejects.toThrow('a world property is permanent')
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('is never another player\'s to claim or to learn: not Bea, not Ada\'s Discord id under another Core user', async () => {
      const { open, activate, read } = await setup()
      const ada = await open(INSTALLATION_A, ADA)
      const placed = await activate(ada, keeper(1), 'tidewater-w0-p0')
      const before = await rows()
      const bea = await open(INSTALLATION_A, BEA)
      // The same Discord user id under another Core user is not the original activator either.
      const impostor = await open(INSTALLATION_A, { ...ADA, coreUserId: 'core-someone-else', displayName: 'Not Ada' })
      const err = await activate(bea, keeper(1), 'tidewater-w0-p0').catch((e: unknown) => e as WorldPropertyRefusal)
      expect(err).toBeInstanceOf(WorldPropertyRefusal)
      expect((err as WorldPropertyRefusal).code).toBe('asset-already-placed')
      const beaRead = await read(bea)
      expect(beaRead.viewer.originalActivations).toEqual([])
      expect(bea.response.viewer.originalActivations).toEqual([])
      // Nothing Bea is told names Ada's session, or Ada.
      for (const said of [JSON.stringify(beaRead), JSON.stringify(bea.response), `${(err as Error).message} ${JSON.stringify(err)}`])
        for (const secret of [ada.response.viewer.session.ref, ADA.discordUserId, ADA.coreUserId]) expect(said).not.toContain(secret)
      expect(impostor.response.viewer.originalActivations).toEqual([])
      expect(await refusalOf(activate(impostor, keeper(1), 'tidewater-w0-p0'))).toBe('asset-already-placed')
      expect(await rows()).toEqual(before)
      expect(await count('world_properties')).toBe(1)
      expect(placed.fresh).toBe(true)
    })

    it('concurrent activations of one NFT: exactly one property, every repeat by its activator idempotent, every other player refused', async () => {
      const { open, activate } = await setup()
      const ada = await open(INSTALLATION_A, ADA)
      const bea = await open(INSTALLATION_A, BEA)
      const results = await Promise.allSettled([
        ...Array.from({ length: 6 }, () => activate(ada, keeper(7), 'saltmarsh-w0-p3')),
        ...Array.from({ length: 3 }, () => activate(bea, keeper(7), 'saltmarsh-w0-p3')),
      ])
      const won = results.flatMap((r) => (r.status === 'fulfilled' && r.value.fresh ? [r.value] : []))
      expect(won).toHaveLength(1)
      const winner = won[0].property.activator!.discordUserId
      for (const [i, r] of results.entries()) {
        const mine = (i < 6 ? ADA : BEA).discordUserId === winner
        if (mine) expect(r).toMatchObject({ status: 'fulfilled', value: { property: { id: won[0].property.id } } })
        else expect(r.status === 'rejected' && (r.reason as WorldPropertyRefusal).code).toBe('asset-already-placed')
      }
      expect(await count('world_properties')).toBe(1)
      expect(await count('world_geometry_freezes')).toBe(1)
      expect((await verifyCity(t.db)).ok).toBe(true)
    })
  })

  describe('migration 0007', () => {
    it('adds world properties to a populated database and changes no existing row', async () => {
      await migrate(t.db, { dir: await migrationsThrough(6), environment: 'local' })
      await installDemoFixture(t.db, 'local')
      await addIdentity(t.db)
      const { open } = await setup({ migrated: true })
      await withPre0008StandIns(t.db, async () => {
        await open(INSTALLATION_A)
        await open(INSTALLATION_B)
      })
      const tables = ['app_meta', 'city', 'city_events', 'activation_intents', 'properties', 'ownership_eras', 'users', 'wallets', 'sessions', 'worlds', 'world_play_bindings', 'world_config_versions', 'world_config_adoptions', 'play_sessions']
      const before = await Promise.all(tables.map((table) => snapshot(t.db, table, '1')))
      expect(await migrate(t.db, { dir: await migrationsThrough(7), environment: 'local' })).toEqual({ applied: [7], current: 7 })
      expect(await Promise.all(tables.map((table) => snapshot(t.db, table, '1')))).toEqual(before)
      expect(await count('world_properties')).toBe(0)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })
  })

  describe('migration 0008', () => {
    it('on a populated 0007 database: records the founding geometry where a property stands, adds no activator, changes no existing row', async () => {
      await migrate(t.db, { dir: await migrationsThrough(7), environment: 'local' })
      await installDemoFixture(t.db, 'local')
      await addIdentity(t.db)
      const env = await setup({ migrated: true })
      // World A gets a property as 0007 wrote one (no freeze, no activator); world B stays empty.
      const [a, b] = await withPre0008StandIns(t.db, async () => {
        const a = await env.open(INSTALLATION_A, ADA)
        const b = await env.open(INSTALLATION_B, ADA)
        await rawActivate(a, asNft(keeper(1)), 'tidewater-w0-p0', { pre0008: true })
        return [a, b]
      })
      const tables = ['app_meta', 'city', 'city_events', 'activation_intents', 'properties', 'ownership_eras', 'users', 'wallets', 'sessions', 'worlds', 'world_play_bindings', 'world_config_versions', 'world_config_adoptions', 'play_sessions']
      const before = await Promise.all(tables.map((table) => snapshot(t.db, table, '1')))
      const PROPERTY_0007 = 'id, world_id, city_id, city_instance_id, chain, standard, contract, token_id, collection_key, district_key, ward, plot, plot_id, building_id, district_geometry_fingerprint, activated_sequence, activated_adoption_seq, activated_config_version, activated_in_play_session, activated_at'
      const property0007 = JSON.stringify((await t.db.query(`SELECT ${PROPERTY_0007} FROM world_properties`)).rows)

      expect(await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).toEqual({ applied: [8], current: 8 })
      expect(await Promise.all(tables.map((table) => snapshot(t.db, table, '1')))).toEqual(before)
      expect(JSON.stringify((await t.db.query(`SELECT ${PROPERTY_0007} FROM world_properties`)).rows)).toBe(property0007)
      expect((await t.db.query('SELECT activator_core_user_id, activator_discord_user_id FROM world_properties')).rows).toEqual([{ activator_core_user_id: null, activator_discord_user_id: null }])

      // Every accepted version (each world's founding one) is recorded with its founding geometry.
      const geometries = (await t.db.query('SELECT world_id, version, layout_key, layout_geometry_fingerprint, recorded_by FROM world_config_geometries ORDER BY world_id')).rows
      expect(geometries.map((g) => [g.version, g.recorded_by])).toEqual([
        [1, 'migration-0008-founding-geometry'],
        [1, 'migration-0008-founding-geometry'],
      ])
      for (const o of [a, b]) expect(geometries.find((g) => g.world_id === o.response.world.id)?.layout_geometry_fingerprint).toBe(o.response.world.definition.geometryFingerprint)
      // A's property froze its geometry at founding, as 0007 required; B has nothing frozen.
      expect((await t.db.query('SELECT world_id, frozen_at_sequence, adoption_seq, config_version, layout_geometry_fingerprint, frozen_by FROM world_geometry_freezes')).rows).toEqual([
        { world_id: a.response.world.id, frozen_at_sequence: '2', adoption_seq: 1, config_version: 1, layout_geometry_fingerprint: a.response.world.definition.geometryFingerprint, frozen_by: 'migration-0008' },
      ])
      expect(await verifyCity(t.db)).toMatchObject({
        ok: true,
        violations: [],
        worlds: expect.arrayContaining([
          expect.objectContaining({ id: a.response.world.id, properties: 1, propertiesWithoutActivator: 1, geometryFrozenAt: 2 }),
          expect.objectContaining({ id: b.response.world.id, properties: 0, geometryFrozenAt: null }),
        ]),
      })

      // After it: the pre-0008 property is still Ada's to repeat (while its session row is kept), new properties name
      // their activator, and B's first property freezes B.
      const after = await setup({ migrated: true, play: env.p })
      const ada = await after.open(INSTALLATION_A, ADA)
      expect(await after.activate(ada, keeper(1), 'tidewater-w0-p0')).toMatchObject({ fresh: false, property: { activator: null } })
      expect(await after.activate(ada, keeper(2), 'tidewater-w0-p1')).toMatchObject({ fresh: true, sequence: 3, property: { activator: { discordUserId: ADA.discordUserId, coreUserId: ADA.coreUserId } } })
      const bea = await after.open(INSTALLATION_A, BEA)
      expect(await refusalOf(after.activate(bea, keeper(1), 'tidewater-w0-p0'))).toBe('asset-already-placed')
      const adaInB = await after.open(INSTALLATION_B, ADA)
      await after.activate(adaInB, sprite(1), 'plum-w0-p0')
      expect((await t.db.query(`SELECT frozen_by FROM world_geometry_freezes WHERE world_id = $1`, [b.response.world.id])).rows).toEqual([{ frozen_by: 'first-property' }])
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, violations: [] })
      // A property written now without its activator is refused by the database itself.
      await expect(rawActivate(ada, asNft(keeper(3)), 'tidewater-w0-p2', { pre0008: true })).rejects.toThrow(/original activator|wp_activator_required/)
    })

    it('pins every new guard function to its own schema', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
      const names = ['world_geometry_districts_ok', 'world_config_geometries_guard', 'world_config_version_require_geometry', 'world_geometry_freezes_guard', 'world_geometry_freeze_require_property', 'world_config_adoptions_keep_frozen_geometry', 'world_properties_guard']
      const { rows: pinned } = await t.db.query<{ proname: string; config: string[] }>(`SELECT p.proname, p.proconfig AS config FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = $1 AND p.proname = ANY($2) ORDER BY p.proname`, [t.schema, names])
      expect(pinned.map((r) => r.proname)).toEqual([...names].sort())
      for (const r of pinned) expect(r.config).toEqual([`search_path=${t.schema}, pg_temp`])
    })
  })

  describe('reachability', () => {
    it('nothing outside the property store module and tests can reach it: no route, CLI or development endpoint', async () => {
      const root = resolve(import.meta.dirname, '../src')
      const files: string[] = []
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) await walk(path)
          else if (entry.name.endsWith('.ts')) files.push(path)
        }
      }
      await walk(root)
      const reaching: string[] = []
      for (const file of files) {
        if (file.endsWith(join('world', 'properties.ts'))) continue
        const text = await readFile(file, 'utf8')
        if (/world\/properties|\.\/properties['"]|createWorldPropertyStore|createPropertyActivationService|world_properties/.test(text)) reaching.push(file.slice(root.length + 1))
      }
      // The store reads world_properties (parity) and verify reads it; neither writes. The local rehearsal composes the
      // activation service, and main builds the property store for it and for nothing else. Nothing else names it.
      expect(reaching.sort()).toEqual(['main.ts', join('world', 'rehearsal.ts'), join('world', 'store.ts'), join('world', 'verify.ts')])
      for (const file of reaching) expect(await readFile(join(root, file), 'utf8')).not.toMatch(/INSERT INTO world_properties/)
      for (const file of [join('world', 'rehearsal.ts'), join('world', 'store.ts'), join('world', 'verify.ts')]) expect(await readFile(join(root, file), 'utf8')).not.toMatch(/createWorldPropertyStore/)
      // main builds it exactly once, inside the block that only runs with the local rehearsal file (refused outside local mode).
      const main = await readFile(join(root, 'main.ts'), 'utf8')
      expect(main.match(/createWorldPropertyStore\(/g)).toHaveLength(1)
      const block = main.slice(main.indexOf('if (config.localRehearsalFile && playSessions && db) {'))
      expect(block.indexOf('createWorldPropertyStore(')).toBeGreaterThan(0)
      expect(block.indexOf('createWorldPropertyStore(')).toBeLessThan(block.indexOf('\n  }\n'))
      // The rehearsal refuses to exist outside local mode, and the app mounts its routes only in local mode.
      expect(await readFile(join(root, 'world', 'rehearsal.ts'), 'utf8')).toMatch(/if \(mode !== 'local'\) throw/)
      expect(await readFile(join(root, 'app.ts'), 'utf8')).toMatch(/const rehearsal = config\.mode === 'local' && playSessions \? \(deps\.rehearsal \?\? null\) : null/)
    })
  })
})
