import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getAddress, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { AuthError, CHALLENGE_TTL_MS, createAuthService, hashSessionToken, SESSION_TTL_MS, type AuthOptions } from '../src/auth/service'
import { createCityReader } from '../src/city/store'
import type { AppMode } from '../src/config'
import { loadMigrations, migrate } from '../src/db/migrations'
import { installDemoFixture } from '../src/fixtures/demoCity'
import { createLogger } from '../src/log'
import { createFixtureOwnershipProvider } from '../src/ownership/fixture'
import { OwnershipError, type OwnershipProvider } from '../src/ownership/provider'
import { createFriendsReader } from '../src/ownership/reader'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { TEST_ORIGIN, testConfig } from './testConfig'

const T0 = new Date('2026-10-02T12:00:00.000Z')
const wallet = () => privateKeyToAccount(generatePrivateKey())

describe.skipIf(NO_TEST_DATABASE)('identity against a disposable Postgres', () => {
  const t = useTestSchema()
  const setup = (environment: AppMode = 'local') => migrate(t.db, { dir: MIGRATIONS_DIR, environment })
  const count = async (table: string) => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n

  /** An auth service on a clock the test controls. */
  function service(options: Partial<AuthOptions> = {}) {
    const clock = { now: new Date(T0) }
    const auth = createAuthService({ db: t.db, publicOrigin: TEST_ORIGIN, now: () => new Date(clock.now), ...options })
    return { auth, clock, advance: (ms: number) => (clock.now = new Date(clock.now.getTime() + ms)) }
  }
  const signIn = async (auth: ReturnType<typeof service>['auth'], account = wallet(), presented: string | null = null) => {
    const challenge = await auth.issueChallenge({ address: account.address, chainId: 4663 })
    const opened = await auth.verify({ nonce: challenge.nonce, signature: await account.signMessage({ message: challenge.message }) }, presented)
    return { account, challenge, ...opened }
  }
  const rejection = async (work: Promise<unknown>) => {
    const err = await work.then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AuthError)
    return [(err as AuthError).status, (err as AuthError).code]
  }

  describe('migration 0003', () => {
    it('adds the four identity tables and creates no rows', async () => {
      await setup()
      expect(await t.tables()).toEqual(expect.arrayContaining(['users', 'wallets', 'sessions', 'auth_challenges']))
      for (const table of ['users', 'wallets', 'sessions', 'auth_challenges', 'city', 'city_events']) expect(await count(table), table).toBe(0)
      const columns = (await t.db.query<{ table_name: string; column_name: string }>('SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2) ORDER BY table_name, ordinal_position', [t.schema, ['users', 'wallets', 'sessions', 'auth_challenges']])).rows
      const of = (table: string) => columns.filter((c) => c.table_name === table).map((c) => c.column_name)
      expect(of('users')).toEqual(['id', 'created_at', 'updated_at'])
      expect(of('wallets')).toEqual(['id', 'user_id', 'chain_id', 'address', 'created_at', 'last_verified_at'])
      expect(of('sessions')).toEqual(['id', 'token_hash', 'user_id', 'wallet_id', 'created_at', 'expires_at', 'revoked_at'])
      expect(of('auth_challenges')).toEqual(['nonce', 'chain_id', 'address', 'message', 'issued_at', 'expires_at', 'consumed_at'])
    })

    it('upgrades a P0-B database in place: the city, its sequence and its history are untouched', async () => {
      // A database as staging has it today: migrations 1-2 and the fixture city.
      const all = await loadMigrations(MIGRATIONS_DIR)
      await t.db.query('CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
      for (const m of all.slice(0, 2)) {
        await t.db.query(m.sql)
        await t.db.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum])
      }
      await t.db.query(`INSERT INTO app_meta (key, value) VALUES ('environment', 'staging')`)
      await installDemoFixture(t.db, 'staging')
      const before = (await t.db.query('SELECT instance_id, sequence, md5(state::text) AS state, updated_at FROM city')).rows
      const events = (await t.db.query('SELECT * FROM city_events')).rows

      const result = await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      expect(result.applied).toEqual(all.slice(2).map((m) => m.version))
      expect((await t.db.query('SELECT instance_id, sequence, md5(state::text) AS state, updated_at FROM city')).rows).toEqual(before)
      expect((await t.db.query('SELECT * FROM city_events')).rows).toEqual(events)
      expect(await count('users')).toBe(0)
    })

    it('does not key a user by wallet, and lets one user hold several wallets', async () => {
      await setup()
      const user = (await t.db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id
      expect(user).toMatch(/^[0-9a-f-]{36}$/)
      for (const address of [`0x${'a'.repeat(40)}`, `0x${'b'.repeat(40)}`]) await t.db.query('INSERT INTO wallets (user_id, chain_id, address) VALUES ($1, 4663, $2)', [user, address])
      expect((await t.db.query('SELECT count(*)::int AS n FROM wallets WHERE user_id = $1', [user])).rows[0].n).toBe(2)
    })

    it('cannot hold one address twice, in any spelling', async () => {
      await setup()
      const user = (await t.db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id
      const other = (await t.db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id
      const lower = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
      await t.db.query('INSERT INTO wallets (user_id, chain_id, address) VALUES ($1, 4663, $2)', [user, lower])
      // The same address again, for the same or another user: refused.
      for (const owner of [user, other]) await expect(t.db.query('INSERT INTO wallets (user_id, chain_id, address) VALUES ($1, 4663, $2)', [owner, lower])).rejects.toMatchObject({ constraint: 'wallets_chain_address_unique' })
      // Checksummed, upper-case and unprefixed spellings never reach the table at all, so they cannot be a second row.
      for (const spelling of [getAddress(lower), `0x${lower.slice(2).toUpperCase()}`, lower.slice(2), `${lower} `, `0x${'g'.repeat(40)}`, '0x1234'])
        await expect(t.db.query('INSERT INTO wallets (user_id, chain_id, address) VALUES ($1, 4663, $2)', [other, spelling]), spelling).rejects.toMatchObject({ constraint: 'wallets_address_normalized' })
      expect(await count('wallets')).toBe(1)
    })

    it('only stores sessions as a 32-byte hash with a real lifetime, and challenges in their exact shape', async () => {
      await setup()
      const user = (await t.db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id
      const w = (await t.db.query<{ id: string }>('INSERT INTO wallets (user_id, chain_id, address) VALUES ($1, 4663, $2) RETURNING id', [user, `0x${'a'.repeat(40)}`])).rows[0].id
      const insert = (hash: Buffer, expires: string) => t.db.query(`INSERT INTO sessions (token_hash, user_id, wallet_id, expires_at) VALUES ($1, $2, $3, now() + $4::interval)`, [hash, user, w, expires])
      await insert(Buffer.alloc(32, 1), '1 hour')
      await expect(insert(Buffer.from('a-plaintext-bearer-token'), '1 hour')).rejects.toMatchObject({ constraint: 'sessions_token_hash_is_sha256' })
      await expect(insert(Buffer.alloc(32, 1), '1 hour')).rejects.toMatchObject({ constraint: 'sessions_token_hash_unique' })
      await expect(insert(Buffer.alloc(32, 2), '-1 hour')).rejects.toMatchObject({ constraint: 'sessions_expiry_after_creation' })

      const challenge = (nonce: string, address: string, ttl: string) => t.db.query(`INSERT INTO auth_challenges (nonce, chain_id, address, message, issued_at, expires_at) VALUES ($1, 4663, $2, 'm', now(), now() + $3::interval)`, [nonce, address, ttl])
      await challenge('0'.repeat(32), `0x${'a'.repeat(40)}`, '5 minutes')
      await expect(challenge('0'.repeat(32), `0x${'a'.repeat(40)}`, '5 minutes')).rejects.toMatchObject({ code: '23505' })
      await expect(challenge('short', `0x${'a'.repeat(40)}`, '5 minutes')).rejects.toMatchObject({ constraint: 'auth_challenges_nonce_shape' })
      await expect(challenge('1'.repeat(32), `0x${'A'.repeat(40)}`, '5 minutes')).rejects.toMatchObject({ constraint: 'auth_challenges_address_normalized' })
      await expect(challenge('2'.repeat(32), `0x${'a'.repeat(40)}`, '-1 minute')).rejects.toMatchObject({ constraint: 'auth_challenges_expiry_after_issue' })
    })
  })

  describe('signed challenge', () => {
    it('issues an EIP-4361 message bound to the origin, chain 4663, the address, a nonce and a five-minute lifetime', async () => {
      await setup()
      const { auth } = service()
      const account = wallet()
      const challenge = await auth.issueChallenge({ address: account.address.toLowerCase(), chainId: 4663 })
      expect(challenge.nonce).toMatch(/^[0-9a-f]{32}$/)
      expect(challenge.expiresAt).toBe(new Date(T0.getTime() + CHALLENGE_TTL_MS).toISOString())
      expect(challenge.message.split('\n')).toEqual([
        '127.0.0.1:8787 wants you to sign in with your Ethereum account:',
        account.address,
        '',
        'Sign in to Rare City. This only proves you control this wallet: it is not a transaction and it costs nothing.',
        '',
        'URI: http://127.0.0.1:8787',
        'Version: 1',
        'Chain ID: 4663',
        `Nonce: ${challenge.nonce}`,
        'Issued At: 2026-10-02T12:00:00.000Z',
        'Expiration Time: 2026-10-02T12:05:00.000Z',
      ])
      const stored = (await t.db.query('SELECT chain_id, address, message, consumed_at FROM auth_challenges WHERE nonce = $1', [challenge.nonce])).rows[0]
      expect(stored).toEqual({ chain_id: 4663, address: account.address.toLowerCase(), message: challenge.message, consumed_at: null })
      // Two challenges for one address never share a nonce.
      expect((await auth.issueChallenge({ address: account.address, chainId: 4663 })).nonce).not.toBe(challenge.nonce)
    })

    it('refuses anything that is not exactly an address on chain 4663', async () => {
      await setup()
      const { auth } = service()
      const address = wallet().address
      const bad: unknown[] = [null, 'x', [], {}, { address }, { chainId: 4663 }, { address, chainId: '4663' }, { address: address.slice(0, 41), chainId: 4663 }, { address: `0x${'0'.repeat(40)}`, chainId: 4663 }, { address, chainId: 4663, extra: 1 }]
      // A mixed-case address whose checksum is wrong is a typo, not an address.
      bad.push({ address: '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266', chainId: 4663 }, { address: '0XF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266', chainId: 4663 })
      for (const input of bad) expect(await rejection(auth.issueChallenge(input)), JSON.stringify(input)).toEqual([400, 'invalid_request'])
      for (const chainId of [1, 46630, 0, -4663, 4663.5]) expect(await rejection(auth.issueChallenge({ address, chainId })), String(chainId)).toEqual([400, 'unsupported_chain'])
      expect(await count('auth_challenges')).toBe(0)
    })

    it('authenticates the wallet that signed, creating its user, wallet and session together', async () => {
      await setup()
      const { auth } = service()
      const { account, token, viewer, expiresAt, maxAgeSeconds, challenge } = await signIn(auth)
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(expiresAt).toEqual(new Date(T0.getTime() + SESSION_TTL_MS))
      expect(maxAgeSeconds).toBe(7 * 24 * 60 * 60)
      expect(viewer).toEqual({ authenticated: true, userId: expect.stringMatching(/^[0-9a-f-]{36}$/), wallet: { address: account.address, chainId: 4663 }, session: { expiresAt: expiresAt.toISOString() } })
      expect(viewer.userId).not.toContain(account.address.slice(2).toLowerCase())
      expect(await auth.viewer(token)).toEqual(viewer)
      expect([await count('users'), await count('wallets'), await count('sessions')]).toEqual([1, 1, 1])
      expect((await t.db.query('SELECT consumed_at FROM auth_challenges WHERE nonce = $1', [challenge.nonce])).rows[0].consumed_at).toEqual(T0)
    })

    it('stores only the hash of the session credential: the credential itself is nowhere in the database', async () => {
      await setup()
      const { auth } = service()
      const { token } = await signIn(auth)
      const session = (await t.db.query<{ token_hash: Buffer }>('SELECT token_hash FROM sessions')).rows[0]
      expect(session.token_hash.equals(hashSessionToken(token))).toBe(true)
      expect(session.token_hash).toHaveLength(32)
      const raw = Buffer.from(token, 'base64url')
      for (const table of await t.tables()) {
        const dump = (await t.db.query<{ row: string }>(`SELECT row_to_json(x)::text AS row FROM ${table} x`)).rows.map((r) => r.row).join('\n')
        expect(dump, table).not.toContain(token)
        expect(dump, table).not.toContain(raw.toString('hex'))
        expect(dump, table).not.toContain(raw.toString('base64'))
      }
    })

    it('rejects a signature from any other wallet, and leaves the challenge for its real owner', async () => {
      await setup()
      const { auth } = service()
      const victim = wallet()
      const attacker = wallet()
      // The attacker asks for the victim's challenge and signs it with their own key.
      const challenge = await auth.issueChallenge({ address: victim.address, chainId: 4663 })
      expect(await rejection(auth.verify({ nonce: challenge.nonce, signature: await attacker.signMessage({ message: challenge.message }) }, null))).toEqual([401, 'signature_invalid'])
      expect([await count('users'), await count('sessions')]).toEqual([0, 0])
      const opened = await auth.verify({ nonce: challenge.nonce, signature: await victim.signMessage({ message: challenge.message }) }, null)
      expect(opened.viewer.wallet.address).toBe(victim.address)
    })

    it('rejects a signature over any other text: another address, chain, origin, nonce or lifetime', async () => {
      await setup()
      const { auth } = service()
      const account = wallet()
      const other = wallet()
      const challenge = await auth.issueChallenge({ address: account.address, chainId: 4663 })
      const tampered = [
        challenge.message.replace(account.address, other.address),
        challenge.message.replace('Chain ID: 4663', 'Chain ID: 1'),
        challenge.message.replace('127.0.0.1:8787 wants', 'evil.example wants'),
        challenge.message.replace('URI: http://127.0.0.1:8787', 'URI: https://evil.example'),
        challenge.message.replace(challenge.nonce, 'f'.repeat(32)),
        challenge.message.replace('12:05:00.000Z', '23:59:00.000Z'),
        `${challenge.message}\n`,
        challenge.message.toLowerCase(),
      ]
      for (const message of tampered) {
        expect(message).not.toBe(challenge.message)
        expect(await rejection(auth.verify({ nonce: challenge.nonce, signature: await account.signMessage({ message }) }, null)), message).toEqual([401, 'signature_invalid'])
      }
      // A signature that is the right shape but not a signature.
      expect(await rejection(auth.verify({ nonce: challenge.nonce, signature: `0x${'00'.repeat(65)}` }, null))).toEqual([401, 'signature_invalid'])
      expect(await count('sessions')).toBe(0)
    })

    it('cannot be used to sign in as an address other than the one it was issued for', async () => {
      await setup()
      const { auth } = service()
      const mine = wallet()
      const victim = wallet()
      // A validly signed challenge for my own address…
      const challenge = await auth.issueChallenge({ address: mine.address, chainId: 4663 })
      const signature = await mine.signMessage({ message: challenge.message })
      // …cannot be replayed against a challenge issued to someone else.
      const theirs = await auth.issueChallenge({ address: victim.address, chainId: 4663 })
      expect(await rejection(auth.verify({ nonce: theirs.nonce, signature }, null))).toEqual([401, 'signature_invalid'])
      expect((await auth.verify({ nonce: challenge.nonce, signature }, null)).viewer.wallet.address).toBe(mine.address)
    })

    it('refuses a challenge issued for another origin or another chain, even with a valid signature', async () => {
      await setup()
      const account = wallet()
      const elsewhere = service({ publicOrigin: 'https://staging.rarecity.example' }).auth
      const here = service().auth
      const foreign = await elsewhere.issueChallenge({ address: account.address, chainId: 4663 })
      expect(foreign.message).toContain('staging.rarecity.example wants you to sign in')
      const signature = await account.signMessage({ message: foreign.message })
      expect(await rejection(here.verify({ nonce: foreign.nonce, signature }, null))).toEqual([401, 'challenge_invalid'])
      expect((await elsewhere.verify({ nonce: foreign.nonce, signature }, null)).viewer.authenticated).toBe(true)

      const challenge = await here.issueChallenge({ address: account.address, chainId: 4663 })
      await t.db.query('UPDATE auth_challenges SET chain_id = 1 WHERE nonce = $1', [challenge.nonce])
      expect(await rejection(here.verify({ nonce: challenge.nonce, signature: await account.signMessage({ message: challenge.message }) }, null))).toEqual([401, 'challenge_invalid'])
    })

    it('expires: a challenge signed in time but presented late does not authenticate', async () => {
      await setup()
      const { auth, advance } = service()
      const account = wallet()
      const challenge = await auth.issueChallenge({ address: account.address, chainId: 4663 })
      const signature = await account.signMessage({ message: challenge.message })
      advance(CHALLENGE_TTL_MS - 1)
      const late = await auth.issueChallenge({ address: account.address, chainId: 4663 })
      advance(1)
      expect(await rejection(auth.verify({ nonce: challenge.nonce, signature }, null))).toEqual([401, 'challenge_invalid'])
      expect(await count('sessions')).toBe(0)
      // The one issued later is still good.
      expect((await auth.verify({ nonce: late.nonce, signature: await account.signMessage({ message: late.message }) }, null)).viewer.authenticated).toBe(true)
    })

    it('is single-use: the same nonce and signature never authenticate twice', async () => {
      await setup()
      const { auth } = service()
      const { challenge, account } = await signIn(auth)
      const signature = await account.signMessage({ message: challenge.message })
      expect(await rejection(auth.verify({ nonce: challenge.nonce, signature }, null))).toEqual([401, 'challenge_invalid'])
      expect(await rejection(auth.verify({ nonce: 'e'.repeat(32), signature }, null))).toEqual([401, 'challenge_invalid'])
      expect(await count('sessions')).toBe(1)
    })

    it('cannot be replayed by racing: of many simultaneous verifications exactly one succeeds', async () => {
      await setup()
      const { auth } = service()
      const account = wallet()
      const challenge = await auth.issueChallenge({ address: account.address, chainId: 4663 })
      const signature = await account.signMessage({ message: challenge.message })
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => auth.verify({ nonce: challenge.nonce, signature }, null)))
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'challenge_invalid', status: 401 })
      expect([await count('users'), await count('wallets'), await count('sessions')]).toEqual([1, 1, 1])
    })

    it('makes one user of one address, however it is spelled and however many sign-ins race', async () => {
      await setup()
      const { auth } = service()
      const account = wallet()
      const spellings = [account.address, account.address.toLowerCase(), account.address, account.address.toLowerCase()]
      const challenges = await Promise.all(spellings.map((address) => auth.issueChallenge({ address, chainId: 4663 })))
      const opened = await Promise.all(challenges.map(async (c) => auth.verify({ nonce: c.nonce, signature: await account.signMessage({ message: c.message }) }, null)))
      expect(new Set(opened.map((o) => o.viewer.userId)).size).toBe(1)
      expect(new Set(opened.map((o) => o.token)).size).toBe(4)
      expect([await count('users'), await count('wallets'), await count('sessions')]).toEqual([1, 1, 4])
      expect((await t.db.query('SELECT address FROM wallets')).rows).toEqual([{ address: account.address.toLowerCase() }])
      // A different wallet is a different user.
      expect((await signIn(auth)).viewer.userId).not.toBe(opened[0].viewer.userId)
      expect(await count('users')).toBe(2)
    })

    it('refuses malformed verification input before touching the database', async () => {
      await setup()
      const { auth } = service()
      const sig = `0x${'ab'.repeat(65)}`
      const nonce = 'a'.repeat(32)
      for (const input of [null, {}, { nonce }, { signature: sig }, { nonce: 'A'.repeat(32), signature: sig }, { nonce: nonce.slice(1), signature: sig }, { nonce, signature: sig.slice(2) }, { nonce, signature: `${sig}00` }, { nonce, signature: `0x${'zz'.repeat(65)}` }, { nonce, signature: sig, message: 'x' }, { nonce: 1, signature: sig }])
        expect(await rejection(auth.verify(input, null)), JSON.stringify(input)).toEqual([400, 'invalid_request'])
    })

    it('cannot be blocked for an address by someone else asking for challenges on its behalf', async () => {
      await setup()
      const { auth, advance } = service()
      const account = wallet()
      const mine = await auth.issueChallenge({ address: account.address, chainId: 4663 })
      // Anyone can ask for a challenge for a public address. However many they ask for, mine still works.
      for (let i = 0; i < 40; i++) {
        advance(1_000)
        await auth.issueChallenge({ address: account.address, chainId: 4663 })
      }
      expect(await count('auth_challenges')).toBe(41)
      expect((await auth.verify({ nonce: mine.nonce, signature: await account.signMessage({ message: mine.message }) }, null)).viewer.authenticated).toBe(true)
    })

    it('never refuses a challenge, and keeps the table to the newest ones', async () => {
      await setup()
      const { auth, advance } = service({ maxChallenges: 3 })
      const account = wallet()
      const issued: { nonce: string; message: string }[] = []
      for (let i = 0; i < 6; i++) {
        issued.push(await auth.issueChallenge({ address: account.address, chainId: 4663 }))
        advance(15_000)
      }
      expect(await count('auth_challenges')).toBe(3)
      const sign = (c: { message: string }) => account.signMessage({ message: c.message })
      // The ones pushed out are simply gone, so they cannot authenticate; the newest can.
      for (const old of issued.slice(0, 3)) expect(await rejection(auth.verify({ nonce: old.nonce, signature: await sign(old) }, null))).toEqual([401, 'challenge_invalid'])
      expect((await auth.verify({ nonce: issued[5].nonce, signature: await sign(issued[5]) }, null)).viewer.authenticated).toBe(true)
    })

    it('deletes dead challenges and long-ended sessions, and nothing that is still live', async () => {
      await setup()
      const { auth, advance } = service()
      const { token } = await signIn(auth)
      await auth.issueChallenge({ address: wallet().address, chainId: 4663 })
      expect([await count('auth_challenges'), await count('sessions')]).toEqual([2, 1])

      // An hour after they expire, the consumed and the unanswered challenge are both removed.
      advance(CHALLENGE_TTL_MS + 60 * 60_000 + 1)
      const fresh = await auth.issueChallenge({ address: wallet().address, chainId: 4663 })
      expect((await t.db.query('SELECT nonce FROM auth_challenges')).rows).toEqual([{ nonce: fresh.nonce }])
      expect((await auth.viewer(token)).authenticated).toBe(true)

      // The session is kept while it is live and for thirty days after it ends.
      advance(SESSION_TTL_MS + 29 * 24 * 60 * 60_000)
      await auth.issueChallenge({ address: wallet().address, chainId: 4663 })
      expect(await count('sessions')).toBe(1)
      advance(2 * 24 * 60 * 60_000)
      await auth.issueChallenge({ address: wallet().address, chainId: 4663 })
      expect(await count('sessions')).toBe(0)
      expect([await count('users'), await count('wallets')]).toEqual([1, 1])
    })
  })

  describe('sessions', () => {
    it('ends at sign-out: the credential stops working and stays revoked', async () => {
      await setup()
      const { auth } = service()
      const { token } = await signIn(auth)
      expect((await auth.viewer(token)).authenticated).toBe(true)
      await auth.logout(token)
      expect(await auth.viewer(token)).toEqual({ authenticated: false })
      expect((await t.db.query('SELECT revoked_at FROM sessions')).rows[0].revoked_at).toEqual(T0)
      // Signing out again, or with nonsense, changes nothing and is not an error.
      await auth.logout(token)
      await auth.logout('garbage')
      await auth.logout(null)
      expect(await count('sessions')).toBe(1)
    })

    it('ends after seven days, and is not extended by use', async () => {
      await setup()
      const { auth, advance } = service()
      const { token } = await signIn(auth)
      advance(SESSION_TTL_MS - 1)
      expect((await auth.viewer(token)).authenticated).toBe(true)
      advance(1)
      expect(await auth.viewer(token)).toEqual({ authenticated: false })
    })

    it('treats anything that is not a live session as anonymous, never as an error', async () => {
      await setup()
      const { auth } = service()
      const { token } = await signIn(auth)
      const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`
      for (const presented of [null, '', 'demo-player', token.slice(1), `${token}x`, flipped, 'a'.repeat(43), "'; DROP TABLE sessions; --", '\u0000'.repeat(43)]) expect(await auth.viewer(presented), String(presented)).toEqual({ authenticated: false })
      expect((await auth.viewer(token)).authenticated).toBe(true)
    })

    it('gives every sign-in a fresh credential and retires the one the browser arrived with', async () => {
      await setup()
      const { auth } = service()
      const first = await signIn(auth)
      const second = await signIn(auth, first.account, first.token)
      expect(second.token).not.toBe(first.token)
      expect(second.viewer.userId).toBe(first.viewer.userId)
      expect(await auth.viewer(first.token)).toEqual({ authenticated: false })
      expect((await auth.viewer(second.token)).authenticated).toBe(true)
      // Another browser's session for the same wallet is its own, and is not touched.
      const elsewhere = await signIn(auth, first.account)
      expect((await auth.viewer(second.token)).authenticated).toBe(true)
      expect((await auth.viewer(elsewhere.token)).authenticated).toBe(true)
      // A credential that was presented cannot be adopted: the new session is never the presented value.
      const planted = 'p'.repeat(43)
      const third = await signIn(auth, wallet(), planted)
      expect(third.token).not.toBe(planted)
      expect(await auth.viewer(planted)).toEqual({ authenticated: false })
    })
  })

  describe('over HTTP', () => {
    const servers: Server[] = []
    afterEach(async () => {
      await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
    })

    async function serve(mode: AppMode = 'local', ownership: OwnershipProvider = createFixtureOwnershipProvider(), lines: string[] = []) {
      const config = testConfig({ mode, databaseUrl: 'postgres://unused', publicOrigin: mode === 'local' ? TEST_ORIGIN : 'https://rarecity.example' })
      const app = createApp({ config, db: t.db, migrationsDir: MIGRATIONS_DIR, log: createLogger((l) => lines.push(l)), city: createCityReader(t.db), auth: createAuthService({ db: t.db, publicOrigin: config.publicOrigin }), friends: createFriendsReader(ownership) })
      const server = createServer(app)
      servers.push(server)
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, origin: config.publicOrigin, lines }
    }
    const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    /** Sign in over HTTP and return the cookie pair the browser would send back. */
    async function httpSignIn(base: string, account = wallet(), cookie?: string) {
      const challenge = (await (await post(base, '/v1/auth/challenge', { address: account.address, chainId: 4663 })).json()) as { nonce: string; message: string }
      const signature: Hex = await account.signMessage({ message: challenge.message })
      const res = await post(base, '/v1/auth/verify', { nonce: challenge.nonce, signature }, cookie ? { cookie } : {})
      const setCookie = res.headers.get('set-cookie') ?? ''
      return { account, res, setCookie, cookie: setCookie.split(';')[0], signature, nonce: challenge.nonce, body: (await res.json()) as Record<string, unknown> }
    }
    const viewer = async (base: string, cookie?: string) => (await (await fetch(`${base}/v1/viewer`, { headers: cookie ? { cookie } : {} })).json()) as Record<string, unknown>

    it('signs a wallet in end to end and sets a hardened session cookie', async () => {
      await setup()
      const { base } = await serve()
      const { account, res, setCookie, body, cookie } = await httpSignIn(base)
      expect(res.status).toBe(200)
      expect(setCookie).toMatch(/^rc_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=604800$/)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(body).toEqual({ authenticated: true, userId: expect.any(String), wallet: { address: account.address, chainId: 4663 }, session: { expiresAt: expect.any(String) } })
      // The credential is in the cookie only: never in a body.
      expect(JSON.stringify(body)).not.toContain(cookie.split('=')[1])
      expect(await viewer(base, cookie)).toEqual(body)
    })

    it('marks the cookie Secure and __Host- outside local mode', async () => {
      await setup('staging')
      const { base } = await serve('staging')
      const { setCookie, cookie } = await httpSignIn(base)
      expect(setCookie).toMatch(/^__Host-rc_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=604800$/)
      expect(setCookie).not.toMatch(/Domain=/i)
      expect((await viewer(base, cookie)).authenticated).toBe(true)
      // The local-mode cookie name carries no authority here.
      expect(await viewer(base, cookie.replace('__Host-rc_session', 'rc_session'))).toEqual({ authenticated: false })
      const out = await post(base, '/v1/auth/logout', {}, { cookie })
      expect(out.headers.get('set-cookie')).toBe('__Host-rc_session=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0')
    })

    it('gives two sessions their own viewer, and an anonymous visitor none', async () => {
      await setup()
      const { base } = await serve()
      const a = await httpSignIn(base)
      const b = await httpSignIn(base)
      const [va, vb, anon] = [await viewer(base, a.cookie), await viewer(base, b.cookie), await viewer(base)]
      expect(va).toMatchObject({ authenticated: true, wallet: { address: a.account.address } })
      expect(vb).toMatchObject({ authenticated: true, wallet: { address: b.account.address } })
      expect(va.userId).not.toBe(vb.userId)
      expect(anon).toEqual({ authenticated: false })
      // Interleaved and repeated, each still sees only itself.
      const seen = await Promise.all([a.cookie, b.cookie, undefined, a.cookie, undefined, b.cookie].map((c) => viewer(base, c)))
      expect(seen.map((v) => v.userId ?? null)).toEqual([va.userId, vb.userId, null, va.userId, null, vb.userId])
      const res = await fetch(`${base}/v1/viewer`, { headers: { cookie: a.cookie } })
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('vary')).toBe('Cookie')
      expect(res.headers.get('etag')).toBeNull()
    })

    it('clears a cookie that is not a session, and answers anonymous rather than an error', async () => {
      await setup()
      const { base } = await serve()
      const res = await fetch(`${base}/v1/viewer`, { headers: { cookie: 'rc_session=not-a-session; other=1' } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ authenticated: false })
      expect(res.headers.get('set-cookie')).toBe('rc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
      expect((await fetch(`${base}/v1/viewer`)).headers.get('set-cookie')).toBeNull()
    })

    it('never puts a viewer in the shared city, and signing in or out never moves the city', async () => {
      await setup()
      await installDemoFixture(t.db, 'local')
      const { base } = await serve()
      const city = async (cookie?: string, etag?: string) => {
        const res = await fetch(`${base}/v1/city`, { headers: { ...(cookie ? { cookie } : {}), ...(etag ? { 'if-none-match': etag } : {}) } })
        return { status: res.status, etag: res.headers.get('etag'), text: await res.text(), setCookie: res.headers.get('set-cookie') }
      }
      const before = await city()
      expect(Object.keys(JSON.parse(before.text))).toEqual(['city', 'server', 'state'])
      const a = await httpSignIn(base)
      const b = await httpSignIn(base)

      // Signed in or not, it is the same bytes under the same ETag.
      const asA = await city(a.cookie)
      const asB = await city(b.cookie)
      expect([asA.text, asB.text]).toEqual([before.text, before.text])
      expect([asA.etag, asB.etag]).toEqual([before.etag, before.etag])
      expect(asA.setCookie).toBeNull()
      for (const secret of [a.cookie.split('=')[1], String(a.body.userId), a.account.address, a.account.address.toLowerCase()]) expect(before.text + asA.text).not.toContain(secret)
      // A 304 for the city says nothing about identity: the viewer is still read fresh.
      expect((await city(a.cookie, before.etag!)).status).toBe(304)
      expect((await viewer(base, a.cookie)).authenticated).toBe(true)

      await post(base, '/v1/auth/logout', {}, { cookie: a.cookie })
      expect(await viewer(base, a.cookie)).toEqual({ authenticated: false })
      expect((await viewer(base, b.cookie)).authenticated).toBe(true)
      const after = await city(a.cookie, before.etag!)
      expect(after.status).toBe(304)
      expect((await city()).etag).toBe(before.etag)
      expect((await t.db.query('SELECT sequence FROM city')).rows).toEqual([{ sequence: '1' }])
      expect(await count('city_events')).toBe(1)
    })

    it('signs out: the session is revoked and the cookie expired', async () => {
      await setup()
      const { base } = await serve()
      const { cookie } = await httpSignIn(base)
      const res = await post(base, '/v1/auth/logout', {}, { cookie })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ authenticated: false })
      expect(res.headers.get('set-cookie')).toBe('rc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
      expect(await viewer(base, cookie)).toEqual({ authenticated: false })
      expect((await t.db.query('SELECT revoked_at IS NOT NULL AS revoked FROM sessions')).rows).toEqual([{ revoked: true }])
      // Signing out when not signed in is fine too.
      expect((await post(base, '/v1/auth/logout', {})).status).toBe(200)
    })

    it('answers a replayed verification with 401 and no cookie', async () => {
      await setup()
      const { base } = await serve()
      const { nonce, signature } = await httpSignIn(base)
      const again = await post(base, '/v1/auth/verify', { nonce, signature })
      expect(again.status).toBe(401)
      expect(await again.json()).toEqual({ error: 'challenge_invalid' })
      expect(again.headers.get('set-cookie')).toBeNull()
      const forged = await post(base, '/v1/auth/verify', { nonce: 'c'.repeat(32), signature })
      expect([forged.status, await forged.json()]).toEqual([401, { error: 'challenge_invalid' }])
    })

    it('lists the Friends the signed-in wallet owns, and only for a signed-in wallet', async () => {
      await setup()
      const owner = wallet()
      const empty = wallet()
      const { base } = await serve('local', createFixtureOwnershipProvider({ owners: { [owner.address]: [[4471n, 7], [812n, 2], [2n ** 70n, 8]] } }))
      const anonymous = await fetch(`${base}/v1/viewer/friends`)
      expect([anonymous.status, await anonymous.json()]).toEqual([401, { error: 'not_authenticated' }])
      expect((await fetch(`${base}/v1/viewer/friends`, { headers: { cookie: 'rc_session=nope' } })).status).toBe(401)

      const a = await httpSignIn(base, owner)
      const res = await fetch(`${base}/v1/viewer/friends`, { headers: { cookie: a.cookie } })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toEqual({
        wallet: { address: owner.address, chainId: 4663 },
        source: 'fixture',
        asOfBlock: '0',
        friends: [
          { tokenId: '812', family: { id: 2, name: 'Family' } },
          { tokenId: '4471', family: { id: 7, name: 'Sparkling' } },
          { tokenId: '1180591620717411303424', family: { id: 8, name: 'Hollow' } },
        ],
      })
      // Whatever the request says it owns is ignored: the answer follows the session's wallet.
      const b = await httpSignIn(base, empty)
      const claimed = await fetch(`${base}/v1/viewer/friends?address=${owner.address}&tokenId=812`, { headers: { cookie: b.cookie, 'x-wallet-address': owner.address } })
      expect(await claimed.json()).toMatchObject({ wallet: { address: empty.address }, friends: [] })
      // Signed out, the list is gone.
      await post(base, '/v1/auth/logout', {}, { cookie: a.cookie })
      expect((await fetch(`${base}/v1/viewer/friends`, { headers: { cookie: a.cookie } })).status).toBe(401)
    })

    it('says so when ownership cannot be read, instead of showing an empty wallet', async () => {
      await setup()
      let reason: OwnershipError['reason'] = 'unavailable'
      const broken: OwnershipProvider = {
        source: 'robinhood-chain',
        listOwnedFriends: async () => {
          throw new OwnershipError(reason, { cause: new Error('fetch failed https://rpc.example/v2/s3cr3t-key') })
        },
        verifyOwnership: async () => false,
        resolveFamily: async () => ({ id: 0, name: 'Skeleton' }),
      }
      const { base, lines } = await serve('local', broken)
      const { cookie } = await httpSignIn(base)
      for (const [r, status, error] of [['unavailable', 503, 'ownership_unavailable'], ['inconsistent', 503, 'ownership_unavailable'], ['wrong-chain', 503, 'ownership_unavailable'], ['invalid-family', 503, 'ownership_unavailable'], ['too-large', 422, 'ownership_too_large']] as const) {
        reason = r
        const res = await fetch(`${base}/v1/viewer/friends`, { headers: { cookie } })
        expect([res.status, await res.json()], r).toEqual([status, { error }])
      }
      expect(lines.join('')).toContain('owned friends read failed')
      expect(lines.join('')).not.toContain('s3cr3t')
    })

    it('never logs a credential, a signature, a nonce or a cookie', async () => {
      await setup()
      const { base, lines } = await serve()
      const { cookie, signature, nonce } = await httpSignIn(base)
      await viewer(base, cookie)
      await fetch(`${base}/v1/viewer/friends`, { headers: { cookie } })
      await post(base, '/v1/auth/verify', { nonce, signature })
      await post(base, '/v1/auth/logout', {}, { cookie })
      await expect.poll(() => lines.length).toBeGreaterThanOrEqual(6)
      const log = lines.join('')
      for (const secret of [cookie.split('=')[1], signature, signature.slice(2), nonce, 'rc_session']) expect(log).not.toContain(secret)
      expect(JSON.parse(lines[0])).toMatchObject({ message: 'request', method: 'POST', path: '/v1/auth/challenge', status: 200 })
    })
  })
})
