import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** What the hosted preview browser tests share: ports, the TEST access credential, and the committed synthetic world. */
export const SERVER_PORT = 4451
export const EDGE_PORT = 4453
export const ORIGIN = `https://localhost:${EDGE_PORT}`

/** A local test credential for the access gate, known to this suite only. A real preview's password is generated, never committed. */
export const ACCESS_USER = 'preview-e2e'
export const ACCESS_PASSWORD = 'local-e2e-only-not-a-deployment-secret-7c1d'

const world = resolve(import.meta.dirname, '../hosted-preview')
export const PREVIEW_CONFIG = JSON.parse(readFileSync(resolve(world, 'districts-preview.config.json'), 'utf8')) as Record<string, unknown>

/** The synthetic world's ids (hosted-preview/README.md). */
export const PREVIEW_GUILD = '910000000000000001'
export const PREVIEW_ADA = '910000000000000101'
export const PREVIEW_BEA = '910000000000000102'
export const PREVIEW_CY = '910000000000000103'
export const KEEPER_101 = 'eip155:8453/erc721:0x000000000000000000000000000000000000d101/101'

/** What the founding run leaves for the transfer run. */
export const STATE_FILE = resolve(import.meta.dirname, '../test-artifacts/hosted-preview-state.json')
