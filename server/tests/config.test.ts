import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config'

const DB = 'postgres://user:hunter2@db.internal:5432/rarecity'
const ORIGIN = 'https://rarecity.example'

describe('server config', () => {
  it('defaults to local mode with no database, bound to loopback', () => {
    expect(loadConfig({})).toEqual({ mode: 'local', port: 8787, host: '127.0.0.1', databaseUrl: null, commit: null, publicOrigin: 'http://127.0.0.1:8787', rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', ownership: 'robinhood', trustedProxy: 'none', rateLimits: true, frameAncestors: [], hstsMaxAge: 0 })
  })

  it('reads staging and production with their database and platform values', () => {
    const cfg = loadConfig({ APP_MODE: 'staging', NODE_ENV: 'production', PORT: '3000', DATABASE_URL: DB, RAILWAY_GIT_COMMIT_SHA: 'abc123', PUBLIC_ORIGIN: ORIGIN, TRUSTED_PROXY: 'railway' })
    expect(cfg).toEqual({ mode: 'staging', port: 3000, host: '0.0.0.0', databaseUrl: DB, commit: 'abc123', publicOrigin: ORIGIN, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', ownership: 'robinhood', trustedProxy: 'railway', rateLimits: true, frameAncestors: [], hstsMaxAge: 31_536_000 })
    expect(loadConfig({ APP_MODE: 'production', DATABASE_URL: DB.replace('postgres:', 'postgresql:'), PUBLIC_ORIGIN: ORIGIN, TRUSTED_PROXY: 'railway' }).mode).toBe('production')
    expect(loadConfig({ APP_MODE: 'local', DATABASE_URL: DB, HOST: '::' })).toMatchObject({ mode: 'local', databaseUrl: DB, host: '::' })
  })

  it('requires a database outside local mode', () => {
    for (const mode of ['staging', 'production']) expect(() => loadConfig({ APP_MODE: mode, PUBLIC_ORIGIN: ORIGIN })).toThrow(`DATABASE_URL is required when APP_MODE=${mode}.`)
  })

  it('never lets a deployed process fall back to local mode', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: DB })).toThrow(/APP_MODE must be set/)
  })

  it('rejects unknown modes and bad ports', () => {
    expect(() => loadConfig({ APP_MODE: 'prod' })).toThrow(ConfigError)
    for (const PORT of ['0', '70000', '80.5', 'abc', '-1']) expect(() => loadConfig({ PORT })).toThrow(/PORT must be/)
  })

  it('rejects a malformed database URL without echoing the secret', () => {
    for (const DATABASE_URL of ['mysql://user:hunter2@host/db', 'user:hunter2@host']) {
      let message = ''
      try {
        loadConfig({ DATABASE_URL })
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toMatch(/DATABASE_URL/)
      expect(message).not.toContain('hunter2')
    }
  })

  it('requires an explicit https public origin outside local mode', () => {
    for (const mode of ['staging', 'production']) {
      expect(() => loadConfig({ APP_MODE: mode, DATABASE_URL: DB })).toThrow(`PUBLIC_ORIGIN is required when APP_MODE=${mode}`)
      expect(() => loadConfig({ APP_MODE: mode, DATABASE_URL: DB, PUBLIC_ORIGIN: 'http://rarecity.example' })).toThrow(/must be https/)
    }
    expect(loadConfig({ APP_MODE: 'staging', DATABASE_URL: DB, PUBLIC_ORIGIN: 'https://RareCity.example:443/', TRUSTED_PROXY: 'railway' }).publicOrigin).toBe(ORIGIN)
  })

  it('accepts only a bare origin, and derives the local one from host and port', () => {
    for (const PUBLIC_ORIGIN of ['rarecity.example', 'ftp://rarecity.example', 'https://rarecity.example/app', 'https://rarecity.example/?x=1', 'https://user:pw@rarecity.example', 'https://rarecity.example/#top'])
      expect(() => loadConfig({ PUBLIC_ORIGIN }), PUBLIC_ORIGIN).toThrow(/PUBLIC_ORIGIN/)
    expect(loadConfig({ PORT: '4319' }).publicOrigin).toBe('http://127.0.0.1:4319')
    expect(loadConfig({ HOST: '::1', PORT: '9000' }).publicOrigin).toBe('http://[::1]:9000')
    expect(loadConfig({ PUBLIC_ORIGIN: 'http://localhost:8787' }).publicOrigin).toBe('http://localhost:8787')
  })

  it('takes the RPC endpoint from ROBINHOOD_RPC_URL without ever echoing it', () => {
    const secret = 'https://robinhood.provider.example/v2/s3cr3t-key'
    expect(loadConfig({ ROBINHOOD_RPC_URL: secret }).rpcUrl).toBe(secret)
    for (const ROBINHOOD_RPC_URL of ['wss://provider.example/s3cr3t-key', 'provider.example/s3cr3t-key']) {
      let message = ''
      try {
        loadConfig({ ROBINHOOD_RPC_URL })
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toMatch(/ROBINHOOD_RPC_URL/)
      expect(message).not.toContain('s3cr3t')
    }
  })

  it('requires the RPC endpoint to be https outside local mode', () => {
    for (const mode of ['staging', 'production'])
      expect(() => loadConfig({ APP_MODE: mode, DATABASE_URL: DB, PUBLIC_ORIGIN: ORIGIN, ROBINHOOD_RPC_URL: 'http://rpc.example/s3cr3t-key' })).toThrow(`ROBINHOOD_RPC_URL must be https:// when APP_MODE=${mode}.`)
    expect(loadConfig({ APP_MODE: 'staging', DATABASE_URL: DB, PUBLIC_ORIGIN: ORIGIN, TRUSTED_PROXY: 'railway', ROBINHOOD_RPC_URL: 'https://rpc.example/key' }).rpcUrl).toBe('https://rpc.example/key')
    expect(loadConfig({ ROBINHOOD_RPC_URL: 'http://127.0.0.1:8545' }).rpcUrl).toBe('http://127.0.0.1:8545')
  })

  it('reads ownership from the chain unless a local process asks for the fixture', () => {
    expect(loadConfig({ OWNERSHIP_PROVIDER: 'fixture' }).ownership).toBe('fixture')
    expect(loadConfig({ OWNERSHIP_PROVIDER: 'robinhood' }).ownership).toBe('robinhood')
    expect(() => loadConfig({ OWNERSHIP_PROVIDER: 'opensea' })).toThrow(/OWNERSHIP_PROVIDER must be one of/)
    for (const mode of ['staging', 'production'])
      expect(() => loadConfig({ APP_MODE: mode, DATABASE_URL: DB, PUBLIC_ORIGIN: ORIGIN, OWNERSHIP_PROVIDER: 'fixture' })).toThrow(`OWNERSHIP_PROVIDER=fixture is only allowed when APP_MODE=local, not ${mode}.`)
  })

  it('never infers proxy trust: staging and production must state it', () => {
    for (const mode of ['staging', 'production']) {
      const deployed = { APP_MODE: mode, DATABASE_URL: DB, PUBLIC_ORIGIN: ORIGIN }
      expect(() => loadConfig(deployed)).toThrow(`TRUSTED_PROXY is required when APP_MODE=${mode}: one of none, railway.`)
      expect(() => loadConfig({ ...deployed, TRUSTED_PROXY: ' ' })).toThrow(/TRUSTED_PROXY is required/)
      // Platform variables that happen to be present are not a statement of trust.
      expect(() => loadConfig({ ...deployed, RAILWAY_ENVIRONMENT: 'staging', RAILWAY_PUBLIC_DOMAIN: 'rarecity.example' })).toThrow(/TRUSTED_PROXY is required/)
      expect(loadConfig({ ...deployed, TRUSTED_PROXY: 'railway' }).trustedProxy).toBe('railway')
      expect(loadConfig({ ...deployed, TRUSTED_PROXY: 'none' }).trustedProxy).toBe('none')
    }
    expect(loadConfig({}).trustedProxy).toBe('none')
    expect(loadConfig({ TRUSTED_PROXY: 'railway' }).trustedProxy).toBe('railway')
    for (const TRUSTED_PROXY of ['Railway', 'cloudflare', 'true', '1', 'x-forwarded-for', 'none,railway']) expect(() => loadConfig({ TRUSTED_PROXY }), TRUSTED_PROXY).toThrow('TRUSTED_PROXY must be one of: none, railway.')
  })

  it('only lets a local process run without rate limits', () => {
    expect(loadConfig({ RATE_LIMITS: 'off' }).rateLimits).toBe(false)
    expect(loadConfig({ RATE_LIMITS: 'on' }).rateLimits).toBe(true)
    for (const RATE_LIMITS of ['false', '0', 'no', 'OFF', 'disabled']) expect(() => loadConfig({ RATE_LIMITS }), RATE_LIMITS).toThrow('RATE_LIMITS must be on or off.')
    for (const mode of ['staging', 'production']) {
      const deployed = { APP_MODE: mode, DATABASE_URL: DB, PUBLIC_ORIGIN: ORIGIN, TRUSTED_PROXY: 'railway' }
      expect(() => loadConfig({ ...deployed, RATE_LIMITS: 'off' })).toThrow(`RATE_LIMITS=off is only allowed when APP_MODE=local, not ${mode}.`)
      expect(loadConfig({ ...deployed, RATE_LIMITS: 'on' }).rateLimits).toBe(true)
    }
  })

  it('accepts only exact https origins as frame ancestors, and none by default', () => {
    expect(loadConfig({}).frameAncestors).toEqual([])
    expect(loadConfig({ FRAME_ANCESTORS: '  ' }).frameAncestors).toEqual([])
    expect(loadConfig({ FRAME_ANCESTORS: 'https://rarefriends.example' }).frameAncestors).toEqual(['https://rarefriends.example'])
    expect(loadConfig({ FRAME_ANCESTORS: 'https://a.example, https://b.example:8443\thttps://a.example' }).frameAncestors).toEqual(['https://a.example', 'https://b.example:8443'])
    const refused = [
      'http://rarefriends.example',
      'rarefriends.example',
      '//rarefriends.example',
      'https://*.rarefriends.example',
      'https://*',
      '*',
      "'self'",
      "'none'",
      'https:',
      'https://rarefriends.example/',
      'https://rarefriends.example/embed',
      'https://rarefriends.example?x=1',
      'https://rarefriends.example#top',
      'https://user:pw@rarefriends.example',
      'https://RareFriends.example',
      'https://rarefriends.example:443',
      'https://rarefriends.example.',
      "https://rarefriends.example;script-src",
      "https://a.example;script-src%20'unsafe-inline'",
      'https://a.example https://*.b.example',
      'wss://rarefriends.example',
      'https://self',
      'https://none',
      'https://localhost',
      'https://rare..example',
      'https://-rare.example',
      'https://rare-.example',
      'https://[2001:db8::1]',
      'https://rarefriends.example:*',
      'https://rarefriends.example\r\nx-injected: 1',
      'data:text/html,x',
    ]
    for (const FRAME_ANCESTORS of refused) expect(() => loadConfig({ FRAME_ANCESTORS }), FRAME_ANCESTORS).toThrow(/^FRAME_ANCESTORS/)
    expect(() => loadConfig({ FRAME_ANCESTORS: Array.from({ length: 17 }, (_, i) => `https://p${i}.example`).join(' ') })).toThrow('FRAME_ANCESTORS lists more than 16 origins.')
  })

  it('starts production HSTS at one day, staging at a year, and takes an explicit lifetime', () => {
    const deployed = { DATABASE_URL: DB, PUBLIC_ORIGIN: ORIGIN, TRUSTED_PROXY: 'railway' }
    expect(loadConfig({ ...deployed, APP_MODE: 'production' }).hstsMaxAge).toBe(86_400)
    expect(loadConfig({ ...deployed, APP_MODE: 'staging' }).hstsMaxAge).toBe(31_536_000)
    expect(loadConfig({ ...deployed, APP_MODE: 'production', HSTS_MAX_AGE: '31536000' }).hstsMaxAge).toBe(31_536_000)
    expect(loadConfig({ ...deployed, APP_MODE: 'production', HSTS_MAX_AGE: '0' }).hstsMaxAge).toBe(0)
    for (const HSTS_MAX_AGE of ['-1', '1.5', '1d', 'max', '63072001', '99999999999999999999', '86400; includeSubDomains', '86400; preload']) expect(() => loadConfig({ HSTS_MAX_AGE }), HSTS_MAX_AGE).toThrow(/^HSTS_MAX_AGE must be/)
  })
})
