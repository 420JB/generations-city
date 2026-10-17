/**
 * Register Rare City's configuration JSON Schema with Proofy Play, as the game service.
 *
 *   npm run play:register-schema            (built: node dist-server/play-schema.js)
 *   npm run play:register-schema:dev        (source, reads .env)
 *
 * Reads PLAY_API_URL and PLAY_SERVICE_CREDENTIAL (with APP_MODE, which decides which Play
 * environment the credential may belong to). Play keeps a registered version forever:
 * re-registering the identical schema is a no-op (`created: false`), and a different schema
 * under the same version is refused with `schema_version_conflict`. So a schema change here
 * is always a new PLAY_CONFIG_SCHEMA_VERSION.
 */
import { ConfigError, loadConfig } from './config'
import { PLAY_CONFIG_JSON_SCHEMA, PLAY_CONFIG_SCHEMA_VERSION } from './engine'
import { createPlayClient, PlayApiError } from './play/client'

try {
  const config = loadConfig(process.env)
  if (!config.play) throw new ConfigError('PLAY_API_URL and PLAY_SERVICE_CREDENTIAL are required.')
  const play = createPlayClient({ baseUrl: config.play.apiUrl, credential: config.play.credential })
  const result = await play.registerConfigSchema(PLAY_CONFIG_SCHEMA_VERSION, structuredClone(PLAY_CONFIG_JSON_SCHEMA) as unknown as Record<string, unknown>)
  console.log(JSON.stringify({ environment: config.play.environment, gameKey: config.play.gameKey, schemaVersion: PLAY_CONFIG_SCHEMA_VERSION, schemaHash: result.schemaHash, created: result.created }))
} catch (err) {
  if (err instanceof ConfigError) console.error(`invalid configuration: ${err.message}`)
  else if (err instanceof PlayApiError) console.error(`Proofy Play refused the schema: ${err.code} (${err.status})`)
  else throw err
  process.exit(1)
}
