import { createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto'

/**
 * A LOCAL Proofy Play, driven through its real HTTP contract (1.1.0): operator routes, the
 * server-admin installation and configuration routes, and player launch.
 *
 * Proofy Core's context token issuer is not deployed, so tokens are signed with Play's own
 * local stand-in issuer key (`npm run dev:keys` in Proofy Play prints it as
 * DEV_CORE_ISSUER_PRIVATE_KEY). Play verifies them exactly as it would Core's: Ed25519, kid,
 * issuer, audience, 120 s lifetime. Nothing here is a mock of Play.
 *
 * Required environment (from the local Play's dev-keys output):
 *   PLAY_API_URL                        e.g. http://127.0.0.1:18090
 *   PLAY_DEV_OPERATOR_KEY               DEV_OPERATOR_KEY
 *   PLAY_DEV_CORE_ISSUER_PRIVATE_KEY    DEV_CORE_ISSUER_PRIVATE_KEY (JWK JSON)
 *   PLAY_DEV_CORE_ISSUER_KEY_ID         DEV_CORE_ISSUER_KEY_ID (default core-dev-1)
 */
function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set. These tests need a running local Proofy Play; see e2e-city-play/README.md.`)
  return v
}

export const playUrl = () => required('PLAY_API_URL').replace(/\/+$/, '')
const operatorKey = () => required('PLAY_DEV_OPERATOR_KEY')

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url')

/** A fresh Discord-shaped id (18 digits), unique per call. */
export function snowflake(): string {
  return `9${BigInt(`0x${randomBytes(8).toString('hex')}`).toString().padStart(17, '0').slice(0, 17)}`
}

export interface ContextClaims {
  guild: string
  user: string
  admin?: boolean
  entitled?: boolean
  displayName?: string
}

/** A Core context token, as Proofy Core would mint it for Play, signed by the local stand-in issuer. */
export function contextToken(c: ContextClaims): string {
  const jwk = JSON.parse(required('PLAY_DEV_CORE_ISSUER_PRIVATE_KEY'))
  const kid = process.env.PLAY_DEV_CORE_ISSUER_KEY_ID ?? 'core-dev-1'
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'EdDSA', typ: 'JWT', kid }
  const claims = {
    iss: 'proofy-core',
    aud: 'proofy-play',
    jti: randomUUID(),
    iat: now,
    exp: now + 110,
    sub: c.user,
    coreUserId: `u${c.user.slice(-8)}`,
    discordGuildId: c.guild,
    coreServerId: `s${c.guild.slice(-8)}`,
    displayName: c.displayName ?? 'Local Player',
    avatar: null,
    brandAdmin: c.admin ?? false,
    playEntitled: c.entitled ?? true,
  }
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  const signature = sign(null, Buffer.from(input), createPrivateKey({ key: jwk, format: 'jwk' }))
  return `${input}.${b64url(signature)}`
}

export interface PlayAnswer {
  status: number
  body: Record<string, unknown> & { ok: boolean; error?: { code: string } }
}

export async function call(method: string, path: string, bearer: string, body?: unknown): Promise<PlayAnswer> {
  const res = await fetch(`${playUrl()}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as PlayAnswer['body'] }
}

export const operator = (method: string, path: string, body?: unknown) => call(method, path, operatorKey(), body)

/** Install a game on a Discord server as its admin. Returns the installation id. */
export async function install(guild: string, gameKey = 'rare-city'): Promise<string> {
  const a = await call('POST', '/v1/admin/installations', contextToken({ guild, user: snowflake(), admin: true }), { gameKey })
  if (a.status !== 201) throw new Error(`install failed: ${a.status} ${JSON.stringify(a.body)}`)
  return (a.body.installation as { id: string }).id
}

/** Create a configuration version as the server's admin. The raw answer: tests also expect refusals. */
export function createConfigVersion(guild: string, installationId: string, config: unknown, schemaVersion = 1): Promise<PlayAnswer> {
  return call('POST', `/v1/admin/installations/${installationId}/config-versions`, contextToken({ guild, user: snowflake(), admin: true }), { schemaVersion, config })
}

export async function activate(guild: string, installationId: string, version: number): Promise<void> {
  const a = await call('POST', `/v1/admin/installations/${installationId}/config-versions/${version}/activate`, contextToken({ guild, user: snowflake(), admin: true }))
  if (a.status !== 200) throw new Error(`activate failed: ${a.status} ${JSON.stringify(a.body)}`)
}

/** Create and activate a version; returns its number and hash. */
export async function publish(guild: string, installationId: string, config: unknown): Promise<{ version: number; configHash: string }> {
  const a = await createConfigVersion(guild, installationId, config)
  if (a.status !== 201) throw new Error(`config version refused: ${a.status} ${JSON.stringify(a.body)}`)
  const cv = a.body.configVersion as { version: number; configHash: string }
  await activate(guild, installationId, cv.version)
  return { version: cv.version, configHash: cv.configHash }
}

export interface Launch {
  runToken: string
  launchUrl: string
  run: { runId: string; installationId: string; configVersion: number; configHash: string }
}

/** A player launches a game on their server, exactly as the Proofy lobby will. A new Discord user each time unless `user` says who. */
export async function launch(guild: string, gameKey = 'rare-city', displayName = 'Local Player', user = snowflake()): Promise<Launch> {
  const a = await call('POST', '/v1/play/launch', contextToken({ guild, user, displayName }), { gameKey })
  if (a.status !== 201) throw new Error(`launch failed: ${a.status} ${JSON.stringify(a.body)}`)
  return a.body as unknown as Launch
}

/** The URL Play hands the browser: the run token in the fragment (contract §11). */
export const launchHref = (l: Launch) => `${l.launchUrl}#runToken=${l.runToken}`
