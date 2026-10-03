import type { ServerConfig } from '../src/config'

/** The origin test servers claim to be reached at. */
export const TEST_ORIGIN = 'http://127.0.0.1:8787'

/** A complete ServerConfig for tests; pass only what a test cares about. */
export function testConfig(patch: Partial<ServerConfig> = {}): ServerConfig {
  return { mode: 'local', port: 0, host: '127.0.0.1', databaseUrl: null, commit: null, publicOrigin: TEST_ORIGIN, rpcUrl: 'http://127.0.0.1:1/rpc-not-used-in-tests', ownership: 'fixture', trustedProxy: 'none', rateLimits: true, frameAncestors: [], hstsMaxAge: 0, activationEnabled: false, ...patch }
}
