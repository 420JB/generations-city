import pg, { type PoolClient } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { withTransaction } from '../src/db/transaction'
import { NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { backend, gone, singleConnectionPool, sleep, watched } from './watchedPool'

/**
 * `withTransaction` against a real Postgres and the real `pg` pool.
 *
 * THE INVARIANT: a connection whose transaction state is uncertain is never a reusable
 * pool connection. Every test here uses a pool of ONE connection, so if a connection is
 * given back, the next transaction is certain to get it.
 */
class Refusal extends Error {}
const isRefusal = (err: unknown) => err instanceof Refusal
const rejection = (work: Promise<unknown>) =>
  work.then(
    () => {
      throw new Error('expected a rejection')
    },
    (err: unknown) => err,
  )

describe.skipIf(NO_TEST_DATABASE)('one transaction on one pooled connection', () => {
  const t = useTestSchema()
  const pools: pg.Pool[] = []
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.end()))
  })

  /** A one-connection pool with a ledger table to write to, and the id of its one server process. */
  async function single(queryTimeoutMs?: number) {
    await t.db.query('CREATE TABLE IF NOT EXISTS ledger (note text PRIMARY KEY)')
    const pool = singleConnectionPool(t.schema, queryTimeoutMs)
    pools.push(pool)
    await pool.query('SELECT 1')
    return { pool, pid: pool.pids[0] }
  }
  const notes = async () => (await t.db.query<{ note: string }>('SELECT note FROM ledger ORDER BY note')).rows.map((r) => r.note)
  const write = (client: PoolClient, note: string) => client.query('INSERT INTO ledger (note) VALUES ($1)', [note])
  /** The server process the pool's one connection is on right now. */
  const currentPid = async (pool: pg.Pool) => (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid

  describe('a connection known to be outside a transaction is reused', () => {
    it('commits, returns the result, and gives the same connection back', async () => {
      const { pool, pid } = await single()
      expect(await withTransaction(pool, isRefusal, async (client) => (await write(client, 'kept'), 'done'))).toBe('done')
      expect(await notes()).toEqual(['kept'])
      expect([pool.totalCount, pool.idleCount]).toEqual([1, 1])
      expect(await currentPid(pool)).toBe(pid)
      expect(await backend(t.db, pid)).toEqual({ state: 'idle', inTransaction: false })
    })

    it('rolls back a refusal the service raised, and reuses the connection', async () => {
      const { pool, pid } = await single()
      const refusal = new Refusal('no')
      const w = watched(pool)
      expect(await rejection(withTransaction(w.db, isRefusal, async (client) => (await write(client, 'ghost'), Promise.reject(refusal))))).toBe(refusal)
      expect(w.sent).toEqual(['BEGIN', 'INSERT INTO ledger', 'ROLLBACK'])
      expect(w.released).toEqual([false])
      expect(await notes()).toEqual([])
      expect([pool.totalCount, await currentPid(pool)]).toEqual([1, pid])
      expect(await backend(t.db, pid)).toEqual({ state: 'idle', inTransaction: false })
    })

    it('rolls back an error the database reported, and reuses the connection', async () => {
      const { pool, pid } = await single()
      await t.db.query(`INSERT INTO ledger (note) VALUES ('taken')`)
      const failures: [string, (client: PoolClient) => Promise<unknown>, string][] = [
        ['division by zero', (client) => client.query('SELECT 1 / 0'), '22012'],
        ['unique violation', (client) => write(client, 'taken'), '23505'],
        ['undefined table', (client) => client.query('SELECT * FROM nowhere'), '42P01'],
        ['raised by a function', (client) => client.query(`DO $$ BEGIN RAISE EXCEPTION 'guard'; END $$`), 'P0001'],
      ]
      for (const [label, fail, code] of failures) {
        const w = watched(pool)
        const err = await rejection(withTransaction(w.db, isRefusal, async (client) => (await write(client, 'ghost'), fail(client))))
        expect(err, label).toBeInstanceOf(pg.DatabaseError)
        expect((err as pg.DatabaseError).code, label).toBe(code)
        expect(w.sent.at(-1), label).toBe('ROLLBACK')
        expect(w.released, label).toEqual([false])
        expect(await notes(), label).toEqual(['taken'])
        expect([pool.totalCount, await currentPid(pool)], label).toEqual([1, pid])
        expect(await backend(t.db, pid), label).toEqual({ state: 'idle', inTransaction: false })
      }
    })

    it('rolls back when COMMIT itself is refused by the database, and reuses the connection', async () => {
      const { pool, pid } = await single()
      // A constraint checked only at COMMIT: the database answers the COMMIT with an error and has already rolled back.
      await t.db.query('CREATE TABLE child (note text REFERENCES ledger (note) DEFERRABLE INITIALLY DEFERRED)')
      const w = watched(pool)
      const err = await rejection(withTransaction(w.db, isRefusal, (client) => client.query(`INSERT INTO child (note) VALUES ('orphan')`)))
      expect((err as pg.DatabaseError).code).toBe('23503')
      expect(w.sent).toEqual(['BEGIN', 'INSERT INTO child', 'COMMIT', 'ROLLBACK'])
      expect(w.released).toEqual([false])
      expect((await t.db.query('SELECT count(*)::int AS n FROM child')).rows[0].n).toBe(0)
      expect(await currentPid(pool)).toBe(pid)
    })
  })

  describe('a connection in an uncertain state is destroyed, never reused', () => {
    it('destroys the connection when a statement times out on this side while the server is still running it', async () => {
      const { pool, pid } = await single(250)
      const started = Date.now()
      const err = await rejection(withTransaction(pool, isRefusal, async (client) => (await write(client, 'ghost'), client.query('SELECT pg_sleep(1.5)'))))
      // pg's own client-side timeout: it stops waiting. It does not cancel anything.
      expect((err as Error).message).toBe('Query read timeout')
      expect(err).not.toBeInstanceOf(pg.DatabaseError)
      expect(Date.now() - started).toBeLessThan(1_200)

      // The connection is out of the pool at once...
      expect([pool.totalCount, pool.idleCount]).toEqual([0, 0])
      // ...while the server is, right now, still inside that transaction, still running that statement.
      expect(await backend(t.db, pid)).toEqual({ state: 'active', inTransaction: true })
      // Closing it is the rollback: the process ends and its write never existed.
      await gone(t.db, pid)
      expect(await notes()).toEqual([])
      // The next request gets a different connection.
      expect(await currentPid(pool)).not.toBe(pid)
      expect(pool.pids).toHaveLength(2)
    })

    it('sends no ROLLBACK down a connection in an unknown state', async () => {
      const { pool, pid } = await single()
      for (const failure of [new Error('Query read timeout'), new Error('Connection terminated unexpectedly'), Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), new TypeError('a bug')]) {
        const w = watched(pool, (text) => (text.includes('pg_sleep') ? failure : null))
        const before = pool.pids.at(-1)!
        expect(await rejection(withTransaction(w.db, isRefusal, async (client) => (await write(client, 'ghost'), client.query('SELECT pg_sleep(0)')))), failure.message).toBe(failure)
        expect(w.sent, failure.message).toEqual(['BEGIN', 'INSERT INTO ledger', 'SELECT pg_sleep(0)'])
        expect(w.released, failure.message).toEqual([true])
        expect(pool.totalCount, failure.message).toBe(0)
        await gone(t.db, before)
        expect(await notes(), failure.message).toEqual([])
      }
      expect(pool.pids[0]).toBe(pid)
      // Each failure cost a connection: none of the five was ever handed out again.
      expect(new Set(pool.pids).size).toBe(5)
    })

    it('destroys a connection the server dropped between statements, without stopping the process', async () => {
      const { pool, pid } = await single()
      const err = await rejection(
        withTransaction(pool, isRefusal, async (client) => {
          await write(client, 'ghost')
          // The server process is killed while the transaction is open and no statement is in flight. pg reports
          // that with an `error` event on the connection, which nothing else is listening for.
          await t.db.query('SELECT pg_terminate_backend($1)', [pid])
          await sleep(200)
          return client.query('SELECT 1')
        }),
      )
      expect(err).toBeInstanceOf(Error)
      expect(pool.totalCount).toBe(0)
      expect(await backend(t.db, pid)).toBeNull()
      expect(await notes()).toEqual([])
      expect(await currentPid(pool)).not.toBe(pid)
    })

    it('destroys a dropped connection even when the work then raises an ordinary refusal', async () => {
      const { pool, pid } = await single()
      const w = watched(pool)
      const refusal = new Refusal('no')
      const err = await rejection(
        withTransaction(w.db, isRefusal, async (client) => {
          await write(client, 'ghost')
          await t.db.query('SELECT pg_terminate_backend($1)', [pid])
          await sleep(200)
          throw refusal
        }),
      )
      expect(err).toBe(refusal)
      // A refusal normally means ROLLBACK and reuse. Not on a connection already known to be lost.
      expect(w.sent).toEqual(['BEGIN', 'INSERT INTO ledger'])
      expect(w.released).toEqual([true])
      expect(pool.totalCount).toBe(0)
    })

    it('destroys the connection when the transport fails under a statement', async () => {
      const { pool, pid } = await single()
      const err = await rejection(
        withTransaction(pool, isRefusal, async (client) => {
          await write(client, 'ghost')
          const running = client.query('SELECT pg_sleep(1)')
          await sleep(100)
          ;(client as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy()
          return running
        }),
      )
      expect((err as Error).message).toMatch(/Connection terminated|not queryable/)
      expect(err).not.toBeInstanceOf(pg.DatabaseError)
      expect(pool.totalCount).toBe(0)
      await gone(t.db, pid)
      expect(await notes()).toEqual([])
    })

    it('destroys the connection when ROLLBACK fails, after a refusal and after a database error alike', async () => {
      const { pool } = await single()
      const causes: [string, (client: PoolClient) => Promise<unknown>][] = [
        ['a refusal', () => Promise.reject(new Refusal('no'))],
        ['a database error', (client) => client.query('SELECT 1 / 0')],
      ]
      for (const [label, fail] of causes) {
        const pid = await currentPid(pool)
        // The ROLLBACK never comes back, so the real connection is still inside its transaction.
        const w = watched(pool, (text) => (text === 'ROLLBACK' ? new Error('Query read timeout') : null))
        const err = await rejection(withTransaction(w.db, isRefusal, async (client) => (await write(client, 'ghost'), fail(client))))
        // The caller still gets the original failure, not the ROLLBACK's.
        expect(err instanceof Refusal || err instanceof pg.DatabaseError, label).toBe(true)
        expect(w.sent.at(-1), label).toBe('ROLLBACK')
        expect(w.released, label).toEqual([true])
        expect(pool.totalCount, label).toBe(0)
        await gone(t.db, pid)
        expect(await notes(), label).toEqual([])
      }
    })

    it('destroys the connection when COMMIT does not come back, whichever way it went', async () => {
      const { pool } = await single()
      // The COMMIT was never received: closing the connection abandons the transaction.
      let pid = await currentPid(pool)
      const unsent = watched(pool, (text) => (text === 'COMMIT' ? new Error('Query read timeout') : null))
      expect(((await rejection(withTransaction(unsent.db, isRefusal, (client) => write(client, 'never')))) as Error).message).toBe('Query read timeout')
      expect(unsent.sent).toEqual(['BEGIN', 'INSERT INTO ledger', 'COMMIT'])
      expect(unsent.released).toEqual([true])
      expect(pool.totalCount).toBe(0)
      await gone(t.db, pid)
      expect(await notes()).toEqual([])

      // The COMMIT was received and done, and only its answer was lost. The caller is told it failed; nothing is
      // assumed either way, and the connection is still not reused.
      pid = await currentPid(pool)
      const answerLost = watched(pool, async (text, client) => {
        if (text !== 'COMMIT') return null
        await client.query('COMMIT')
        return new Error('Query read timeout')
      })
      expect(((await rejection(withTransaction(answerLost.db, isRefusal, (client) => write(client, 'happened')))) as Error).message).toBe('Query read timeout')
      expect(answerLost.released).toEqual([true])
      expect(pool.totalCount).toBe(0)
      await gone(t.db, pid)
      expect(await notes()).toEqual(['happened'])
    })
  })

  describe('UNCERTAIN TRANSACTION CONNECTION != REUSABLE POOL CONNECTION', () => {
    /** The pattern `withTransaction` replaces: best-effort ROLLBACK, then always back to the pool. */
    async function legacyTransaction<T>(pool: pg.Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw err
      } finally {
        client.release()
      }
    }
    /** One request stalls past the client-side timeout after writing; then, later, an unrelated request commits its own write. */
    async function stallThenAnotherRequest(run: <T>(pool: pg.Pool, work: (client: PoolClient) => Promise<T>) => Promise<T>) {
      const { pool, pid } = await single(250)
      await rejection(run(pool, async (client) => (await write(client, 'first request: must never exist'), client.query('SELECT pg_sleep(1)'))))
      // Long enough for the stalled statement to finish on the server.
      await sleep(1_300)
      await run(pool, (client) => write(client, 'second request'))
      return { pool, pid }
    }

    it('THE HAZARD IS REAL: the old pattern hands the next request a connection still inside the first one\'s transaction', async () => {
      const { pool, pid } = await stallThenAnotherRequest(legacyTransaction)
      // The second request's COMMIT made the first request's abandoned write permanent.
      expect(await notes()).toEqual(['first request: must never exist', 'second request'])
      expect(pool.pids).toEqual([pid])
    })

    it('withTransaction never does: the second request gets a new connection and commits only its own write', async () => {
      const { pool, pid } = await stallThenAnotherRequest((p, work) => withTransaction(p, isRefusal, work))
      expect(await notes()).toEqual(['second request'])
      expect(pool.pids).toHaveLength(2)
      expect(pool.pids[1]).not.toBe(pid)
      expect(await backend(t.db, pid)).toBeNull()
    })
  })
})
