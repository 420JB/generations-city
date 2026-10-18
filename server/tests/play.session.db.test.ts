import { randomBytes } from 'node:crypto'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthService, hashSessionToken } from '../src/auth/service'
import type { AppMode } from '../src/config'
import { migrate } from '../src/db/migrations'
import type { PlayEnvironment } from '../src/engine'
import { installDemoFixture } from '../src/fixtures/demoCity'
import { silentLogger } from '../src/log'
import { createPlayLaunchService } from '../src/play/launch'
import { createPlaySessionService, createPlaySessionStore, PlaySessionError, type NewPlaySession, type PlaySessionService } from '../src/play/session'
import { createWorldStore } from '../src/world/store'
import { addIdentity, snapshot } from './activationFixtures'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { ADA, BEA, DOC_A, DOC_B, fakePlay, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'

/** What GET /v1/play/city does: the session behind the cookie, then its city. */
const readCity = async (sessions: PlaySessionService, token: string) => sessions.city(await sessions.session(token))
const PLAY_ENV: Record<AppMode, PlayEnvironment> = { local: 'dev', staging: 'staging', production: 'live' }
/** Every table that existed before 0006. */
const BEFORE_0006 = { app_meta: 'key', city: 'id', city_events: 'city_id, sequence', activation_intents: 'id', properties: 'id', ownership_eras: 'id', users: 'id', wallets: 'id', sessions: 'id', auth_challenges: 'nonce', worlds: 'id', world_play_bindings: 'world_id', world_config_versions: 'world_id, version', world_config_adoptions: 'world_id, adoption_seq' }

describe.skipIf(NO_TEST_DATABASE)('play sessions against a disposable Postgres', () => {
  const t = useTestSchema()
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
  })

  async function migrationsThrough(last: number): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'rc-play-sessions-'))
    dirs.push(dir)
    for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()) if (Number(file.slice(0, 4)) <= last) await copyFile(join(MIGRATIONS_DIR, file), join(dir, file))
    return dir
  }

  /** Play with installations A and B, the real launch path and world store, and the real session store. */
  async function setup(options: { mode?: AppMode; migrated?: boolean; now?: () => Date } = {}) {
    const mode = options.mode ?? 'local'
    if (!options.migrated) await migrate(t.db, { dir: MIGRATIONS_DIR, environment: mode })
    const p = fakePlay()
    p.install(INSTALLATION_A, GUILD_A)
    p.install(INSTALLATION_B, GUILD_B)
    p.publish(INSTALLATION_A, DOC_A)
    p.publish(INSTALLATION_B, DOC_B)
    const environment = PLAY_ENV[mode]
    const worlds = createWorldStore(t.db, { mode, log: silentLogger })
    const launch = createPlayLaunchService({ play: p.play, environment, gameKey: 'rare-city', worlds })
    const store = createPlaySessionStore(t.db)
    const sessions = createPlaySessionService({ store, worlds, play: p.play, environment, gameKey: 'rare-city', log: silentLogger, now: options.now, installationCacheMs: 0 })
    /** Launch into `installation` as `player` and open the browser's session, as POST /v1/play/session does. */
    const open = async (installation: string, name: string, player = ADA, presented: string | null = null) => sessions.open(await launch.open({ runToken: p.launch(installation, name, { player }) }), presented)
    return { p, worlds, launch, store, sessions, open, environment }
  }

  const count = async (table: string, where = 'true', params: unknown[] = []) => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n
  const before0006 = async () => Object.fromEntries(await Promise.all(Object.entries(BEFORE_0006).map(async ([table, order]) => [table, await snapshot(t.db, table, order)])))

  describe('migration 0006', () => {
    it('adds the session table to a populated database and changes no existing row', async () => {
      await migrate(t.db, { dir: await migrationsThrough(5), environment: 'local' })
      // A Rare Friends city, a wallet user with a live session, and a founded world: everything 0006 must leave alone.
      await installDemoFixture(t.db, 'local')
      await addIdentity(t.db)
      const { open } = await setup({ migrated: true })
      // No sessions table yet: a launch founds the world, opening a session is what fails.
      await expect(open(INSTALLATION_A, 'a')).rejects.toMatchObject({ code: 'play_session_unavailable' })
      expect(await count('worlds')).toBe(1)
      const rows = await before0006()
      const applied = (await t.db.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')).rows

      expect(await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).toEqual({ applied: [6], current: 6 })
      expect(await before0006()).toEqual(rows)
      expect((await t.db.query('SELECT version, checksum, applied_at FROM schema_migrations WHERE version <= 5 ORDER BY version')).rows).toEqual(applied)
      expect(await count('play_sessions')).toBe(0)
      expect((await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).applied).toEqual([])
    })

    it('pins its guard to its own schema', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
      const { rows } = await t.db.query<{ config: string[] }>(`SELECT p.proconfig AS config FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = $1 AND p.proname = 'play_sessions_guard'`, [t.schema])
      expect(rows).toEqual([{ config: [`search_path=${t.schema}, pg_temp`] }])
    })
  })

  describe('the table guards a session', () => {
    async function oneSession() {
      const env = await setup()
      const opened = await env.open(INSTALLATION_A, 'a')
      const id = (await t.db.query<{ id: string }>('SELECT id FROM play_sessions')).rows[0].id
      return { ...env, opened, id }
    }

    it('keeps the player, the city, the credential and the lifetime it was opened with', async () => {
      const { id } = await oneSession()
      for (const [column, value] of [
        ['discord_user_id', BEA.discordUserId],
        ['core_user_id', 'someone'],
        ['display_name', 'Mallory'],
        ['play_installation_id', INSTALLATION_B],
        ['discord_guild_id', GUILD_B],
        ['expires_at', new Date(Date.now() + 86_400_000)],
        ['token_hash', randomBytes(32)],
        ['play_run_id', '01a14800-0000-7000-8000-0000000000ff'],
      ] as const) {
        await expect(t.db.query(`UPDATE play_sessions SET ${column} = $2 WHERE id = $1`, [id, value]), column).rejects.toThrow('a play session keeps the player, the city, the credential and the lifetime it was opened with')
      }
    })

    it('is revoked once, stays revoked, and cannot be removed while live', async () => {
      const { id } = await oneSession()
      await expect(t.db.query('DELETE FROM play_sessions WHERE id = $1', [id])).rejects.toThrow('a live play session cannot be removed')
      await t.db.query('UPDATE play_sessions SET revoked_at = now() WHERE id = $1', [id])
      await expect(t.db.query('UPDATE play_sessions SET revoked_at = NULL WHERE id = $1', [id])).rejects.toThrow('a revoked play session stays revoked')
      await expect(t.db.query(`UPDATE play_sessions SET revoked_at = now() + interval '1 day' WHERE id = $1`, [id])).rejects.toThrow('a revoked play session stays revoked')
      // Ended: it may be tidied away.
      await t.db.query('DELETE FROM play_sessions WHERE id = $1', [id])
      expect(await count('play_sessions')).toBe(0)
    })

    it('can only name a world through the binding that world has', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, 'a')
      const b = await env.open(INSTALLATION_B, 'b')
      const row = (s: Partial<NewPlaySession['scope']>, extra: Partial<NewPlaySession> = {}): NewPlaySession => ({
        tokenHash: randomBytes(32),
        scope: { worldId: a.response.world.id, environment: 'dev', gameKey: 'rare-city', installationId: INSTALLATION_A, discordGuildId: GUILD_A, ...s },
        player: ADA,
        runId: `01a14800-0000-7000-8000-${randomBytes(6).toString('hex')}`,
        launchConfig: { version: 1, configHash: 'a'.repeat(64) },
        runExpiresAt: new Date(Date.now() + 3_600_000),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        ...extra,
      })
      const fk = { code: '23503' }
      // World A with installation B's identity, B's guild, another environment or game, a world that does not exist.
      await expect(env.store.insert(row({ installationId: INSTALLATION_B }), null)).rejects.toMatchObject(fk)
      await expect(env.store.insert(row({ discordGuildId: GUILD_B }), null)).rejects.toMatchObject(fk)
      await expect(env.store.insert(row({ worldId: b.response.world.id }), null)).rejects.toMatchObject(fk)
      await expect(env.store.insert(row({ environment: 'test' }), null)).rejects.toMatchObject(fk)
      await expect(env.store.insert(row({ gameKey: 'other-game' }), null)).rejects.toMatchObject(fk)
      await expect(env.store.insert(row({ worldId: '01a14800-0000-7000-8000-000000000999' }), null)).rejects.toMatchObject(fk)
      // Opened already over, opened revoked, or outliving its run.
      await expect(env.store.insert(row({}, { createdAt: new Date(Date.now() - 7_200_000), expiresAt: new Date(Date.now() - 1_000) }), null)).rejects.toThrow('a play session cannot be opened already expired')
      await expect(env.store.insert(row({}, { runExpiresAt: new Date(Date.now() + 60_000) }), null)).rejects.toThrow(/play_sessions_within_run/)
      expect(await count('play_sessions')).toBe(2)
      await env.store.insert(row({}), null)
      expect(await count('play_sessions')).toBe(3)
    })
  })

  describe('opening and reading', () => {
    it('reads the persisted city of the session, with its governing configuration, after a reload', async () => {
      const env = await setup()
      const opened = await env.open(INSTALLATION_A, 'a')
      expect(opened.response.world.created).toBe(true)
      expect(await count('play_sessions')).toBe(1)
      const stored = (await t.db.query('SELECT * FROM play_sessions')).rows[0]
      expect(stored).toMatchObject({ world_id: opened.response.world.id, play_environment: 'dev', play_installation_id: INSTALLATION_A, discord_guild_id: GUILD_A, discord_user_id: ADA.discordUserId, core_user_id: ADA.coreUserId, display_name: 'Ada', revoked_at: null })
      expect(stored.token_hash).toEqual(hashSessionToken(opened.token))
      expect(JSON.stringify(stored)).not.toContain(opened.token)

      const read = await readCity(env.sessions, opened.token)
      expect(read.world).toEqual({ ...opened.response.world, created: false })
      expect(read.config).toEqual(DOC_A)
      expect(read.play).toEqual({ environment: 'dev', gameKey: 'rare-city', installationId: INSTALLATION_A, discordGuildId: GUILD_A, configVersion: 1, configHash: opened.response.play.configHash, schemaVersion: 1 })
      expect(read.viewer.player).toEqual(ADA)
      // Reading writes nothing: no world row, no event, no adoption.
      const worldRows = JSON.stringify(await Promise.all(['worlds', 'world_play_bindings', 'world_config_versions', 'world_config_adoptions', 'city', 'city_events'].map((x) => snapshot(t.db, x, '1'))))
      await readCity(env.sessions, opened.token)
      expect(JSON.stringify(await Promise.all(['worlds', 'world_play_bindings', 'world_config_versions', 'world_config_adoptions', 'city', 'city_events'].map((x) => snapshot(t.db, x, '1'))))).toBe(worldRows)
    })

    it('follows the configuration that governs the city now, not the version the session launched with', async () => {
      const env = await setup()
      const opened = await env.open(INSTALLATION_A, 'a')
      const v2 = { ...DOC_A, cityName: 'Harborlight Renewed' }
      env.p.publish(INSTALLATION_A, v2)
      // Another player's launch adopts version 2.
      await env.open(INSTALLATION_A, 'b', BEA)
      const read = await readCity(env.sessions, opened.token)
      expect([read.play.configVersion, read.world.definition.governingConfigVersion, read.world.definition.foundingConfigVersion]).toEqual([2, 2, 1])
      expect(read.config).toEqual(v2)
      expect(read.world.id).toBe(opened.response.world.id)
    })

    it('keeps installations and players apart', async () => {
      const env = await setup()
      const adaA = await env.open(INSTALLATION_A, 'a', ADA)
      const beaA = await env.open(INSTALLATION_A, 'b', BEA)
      const adaB = await env.open(INSTALLATION_B, 'c', ADA)
      const a1 = await readCity(env.sessions, adaA.token)
      const a2 = await readCity(env.sessions, beaA.token)
      const b1 = await readCity(env.sessions, adaB.token)
      expect(a1.world.id).toBe(a2.world.id)
      expect(b1.world.id).not.toBe(a1.world.id)
      expect([a1.viewer.player, a2.viewer.player, b1.viewer.player]).toEqual([ADA, BEA, ADA])
      expect([a1.play.installationId, b1.play.installationId]).toEqual([INSTALLATION_A, INSTALLATION_B])
      expect([a1.config, b1.config]).toEqual([DOC_A, DOC_B])
      // The same Discord user in two servers holds two sessions, each bound to its own city.
      expect(await count('play_sessions', 'discord_user_id = $1', [ADA.discordUserId])).toBe(2)
    })

    it('reads a world only through the exact binding it has', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, 'a')
      await env.open(INSTALLATION_B, 'b')
      const scope = { worldId: a.response.world.id, environment: 'dev' as const, gameKey: 'rare-city', installationId: INSTALLATION_A, discordGuildId: GUILD_A }
      expect((await env.worlds.read(scope)).world.id).toBe(scope.worldId)
      for (const wrong of [{ installationId: INSTALLATION_B }, { discordGuildId: GUILD_B }, { environment: 'test' as const }, { gameKey: 'other-game' }, { worldId: '01a14800-0000-7000-8000-000000000999' }])
        await expect(env.worlds.read({ ...scope, ...wrong }), JSON.stringify(wrong)).rejects.toMatchObject({ code: 'world_unavailable' })
    })

    it('opens one session per run, even if a run were redeemed twice', async () => {
      const env = await setup()
      const launched = await env.launch.open({ runToken: env.p.launch(INSTALLATION_A, 'a') })
      const first = await env.sessions.open(launched, null)
      // The retirement of the presented session is part of the same transaction, and rolls back with it.
      const again = await env.sessions.open(launched, first.token).then(
        () => null,
        (e: unknown) => e,
      )
      expect(again).toBeInstanceOf(PlaySessionError)
      expect((again as PlaySessionError).code).toBe('run_already_used')
      expect((await readCity(env.sessions, first.token)).viewer.player).toEqual(ADA)
      expect(await count('play_sessions')).toBe(1)
      // Concurrent opens of one run: exactly one session.
      const other = await env.launch.open({ runToken: env.p.launch(INSTALLATION_A, 'b') })
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => env.sessions.open(other, null)))
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected').map((r) => ((r as PromiseRejectedResult).reason as PlaySessionError).code)).toEqual(Array(7).fill('run_already_used'))
    })

    it('refuses an expired session by either clock, and a revoked one', async () => {
      let offset = 0
      const env = await setup({ now: () => new Date(Date.now() + offset) })
      const opened = await env.open(INSTALLATION_A, 'a')
      offset = 3 * 60 * 60_000
      await expect(readCity(env.sessions, opened.token)).rejects.toMatchObject({ status: 401, code: 'play_session_required' })
      offset = 0
      expect((await readCity(env.sessions, opened.token)).viewer.player).toEqual(ADA)
      // By the database's clock: a session whose expiry has passed there is over, whatever the service's clock says.
      await t.db.query(`ALTER TABLE play_sessions DISABLE TRIGGER USER`)
      await t.db.query(`UPDATE play_sessions SET created_at = now() - interval '2 hours', expires_at = clock_timestamp() - interval '1 second'`)
      await t.db.query(`ALTER TABLE play_sessions ENABLE TRIGGER USER`)
      offset = -3 * 60 * 60_000
      await expect(readCity(env.sessions, opened.token)).rejects.toMatchObject({ code: 'play_session_required' })
      offset = 0
      const second = await env.open(INSTALLATION_A, 'b')
      await env.sessions.logout(second.token)
      await expect(readCity(env.sessions, second.token)).rejects.toMatchObject({ code: 'play_session_required' })
    })

    it('is not read by a deployment of another Play environment, nor from a database stamped for another', async () => {
      const env = await setup()
      const opened = await env.open(INSTALLATION_A, 'a')
      const testEnv = createPlaySessionService({ store: env.store, worlds: env.worlds, play: env.p.play, environment: 'test', gameKey: 'rare-city', log: silentLogger })
      await expect(readCity(testEnv, opened.token)).rejects.toMatchObject({ code: 'play_session_required' })
      const otherGame = createPlaySessionService({ store: env.store, worlds: env.worlds, play: env.p.play, environment: 'dev', gameKey: 'other-game', log: silentLogger })
      await expect(readCity(otherGame, opened.token)).rejects.toMatchObject({ code: 'play_session_required' })
      // A world store for another APP_MODE refuses the database outright, so a session it was handed cannot be read either.
      const staging = createPlaySessionService({ store: env.store, worlds: createWorldStore(t.db, { mode: 'staging', log: silentLogger }), play: env.p.play, environment: 'dev', gameKey: 'rare-city', log: silentLogger })
      await expect(readCity(staging, opened.token)).rejects.toMatchObject({ status: 503, code: 'world_unavailable' })
    })

    it('leaves wallet sign-in and its sessions exactly as they were', async () => {
      const env = await setup()
      const auth = createAuthService({ db: t.db, publicOrigin: 'http://127.0.0.1:8787' })
      const wallet = await addIdentity(t.db)
      const walletRows = await snapshot(t.db, 'sessions', 'id')
      const identity = [await snapshot(t.db, 'users', 'id'), await snapshot(t.db, 'wallets', 'id')]
      const a = await env.open(INSTALLATION_A, 'a')
      const b = await env.open(INSTALLATION_A, 'b', BEA, a.token)
      await readCity(env.sessions, b.token)
      await env.sessions.logout(b.token)
      await env.store.tidy(new Date(Date.now() + 86_400_000))
      // No wallet user, wallet or session was made, changed or ended for a Play player.
      expect(await snapshot(t.db, 'sessions', 'id')).toBe(walletRows)
      expect([await snapshot(t.db, 'users', 'id'), await snapshot(t.db, 'wallets', 'id')]).toEqual(identity)
      // A play credential is not a wallet session, and a wallet session row is not a play session.
      expect(await auth.viewer(a.token)).toEqual({ authenticated: false })
      expect(await auth.session(a.token)).toBeNull()
      expect(wallet.sessionId).toBeTruthy()
    })

    it('tidies only sessions that ended long ago', async () => {
      const env = await setup()
      const live = await env.open(INSTALLATION_A, 'a')
      const ended = await env.open(INSTALLATION_A, 'b', BEA)
      await env.sessions.logout(ended.token)
      await env.store.tidy(new Date(Date.now() - 60_000))
      expect(await count('play_sessions')).toBe(2)
      await env.store.tidy(new Date(Date.now() + 60_000))
      expect(await count('play_sessions')).toBe(1)
      expect((await readCity(env.sessions, live.token)).viewer.player).toEqual(ADA)
    })

    it('ends the session when Play says the installation is suspended or uninstalled', async () => {
      const env = await setup()
      const opened = await env.open(INSTALLATION_A, 'a')
      env.p.setStatus(INSTALLATION_A, 'uninstalled')
      await expect(readCity(env.sessions, opened.token)).rejects.toMatchObject({ status: 403, code: 'installation_not_active' })
      expect(await count('play_sessions', 'revoked_at IS NOT NULL')).toBe(1)
      env.p.setStatus(INSTALLATION_A, 'active')
      await expect(readCity(env.sessions, opened.token)).rejects.toMatchObject({ code: 'play_session_required' })
    })
  })
})
