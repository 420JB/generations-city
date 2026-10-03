import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { availablePlots } from '../../src/game/allocation'
import { createPropertyReader } from '../src/activation/properties'
import { ownershipEraId, propertyId } from '../src/activation/propertyId'
import { ActivationError, createActivationService, INTENT_TTL_MS, type ActivationOptions, type CommitStep } from '../src/activation/service'
import { activationDigest } from '../src/activation/typedData'
import { createAuthService, hashSessionToken, type LiveSession } from '../src/auth/service'
import { initializeCity } from '../src/city/store'
import { verifyCity } from '../src/city/verify'
import type { Database } from '../src/db/pool'
import { migrate } from '../src/db/migrations'
import { createGenesisState, districtForFamily, wardCapacity, type ActivationIntentResponse, type GameState } from '../src/engine'
import { installDemoFixture } from '../src/fixtures/demoCity'
import { createLogger } from '../src/log'
import { createGenerationsOwnershipProvider } from '../src/ownership/generations'
import type { OwnershipProvider } from '../src/ownership/provider'
import { snapshot, unguarded } from './activationFixtures'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { fakeChain } from './fakeChain'
import { TEST_ORIGIN } from './testConfig'

/** Registry family 2 (Family) lives in district d4. */
const FAMILY = 2
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

describe.skipIf(NO_TEST_DATABASE)('permanent Friend activation against a disposable Postgres', () => {
  const t = useTestSchema()

  /** Counts every statement that reaches the database through it. */
  function counting(db: Database): { db: Database; queries: () => number } {
    let n = 0
    return {
      queries: () => n,
      db: {
        query: ((...args: unknown[]) => {
          n += 1
          return (db.query as (...a: unknown[]) => unknown)(...args)
        }) as Database['query'],
        connect: (async () => {
          n += 1
          return db.connect()
        }) as Database['connect'],
        end: () => db.end(),
      },
    }
  }

  /** A migrated local database with an empty activation-rehearsal city, a fake chain, and the real services over them. */
  async function world(options: { city?: 'rehearsal' | 'fixture' | 'none' } = {}) {
    await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
    const kind = options.city ?? 'rehearsal'
    const city = kind === 'rehearsal' ? await initializeCity(t.db, { state: createGenesisState(), origin: 'demo-fixture', rehearsal: true, environment: 'local' }) : kind === 'fixture' ? await installDemoFixture(t.db, 'local') : null
    const chain = fakeChain()
    const lines: string[] = []
    const log = createLogger((line) => lines.push(line))
    /** Runs inside every activation read, before the chain is asked. Lets a test move the world mid-request. */
    const during: { read: (() => Promise<void>) | null } = { read: null }
    const real = createGenerationsOwnershipProvider({ transport: chain.transport })
    const ownership: OwnershipProvider = {
      ...real,
      async verifyActivation(address, tokenId) {
        const hook = during.read
        during.read = null
        await hook?.()
        return real.verifyActivation(address, tokenId)
      },
    }
    const auth = createAuthService({ db: t.db, publicOrigin: TEST_ORIGIN })
    const service = (patch: Partial<ActivationOptions> = {}) => createActivationService({ db: t.db, ownership, publicOrigin: TEST_ORIGIN, enabled: true, log, ...patch })

    /** A wallet that owns these Friends on the fake chain and is signed in. */
    async function person(tokens: readonly (readonly [bigint, number])[] = [], signer: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey()), via = auth) {
      for (const [tokenId, familyId] of tokens) {
        chain.mint(signer.address, tokenId)
        chain.families.set(tokenId, familyId)
      }
      const challenge = await via.issueChallenge({ address: signer.address, chainId: 4663 })
      const opened = await via.verify({ nonce: challenge.nonce, signature: await signer.signMessage({ message: challenge.message }) }, null)
      const session = (await via.session(opened.token))!
      expect(session).not.toBeNull()
      return { account: signer, cookie: opened.token, session, userId: session.userId }
    }
    return { city: city!, chain, lines, during, ownership, auth, service, person }
  }

  type World = Awaited<ReturnType<typeof world>>
  type Person = Awaited<ReturnType<World['person']>>

  const sign = (who: { account: PrivateKeyAccount }, intent: ActivationIntentResponse) => who.account.signTypedData(JSON.parse(JSON.stringify(intent.typedData)))
  const cityRow = async () => (await t.db.query<{ instance_id: string; sequence: string; state: GameState; hash: string; updated_at: Date }>('SELECT instance_id, sequence, state, md5(state::text) AS hash, updated_at FROM city')).rows[0]
  const tally = async () =>
    (
      await t.db.query<{ issued: number; committed: number; superseded: number; properties: number; eras: number; events: number }>(
        `SELECT (SELECT count(*)::int FROM activation_intents WHERE status = 'issued') AS issued,
                (SELECT count(*)::int FROM activation_intents WHERE status = 'committed') AS committed,
                (SELECT count(*)::int FROM activation_intents WHERE status = 'superseded') AS superseded,
                (SELECT count(*)::int FROM properties) AS properties,
                (SELECT count(*)::int FROM ownership_eras) AS eras,
                (SELECT count(*)::int FROM city_events) AS events`,
      )
    ).rows[0]
  const NOTHING = { issued: 0, committed: 0, superseded: 0, properties: 0, eras: 0, events: 1 }
  /** Everything permanent, as text: the city, its events, the properties and their eras. */
  const permanent = async () => [await snapshot(t.db, 'city', 'id'), await snapshot(t.db, 'city_events', 'sequence'), await snapshot(t.db, 'properties', 'id'), await snapshot(t.db, 'ownership_eras', 'id')].join('\n')
  const intents = async () => snapshot(t.db, 'activation_intents', 'issued_at, id')
  /** The code a refused activation was refused with. Anything that is not a refusal fails the test. */
  const refusal = async (work: Promise<unknown>) => {
    const err = await work.then(
      () => null,
      (e: unknown) => e,
    )
    if (!(err instanceof ActivationError)) throw new Error(`expected an activation refusal, got ${err === null ? 'success' : String(err)}`)
    return err.code
  }
  /** Issue, sign and commit one activation. */
  async function activate(w: World, who: Person, tokenId: bigint, plotId: string, svc = w.service()) {
    const intent = await svc.issueIntent(who.session, { tokenId: tokenId.toString(), plotId })
    const signature = await sign(who, intent)
    return { intent, signature, result: await svc.commit(who.session, { intentId: intent.intentId, signature }) }
  }

  describe('the happy path', () => {
    it('issues, signs and commits: one building, one event, one property, one era, one committed intent, one step', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const svc = w.service()
      const before = await cityRow()

      const issuedHead = w.chain.head
      const intent = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      // Issuing changes nothing in the city and reserves nothing.
      expect(await tally()).toEqual({ ...NOTHING, issued: 1 })
      expect((await cityRow()).hash).toBe(before.hash)

      w.chain.head += 40n
      const signature = await sign(me, intent)
      const result = await svc.commit(me.session, { intentId: intent.intentId, signature })

      const id = propertyId('812')
      expect(id).toBe('29d2ac0a-1754-8500-acdd-802ba2c51575')
      expect(result).toEqual({
        status: 'committed',
        property: { id, tokenId: '812', buildingId: 'b-812', districtId: 'd4', ward: 0, plot: 7, plotId: 'd4-w0-p7', activatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/), sequence: 2 },
        city: { id: 'main', instance: w.city.instance },
      })
      expect(await tally()).toEqual({ issued: 0, committed: 1, superseded: 0, properties: 1, eras: 1, events: 2 })

      // THE CITY: the sequence advanced exactly once, and the state gained exactly this building.
      const after = await cityRow()
      expect([after.instance_id, after.sequence]).toEqual([before.instance_id, '2'])
      expect(Object.keys(after.state.buildings)).toEqual(['b-812'])
      expect(after.state.buildings['b-812']).toMatchObject({ id: 'b-812', friendId: 812, ownerId: me.userId, districtId: 'd4', ward: 0, plot: 7, ownerBuilt: 0, patrons: {}, fixtures: [], milestones: [], billboard: { image: null, updatedClock: null } })
      expect(after.state.clock).toBe(before.state.clock + 1)
      // An ordinary free plot opens no ward.
      expect(after.state.wards).toEqual(before.state.wards)
      // The first activation creates the user's display record, with this Friend as avatar.
      const address = me.account.address.toLowerCase()
      expect(after.state.users).toEqual({ [me.userId]: { id: me.userId, handle: `${address.slice(0, 6)}…${address.slice(-4)}`, friendId: 812, hue: Number.parseInt(address.slice(2, 10), 16) % 360 } })
      // Nothing of the demo: no resident counter, no simulated RF, no Representative, no reward, no Radio.
      expect(after.state.residentSeq).toBe(before.state.residentSeq)
      expect(after.state.wallets).toEqual({})
      expect(after.state.season).toEqual(before.state.season)
      expect([after.state.badges, after.state.counters, after.state.radio]).toEqual([{}, {}, []])

      // THE EVENT: exactly one, at the new sequence, with durable public facts only.
      const events = (await t.db.query<{ sequence: string; type: string; payload: Record<string, unknown> }>('SELECT sequence, type, payload FROM city_events ORDER BY sequence')).rows
      expect(events.map((e) => [e.sequence, e.type])).toEqual([['1', 'city.initialized'], ['2', 'property.activated']])
      expect(events[1].payload).toEqual({ propertyId: id, tokenId: '812', userId: me.userId, ownerAddress: address, familyId: 2, districtId: 'd4', ward: 0, plot: 7, plotId: 'd4-w0-p7', verifiedBlock: w.chain.head.toString() })

      // THE PROPERTY, its first ownership era, and the committed intent, all at one moment and one block.
      const property = (await t.db.query('SELECT *, token_id::text AS token FROM properties')).rows[0]
      expect(property).toMatchObject({ id, city_id: 'main', city_instance_id: w.city.instance, chain_id: 4663, collection: '0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d', token: '812', family_id: 2, district_id: 'd4', ward: 0, plot: 7, plot_id: 'd4-w0-p7', building_id: 'b-812', activated_sequence: '2', activated_by_user_id: me.userId, activated_by_wallet_id: me.session.walletId, activation_intent_id: intent.intentId, verified_block: w.chain.head.toString() })
      expect(property.activated_at.toISOString()).toBe(result.property.activatedAt)
      const era = (await t.db.query('SELECT * FROM ownership_eras')).rows[0]
      expect(era).toMatchObject({ id: ownershipEraId(id, 1), property_id: id, era_number: 1, owner_address: address, owner_wallet_id: me.session.walletId, owner_user_id: me.userId, start_reason: 'activation', start_block: w.chain.head.toString(), ended_at: null, end_reason: null, end_block: null })
      expect(era.started_at).toEqual(property.activated_at)
      const row = (await t.db.query('SELECT * FROM activation_intents')).rows[0]
      expect(row).toMatchObject({ id: intent.intentId, status: 'committed', property_id: id, session_id: me.session.sessionId, issued_block: issuedHead.toString() })
      // The exact 65 bytes the wallet produced.
      expect(`0x${row.signature.toString('hex')}`).toBe(signature)
      expect(row.committed_at).toEqual(property.activated_at)
      expect(after.updated_at).toEqual(property.activated_at)
      // The second read is recorded on the property; the first on the intent. They are different blocks here.
      expect(BigInt(property.verified_block) - BigInt(row.issued_block)).toBe(40n)

      expect(await verifyCity(t.db)).toMatchObject({ ok: true, violations: [], counts: { buildings: 1, users: 1, events: 2, properties: 1, eras: 1, openEras: 1, intents: 1, committedIntents: 1 } })
    })

    it('stores the intent exactly as issued, timed by the database clock, and returns what the wallet must sign', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const intent = await w.service({ random: () => Buffer.alloc(32, 0xab) }).issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      expect(Object.keys(intent)).toEqual(['intentId', 'expiresAt', 'typedData', 'digest'])
      expect(intent.intentId).toBe('ab'.repeat(32))
      expect(intent.typedData.message).toEqual({
        intentId: `0x${'ab'.repeat(32)}`,
        site: TEST_ORIGIN,
        statement: 'Activate this Rare Friend as a permanent Rare City property.',
        wallet: me.account.address,
        collection: '0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D',
        tokenId: '812',
        familyId: 2,
        familyName: 'Family',
        cityId: 'main',
        cityInstance: w.city.instance,
        districtId: 'd4',
        ward: 0,
        plot: 7,
        plotId: 'd4-w0-p7',
        issuedAt: expect.stringMatching(/^\d{13}$/),
        expiresAt: expect.stringMatching(/^\d{13}$/),
      })
      expect(intent.typedData.domain).toEqual({ name: 'Rare City', version: '1', chainId: 4663 })
      expect(intent.digest).toBe(activationDigest(intent.typedData))

      const row = (await t.db.query('SELECT *, token_id::text AS token, abs(extract(epoch FROM (issued_at - now()))) AS skew FROM activation_intents')).rows[0]
      expect(row).toMatchObject({ id: intent.intentId, user_id: me.userId, wallet_id: me.session.walletId, session_id: me.session.sessionId, owner_address: me.account.address.toLowerCase(), chain_id: 4663, collection: '0x14c49e6118f46525de9ab41a51cbaa3c6ebf181d', token: '812', family_id: 2, city_id: 'main', city_instance_id: w.city.instance, district_id: 'd4', ward: 0, plot: 7, plot_id: 'd4-w0-p7', origin: TEST_ORIGIN, issued_block: w.chain.head.toString(), status: 'issued', committed_at: null, signature: null, property_id: null })
      expect(`0x${row.digest.toString('hex')}`).toBe(intent.digest)
      // Signed times are the stored times, to the millisecond, and the stored time is the database's "now".
      expect(String(row.issued_at.getTime())).toBe(intent.typedData.message.issuedAt)
      expect(String(row.expires_at.getTime())).toBe(intent.typedData.message.expiresAt)
      expect(row.expires_at.toISOString()).toBe(intent.expiresAt)
      expect(row.expires_at.getTime() - row.issued_at.getTime()).toBe(INTENT_TTL_MS)
      expect(Number(row.skew)).toBeLessThan(5)
      expect(await sign(me, intent)).toMatch(/^0x[0-9a-f]{130}$/)
    })

    it('activates the smallest and the largest Friend the city can hold', async () => {
      const w = await world()
      const me = await w.person([[0n, FAMILY], [9007199254740991n, FAMILY]])
      expect((await activate(w, me, 0n, 'd4-w0-p0')).result.property).toMatchObject({ id: propertyId('0'), tokenId: '0', buildingId: 'b-0' })
      expect((await activate(w, me, 9007199254740991n, 'd4-w0-p1')).result.property).toMatchObject({ id: propertyId('9007199254740991'), tokenId: '9007199254740991', buildingId: 'b-9007199254740991', sequence: 3 })
      expect(Object.keys((await cityRow()).state.buildings).sort()).toEqual(['b-0', 'b-9007199254740991'])
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('places every family in its own district and nowhere else', async () => {
      const w = await world()
      const me = await w.person(Array.from({ length: 9 }, (_, familyId) => [BigInt(100 + familyId), familyId] as const))
      for (let familyId = 0; familyId < 9; familyId++) {
        const district = districtForFamily(familyId)!
        const elsewhere = districtForFamily((familyId + 1) % 9)!
        expect(await refusal(w.service().issueIntent(me.session, { tokenId: String(100 + familyId), plotId: `${elsewhere}-w0-p5` })), `family ${familyId}`).toBe('plot_invalid')
        expect((await activate(w, me, BigInt(100 + familyId), `${district}-w0-p0`)).result.property.districtId).toBe(district)
      }
      expect(await tally()).toMatchObject({ properties: 9, eras: 9, events: 10, committed: 9, issued: 0, superseded: 0 })
      expect((await verifyCity(t.db)).ok).toBe(true)
    })
  })

  describe('the one pinned ownership read', () => {
    it('reads owner and family at one block when issuing, and again at one fresh block before committing', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const svc = w.service()
      const reads = () => w.chain.requests.map((r) => r.method)
      const blocks = () => w.chain.requests.filter((r) => r.method === 'eth_call').map((r) => BigInt(r.params[1] as string))

      const intent = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const first = w.chain.head
      expect(reads()).toEqual(['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_call'])
      expect(blocks()).toEqual([first, first])

      w.chain.head += 7n
      await svc.commit(me.session, { intentId: intent.intentId, signature: await sign(me, intent) })
      // The second read is not optional and not a reuse: it pins the block again and reads both contracts at it.
      expect(reads()).toEqual(['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_call', 'eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_call'])
      expect(blocks()).toEqual([first, first, first + 7n, first + 7n])
      // Never the Transfer history, never Multicall.
      expect(w.chain.logQueries()).toEqual([])
      expect((await t.db.query('SELECT issued_block, (SELECT verified_block FROM properties) AS verified_block FROM activation_intents')).rows).toEqual([{ issued_block: first.toString(), verified_block: (first + 7n).toString() }])
    })

    it('refuses a provider that has fallen behind the block the intent was issued on', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const intent = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const before = await permanent()
      w.chain.head -= 3n
      expect(await refusal(w.service().commit(me.session, { intentId: intent.intentId, signature: await sign(me, intent) }))).toBe('ownership_unavailable')
      expect(await permanent()).toBe(before)
      expect(await tally()).toEqual({ ...NOTHING, issued: 1 })
    })
  })

  describe('requests that are not exactly the request', () => {
    it('refuses every malformed token id and plot before the chain and before any write', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const svc = w.service()
      const before = w.chain.requests.length
      const bodies: unknown[] = [
        ...['01', '0812', '812.0', '1.0', '1e3', '0x32c', '0x10', ' 812', '812 ', '8 12', '+812', '-812', '-1', '+1', '1.5', '8.12e2', 'NaN', 'Infinity', '', '9007199254740992', '18446744073709551616'].map((tokenId) => ({ tokenId, plotId: 'd4-w0-p7' })),
        { tokenId: 812, plotId: 'd4-w0-p7' },
        { tokenId: null, plotId: 'd4-w0-p7' },
        { tokenId: ['812'], plotId: 'd4-w0-p7' },
        ...['', 'd4', 'd0-w0-p0', 'd10-w0-p0', 'd4-w00-p7', 'd4-w0-p07', 'd4-w0-p-1', 'D4-w0-p7', ' d4-w0-p7', 'd4-w0-p7 ', 'd4-w0-p1e1'].map((plotId) => ({ tokenId: '812', plotId })),
        { tokenId: '812', plotId: 7 },
        // Exactly two keys: nothing missing, nothing extra, and nothing the browser would like to assert.
        { tokenId: '812' },
        { plotId: 'd4-w0-p7' },
        {},
        { tokenId: '812', plotId: 'd4-w0-p7', familyId: 2 },
        { tokenId: '812', plotId: 'd4-w0-p7', districtId: 'd4' },
        { tokenId: '812', plotId: 'd4-w0-p7', cityInstance: w.city.instance },
        { tokenId: '812', plotId: 'd4-w0-p7', wallet: me.account.address },
        null,
        'tokenId=812',
        ['812', 'd4-w0-p7'],
      ]
      for (const body of bodies) expect(await refusal(svc.issueIntent(me.session, body)), JSON.stringify(body)).toBe('invalid_request')
      expect(w.chain.requests.length).toBe(before)
      expect(await tally()).toEqual(NOTHING)
    })

    it('refuses a commit that is not exactly an intent id and a signature, and never reads typed data back', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const svc = w.service()
      const intent = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      const before = w.chain.requests.length
      const bodies: unknown[] = [
        {},
        { intentId: intent.intentId },
        { signature },
        { intentId: intent.intentId.toUpperCase(), signature },
        { intentId: `0x${intent.intentId}`, signature },
        { intentId: intent.intentId.slice(1), signature },
        { intentId: intent.intentId, signature: signature.slice(2) },
        { intentId: intent.intentId, signature: `${signature}00` },
        { intentId: intent.intentId, signature: signature.slice(0, -2) },
        { intentId: intent.intentId, signature: 12 },
        // The browser may not send back what was signed: the server already knows.
        { intentId: intent.intentId, signature, typedData: intent.typedData },
        { intentId: intent.intentId, signature, digest: intent.digest },
        { intentId: intent.intentId, signature, tokenId: '812' },
        { intentId: intent.intentId, signature, plotId: 'd4-w0-p8' },
        null,
        [intent.intentId, signature],
      ]
      for (const body of bodies) expect(await refusal(svc.commit(me.session, body)), JSON.stringify(body)).toBe('invalid_request')
      expect(w.chain.requests.length).toBe(before)
      expect(await tally()).toEqual({ ...NOTHING, issued: 1 })
    })

    it('does nothing for a session on another chain', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const elsewhere: LiveSession = { ...me.session, chainId: 1 }
      const before = w.chain.requests.length
      expect(await refusal(w.service().issueIntent(elsewhere, { tokenId: '812', plotId: 'd4-w0-p7' }))).toBe('unsupported_chain')
      expect(await refusal(w.service().commit(elsewhere, { intentId: 'a'.repeat(64), signature: `0x${'b'.repeat(130)}` }))).toBe('unsupported_chain')
      expect(w.chain.requests.length).toBe(before)
      expect(await tally()).toEqual(NOTHING)
    })
  })

  describe('with ACTIVATION_ENABLED off', () => {
    it('refuses both steps before any chain read, any database read and any write', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      // An intent issued while activation was on cannot be committed once it is off.
      const intent = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      const before = [await permanent(), await intents()]
      const rpc = w.chain.requests.length

      const counted = counting(t.db)
      const off = w.service({ enabled: false, db: counted.db })
      expect(await refusal(off.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p8' }))).toBe('activation_disabled')
      expect(await refusal(off.commit(me.session, { intentId: intent.intentId, signature }))).toBe('activation_disabled')
      // Malformed requests are told the same thing: off is decided first.
      expect(await refusal(off.issueIntent(me.session, { nope: true }))).toBe('activation_disabled')
      expect(counted.queries()).toBe(0)
      expect(w.chain.requests.length).toBe(rpc)
      expect([await permanent(), await intents()]).toEqual(before)
    })
  })

  describe('the city must be one that may hold properties, and sound', () => {
    it('never issues or commits in an ordinary demo fixture city', async () => {
      const w = await world({ city: 'fixture' })
      const me = await w.person([[812n, FAMILY]])
      const before = await permanent()
      expect(await refusal(w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' }))).toBe('city_not_activatable')
      expect(w.chain.requests).toEqual([])
      expect(await permanent()).toBe(before)
      expect(await tally()).toMatchObject({ issued: 0, properties: 0, events: 1 })
    })

    it('never creates a city: with none installed it refuses and installs nothing', async () => {
      const w = await world({ city: 'none' })
      const me = await w.person([[812n, FAMILY]])
      expect(await refusal(w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' }))).toBe('city_not_activatable')
      expect(w.chain.requests).toEqual([])
      expect((await t.db.query('SELECT count(*)::int AS n FROM city')).rows[0].n).toBe(0)
      expect(await tally()).toEqual({ ...NOTHING, events: 0 })
    })

    it('refuses to issue against a city that fails its invariants, before the chain is asked', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      // A building with no property row: a state the guards make unreachable.
      const { state } = await cityRow()
      const phantom = { ...state, users: { ghost: { id: 'ghost', handle: 'ghost', friendId: 1, hue: 0 } }, buildings: { 'b-1': { id: 'b-1', friendId: 1, ownerId: 'ghost', districtId: 'd4', ward: 0, plot: 0, ownerBuilt: 0, patrons: {}, architecture: {}, fixtures: [], landscapeInventory: {}, landscapeSlots: [], billboard: { image: null, updatedClock: null }, milestones: [] } } }
      await unguarded(t.db, () => t.db.query('UPDATE city SET state = $1::json', [JSON.stringify(phantom)]))
      expect(await refusal(w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' }))).toBe('city_inconsistent')
      expect(w.chain.requests).toEqual([])
      expect(await tally()).toEqual(NOTHING)
      const logged = w.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.message === 'city failed its authoritative invariants: activation refused')
      expect(logged).toEqual([expect.objectContaining({ level: 'error', when: 'issue', sequence: '1', violations: 2, rule: 'count' })])
    })

    it('aborts a commit when the locked city fails its invariants before the mutation', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const intent = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      // Between issue and commit the stored state is corrupted: a simulated wallet appears in a city that may hold none.
      const { state } = await cityRow()
      await unguarded(t.db, () => t.db.query('UPDATE city SET state = $1::json', [JSON.stringify({ ...state, users: { ghost: { id: 'ghost', handle: 'ghost', friendId: 1, hue: 0 } }, wallets: { ghost: 500 } })]))
      const before = [await permanent(), await intents()]
      expect(await refusal(w.service().commit(me.session, { intentId: intent.intentId, signature }))).toBe('city_inconsistent')
      expect([await permanent(), await intents()]).toEqual(before)
      expect(await tally()).toEqual({ ...NOTHING, issued: 1 })
      expect(w.lines.some((l) => l.includes('"when":"before-commit"') && l.includes('simulated-wallet'))).toBe(true)
    })

    it('rolls everything back when the stored result fails the check after the mutation', async () => {
      const corruptions: [string, (state: GameState) => void][] = [
        // The building is not where its property says it is.
        ['plot moved', (state) => void (state.buildings['b-812'].plot += 1)],
        // A building appears that no property accounts for.
        ['extra building', (state) => void (state.buildings['b-9'] = { ...state.buildings['b-812'], id: 'b-9', friendId: 9, plot: 3 })],
        // Sound and in parity, but not the state the transition produced.
        ['not the transition', (state) => void (state.clock += 5)],
        // Sound and in parity, but the building went to somebody else.
        ['another owner', (state) => {
          state.users.thief = { id: 'thief', handle: 'thief', friendId: 812, hue: 1 }
          state.buildings['b-812'].ownerId = 'thief'
        }],
      ]
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const intent = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      const before = [await permanent(), await intents()]
      for (const [label, corrupt] of corruptions) {
        const faulty = w.service({
          async onCommitStep(step, client) {
            if (step !== 'intent') return
            // Every write has been made. Now the stored state is altered behind the guards, as a bug or a bad transition would.
            const { state } = (await client.query<{ state: GameState }>('SELECT state FROM city')).rows[0]
            corrupt(state)
            await client.query(`SET LOCAL session_replication_role = 'replica'`)
            await client.query('UPDATE city SET state = $1::json', [JSON.stringify(state)])
            await client.query(`SET LOCAL session_replication_role = 'origin'`)
          },
        })
        expect(await refusal(faulty.commit(me.session, { intentId: intent.intentId, signature })), label).toBe('city_inconsistent')
        expect([await permanent(), await intents()], label).toEqual(before)
      }
      expect(await tally()).toEqual({ ...NOTHING, issued: 1 })
      // Nothing is left behind: the same intent and signature still commit cleanly.
      expect((await w.service().commit(me.session, { intentId: intent.intentId, signature })).property.sequence).toBe(2)
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('leaves zero partial activation when the transaction fails after any of its writes', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const intent = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      const before = [await permanent(), await intents()]
      const steps: CommitStep[] = ['city', 'event', 'property', 'era', 'intent']
      const reached: CommitStep[] = []
      for (const failAfter of steps) {
        const failing = w.service({
          onCommitStep(step) {
            reached.push(step)
            if (step === failAfter) throw new Error(`injected failure after ${step}`)
          },
        })
        await expect(failing.commit(me.session, { intentId: intent.intentId, signature }), failAfter).rejects.toThrow(`injected failure after ${failAfter}`)
        // No building, no event, no property, no era, no sequence step, and the intent is still merely issued.
        expect([await permanent(), await intents()], failAfter).toEqual(before)
        expect(await tally(), failAfter).toEqual({ ...NOTHING, issued: 1 })
        expect((await cityRow()).sequence, failAfter).toBe('1')
      }
      // Each run got exactly as far as its failure, in the order the writes are made.
      expect(reached).toEqual(['city', 'city', 'event', 'city', 'event', 'property', 'city', 'event', 'property', 'era', 'city', 'event', 'property', 'era', 'intent'])
      expect((await w.service().commit(me.session, { intentId: intent.intentId, signature })).property.sequence).toBe(2)
      expect(await tally()).toEqual({ issued: 0, committed: 1, superseded: 0, properties: 1, eras: 1, events: 2 })
      expect((await verifyCity(t.db)).ok).toBe(true)
    })
  })

  describe('a connection is never left holding half an activation', () => {
    /** The pool, handing out connections that record how they were given back and can be made to misbehave. */
    function watched(sabotage: (text: string) => Error | null = () => null) {
      const released: unknown[] = []
      const sent: string[] = []
      const db: Database = {
        query: t.db.query.bind(t.db) as Database['query'],
        end: () => t.db.end(),
        connect: (async () => {
          const client = await t.db.connect()
          return new Proxy(client, {
            get(target, key) {
              if (key === 'release')
                return (arg?: unknown) => {
                  released.push(arg ?? false)
                  return target.release(arg as boolean)
                }
              if (key === 'query')
                return (...args: unknown[]) => {
                  const text = String(args[0])
                  sent.push(text.trim().split(/\s+/).slice(0, 3).join(' '))
                  const failure = sabotage(text)
                  // The statement is never sent: as far as this side knows, it simply did not come back.
                  if (failure) return Promise.reject(failure)
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

    it('closes the connection, rather than reuse it, when a statement does not come back', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const intent = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      const before = [await permanent(), await intents()]

      // The city has been updated inside the transaction; the event insert then times out on this side.
      const pool = watched((text) => (text.includes('INSERT INTO city_events') ? new Error('Query read timeout') : null))
      await expect(w.service({ db: pool.db }).commit(me.session, { intentId: intent.intentId, signature })).rejects.toThrow('Query read timeout')
      // No ROLLBACK is queued behind a statement that may still be running: the connection is destroyed.
      expect(pool.sent.filter((q) => q.startsWith('UPDATE city'))).toHaveLength(1)
      expect(pool.sent).not.toContain('ROLLBACK')
      expect(pool.sent).not.toContain('COMMIT')
      expect(pool.released).toEqual([true])
      // Closing it abandoned the transaction: the city is as it was, and nothing holds its lock.
      expect([await permanent(), await intents()]).toEqual(before)
      expect((await w.service().commit(me.session, { intentId: intent.intentId, signature })).property.sequence).toBe(2)
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('closes the connection when the ROLLBACK itself fails, and reuses it when everything is in order', async () => {
      const w = await world()
      const a = await w.person([[812n, FAMILY]])
      const b = await w.person([[813n, FAMILY]])
      const intentA = await w.service().issueIntent(a.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const intentB = await w.service().issueIntent(b.session, { tokenId: '813', plotId: 'd4-w0-p7' })
      const [signatureA, signatureB] = [await sign(a, intentA), await sign(b, intentB)]

      // An ordinary success and an ordinary refusal both hand back a healthy connection.
      const healthy = watched()
      await w.service({ db: healthy.db }).commit(a.session, { intentId: intentA.intentId, signature: signatureA })
      expect(await refusal(w.service({ db: healthy.db }).commit(b.session, { intentId: intentB.intentId, signature: signatureB }))).toBe('plot_unavailable')
      expect(healthy.released).toEqual([false, false])
      expect(healthy.sent.filter((q) => q === 'ROLLBACK' || q === 'COMMIT')).toEqual(['COMMIT', 'ROLLBACK'])

      // The same refusal, but the ROLLBACK does not go through: that connection is not reused.
      const before = [await permanent(), await intents()]
      const failing = watched((text) => (text === 'ROLLBACK' ? new Error('Query read timeout') : null))
      expect(await refusal(w.service({ db: failing.db }).commit(b.session, { intentId: intentB.intentId, signature: signatureB }))).toBe('plot_unavailable')
      expect(failing.released).toEqual([true])
      expect([await permanent(), await intents()]).toEqual(before)
      // An error this service did not raise and the database did not report is treated the same way.
      const thrown = watched()
      await expect(w.service({ db: thrown.db, onCommitStep: () => Promise.reject(new TypeError('bug')) }).commit(b.session, { intentId: intentB.intentId, signature: signatureB })).rejects.toThrow()
      expect(await tally()).toEqual({ issued: 1, committed: 1, superseded: 0, properties: 1, eras: 1, events: 2 })
    })

    it('bounds every statement and idle time of a writing transaction in the database itself', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const pool = watched()
      const settings: Record<string, string> = {}
      const svc = w.service({
        db: pool.db,
        async onCommitStep(step, client) {
          if (step !== 'city') return
          for (const name of ['lock_timeout', 'statement_timeout', 'idle_in_transaction_session_timeout']) settings[name] = (await client.query<{ v: string }>(`SELECT current_setting('${name}') AS v`)).rows[0].v
        },
      })
      await activate(w, me, 812n, 'd4-w0-p7', svc)
      // Both below the pool's ten-second client-side limit, so the database cancels before the service gives up.
      expect(settings).toEqual({ lock_timeout: '5s', statement_timeout: '8s', idle_in_transaction_session_timeout: '15s' })
      // They are set for the transaction only: a pooled connection does not keep them.
      expect((await t.db.query<{ v: string }>(`SELECT current_setting('statement_timeout') AS v`)).rows[0].v).toBe('0')
    })

    it('answers intent_expired, not a failure, when the intent runs out between the check and the guarded write', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const svc = w.service({ intentTtlMs: 400, onCommitStep: (step) => (step === 'city' ? sleep(600) : undefined) })
      const intent = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      const before = await permanent()
      // Live when the transaction checked it; expired by the time the database's own guard looked.
      expect(await refusal(svc.commit(me.session, { intentId: intent.intentId, signature }))).toBe('intent_expired')
      expect(await permanent()).toBe(before)
      expect(await tally()).toEqual({ ...NOTHING, issued: 1 })
    })
  })

  describe('ownership and family come from the chain, fresh, both times', () => {
    it('issues nothing for a Friend the wallet does not own, or that does not exist', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const stranger = await w.person()
      expect(await refusal(w.service().issueIntent(stranger.session, { tokenId: '812', plotId: 'd4-w0-p7' }))).toBe('friend_not_owned')
      expect(await refusal(w.service().issueIntent(me.session, { tokenId: '404', plotId: 'd4-w0-p7' }))).toBe('friend_not_owned')
      expect(await tally()).toEqual(NOTHING)
    })

    it('issues nothing when the provider cannot answer, and says so without its details', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const svc = w.service()
      for (const method of ['eth_chainId', 'eth_blockNumber', 'eth_call']) {
        w.chain.fail = (m) => (m === method ? new Error('fetch failed https://rpc.example/v2/s3cr3t-key') : undefined)
        const err = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' }).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(ActivationError)
        expect([(err as ActivationError).code, (err as ActivationError).status, (err as ActivationError).message]).toEqual(['ownership_unavailable', 503, 'ownership_unavailable'])
      }
      w.chain.fail = () => undefined
      w.chain.chainId = 1
      expect(await refusal(svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' }))).toBe('ownership_unavailable')
      w.chain.chainId = 4663
      w.chain.families.set(812n, 9)
      expect(await refusal(svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' }))).toBe('ownership_inconsistent')
      expect(await tally()).toEqual(NOTHING)
      expect(w.lines.join('\n')).not.toMatch(/s3cr3t|rpc\.example/)
      expect(w.lines.filter((l) => l.includes('activation ownership read failed'))).toHaveLength(5)
    })

    it('does not commit when ownership was lost between issue and commit', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const other = await w.person()
      const intent = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      const before = [await permanent(), await intents()]
      w.chain.transfer(me.account.address, other.account.address, 812n)
      expect(await refusal(w.service().commit(me.session, { intentId: intent.intentId, signature }))).toBe('friend_not_owned')
      // The same when the Friend has been burned, or the provider cannot say.
      w.chain.ownerOverride.set(812n, null)
      expect(await refusal(w.service().commit(me.session, { intentId: intent.intentId, signature }))).toBe('friend_not_owned')
      w.chain.fail = (m) => (m === 'eth_call' ? new Error('down') : undefined)
      expect(await refusal(w.service().commit(me.session, { intentId: intent.intentId, signature }))).toBe('ownership_unavailable')
      expect([await permanent(), await intents()]).toEqual(before)
      expect(await tally()).toEqual({ ...NOTHING, issued: 1 })
    })

    it('does not commit when the family is no longer the family that was signed', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const intent = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      const before = [await permanent(), await intents()]
      w.chain.families.set(812n, 7)
      expect(await refusal(w.service().commit(me.session, { intentId: intent.intentId, signature }))).toBe('family_mismatch')
      w.chain.families.set(812n, 200)
      expect(await refusal(w.service().commit(me.session, { intentId: intent.intentId, signature }))).toBe('ownership_inconsistent')
      expect([await permanent(), await intents()]).toEqual(before)
      // Back to the signed family, the same intent commits.
      w.chain.families.set(812n, FAMILY)
      expect((await w.service().commit(me.session, { intentId: intent.intentId, signature })).property.districtId).toBe('d4')
    })
  })

  describe('the plot', () => {
    it('issues nothing for a plot the allocation rules do not offer', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY], [813n, FAMILY]])
      const svc = w.service()
      await activate(w, me, 813n, 'd4-w0-p3')
      const rpc = w.chain.requests.length
      // Past the end of the ward, the next ward while this one has room, and beyond the next ward: none is a plot to take.
      for (const plotId of [`d4-w0-p${wardCapacity(0)}`, 'd4-w1-p0', 'd4-w2-p0', 'd4-w0-p999999']) expect(await refusal(svc.issueIntent(me.session, { tokenId: '812', plotId })), plotId).toBe('plot_invalid')
      // A real plot that somebody has.
      expect(await refusal(svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p3' }))).toBe('plot_unavailable')
      // All of that is decided from the city, before the chain is asked.
      expect(w.chain.requests.length).toBe(rpc)
      // A free plot in a district that is not the Friend's family's: decided by the chain's family, not by the request.
      expect(await refusal(svc.issueIntent(me.session, { tokenId: '812', plotId: 'd5-w0-p0' }))).toBe('plot_invalid')
      expect(await tally()).toMatchObject({ issued: 0, properties: 1 })
    })

    it('refuses the commit, with no partial write, when the plot was taken after the intent was issued', async () => {
      const w = await world()
      const a = await w.person([[812n, FAMILY]])
      const b = await w.person([[813n, FAMILY]])
      const svc = w.service()
      // Both are issued an intent for the same plot: issuing reserves nothing.
      const intentA = await svc.issueIntent(a.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const intentB = await svc.issueIntent(b.session, { tokenId: '813', plotId: 'd4-w0-p7' })
      await svc.commit(a.session, { intentId: intentA.intentId, signature: await sign(a, intentA) })
      const before = await permanent()
      expect(await refusal(svc.commit(b.session, { intentId: intentB.intentId, signature: await sign(b, intentB) }))).toBe('plot_unavailable')
      expect(await permanent()).toBe(before)
      expect(await tally()).toEqual({ issued: 1, committed: 1, superseded: 0, properties: 1, eras: 1, events: 2 })
      // Unrelated city activity does not invalidate an intent whose own plot is still free.
      const c = await w.person([[814n, FAMILY]])
      const intentC = await svc.issueIntent(c.session, { tokenId: '814', plotId: 'd4-w0-p9' })
      await activate(w, b, 813n, 'd4-w0-p8')
      expect((await svc.commit(c.session, { intentId: intentC.intentId, signature: await sign(c, intentC) })).property).toMatchObject({ plotId: 'd4-w0-p9', sequence: 4 })
    })

    it('catches a plot taken during the ownership read: the locked state decides, not the earlier look', async () => {
      const w = await world()
      const a = await w.person([[812n, FAMILY]])
      const b = await w.person([[813n, FAMILY]])
      const intentA = await w.service().issueIntent(a.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signatureA = await sign(a, intentA)
      // While A's commit is waiting on the chain, B takes the plot.
      w.during.read = async () => void (await activate(w, b, 813n, 'd4-w0-p7'))
      expect(await refusal(w.service().commit(a.session, { intentId: intentA.intentId, signature: signatureA }))).toBe('plot_unavailable')
      expect(await tally()).toEqual({ issued: 1, committed: 1, superseded: 0, properties: 1, eras: 1, events: 2 })
      expect((await cityRow()).state.buildings).toHaveProperty('b-813')
      expect((await cityRow()).state.buildings).not.toHaveProperty('b-812')
    })

    it('opens exactly one ward when the exact plot chosen lies in the next ward', async () => {
      const w = await world()
      const capacity = wardCapacity(0)
      const me = await w.person(Array.from({ length: capacity + 2 }, (_, i) => [BigInt(5000 + i), FAMILY] as const))
      for (let plot = 0; plot < capacity; plot++) await activate(w, me, BigInt(5000 + plot), `d4-w0-p${plot}`)
      const full = await cityRow()
      expect(full.state.wards.d4).toBe(1)
      expect(availablePlots(full.state, 'd4').every((c) => c.newWard && c.ward === 1)).toBe(true)
      // The founding ward is full, so its plots are gone and the next ward's are offered.
      expect(await refusal(w.service().issueIntent(me.session, { tokenId: String(5000 + capacity), plotId: 'd4-w0-p0' }))).toBe('plot_unavailable')
      expect(await refusal(w.service().issueIntent(me.session, { tokenId: String(5000 + capacity), plotId: 'd4-w2-p0' }))).toBe('plot_invalid')

      const { result } = await activate(w, me, BigInt(5000 + capacity), 'd4-w1-p3')
      expect(result.property).toMatchObject({ ward: 1, plot: 3, plotId: 'd4-w1-p3', sequence: capacity + 2 })
      const opened = await cityRow()
      expect(opened.state.wards).toEqual({ ...full.state.wards, d4: 2 })
      // The ward is open now: its next plot opens nothing further.
      await activate(w, me, BigInt(5000 + capacity + 1), 'd4-w1-p0')
      expect((await cityRow()).state.wards).toEqual({ ...full.state.wards, d4: 2 })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, counts: { buildings: capacity + 2, properties: capacity + 2, eras: capacity + 2, events: capacity + 3, users: 1 } })
      // One user owns them all, and their avatar is still the first Friend they activated.
      expect((await cityRow()).state.users[me.userId].friendId).toBe(5000)
    })
  })

  describe('the signature', () => {
    it('refuses a signature by any other key, and one that is not a signature', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const stranger = await w.person()
      const intent = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const before = [await permanent(), await intents()]
      const rpc = w.chain.requests.length
      const good = await sign(me, intent)
      const bad = [
        await sign(stranger, intent),
        // The right key over the wrong thing: a plain message, and the same fields with one changed.
        await me.account.signMessage({ message: intent.digest }),
        await me.account.signMessage({ message: { raw: intent.digest as `0x${string}` } }),
        await me.account.signTypedData(JSON.parse(JSON.stringify({ ...intent.typedData, message: { ...intent.typedData.message, plotId: 'd4-w0-p8', plot: 8 } }))),
        await me.account.signTypedData(JSON.parse(JSON.stringify({ ...intent.typedData, domain: { ...intent.typedData.domain, chainId: 1 } }))),
        await me.account.signTypedData(JSON.parse(JSON.stringify({ ...intent.typedData, domain: { ...intent.typedData.domain, name: 'Rare Town' } }))),
        // Not a recoverable signature at all.
        `0x${'00'.repeat(65)}`,
        `0x${'ff'.repeat(65)}`,
        `${good.slice(0, -2)}05`,
        // A flipped bit.
        `${good.slice(0, 10)}${good[10] === '0' ? '1' : '0'}${good.slice(11)}`,
      ]
      for (const signature of bad) expect(await refusal(w.service().commit(me.session, { intentId: intent.intentId, signature })), signature.slice(0, 12)).toBe('signature_invalid')
      // A wrong signature never reaches the chain or the transaction.
      expect(w.chain.requests.length).toBe(rpc)
      expect([await permanent(), await intents()]).toEqual(before)
      expect((await w.service().commit(me.session, { intentId: intent.intentId, signature: good })).status).toBe('committed')
    })

    it('never accepts the signature of one intent for another', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY], [813n, FAMILY]])
      const svc = w.service()
      const a = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const b = await svc.issueIntent(me.session, { tokenId: '813', plotId: 'd4-w0-p8' })
      const signatureA = await sign(me, a)
      const before = [await permanent(), await intents()]
      expect(await refusal(svc.commit(me.session, { intentId: b.intentId, signature: signatureA }))).toBe('signature_invalid')
      expect([await permanent(), await intents()]).toEqual(before)
      // Nor for a second intent of the same Friend: the earlier one is superseded, and its signature fits neither.
      const c = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p9' })
      expect(await refusal(svc.commit(me.session, { intentId: c.intentId, signature: signatureA }))).toBe('signature_invalid')
      expect(await refusal(svc.commit(me.session, { intentId: a.intentId, signature: signatureA }))).toBe('intent_superseded')
      expect(await tally()).toEqual({ ...NOTHING, issued: 2, superseded: 1 })
    })
  })

  describe('the session', () => {
    it('lets only the exact session an intent was issued in commit it', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const svc = w.service()
      const intent = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      const before = [await permanent(), await intents()]
      const rpc = w.chain.requests.length

      // The same wallet signed in again: a perfectly good session, and not the one.
      const again = await w.person([], me.account)
      expect(again.userId).toBe(me.userId)
      expect(again.session.sessionId).not.toBe(me.session.sessionId)
      expect(await refusal(svc.commit(again.session, { intentId: intent.intentId, signature }))).toBe('intent_session_mismatch')
      // Another user is not even told the intent exists, whatever they send.
      const stranger = await w.person()
      expect(await refusal(svc.commit(stranger.session, { intentId: intent.intentId, signature }))).toBe('intent_not_found')
      expect(await refusal(svc.commit(stranger.session, { intentId: 'f'.repeat(64), signature }))).toBe('intent_not_found')
      // A session object that claims to be the right one but names another wallet.
      expect(await refusal(svc.commit({ ...me.session, walletId: stranger.session.walletId, address: stranger.session.address }, { intentId: intent.intentId, signature }))).toBe('intent_session_mismatch')
      expect(w.chain.requests.length).toBe(rpc)
      expect([await permanent(), await intents()]).toEqual(before)
      expect((await svc.commit(me.session, { intentId: intent.intentId, signature })).status).toBe('committed')
    })

    it('does not commit for a revoked session', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const intent = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      const before = await permanent()
      await w.auth.logout(me.cookie)
      // The cookie no longer resolves to a session at all, so the HTTP layer answers 401 before the service is reached...
      expect(await w.auth.session(me.cookie)).toBeNull()
      // ...and the service refuses a session object resolved a moment before the revocation.
      expect(await refusal(w.service().commit(me.session, { intentId: intent.intentId, signature }))).toBe('not_authenticated')
      expect(await refusal(w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p8' }))).toBe('not_authenticated')
      expect(await permanent()).toBe(before)
      expect(await tally()).toEqual({ ...NOTHING, issued: 1 })
    })

    it('does not commit when the session is revoked during the ownership read', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const intent = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      const before = await permanent()
      w.during.read = () => w.auth.logout(me.cookie)
      expect(await refusal(w.service().commit(me.session, { intentId: intent.intentId, signature }))).toBe('not_authenticated')
      expect(await permanent()).toBe(before)
    })

    it('never issues an intent that outlives its session, and does not commit once the session has expired', async () => {
      const w = await world()
      // A session opened almost seven days ago: it has about 1.5 seconds left.
      const opening = createAuthService({ db: t.db, publicOrigin: TEST_ORIGIN, now: () => new Date(Date.now() - 7 * 86_400_000 + 1_500) })
      const me = await w.person([[812n, FAMILY]], undefined, opening)
      const intent = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      // Clamped to the session's own end, not ten minutes on.
      expect(intent.expiresAt).toBe(me.session.expiresAt.toISOString())
      expect(Number(intent.typedData.message.expiresAt) - Number(intent.typedData.message.issuedAt)).toBeLessThan(1_500)
      const before = await permanent()

      await sleep(1_700)
      // By the database clock the session is over, whatever the service's own clock says.
      expect(await opening.session(me.cookie)).toBeNull()
      expect(['intent_expired', 'not_authenticated']).toContain(await refusal(w.service().commit(me.session, { intentId: intent.intentId, signature })))
      expect(await refusal(w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p8' }))).toBe('not_authenticated')
      expect(await permanent()).toBe(before)
      expect(await tally()).toEqual({ ...NOTHING, issued: 1 })
    })
  })

  describe('an intent is short-lived and single', () => {
    it('does not commit an expired intent', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const svc = w.service({ intentTtlMs: 250 })
      const intent = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      const before = await permanent()
      await sleep(350)
      const rpc = w.chain.requests.length
      expect(await refusal(svc.commit(me.session, { intentId: intent.intentId, signature }))).toBe('intent_expired')
      expect(w.chain.requests.length).toBe(rpc)
      expect(await permanent()).toBe(before)
      // The session is still perfectly good: a new intent is issued (the dead one superseded) and commits.
      const fresh = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      expect(fresh.intentId).not.toBe(intent.intentId)
      expect((await w.service().commit(me.session, { intentId: fresh.intentId, signature: await sign(me, fresh) })).status).toBe('committed')
      expect(await tally()).toMatchObject({ issued: 0, superseded: 1, committed: 1, properties: 1 })
    })

    it('does not commit an intent that expires during the ownership read', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const svc = w.service({ intentTtlMs: 400 })
      const intent = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      const before = await permanent()
      // Live when the request arrives; dead by the time the chain has answered.
      w.during.read = () => sleep(600)
      expect(await refusal(svc.commit(me.session, { intentId: intent.intentId, signature }))).toBe('intent_expired')
      expect(await permanent()).toBe(before)
    })

    it('never lets a service configuration lengthen an intent beyond ten minutes', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const intent = await w.service({ intentTtlMs: 60 * 60_000 }).issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      expect(Number(intent.typedData.message.expiresAt) - Number(intent.typedData.message.issuedAt)).toBe(600_000)
    })

    it('does not commit a superseded intent', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const svc = w.service()
      const first = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, first)
      const second = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p8' })
      expect(second.intentId).not.toBe(first.intentId)
      const before = await permanent()
      const rpc = w.chain.requests.length
      expect(await refusal(svc.commit(me.session, { intentId: first.intentId, signature }))).toBe('intent_superseded')
      expect(w.chain.requests.length).toBe(rpc)
      expect(await permanent()).toBe(before)
      expect(await tally()).toEqual({ ...NOTHING, issued: 1, superseded: 1 })
      expect((await svc.commit(me.session, { intentId: second.intentId, signature: await sign(me, second) })).property.plotId).toBe('d4-w0-p8')
    })

    it('returns the same intent for the same request, and replaces it for any other', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY], [813n, FAMILY]])
      const svc = w.service()
      const first = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      // The same session asking for the same Friend on the same plot gets the same intent, byte for byte.
      expect(await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })).toEqual(first)
      expect(await tally()).toEqual({ ...NOTHING, issued: 1 })
      // Another Friend of the same wallet is another intent, and both are live.
      const other = await svc.issueIntent(me.session, { tokenId: '813', plotId: 'd4-w0-p8' })
      expect(await tally()).toEqual({ ...NOTHING, issued: 2 })
      // Another plot for the same Friend replaces its intent.
      const moved = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p9' })
      expect(moved.intentId).not.toBe(first.intentId)
      expect(await tally()).toEqual({ ...NOTHING, issued: 2, superseded: 1 })
      // Another session of the same wallet replaces it too: the old session's intent is not handed to the new one.
      const again = await w.person([], me.account)
      const rebound = await svc.issueIntent(again.session, { tokenId: '812', plotId: 'd4-w0-p9' })
      expect(rebound.intentId).not.toBe(moved.intentId)
      expect(await tally()).toEqual({ ...NOTHING, issued: 2, superseded: 2 })
      expect((await t.db.query(`SELECT id, session_id FROM activation_intents WHERE status = 'issued' ORDER BY token_id`)).rows).toEqual([{ id: rebound.intentId, session_id: again.session.sessionId }, { id: other.intentId, session_id: me.session.sessionId }])
      expect(await refusal(svc.commit(me.session, { intentId: moved.intentId, signature: await sign(me, moved) }))).toBe('intent_superseded')
    })

    it('replaces an intent that is close to its end rather than hand it out again', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      // Thirty seconds of life is less than the minute an intent must have left to be reused.
      const svc = w.service({ intentTtlMs: 30_000 })
      const first = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const second = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      expect(second.intentId).not.toBe(first.intentId)
      expect(await tally()).toEqual({ ...NOTHING, issued: 1, superseded: 1 })
    })

    it('replaces an intent when the registry family has changed since it was issued', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const first = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      w.chain.families.set(812n, 7)
      expect(await refusal(w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' }))).toBe('plot_invalid')
      const moved = await w.service().issueIntent(me.session, { tokenId: '812', plotId: 'd2-w0-p0' })
      expect(moved.typedData.message).toMatchObject({ familyId: 7, familyName: 'Sparkling', districtId: 'd2' })
      expect((await t.db.query('SELECT status FROM activation_intents WHERE id = $1', [first.intentId])).rows).toEqual([{ status: 'superseded' }])
    })
  })

  describe('concurrency', () => {
    it('issues one intent to any number of simultaneous identical requests', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const svc = w.service()
      const issued = await Promise.all(Array.from({ length: 8 }, () => svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })))
      expect(new Set(issued.map((i) => i.intentId)).size).toBe(1)
      expect(new Set(issued.map((i) => JSON.stringify(i))).size).toBe(1)
      expect(await tally()).toEqual({ ...NOTHING, issued: 1 })
    })

    it('never leaves two live intents for one wallet and Friend, however the requests race', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const svc = w.service()
      const plots = Array.from({ length: 8 }, (_, i) => `d4-w0-p${i}`)
      const issued = await Promise.all(plots.map((plotId) => svc.issueIntent(me.session, { tokenId: '812', plotId })))
      expect(new Set(issued.map((i) => i.intentId)).size).toBe(8)
      // Each request superseded whatever was live before it: exactly one survives, and none failed.
      expect(await tally()).toEqual({ ...NOTHING, issued: 1, superseded: 7 })
      const live = (await t.db.query<{ id: string; plot_id: string }>(`SELECT id, plot_id FROM activation_intents WHERE status = 'issued'`)).rows[0]
      const winner = issued.find((i) => i.intentId === live.id)!
      expect(winner.typedData.message.plotId).toBe(live.plot_id)
      // Only the survivor commits.
      const results = await Promise.allSettled(issued.map(async (intent) => svc.commit(me.session, { intentId: intent.intentId, signature: await sign(me, intent) })))
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      for (const r of results) if (r.status === 'rejected') expect((r.reason as ActivationError).code).toBe('intent_superseded')
      expect(await tally()).toEqual({ issued: 0, committed: 1, superseded: 7, properties: 1, eras: 1, events: 2 })
    })

    it('makes exactly one permanent mutation for simultaneous commits of the same intent, and gives every caller the same result', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const svc = w.service()
      const intent = await svc.issueIntent(me.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signature = await sign(me, intent)
      const results = await Promise.all(Array.from({ length: 6 }, () => svc.commit(me.session, { intentId: intent.intentId, signature })))
      expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1)
      expect(results[0].property).toMatchObject({ id: propertyId('812'), sequence: 2 })
      expect(await tally()).toEqual({ issued: 0, committed: 1, superseded: 0, properties: 1, eras: 1, events: 2 })
      expect((await cityRow()).sequence).toBe('2')
      expect(w.lines.filter((l) => l.includes('"message":"property activated"'))).toHaveLength(1)
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('gives a contested plot to at most one of the intents racing for it', async () => {
      const w = await world()
      const people = await Promise.all(Array.from({ length: 5 }, (_, i) => w.person([[BigInt(900 + i), FAMILY]])))
      const svc = w.service()
      const racers = await Promise.all(
        people.map(async (who, i) => {
          const intent = await svc.issueIntent(who.session, { tokenId: String(900 + i), plotId: 'd4-w0-p7' })
          return { who, intent, signature: await sign(who, intent) }
        }),
      )
      const results = await Promise.allSettled(racers.map((r) => svc.commit(r.who.session, { intentId: r.intent.intentId, signature: r.signature })))
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      for (const r of results) if (r.status === 'rejected') expect((r.reason as ActivationError).code).toBe('plot_unavailable')
      expect(await tally()).toEqual({ issued: 4, committed: 1, superseded: 0, properties: 1, eras: 1, events: 2 })
      expect(Object.keys((await cityRow()).state.buildings)).toHaveLength(1)
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('serialises unrelated simultaneous activations: every one lands, each on its own sequence', async () => {
      const w = await world()
      const people = await Promise.all(Array.from({ length: 6 }, (_, i) => w.person([[BigInt(700 + i), FAMILY]])))
      const results = await Promise.all(people.map((who, i) => activate(w, who, BigInt(700 + i), `d4-w0-p${i}`)))
      expect(results.map((r) => r.result.property.sequence).sort()).toEqual([2, 3, 4, 5, 6, 7])
      expect(await tally()).toEqual({ issued: 0, committed: 6, superseded: 0, properties: 6, eras: 6, events: 7 })
      expect((await cityRow()).sequence).toBe('7')
      expect((await cityRow()).state.clock).toBe(6)
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('gives one Friend at most one property when two activations of it race', async () => {
      const w = await world()
      // The accepted residual race: the Friend changes hands between a pinned read and the write, so the chain told
      // each of two wallets, at its own moment, that it owned the Friend. The database still allows one property.
      const everyone: OwnershipProvider = { ...w.ownership, verifyActivation: async () => ({ owned: true, family: { id: FAMILY, name: 'Family' }, blockNumber: w.chain.head }) }
      const svc = w.service({ ownership: everyone })
      const a = await w.person()
      const b = await w.person()
      const intentA = await svc.issueIntent(a.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const intentB = await svc.issueIntent(b.session, { tokenId: '812', plotId: 'd4-w0-p8' })
      const [signatureA, signatureB] = [await sign(a, intentA), await sign(b, intentB)]
      const results = await Promise.allSettled([svc.commit(a.session, { intentId: intentA.intentId, signature: signatureA }), svc.commit(b.session, { intentId: intentB.intentId, signature: signatureB })])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected').map((r) => ((r as PromiseRejectedResult).reason as ActivationError).code)).toEqual(['friend_already_activated'])
      expect(await tally()).toEqual({ issued: 1, committed: 1, superseded: 0, properties: 1, eras: 1, events: 2 })
      expect(Object.keys((await cityRow()).state.buildings)).toEqual(['b-812'])
      expect((await verifyCity(t.db)).ok).toBe(true)
    })

    it('refuses to activate a Friend that was activated before the commit, and issues nothing for it afterwards', async () => {
      const w = await world()
      const a = await w.person([[812n, FAMILY]])
      const b = await w.person()
      const svc = w.service()
      const intentA = await svc.issueIntent(a.session, { tokenId: '812', plotId: 'd4-w0-p7' })
      const signatureA = await sign(a, intentA)
      // The Friend moves to B, who activates it, and then moves back to A.
      w.chain.transfer(a.account.address, b.account.address, 812n)
      await activate(w, b, 812n, 'd4-w0-p8')
      w.chain.transfer(b.account.address, a.account.address, 812n)
      const before = await permanent()
      // A owns it again and holds a live, correctly signed intent. The Friend already has its property.
      expect(await refusal(svc.commit(a.session, { intentId: intentA.intentId, signature: signatureA }))).toBe('friend_already_activated')
      expect(await refusal(svc.issueIntent(a.session, { tokenId: '812', plotId: 'd4-w0-p9' }))).toBe('friend_already_activated')
      expect(await permanent()).toBe(before)
      expect(await tally()).toMatchObject({ properties: 1, eras: 1, events: 2, committed: 1 })
    })
  })

  describe('a retry after an answer was lost', () => {
    it('returns the committed property again without activating again', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const svc = w.service()
      const { intent, signature, result } = await activate(w, me, 812n, 'd4-w0-p7')
      const before = [await permanent(), await intents()]
      const rpc = w.chain.requests.length

      // The same request again: the same answer, and nothing new anywhere. Not even a chain read.
      for (let i = 0; i < 3; i++) expect(await svc.commit(me.session, { intentId: intent.intentId, signature })).toEqual(result)
      expect(w.chain.requests.length).toBe(rpc)
      expect([await permanent(), await intents()]).toEqual(before)
      expect(await tally()).toEqual({ issued: 0, committed: 1, superseded: 0, properties: 1, eras: 1, events: 2 })
      expect(w.lines.filter((l) => l.includes('"message":"property activated"'))).toHaveLength(1)

      // It is an answer about what happened, so it does not depend on what is true now: the chain is down, the
      // Friend has been sold, the city has moved on, and the user has signed in again.
      w.chain.fail = () => new Error('down')
      w.chain.ownerOverride.set(812n, null)
      const again = await w.person([], me.account)
      expect(await svc.commit(again.session, { intentId: intent.intentId, signature })).toEqual(result)
      w.chain.fail = () => undefined
      const other = await w.person([[813n, FAMILY]])
      await activate(w, other, 813n, 'd4-w0-p8')
      expect(await svc.commit(me.session, { intentId: intent.intentId, signature })).toEqual(result)
      expect(result.property.sequence).toBe(2)
      expect((await cityRow()).sequence).toBe('3')

      // It is not a property lookup for anyone else.
      expect(await refusal(svc.commit(other.session, { intentId: intent.intentId, signature }))).toBe('intent_not_found')
      // And the stored signature is the one that authorised it, whatever a retry sends.
      await svc.commit(me.session, { intentId: intent.intentId, signature: `0x${'ab'.repeat(65)}` })
      expect(`0x${(await t.db.query('SELECT signature FROM activation_intents WHERE id = $1', [intent.intentId])).rows[0].signature.toString('hex')}`).toBe(signature)
    })
  })

  describe('users in the city state are presentation', () => {
    it('leaves a user avatar unchanged when they activate a second Friend, and never selects a Representative', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY], [4471n, 7], [1204n, 0]])
      await activate(w, me, 812n, 'd4-w0-p7')
      const first = (await cityRow()).state.users[me.userId]
      await activate(w, me, 4471n, 'd2-w0-p0')
      await activate(w, me, 1204n, 'd8-w0-p0')
      const { state } = await cityRow()
      expect(state.users).toEqual({ [me.userId]: first })
      expect(first.friendId).toBe(812)
      expect(Object.values(state.buildings).map((b) => [b.id, b.ownerId]).sort()).toEqual([['b-1204', me.userId], ['b-4471', me.userId], ['b-812', me.userId]])
      expect(state.season.representatives).toEqual({})
      expect(state.season.joinedClock).toEqual({})
      expect(state.wallets).toEqual({})
      expect(state.residentSeq).toBe(0)
      expect(state.clock).toBe(3)
    })

    it('gives a user whose avatar is somebody else\'s Friend no claim to it', async () => {
      const w = await world()
      const owner = await w.person([[812n, FAMILY]])
      const pretender = await w.person([[813n, FAMILY]])
      await activate(w, pretender, 813n, 'd4-w0-p0')
      // The pretender's display record is edited to show Friend 812 as its avatar.
      const { state } = await cityRow()
      state.users[pretender.userId].friendId = 812
      await unguarded(t.db, () => t.db.query('UPDATE city SET state = $1::json', [JSON.stringify(state)]))
      // It changes nothing: the pretender cannot activate 812, and the owner can.
      expect(await refusal(w.service().issueIntent(pretender.session, { tokenId: '812', plotId: 'd4-w0-p7' }))).toBe('friend_not_owned')
      const { result } = await activate(w, owner, 812n, 'd4-w0-p7')
      expect((await cityRow()).state.buildings[result.property.buildingId].ownerId).toBe(owner.userId)
      // And the annotation of who has a property reads the property rows, not avatars.
      const annotated = await createPropertyReader(t.db).forFriends([812n, 813n, 999n])
      expect([...annotated.keys()].sort()).toEqual(['812', '813'])
    })
  })

  describe('what is written down', () => {
    it('keeps every secret out of the event, the response and the log', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY]])
      const { intent, signature, result } = await activate(w, me, 812n, 'd4-w0-p7')
      const event = (await t.db.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM city_events WHERE type = 'property.activated'`)).rows[0]
      expect(Object.keys(event.payload).sort()).toEqual(['districtId', 'familyId', 'ownerAddress', 'plot', 'plotId', 'propertyId', 'tokenId', 'userId', 'verifiedBlock', 'ward'])
      const secrets = [me.cookie, hashSessionToken(me.cookie).toString('hex'), me.session.sessionId, signature, signature.slice(2), intent.digest, intent.digest.slice(2), intent.intentId, 'rpc-not-used']
      const written = [JSON.stringify(event.payload), JSON.stringify((await cityRow()).state), JSON.stringify(result), w.lines.join('\n')]
      for (const text of written) for (const secret of secrets) expect(text).not.toContain(secret)
      // The response names no session, wallet row or signature either.
      expect(JSON.stringify([intent, result])).not.toContain(me.session.walletId)
      expect(JSON.stringify([intent, result])).not.toContain(me.session.sessionId)
    })

    it('annotates Friends with their property from the normalized rows', async () => {
      const w = await world()
      const me = await w.person([[812n, FAMILY], [813n, FAMILY]])
      const reader = createPropertyReader(t.db)
      expect(await reader.forFriends([])).toEqual(new Map())
      expect(await reader.forFriends([812n, 813n])).toEqual(new Map())
      const { result } = await activate(w, me, 812n, 'd4-w0-p7')
      const found = await reader.forFriends([813n, 812n, 2n ** 70n])
      expect([...found.entries()]).toEqual([['812', { id: propertyId('812'), buildingId: 'b-812', districtId: 'd4', ward: 0, plot: 7, plotId: 'd4-w0-p7', activatedAt: result.property.activatedAt }]])
    })
  })

  describe('session clean-up', () => {
    it('still deletes ended sessions, leaving every intent and property intact', async () => {
      const w = await world()
      const a = await w.person([[812n, FAMILY]])
      const b = await w.person([[813n, FAMILY]])
      const svc = w.service()
      const committed = await activate(w, a, 812n, 'd4-w0-p7')
      const superseded = await svc.issueIntent(b.session, { tokenId: '813', plotId: 'd4-w0-p8' })
      const issued = await svc.issueIntent(b.session, { tokenId: '813', plotId: 'd4-w0-p9' })
      const before = await permanent()
      expect(await tally()).toMatchObject({ issued: 1, committed: 1, superseded: 1 })

      // The sign-in service tidies as it always has, forty days from now: every session here ended long ago.
      const later = createAuthService({ db: t.db, publicOrigin: TEST_ORIGIN, now: () => new Date(Date.now() + 40 * 86_400_000) })
      await later.issueChallenge({ address: a.account.address, chainId: 4663 })
      expect((await t.db.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n).toBe(0)

      // The intents outlive their sessions: detached, otherwise untouched.
      expect((await t.db.query('SELECT id, status, session_id FROM activation_intents ORDER BY issued_at, id')).rows).toEqual([
        { id: committed.intent.intentId, status: 'committed', session_id: null },
        { id: superseded.intentId, status: 'superseded', session_id: null },
        { id: issued.intentId, status: 'issued', session_id: null },
      ])
      expect(await permanent()).toBe(before)
      expect((await verifyCity(t.db)).ok).toBe(true)

      // Signed in again: the committed activation is still reported, and the orphaned intent can never be committed.
      const backA = await w.person([], a.account)
      expect(await svc.commit(backA.session, { intentId: committed.intent.intentId, signature: committed.signature })).toEqual(committed.result)
      const backB = await w.person([], b.account)
      expect(await refusal(svc.commit(backB.session, { intentId: issued.intentId, signature: await sign(b, issued) }))).toBe('intent_session_mismatch')
      // A new intent replaces it and works.
      const fresh = await svc.issueIntent(backB.session, { tokenId: '813', plotId: 'd4-w0-p9' })
      expect((await svc.commit(backB.session, { intentId: fresh.intentId, signature: await sign(b, fresh) })).property.plotId).toBe('d4-w0-p9')
    })
  })

  describe('identity resolved for activation', () => {
    it('resolves the exact live session behind a cookie, and nothing for anything else', async () => {
      const w = await world()
      const me = await w.person()
      const row = (await t.db.query('SELECT s.id, s.user_id, s.wallet_id, s.expires_at, w.address FROM sessions s JOIN wallets w ON w.id = s.wallet_id')).rows[0]
      expect(me.session).toEqual({ sessionId: row.id, userId: row.user_id, walletId: row.wallet_id, address: me.account.address.toLowerCase(), chainId: 4663, expiresAt: row.expires_at })
      for (const presented of [null, '', 'nope', 'T'.repeat(43), `${me.cookie}x`, me.cookie.slice(1)]) expect(await w.auth.session(presented), String(presented)).toBeNull()
      // The public viewer still says nothing about session or wallet rows.
      const viewer = await w.auth.viewer(me.cookie)
      expect(Object.keys(viewer)).toEqual(['authenticated', 'userId', 'wallet', 'session'])
      expect(JSON.stringify(viewer)).not.toContain(row.id)
      expect(JSON.stringify(viewer)).not.toContain(row.wallet_id)
      await w.auth.logout(me.cookie)
      expect(await w.auth.session(me.cookie)).toBeNull()
    })

    it('is over when either clock says it is over', async () => {
      const w = await world()
      // The service clock runs eight days ahead of the database: by the service's own clock the session has ended.
      const clock = { now: new Date() }
      const auth = createAuthService({ db: t.db, publicOrigin: TEST_ORIGIN, now: () => new Date(clock.now) })
      const me = await w.person([], undefined, auth)
      expect(await auth.session(me.cookie)).not.toBeNull()
      clock.now = new Date(Date.now() + 8 * 86_400_000)
      expect(await auth.session(me.cookie)).toBeNull()
    })
  })
})
