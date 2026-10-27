import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig, secureTransport } from '../src/config'

/**
 * THE HOSTED PREVIEW PROFILE (LOCAL_HOSTED_PREVIEW=true): what it requires, every combination it refuses, and that
 * ordinary local, staging and production configuration is exactly what it was.
 */
const DB = 'postgres://user:hunter2@preview-db.railway.internal:5432/districts_preview'
const ORIGIN = 'https://districts-preview.example'
const PASSWORD = 'k3Qx-preview-password-generated-at-random-9f2c'
const HASH = createHash('sha256').update(PASSWORD).digest('hex')
const dev = (env: string) => `ppk_${env}_${'a1'.repeat(12)}.${'b2'.repeat(32)}`

/** A complete, valid preview, as Railway would run it. */
const PREVIEW: Record<string, string> = {
  LOCAL_HOSTED_PREVIEW: 'true',
  APP_MODE: 'local',
  NODE_ENV: 'production',
  PORT: '8080',
  PUBLIC_ORIGIN: ORIGIN,
  TRUSTED_PROXY: 'railway',
  DATABASE_URL: DB,
  PLAY_API_URL: 'http://proofy-play-dev.railway.internal:8080',
  PLAY_SERVICE_CREDENTIAL: dev('dev'),
  LOCAL_PROPERTY_REHEARSAL_FILE: 'hosted-preview/rehearsal-controller-a.json',
  PREVIEW_ACCESS_USER: 'preview',
  PREVIEW_ACCESS_PASSWORD_SHA256: HASH,
  RAILWAY_ENVIRONMENT_ID: 'env-id',
  RAILWAY_PROJECT_ID: 'project-id',
  RAILWAY_SERVICE_ID: 'service-id',
}

const without = (...names: string[]) => Object.fromEntries(Object.entries(PREVIEW).filter(([k]) => !names.includes(k)))
const refusal = (env: Record<string, string | undefined>) => {
  try {
    loadConfig(env)
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError)
    return (err as Error).message
  }
  throw new Error('expected the configuration to be refused')
}

describe('hosted preview configuration', () => {
  it('accepts the complete profile: local mode on the wire as a deployed one, with its gate', () => {
    const cfg = loadConfig(PREVIEW)
    expect(cfg).toMatchObject({ mode: 'local', host: '0.0.0.0', port: 8080, publicOrigin: ORIGIN, trustedProxy: 'railway', rateLimits: true, hstsMaxAge: 31_536_000, activationEnabled: false, ownership: 'robinhood', frameAncestors: [], localRehearsalFile: 'hosted-preview/rehearsal-controller-a.json' })
    expect(cfg.play).toMatchObject({ environment: 'dev', gameKey: 'rare-city', apiUrl: 'http://proofy-play-dev.railway.internal:8080' })
    expect(cfg.hostedPreview?.accessUser).toBe('preview')
    expect(cfg.hostedPreview?.accessPasswordSha256.equals(Buffer.from(HASH, 'hex'))).toBe(true)
    expect(secureTransport(cfg)).toBe(true)
    // A TEST Play, https Play, an explicit HOST and HSTS lifetime, and an upper-case hash are all the same profile.
    expect(loadConfig({ ...PREVIEW, PLAY_SERVICE_CREDENTIAL: dev('test') }).play?.environment).toBe('test')
    expect(loadConfig({ ...PREVIEW, PLAY_API_URL: 'https://play-dev.example' }).play?.apiUrl).toBe('https://play-dev.example')
    expect(loadConfig({ ...PREVIEW, PLAY_API_URL: 'http://127.0.0.1:18090' }).play?.apiUrl).toBe('http://127.0.0.1:18090')
    expect(loadConfig({ ...PREVIEW, HOST: '::', HSTS_MAX_AGE: '86400' })).toMatchObject({ host: '::', hstsMaxAge: 86_400 })
    expect(loadConfig({ ...PREVIEW, PREVIEW_ACCESS_PASSWORD_SHA256: HASH.toUpperCase() }).hostedPreview?.accessPasswordSha256.toString('hex')).toBe(HASH)
    expect(loadConfig({ ...PREVIEW, LOCAL_HOSTED_PREVIEW: ' true ' }).hostedPreview).not.toBeNull()
    // Off Railway too (one machine, as the browser tests run it): the profile is the same.
    expect(loadConfig(without('RAILWAY_ENVIRONMENT_ID', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID')).hostedPreview).not.toBeNull()
  })

  it('refuses a flag that is not exactly true or false', () => {
    for (const LOCAL_HOSTED_PREVIEW of ['1', 'yes', 'on', 'TRUE', 'True', 'enabled'])
      expect(refusal({ ...PREVIEW, LOCAL_HOSTED_PREVIEW }), LOCAL_HOSTED_PREVIEW).toBe('LOCAL_HOSTED_PREVIEW must be true or false.')
  })

  it('refuses a gate without the flag, and a local process on Railway without the profile', () => {
    // The flag forgotten: the gate's variables alone would be a gate that is not there.
    for (const flag of [undefined, 'false', ''])
      expect(refusal({ ...PREVIEW, LOCAL_HOSTED_PREVIEW: flag }), String(flag)).toMatch(/^PREVIEW_ACCESS_USER is set but LOCAL_HOSTED_PREVIEW is not true/)
    expect(refusal({ PREVIEW_ACCESS_PASSWORD_SHA256: HASH })).toMatch(/^PREVIEW_ACCESS_PASSWORD_SHA256 is set but LOCAL_HOSTED_PREVIEW/)
    expect(refusal({ PREVIEW_ACCESS_PASSWORD: PASSWORD })).toMatch(/^PREVIEW_ACCESS_PASSWORD is set but LOCAL_HOSTED_PREVIEW/)
    // Everything forgotten: APP_MODE=local, as a developer runs it, but on Railway.
    for (const marker of ['RAILWAY_ENVIRONMENT_ID', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID']) {
      expect(refusal({ APP_MODE: 'local', [marker]: 'x' }), marker).toMatch(/^APP_MODE=local is running on Railway/)
      expect(refusal({ [marker]: 'x' }), marker).toMatch(/^APP_MODE=local is running on Railway/)
    }
  })

  it('refuses every missing or contradictory part of the profile', () => {
    const cases: [Record<string, string | undefined>, RegExp][] = [
      // The mode: stated, and local.
      [without('APP_MODE', 'NODE_ENV'), /APP_MODE must be set to local/],
      // With NODE_ENV=production the mode's own reader refuses first, as it always has.
      [without('APP_MODE'), /APP_MODE must be set to staging or production when NODE_ENV=production/],
      [{ ...PREVIEW, APP_MODE: 'Local' }, /APP_MODE must be one of/],
      [{ ...PREVIEW, APP_MODE: 'staging' }, /APP_MODE must be set to local/],
      [{ ...PREVIEW, APP_MODE: 'production' }, /APP_MODE must be set to local/],
      // The origin: stated, and https.
      [without('PUBLIC_ORIGIN'), /PUBLIC_ORIGIN must be set to the preview's https:\/\/ origin/],
      [{ ...PREVIEW, PUBLIC_ORIGIN: 'http://districts-preview.example' }, /PUBLIC_ORIGIN must be set to the preview's https:\/\/ origin/],
      // The proxy: Railway's edge, stated.
      [without('TRUSTED_PROXY'), /TRUSTED_PROXY must be railway/],
      [{ ...PREVIEW, TRUSTED_PROXY: 'none' }, /TRUSTED_PROXY must be railway/],
      // Limits, HSTS, framing, activation, wallet fixtures.
      [{ ...PREVIEW, RATE_LIMITS: 'off' }, /RATE_LIMITS must be on/],
      [{ ...PREVIEW, HSTS_MAX_AGE: '0' }, /HSTS_MAX_AGE must be greater than 0/],
      [{ ...PREVIEW, FRAME_ANCESTORS: 'https://discord.example' }, /FRAME_ANCESTORS is not supported/],
      [{ ...PREVIEW, ACTIVATION_ENABLED: 'true' }, /ACTIVATION_ENABLED must not be true/],
      [{ ...PREVIEW, OWNERSHIP_PROVIDER: 'fixture' }, /OWNERSHIP_PROVIDER=fixture is refused: legacy wallet-fixture authentication/],
      // Play: connected, DEV or TEST, over https or a private network.
      [without('PLAY_API_URL', 'PLAY_SERVICE_CREDENTIAL', 'LOCAL_PROPERTY_REHEARSAL_FILE'), /PLAY_API_URL and PLAY_SERVICE_CREDENTIAL must name a DEV or TEST Proofy Play/],
      [{ ...PREVIEW, PLAY_SERVICE_CREDENTIAL: dev('live') }, /minted for Play environment live; APP_MODE=local may only use dev or test/],
      [{ ...PREVIEW, PLAY_SERVICE_CREDENTIAL: dev('staging') }, /minted for Play environment staging/],
      [{ ...PREVIEW, PLAY_API_URL: 'http://play-dev.example' }, /PLAY_API_URL must be https:\/\/, or http:\/\/ only to a \*\.railway\.internal or loopback host/],
      [{ ...PREVIEW, PLAY_API_URL: 'http://railway.internal.example' }, /PLAY_API_URL must be https:\/\//],
      // The synthetic world.
      [without('LOCAL_PROPERTY_REHEARSAL_FILE'), /LOCAL_PROPERTY_REHEARSAL_FILE must name the synthetic preview world/],
      [without('DATABASE_URL'), /PLAY_API_URL needs DATABASE_URL/],
      // The gate: both parts, a hash and never the password.
      [without('PREVIEW_ACCESS_USER'), /PREVIEW_ACCESS_USER and PREVIEW_ACCESS_PASSWORD_SHA256 must both be set/],
      [without('PREVIEW_ACCESS_PASSWORD_SHA256'), /PREVIEW_ACCESS_USER and PREVIEW_ACCESS_PASSWORD_SHA256 must both be set/],
      [{ ...PREVIEW, PREVIEW_ACCESS_PASSWORD: PASSWORD }, /PREVIEW_ACCESS_PASSWORD is refused: configure only its SHA-256/],
      [{ ...PREVIEW, PREVIEW_ACCESS_USER: 'pre view' }, /PREVIEW_ACCESS_USER must be/],
      [{ ...PREVIEW, PREVIEW_ACCESS_USER: 'a:b' }, /PREVIEW_ACCESS_USER must be/],
      [{ ...PREVIEW, PREVIEW_ACCESS_PASSWORD_SHA256: HASH.slice(1) }, /PREVIEW_ACCESS_PASSWORD_SHA256 must be the 64-hex-digit SHA-256/],
      [{ ...PREVIEW, PREVIEW_ACCESS_PASSWORD_SHA256: createHash('sha256').update('').digest('hex') }, /PREVIEW_ACCESS_PASSWORD_SHA256 must be the 64-hex-digit SHA-256 of a non-empty/],
    ]
    for (const [env, expected] of cases) expect(refusal(env), expected.source).toMatch(expected)
  })

  it('never echoes a secret in a refusal', () => {
    const messages = [
      refusal({ ...PREVIEW, PREVIEW_ACCESS_PASSWORD: PASSWORD }),
      refusal({ ...PREVIEW, PREVIEW_ACCESS_PASSWORD_SHA256: `${HASH}0` }),
      refusal({ ...PREVIEW, PLAY_SERVICE_CREDENTIAL: dev('live') }),
      refusal({ ...PREVIEW, PLAY_SERVICE_CREDENTIAL: 'ppk_dev_not-a-credential' }),
      refusal({ ...PREVIEW, TRUSTED_PROXY: 'none' }),
      refusal({ ...PREVIEW, LOCAL_HOSTED_PREVIEW: undefined }),
    ]
    for (const message of messages) for (const secret of [PASSWORD, HASH, 'hunter2', 'b2b2b2b2']) expect(message).not.toContain(secret)
  })

  it('leaves ordinary local, staging and production configuration as it was', () => {
    // Local: loopback, plain http, no HSTS, no gate, fixtures and RATE_LIMITS=off still allowed for the test suites.
    const local = loadConfig({})
    expect(local).toMatchObject({ mode: 'local', host: '127.0.0.1', publicOrigin: 'http://127.0.0.1:8787', hstsMaxAge: 0, trustedProxy: 'none', hostedPreview: null })
    expect(secureTransport(local)).toBe(false)
    expect(loadConfig({ OWNERSHIP_PROVIDER: 'fixture', RATE_LIMITS: 'off', LOCAL_HOSTED_PREVIEW: 'false' })).toMatchObject({ ownership: 'fixture', rateLimits: false, hostedPreview: null })
    // The local Play browser suite's own environment (e2e-city-play/serve.ts) is untouched.
    const suite = { APP_MODE: 'local', NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:4352', OWNERSHIP_PROVIDER: 'fixture', RATE_LIMITS: 'off', TRUSTED_PROXY: 'none', DATABASE_URL: DB, PLAY_API_URL: 'http://127.0.0.1:18090', PLAY_SERVICE_CREDENTIAL: dev('dev'), LOCAL_PROPERTY_REHEARSAL_FILE: '/tmp/r.json' }
    expect(loadConfig(suite)).toMatchObject({ mode: 'local', hostedPreview: null, localRehearsalFile: '/tmp/r.json', hstsMaxAge: 0 })
    // Staging and production on Railway: unchanged, and the preview flag cannot be combined with them.
    for (const mode of ['staging', 'production']) {
      const deployed = { APP_MODE: mode, DATABASE_URL: DB, PUBLIC_ORIGIN: 'https://rarecity.example', TRUSTED_PROXY: 'railway', RAILWAY_SERVICE_ID: 'svc' }
      const cfg = loadConfig(deployed)
      expect(cfg).toMatchObject({ mode, host: '0.0.0.0', hostedPreview: null, hstsMaxAge: mode === 'production' ? 86_400 : 31_536_000 })
      expect(secureTransport(cfg)).toBe(true)
      expect(refusal({ ...deployed, LOCAL_HOSTED_PREVIEW: 'true' })).toMatch(/APP_MODE must be set to local/)
    }
  })
})
