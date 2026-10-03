import pg, { type PoolClient } from 'pg'
import type { Database } from '../src/db/pool'
import { resolveTestDatabase } from './testDb'

/**
 * TEST HELPERS for connection hygiene: what was sent on a pooled connection, how the
 * connection was given back, and what the database itself says about it afterwards.
 */
export interface Watched {
  db: Database
  /** One entry per connection handed back: true = destroyed, false = returned to the pool for reuse. */
  released: boolean[]
  /** The first words of every statement sent through a checked-out connection, in order. */
  sent: string[]
}

/**
 * Wrap a pool so its checked-out connections can be observed and made to misbehave.
 * `sabotage` runs before each statement: return an Error and the statement is NOT sent and
 * rejects with it (as far as the caller can tell, it never came back); return null and it runs.
 */
export function watched(pool: Database, sabotage: (text: string, client: PoolClient) => Error | null | Promise<Error | null> = () => null, beforeConnect: () => Promise<unknown> = async () => undefined): Watched {
  const released: boolean[] = []
  const sent: string[] = []
  const db: Database = {
    query: pool.query.bind(pool) as Database['query'],
    end: () => pool.end(),
    connect: (async () => {
      await beforeConnect()
      const client = await pool.connect()
      return new Proxy(client, {
        get(target, key) {
          if (key === 'release')
            return (arg?: unknown) => {
              released.push(Boolean(arg))
              return target.release(arg as boolean)
            }
          if (key === 'query')
            return async (...args: unknown[]) => {
              const text = String(args[0])
              sent.push(text.trim().split(/\s+/).slice(0, 3).join(' '))
              const failure = await sabotage(text, target)
              if (failure) throw failure
              return (target.query as (...a: unknown[]) => unknown)(...args)
            }
          const value = Reflect.get(target, key, target) as unknown
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        },
      })
    }) as Database['connect'],
  }
  return { db, released, sent }
}

/**
 * A pool of exactly ONE connection in the given schema. With one connection, "the next
 * request" gets the very connection the last one gave back, if it gave one back.
 * `queryTimeoutMs` is pg's client-side limit: the same mechanism the service's pool uses.
 */
export function singleConnectionPool(schema: string, queryTimeoutMs?: number): pg.Pool & { pids: number[] } {
  const target = resolveTestDatabase(process.env)
  if (!('url' in target)) throw new Error('no test database')
  const pool = new pg.Pool({ connectionString: target.url, max: 1, query_timeout: queryTimeoutMs, options: `-c search_path=${schema}` }) as pg.Pool & { pids: number[] }
  pool.pids = []
  // Every server process this pool has ever been connected to, oldest first.
  pool.on('connect', (client) => pool.pids.push((client as unknown as { processID: number }).processID))
  pool.on('error', () => undefined)
  return pool
}

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

/** What the database says a server process is doing, or null when it no longer exists. */
export async function backend(observer: Database, pid: number): Promise<{ state: string; inTransaction: boolean } | null> {
  const row = (await observer.query<{ state: string; open: boolean }>('SELECT state, xact_start IS NOT NULL AS open FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0]
  return row ? { state: row.state, inTransaction: row.open } : null
}

/** Wait until a server process has gone: its connection was closed and whatever it held was abandoned. */
export async function gone(observer: Database, pid: number, withinMs = 8_000): Promise<void> {
  const deadline = Date.now() + withinMs
  while (await backend(observer, pid)) {
    if (Date.now() > deadline) throw new Error(`server process ${pid} is still there after ${withinMs} ms`)
    await sleep(25)
  }
}
