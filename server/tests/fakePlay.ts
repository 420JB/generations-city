import { canonicalHash } from '../src/play/canonical'
import { PlayApiError, type PlayConfigVersion, type PlayGameReader, type PlayInstallation, type PlayRun } from '../src/play/client'

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
    /** Create and activate a version, as an admin would. */
    publish(id: string, config: Record<string, unknown>, schemaVersion = 1) {
      const i = installations.get(id)!
      const version = i.versions.length + 1
      const configHash = canonicalHash(config)
      i.versions.push({ installationId: id, version, schemaVersion, configHash, config: structuredClone(config) })
      i.activeConfigVersion = version
      i.activeConfigHash = configHash
      return { version, configHash }
    },
    setStatus(id: string, status: PlayInstallation['status']) {
      installations.get(id)!.status = status
    },
    /** A player launches: the run is pinned to the active version now. */
    launch(id: string, name: string, options: { gameKey?: string; expired?: boolean } = {}) {
      const i = installations.get(id)!
      const runToken = token(name)
      runs.set(runToken, {
        runId: `01a14800-0000-7000-8000-${String(runs.size + 1).padStart(12, '0')}`,
        installationId: id,
        gameKey: options.gameKey ?? 'rare-city',
        discordGuildId: i.discordGuildId,
        player: { discordUserId: '111111111111111111', displayName: 'Ada' },
        configVersion: i.activeConfigVersion!,
        configHash: i.activeConfigHash!,
        runExpiresAt: '2026-10-17T12:00:00.000Z',
        redeemed: false,
        expired: options.expired,
      })
      return runToken
    },
  }
}
