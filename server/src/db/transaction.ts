import pg, { type PoolClient } from 'pg'
import type { Database } from './pool'

/**
 * ONE TRANSACTION ON ONE POOLED CONNECTION, and the rule for giving that connection back.
 *
 * Every request shares one pool, and a pooled connection carries its transaction with it.
 * So a connection goes back to the pool only when it is KNOWN to be outside a transaction.
 * If that is not known, it is closed instead: closing a connection makes the database
 * abandon whatever transaction it held, and nobody is ever handed it to commit.
 *
 * How a failed transaction ends depends on what kind of failure it was:
 *
 * - A REFUSAL the service itself raised (`isRefusal`), with every statement before it
 *   answered: the connection is fine. ROLLBACK is sent.
 * - An error the DATABASE REPORTED (`pg.DatabaseError`): the statement was answered, so the
 *   connection is still in step with the server. ROLLBACK is sent.
 * - ANYTHING ELSE: a statement that timed out on this side (the pool's `query_timeout` only
 *   stops waiting: the statement may still be running there), a dropped connection, a
 *   transport failure, a bug. The server's state is unknown, and a ROLLBACK queued behind a
 *   statement that is still running may never be sent. No ROLLBACK is attempted and the
 *   connection is closed. This includes COMMIT itself: a COMMIT that did not come back may
 *   or may not have happened, and the connection is not reused to find out.
 * - A ROLLBACK THAT FAILS, after either of the first two: the connection is closed.
 * - A CONNECTION THAT DROPS BETWEEN STATEMENTS says so with an `error` event, not with a
 *   rejected query. The pool does not listen for that while a connection is checked out, and
 *   an `error` event nobody listens for stops the process. It is listened for here: the
 *   connection is marked as lost and closed, and no ROLLBACK is sent down it.
 *
 * The error is always rethrown unchanged.
 */
export async function withTransaction<T>(db: Database, isRefusal: (err: unknown) => boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  /** true = this connection's transaction state is not known. It is destroyed, never pooled. */
  let discard = false
  const lost = () => {
    discard = true
  }
  client.on('error', lost)
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    if (!discard && (isRefusal(err) || err instanceof pg.DatabaseError)) {
      await client.query('ROLLBACK').catch(() => {
        discard = true
      })
    } else {
      discard = true
    }
    throw err
  } finally {
    client.removeListener('error', lost)
    // pg-pool closes a connection released with a truthy argument instead of keeping it.
    client.release(discard)
  }
}
