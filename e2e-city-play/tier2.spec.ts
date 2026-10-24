import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import pg from 'pg'
import { arrive, ARCHITECT, claim, CONSTRUCTIONS, drawnHeight, guildFor, installed, openProperty, player, presses, records } from './constructionHelpers'
import { launch, launchHref, snowflake } from './play'
import { CONSTRUCTION_CREDITS, CONSTRUCTION_KEEPER, CONSTRUCTION_PASS, REHEARSAL_ADA, REHEARSAL_BEA, REHEARSAL_CY } from './rehearsal'

/**
 * TIER 2 LOCAL TEST CONSTRUCTION AND ARCHITECT ACTIVITY (P1-C2-E3B), end to end against a REAL local Proofy Play, in the
 * original city view. A Tier 1 property's next goal is Tier 2 (provisional local recipe `local-test-tier2-v1`: 250
 * lifetime units, three more 50-unit steps); its controller and patrons take it there with valueless LOCAL TEST credits;
 * the building is drawn taller, at the renderer's Tier 2, for everyone and after a reload. Each player's own construction
 * record (Architect activity) splits what they built as the file's named controller from what they built as a patron.
 * Nothing here is verified ownership, RF or Proofy Points, and no rank, level or reward exists.
 */
const SHOTS = resolve(import.meta.dirname, '../test-artifacts/city-play-evidence')
mkdirSync(SHOTS, { recursive: true })
/** The keeper's token id, as the renderer names its building. */
const KEEPER_ID = CONSTRUCTION_KEEPER.slice(CONSTRUCTION_KEEPER.lastIndexOf('/') + 1)
const UNCONFIRMED = 'We could not confirm this build. It may already have been built and paid for. Check it with the same press: one press is never built or paid twice.'

const databaseUrl = process.env.CITY_PLAY_DATABASE_URL ?? ''
let db: pg.Pool
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: databaseUrl, max: 2 })
})
test.afterAll(async () => {
  await db.end()
})

test('a Tier 1 property continues to Tier 2 with its controller and patrons: progress between, the building grows on the map, no civic award; a reload and every player see it', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 7))
  const { constructionsOf } = records(db)
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  const sprite = (page: typeof ada.page) => page.getByTestId(`building-${KEEPER_ID}`)
  const card = ada.page.getByTestId('construction-card')
  await expect(card).toHaveAttribute('data-recipe', 'local-test-tier2-v1')
  await expect(card).toHaveAttribute('data-max-tier', '2')
  await expect(card.getByTestId('construction-goal')).toHaveText('Next goal: Tier 1 at 100 lifetime units, 2 more steps by anyone. Provisional LOCAL TEST goal, not a final tier rule.')
  for (let i = 0; i < 2; i++) {
    await card.getByTestId('construction-action').click()
    await expect(card).toHaveAttribute('data-built', String(50 * (i + 1)))
  }
  await expect(card).toHaveAttribute('data-tier', '1')
  await expect(sprite(ada.page)).toHaveAttribute('data-tier', '1')
  await expect(card.getByTestId('construction-goal')).toHaveAttribute('data-steps-left', '3')
  const tier1Total = Number(await sprite(ada.page).getAttribute('data-total'))
  const tier1Height = await drawnHeight(ada.page, KEEPER_ID)

  // Cy, a patron with test credits, takes it two steps on: progress inside Tier 1, drawn as it grows.
  const cy = await player(browser, guild, 'Cy', REHEARSAL_CY)
  const cyCard = await openProperty(cy.page, placed.plotId, placed.buildingId)
  const totals: number[] = [tier1Total]
  for (let i = 0; i < 2; i++) {
    await cyCard.getByTestId('construction-action').click()
    await expect(cyCard).toHaveAttribute('data-built', String(150 + 50 * i))
    await expect(cyCard).toHaveAttribute('data-tier', '1')
    await expect(sprite(cy.page)).toHaveAttribute('data-tier', '1')
    await expect.poll(async () => Number(await sprite(cy.page).getAttribute('data-total'))).toBeGreaterThan(totals.at(-1)!)
    totals.push(Number(await sprite(cy.page).getAttribute('data-total')))
  }
  await expect(cyCard.getByTestId('construction-goal')).toHaveText('Next goal: Tier 2 at 250 lifetime units, 1 more step by anyone. Provisional LOCAL TEST goal, not a final tier rule.')
  await expect(cyCard.getByTestId('construction-credits')).toHaveText(String(CONSTRUCTION_CREDITS.cy - 100))
  await cy.page.screenshot({ path: `${SHOTS}/tier2-1-progress.png` })

  // Bea completes Tier 2, as a patron.
  const bea = await player(browser, guild, 'Bea', REHEARSAL_BEA)
  const beaCard = await openProperty(bea.page, placed.plotId, placed.buildingId)
  await beaCard.getByTestId('construction-action').click()
  await expect(beaCard.getByTestId('construction-status')).toHaveText(/^Built 50 test units as a patron: Tier 2 reached\. Recorded at city sequence \d+\.$/)
  await expect(beaCard).toHaveAttribute('data-tier', '2')
  await expect(beaCard).toHaveAttribute('data-standing', 'complete')
  await expect(beaCard.getByTestId('construction-action')).toHaveCount(0)
  await expect(beaCard.getByTestId('construction-goal')).toHaveText('Complete: Tier 2 is the last tier of the local test recipe (100 · 250 units). Nothing more can be built here in this rehearsal.')
  await expect(beaCard.getByTestId('construction-contributors')).toHaveText('Built by 1 owner and 2 patrons over its lifetime.')
  await expect(beaCard.getByTestId('construction-control')).toHaveText('This local server’s test file names another player as this NFT’s current controller.')
  await expect(beaCard.getByTestId('investment-current-owner')).toHaveText('100')
  await expect(beaCard.getByTestId('investment-community')).toHaveText('150')
  await expect(beaCard.getByTestId('investment-total')).toHaveText('250')
  await expect(bea.page.getByTestId('building-panel').getByTestId('panel-tier')).toContainText('2')
  await expect(sprite(bea.page)).toHaveAttribute('data-tier', '2')
  await expect(sprite(bea.page)).toHaveAccessibleName(/Tier 2/)
  await bea.page.screenshot({ path: `${SHOTS}/tier2-2-complete.png` })

  // Ada's map, after a reload: the same building at Tier 2, drawn taller than at Tier 1; still no Crown, Capital or monument.
  const tier2Height = await drawnHeight(ada.page, KEEPER_ID)
  expect(tier2Height).toBeGreaterThan(tier1Height)
  await expect(ada.city).toHaveAttribute('data-source', 'session')
  await expect(sprite(ada.page)).toHaveAttribute('data-tier', '2')
  expect(Number(await sprite(ada.page).getAttribute('data-total'))).toBeGreaterThan(totals.at(-1)!)
  await expect(ada.page.getByTestId('hud-crown')).toContainText('—')
  await expect(ada.page.getByTestId('hud-capital')).toHaveAttribute('data-capital', '')
  await expect(ada.page.getByTestId('crown-spire')).toHaveCount(0)
  await expect(ada.page.locator('[data-testid^="monument-m"]')).toHaveCount(0)
  await expect(ada.page.getByTestId('play-world-note')).toContainText('Local test construction draws tiers only: it earns no Crown, Capital or monument.')
  const mine = await openProperty(ada.page, placed.plotId, placed.buildingId)
  await expect(mine).toHaveAttribute('data-tier', '2')
  await expect(mine.getByTestId('construction-history-entry')).toHaveCount(5)
  await expect(mine.getByTestId('construction-viewer-progress')).toHaveAttribute('data-owner-units', '100')
  await expect(ada.page.getByTestId('building-panel').getByTestId('property-founder')).toHaveText('You')
  await expect(ada.page.getByTestId('building-panel').getByTestId('property-holder')).toHaveText('Not verified')
  await ada.page.getByTestId('nav-properties').click()
  await expect(ada.page.getByTestId('my-property')).toContainText('Tier 2 ·')
  await ada.page.screenshot({ path: `${SHOTS}/tier2-3-reloaded.png` })

  expect((await constructionsOf(placed.propertyId)).map((c) => [c.recipe, c.role, c.contributor_discord_user_id, c.built_after, c.tier_after])).toEqual([
    ['local-test-tier2-v1', 'owner', REHEARSAL_ADA, 50, 0],
    ['local-test-tier2-v1', 'owner', REHEARSAL_ADA, 100, 1],
    ['local-test-tier2-v1', 'patron', REHEARSAL_CY, 150, 1],
    ['local-test-tier2-v1', 'patron', REHEARSAL_CY, 200, 1],
    ['local-test-tier2-v1', 'patron', REHEARSAL_BEA, 250, 2],
  ])
  for (const p of [ada, cy, bea]) await p.context.close()
})

test('Architect activity: each player\'s own construction record across properties, owner apart from patron, from My Properties and the construction card; nothing ranked', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 8))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  // Two properties: the keeper the file names Ada the controller of, and a pass it names nobody for.
  const keeper = await claim(ada.page, CONSTRUCTION_KEEPER)
  await ada.page.getByTestId('construction-action').click()
  await expect(ada.page.getByTestId('construction-card')).toHaveAttribute('data-built', '50')
  const pass = await claim(ada.page, CONSTRUCTION_PASS)
  await expect(ada.page.getByTestId('construction-card')).toHaveAttribute('data-control', 'unknown')
  await ada.page.getByTestId('construction-action').click()
  await expect(ada.page.getByTestId('construction-card')).toHaveAttribute('data-built', '50')
  const reads: string[] = []
  ada.page.on('request', (r) => r.url().includes(ARCHITECT) && reads.push(r.method()))

  // From the construction card.
  await ada.page.getByTestId('construction-architect').click()
  const panel = ada.page.getByTestId('architect-activity')
  await expect(panel).toHaveAttribute('data-state', 'ready')
  await expect(panel.getByTestId('architect-test-tag')).toHaveText('LOCAL TEST')
  const totals = panel.getByTestId('architect-totals')
  await expect(totals).toHaveAttribute('data-owner-units', '50')
  await expect(totals).toHaveAttribute('data-patron-units', '50')
  await expect(totals).toHaveAttribute('data-current-era-owner-units', '50')
  await expect(totals).toHaveAttribute('data-earlier-era-owner-units', '0')
  await expect(totals).toHaveAttribute('data-properties-developed', '2')
  await expect(panel.getByTestId('architect-actions')).toHaveText(`1 step as owner · 1 as patron · ${CONSTRUCTION_CREDITS.ada - 100} test credits to spend here.`)
  const items = panel.getByTestId('architect-property')
  await expect(items).toHaveCount(2)
  // Most recent activity first: the pass (patron), then the keeper (owner).
  await expect(items.nth(0)).toHaveAttribute('data-property-id', pass.propertyId)
  await expect(items.nth(0)).toHaveAttribute('data-control', 'unknown')
  await expect(items.nth(0)).toHaveAttribute('data-patron-units', '50')
  await expect(items.nth(0)).toHaveAttribute('data-owner-units', '0')
  await expect(items.nth(0).getByTestId('architect-property-basis')).toHaveText('Founded by you · No test controller named')
  await expect(items.nth(1)).toHaveAttribute('data-property-id', keeper.propertyId)
  await expect(items.nth(1)).toHaveAttribute('data-control', 'viewer')
  await expect(items.nth(1)).toHaveAttribute('data-owner-units', '50')
  await expect(items.nth(1).getByTestId('architect-property-basis')).toHaveText('Founded by you · Test controller: you')
  // Her credits (120, less 100 spent) do not pay the next step, and her record says so.
  await expect(items.nth(1)).toHaveAttribute('data-standing', 'insufficient')
  await expect(items.nth(1).getByTestId('architect-property-next')).toHaveText('Next: an owner step of 50 TEST credits toward Tier 1 (not enough test credits yet).')
  await expect(panel.getByTestId('architect-basis')).toContainText('test data, not verified NFT control. Founding a property is not owning it.')
  await expect(panel.getByTestId('architect-basis')).toContainText('never count as your own progress. There are no ranks, levels or rewards here.')
  expect(await panel.innerText()).not.toMatch(/\b(rank(ed)?|level \d|xp|badge|leaderboard)\b/i)
  await ada.page.screenshot({ path: `${SHOTS}/tier2-4-architect.png` })

  // OPEN a property from it, and back.
  await items.nth(1).getByTestId('architect-property-view').click()
  await expect(ada.page.getByTestId('building-panel')).toHaveAttribute('data-building', keeper.buildingId)
  await ada.page.getByTestId('building-panel').getByRole('button', { name: 'Back' }).click()
  await expect(ada.page.getByTestId('architect-activity')).toBeVisible()

  // From MY PROPERTIES, after a relaunch: the same record, read again from the server.
  await arrive(ada.page, launchHref(await launch(guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await ada.page.getByTestId('nav-properties').click()
  await ada.page.getByTestId('my-properties-architect').click()
  await expect(ada.page.getByTestId('architect-totals')).toHaveAttribute('data-owner-units', '50')
  await expect(ada.page.getByTestId('architect-property')).toHaveCount(2)
  expect(reads.every((m) => m === 'GET')).toBe(true)

  // Bea builds on Ada's keeper as a patron: her record holds it as patron units, and none as her own progression.
  const bea = await player(browser, guild, 'Bea', REHEARSAL_BEA)
  const beaCard = await openProperty(bea.page, keeper.plotId, keeper.buildingId)
  await beaCard.getByTestId('construction-action').click()
  await expect(beaCard).toHaveAttribute('data-built', '100')
  await beaCard.getByTestId('construction-architect').click()
  const hers = bea.page.getByTestId('architect-totals')
  await expect(hers).toHaveAttribute('data-owner-units', '0')
  await expect(hers).toHaveAttribute('data-patron-units', '50')
  await expect(hers).toHaveAttribute('data-tiers-completed', '1')
  await expect(bea.page.getByTestId('architect-property')).toHaveCount(1)
  await expect(bea.page.getByTestId('architect-property')).toHaveAttribute('data-founded', 'false')
  await expect(bea.page.getByTestId('architect-property')).toHaveAttribute('data-control', 'other')
  expect(await bea.page.getByTestId('architect-activity').innerText()).not.toMatch(/Ada/)
  // A player the file gives nothing has an empty record, and is told so.
  const visitor = await player(browser, guild, 'Visitor', snowflake())
  await visitor.page.getByTestId('nav-properties').click()
  await visitor.page.getByTestId('my-properties-architect').click()
  await expect(visitor.page.getByTestId('architect-empty')).toBeVisible()
  for (const p of [ada, bea, visitor]) await p.context.close()
})

test('a Tier 2 press whose answer was lost is checked as the same press and paid once; the browser cannot ask for Tier 2', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 9))
  const { constructionsOf, ledger } = records(db)
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  for (let i = 0; i < 2; i++) {
    await ada.page.getByTestId('construction-action').click()
    await expect(ada.page.getByTestId('construction-card')).toHaveAttribute('data-built', String(50 * (i + 1)))
  }
  const cy = await player(browser, guild, 'Cy', REHEARSAL_CY)
  const card = await openProperty(cy.page, placed.plotId, placed.buildingId)
  const sent = presses(cy.page)
  // The server builds Cy's first Tier 2 step, and the answer never reaches the page.
  let lose = true
  await cy.page.route(`**${CONSTRUCTIONS}`, async (route) => {
    if (!lose) return route.continue()
    lose = false
    await route.fetch()
    await route.abort('failed')
  })
  await card.getByTestId('construction-action').click()
  await expect(card.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'unconfirmed')
  await expect(card.getByTestId('construction-status')).toHaveText(UNCONFIRMED)
  await expect(card).toHaveAttribute('data-built', '150')
  // The press kept in this browser is only the request to repeat and what it was for: no credential, token or result.
  const kept = JSON.parse((await cy.page.evaluate(() => localStorage.getItem('rare-city-construction-presses')))!) as Record<string, unknown>[]
  expect(kept).toEqual([{ actionId: sent[0].actionId, worldId: sent[0].worldId, discordUserId: REHEARSAL_CY, propertyId: placed.propertyId, role: 'patron', intent: { recipe: 'local-test-tier2-v1', tier: 1 } }])
  // A reload: the press is kept, and checked exactly as sent.
  await cy.page.reload()
  const again = await openProperty(cy.page, placed.plotId, placed.buildingId)
  await expect(again.getByTestId('construction-action')).toHaveText('Check this build · same press')
  await again.getByTestId('construction-action').click()
  await expect(again.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'repeat')
  await expect(again).toHaveAttribute('data-built', '150')
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual(sent[0])
  expect((await ledger(placed.propertyId)).filter((e) => e.account === REHEARSAL_CY).map((e) => e.balance_after)).toEqual([CONSTRUCTION_CREDITS.cy, CONSTRUCTION_CREDITS.cy - 50])
  // Settled: nothing is kept any more.
  expect(await cy.page.evaluate(() => localStorage.getItem('rare-city-construction-presses'))).toBe('[]')

  // The browser asks for Tier 2 outright, with every field it could add: refused, nothing written.
  const before = (await constructionsOf(placed.propertyId)).length
  const actor = { sessionRef: await cy.city.getAttribute('data-session-ref'), worldId: await cy.city.getAttribute('data-world'), discordUserId: REHEARSAL_CY }
  for (const extra of [{ tier: 2 }, { tierAfter: 2 }, { recipe: 'local-test-tier1-v1' }, { units: 100 }, { builtAfter: 250 }]) {
    const answer = await cy.page.evaluate(
      async ([path, body]) => {
        const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        return [res.status, await res.json()]
      },
      [CONSTRUCTIONS, { ...actor, propertyId: placed.propertyId, role: 'patron', actionId: crypto.randomUUID(), ...extra }] as const,
    )
    expect(answer).toEqual([400, { error: 'invalid_request' }])
  }
  expect(await constructionsOf(placed.propertyId)).toHaveLength(before)

  // Honest presses only: two more steps (Cy, then Bea) reach Tier 2, one record and one debit each.
  await again.getByTestId('construction-action').click()
  await expect(again).toHaveAttribute('data-built', '200')
  const bea = await player(browser, guild, 'Bea', REHEARSAL_BEA)
  const beaCard = await openProperty(bea.page, placed.plotId, placed.buildingId)
  await beaCard.getByTestId('construction-action').dblclick()
  await expect(beaCard).toHaveAttribute('data-tier', '2')
  const rows = await constructionsOf(placed.propertyId)
  expect(rows.map((r) => r.built_after)).toEqual([50, 100, 150, 200, 250])
  expect(new Set(rows.map((r) => r.action_id)).size).toBe(5)
  expect((await ledger(placed.propertyId)).filter((e) => e.kind === 'construction-debit')).toHaveLength(5)
  for (const p of [ada, cy, bea]) await p.context.close()
})

test('a lost press whose kept intent no longer reads is still checked under its own id after a reload: one construction, one debit, one event (independent audit L1)', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 9, 1))
  const { constructionsOf, ledger } = records(db)
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  for (let i = 0; i < 2; i++) {
    await ada.page.getByTestId('construction-action').click()
    await expect(ada.page.getByTestId('construction-card')).toHaveAttribute('data-built', String(50 * (i + 1)))
  }
  const cy = await player(browser, guild, 'Cy', REHEARSAL_CY)
  const card = await openProperty(cy.page, placed.plotId, placed.buildingId)
  const sent = presses(cy.page)
  // The server builds Cy's first Tier 2 step, and the answer never reaches the page.
  let lose = true
  await cy.page.route(`**${CONSTRUCTIONS}`, async (route) => {
    if (!lose) return route.continue()
    lose = false
    await route.fetch()
    await route.abort('failed')
  })
  await card.getByTestId('construction-action').click()
  await expect(card.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'unconfirmed')
  expect(await constructionsOf(placed.propertyId)).toHaveLength(3)

  // Test-only browser setup: the kept press's display-only intent is replaced by shapes an earlier or later build might
  // have left (here an unknown object), and nothing else about it changes.
  await cy.page.evaluate(() => {
    const kept = JSON.parse(localStorage.getItem('rare-city-construction-presses')!) as Record<string, unknown>[]
    localStorage.setItem('rare-city-construction-presses', JSON.stringify(kept.map((p) => ({ ...p, intent: { recipe: 7, tier: 'one', legacy: true } }))))
  })
  await cy.page.reload()
  const again = await openProperty(cy.page, placed.plotId, placed.buildingId)
  await expect(again.getByTestId('construction-action')).toHaveText('Check this build · same press')
  await again.getByTestId('construction-action').click()
  await expect(again.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'repeat')
  await expect(again).toHaveAttribute('data-built', '150')
  // The same request, exactly as first sent, and the intent never in it.
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual(sent[0])
  expect(Object.keys(sent[0]).sort()).toEqual(['actionId', 'discordUserId', 'propertyId', 'role', 'sessionRef', 'worldId'])
  const rows = await constructionsOf(placed.propertyId)
  expect(rows.map((r) => r.built_after)).toEqual([50, 100, 150])
  expect(rows.filter((r) => r.action_id === sent[0].actionId)).toHaveLength(1)
  expect((await ledger(placed.propertyId)).filter((e) => e.account === REHEARSAL_CY && e.kind === 'construction-debit').map((e) => e.delta)).toEqual([-50])
  const events = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM city_events e JOIN world_properties p ON p.city_id = e.city_id WHERE p.id = $1 AND e.payload ->> 'action' = $2", [placed.propertyId, sent[0].actionId])).rows[0].n
  expect(events).toBe(1)
  expect(await cy.page.evaluate(() => localStorage.getItem('rare-city-construction-presses'))).toBe('[]')
  for (const p of [ada, cy]) await p.context.close()
})
