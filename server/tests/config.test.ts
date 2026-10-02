import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config'

const DB = 'postgres://user:hunter2@db.internal:5432/rarecity'

describe('server config', () => {
  it('defaults to local mode with no database, bound to loopback', () => {
    expect(loadConfig({})).toEqual({ mode: 'local', port: 8787, host: '127.0.0.1', databaseUrl: null, commit: null })
  })

  it('reads staging and production with their database and platform values', () => {
    const cfg = loadConfig({ APP_MODE: 'staging', NODE_ENV: 'production', PORT: '3000', DATABASE_URL: DB, RAILWAY_GIT_COMMIT_SHA: 'abc123' })
    expect(cfg).toEqual({ mode: 'staging', port: 3000, host: '0.0.0.0', databaseUrl: DB, commit: 'abc123' })
    expect(loadConfig({ APP_MODE: 'production', DATABASE_URL: DB.replace('postgres:', 'postgresql:') }).mode).toBe('production')
    expect(loadConfig({ APP_MODE: 'local', DATABASE_URL: DB, HOST: '::' })).toMatchObject({ mode: 'local', databaseUrl: DB, host: '::' })
  })

  it('requires a database outside local mode', () => {
    for (const mode of ['staging', 'production']) expect(() => loadConfig({ APP_MODE: mode })).toThrow(`DATABASE_URL is required when APP_MODE=${mode}.`)
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
})
