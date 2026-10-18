import { emptyWorldCityState, judgeWorldConfig } from '../src/engine'
import { canonicalHash } from '../src/play/canonical'
import { PlayApiError, type PlayConfigVersion, type PlayGameReader, type PlayInstallation, type PlayRun } from '../src/play/client'
import { uuidv7 } from '../src/world/ids'
import { WorldRefusal, type ConfirmActive, type VerifiedLaunch, type WorldScope, type WorldStore } from '../src/world/store'
import { PlaySessionError, type LivePlaySession, type NewPlaySession, type PlaySessionStore } from '../src/play/session'

/** Two brand documents in Rare City's Play schema v1 (a small one and the reference one). */
export const DOC_A = {
  cityName: 'Harborlight',
  brand: { name: 'Harborlight Collective', logo: '/brand-media/samples/harborlight-logo.svg' },
  capital: { name: 'Beacon Hall', crest: null },
  collections: [{ key: 'harbor-keepers', chain: 'eip155:8453', contract: '0x000000000000000000000000000000000000a001', displayName: 'Harbor Keepers' }],
  districts: [
    { key: 'lantern-quay', name: 'Lantern Quay', accent: '#ff9f43', monument: { collection: 'harbor-keepers', tokenId: '1004', artwork: null }, proofyRule: null },
    { key: 'tidewater', name: 'Tidewater', accent: '#2ec4b6', monument: null, proofyRule: null },
    { key: 'compass-row', name: 'Compass Row', accent: '#5aa9ff', monument: null, proofyRule: { verificationRuleId: 41, label: 'Verified Captain role' } },
  ],
}

export const DOC_B = { ...DOC_A, cityName: 'Neon Orchard', districts: DOC_A.districts.map((d, i) => ({ ...d, key: ['plum', 'citrus', 'fig'][i], name: ['Plum', 'Citrus', 'Fig'][i] })) }

export const INSTALLATION_A = '01a14800-0000-7000-8000-00000000000a'
export const INSTALLATION_B = '01a14800-0000-7000-8000-00000000000b'
export const GUILD_A = '900000000000000001'
export const GUILD_B = '900000000000000002'
/** Two Discord users. Ada is who a fake launch is for unless it says otherwise. */
export const ADA = { discordUserId: '111111111111111111', coreUserId: 'core-ada', displayName: 'Ada' }
export const BEA = { discordUserId: '222222222222222222', coreUserId: 'core-bea', displayName: 'Bea' }
/** Shaped like a Play run token; the fake only looks it up. */
export const token = (name: string) => `eyJhbGciOiJFZERTQSJ9.${Buffer.from(name).toString('base64url').padEnd(12, 'x')}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`

interface FakeInstallation extends PlayInstallation {
  versions: PlayConfigVersion[]
}

/**
 * An in-memory Play for the launch path's tests: installations with immutable numbered
 * versions, runs pinned at launch, single-use redemption, Play's error codes. `tamper` makes
 * it answer wrongly in one specific way, to prove the launch path checks rather than trusts.
 */
export function fakePlay() {
  const installations = new Map<string, FakeInstallation>()
  const runs = new Map<string, PlayRun & { redeemed: boolean; expired?: boolean }>()
  const calls: string[] = []
  const tamper: {
    run?: Partial<PlayRun>
    installation?: Partial<PlayInstallation>
    version?: Partial<PlayConfigVersion>
    fail?: { method: 'redeemRun' | 'getInstallation' | 'getConfigVersion'; status: number; code: string }
  } = {}

  const fail = (method: string) => {
    if (tamper.fail?.method === method) throw new PlayApiError(tamper.fail.status, tamper.fail.code, 'refused')
  }

  const play: PlayGameReader = {
    async redeemRun(runToken) {
      calls.push('redeemRun')
      fail('redeemRun')
      const run = runs.get(runToken)
      if (!run) throw new PlayApiError(422, 'run_token_invalid', 'refused')
      if (run.expired) throw new PlayApiError(409, 'run_expired', 'refused')
      if (run.redeemed) throw new PlayApiError(409, 'run_already_redeemed', 'refused')
      run.redeemed = true
      const ctx: PlayRun = { runId: run.runId, installationId: run.installationId, gameKey: run.gameKey, discordGuildId: run.discordGuildId, player: run.player, configVersion: run.configVersion, configHash: run.configHash, runExpiresAt: run.runExpiresAt }
      return { ...ctx, ...tamper.run }
    },
    async getInstallation(id) {
      calls.push(`getInstallation ${id}`)
      fail('getInstallation')
      const i = installations.get(id)
      if (!i) throw new PlayApiError(404, 'installation_not_found', 'refused')
      const dto: PlayInstallation = { id: i.id, gameKey: i.gameKey, discordGuildId: i.discordGuildId, status: i.status, activeConfigVersion: i.activeConfigVersion, activeConfigHash: i.activeConfigHash }
      return { ...dto, ...tamper.installation }
    },
    async getConfigVersion(id, version) {
      calls.push(`getConfigVersion ${id} ${version}`)
      fail('getConfigVersion')
      const i = installations.get(id)
      if (!i) throw new PlayApiError(404, 'installation_not_found', 'refused')
      const v = i.versions.find((x) => x.version === version)
      if (!v) throw new PlayApiError(404, 'config_version_not_found', 'refused')
      return { ...structuredClone(v), ...tamper.version }
    },
  }

  return {
    play,
    calls,
    tamper,
    install(id: string, guild: string) {
      installations.set(id, { id, gameKey: 'rare-city', discordGuildId: guild, status: 'active', activeConfigVersion: null, activeConfigHash: null, versions: [] })
    },
    /** Create a version without activating it. */
    create(id: string, config: Record<string, unknown>, schemaVersion = 1) {
      const i = installations.get(id)!
      const version = i.versions.length + 1
      const configHash = canonicalHash(config)
      i.versions.push({ installationId: id, version, schemaVersion, configHash, config: structuredClone(config) })
      return { version, configHash }
    },
    /** Make a version the active one (Play may re-activate an earlier version). */
    activate(id: string, version: number) {
      const i = installations.get(id)!
      const v = i.versions.find((x) => x.version === version)!
      i.activeConfigVersion = v.version
      i.activeConfigHash = v.configHash
    },
    /** Create and activate a version, as an admin would. */
    publish(id: string, config: Record<string, unknown>, schemaVersion = 1) {
      const created = this.create(id, config, schemaVersion)
      this.activate(id, created.version)
      return created
    },
    setStatus(id: string, status: PlayInstallation['status']) {
      installations.get(id)!.status = status
    },
    /** A player launches: the run is pinned to the active version now. */
    launch(id: string, name: string, options: { gameKey?: string; expired?: boolean; player?: PlayRun['player']; runExpiresAt?: string } = {}) {
      const i = installations.get(id)!
      const runToken = token(name)
      runs.set(runToken, {
        runId: `01a14800-0000-7000-8000-${String(runs.size + 1).padStart(12, '0')}`,
        installationId: id,
        gameKey: options.gameKey ?? 'rare-city',
        discordGuildId: i.discordGuildId,
        player: options.player ?? ADA,
        configVersion: i.activeConfigVersion!,
        configHash: i.activeConfigHash!,
        // Two hours from now, like Play's default maxRunSeconds.
        runExpiresAt: options.runExpiresAt ?? new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        redeemed: false,
        expired: options.expired,
      })
      return runToken
    },
  }
}

/**
 * A stand-in for the world store, for launch-path tests that need no database: one world per
 * installation, kept in memory, judged with the same pure judge the real store uses. It
 * records exactly what the launch path handed it. The real store is tested against Postgres
 * (world.db.test.ts).
 */
export function memoryWorlds() {
  const worlds = new Map<string, string>()
  /** world id -> the launch that last opened it, and the world it got. */
  const byWorld = new Map<string, { launch: VerifiedLaunch; world: Awaited<ReturnType<WorldStore['open']>>['world'] }>()
  const opened: VerifiedLaunch[] = []
  const read: WorldScope[] = []
  const confirms: ConfirmActive[] = []
  const store: WorldStore & { fail?: Error } = {
    async read(scope) {
      read.push(structuredClone(scope))
      if (store.fail) throw store.fail
      const known = byWorld.get(scope.worldId)
      const l = known?.launch
      if (!known || !l || l.environment !== scope.environment || l.gameKey !== scope.gameKey || l.installationId !== scope.installationId || l.discordGuildId !== scope.discordGuildId)
        throw new WorldRefusal('world_unavailable', 'not bound')
      return { world: { ...known.world, created: false }, governing: { version: l.pinned.version, schemaVersion: l.pinned.schemaVersion, configHash: l.pinned.configHash, config: structuredClone(l.pinned.config) } }
    },
    async open(launch, confirmActive) {
      opened.push(structuredClone(launch))
      confirms.push(confirmActive)
      if (store.fail) throw store.fail
      const known = worlds.get(launch.installationId)
      const id = known ?? uuidv7()
      const judged = judgeWorldConfig(launch.pinned.config, id, null)
      if (judged.verdict === 'rejected') throw new WorldRefusal(judged.code, 'refused', judged.problems)
      worlds.set(launch.installationId, id)
      const result: Awaited<ReturnType<WorldStore['open']>> = {
        cityId: `world:${id}`,
        instance: '00000000-0000-4000-8000-000000000000',
        accepted: judged,
        world: {
          id,
          provisioned: true,
          created: !known,
          foundedAt: '2026-10-17T00:00:00.000Z',
          sequence: 1,
          definition: { foundingConfigVersion: 1, governingConfigVersion: launch.pinned.version, layoutKey: judged.foundation.layout.key, geometryFingerprint: judged.foundation.layout.geometryFingerprint },
          state: emptyWorldCityState(),
        },
      }
      byWorld.set(id, { launch: structuredClone(launch), world: result.world })
      return result
    },
  }
  return { store, opened, read, confirms, worlds }
}

/**
 * Play sessions kept in memory, for HTTP tests that need no database. The same rules as the Postgres store
 * (one session per run, retire on relaunch, live by expiry and revocation, scoped to environment and game);
 * the Postgres store itself is tested in play.session.db.test.ts.
 */
export function memorySessions() {
  const rows: (NewPlaySession & { revokedAt: Date | null })[] = []
  const store: PlaySessionStore & { fail?: Error } = {
    async insert(s, retiring) {
      if (store.fail) throw store.fail
      if (rows.some((r) => r.scope.environment === s.scope.environment && r.runId === s.runId)) throw new PlaySessionError(409, 'run_already_used')
      if (retiring) for (const r of rows) if (r.tokenHash.equals(retiring) && !r.revokedAt) r.revokedAt = s.createdAt
      rows.push({ ...s, revokedAt: null })
    },
    async find(hash, at, environment, gameKey): Promise<LivePlaySession | null> {
      if (store.fail) throw store.fail
      const r = rows.find((x) => x.tokenHash.equals(hash) && !x.revokedAt && x.expiresAt > at && x.expiresAt.getTime() > Date.now() && x.scope.environment === environment && x.scope.gameKey === gameKey)
      return r ? { id: r.id, scope: structuredClone(r.scope), player: { ...r.player }, createdAt: r.createdAt, expiresAt: r.expiresAt } : null
    },
    async revoke(by, at) {
      for (const r of rows) if (!r.revokedAt && ('id' in by ? r.id === by.id : r.tokenHash.equals(by.tokenHash))) r.revokedAt = at
    },
    async tidy() {},
  }
  return { store, rows }
}
