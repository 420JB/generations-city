import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyCity } from '../src/city/verify'
import { migrate } from '../src/db/migrations'
import { type DistrictRuleMatch } from '../src/engine'
import { worldClaimWindowsOf, worldTicketsOf } from '../src/world/rotation'
import { MIGRATIONS_DIR, NO_TEST_DATABASE, useTestSchema } from './dbHarness'
import { ADA, BEA, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'
import { DOC, keeper, player, refusalOf, sleep, ticketWorld, tide } from './ticketHarness'

/**
 * DISTRICT TICKET POLICIES D1 TO D4 (owner-locked 2026-10-21, P1-C2-D2, migration 0011) against a disposable Postgres,
 * through the real launch path, session service, ticket store and property store, with a mutable trusted source standing
 * in for the rehearsal fixture (grants, explicit rules, Proofy rule answers: TEST DATA, never a verified Core answer).
 *
 *   D1  restricted districts: unrestricted fallback rotation; a restricted district only by an explicit rule AND a
 *       positive answer; an all-restricted city playable for qualified players only.
 *   D2  a fixed 900-second claim window: never extended by reloads, relaunches, tabs, NFT switches or cancel/re-entry;
 *       a fresh window after it runs out or after a successful activation.
 *   D3  conflicting explicit rules refused, whatever their order, ids or types; agreeing rules resolve canonically.
 *   D4  a rule-only change supersedes exactly the affected rule tickets; a rotation or geometry change supersedes all.
 */
const CY = player(3, 'Cy')
const DEE = player(4, 'Dee')
const EVE = player(5, 'Eve')
/** Every district restricted, each by its own Proofy rule: lantern-quay 51, tidewater 52, saltmarsh 53, compass-row 54, dune 55. */
const RESTRICTED = { ...DOC, districts: DOC.districts.map((d, i) => ({ ...d, proofyRule: { verificationRuleId: 51 + i, label: `Rule ${51 + i}` } })) }
const TIDE_TO_TIDEWATER: DistrictRuleMatch[] = [{ id: 'tide-to-tidewater', district: 'tidewater' }]
const CAPTAINS: DistrictRuleMatch[] = [{ id: 'captains', district: 'compass-row' }]
const TO_DUNE: DistrictRuleMatch[] = [{ id: 'r1', district: 'dune' }]

describe.skipIf(NO_TEST_DATABASE)('district ticket policies D1 to D4 (migration 0011) against a disposable Postgres', () => {
  const t = useTestSchema()
  const { setup, one, rotation, slotsOf, sequenceOf, frozen, statusOf, leaveOnly } = ticketWorld(t)
  const windowsOf = (worldId: string) => worldClaimWindowsOf(t.db, worldId)
  const causeOf = async (id: string) => (await one<{ status: string; supersede_cause: string | null }>('SELECT status, supersede_cause FROM world_district_tickets WHERE id = $1', [id]))
  /** Every ticket of a world as a holder would see it: whole identity, district, slot, lease and state. */
  const whole = async (worldId: string) =>
    (await worldTicketsOf(t.db, worldId)).map((x) => ({ id: x.id, status: x.status, kind: x.kind, districtKey: x.districtKey, ordinal: x.ordinal, generation: x.generation, epoch: x.epoch, issuedAt: x.issuedAt, expiresAt: x.expiresAt, claimWindow: x.claimWindow }))

  describe('D1: restricted districts', () => {
    it('an all-restricted city: a qualified player selects the NFT, receives a rule ticket bound to everything that authorized it, and places it', async () => {
      const env = await setup({ docs: [RESTRICTED, DOC] })
      const a = await env.open(INSTALLATION_A, ADA)
      const worldId = a.response.world.id
      env.source.rules(tide(1), TIDE_TO_TIDEWATER)
      env.source.answer(GUILD_A, ADA, 52, true)
      // Entry: nothing to assign until the NFT is chosen. Nothing is held, written or opened meanwhile, so nobody waits.
      expect(await env.enter(a, [tide(1)])).toEqual({ ticket: null, fresh: false, awaiting: 'asset' })
      expect(await rotation(worldId)).toMatchObject({ districts: [], high_water: '0' })
      expect(await windowsOf(worldId)).toEqual([])
      // Selecting it, with no ticket: the rule ticket, on the restricted district, authorized by local test data only.
      const assigned = await env.assign(a, null, tide(1), TIDE_TO_TIDEWATER)
      expect(assigned.changed).toBe(true)
      expect(assigned.ticket).toMatchObject({
        kind: 'rule',
        districtKey: 'tidewater',
        worldId,
        installationId: INSTALLATION_A,
        actor: { discordUserId: ADA.discordUserId, coreUserId: ADA.coreUserId },
        asset: 'eip155:1/erc721:0x000000000000000000000000000000000000a002/1',
        ruleRef: 'tide-to-tidewater',
        authorization: { verificationRuleId: 52, source: 'local-fixture' },
        configVersion: 1,
        ordinal: null,
        status: 'active',
      })
      expect(Date.parse(assigned.ticket.expiresAt) - Date.parse(assigned.ticket.issuedAt)).toBe(900_000)
      // Selecting it again (a reload of the panel) changes nothing; the ticket is bound to its district: no other plot.
      expect(await env.assign(a, null, tide(1), TIDE_TO_TIDEWATER)).toMatchObject({ changed: false, ticket: { id: assigned.ticket.id } })
      // Selecting an NFT no rule places: refused, and the rule ticket stays exactly as it was.
      env.source.grant(ADA, [tide(1), keeper(9)])
      expect(await refusalOf(env.tickets.assign(await env.live(a), assigned.ticket.id, keeper(9)))).toBe('no_default_district')
      expect(await statusOf(assigned.ticket.id)).toBe('active')
      expect(await refusalOf(env.activate(a, assigned.ticket, tide(1), 'lantern-quay-w0-p0', TIDE_TO_TIDEWATER))).toBe('plot_outside_assignment')
      const placed = await env.activate(a, assigned.ticket, tide(1), 'tidewater-w0-p0', TIDE_TO_TIDEWATER)
      expect([placed.fresh, placed.property.districtKey, placed.ticketId]).toEqual([true, 'tidewater', assigned.ticket.id])
      expect(await frozen(worldId)).toBe(true)
      expect(await windowsOf(worldId)).toEqual([expect.objectContaining({ closeReason: 'activated', propertyId: placed.property.id })])
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ properties: 1, districtTickets: { committed: 1, active: 0, highWater: 0, windows: 0 } }] })
    })

    it('an all-restricted city: unqualified, unanswered and unruled players may view it but cannot claim; failed evidence always refuses', async () => {
      const env = await setup({ docs: [RESTRICTED, DOC] })
      const [b, c, d, e] = [await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY), await env.open(INSTALLATION_A, DEE), await env.open(INSTALLATION_A, EVE)]
      const worldId = b.response.world.id
      for (const n of [2, 3, 5]) env.source.rules(tide(n), TIDE_TO_TIDEWATER)
      env.source.answer(GUILD_A, BEA, 52, false)
      env.source.answer(GUILD_A, EVE, 52, null)
      // Bea's rule answered false; Cy's has no answer; Eve's answered null (unknown); Dee's NFT has no rule at all.
      expect(await refusalOf(env.enter(b, [tide(2)]))).toBe('district_rule_unqualified')
      expect(await refusalOf(env.enter(c, [tide(3)]))).toBe('district_rule_unverified')
      expect(await refusalOf(env.enter(e, [tide(5)]))).toBe('district_rule_unverified')
      expect(await refusalOf(env.enter(d, [keeper(4)]))).toBe('no_default_district')
      // Selecting the NFT directly is refused the same way: nothing a browser sends makes them eligible.
      expect(await refusalOf(env.assign(b, null, tide(2), TIDE_TO_TIDEWATER))).toBe('district_rule_unqualified')
      expect(await refusalOf(env.assign(c, null, tide(3), TIDE_TO_TIDEWATER))).toBe('district_rule_unverified')
      expect(await refusalOf(env.assign(d, null, keeper(4)))).toBe('no_default_district')
      // An NFT the trusted source does not list for the player is refused whatever its rule says.
      env.source.answer(GUILD_A, BEA, 52, true)
      expect(await refusalOf(env.assign(b, null, tide(9), TIDE_TO_TIDEWATER))).toBe('not_eligible')
      // Nothing was issued or opened; the city is still theirs to view.
      expect((await t.db.query('SELECT 1 FROM world_district_tickets WHERE world_id = $1', [worldId])).rowCount).toBe(0)
      expect(await windowsOf(worldId)).toEqual([])
      for (const o of [b, c, d]) expect((await env.sessions.city(await env.sessions.session(o.token))).world.id).toBe(worldId)
      // Evidence that turns false after issuance: refused at activation, then the ticket is superseded and nothing placed.
      const ruled = (await env.assign(b, null, tide(2), TIDE_TO_TIDEWATER)).ticket
      env.source.answer(GUILD_A, BEA, 52, false)
      expect(await refusalOf(env.activate(b, ruled, tide(2), 'tidewater-w0-p0', TIDE_TO_TIDEWATER))).toBe('district_rule_unqualified')
      env.source.answer(GUILD_A, BEA, 52, null)
      expect(await refusalOf(env.activate(b, ruled, tide(2), 'tidewater-w0-p0', TIDE_TO_TIDEWATER))).toBe('district_rule_unverified')
      expect(await refusalOf(env.enter(b, [tide(2)]))).toBe('district_rule_unverified')
      expect(await causeOf(ruled.id)).toEqual({ status: 'superseded', supersede_cause: 'rules' })
      expect(await sequenceOf(worldId)).toBe(1)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('a mixed city: entry assigns an unrestricted district at once; a qualified player\'s rule ticket reaches the restricted one, an unqualified player\'s cannot', async () => {
      const env = await setup()
      const [a, b] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA)]
      const worldId = a.response.world.id
      env.source.answer(GUILD_A, ADA, 41, true)
      env.source.answer(GUILD_A, BEA, 41, false)
      env.source.rules(keeper(7), CAPTAINS)
      env.source.rules(keeper(8), CAPTAINS)
      // Immediate provisional fallback assignment at entry, even for players whose NFTs have rules.
      const t0 = await env.ticketOf(a, [keeper(1), keeper(7)])
      expect(t0).toMatchObject({ kind: 'fallback', districtKey: 'lantern-quay', ordinal: 0 })
      const tb = await env.ticketOf(b, [keeper(8)])
      expect(tb).toMatchObject({ kind: 'fallback', districtKey: 'tidewater', ordinal: 1 })
      // A fallback ticket never places anything on the restricted district.
      expect(await refusalOf(env.activate(a, t0, keeper(1), 'compass-row-w0-p0'))).toBe('plot_outside_assignment')
      // Ada selects her Captain: a rule ticket for the restricted district, in her window; her fallback slot is freed.
      const rt = (await env.assign(a, t0, keeper(7), CAPTAINS)).ticket
      expect(rt).toMatchObject({ kind: 'rule', districtKey: 'compass-row', authorization: { verificationRuleId: 41, source: 'local-fixture' }, expiresAt: t0.expiresAt })
      expect((await slotsOf(worldId))[0]).toMatchObject({ state: 'free' })
      // Bea selects hers: refused, her fallback ticket stays; nor can her fallback ticket place the Captain anywhere.
      expect(await refusalOf(env.assign(b, tb, keeper(8), CAPTAINS))).toBe('district_rule_unqualified')
      expect(await statusOf(tb.id)).toBe('active')
      expect(await refusalOf(env.activate(b, tb, keeper(8), 'tidewater-w0-p0', CAPTAINS))).toBe('district_rule_unqualified')
      expect(await refusalOf(env.activate(b, tb, keeper(8), 'compass-row-w0-p0', CAPTAINS))).toBe('district_rule_unqualified')
      expect((await env.activate(a, rt, keeper(7), 'compass-row-w0-p0', CAPTAINS)).property.districtKey).toBe('compass-row')
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('Proofy rule answers are per Discord server, and claim windows per world', async () => {
      const env = await setup({ docs: [RESTRICTED, RESTRICTED] })
      const inA = await env.open(INSTALLATION_A, ADA)
      const inB = await env.open(INSTALLATION_B, ADA)
      env.source.answer(GUILD_A, ADA, 52, true)
      env.source.grant(ADA, [tide(1)])
      const ta = (await env.assign(inA, null, tide(1), TIDE_TO_TIDEWATER)).ticket
      // The same rule id and player in another Discord server is another answer: none.
      expect(await refusalOf(env.assign(inB, null, tide(1), TIDE_TO_TIDEWATER))).toBe('district_rule_unverified')
      env.source.answer(GUILD_B, ADA, 52, true)
      await leaveOnly(inA.response.world.id, ADA, 100)
      const tb = (await env.assign(inB, null, tide(1), TIDE_TO_TIDEWATER)).ticket
      // Each world has its own window: the shortened one in A does not shorten B's, and B's ticket cannot act in A.
      expect(Date.parse(tb.expiresAt) - Date.parse(tb.issuedAt)).toBe(900_000)
      expect((await env.tickets.current(await env.live(inA)))?.id).toBe(ta.id)
      expect(Date.parse((await env.tickets.current(await env.live(inA)))!.expiresAt) - Date.now()).toBeLessThan(101_000)
      expect(await refusalOf(env.activate(inA, tb, tide(1), 'tidewater-w0-p0', TIDE_TO_TIDEWATER))).toBe('ticket_not_live')
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })
  })

  describe('D2: a fixed fifteen-minute claim window', () => {
    it('lasts exactly 900 seconds from issuance by this database\'s clock, and expires precisely then', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const worldId = a.response.world.id
      const t0 = await env.ticketOf(a)
      expect(
        await one('SELECT (w.expires_at - w.opened_at) = interval \'900 seconds\' AS exact, t.issued_at = w.opened_at AS issued_on_opening, t.expires_at = w.expires_at AS ends_with_window FROM world_district_tickets t JOIN world_claim_windows w ON w.id = t.claim_window WHERE t.id = $1', [t0.id]),
      ).toEqual({ exact: true, issued_on_opening: true, ends_with_window: true })
      // Half a second left: live. A little later: expired, by the database's clock, and nothing places with it.
      await leaveOnly(worldId, ADA, 0.5)
      expect((await env.tickets.current(await env.live(a)))?.id).toBe(t0.id)
      await sleep(700)
      expect(await env.tickets.current(await env.live(a))).toBeNull()
      expect(await refusalOf(env.activate(a, t0, keeper(1), 'lantern-quay-w0-p0'))).toBe('ticket_expired')
      // A fresh claim after it ran out is a new window and a new, independently issued ticket: no lockout.
      const t1 = await env.ticketOf(a)
      expect(t1.id).not.toBe(t0.id)
      expect(Date.parse(t1.expiresAt) - Date.parse(t1.issuedAt)).toBe(900_000)
      const windows = await windowsOf(worldId)
      expect(windows.map((w) => [w.closeReason, w.openedBy])).toEqual([['lapsed', 'issuance'], [null, 'issuance']])
      expect(t1.claimWindow).toBe(windows[1].id)
      expect(await statusOf(t0.id)).toBe('expired')
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('the database sets the lease: a window asking for another is given 900 seconds; a ticket outliving its window, or a window extended, is refused', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const worldId = a.response.world.id
      const t0 = await env.ticketOf(a)
      const client = await t.db.connect()
      try {
        await client.query('BEGIN')
        const asked = await client.query<{ lease: string }>(
          `INSERT INTO world_claim_windows (id, world_id, actor_discord_user_id, actor_core_user_id, opened_at, expires_at, opened_by) VALUES (gen_random_uuid(), $1, '933333333333333333', 'core-z', now(), now() + interval '1 day', 'issuance') RETURNING (expires_at - opened_at)::text AS lease`,
          [worldId],
        )
        expect(asked.rows[0].lease).toBe('00:15:00')
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
      await expect(t.db.query("UPDATE world_claim_windows SET expires_at = expires_at + interval '1 minute' WHERE world_id = $1", [worldId])).rejects.toThrow(/keeps its holder and its lease/)
      await expect(t.db.query("UPDATE world_claim_windows SET close_reason = 'lapsed' WHERE world_id = $1", [worldId])).rejects.toThrow(/lapses only once it has run out/)
      await expect(t.db.query('DELETE FROM world_claim_windows WHERE world_id = $1', [worldId])).rejects.toThrow(/cannot be removed/)
      // A second ticket in the same window, ending a minute later than it: refused before the one-active index is reached.
      await expect(
        t.db.query(
          `INSERT INTO world_district_tickets (id, world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, actor_discord_user_id, actor_core_user_id, issued_in_play_session, kind, district_key,
                                               district_geometry_fingerprint, epoch, ordinal, generation, config_version, config_hash, layout_geometry_fingerprint, status, issued_at, expires_at, claim_window)
           SELECT gen_random_uuid(), world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, actor_discord_user_id, actor_core_user_id, issued_in_play_session, kind, district_key,
                  district_geometry_fingerprint, epoch, ordinal, generation, config_version, config_hash, layout_geometry_fingerprint, 'active', now(), expires_at + interval '1 minute', claim_window
             FROM world_district_tickets WHERE id = $1`,
          [t0.id],
        ),
      ).rejects.toThrow(/ends exactly when its claim window ends/)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('reloads, relaunches, tabs, NFT switches and cancel/re-entry keep the same window: the claim is never renewed', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const worldId = a.response.world.id
      const mine = [keeper(1), tide(1)]
      const t0 = await env.ticketOf(a, mine)
      const end = t0.expiresAt
      // Reloads and tabs (concurrent entries), a relaunch and another browser: the same ticket, the same end.
      const repeats = await Promise.all(Array.from({ length: 5 }, () => env.enter(a, mine)))
      expect(new Set(repeats.map((r) => `${r.ticket?.id}@${r.ticket?.expiresAt}`))).toEqual(new Set([`${t0.id}@${end}`]))
      const elsewhere = await env.open(INSTALLATION_A, ADA)
      // The relaunch in the same browser replaces its session: the page acts as the new one from here on.
      const relaunched = await env.open(INSTALLATION_A, ADA, a.token)
      for (const o of [relaunched, elsewhere]) expect((await env.enter(o, mine)).ticket).toMatchObject({ id: t0.id, expiresAt: end })
      const p = relaunched
      // NFT switches, there and back: new tickets, the same end.
      const ruled = (await env.assign(p, t0, tide(1), TO_DUNE)).ticket
      const back = (await env.assign(p, ruled, keeper(1))).ticket
      expect([ruled.expiresAt, back.expiresAt]).toEqual([end, end])
      // Cancel and enter again, three times: a new ticket each time, in the same window, with the same end.
      let held = back
      for (let i = 0; i < 3; i++) {
        await env.release(p, held)
        const again = await env.enter(p, mine)
        expect(again).toMatchObject({ fresh: true, ticket: { expiresAt: end } })
        expect(again.ticket!.id).not.toBe(held.id)
        held = again.ticket!
      }
      // Cancel, then several tabs enter at once: one ticket, the same end.
      await env.release(p, held)
      const raced = await Promise.all(Array.from({ length: 6 }, (_, i) => env.enter(i % 2 ? p : elsewhere, mine)))
      expect(raced.filter((r) => r.fresh)).toHaveLength(1)
      expect(new Set(raced.map((r) => `${r.ticket?.id}@${r.ticket?.expiresAt}`)).size).toBe(1)
      expect(raced[0].ticket!.expiresAt).toBe(end)
      // In a city with a default rotation a selection never stands in for entry: no ticketless assignment.
      await env.release(p, raced[0].ticket!)
      expect(await refusalOf(env.assign(p, null, keeper(1)))).toBe('ticket_not_live')
      const windows = await windowsOf(worldId)
      expect(windows).toHaveLength(1)
      expect(windows[0]).toMatchObject({ expiresAt: end, closedAt: null })
      expect((await one<{ n: number }>('SELECT count(DISTINCT claim_window)::int AS n FROM world_district_tickets WHERE world_id = $1', [worldId])).n).toBe(1)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('a successful activation closes the window; the next NFT is a new, independently checked ticket and window, without signing out', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const worldId = a.response.world.id
      const t0 = await env.ticketOf(a, [keeper(1), keeper(2)])
      const placed = await env.activate(a, t0, keeper(1), 'lantern-quay-w0-p0')
      expect((await windowsOf(worldId))[0]).toMatchObject({ closeReason: 'activated', propertyId: placed.property.id })
      await sleep(20)
      const t1 = await env.ticketOf(a, [keeper(1), keeper(2)])
      expect(t1.claimWindow).not.toBe(t0.claimWindow)
      expect(Date.parse(t1.expiresAt)).toBeGreaterThan(Date.parse(t0.expiresAt))
      expect(Date.parse(t1.expiresAt) - Date.parse(t1.issuedAt)).toBe(900_000)
      await env.activate(a, t1, keeper(2), 'tidewater-w0-p0')
      // Checked again each time: with nothing left that the trusted source lists, no third ticket or window.
      expect(await refusalOf(env.enter(a, [keeper(1), keeper(2)]))).toBe('not_eligible')
      expect((await windowsOf(worldId)).map((w) => w.closeReason)).toEqual(['activated', 'activated'])
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ districtTickets: { committed: 2, windows: 0 } }] })
    })
  })

  describe('D3: conflicting explicit rules', () => {
    it('rules naming different districts are refused before any plot, whatever their order, ids or types, and even where the player qualifies for one', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      env.source.answer(GUILD_A, ADA, 41, true)
      const t0 = await env.ticketOf(a, [tide(1)])
      const rules: DistrictRuleMatch[] = [{ id: 'by-collection', district: 'saltmarsh' }, { id: 'by-trait', district: 'dune' }, { id: 'a-role', district: 'saltmarsh' }, { id: 'z-captain', district: 'compass-row' }]
      for (let i = 0; i < rules.length; i++) {
        const order = [...rules.slice(i), ...rules.slice(0, i)]
        expect(await refusalOf(env.assign(a, t0, tide(1), order))).toBe('district_rule_ambiguous')
        expect(await refusalOf(env.assign(a, t0, tide(1), [...order].reverse()))).toBe('district_rule_ambiguous')
        // Nor can a page choose one of the districts for itself by naming a plot there.
        for (const plot of ['saltmarsh-w0-p0', 'dune-w0-p0', 'compass-row-w0-p0', 'lantern-quay-w0-p0']) expect(await refusalOf(env.activate(a, t0, tide(1), plot, order))).toBe('district_rule_ambiguous')
      }
      // In a city of restricted districts too, where the player qualifies for both: refused, at entry and at selection.
      const env2 = await setup({ migrated: true, play: env.p, source: env.source })
      env2.p.publish(INSTALLATION_B, RESTRICTED)
      const b = await env2.open(INSTALLATION_B, ADA)
      env.source.answer(GUILD_B, ADA, 52, true)
      env.source.answer(GUILD_B, ADA, 55, true)
      const both: DistrictRuleMatch[] = [{ id: 'x', district: 'tidewater' }, { id: 'y', district: 'dune' }]
      env.source.rules(tide(1), both)
      expect(await refusalOf(env2.enter(b, [tide(1)]))).toBe('district_rule_ambiguous')
      expect(await refusalOf(env2.assign(b, null, tide(1), both))).toBe('district_rule_ambiguous')
      expect(await statusOf(t0.id)).toBe('active')
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('rules naming the same district agree: canonical, deduplicated provenance, whatever their order', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const t0 = await env.ticketOf(a, [tide(1)])
      const agreeing: DistrictRuleMatch[] = [{ id: 'b', district: 'dune' }, { id: 'a', district: 'dune' }, { id: 'a', district: 'dune' }, { id: 'elsewhere', district: 'orchard' }]
      const first = (await env.assign(a, t0, tide(1), agreeing)).ticket
      expect(first).toMatchObject({ kind: 'rule', districtKey: 'dune', ruleRef: 'a,b' })
      for (const order of [[...agreeing].reverse(), [agreeing[2], agreeing[0], agreeing[3], agreeing[1]]]) expect(await env.assign(a, first, tide(1), order)).toMatchObject({ changed: false, ticket: { id: first.id, ruleRef: 'a,b' } })
      expect((await env.activate(a, first, tide(1), 'dune-w0-p0', agreeing)).property.districtKey).toBe('dune')
    })
  })

  describe('D4: selective invalidation', () => {
    it('an unrelated rule change, a presentation-only version and another district\'s Proofy rule change keep every ticket whole', async () => {
      const env = await setup()
      const [a, b, c, d] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY), await env.open(INSTALLATION_A, DEE)]
      const worldId = a.response.world.id
      await env.assign(a, await env.ticketOf(a, [tide(1)]), tide(1), TO_DUNE)
      await env.ticketOf(b, [keeper(2)])
      env.source.answer(GUILD_A, CY, 41, true)
      await env.assign(c, await env.ticketOf(c, [keeper(3)]), keeper(3), CAPTAINS)
      const before = await whole(worldId)
      expect(before.filter((x) => x.status === 'active').map((x) => [x.kind, x.districtKey])).toEqual([['rule', 'dune'], ['fallback', 'lantern-quay'], ['rule', 'compass-row']])
      // Rules for other NFTs, answers to other rules, and a rule for Ada's NFT naming a district this city does not have.
      env.source.rules(keeper(99), [{ id: 'new', district: 'saltmarsh' }])
      env.source.rules(tide(1), [...TO_DUNE, { id: 'other-city', district: 'orchard' }])
      env.source.answer(GUILD_A, CY, 99, false)
      env.source.answer(GUILD_A, ADA, 41, false)
      await env.ticketOf(d, [keeper(4)])
      const after = await whole(worldId)
      expect(after.slice(0, before.length)).toEqual(before)
      // A presentation-only version, then a version that changes only another district's Proofy rule... none on Cy's.
      env.p.publish(INSTALLATION_A, { ...DOC, cityName: 'Harborlight Renamed' })
      await env.open(INSTALLATION_A, EVE)
      expect((await whole(worldId)).slice(0, before.length)).toEqual(before)
      expect(await rotation(worldId)).toMatchObject({ epoch: 1, basis_config_version: 2 })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('a change affecting eligibility supersedes exactly the affected rule tickets, transactionally; they never commit, and holders keep their window', async () => {
      const env = await setup()
      const [a, b, c, d, e] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY), await env.open(INSTALLATION_A, DEE), await env.open(INSTALLATION_A, EVE)]
      const worldId = a.response.world.id
      const ta = (await env.assign(a, await env.ticketOf(a, [tide(1), keeper(1)]), tide(1), TO_DUNE)).ticket
      const tb = (await env.assign(b, await env.ticketOf(b, [tide(2)]), tide(2), TO_DUNE)).ticket
      const tc = await env.ticketOf(c, [keeper(3)])
      env.source.answer(GUILD_A, DEE, 41, true)
      const td = (await env.assign(d, await env.ticketOf(d, [keeper(4)]), keeper(4), CAPTAINS)).ticket
      const te = (await env.assign(e, await env.ticketOf(e, [tide(5)]), tide(5), TO_DUNE)).ticket
      // Ada's NFT now goes elsewhere; Dee's answer is withdrawn; Bea no longer holds hers; Eve's gains an agreeing rule.
      env.source.rules(tide(1), [{ id: 'r9', district: 'saltmarsh' }])
      env.source.answer(GUILD_A, DEE, 41, null)
      env.source.grant(BEA, [])
      env.source.rules(tide(5), [...TO_DUNE, { id: 'r2', district: 'dune' }])
      // Any ticket transaction in the world supersedes exactly those (here Cy's re-entry, which changes nothing of Cy's).
      expect(await env.enter(c, [keeper(3)])).toMatchObject({ fresh: false, ticket: { id: tc.id } })
      for (const x of [ta, tb, td, te]) expect(await causeOf(x.id)).toEqual({ status: 'superseded', supersede_cause: 'rules' })
      expect(await statusOf(tc.id)).toBe('active')
      expect(await one('SELECT end_reason FROM world_district_tickets WHERE id = $1', [ta.id])).toEqual({ end_reason: 'rotation_changed' })
      // A superseded ticket never commits, on any plot.
      expect(await refusalOf(env.activate(a, ta, tide(1), 'dune-w0-p0', TO_DUNE))).toBe('ticket_superseded')
      expect(await refusalOf(env.activate(a, ta, tide(1), 'saltmarsh-w0-p0', [{ id: 'r9', district: 'saltmarsh' }]))).toBe('ticket_superseded')
      // Holders are assigned again only by a fresh, fully checked request, in the window they had.
      const again = (await env.assign(a, await env.ticketOf(a, [tide(1), keeper(1)]), tide(1), [{ id: 'r9', district: 'saltmarsh' }])).ticket
      expect(again).toMatchObject({ kind: 'rule', districtKey: 'saltmarsh', ruleRef: 'r9', expiresAt: ta.expiresAt })
      expect(await refusalOf(env.assign(d, await env.ticketOf(d, [keeper(4)]), keeper(4), CAPTAINS))).toBe('district_rule_unverified')
      // (Straight to the store: the harness's entry would grant Bea her NFT again.)
      expect(await refusalOf(env.tickets.enter(await env.live(b)))).toBe('not_eligible')
      expect((await env.assign(e, await env.ticketOf(e, [tide(5)]), tide(5), [...TO_DUNE, { id: 'r2', district: 'dune' }])).ticket).toMatchObject({ ruleRef: 'r1,r2', expiresAt: te.expiresAt })
      expect(await sequenceOf(worldId)).toBe(1)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('a version changing a restricted district\'s Proofy rule supersedes exactly the rule tickets on it, in the adoption\'s own transaction', async () => {
      const env = await setup()
      const [a, b, c] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY)]
      const worldId = a.response.world.id
      env.source.answer(GUILD_A, ADA, 41, true)
      env.source.answer(GUILD_A, ADA, 47, true)
      const captain = (await env.assign(a, await env.ticketOf(a, [keeper(7)]), keeper(7), CAPTAINS)).ticket
      const dune = (await env.assign(b, await env.ticketOf(b, [tide(2)]), tide(2), TO_DUNE)).ticket
      const fallback = await env.ticketOf(c, [keeper(3)])
      const keep = (await whole(worldId)).filter((x) => x.id !== captain.id)
      env.p.publish(INSTALLATION_A, { ...DOC, districts: DOC.districts.map((x) => (x.key === 'compass-row' ? { ...x, proofyRule: { verificationRuleId: 47, label: 'Harbor Master role' } } : x)) })
      // The launch that adopts it: no ticket transaction runs, and the rule ticket on compass-row is already superseded.
      await env.open(INSTALLATION_A, DEE)
      expect(await rotation(worldId)).toMatchObject({ epoch: 1, basis_config_version: 2 })
      expect(await causeOf(captain.id)).toEqual({ status: 'superseded', supersede_cause: 'rules' })
      expect((await whole(worldId)).filter((x) => x.id !== captain.id).slice(0, keep.length)).toEqual(keep)
      expect([await statusOf(dune.id), await statusOf(fallback.id)]).toEqual(['active', 'active'])
      expect(await refusalOf(env.activate(a, captain, keeper(7), 'compass-row-w0-p0', CAPTAINS))).toBe('ticket_superseded')
      // Ada qualifies for the new rule too: a fresh request, in her window, records the new rule.
      expect(await refusalOf(env.assign(a, null, keeper(7), CAPTAINS))).toBe('ticket_not_live')
      const renewed = (await env.assign(a, await env.ticketOf(a, [keeper(7)]), keeper(7), CAPTAINS)).ticket
      expect(renewed).toMatchObject({ districtKey: 'compass-row', authorization: { verificationRuleId: 47 }, expiresAt: captain.expiresAt })
      expect((await env.activate(a, renewed, keeper(7), 'compass-row-w0-p0', CAPTAINS)).fresh).toBe(true)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('a rotation change after the freeze supersedes every pending ticket, reissues the fallback ones in order in their windows, and leaves properties exactly as they were', async () => {
      const env = await setup()
      const [a, b, c, d] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY), await env.open(INSTALLATION_A, DEE)]
      const worldId = a.response.world.id
      await env.activate(a, await env.ticketOf(a, [keeper(1)]), keeper(1), 'lantern-quay-w0-p0')
      const tb = await env.ticketOf(b, [keeper(2)])
      const tc = await env.ticketOf(c, [keeper(3)])
      const td = (await env.assign(d, await env.ticketOf(d, [tide(4)]), tide(4), TO_DUNE)).ticket
      const properties = (await t.db.query('SELECT * FROM world_properties WHERE world_id = $1 ORDER BY id', [worldId])).rows
      const events = (await t.db.query('SELECT * FROM city_events ORDER BY city_id, sequence')).rows
      // Saltmarsh becomes restricted: the same geometry (the freeze allows it), another default rotation.
      env.p.publish(INSTALLATION_A, { ...DOC, districts: DOC.districts.map((x) => (x.key === 'saltmarsh' ? { ...x, proofyRule: { verificationRuleId: 48, label: 'Salt role' } } : x)) })
      await env.open(INSTALLATION_A, EVE)
      expect(await rotation(worldId)).toMatchObject({ epoch: 2, districts: ['lantern-quay', 'tidewater', 'dune'] })
      for (const x of [tb, tc, td]) expect(await causeOf(x.id)).toEqual({ status: 'superseded', supersede_cause: 'rotation' })
      const [nb, nc] = [(await env.tickets.current(await env.live(b)))!, (await env.tickets.current(await env.live(c)))!]
      expect([nb.reissuedFrom, nb.ordinal, nb.districtKey, nb.expiresAt, nb.claimWindow, nc.reissuedFrom, nc.ordinal, nc.expiresAt]).toEqual([tb.id, 4, 'lantern-quay', tb.expiresAt, tb.claimWindow, tc.id, 5, tc.expiresAt])
      expect(await env.tickets.current(await env.live(d))).toBeNull()
      // Old tickets and old generations never commit; the reissued ones do, and nothing placed before moved.
      expect(await refusalOf(env.activate(b, tb, keeper(2), 'tidewater-w0-p0'))).toBe('ticket_superseded')
      expect(await refusalOf(env.activate(d, td, tide(4), 'dune-w0-p0', TO_DUNE))).toBe('ticket_superseded')
      expect((await t.db.query('SELECT * FROM world_properties WHERE world_id = $1 ORDER BY id', [worldId])).rows).toEqual(properties)
      expect((await t.db.query('SELECT * FROM city_events ORDER BY city_id, sequence')).rows).toEqual(events)
      expect((await env.activate(b, nb, keeper(2), 'lantern-quay-w0-p1')).fresh).toBe(true)
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ districtTickets: { epoch: 2, windows: 2 } }] })
    })
  })

  describe('activation judges the rules again, before any sweep', () => {
    it('a rule ticket whose NFT gained or lost a rule id, or whose district\'s answer changed, never commits, even if no ticket transaction ran since', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const worldId = a.response.world.id
      const ruled = (await env.assign(a, await env.ticketOf(a, [tide(1)]), tide(1), TO_DUNE)).ticket
      // The trusted source now names one more agreeing rule: the same district, other provenance. Nothing else ran.
      expect(await refusalOf(env.activate(a, ruled, tide(1), 'dune-w0-p0', [...TO_DUNE, { id: 'r2', district: 'dune' }]))).toBe('ticket_superseded')
      expect(await refusalOf(env.activate(a, ruled, tide(1), 'dune-w0-p0', []))).toBe('ticket_superseded')
      expect(await statusOf(ruled.id)).toBe('active')
      expect(await sequenceOf(worldId)).toBe(1)
      // With exactly the rules it was issued on, it places.
      expect((await env.activate(a, ruled, tide(1), 'dune-w0-p0', TO_DUNE)).fresh).toBe(true)
    })

    it('the database accepts a restricted district\'s authorization only from local test data, and only as its configuration names the rule', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const t0 = await env.ticketOf(a, [keeper(7)])
      const forge = (gate: string, source: string) =>
        t.db.query(
          `INSERT INTO world_district_tickets (id, world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, actor_discord_user_id, actor_core_user_id, issued_in_play_session, kind, district_key,
                                               district_geometry_fingerprint, epoch, asset, rule_ref, config_version, config_hash, layout_geometry_fingerprint, status, issued_at, expires_at, claim_window, gate_rule_id, authorization_source)
           SELECT gen_random_uuid(), world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, actor_discord_user_id, actor_core_user_id, issued_in_play_session, 'rule', 'compass-row',
                  (SELECT g.v ->> 'geometryFingerprint' FROM world_config_geometries c, jsonb_array_elements(c.districts) g(v) WHERE c.world_id = t.world_id AND c.version = 1 AND g.v ->> 'key' = 'compass-row'),
                  epoch, 'eip155:8453/erc721:0x000000000000000000000000000000000000a001/7', 'captains', config_version, config_hash, layout_geometry_fingerprint, 'active', now(), expires_at, claim_window, ${gate}, ${source}
             FROM world_district_tickets t WHERE id = $1`,
          [t0.id],
        )
      await expect(forge('41', "'proofy-core'")).rejects.toThrow(/only by local test data \(local-fixture\)/)
      await expect(forge('NULL', 'NULL')).rejects.toThrow(/records its district's Proofy rule exactly as its configuration names it/)
      await expect(forge('47', "'local-fixture'")).rejects.toThrow(/records its district's Proofy rule exactly as its configuration names it/)
      expect(await statusOf(t0.id)).toBe('active')
    })
  })

  describe('races', () => {
    it('a rule change seen by many concurrent entrants supersedes the affected ticket exactly once; slots stay distinct and fair', async () => {
      const env = await setup()
      const a = await env.open(INSTALLATION_A, ADA)
      const worldId = a.response.world.id
      const ta = (await env.assign(a, await env.ticketOf(a, [tide(1)]), tide(1), TO_DUNE)).ticket
      env.source.rules(tide(1), [{ id: 'moved', district: 'saltmarsh' }])
      const players = Array.from({ length: 12 }, (_, i) => player(300 + i))
      const opened = await Promise.all(players.map((who) => env.open(INSTALLATION_A, who)))
      const entered = await Promise.all(opened.map((o, i) => env.ticketOf(o, [keeper(300 + i)])))
      expect(await causeOf(ta.id)).toEqual({ status: 'superseded', supersede_cause: 'rules' })
      expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM world_district_tickets WHERE world_id = $1 AND status = 'superseded'", [worldId])).n).toBe(1)
      // Ada's freed fallback slot 0 (released when she took the rule ticket) went to exactly one entrant, first.
      const ordinals = entered.map((x) => `${x.ordinal}/${x.generation}`)
      expect(new Set(ordinals).size).toBe(12)
      expect(entered.filter((x) => x.ordinal === 0)).toEqual([expect.objectContaining({ generation: 2 })])
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })

    it('an adoption changing the Proofy rule of a district races an activation on it: whichever holds the city first wins whole', async () => {
      let resume!: () => void
      let reached!: () => void
      const atTicket = new Promise<void>((r) => (reached = r))
      const gate = new Promise<void>((r) => (resume = r))
      let pause = true
      const env = await setup({ onStep: async (step) => { if (step === 'ticket' && pause) { pause = false; reached(); await gate } } })
      const [a, b, d] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, DEE)]
      const worldId = a.response.world.id
      // A first property, so the geometry is frozen and Play's active version is not asked (that check would refuse it, rightly).
      pause = false
      await env.activate(d, await env.ticketOf(d, [keeper(4)]), keeper(4), 'lantern-quay-w0-p0')
      pause = true
      env.source.answer(GUILD_A, ADA, 41, true)
      env.source.answer(GUILD_A, BEA, 41, true)
      const ta = (await env.assign(a, await env.ticketOf(a, [keeper(7)]), keeper(7), CAPTAINS)).ticket
      const tb = (await env.assign(b, await env.ticketOf(b, [keeper(8)]), keeper(8), CAPTAINS)).ticket
      // Ada's activation holds the city; the launch adopting the new rule waits for it, then supersedes only Bea's ticket.
      const placing = env.activate(a, ta, keeper(7), 'compass-row-w0-p0', CAPTAINS)
      await atTicket
      env.p.publish(INSTALLATION_A, { ...DOC, districts: DOC.districts.map((x) => (x.key === 'compass-row' ? { ...x, proofyRule: { verificationRuleId: 47, label: 'Harbor Master role' } } : x)) })
      const adopting = env.open(INSTALLATION_A, CY)
      await sleep(150)
      resume()
      expect((await placing).fresh).toBe(true)
      await adopting
      expect([await statusOf(ta.id), await causeOf(tb.id)]).toEqual(['committed', { status: 'superseded', supersede_cause: 'rules' }])
      expect(await refusalOf(env.activate(b, tb, keeper(8), 'compass-row-w0-p1', CAPTAINS))).toBe('ticket_superseded')
      expect(await rotation(worldId)).toMatchObject({ basis_config_version: 2, committed_count: '2' })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
    })
  })

  describe('migration 0011', () => {
    async function through(last: number, extra = ''): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'rc-policy-'))
      for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort())
        if (Number(file.slice(0, 4)) <= last) await copyFile(join(MIGRATIONS_DIR, file), join(dir, file))
      if (extra) await writeFile(join(dir, '0011_district_ticket_policy.sql'), `${await readFile(join(MIGRATIONS_DIR, '0011_district_ticket_policy.sql'), 'utf8')}\n${extra}\n`)
      return dir
    }

    it('applies onto a 0010 database holding an active ticket without changing a row; its holder\'s window is exactly its lease, so cancelling never renews it', async () => {
      const dir = await through(10)
      try {
        await migrate(t.db, { dir, environment: 'local' })
        const env = await setup({ migrated: true })
        const a = await env.open(INSTALLATION_A, ADA)
        const worldId = a.response.world.id
        // A ticket issued the 0010 way (its own seven-minute lease), written as 0010's store wrote it.
        const r = (await t.db.query<{ version: number; config_hash: string; layout_geometry_fingerprint: string; districts: { key: string; geometryFingerprint: string }[] }>(
          'SELECT g.version, v.config_hash, g.layout_geometry_fingerprint, g.districts FROM world_config_geometries g JOIN world_config_versions v USING (world_id, version) WHERE g.world_id = $1', [worldId])).rows[0]
        const lq = r.districts.find((x) => x.key === 'lantern-quay')!.geometryFingerprint
        const client = await t.db.connect()
        try {
          await client.query('BEGIN')
          await client.query(`INSERT INTO world_assignment_rotations (world_id, epoch, epoch_start_ordinal, high_water, committed_count, basis_config_version, basis_config_hash, layout_geometry_fingerprint, districts) VALUES ($1, 1, 0, 0, 0, $2, $3, $4, '["lantern-quay","tidewater","saltmarsh","dune"]'::jsonb)`, [worldId, r.version, r.config_hash, r.layout_geometry_fingerprint])
          await client.query('UPDATE world_assignment_rotations SET high_water = 1 WHERE world_id = $1', [worldId])
          await client.query(`INSERT INTO world_assignment_slots (world_id, ordinal, epoch, district_key, generation, state) VALUES ($1, 0, 1, 'lantern-quay', 1, 'held')`, [worldId])
          await client.query(
            `INSERT INTO world_district_tickets (id, world_id, play_environment, play_game_key, play_installation_id, discord_guild_id, actor_discord_user_id, actor_core_user_id, issued_in_play_session, kind, district_key, district_geometry_fingerprint, epoch, ordinal, generation, config_version, config_hash, layout_geometry_fingerprint, status, issued_at, expires_at)
             SELECT gen_random_uuid(), $1, 'dev', 'rare-city', $2, $3, $4, $5, $6, 'fallback', 'lantern-quay', $7, 1, 0, 1, $8, $9, $10, 'active', clock_timestamp(), clock_timestamp() + interval '7 minutes'`,
            [worldId, INSTALLATION_A, GUILD_A, ADA.discordUserId, ADA.coreUserId, a.response.viewer.session.ref, lq, r.version, r.config_hash, r.layout_geometry_fingerprint],
          )
          await client.query('COMMIT')
        } finally {
          client.release()
        }
        const legacy = (await t.db.query<{ id: string; issued_at: Date; expires_at: Date }>('SELECT id, issued_at, expires_at FROM world_district_tickets WHERE world_id = $1', [worldId])).rows[0]
        const COLUMNS = 'id, status, issued_at, expires_at, ended_at, end_reason, ordinal, generation, district_key, epoch'
        const before = (await t.db.query(`SELECT ${COLUMNS} FROM world_district_tickets ORDER BY id`)).rows
        const slots = await slotsOf(worldId)
        expect(await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).toEqual({ applied: [11, 12, 13], current: 13 })
        expect((await t.db.query(`SELECT ${COLUMNS} FROM world_district_tickets ORDER BY id`)).rows).toEqual(before)
        expect(await slotsOf(worldId)).toEqual(slots)
        expect(await one('SELECT claim_window, gate_rule_id, authorization_source, supersede_cause FROM world_district_tickets WHERE id = $1', [legacy.id])).toEqual({ claim_window: null, gate_rule_id: null, authorization_source: null, supersede_cause: null })
        const [w] = await windowsOf(worldId)
        expect(w).toMatchObject({ openedBy: 'migration-0011', openedAt: legacy.issued_at.toISOString(), expiresAt: legacy.expires_at.toISOString(), closedAt: null })
        expect(await verifyCity(t.db)).toMatchObject({ ok: true })
        // The legacy holder enters: the same ticket. Cancels and enters again: a new ticket that ends when the legacy one did.
        expect((await env.ticketOf(a)).id).toBe(legacy.id)
        await env.release(a, { id: legacy.id })
        const again = await env.ticketOf(a)
        expect([again.id === legacy.id, again.expiresAt, again.claimWindow]).toEqual([false, legacy.expires_at.toISOString(), w.id])
        expect((await env.activate(a, again, keeper(1), 'lantern-quay-w0-p0')).fresh).toBe(true)
        expect(await verifyCity(t.db)).toMatchObject({ ok: true })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('a failure inside it leaves nothing behind: 0010\'s guards and tables as they were; it applies cleanly afterwards, its guards pinned', async () => {
      const dir = await through(11, 'SELECT 1 / 0;')
      try {
        await expect(migrate(t.db, { dir, environment: 'local' })).rejects.toThrow(/division by zero/)
        expect((await t.db.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0].v).toBe(10)
        expect(await t.tables()).not.toContain('world_claim_windows')
        expect((await t.db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'world_district_tickets' AND column_name = 'claim_window'", [t.schema])).rowCount).toBe(0)
        expect((await one<{ src: string }>("SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = 'world_district_tickets_guard'", [t.schema])).src).not.toMatch(/claim window/)
        expect(await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'local' })).toEqual({ applied: [11, 12, 13], current: 13 })
        const pinned = (await t.db.query<{ proname: string; proconfig: string[] | null }>(
          "SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname IN ('world_config_district_rule', 'world_claim_windows_guard', 'world_claim_window_opened_by_ticket', 'world_district_tickets_guard', 'world_district_ticket_ended_whole') ORDER BY p.proname", [t.schema])).rows
        expect(pinned.map((p) => p.proname)).toEqual(['world_claim_window_opened_by_ticket', 'world_claim_windows_guard', 'world_config_district_rule', 'world_district_ticket_ended_whole', 'world_district_tickets_guard'])
        for (const p of pinned) expect(p.proconfig, p.proname).toEqual([`search_path=${t.schema}, pg_temp`])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('holds claim windows only in a local database', async () => {
      await migrate(t.db, { dir: MIGRATIONS_DIR, environment: 'staging' })
      await expect(
        t.db.query(`INSERT INTO world_claim_windows (id, world_id, actor_discord_user_id, actor_core_user_id, opened_at, expires_at, opened_by) VALUES (gen_random_uuid(), gen_random_uuid(), '911111111111111111', 'core-x', now(), now(), 'issuance')`),
      ).rejects.toThrow(/only a local database may hold one/)
    })
  })

  describe('defense in depth', () => {
    it('city:verify reports a window or ticket the guards never let exist', async () => {
      const env = await setup()
      const [a, b] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA)]
      const worldId = a.response.world.id
      await env.ticketOf(a)
      const rb = (await env.assign(b, await env.ticketOf(b, [tide(2)]), tide(2), TO_DUNE)).ticket
      const unguarded = async (sql: string, params: unknown[]) => {
        const client = await t.db.connect()
        try {
          await client.query('BEGIN')
          await client.query(`SET LOCAL session_replication_role = 'replica'`)
          await client.query(sql, params)
          await client.query('COMMIT')
        } finally {
          client.release()
        }
      }
      expect(await verifyCity(t.db)).toMatchObject({ ok: true })
      // A window stretched past 900 seconds (its tickets with it), and a rule ticket recording another Proofy rule.
      await unguarded("UPDATE world_claim_windows SET expires_at = expires_at + interval '10 minutes' WHERE world_id = $1 AND actor_discord_user_id = $2", [worldId, ADA.discordUserId])
      await unguarded("UPDATE world_district_tickets SET gate_rule_id = 41, authorization_source = 'proofy-core' WHERE id = $1", [rb.id])
      const report = await verifyCity(t.db)
      expect(report.ok).toBe(false)
      const details = (report as { violations: { rule: string; detail: string }[] }).violations.map((v) => `${v.rule}: ${v.detail}`)
      expect(details).toEqual(expect.arrayContaining([expect.stringMatching(/^windows: .*does not last exactly 900 seconds/), expect.stringMatching(/^windows: .*ending at another time/), expect.stringMatching(/^rules: .*records Proofy rule 41/), expect.stringMatching(/^rules: .*not local test data/)]))
      // And the activation path refuses the forged rule ticket, typed.
      expect(await refusalOf(env.activate(b, rb, tide(2), 'dune-w0-p0', TO_DUNE))).toBe('ticket_superseded')
    })
  })

  describe('city:verify judges a withdrawn rule ticket by the epoch it was withdrawn in', () => {
    const HARBOR_MASTER = { ...DOC, districts: DOC.districts.map((x) => (x.key === 'compass-row' ? { ...x, proofyRule: { verificationRuleId: 47, label: 'Harbor Master role' } } : x)) }
    const SALT = { ...HARBOR_MASTER, districts: HARBOR_MASTER.districts.map((x) => (x.key === 'saltmarsh' ? { ...x, proofyRule: { verificationRuleId: 48, label: 'Salt role' } } : x)) }
    /** Past the guards (replica role), in this disposable schema: a forgery city:verify alone must catch. */
    const unguarded = async (sql: string, params: unknown[]) => {
      const client = await t.db.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SET LOCAL session_replication_role = 'replica'`)
        await client.query(sql, params)
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    }
    const violations = async () => {
      const report = await verifyCity(t.db)
      return report.ok ? [] : (report as { violations: { rule: string; detail: string }[] }).violations.map((v) => `${v.rule}: ${v.detail}`)
    }

    /**
     * Real transitions only: in epoch 1 Bea places a property and a rule change (D4) withdraws Ada's rule ticket; then two
     * rotation changes (saltmarsh restricted, then unrestricted again) move the rotation to epochs 2 and 3, superseding and
     * reissuing Cy's fallback ticket each time; in epoch 3 Dee's rule ticket is withdrawn when her answer is.
     */
    async function history() {
      const env = await setup()
      const [a, b, c, d] = [await env.open(INSTALLATION_A, ADA), await env.open(INSTALLATION_A, BEA), await env.open(INSTALLATION_A, CY), await env.open(INSTALLATION_A, DEE)]
      const worldId = a.response.world.id
      await env.activate(b, await env.ticketOf(b, [keeper(2)]), keeper(2), 'lantern-quay-w0-p0')
      env.source.answer(GUILD_A, ADA, 41, true)
      const captain = (await env.assign(a, await env.ticketOf(a, [keeper(7)]), keeper(7), CAPTAINS)).ticket
      const fallback = await env.ticketOf(c, [keeper(3)])
      env.p.publish(INSTALLATION_A, HARBOR_MASTER)
      await env.open(INSTALLATION_A, EVE)
      expect(await rotation(worldId)).toMatchObject({ epoch: 1, basis_config_version: 2 })
      expect(await causeOf(captain.id)).toEqual({ status: 'superseded', supersede_cause: 'rules' })
      expect(await violations()).toEqual([])
      env.p.publish(INSTALLATION_A, SALT)
      await env.open(INSTALLATION_A, EVE)
      expect(await rotation(worldId)).toMatchObject({ epoch: 2, basis_config_version: 3 })
      expect(await causeOf(fallback.id)).toEqual({ status: 'superseded', supersede_cause: 'rotation' })
      return { captain, fallback, worldId, env, c, d }
    }

    it('a rule ticket withdrawn in an earlier epoch verifies after one rotation change, and after another', async () => {
      const { captain, worldId, env, c, d } = await history()
      // A: withdrawn in epoch 1, verified in epoch 2.
      expect(await one('SELECT epoch, status, supersede_cause, kind FROM world_district_tickets WHERE id = $1', [captain.id])).toEqual({ epoch: 1, status: 'superseded', supersede_cause: 'rules', kind: 'rule' })
      expect(await violations()).toEqual([])
      // B: another rotation change, to epoch 3; Cy's reissued ticket is reissued again, and Dee's rule ticket is withdrawn in epoch 3.
      env.p.publish(INSTALLATION_A, HARBOR_MASTER)
      await env.open(INSTALLATION_A, EVE)
      expect(await rotation(worldId)).toMatchObject({ epoch: 3, basis_config_version: 4 })
      expect(await env.tickets.current(await env.live(c))).toMatchObject({ epoch: 3, kind: 'fallback', status: 'active' })
      env.source.answer(GUILD_A, DEE, 47, true)
      const dee = (await env.assign(d, await env.ticketOf(d, [keeper(4)]), keeper(4), CAPTAINS)).ticket
      env.source.answer(GUILD_A, DEE, 47, null)
      await env.enter(c, [keeper(3)])
      expect(await causeOf(dee.id)).toEqual({ status: 'superseded', supersede_cause: 'rules' })
      expect(await one('SELECT epoch FROM world_district_tickets WHERE id = $1', [captain.id])).toEqual({ epoch: 1 })
      expect(await verifyCity(t.db)).toMatchObject({ ok: true, worlds: [{ properties: 1, districtTickets: { epoch: 3, committed: 1 } }] })
    })

    it('a forged future epoch, an active ticket of another epoch and the historical tampering already caught are each reported, exactly', async () => {
      const { captain, fallback, worldId, env, c, d } = await history()
      env.p.publish(INSTALLATION_A, HARBOR_MASTER)
      await env.open(INSTALLATION_A, EVE)
      env.source.answer(GUILD_A, DEE, 47, true)
      const dee = (await env.assign(d, await env.ticketOf(d, [keeper(4)]), keeper(4), CAPTAINS)).ticket
      env.source.answer(GUILD_A, DEE, 47, null)
      await env.enter(c, [keeper(3)])
      const live = (await env.tickets.current(await env.live(c)))!
      expect([await rotation(worldId), await causeOf(dee.id), live.epoch]).toEqual([expect.objectContaining({ epoch: 3 }), { status: 'superseded', supersede_cause: 'rules' }, 3])
      expect(await violations()).toEqual([])
      const ticket = (id: string) => `world ${worldId} ticket ${id}`
      /** One forgery at a time, past the guards: city:verify reports exactly `expected`, then the row is put back and it verifies again. */
      const forged = async (sql: string, params: unknown[], undo: string, expected: string[]) => {
        await unguarded(sql, params)
        expect(await violations()).toEqual(expected)
        await unguarded(undo, params)
        expect(await violations()).toEqual([])
      }
      const withdrawn = (id: string) => `rules: ${ticket(id)} was superseded by a rule change, but is not a rule ticket of an epoch its rotation has reached`
      const future = (id: string) => `tickets: ${ticket(id)} names epoch 4; its rotation has reached only epoch 3`
      // C: a withdrawn rule ticket, or any ended one, claiming an epoch the rotation has not reached.
      await forged('UPDATE world_district_tickets SET epoch = 4 WHERE id = $1', [captain.id], 'UPDATE world_district_tickets SET epoch = 1 WHERE id = $1', [future(captain.id), withdrawn(captain.id)])
      await forged('UPDATE world_district_tickets SET epoch = 4 WHERE id = $1', [dee.id], 'UPDATE world_district_tickets SET epoch = 3 WHERE id = $1', [future(dee.id), withdrawn(dee.id)])
      for (const status of ['committed', 'released']) {
        const { id, epoch } = await one<{ id: string; epoch: number }>('SELECT id, epoch FROM world_district_tickets WHERE world_id = $1 AND status = $2 ORDER BY issued_at LIMIT 1', [worldId, status])
        await forged('UPDATE world_district_tickets SET epoch = 4 WHERE id = $1', [id], `UPDATE world_district_tickets SET epoch = ${epoch} WHERE id = $1`, [future(id)])
      }
      // D: an active ticket of an earlier epoch, or of one the rotation has not reached.
      for (const epoch of [2, 1, 4])
        await forged(`UPDATE world_district_tickets SET epoch = ${epoch} WHERE id = $1`, [live.id], 'UPDATE world_district_tickets SET epoch = 3 WHERE id = $1', [`tickets: ${ticket(live.id)} is active in epoch ${epoch}; the rotation is in epoch 3`])
      // E: what was already caught still is. A fallback ticket "withdrawn by a rule change"; a ticket superseded by a rotation
      // change its rotation has not left (the current epoch, or a future one); a superseded ticket that does not say why.
      await forged("UPDATE world_district_tickets SET supersede_cause = 'rules' WHERE id = $1", [fallback.id], "UPDATE world_district_tickets SET supersede_cause = 'rotation' WHERE id = $1", [withdrawn(fallback.id)])
      await forged("UPDATE world_district_tickets SET supersede_cause = 'rotation' WHERE id = $1", [dee.id], "UPDATE world_district_tickets SET supersede_cause = 'rules' WHERE id = $1", [
        `rules: ${ticket(dee.id)} was superseded by a rotation change, but its rotation is still in its epoch`,
      ])
      await forged('UPDATE world_district_tickets SET epoch = 4 WHERE id = $1', [fallback.id], 'UPDATE world_district_tickets SET epoch = 1 WHERE id = $1', [
        future(fallback.id),
        `rules: ${ticket(fallback.id)} was superseded by a rotation change, but its rotation is still in its epoch`,
      ])
      await forged('UPDATE world_district_tickets SET supersede_cause = NULL WHERE id = $1', [captain.id], "UPDATE world_district_tickets SET supersede_cause = 'rules' WHERE id = $1", [`rules: ${ticket(captain.id)} was superseded without saying why`])
      // An epoch below the first is not even storable, guards or none.
      await expect(unguarded('UPDATE world_district_tickets SET epoch = 0 WHERE id = $1', [captain.id])).rejects.toThrow(/wdt_ordinal_shape/)
      expect(await violations()).toEqual([])
    })
  })
})
