import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import pg from 'pg'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { afterEach, describe, expect, it } from 'vitest'
import { createActivationService } from '../src/activation/service'
import { createApp } from '../src/app'
import { AuthError, createAuthService, hashSessionToken, type AuthOptions } from '../src/auth/service'
import { initializeCity } from '../src/city/store'
import { verifyCity } from '../src/city/verify'
import type { Database } from '../src/db/pool'
import { migrate } from '../src/db/migrations'
import { createGenesisState } from '../src/engine'
import { createLogger, silentLogger } from '../src/log'
import { createGenerationsOwnershipProvider } from '../src/ownership/generations'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { fakeChain } from './fakeChain'
import { TEST_ORIGIN, testConfig } from './testConfig'
import { backend, gone, singleConnectionPool, watched } from './watchedPool'

/**
 * Sign-in (`verify`) shares one pool with permanent activation. These tests are about the
 * CONNECTION a sign-in transaction hands back: reusable only when it is known to be outside
 * a transaction, destroyed otherwise. They assert what was sent, how the connection was
 * released, and what the database holds afterwards, not merely the answer the caller got.
 */
const wallet = () => privateKeyToAccount(generatePrivateKey())
const rejection = (work: Promise<unknown>) =>
  work.then(
    () => {
      throw new Error('expected a rejection')
    },
    (err: unknown) => err,
  )

describe.skipIf(NO_TEST_DATABASE)('sign-in connection hygiene', () => {
  const t = useTestSchema()
  const pools: pg.Pool[] = []
  const servers: Server[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
    await Promise.all(pools.splice(0).map((p) => p.end()))
  })

  const setup = () => migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
  const auth = (db: Database, options: Partial<AuthOptions> = {}) => createAuthService({ db, publicOrigin: TEST_ORIGIN, ...options })
  /** A challenge issued and signed, ready to be verified. Issued through the plain pool. */
  async function signed(account: PrivateKeyAccount = wallet()) {
    const challenge = await auth(t.db).issueChallenge({ address: account.address, chainId: 4663 })
    return { account, nonce: challenge.nonce, signature: await account.signMessage({ message: challenge.message }) }
  }
  const tally = async () =>
    (
      await t.db.query<{ users: number; wallets: number; sessions: number; live: number; consumed: number }>(
        `SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM wallets) AS wallets, (SELECT count(*)::int FROM sessions) AS sessions,
                (SELECT count(*)::int FROM sessions WHERE revoked_at IS NULL) AS live, (SELECT count(*)::int FROM auth_challenges WHERE consumed_at IS NOT NULL) AS consumed`,
      )
    ).rows[0]
  const NOTHING = { users: 0, wallets: 0, sessions: 0, live: 0, consumed: 0 }
  function single(queryTimeoutMs?: number) {
    const pool = singleConnectionPool(t.schema, queryTimeoutMs)
    pools.push(pool)
    return pool
  }
  const VERIFY = ['BEGIN', 'UPDATE auth_challenges SET', 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', 'UPDATE wallets SET', 'INSERT INTO users', 'INSERT INTO wallets', 'INSERT INTO sessions', 'COMMIT']

  describe('a sign-in that ends cleanly reuses its connection', () => {
    it('a successful sign-in consumes the challenge, creates the user and wallet, opens the session, and gives the connection back', async () => {
      await setup()
      const w = watched(t.db)
      const one = await signed()
      const opened = await auth(w.db).verify({ nonce: one.nonce, signature: one.signature }, null)
      expect(w.sent).toEqual(VERIFY)
      expect(w.released).toEqual([false])
      expect(opened.viewer).toMatchObject({ authenticated: true, wallet: { address: one.account.address, chainId: 4663 } })
      expect(await tally()).toEqual({ users: 1, wallets: 1, sessions: 1, live: 1, consumed: 1 })
      expect((await t.db.query('SELECT token_hash FROM sessions')).rows[0].token_hash).toEqual(hashSessionToken(opened.token))

      // The same wallet again, arriving with its session: the same user and wallet, the old session retired, a new one opened.
      const again = watched(t.db)
      const two = await signed(one.account)
      const reopened = await auth(again.db).verify({ nonce: two.nonce, signature: two.signature }, opened.token)
      expect(again.sent).toEqual(['BEGIN', 'UPDATE auth_challenges SET', 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', 'UPDATE wallets SET', 'UPDATE sessions SET', 'INSERT INTO sessions', 'COMMIT'])
      expect(again.released).toEqual([false])
      expect(reopened.viewer.userId).toBe(opened.viewer.userId)
      expect(reopened.token).not.toBe(opened.token)
      expect(await tally()).toEqual({ users: 1, wallets: 1, sessions: 2, live: 1, consumed: 2 })
      expect(await auth(t.db).viewer(opened.token)).toEqual({ authenticated: false })
      expect(await auth(t.db).viewer(reopened.token)).toMatchObject({ authenticated: true, userId: opened.viewer.userId })
    })

    it('an AuthError raised inside the open transaction is rolled back and the connection reused', async () => {
      await setup()
      const one = await signed()
      // The challenge is consumed by somebody else after this request read it and before its transaction's UPDATE.
      const w = watched(t.db, undefined, () => t.db.query('UPDATE auth_challenges SET consumed_at = now() WHERE nonce = $1', [one.nonce]))
      const err = await rejection(auth(w.db).verify({ nonce: one.nonce, signature: one.signature }, null))
      expect(err).toBeInstanceOf(AuthError)
      expect([(err as AuthError).status, (err as AuthError).code]).toEqual([401, 'challenge_invalid'])
      expect(w.sent).toEqual(['BEGIN', 'UPDATE auth_challenges SET', 'ROLLBACK'])
      expect(w.released).toEqual([false])
      expect(await tally()).toEqual({ ...NOTHING, consumed: 1 })
    })

    it('an error the database reported is rolled back, leaves nothing, and the connection is reused', async () => {
      await setup()
      const pool = single()
      // The session credential this sign-in will generate already exists: the INSERT is refused by the database itself.
      const token = Buffer.alloc(32, 7)
      const other = (await t.db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id
      const otherWallet = (await t.db.query<{ id: string }>('INSERT INTO wallets (user_id, chain_id, address) VALUES ($1, 4663, $2) RETURNING id', [other, `0x${'ab'.repeat(20)}`])).rows[0].id
      await t.db.query(`INSERT INTO sessions (token_hash, user_id, wallet_id, created_at, expires_at) VALUES ($1, $2, $3, now(), now() + interval '1 day')`, [hashSessionToken(token.toString('base64url')), other, otherWallet])
      const before = await tally()

      const one = await signed()
      const w = watched(pool)
      const err = await rejection(auth(w.db, { random: () => token }).verify({ nonce: one.nonce, signature: one.signature }, null))
      expect(err).toBeInstanceOf(pg.DatabaseError)
      expect((err as pg.DatabaseError).code).toBe('23505')
      expect(w.sent).toEqual([...VERIFY.slice(0, -1), 'ROLLBACK'])
      expect(w.released).toEqual([false])
      // The user and wallet inserted earlier in the transaction are gone, and the challenge is not consumed.
      expect(await tally()).toEqual(before)
      const pid = pool.pids[0]
      expect(await backend(t.db, pid)).toEqual({ state: 'idle', inTransaction: false })

      // The very same connection now carries a successful sign-in, and brings none of the failed one with it.
      const two = await signed()
      await auth(pool).verify({ nonce: two.nonce, signature: two.signature }, null)
      expect(pool.pids).toEqual([pid])
      expect(await tally()).toEqual({ users: before.users + 1, wallets: before.wallets + 1, sessions: before.sessions + 1, live: before.live + 1, consumed: 1 })
      expect((await t.db.query('SELECT consumed_at FROM auth_challenges WHERE nonce = $1', [one.nonce])).rows[0].consumed_at).toBeNull()
      expect((await t.db.query('SELECT count(*)::int AS n FROM wallets WHERE address = $1', [one.account.address.toLowerCase()])).rows[0].n).toBe(0)
    })

    it('of any number of racing verifications of one challenge, exactly one succeeds, and every connection is given back clean', async () => {
      await setup()
      const w = watched(t.db)
      const one = await signed()
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => auth(w.db).verify({ nonce: one.nonce, signature: one.signature }, null)))
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      for (const r of results) if (r.status === 'rejected') expect([(r.reason as AuthError).status, (r.reason as AuthError).code]).toEqual([401, 'challenge_invalid'])
      expect(await tally()).toEqual({ users: 1, wallets: 1, sessions: 1, live: 1, consumed: 1 })
      // Losing a race is a refusal, not an uncertainty: no connection was thrown away, and none was left in a transaction.
      expect(w.released.length).toBeGreaterThan(0)
      expect(w.released.every((destroyed) => destroyed === false)).toBe(true)
      expect(w.sent.filter((q) => q === 'COMMIT')).toHaveLength(1)
      expect(w.sent.filter((q) => q === 'ROLLBACK')).toHaveLength(w.released.length - 1)
    })
  })

  describe('a sign-in whose connection is in an uncertain state never gives it back', () => {
    it('destroys the connection when a statement times out on this side while the server is still working', async () => {
      await setup()
      const one = await signed()
      const pool = single(500)
      await pool.query('SELECT 1')
      const pid = pool.pids[0]
      // Another session holds the sessions table: the sign-in's INSERT waits on the server, past the client-side limit.
      const blocker = await t.db.connect()
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE')
      try {
        const w = watched(pool)
        const err = await rejection(auth(w.db).verify({ nonce: one.nonce, signature: one.signature }, null))
        // pg's real client-side timeout. Not an AuthError, and not an answer from the database.
        expect((err as Error).message).toBe('Query read timeout')
        expect(err).not.toBeInstanceOf(AuthError)
        expect(err).not.toBeInstanceOf(pg.DatabaseError)
        // Everything up to the stalled statement was sent, and then NOTHING: no ROLLBACK queued behind it.
        expect(w.sent).toEqual(VERIFY.slice(0, -1))
        expect(w.released).toEqual([true])
        expect([pool.totalCount, pool.idleCount]).toEqual([0, 0])
        // On the server the transaction is open at this moment: the challenge consumed, a user and a wallet inserted, the INSERT waiting.
        expect(await backend(t.db, pid)).toEqual({ state: 'active', inTransaction: true })
      } finally {
        // The table is released: the stalled INSERT now completes on the server, inside a transaction nobody will ever commit.
        await blocker.query('ROLLBACK')
        blocker.release()
      }
      await gone(t.db, pid)
      expect(await tally()).toEqual(NOTHING)
      // The next request on this pool is on a different connection.
      await pool.query('SELECT 1')
      expect(pool.pids).toHaveLength(2)
      expect(pool.pids[1]).not.toBe(pid)
    })

    it('destroys the connection when it is dropped under a statement', async () => {
      await setup()
      const pool = single()
      await pool.query('SELECT 1')
      const pid = pool.pids[0]
      const one = await signed()
      // The server process is killed just as the user row is about to be inserted.
      const w = watched(pool, async (text) => {
        if (text.startsWith('INSERT INTO users')) await t.db.query('SELECT pg_terminate_backend($1)', [pid])
        return null
      })
      const err = await rejection(auth(w.db).verify({ nonce: one.nonce, signature: one.signature }, null))
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(AuthError)
      expect(w.released).toEqual([true])
      expect(w.sent).not.toContain('COMMIT')
      expect(pool.totalCount).toBe(0)
      await gone(t.db, pid)
      expect(await tally()).toEqual(NOTHING)
    })

    it('destroys the connection on a transport failure, and sends no ROLLBACK down it', async () => {
      await setup()
      for (const failure of [new Error('Connection terminated unexpectedly'), Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })]) {
        const pool = single()
        await pool.query('SELECT 1')
        const one = await signed()
        const w = watched(pool, (text) => (text.startsWith('INSERT INTO wallets') ? failure : null))
        expect(await rejection(auth(w.db).verify({ nonce: one.nonce, signature: one.signature }, null)), failure.message).toBe(failure)
        expect(w.sent, failure.message).toEqual(VERIFY.slice(0, 6))
        expect(w.released, failure.message).toEqual([true])
        expect(pool.totalCount, failure.message).toBe(0)
        await gone(t.db, pool.pids[0])
        expect(await tally(), failure.message).toEqual(NOTHING)
      }
    })

    it('destroys the connection when ROLLBACK fails after an AuthError', async () => {
      await setup()
      const pool = single()
      await pool.query('SELECT 1')
      const one = await signed()
      const w = watched(
        pool,
        (text) => (text === 'ROLLBACK' ? new Error('Query read timeout') : null),
        () => t.db.query('UPDATE auth_challenges SET consumed_at = now() WHERE nonce = $1', [one.nonce]),
      )
      const err = await rejection(auth(w.db).verify({ nonce: one.nonce, signature: one.signature }, null))
      // The caller is still told what was actually wrong.
      expect([(err as AuthError).status, (err as AuthError).code]).toEqual([401, 'challenge_invalid'])
      expect(w.sent).toEqual(['BEGIN', 'UPDATE auth_challenges SET', 'ROLLBACK'])
      expect(w.released).toEqual([true])
      expect(pool.totalCount).toBe(0)
      await gone(t.db, pool.pids[0])
    })

    it('destroys the connection when ROLLBACK fails after a database error', async () => {
      await setup()
      const pool = single()
      await pool.query('SELECT 1')
      const token = Buffer.alloc(32, 9)
      const other = (await t.db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id
      const otherWallet = (await t.db.query<{ id: string }>('INSERT INTO wallets (user_id, chain_id, address) VALUES ($1, 4663, $2) RETURNING id', [other, `0x${'cd'.repeat(20)}`])).rows[0].id
      await t.db.query(`INSERT INTO sessions (token_hash, user_id, wallet_id, created_at, expires_at) VALUES ($1, $2, $3, now(), now() + interval '1 day')`, [hashSessionToken(token.toString('base64url')), other, otherWallet])
      const before = await tally()
      const one = await signed()
      const w = watched(pool, (text) => (text === 'ROLLBACK' ? new Error('Query read timeout') : null))
      const err = await rejection(auth(w.db, { random: () => token }).verify({ nonce: one.nonce, signature: one.signature }, null))
      expect((err as pg.DatabaseError).code).toBe('23505')
      expect(w.sent.at(-1)).toBe('ROLLBACK')
      expect(w.released).toEqual([true])
      expect(pool.totalCount).toBe(0)
      await gone(t.db, pool.pids[0])
      expect(await tally()).toEqual(before)
    })

    it('destroys the connection when COMMIT does not come back, and assumes nothing about whether it happened', async () => {
      await setup()
      // The COMMIT never reached the server: the sign-in did not happen.
      const unsent = single()
      await unsent.query('SELECT 1')
      const one = await signed()
      const a = watched(unsent, (text) => (text === 'COMMIT' ? new Error('Query read timeout') : null))
      expect(((await rejection(auth(a.db).verify({ nonce: one.nonce, signature: one.signature }, null))) as Error).message).toBe('Query read timeout')
      expect(a.sent).toEqual(VERIFY)
      expect(a.released).toEqual([true])
      expect(unsent.totalCount).toBe(0)
      await gone(t.db, unsent.pids[0])
      expect(await tally()).toEqual(NOTHING)

      // The COMMIT reached the server and only its answer was lost: the session exists, but its credential was never
      // returned to anyone, so nobody can present it. The connection is destroyed all the same.
      const lost = single()
      await lost.query('SELECT 1')
      const two = await signed()
      const b = watched(lost, async (text, client) => {
        if (text !== 'COMMIT') return null
        await client.query('COMMIT')
        return new Error('Query read timeout')
      })
      expect(((await rejection(auth(b.db).verify({ nonce: two.nonce, signature: two.signature }, null))) as Error).message).toBe('Query read timeout')
      expect(b.released).toEqual([true])
      expect(lost.totalCount).toBe(0)
      expect(await tally()).toEqual({ users: 1, wallets: 1, sessions: 1, live: 1, consumed: 1 })
      // The challenge is spent either way: a replay of it is refused.
      expect(((await rejection(auth(t.db).verify({ nonce: two.nonce, signature: two.signature }, null))) as AuthError).code).toBe('challenge_invalid')
    })

    it('still answers 503 auth_unavailable over HTTP, with no cookie and no detail', async () => {
      await setup()
      const lines: string[] = []
      const failing = watched(t.db, (text) => (text.startsWith('INSERT INTO sessions') ? Object.assign(new Error('read ECONNRESET postgres://rarecity:hunter2@db.internal'), { code: 'ECONNRESET' }) : null))
      const server = createServer(createApp({ config: testConfig({ rateLimits: false }), db: t.db, migrationsDir: MIGRATIONS_DIR, log: createLogger((l) => lines.push(l)), auth: auth(failing.db) }))
      servers.push(server)
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      const one = await signed()
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: one.nonce, signature: one.signature }) })
      expect([res.status, await res.json(), res.headers.get('set-cookie'), res.headers.get('retry-after')]).toEqual([503, { error: 'auth_unavailable' }, null, '5'])
      expect(failing.released).toEqual([true])
      expect(lines.join('\n')).not.toContain('hunter2')
      // Nothing of the failed sign-in survives once its connection has closed.
      const deadline = Date.now() + 5_000
      while ((await tally()).users !== 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25))
      expect(await tally()).toEqual(NOTHING)
    })
  })

  describe('CROSS-FLOW: an uncertain sign-in connection is never inherited by an activation', () => {
    it('a sign-in that stalls mid-transaction leaves nothing for the activation that follows on the same pool to commit', async () => {
      await setup()
      const city = await initializeCity(t.db, { state: createGenesisState(), origin: 'demo-fixture', rehearsal: true, environment: 'local' })
      const chain = fakeChain()
      const ownership = createGenerationsOwnershipProvider({ transport: chain.transport })

      // The owner signs in and is issued an intent, all through the ordinary pool.
      const owner = wallet()
      chain.mint(owner.address, 812n)
      const signIn = await signed(owner)
      const opened = await auth(t.db).verify({ nonce: signIn.nonce, signature: signIn.signature }, null)
      const session = (await auth(t.db).session(opened.token))!
      const intent = await createActivationService({ db: t.db, ownership, publicOrigin: TEST_ORIGIN, enabled: true, log: silentLogger }).issueIntent(session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await owner.signTypedData(JSON.parse(JSON.stringify(intent.typedData)))
      const before = await tally()

      // ONE pool of ONE connection, shared by sign-in and activation exactly as the service shares its pool. Whatever
      // sign-in gives back is, with certainty, the connection the activation gets.
      const shared = single(1_000)
      await shared.query('SELECT 1')
      const authPid = shared.pids[0]

      // A stranger's sign-in stalls on that connection, mid-transaction, past the client-side timeout.
      const stranger = await signed()
      const blocker = await t.db.connect()
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE')
      try {
        expect(((await rejection(auth(shared).verify({ nonce: stranger.nonce, signature: stranger.signature }, null))) as Error).message).toBe('Query read timeout')
        // THE INVARIANT: the uncertain connection is not a pool connection any more.
        expect([shared.totalCount, shared.idleCount]).toEqual([0, 0])
        expect(await backend(t.db, authPid)).toEqual({ state: 'active', inTransaction: true })
      } finally {
        await blocker.query('ROLLBACK')
        blocker.release()
      }

      // The activation now runs on the shared pool. It begins and commits transactions of its own.
      const result = await createActivationService({ db: shared, ownership, publicOrigin: TEST_ORIGIN, enabled: true, log: silentLogger }).commit(session, { intentId: intent.intentId, signature })
      expect(result.property).toMatchObject({ tokenId: '812', plotId: 'd4-w0-p7', sequence: 2 })
      expect(result.city.instance).toBe(city.instance)

      // It ran on a different connection, and its COMMIT made nothing of the stranger's sign-in permanent.
      expect(shared.pids.length).toBeGreaterThan(1)
      expect(shared.pids.slice(1)).not.toContain(authPid)
      await gone(t.db, authPid)
      expect(await tally()).toEqual(before)
      expect((await t.db.query('SELECT consumed_at FROM auth_challenges WHERE nonce = $1', [stranger.nonce])).rows[0].consumed_at).toBeNull()
      expect((await t.db.query('SELECT count(*)::int AS n FROM wallets WHERE address = $1', [stranger.account.address.toLowerCase()])).rows[0].n).toBe(0)
      // The stranger is not signed in, and their challenge is still theirs to use.
      expect((await auth(t.db).verify({ nonce: stranger.nonce, signature: stranger.signature }, null)).viewer.authenticated).toBe(true)
      expect((await verifyCity(t.db)).ok).toBe(true)
    })
  })
})
