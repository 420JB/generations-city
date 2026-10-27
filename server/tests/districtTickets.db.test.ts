import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { verifyCity } from '../src/city/verify'
import { migrate } from '../src/db/migrations'
import { createPool } from '../src/db/pool'
import { MAX_RULE_REF_LENGTH, nftAsset, type DistrictRuleMatch } from '../src/engine'
import { silentLogger } from '../src/log'
import { worldTicketsOf } from '../src/world/rotation'
import type { ActivationStep } from '../src/world/properties'
import { createDistrictTicketStore, DistrictTicketRefusal } from '../src/world/tickets'
import { snapshot } from './activationFixtures'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { ADA, BEA, GUILD_A, INSTALLATION_A, INSTALLATION_B } from './fakePlay'
import { contract, DOC, keeper, player, refusalOf, ROTATION, sleep, testSource, ticketWorld, tide } from './ticketHarness'

/**
 * DISTRICT TICKETS (P1-C2-D1, migration 0010) against a disposable Postgres: the owner-locked citywide
 * round-robin default assignment of MCD 46B, through the real launch path, world store, session
 * service, ticket store and property store. The numbered proofs are the milestone's.
 */
/** The same collections on other ground: the districts reversed (a geometry change allowed before the first property). */
const DOC_REVERSED = { ...DOC, districts: [...DOC.districts].reverse() }
/** Presentation only: the same districts and geometry. */
const DOC_RENAMED = { ...DOC, cityName: 'Harborlight Renamed' }
const CY = player(3, 'Cy')
const DEE = player(4, 'Dee')

describe.skipIf(NO_TEST_DATABASE)('district tickets (migration 0010) against a disposable Postgres', () => {
  const t = useTestSchema()
  const { setup, one, rotation, slotsOf, sequenceOf, frozen, statusOf, leaveOnly } = ticketWorld(t)

  describe('entry and the round robin', () => {
    it('1. A, B and C entering in order hold districts 1, 2 and 3 at once, without waiting for each other', async () => {
      const env = await setup()
      const [a, b, c] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY)]
      const ta = await env.enter(a)
      const tb = await env.enter(b)
      const tc = await env.enter(c)
      expect([ta, tb, tc].map((e) => [e.fresh, e.awaiting, e.ticket!.districtKey, e.ticket!.ordinal, e.ticket!.generation, e.ticket!.kind, e.ticket!.status])).toEqual([
        [true, null, 'lantern-quay', 0, 1, 'fallback', 'active'],
        [true, null, 'tidewater', 1, 1, 'fallback', 'active'],
        [true, null, 'saltmarsh', 2, 1, 'fallback', 'active'],
      ])
      // Each is bound to the governing configuration and geometry, and to its holder.
      const worldId = a.response.world.id
      expect(ta.ticket).toMatchObject({ worldId, installationId: INSTALLATION_A, actor: { discordUserId: ADA.discordUserId, coreUserId: ADA.coreUserId }, configVersion: 1, epoch: 1, layoutGeometryFingerprint: a.response.world.definition.geometryFingerprint })
      // Exactly the locked lease (D2), from the instant of issuance.
      expect(Date.parse(ta.ticket!.expiresAt) - Date.parse(ta.ticket!.issuedAt)).toBe(900_000)
      // Provisional: no property, no event, no sequence, no freeze. The rotation skips the rule-gated district.
      expect(await sequenceOf(worldId)).toBe(1)
      expect(await frozen(worldId)).toBe(false)
      expect(await rotation(worldId)).toMatchObject({ epoch: 1, high_water: '3', committed_count: '0', districts: ROTATION })
      // The fourth and fifth go on round the rotation; the gated district is nobody's default.
      expect((await env.ticketOf(await env.open(INSTALLATION_A, DEE))).districtKey).toBe('dune')
      expect((await env.ticketOf(await env.open(INSTALLATION_A, player(5))))).toMatchObject({ districtKey: 'lantern-quay', ordinal: 4 })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ districtTickets: { epoch: 1, highWater: 5, committed: 0, active: 5, free: 0 } }] })
    })

    it('2. B and C activate in their districts while A stays idle; A keeps District 1', async () => {
      const env = await setup()
      const [a, b, c] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY)]
      const ta = (await env.ticketOf(a))
      const tb = (await env.ticketOf(b, [keeper(2)]))
      const tc = (await env.ticketOf(c, [keeper(3)]))
      // C first, then B: order of activation is the players', not the rotation's.
      const placedC = await env.activate(c, tc, keeper(3), 'saltmarsh-w0-p0')
      const placedB = await env.activate(b, tb, keeper(2), 'tidewater-w0-p1')
      expect([placedC.fresh, placedC.sequence, placedC.ticketId, placedB.sequence, placedB.ticketId]).toEqual([true, 2, tc.id, 3, tb.id])
      const worldId = a.response.world.id
      expect(await statusOf(ta.id)).toBe('active')
      expect(await env.tickets.current(await env.live(a))).toMatchObject({ id: ta.id, districtKey: 'lantern-quay', ordinal: 0 })
      expect(await rotation(worldId)).toMatchObject({ high_water: '3', committed_count: '2' })
      expect((await slotsOf(worldId)).map((s) => s.state)).toEqual(['held', 'consumed', 'consumed'])
      // Then A, in District 1.
      expect((await env.activate(a, ta, keeper(1), 'lantern-quay-w0-p0')).sequence).toBe(4)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ properties: 3, districtTickets: { committed: 3, active: 0 } }] })
    })

    it('3. A cancels: the next eligible entrant receives A\'s released slot (oldest gap first); placed properties do not move', async () => {
      const env = await setup()
      const [a, b, c, d] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY), await env.open(INSTALLATION_A, DEE)]
      const ta = (await env.ticketOf(a))
      const tb = (await env.ticketOf(b, [keeper(2)]))
      await env.enter(c, [keeper(3)])
      await env.activate(b, tb, keeper(2), 'tidewater-w0-p0')
      const released = await env.release(a, ta)
      expect(released).toMatchObject({ id: ta.id, status: 'released', endReason: 'cancel' })
      const worldId = a.response.world.id
      expect((await slotsOf(worldId))[0]).toMatchObject({ ordinal: 0, state: 'free', generation: 1 })
      // D gets District 1 from the gap pool, at the slot's next generation, with a new ticket id.
      const td = (await env.ticketOf(d, [keeper(4)]))
      expect([td.ordinal, td.generation, td.districtKey, td.id === ta.id]).toEqual([0, 2, 'lantern-quay', false])
      // A, entering again, takes the next new slot: no gaps left.
      expect((await env.ticketOf(a))).toMatchObject({ ordinal: 3, generation: 1, districtKey: 'dune' })
      // B's property is where B put it.
      expect((await one<{ plot_id: string }>('SELECT plot_id FROM world_properties WHERE world_id = $1', [worldId])).plot_id).toBe('tidewater-w0-p0')
      // Two gaps: the lower ordinal is reused first, whatever order they were released in.
      const e = await env.open(INSTALLATION_A, player(5))
      const f = await env.open(INSTALLATION_A, player(6))
      const te = (await env.ticketOf(e, [keeper(5)]))
      const tf = (await env.ticketOf(f, [keeper(6)]))
      await env.release(f, tf)
      await env.release(e, te)
      expect([te.ordinal, tf.ordinal]).toEqual([4, 5])
      const g = (await env.ticketOf(await env.open(INSTALLATION_A, player(7)), [keeper(7)]))
      expect([g.ordinal, g.generation]).toEqual([4, 2])
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('4. concurrent entrants each receive a distinct ordinal and generation; gaps are refilled exactly once', async () => {
      const env = await setup()
      const players = Array.from({ length: 16 }, (_, i) => player(100 + i))
      const opened = await Promise.all(players.map((who) => env.open(INSTALLATION_A, who)))
      const entered = (await Promise.all(opened.map((o, i) => env.ticketOf(o, [keeper(100 + i)])))).map((ticket) => ({ ticket }))
      const pairs = entered.map((e) => `${e.ticket.ordinal}/${e.ticket.generation}`)
      expect(new Set(pairs).size).toBe(16)
      expect(entered.map((e) => e.ticket.ordinal).sort((x, y) => x! - y!)).toEqual(Array.from({ length: 16 }, (_, i) => i))
      // Every district gets exactly its share of the rotation.
      for (const d of ROTATION) expect(entered.filter((e) => e.ticket.districtKey === d)).toHaveLength(4)
      for (const e of entered) expect(e.ticket.districtKey).toBe(ROTATION[e.ticket.ordinal! % ROTATION.length])
      const worldId = opened[0].response.world.id
      // Five leave at once; eight more arrive at once: the five gaps are reused (generation 2), then three new slots.
      const leaving = [3, 7, 8, 11, 14]
      await Promise.all(leaving.map((i) => env.release(opened[i], entered[i].ticket)))
      const gaps = leaving.map((i) => entered[i].ticket.ordinal!).sort((x, y) => x - y)
      const more = Array.from({ length: 8 }, (_, i) => player(200 + i))
      const again = (await Promise.all((await Promise.all(more.map((who) => env.open(INSTALLATION_A, who)))).map((o, i) => env.ticketOf(o, [keeper(200 + i)])))).map((ticket) => ({ ticket }))
      const got = again.map((e) => [e.ticket.ordinal!, e.ticket.generation!] as const).sort((x, y) => x[0] - y[0])
      expect(got).toEqual([...gaps.map((g) => [g, 2]), [16, 1], [17, 1], [18, 1]])
      expect(await rotation(worldId)).toMatchObject({ high_water: '19' })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ districtTickets: { highWater: 19, active: 19, free: 0 } }] })
    })

    it('5. a reload, re-entry, relaunch or new session returns the same ticket: nobody skips a district by logging in again', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const first = await env.ticketOf(a)
      const repeats = await Promise.all(Array.from({ length: 6 }, () => env.enter(a)))
      expect(repeats.every((r) => !r.fresh && r.ticket?.id === first.id)).toBe(true)
      // A relaunch in the same browser (a new session) and a launch in another browser: still the same ticket.
      const relaunched = await env.open(INSTALLATION_A, ADA, a.token)
      const elsewhere = await env.open(INSTALLATION_A, ADA)
      for (const o of [relaunched, elsewhere]) expect(await env.enter(o)).toMatchObject({ fresh: false, ticket: { id: first.id, ordinal: 0 } })
      // Reading never issues.
      const reader = await env.open(INSTALLATION_A, BEA)
      expect(await env.tickets.current(await env.live(reader))).toBeNull()
      expect(await rotation(a.response.world.id)).toMatchObject({ high_water: '1' })
      expect((await env.ticketOf(reader, [keeper(2)])).ordinal).toBe(1)
      // The one-active-ticket-per-player rule is the database's own: a second active ticket cannot be written.
      await expect(t.db.query(`INSERT INTO world_district_tickets SELECT * FROM world_district_tickets WHERE id = $1`, [first.id])).rejects.toThrow()
    })

    it('no eligible NFT, no ticket; a world whose every district is gated has no default district', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      expect(await refusalOf(env.enter(a, []))).toBe('not_eligible')
      // An NFT of another city's collections is not an NFT of this city.
      expect(await refusalOf(env.enter(a, [nftAsset({ chain: 'eip155:1', contract: contract(0xbeef), tokenId: '1' })!]))).toBe('not_eligible')
      expect(await rotation(a.response.world.id)).toMatchObject({ high_water: '0' })
      env.p.publish(INSTALLATION_B, { ...DOC, districts: DOC.districts.map((d) => ({ ...d, proofyRule: { verificationRuleId: 9, label: 'Gated' } })) })
      const b = await env.open(INSTALLATION_B, ADA)
      expect(await refusalOf(env.enter(b))).toBe('no_default_district')
    })
  })

  describe('expiry, cancellation and stale generations', () => {
    it('6. an expired or released ticket cannot commit; nothing is written or frozen, and the slot is reused', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const worldId = a.response.world.id
      const ta = await env.ticketOf(a)
      await leaveOnly(worldId, ADA, -0.3)
      const drawn = await env.drawnOf(a)
      const asked = env.p.calls.length
      expect(await refusalOf(env.activate(a, ta, keeper(1), 'lantern-quay-w0-p0', [], drawn))).toBe('ticket_expired')
      // Refused on the ticket alone: Play was asked only by requireActor, never for the first property's configuration.
      expect(env.p.calls.slice(asked)).toEqual([`getInstallation ${INSTALLATION_A}`])
      expect(await sequenceOf(worldId)).toBe(1)
      expect(await frozen(worldId)).toBe(false)
      // The server expires it on the next ticket transaction (no browser unload needed), and the slot goes to the next entrant.
      expect(await env.tickets.current(await env.live(a))).toBeNull()
      const b = await env.open(INSTALLATION_A, BEA)
      const tb = (await env.ticketOf(b, [keeper(2)]))
      expect([tb.ordinal, tb.generation]).toEqual([0, 2])
      expect(await statusOf(ta.id)).toBe('expired')
      expect(await refusalOf(env.activate(a, ta, keeper(1), 'lantern-quay-w0-p0'))).toBe('ticket_expired')

      // Released: refused as no longer live.
      const env2 = await setup({ migrated: true, play: env.p })
      const c = await env2.open(INSTALLATION_B, CY)
      const tc = (await env2.ticketOf(c))
      await env2.release(c, tc)
      expect(await refusalOf(env2.activate(c, tc, keeper(1), 'lantern-quay-w0-p0'))).toBe('ticket_not_live')
      expect(await refusalOf(env2.release(c, tc))).toBe('ticket_not_live')
      expect(await sequenceOf(c.response.world.id)).toBe(1)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('7. a stale ticket cannot commit after its slot is reissued; the reissued generation can', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const d = await env.open(INSTALLATION_A, DEE)
      const stale = (await env.ticketOf(a))
      await env.release(a, stale)
      const fresh = (await env.ticketOf(d, [keeper(1), keeper(4)]))
      expect([fresh.ordinal, fresh.generation]).toEqual([stale.ordinal, stale.generation! + 1])
      // A's old page names the old ticket, on the same district and plot: refused, whatever it asks.
      expect(await refusalOf(env.activate(a, stale, keeper(1), 'lantern-quay-w0-p0'))).toBe('ticket_not_live')
      // Nor can anyone else use the slot's new ticket.
      expect(await refusalOf(env.activate(a, fresh, keeper(1), 'lantern-quay-w0-p0'))).toBe('ticket_not_live')
      expect((await env.activate(d, fresh, keeper(4), 'lantern-quay-w0-p0')).fresh).toBe(true)
      const worldId = a.response.world.id
      expect((await slotsOf(worldId))[0]).toMatchObject({ state: 'consumed', generation: 2 })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ districtTickets: { committed: 1, highWater: 1 } }] })
    })

    it('commit against cancel: whichever takes the ticket first wins, the other is refused, nothing half-done', async () => {
      // Cancel lands while the activation holds the city but not yet the ticket: the activation sees it released.
      let resume!: () => void
      let reached!: () => void
      const atLock = new Promise<void>((r) => (reached = r))
      const gate = new Promise<void>((r) => (resume = r))
      let pause = true
      const env = await setup({ onStep: async (step) => { if (step === 'locked' && pause) { reached(); await gate } } })
      const a = await env.open(INSTALLATION_A, ADA)
      const ta = (await env.ticketOf(a))
      const drawn = await env.drawnOf(a)
      const commit = env.activate(a, ta, keeper(1), 'lantern-quay-w0-p0', [], drawn)
      await atLock
      await env.release(a, ta)
      resume()
      expect(await refusalOf(commit)).toBe('ticket_not_live')
      expect(await sequenceOf(a.response.world.id)).toBe(1)

      // The activation holds the ticket first: the cancel waits, then finds it committed.
      pause = false
      let resume2!: () => void
      let reached2!: () => void
      const atTicket = new Promise<void>((r) => (reached2 = r))
      const gate2 = new Promise<void>((r) => (resume2 = r))
      const env2 = await setup({ migrated: true, play: env.p, onStep: async (step) => { if (step === 'ticket') { reached2(); await gate2 } } })
      const b = await env2.open(INSTALLATION_B, BEA)
      const tb = (await env2.ticketOf(b, [keeper(2)]))
      const commit2 = env2.activate(b, tb, keeper(2), 'lantern-quay-w0-p1')
      await atTicket
      const cancel = env2.release(b, tb)
      await sleep(150)
      resume2()
      expect((await commit2).fresh).toBe(true)
      expect(await refusalOf(cancel)).toBe('ticket_not_live')
      expect(await statusOf(tb.id)).toBe('committed')
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('commit against expiry: a lease that runs out while the activation is being written is refused by the database, typed', async () => {
      let resume!: () => void
      let reached!: () => void
      const atTicket = new Promise<void>((r) => (reached = r))
      const gate = new Promise<void>((r) => (resume = r))
      const env = await setup({ onStep: async (step) => { if (step === 'ticket') { reached(); await gate } } })
      const a = await env.open(INSTALLATION_A, ADA)
      const ta = await env.ticketOf(a)
      await leaveOnly(a.response.world.id, ADA, 1)
      const commit = env.activate(a, ta, keeper(1), 'lantern-quay-w0-p0')
      await atTicket
      await sleep(1_200)
      resume()
      expect(await refusalOf(commit)).toBe('ticket_expired')
      expect(await sequenceOf(a.response.world.id)).toBe(1)
      expect(await frozen(a.response.world.id)).toBe(false)
      expect(await statusOf(ta.id)).toBe('active')
    })

    it('switch against expiry: a lease that runs out between the check and the replacement ticket is refused ticket_expired, both ways; nothing changes', async () => {
      // The lease is checked (`namedTicket`), the old ticket released, then held at `reassigning` until the lease is over:
      // the database refuses the replacement, which keeps that lease, as already expired.
      let armed = false
      const env = await setup({ onTicketStep: async (step) => { if (step === 'reassigning' && armed) await sleep(1_200) } })
      const a = await env.open(INSTALLATION_A, ADA)
      const worldId = a.response.world.id
      const everything = async () => ({
        tickets: (await t.db.query('SELECT id, status, end_reason, expires_at FROM world_district_tickets WHERE world_id = $1 ORDER BY issued_at, id', [worldId])).rows,
        slots: await slotsOf(worldId),
        rotation: await rotation(worldId),
        sequence: await sequenceOf(worldId),
        frozen: await frozen(worldId),
        properties: (await one<{ n: number }>('SELECT count(*)::int AS n FROM world_properties WHERE world_id = $1', [worldId])).n,
        events: (await one<{ n: number }>('SELECT count(*)::int AS n FROM city_events')).n,
      })

      // Fallback to rule: refused, typed. The fallback ticket is still active and its slot still held, no rule ticket exists.
      const ta = await env.ticketOf(a, [tide(1)])
      await leaveOnly(worldId, ADA, 1)
      const before = await everything()
      armed = true
      expect(await refusalOf(env.assign(a, ta, tide(1), [{ id: 'r1', district: 'dune' }]))).toBe('ticket_expired')
      armed = false
      expect(await everything()).toEqual(before)
      expect(before).toMatchObject({ slots: [{ ordinal: 0, generation: 1, state: 'held' }], sequence: 1, frozen: false, properties: 0 })

      // The slot was never lost: once the lease is expired, the next entrant receives it at its next generation.
      const b = await env.open(INSTALLATION_A, BEA)
      expect((await env.ticketOf(b, [keeper(2)]))).toMatchObject({ districtKey: 'lantern-quay', ordinal: 0, generation: 2 })
      expect(await statusOf(ta.id)).toBe('expired')

      // Rule back to fallback: refused, typed. The rule ticket is still active and the freed slot still free.
      const c = await env.open(INSTALLATION_A, CY)
      const tc = (await env.ticketOf(c, [tide(3), keeper(3)]))
      const ruled = (await env.assign(c, tc, tide(3), [{ id: 'r1', district: 'dune' }])).ticket
      await leaveOnly(worldId, CY, 1)
      const held = await everything()
      expect(held.slots.find((x) => x.ordinal === Number(tc.ordinal))).toMatchObject({ state: 'free' })
      armed = true
      expect(await refusalOf(env.assign(c, ruled, keeper(3)))).toBe('ticket_expired')
      armed = false
      expect(await everything()).toEqual(held)
      expect(await statusOf(ruled.id)).toBe('active')
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('switch against expiry: only that refusal of the database is ticket_expired; any other error inside a switch is not reclassified', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const ta = (await env.ticketOf(a, [tide(1)]))
      // A different refusal raised where the replacement is inserted (a test-only trigger in this disposable schema).
      await t.db.query("CREATE FUNCTION test_other_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'some other refusal'; END $$")
      await t.db.query("CREATE TRIGGER test_other_refusal BEFORE INSERT ON world_district_tickets FOR EACH ROW WHEN (NEW.kind = 'rule') EXECUTE FUNCTION test_other_refusal()")
      const err = await env.assign(a, ta, tide(1), [{ id: 'r1', district: 'dune' }]).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(pg.DatabaseError)
      expect(err).toMatchObject({ code: 'P0001', message: 'some other refusal' })
      expect(err).not.toBeInstanceOf(DistrictTicketRefusal)
      await t.db.query('DROP TRIGGER test_other_refusal ON world_district_tickets')
      // Rolled back: the fallback ticket is as it was, and the switch then works.
      expect(await statusOf(ta.id)).toBe('active')
      expect((await env.assign(a, ta, tide(1), [{ id: 'r1', district: 'dune' }])).ticket).toMatchObject({ kind: 'rule', districtKey: 'dune' })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })
  })

  describe('activation', () => {
    it('8. a failed activation consumes no ticket and freezes nothing; the same ticket then succeeds', async () => {
      let fail: ActivationStep | null = null
      const env = await setup({ onStep: (step) => { if (step === fail) throw new Error(`injected at ${step}`) } })
      const a = await env.open(INSTALLATION_A, ADA)
      const worldId = a.response.world.id
      const ta = (await env.ticketOf(a))
      // Outside its district, on a gated district, on a plot that is not a plot, on another geometry.
      expect(await refusalOf(env.activate(a, ta, keeper(1), 'tidewater-w0-p0'))).toBe('plot_outside_assignment')
      expect(await refusalOf(env.activate(a, ta, keeper(1), 'compass-row-w0-p0'))).toBe('plot_outside_assignment')
      expect(await refusalOf(env.activate(a, ta, keeper(1), 'lantern-quay-w9-p0'))).toBe('plot-unavailable')
      expect(await refusalOf(env.activate(a, ta, keeper(1), 'lantern-quay-w0-p0', [], 'f'.repeat(64)))).toBe('config_superseded')
      // Play silent about the active configuration of a first property (it answered requireActor, then not under the lock).
      const drawn = await env.drawnOf(a)
      const ask = env.p.play.getInstallation.bind(env.p.play)
      let asked = 0
      env.p.play.getInstallation = (id, o) => (++asked === 2 ? Promise.reject(new Error('unreachable')) : ask(id, o))
      expect(await refusalOf(env.activate(a, ta, keeper(1), 'lantern-quay-w0-p0', [], drawn))).toBe('active_config_unverified')
      env.p.play.getInstallation = ask
      // Failures after everything was written, up to the ticket's own consumption: rolled back whole.
      for (const step of ['event', 'freeze', 'property', 'consumed'] as const) {
        fail = step
        await expect(env.activate(a, ta, keeper(1), 'lantern-quay-w0-p0')).rejects.toThrow(`injected at ${step}`)
      }
      fail = null
      expect(await statusOf(ta.id)).toBe('active')
      expect(await sequenceOf(worldId)).toBe(1)
      expect(await frozen(worldId)).toBe(false)
      expect((await slotsOf(worldId))[0]).toMatchObject({ state: 'held', generation: 1 })
      expect(await rotation(worldId)).toMatchObject({ committed_count: '0' })
      const placed = await env.activate(a, ta, keeper(1), 'lantern-quay-w0-p0')
      expect([placed.fresh, placed.sequence, placed.ticketId]).toEqual([true, 2, ta.id])
      expect(await frozen(worldId)).toBe(true)
    })

    it('9. a completed activation consumes exactly one ticket, a repeat consumes nothing, and it all survives a restart', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const worldId = a.response.world.id
      const ta = (await env.ticketOf(a, [keeper(1), keeper(2)]))
      const placed = await env.activate(a, ta, keeper(1), 'lantern-quay-w0-p2')
      // The same activation again (a retry, a double click): the same property, nothing consumed.
      const again = await env.activate(a, ta, keeper(1), 'lantern-quay-w0-p2')
      expect([again.fresh, again.property.id, again.ticketId]).toEqual([false, placed.property.id, undefined])
      const committed = await one<{ status: string; property_id: string; committed_sequence: string; end_reason: string }>('SELECT status, property_id, committed_sequence, end_reason FROM world_district_tickets WHERE id = $1', [ta.id])
      expect(committed).toEqual({ status: 'committed', property_id: placed.property.id, committed_sequence: '2', end_reason: 'activated' })
      expect(await rotation(worldId)).toMatchObject({ high_water: '1', committed_count: '1' })
      // A consumed ticket places nothing else.
      expect(await refusalOf(env.activate(a, ta, keeper(2), 'lantern-quay-w0-p3'))).toBe('ticket_not_live')

      // A restart: a new pool, new services, the same database.
      const before = await worldTicketsOf(t.db, worldId)
      const restarted = createPool(process.env.TEST_DATABASE_URL!, silentLogger, { searchPath: t.schema })
      try {
        expect(await worldTicketsOf(restarted, worldId)).toEqual(before)
        const env2 = await setup({ db: restarted, migrated: true, play: env.p })
        const a2 = await env2.open(INSTALLATION_A, ADA)
        expect(await env2.tickets.current(await env2.live(a2))).toBeNull()
        expect((await env2.ticketOf(a2, [keeper(1), keeper(2)]))).toMatchObject({ ordinal: 1, districtKey: 'tidewater' })
        expect(await verifyCity(restarted)).toMatchObject({ ok: true, worlds: [{ properties: 1, districtTickets: { committed: 1, active: 1 } }] })
      } finally {
        await restarted.end()
      }
    })

    it('13. two players on one plot of one district: one property; the other keeps their ticket and chooses again', async () => {
      const env = await setup()
      const opened = await Promise.all([ADA, BEA, CY, DEE, player(5)].map((who) => env.open(INSTALLATION_A, who)))
      const entered = []
      for (const [i, o] of opened.entries()) entered.push((await env.ticketOf(o, [keeper(10 + i)])))
      // Ada (ordinal 0) and P5 (ordinal 4) both hold lantern-quay.
      expect([entered[0].districtKey, entered[4].districtKey]).toEqual(['lantern-quay', 'lantern-quay'])
      const results = await Promise.allSettled([env.activate(opened[0], entered[0], keeper(10), 'lantern-quay-w0-p1'), env.activate(opened[4], entered[4], keeper(14), 'lantern-quay-w0-p1')])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const loser = results.findIndex((r) => r.status === 'rejected')
      expect(await refusalOf(Promise.reject((results[loser] as PromiseRejectedResult).reason))).toBe('plot-unavailable')
      const loserTicket = entered[loser === 0 ? 0 : 4]
      expect(await statusOf(loserTicket.id)).toBe('active')
      expect((await env.activate(opened[loser === 0 ? 0 : 4], loserTicket, keeper(loser === 0 ? 10 : 14), 'lantern-quay-w0-p2')).fresh).toBe(true)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })
  })

  describe('collections, explicit rules and several NFTs', () => {
    it('10. NFTs of different collections share one rotation', async () => {
      const env = await setup()
      const [a, b, c] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY)]
      const ta = (await env.ticketOf(a, [keeper(1)]))
      const tb = (await env.ticketOf(b, [tide(7)]))
      const tc = (await env.ticketOf(c, [keeper(3), tide(8)]))
      expect([ta, tb, tc].map((x) => x.districtKey)).toEqual(['lantern-quay', 'tidewater', 'saltmarsh'])
      await env.activate(b, tb, tide(7), 'tidewater-w0-p0')
      await env.activate(c, tc, tide(8), 'saltmarsh-w0-p0')
      await env.activate(a, ta, keeper(1), 'lantern-quay-w0-p0')
      expect((await t.db.query<{ collection_key: string }>('SELECT collection_key FROM world_properties ORDER BY activated_sequence')).rows.map((r) => r.collection_key)).toEqual(['tide-pass', 'tide-pass', 'harbor-keepers'])
    })

    it('11. an explicit rule releases the unused fallback slot for the next entrant and assigns the rule\'s district before any plot', async () => {
      const env = await setup()
      const rules: DistrictRuleMatch[] = [{ id: 'tide-to-saltmarsh', district: 'saltmarsh' }]
      const [a, b] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA)]
      const worldId = a.response.world.id
      const fallback = (await env.ticketOf(a, [tide(1), keeper(1)]))
      expect(fallback.districtKey).toBe('lantern-quay')
      // A fallback ticket cannot place an NFT a rule assigns.
      expect(await refusalOf(env.activate(a, fallback, tide(1), 'lantern-quay-w0-p0', rules))).toBe('district_rule_applies')
      // Selecting it swaps the ticket: the rule's district, for that NFT, with the lease Ada had.
      const assigned = await env.assign(a, fallback, tide(1), rules)
      expect(assigned.changed).toBe(true)
      expect(assigned.ticket).toMatchObject({ kind: 'rule', districtKey: 'saltmarsh', ordinal: null, generation: null, asset: 'eip155:1/erc721:0x000000000000000000000000000000000000a002/1', ruleRef: 'tide-to-saltmarsh', expiresAt: fallback.expiresAt })
      expect(await one('SELECT status, end_reason FROM world_district_tickets WHERE id = $1', [fallback.id])).toEqual({ status: 'released', end_reason: 'reassigned' })
      // The freed District 1 slot goes to the next entrant.
      expect((await env.ticketOf(b, [keeper(2)]))).toMatchObject({ ordinal: 0, generation: 2, districtKey: 'lantern-quay' })
      // Selecting the same NFT again changes nothing; the rule ticket places only that NFT, only in its district.
      expect((await env.assign(a, assigned.ticket, tide(1), rules)).changed).toBe(false)
      expect(await refusalOf(env.activate(a, assigned.ticket, keeper(1), 'saltmarsh-w0-p0', []))).toBe('ticket_asset_mismatch')
      expect(await refusalOf(env.activate(a, assigned.ticket, tide(1), 'tidewater-w0-p0', rules))).toBe('plot_outside_assignment')
      const placed = await env.activate(a, assigned.ticket, tide(1), 'saltmarsh-w0-p0', rules)
      expect(placed.property.districtKey).toBe('saltmarsh')
      expect(await rotation(worldId)).toMatchObject({ high_water: '1', committed_count: '1' })
      // Ada's next NFT on a fallback ticket: committed tickets outnumber rotation ordinals (a rule ticket takes none).
      const next = (await env.ticketOf(a, [tide(1), keeper(1)]))
      expect([next.ordinal, next.generation, next.districtKey]).toEqual([1, 1, 'tidewater'])
      await env.activate(a, next, keeper(1), 'tidewater-w0-p1')
      await env.activate(b, (await env.tickets.current(await env.live(b)))!, keeper(2), 'lantern-quay-w0-p0')
      expect(await rotation(worldId)).toMatchObject({ high_water: '2', committed_count: '3' })
      const c = await env.open(INSTALLATION_A, CY)
      const tc = (await env.ticketOf(c, [tide(3)]))
      await env.activate(c, (await env.assign(c, tc, tide(3), rules)).ticket, tide(3), 'saltmarsh-w0-p2', rules)
      expect(await rotation(worldId)).toMatchObject({ high_water: '3', committed_count: '4' })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ districtTickets: { committed: 4, highWater: 3, free: 1 } }] })
    })

    it('rules: switching back to an NFT no rule assigns returns to the rotation; conflicting rules and gated districts are refused, never guessed', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const t0 = (await env.ticketOf(a, [tide(1), keeper(1)]))
      const ruled = (await env.assign(a, t0, tide(1), [{ id: 'r1', district: 'dune' }])).ticket
      const back = await env.assign(a, ruled, keeper(1))
      expect(back).toMatchObject({ changed: true, ticket: { kind: 'fallback', ordinal: 0, generation: 2, districtKey: 'lantern-quay', expiresAt: t0.expiresAt } })
      // Two rules naming different districts: no approved precedence, so refused, at selection and at activation.
      const conflicting = [{ id: 'by-collection', district: 'saltmarsh' }, { id: 'by-trait', district: 'dune' }]
      expect(await refusalOf(env.assign(a, back.ticket, tide(1), conflicting))).toBe('district_rule_ambiguous')
      expect(await refusalOf(env.activate(a, back.ticket, tide(1), 'lantern-quay-w0-p0', conflicting))).toBe('district_rule_ambiguous')
      // Two rules naming the same district agree: both ids are recorded.
      expect((await env.assign(a, back.ticket, tide(1), [{ id: 'b', district: 'dune' }, { id: 'a', district: 'dune' }])).ticket).toMatchObject({ districtKey: 'dune', ruleRef: 'a,b' })
      // A rule naming a district this city does not have is not a rule of this city; one naming a gated district is refused.
      const current = (await env.tickets.current(await env.live(a)))!
      expect((await env.assign(a, current, keeper(1), [{ id: 'elsewhere', district: 'orchard' }])).ticket).toMatchObject({ kind: 'fallback' })
      const now = (await env.tickets.current(await env.live(a)))!
      expect(await refusalOf(env.assign(a, now, keeper(1), [{ id: 'captains', district: 'compass-row' }]))).toBe('district_rule_unverified')
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('rules whose ids together are longer than a ticket records are refused, typed, before anything is written; the exact limit is recorded; the database still refuses more', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const worldId = a.response.world.id
      // Each id valid on its own (at most 64 characters), every rule naming one district.
      const rules = (...lengths: number[]): DistrictRuleMatch[] => lengths.map((n, i) => ({ id: 'abcd'[i].repeat(n), district: 'dune' }))
      const four = rules(64, 64, 64, 64)
      const exact = rules(64, 64, 64, 5)
      const over = rules(64, 64, 64, 6)
      const t0 = (await env.ticketOf(a, [tide(1)]))
      const ticketsOf = async () => (await t.db.query('SELECT id, kind, status, rule_ref FROM world_district_tickets WHERE world_id = $1 ORDER BY issued_at, id', [worldId])).rows
      const before = { tickets: await ticketsOf(), slots: await slotsOf(worldId) }
      // Four long ids (259 characters) and one past the limit (201): refused at selection, and nothing changes.
      for (const matches of [four, over]) {
        expect(await refusalOf(env.assign(a, t0, tide(1), matches))).toBe('district_rule_ref_too_long')
        expect({ tickets: await ticketsOf(), slots: await slotsOf(worldId) }).toEqual(before)
      }
      // The fallback ticket cannot place the NFT those rules decide either; nothing is written or frozen.
      expect(await refusalOf(env.activate(a, t0, tide(1), 'lantern-quay-w0-p0', four))).toBe('district_rule_ref_too_long')
      expect([await sequenceOf(worldId), await frozen(worldId)]).toEqual([1, false])
      // Ambiguity is still decided first: conflicting districts are ambiguous however long the ids.
      expect(await refusalOf(env.assign(a, t0, tide(1), [...four, { id: 'e'.repeat(64), district: 'saltmarsh' }]))).toBe('district_rule_ambiguous')
      // Exactly the limit: issued, every id recorded, and the rule ticket places the NFT.
      const ruled = await env.assign(a, t0, tide(1), exact)
      expect(ruled).toMatchObject({ changed: true, ticket: { kind: 'rule', districtKey: 'dune', ruleRef: exact.map((r) => r.id).join(',') } })
      expect((await one<{ n: number }>('SELECT char_length(rule_ref)::int AS n FROM world_district_tickets WHERE id = $1', [ruled.ticket.id])).n).toBe(MAX_RULE_REF_LENGTH)
      expect((await env.activate(a, ruled.ticket, tide(1), 'dune-w0-p0', exact)).property.plotId).toBe('dune-w0-p0')
      expect(await statusOf(ruled.ticket.id)).toBe('committed')
      // The database's own limit stays: past the guards (replica role), a 201-character ref is still refused by its CHECK.
      const client = await t.db.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SET LOCAL session_replication_role = 'replica'`)
        await expect(client.query('UPDATE world_district_tickets SET rule_ref = $2 WHERE id = $1', [ruled.ticket.id, over.map((r) => r.id).join(',')])).rejects.toMatchObject({ code: '23514', constraint: 'wdt_rule_shape' })
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('12. a player claims a second, distinct NFT without signing out; never two pending tickets', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const b = await env.open(INSTALLATION_A, BEA)
      const mine = [keeper(1), keeper(2)]
      const first = (await env.ticketOf(a, mine))
      await env.activate(a, first, keeper(1), 'lantern-quay-w0-p0')
      await env.enter(b, [keeper(5)])
      // The same session enters again: a new, independently issued ticket (the next slot), not the consumed one.
      const second = await env.enter(a, mine)
      expect(second).toMatchObject({ fresh: true, ticket: { ordinal: 2, districtKey: 'saltmarsh' } })
      expect(second.ticket!.id).not.toBe(first.id)
      await env.activate(a, second.ticket!, keeper(2), 'saltmarsh-w0-p0')
      // Nothing left to place: no third ticket.
      expect(await refusalOf(env.enter(a, mine))).toBe('not_eligible')
      expect((await t.db.query('SELECT 1 FROM world_properties WHERE activator_discord_user_id = $1', [ADA.discordUserId])).rowCount).toBe(2)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ districtTickets: { committed: 2, active: 1 } }] })
    })
  })

  describe('isolation', () => {
    it('14. worlds and guilds are apart: separate rotations; a ticket of one world authorizes nothing in another', async () => {
      const env = await setup()
      const inA = await env.open(INSTALLATION_A, ADA)
      const inB = await env.open(INSTALLATION_B, ADA)
      const ta = (await env.ticketOf(inA))
      const tb = (await env.ticketOf(inB))
      expect([ta.ordinal, tb.ordinal, ta.worldId === tb.worldId]).toEqual([0, 0, false])
      // Ada's world-A ticket, presented in world B (and the other way round).
      expect(await refusalOf(env.activate(inB, ta, keeper(1), 'lantern-quay-w0-p0'))).toBe('ticket_not_live')
      expect(await refusalOf(env.activate(inA, tb, keeper(1), 'lantern-quay-w0-p0'))).toBe('ticket_not_live')
      // Bea cannot release, reassign or use Ada's ticket in their shared world.
      const bea = await env.open(INSTALLATION_A, BEA)
      expect(await refusalOf(env.release(bea, ta))).toBe('ticket_not_live')
      expect(await refusalOf(env.assign(bea, ta, keeper(9)))).toBe('ticket_not_live')
      expect(await refusalOf(env.activate(bea, ta, keeper(9), 'lantern-quay-w0-p0'))).toBe('ticket_not_live')
      // The database refuses a ticket bound to another world's installation.
      await expect(
        t.db.query(`UPDATE world_district_tickets SET play_installation_id = $2 WHERE id = $1`, [ta.id, INSTALLATION_B]),
      ).rejects.toThrow()
      expect(await statusOf(ta.id)).toBe('active')
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })
  })

  describe('geometry', () => {
    it('15. an incompatible pre-freeze configuration change supersedes active tickets in its own transaction and reissues them in order; old tickets and old maps cannot commit', async () => {
      const env = await setup()
      const [a, b] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA)]
      const worldId = a.response.world.id
      const ta = (await env.ticketOf(a))
      const tb = (await env.ticketOf(b, [keeper(2)]))
      const oldMap = a.response.world.definition.geometryFingerprint
      // A presentation-only version: same districts, same ground. Tickets stand, the rotation records the new basis.
      env.p.publish(INSTALLATION_A, DOC_RENAMED)
      await env.open(INSTALLATION_A, CY)
      expect(await rotation(worldId)).toMatchObject({ epoch: 1, basis_config_version: 2 })
      expect(await statusOf(ta.id)).toBe('active')
      // The districts reversed: other ground under the same plot ids. Adopted by Cy's launch, before any property.
      env.p.publish(INSTALLATION_A, DOC_REVERSED)
      const c = await env.open(INSTALLATION_A, CY)
      expect(c.response.world.definition.geometryFingerprint).not.toBe(oldMap)
      expect(await rotation(worldId)).toMatchObject({ epoch: 2, basis_config_version: 3, districts: [...ROTATION].reverse() })
      expect([await statusOf(ta.id), await statusOf(tb.id)]).toEqual(['superseded', 'superseded'])
      // Reissued to their holders, in their old order, on the new rotation, keeping the lease they had.
      const [na, nb] = [(await env.tickets.current(await env.live(a)))!, (await env.tickets.current(await env.live(b)))!]
      expect([na.ordinal, na.districtKey, na.epoch, na.reissuedFrom, na.expiresAt, nb.ordinal, nb.districtKey, nb.reissuedFrom]).toEqual([2, 'dune', 2, ta.id, ta.expiresAt, 3, 'saltmarsh', tb.id])
      // The old ticket cannot commit, on either map; the old map cannot commit with the new ticket.
      expect(await refusalOf(env.activate(a, ta, keeper(1), 'lantern-quay-w0-p0', [], oldMap))).toBe('config_superseded')
      expect(await refusalOf(env.activate(a, ta, keeper(1), 'dune-w0-p0'))).toBe('ticket_superseded')
      expect(await refusalOf(env.activate(a, na, keeper(1), 'dune-w0-p0', [], oldMap))).toBe('config_superseded')
      expect(await sequenceOf(worldId)).toBe(1)
      // On the new map, with the new ticket: placed, and the reversed geometry is frozen.
      expect((await env.activate(a, na, keeper(1), 'dune-w0-p0')).fresh).toBe(true)
      expect(await frozen(worldId)).toBe(true)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ districtTickets: { epoch: 2, committed: 1 } }] })
      // After the freeze, moving the districts is refused at launch (0008), and the rotation stays as it is.
      env.p.publish(INSTALLATION_A, DOC)
      await expect(env.open(INSTALLATION_A, CY)).rejects.toMatchObject({ code: 'config_incompatible' })
      expect(await rotation(worldId)).toMatchObject({ epoch: 2, basis_config_version: 3 })
    })

    it('the database refuses an adoption that leaves the rotation behind', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      await env.enter(a)
      const worldId = a.response.world.id
      // Version 2 is recorded through this build but does not govern: the run is pinned to it, then Play re-activates 1.
      env.p.publish(INSTALLATION_A, DOC_RENAMED)
      const run = env.p.launch(INSTALLATION_A, `pinned-${randomUUID()}`, { player: ADA })
      env.p.activate(INSTALLATION_A, 1)
      await env.launch.open({ runToken: run })
      expect((await t.db.query('SELECT version FROM world_config_versions WHERE world_id = $1 ORDER BY version', [worldId])).rows).toEqual([{ version: 1 }, { version: 2 }])
      // Adopting it by hand, without moving the rotation: refused when the statement's transaction commits.
      await expect(t.db.query('INSERT INTO world_config_adoptions (world_id, adoption_seq, version) VALUES ($1, 2, 2)', [worldId])).rejects.toThrow(/follows every configuration adoption/)
      expect(await rotation(worldId)).toMatchObject({ basis_config_version: 1 })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })
  })

  describe('migration 0010', () => {
    const TABLES: Record<string, string> = {
      app_meta: 'key', city: 'id', city_events: 'city_id, sequence', worlds: 'id', world_play_bindings: 'world_id', world_config_versions: 'world_id, version', world_config_geometries: 'world_id, version',
      world_config_adoptions: 'world_id, adoption_seq', world_geometry_freezes: 'world_id', world_properties: 'id', play_sessions: 'id',
    }
    const rows = async () => Object.fromEntries(await Promise.all(Object.entries(TABLES).map(async ([table, order]) => [table, await snapshot(t.db, table, order)])))
    async function through(last: number, extra = ''): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'rc-tickets-'))
      for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort())
        if (Number(file.slice(0, 4)) <= last) await copyFile(join(MIGRATIONS_DIR, file), join(dir, file))
      if (extra) await writeFile(join(dir, '0010_district_tickets.sql'), `${await readFile(join(MIGRATIONS_DIR, '0010_district_tickets.sql'), 'utf8')}\n${extra}\n`)
      return dir
    }

    it('applies onto a populated 0009 database without changing a row; a world placed before it then enters the rotation', async () => {
      const dir = await through(9)
      try {
        await migrate(t.db, { dir, environment: 'local' })
        const env = await setup({ migrated: true })
        const a = await env.open(INSTALLATION_A, ADA)
        // A property placed the 0009 way (no ticket): the store-level path, which 0010 must not reinterpret.
        await env.store.activate(await env.live(a), { asset: keeper(1), plotId: 'saltmarsh-w0-p0', geometryFingerprint: a.response.world.definition.geometryFingerprint }, { activeConfig: env.sessions.activeConfig(await env.live(a)) })
        await env.open(INSTALLATION_B, BEA)
        const before = await rows()
        const through10 = await through(10)
        try {
          expect(await migrate(t.db, { dir: through10, environment: 'local' })).toEqual({ applied: [10], current: 10 })
        } finally {
          await rm(through10, { recursive: true, force: true })
        }
        expect(await rows()).toEqual(before)
        // And 0011 after it, changing nothing either.
        expect(await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).toEqual({ applied: [11, 12, 13, 14, 15, 16, 17, 18], current: 18 })
        expect(await rows()).toEqual(before)
        expect(await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).toEqual({ applied: [], current: 18 })
        expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ properties: 1, districtTickets: null }, { properties: 0, districtTickets: null }] })
        // The world enters the rotation now; its earlier property is not a ticket's, and the next one consumes one.
        const ta = (await env.ticketOf(a, [keeper(1), keeper(2)]))
        expect(ta).toMatchObject({ ordinal: 0, districtKey: 'lantern-quay' })
        await env.activate(a, ta, keeper(2), 'lantern-quay-w0-p0')
        expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ properties: 2, districtTickets: { committed: 1 } }, { districtTickets: null }] })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('a failure inside it leaves nothing behind, and it applies cleanly afterwards', async () => {
      const dir = await through(10, 'SELECT 1 / 0;')
      try {
        await expect(migrate(t.db, { dir, environment: 'local' })).rejects.toThrow(/division by zero/)
        expect((await t.db.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0].v).toBe(9)
        expect(await t.tables()).not.toContain('world_district_tickets')
        const left = (await t.db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND (p.proname LIKE 'world_rotation%' OR p.proname LIKE 'world_district%' OR p.proname LIKE 'world_assignment%')", [t.schema])).rows[0].n
        expect(left).toBe(0)
        expect(await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).toEqual({ applied: [10, 11, 12, 13, 14, 15, 16, 17, 18], current: 18 })
        expect(await t.tables()).toEqual(expect.arrayContaining(['world_assignment_rotations', 'world_assignment_slots', 'world_district_tickets']))
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('pins every guard to its own schema, never a session\'s temporary objects', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })
      const pinned = (await t.db.query<{ proname: string; proconfig: string[] | null }>("SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND (p.proname LIKE 'world_rotation%' OR p.proname LIKE 'world_district%' OR p.proname LIKE 'world_assignment%' OR p.proname IN ('world_config_adoption_moves_rotation', 'world_property_consumes_ticket')) ORDER BY p.proname", [t.schema])).rows
      expect(pinned.map((r) => r.proname)).toEqual(['world_assignment_rotations_guard', 'world_assignment_slot_retired_by_epoch', 'world_assignment_slots_guard', 'world_config_adoption_moves_rotation', 'world_district_ticket_ended_whole', 'world_district_tickets_guard', 'world_property_consumes_ticket', 'world_rotation_district', 'world_rotation_districts_ok'])
      for (const r of pinned) expect(r.proconfig, r.proname).toEqual([`search_path=${t.schema}, pg_temp`])
    })
  })

  describe('database guards', () => {
    it('refuses rewriting, reviving, deleting or forging tickets, slots and rotations', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const worldId = a.response.world.id
      const ta = (await env.ticketOf(a))
      const attempts: [string, unknown[], RegExp][] = [
        ['UPDATE world_district_tickets SET district_key = $2 WHERE id = $1', [ta.id, 'tidewater'], /keeps what it was issued as/],
        ['UPDATE world_district_tickets SET expires_at = expires_at + interval \'10 minutes\' WHERE id = $1', [ta.id], /keeps what it was issued as/],
        ["UPDATE world_district_tickets SET status = 'expired', end_reason = 'expired' WHERE id = $1", [ta.id], /expires only once its lease has run out/],
        ['DELETE FROM world_district_tickets WHERE id = $1', [ta.id], /cannot be removed/],
        ['DELETE FROM world_assignment_slots WHERE world_id = $1', [worldId], /cannot be removed/],
        ['DELETE FROM world_assignment_rotations WHERE world_id = $1', [worldId], /cannot be removed/],
        ["UPDATE world_assignment_slots SET state = 'free' WHERE world_id = $1", [worldId], /only once its ticket has ended/],
        ["UPDATE world_assignment_slots SET state = 'consumed' WHERE world_id = $1", [worldId], /consumed only by the property/],
        ["UPDATE world_assignment_slots SET district_key = 'dune' WHERE world_id = $1", [worldId], /keeps its world, ordinal, epoch and district/],
        ['UPDATE world_assignment_rotations SET high_water = 0 WHERE world_id = $1', [worldId], /only grow/],
        ['UPDATE world_assignment_rotations SET high_water = high_water + 2 WHERE world_id = $1', [worldId], /only grow/],
        ["UPDATE world_assignment_rotations SET districts = '[\"dune\"]'::jsonb WHERE world_id = $1", [worldId], /only by beginning a new epoch/],
        ['UPDATE world_assignment_rotations SET epoch = 2, epoch_start_ordinal = high_water WHERE world_id = $1', [worldId], /every active ticket of the old one is superseded/],
        ["UPDATE world_district_tickets SET status = 'committed', end_reason = 'activated', property_id = $2, committed_sequence = 2 WHERE id = $1", [ta.id, randomUUID()], /committed only by the property it became/],
      ]
      for (const [sql, params, why] of attempts) await expect(t.db.query(sql, params), sql).rejects.toThrow(why)
      // Released without its slot returning to the gap pool: refused when the transaction commits.
      const client = await t.db.connect()
      try {
        await client.query('BEGIN')
        await client.query("UPDATE world_district_tickets SET status = 'released', end_reason = 'cancel' WHERE id = $1", [ta.id])
        await expect(client.query('COMMIT')).rejects.toThrow(/returns to the gap pool/)
      } finally {
        client.release()
      }
      // A superseded ticket whose rotation did not move on: refused at commit.
      const c2 = await t.db.connect()
      try {
        await c2.query('BEGIN')
        await c2.query("UPDATE world_district_tickets SET status = 'superseded', end_reason = 'rotation_changed', supersede_cause = 'rotation' WHERE id = $1", [ta.id])
        await c2.query("UPDATE world_assignment_slots SET state = 'free' WHERE world_id = $1", [worldId])
        await expect(c2.query('COMMIT')).rejects.toThrow(/superseded only by its rotation beginning a later epoch/)
      } finally {
        c2.release()
      }
      expect(await statusOf(ta.id)).toBe('active')
      // A forged issuance for a player who is not the session's: outside any claim window, then in a window forged for them.
      const fields = `id, world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, actor_discord_user_id, actor_core_user_id, issued_in_play_session, kind, district_key, district_geometry_fingerprint, epoch, ordinal, generation, asset, rule_ref, config_version, config_hash, layout_geometry_fingerprint, status, issued_at, expires_at, claim_window`
      const forge = (client: Pick<pg.Pool, 'query'>, window: string | null) =>
        client.query(
          `INSERT INTO world_district_tickets (${fields}) SELECT $2, world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, '922222222222222222', 'core-x', issued_in_play_session, 'rule', 'tidewater',
                   (SELECT g.v ->> 'geometryFingerprint' FROM world_config_geometries c, jsonb_array_elements(c.districts) g(v) WHERE c.world_id = t.world_id AND c.version = 1 AND g.v ->> 'key' = 'tidewater'),
                   epoch, NULL, NULL, 'eip155:1/erc721:0x000000000000000000000000000000000000a002/1', 'forged', config_version, config_hash, layout_geometry_fingerprint, 'active', now(),
                   (SELECT w.expires_at FROM world_claim_windows w WHERE w.id = $3), $3
              FROM world_district_tickets t WHERE id = $1`,
          [ta.id, randomUUID(), window],
        )
      await expect(forge(t.db, null)).rejects.toThrow(/in its holder's open claim window/)
      const forger = await t.db.connect()
      try {
        await forger.query('BEGIN')
        const w = (await forger.query<{ id: string }>(`INSERT INTO world_claim_windows (id, world_id, actor_discord_user_id, actor_core_user_id, opened_at, expires_at, opened_by) VALUES ($1, $2, '922222222222222222', 'core-x', now(), now(), 'issuance') RETURNING id`, [randomUUID(), worldId])).rows[0]
        await expect(forge(forger, w.id)).rejects.toThrow(/only to the player of a live play session/)
      } finally {
        await forger.query('ROLLBACK')
        forger.release()
      }
      // A window nothing opened with a ticket: refused when its transaction commits.
      await expect(t.db.query(`INSERT INTO world_claim_windows (id, world_id, actor_discord_user_id, actor_core_user_id, opened_at, expires_at, opened_by) VALUES ($1, $2, '922222222222222222', 'core-x', now(), now(), 'issuance')`, [randomUUID(), worldId])).rejects.toThrow(
        /opens with the ticket whose issuance opened it/,
      )
      // A property without a ticket, in a world that assigns districts by tickets.
      await expect(env.store.activate(await env.live(a), { asset: keeper(1), plotId: 'lantern-quay-w0-p0', geometryFingerprint: a.response.world.definition.geometryFingerprint }, { activeConfig: env.sessions.activeConfig(await env.live(a)) })).rejects.toThrow(
        /activated only by consuming a live ticket/,
      )
      expect(await sequenceOf(worldId)).toBe(1)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('defense in depth: a live ticket of an older epoch or geometry, which the guards never let exist, is still refused, typed, and reported', async () => {
      const env = await setup()
      const [a, b] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA)]
      const worldId = a.response.world.id
      const ta = (await env.ticketOf(a))
      const tb = (await env.ticketOf(b, [keeper(2)]))
      const unguarded = async (table: string, trigger: string, sql: string, params: unknown[]) => {
        await t.db.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)
        try {
          await t.db.query(sql, params)
        } finally {
          await t.db.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
        }
      }
      // Ada's ticket names another layout geometry than the one it was issued on.
      await unguarded('world_district_tickets', 'world_district_tickets_guard', 'UPDATE world_district_tickets SET layout_geometry_fingerprint = $2 WHERE id = $1', [ta.id, 'f'.repeat(64)])
      expect(await refusalOf(env.activate(a, ta, keeper(1), 'lantern-quay-w0-p0'))).toBe('ticket_superseded')
      expect(await verifyCity(t.db)).toMatchObject({ ok: false, violations: expect.arrayContaining([expect.objectContaining({ rule: 'tickets' })]) })
      // The rotation moved on to a new epoch while Bea's ticket stayed active.
      await unguarded('world_assignment_rotations', 'world_assignment_rotations_guard', 'UPDATE world_assignment_rotations SET epoch = epoch + 1, epoch_start_ordinal = high_water WHERE world_id = $1', [worldId])
      expect(await refusalOf(env.activate(b, tb, keeper(2), 'tidewater-w0-p0'))).toBe('ticket_superseded')
      expect(await sequenceOf(worldId)).toBe(1)
      expect(await frozen(worldId)).toBe(false)
    })

    it('holds tickets only in a local database, and the service refuses outside local mode', async () => {
      // A database stamped staging: the guards refuse before anything else is looked at.
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      const hash = 'a'.repeat(64)
      await expect(
        t.db.query(`INSERT INTO world_assignment_rotations (world_id, epoch, epoch_start_ordinal, high_water, committed_count, basis_config_version, basis_config_hash, layout_geometry_fingerprint, districts) VALUES ($1, 1, 0, 0, 0, 1, $2, $2, '[]'::jsonb)`, [randomUUID(), hash]),
      ).rejects.toThrow(/only a local database may hold one/)
      await expect(
        t.db.query(
          `INSERT INTO world_district_tickets (id, world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, actor_discord_user_id, actor_core_user_id, issued_in_play_session, kind, district_key,
                                               district_geometry_fingerprint, epoch, ordinal, generation, asset, rule_ref, config_version, config_hash, layout_geometry_fingerprint, status, issued_at, expires_at)
           VALUES ($1, $2, 'staging', 'rare-city', $2, '900000000000000001', '911111111111111111', 'core-x', $2, 'rule', 'tidewater', $3, 1, NULL, NULL, 'eip155:1/erc721:0x000000000000000000000000000000000000a002/1', 'r', 1, $3, $3, 'active', now(), now() + interval '1 minute')`,
          [randomUUID(), randomUUID(), hash],
        ),
      ).rejects.toThrow(/only a local database may hold one/)
      // The service: refused by its mode before anything is read, and by the database's stamp in local mode.
      const actor = { id: randomUUID(), scope: { worldId: randomUUID(), environment: 'dev' as const, gameKey: 'rare-city', installationId: INSTALLATION_A, discordGuildId: GUILD_A }, player: ADA, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }
      const { eligibility } = testSource()
      eligibility.assets = () => [keeper(1)]
      expect(await refusalOf(createDistrictTicketStore(t.db, { mode: 'staging', log: silentLogger, eligibility }).enter(actor))).toBe('mutations_held')
      expect(await refusalOf(createDistrictTicketStore(t.db, { mode: 'local', log: silentLogger, eligibility }).enter(actor))).toBe('mutations_held')
      expect(await refusalOf(createDistrictTicketStore(t.db, { mode: 'local', log: silentLogger, eligibility }).release(actor, randomUUID()))).toBe('mutations_held')
      // Only the local fixture is a source: nothing else may stand in for Proofy Core.
      expect(() => createDistrictTicketStore(t.db, { mode: 'local', log: silentLogger, eligibility: { ...eligibility, source: 'proofy-core' as 'local-fixture' } })).toThrow(/only on the local rehearsal fixture/)
      expect((await t.db.query('SELECT 1 FROM world_assignment_rotations')).rowCount).toBe(0)
    })

    it('16. Rare Friends and worlds nobody entered are untouched: no rotation, and the property path without tickets works there as before', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      // No entry through tickets: no rotation, so the store-level path (internal, no route) still writes as before 0010.
      const placed = await env.store.activate(await env.live(a), { asset: keeper(1), plotId: 'tidewater-w0-p0', geometryFingerprint: a.response.world.definition.geometryFingerprint }, { activeConfig: env.sessions.activeConfig(await env.live(a)) })
      expect(placed.fresh).toBe(true)
      expect((await t.db.query('SELECT 1 FROM world_assignment_rotations')).rowCount).toBe(0)
      expect((await t.db.query("SELECT 1 FROM city WHERE id = 'main'")).rowCount).toBe(0)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ districtTickets: null }] })
    })
  })
})

describe('district tickets are reachable only through the local rehearsal', () => {
  it('builds the ticket store only in main\'s local-rehearsal block; moves the rotation only from adoptions and ticket transactions', async () => {
    const root = resolve(import.meta.dirname, '../src')
    const files: string[] = []
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(join(dir, e.name))
        else if (e.name.endsWith('.ts')) files.push(join(dir, e.name))
      }
    }
    await walk(root)
    const naming = async (pattern: RegExp, except: string[]) => {
      const found: string[] = []
      for (const file of files) if (!except.includes(file.slice(root.length + 1)) && pattern.test(await readFile(file, 'utf8'))) found.push(file.slice(root.length + 1))
      return found.sort()
    }
    expect(await naming(/createDistrictTicketStore\(/, [join('world', 'tickets.ts')])).toEqual(['main.ts'])
    const main = await readFile(join(root, 'main.ts'), 'utf8')
    const block = main.slice(main.indexOf('if (config.localRehearsalFile && playSessions && db) {'))
    expect(block.indexOf('createDistrictTicketStore(')).toBeGreaterThan(0)
    expect(block.indexOf('createDistrictTicketStore(')).toBeLessThan(block.indexOf('\n  }\n'))
    expect(await naming(/syncAssignmentRotation\(/, [join('world', 'rotation.ts')])).toEqual([join('world', 'store.ts'), join('world', 'tickets.ts')])
    expect(await naming(/consumeTicket\(|lockTicketForCommit\(/, [join('world', 'rotation.ts')])).toEqual([join('world', 'properties.ts')])
    // Nothing writes the ticket tables but the rotation module.
    expect(await naming(/INSERT INTO world_(district_tickets|assignment_slots)|UPDATE world_(district_tickets|assignment_slots)/, [])).toEqual([join('world', 'rotation.ts')])
  })
})
