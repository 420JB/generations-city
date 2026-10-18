/**
 * PROOFY PLAY, AS RARE CITY'S GAME SERVICE SEES IT: the three `/v1/game` reads this slice
 * needs, authenticated with Rare City's service credential (Play contract 1.1.0 §3.2, §4.4,
 * §4.7), plus schema registration for the operator command.
 *
 * Play's own client (`@proofy/play-sdk` `PlayGameClient`) is a private, unpublished package,
 * so this is a faithful subset of it: same routes, same bearer credential, same error
 * envelope, and responses checked against the contract's shapes before use. Differences, on
 * purpose: one deadline covers the response BODY as well as the headers (a stalled body must
 * not hang a request), and bodies are size-bounded.
 *
 * The credential never leaves this module: not in a URL, an error message or a log line.
 */

export interface PlayInstallation {
  id: string
  gameKey: string
  discordGuildId: string
  status: 'active' | 'suspended' | 'uninstalled'
  activeConfigVersion: number | null
  activeConfigHash: string | null
}

export interface PlayConfigVersion {
  installationId: string
  version: number
  schemaVersion: number
  configHash: string
  /** The document, as Play stores it. Untrusted until checked against the run. */
  config: Record<string, unknown>
}

export interface PlayRun {
  runId: string
  installationId: string
  gameKey: string
  discordGuildId: string
  /**
   * The player, as Play pinned them to the run from the Proofy Core context it was launched with: the
   * Discord user id (Core's own, from its Discord sign-in) is the canonical identity, the Core user id
   * an opaque companion (contract §2, §3.3, §4.7).
   */
  player: { discordUserId: string; coreUserId: string; displayName: string }
  configVersion: number
  configHash: string
  runExpiresAt: string
}

/** Everything the launch path asks of Play. `createPlayClient` talks to a deployed Play; tests use their own. */
export interface PlayGameReader {
  redeemRun(runToken: string): Promise<PlayRun>
  /** `signal` ends the request early: it is abandoned, not left running in the background. */
  getInstallation(installationId: string, options?: { signal?: AbortSignal }): Promise<PlayInstallation>
  getConfigVersion(installationId: string, version: number): Promise<PlayConfigVersion>
}

export interface PlaySchemaRegistrar {
  registerConfigSchema(schemaVersion: number, jsonSchema: Record<string, unknown>): Promise<{ schemaHash: string; created: boolean }>
}

/** Any failure talking to Play. `code` is Play's stable error code where it sent one. */
export class PlayApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'PlayApiError'
    this.status = status
    this.code = code
  }
}

/** `ppk_<env>_<keyId>.<secret>` (contract §3.2). */
export const PLAY_CREDENTIAL_PATTERN = /^ppk_(dev|test|staging|live)_[0-9a-f]{24}\.[0-9a-f]{64}$/

const DEFAULT_TIMEOUT_MS = 10_000
/** Play's transport limit is 256 KB and a configuration at most 64 KiB; nothing it answers is larger. */
const MAX_RESPONSE_BYTES = 512 * 1024

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const GUILD = /^[0-9]{15,25}$/
const GAME_KEY = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/
/** Core's opaque ids (contract §2). */
const CORE_ID = /^[A-Za-z0-9_-]{1,64}$/

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1
const str = (v: unknown, re?: RegExp): v is string => typeof v === 'string' && (!re || re.test(v))

function invalid(): never {
  throw new PlayApiError(502, 'invalid_response', 'Proofy Play answered with a body that does not match the V1 contract.')
}

function readInstallation(v: unknown): PlayInstallation {
  if (!isRecord(v) || !str(v.id, UUID) || !str(v.gameKey, GAME_KEY) || !str(v.discordGuildId, GUILD)) invalid()
  if (v.status !== 'active' && v.status !== 'suspended' && v.status !== 'uninstalled') invalid()
  if (v.activeConfigVersion !== null && !posInt(v.activeConfigVersion)) invalid()
  if (v.activeConfigHash !== null && !str(v.activeConfigHash, HASH)) invalid()
  return { id: v.id, gameKey: v.gameKey, discordGuildId: v.discordGuildId, status: v.status, activeConfigVersion: v.activeConfigVersion, activeConfigHash: v.activeConfigHash }
}

function readConfigVersion(v: unknown): PlayConfigVersion {
  if (!isRecord(v) || !str(v.installationId, UUID) || !posInt(v.version) || !posInt(v.schemaVersion) || !str(v.configHash, HASH) || !isRecord(v.config)) invalid()
  return { installationId: v.installationId, version: v.version, schemaVersion: v.schemaVersion, configHash: v.configHash, config: v.config }
}

function readRun(v: unknown): PlayRun {
  if (!isRecord(v) || !str(v.runId, UUID) || !str(v.installationId, UUID) || !str(v.gameKey, GAME_KEY) || !str(v.discordGuildId, GUILD)) invalid()
  if (!isRecord(v.player) || !str(v.player.discordUserId, GUILD) || !str(v.player.coreUserId, CORE_ID) || !str(v.player.displayName)) invalid()
  if (v.player.displayName.length < 1 || v.player.displayName.length > 100) invalid()
  if (!posInt(v.configVersion) || !str(v.configHash, HASH) || !str(v.runExpiresAt) || Number.isNaN(Date.parse(v.runExpiresAt))) invalid()
  return {
    runId: v.runId,
    installationId: v.installationId,
    gameKey: v.gameKey,
    discordGuildId: v.discordGuildId,
    player: { discordUserId: v.player.discordUserId, coreUserId: v.player.coreUserId, displayName: v.player.displayName },
    configVersion: v.configVersion,
    configHash: v.configHash,
    runExpiresAt: v.runExpiresAt,
  }
}

/** The whole body, refusing (and cancelling) one that grows past the limit, whatever its headers said. */
async function readBounded(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error('too large')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

export interface PlayClientOptions {
  /** Base URL of proofy-play-api. */
  baseUrl: string
  /** Rare City's service credential. Server-side only. */
  credential: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export function createPlayClient(options: PlayClientOptions): PlayGameReader & PlaySchemaRegistrar {
  if (!PLAY_CREDENTIAL_PATTERN.test(options.credential)) throw new TypeError('Play credential must look like ppk_<env>_<keyId>.<secret>')
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  /** The parsed `ok: true` body. Throws PlayApiError for anything else. */
  async function request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, cancel?: AbortSignal): Promise<Record<string, unknown>> {
    const route = `${method} ${path.split('?')[0]}`
    const headers: Record<string, string> = { authorization: `Bearer ${options.credential}`, accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    // One deadline for the whole exchange, body included; a caller's signal can end it sooner.
    const signal = cancel ? AbortSignal.any([cancel, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    let status: number
    let text: string
    try {
      const response = await doFetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'error' })
      status = response.status
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (declared > MAX_RESPONSE_BYTES) throw new Error('too large')
      text = new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response))
    } catch {
      // Deliberately generic: the cause may carry the request, and the request carries the credential.
      throw new PlayApiError(503, 'transport_error', `Could not reach Proofy Play (${route}).`)
    }
    let payload: unknown = null
    try {
      if (text.length > 0) payload = JSON.parse(text)
    } catch {
      // Not JSON at all: answered, but outside the contract (judged with the status below).
    }
    if (status >= 200 && status < 300) {
      if (!isRecord(payload) || payload.ok !== true) invalid()
      return payload
    }
    if (isRecord(payload) && payload.ok === false && isRecord(payload.error) && str(payload.error.code, /^[a-z_]{1,64}$/)) {
      throw new PlayApiError(status, payload.error.code, `Proofy Play refused ${route}: ${payload.error.code}.`)
    }
    throw new PlayApiError(status >= 500 ? 503 : 502, 'invalid_response', `Proofy Play answered ${status} to ${route} without a recognizable error body.`)
  }

  return {
    async redeemRun(runToken) {
      return readRun((await request('POST', '/v1/game/runs/redeem', { runToken })).run)
    },
    async getInstallation(installationId, options) {
      return readInstallation((await request('GET', `/v1/game/installations/${encodeURIComponent(installationId)}`, undefined, options?.signal)).installation)
    },
    async getConfigVersion(installationId, version) {
      return readConfigVersion((await request('GET', `/v1/game/installations/${encodeURIComponent(installationId)}/config/${version}`)).configVersion)
    },
    async registerConfigSchema(schemaVersion, jsonSchema) {
      const body = await request('PUT', `/v1/game/config-schemas/${schemaVersion}`, { jsonSchema })
      if (!isRecord(body.schema) || !str(body.schema.schemaHash, HASH) || typeof body.created !== 'boolean') invalid()
      return { schemaHash: body.schema.schemaHash, created: body.created }
    },
  }
}
