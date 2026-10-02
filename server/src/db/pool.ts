import pg, { type Pool } from 'pg'
import { errorFields, type Logger } from '../log'

/** The slice of a pg Pool the server depends on. */
export type Database = Pick<Pool, 'query' | 'connect' | 'end'>

const CONNECT_TIMEOUT_MS = 5_000
const QUERY_TIMEOUT_MS = 10_000

export interface PoolOptions {
  /** Tests isolate themselves in a throwaway schema; the service uses the default search path. */
  searchPath?: string
  /** Client-side limit per query. 0 disables it, for migrations that may legitimately run long. */
  queryTimeoutMs?: number
}

export function createPool(databaseUrl: string, log: Logger, options: PoolOptions = {}): Pool {
  // The search path is spliced into a connection option, so it is restricted to a plain identifier.
  if (options.searchPath !== undefined && !/^[a-z_][a-z0-9_]*$/.test(options.searchPath)) throw new Error('searchPath must be a plain lowercase identifier.')
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: options.queryTimeoutMs ?? QUERY_TIMEOUT_MS,
    ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
  })
  // An idle client can fail when the database restarts; without a handler that would crash the process.
  pool.on('error', (err) => log.error('database idle client error', errorFields(err)))
  return pool
}
