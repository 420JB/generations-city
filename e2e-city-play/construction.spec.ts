import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test'
import pg from 'pg'
import { BRAND_A } from './brands'
import { install, launch, launchHref, publish, snowflake } from './play'
import { constructionGuilds, CONSTRUCTION_CREDITS, CONSTRUCTION_KEEPER, CONSTRUCTION_PASS, REHEARSAL_ADA, REHEARSAL_BEA, REHEARSAL_CY } from './rehearsal'

/**
 * LOCAL TEST CONSTRUCTION (P1-C2-E3A; Tier 1 is no longer the top since P1-C2-E3B, see `tier2.spec.ts`), end to end against a REAL local Proofy Play, through the property's own panel: the
 * player whom the local file names as the NFT's current controller builds it from Tier 0 to Tier 1 in two server-computed
 * steps, paid in valueless LOCAL TEST credits; another player contributes as a patron; the city draws the building at the
 * tier the server stored, for everyone, after a reload too. The page sends only a property, a role and a press id.
 * Construction data exists only for this run's construction Discord servers (`rehearsal.ts`); every other test's city has
 * none. Nothing here is verified ownership, RF or Proofy Points.
 */
const SHOTS = resolve(import.meta.dirname, '../test-artifacts/city-play-evidence')
mkdirSync(SHOTS, { recursive: true })
const CONSTRUCTIONS = '/v1/play/rehearsal/constructions'
/** What the card says when an answer does not say whether the press built (independent audit M1): never "nothing was placed". */
const UNCONFIRMED = 'We could not confirm this build. It may already have been built and paid for. Check it with the same press: one press is never built or paid twice.'

const databaseUrl = process.env.CITY_PLAY_DATABASE_URL ?? ''
let db: pg.Pool
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: databaseUrl, max: 2 })
})
test.afterAll(async () => {
  await db.end()
})

/** This test's own construction Discord servers, `n` of its two (each test, and each of up to five repetitions, founds its own cities). */
function guildFor(testInfo: TestInfo, slot: number, n = 0) {
  const guilds = constructionGuilds()
  const index = slot * 10 + testInfo.repeatEachIndex * 2 + n
  if (index >= guilds.length) throw new Error('not enough construction Discord servers for this run')
  return guilds[index]
}

async function installed(guild: string) {
  const installation = await install(guild)
  await publish(guild, installation, BRAND_A)
  return { guild, installation }
}

async function arrive(page: Page, href: string) {
  await page.goto('about:blank')
  await page.goto(href)
  await expect(page.getByTestId('play-city')).toBeAttached()
  await expect(page.getByTestId('city-svg')).toBeVisible()
  return page.getByTestId('play-city')
}

async function player(browser: Browser, guild: string, name: string, discordUserId: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const city = await arrive(page, launchHref(await launch(guild, 'rare-city', name, discordUserId)))
  return { context, page, city }
}

/** Until the camera stops moving. */
async function still(page: Page) {
  let last = ''
  for (let i = 0; i < 80; i++) {
    const now = await page.getByTestId('city-svg').getAttribute('viewBox')
    if (now === last) return
    last = now ?? ''
    await page.waitForTimeout(120)
  }
}

/** A highlighted plot the player can actually click: the first candidate whose center no drawer, bar or HUD covers. */
async function visiblePlot(page: Page): Promise<string> {
  await still(page)
  const id = await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-testid^="candidate-plot-"]')) {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      if (hit && el.contains(hit)) return el.getAttribute('data-testid')
    }
    return null
  })
  if (!id) throw new Error('no highlighted plot is visible')
  const [, d, ward, plot] = /^candidate-plot-(.+)-(\d+)-(\d+)$/.exec(id)!
  return `${d}-w${ward}-p${plot}`
}

/** One whole claim through the page, from the claim card: returns the stored plot and building. */
async function claim(page: Page, asset: string) {
  const card = page.getByTestId('play-ticket')
  if ((await card.getAttribute('data-state')) !== 'held') await card.getByTestId('play-ticket-enter').click()
  await expect(card).toHaveAttribute('data-state', 'held')
  await card.getByTestId('play-claim-continue').click()
  const panel = page.getByTestId('rehearsal-panel')
  await expect(panel).toBeVisible()
  await page.locator(`[data-asset="${asset}"]`).check()
  await expect(panel).toHaveAttribute('data-assigned', 'yes')
  const plotId = await visiblePlot(page)
  const [, d, ward, plot] = /^(.+)-w(\d+)-p(\d+)$/.exec(plotId)!
  await page.getByTestId(`candidate-plot-${d}-${ward}-${plot}`).click()
  await panel.getByTestId('rehearsal-review').click()
  await panel.getByTestId('rehearsal-activate').click()
  const stored = page.getByTestId('building-panel').getByTestId('stored-property')
  await expect(stored).toHaveAttribute('data-plot-id', plotId)
  const propertyId = (await stored.getAttribute('data-property-id'))!
  return { plotId, propertyId, buildingId: `b-${propertyId}` }
}

/** Open a property's panel as anyone finds it: its district's list. */
async function openProperty(page: Page, plotId: string, buildingId: string) {
  await page.getByTestId('nav-districts').click()
  await page.getByTestId(`dtab-${/^(.+)-w\d+-p\d+$/.exec(plotId)![1]}`).click()
  await page.getByTestId(`warp-${buildingId}`).click()
  await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', buildingId)
  const card = page.getByTestId('construction-card')
  await expect(card).toHaveAttribute('data-state', 'ready')
  return card
}

const sprite = (page: Page) => page.getByTestId('building-812')
/** Every construction request the page sends, as sent. */
function presses(page: Page) {
  const sent: { actionId: string; propertyId: string; role: string; sessionRef: string; worldId: string; discordUserId: string }[] = []
  page.on('request', (r) => r.url().endsWith(CONSTRUCTIONS) && r.method() === 'POST' && sent.push(r.postDataJSON()))
  return sent
}
const constructionsOf = async (propertyId: string) =>
  (
    await db.query<{ property_id: string; action_id: string; role: string; units: number }>(
      `SELECT c.property_id, c.action_id, c.role, c.units FROM world_property_constructions c JOIN world_properties p ON p.world_id = c.world_id WHERE p.id = $1 ORDER BY c.sequence`,
      [propertyId],
    )
  ).rows
const ledger = async (propertyId: string) =>
  (
    await db.query<{ account: string; kind: string; delta: number; balance_after: number }>(
      `SELECT t.account_discord_user_id AS account, t.kind, t.delta, t.balance_after FROM world_test_credit_entries t JOIN world_properties p ON p.world_id = t.world_id
        WHERE p.id = $1 ORDER BY t.account_discord_user_id, t.entry_seq`,
      [propertyId],
    )
  ).rows

test('the NFT\'s current controller builds it from Tier 0 to Tier 1 on its panel: local test credits, progress, the building on the map, history; a reload and every other player see it', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 0))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  const panel = ada.page.getByTestId('building-panel')
  const card = panel.getByTestId('construction-card')

  // Tier 0, as founded: the local file names Ada as the controller; her test credits are granted, not yet recorded.
  await expect(card).toHaveAttribute('data-state', 'ready')
  await expect(card).toHaveAttribute('data-tier', '0')
  await expect(card).toHaveAttribute('data-control', 'viewer')
  await expect(card.getByTestId('construction-test-tag')).toHaveText('LOCAL TEST')
  await expect(card.getByTestId('construction-credits')).toHaveText(String(CONSTRUCTION_CREDITS.ada))
  await expect(card.getByTestId('construction-cost-note')).toContainText('LOCAL TEST credits only: valueless')
  await expect(card.getByTestId('construction-cost-note')).toContainText('provisional local tuning, not a price')
  await expect(card.page().getByTestId('construction-records').getByTestId('construction-history-none')).toBeVisible()
  await expect(panel.getByTestId('property-founder')).toHaveText('You')
  await expect(panel.getByTestId('property-holder')).toHaveText('Not verified')
  await expect(sprite(ada.page)).toHaveAttribute('data-tier', '0')
  await expect(sprite(ada.page)).toHaveAttribute('data-total', '0')
  const sequence = Number(await ada.city.getAttribute('data-world-sequence'))
  await ada.page.screenshot({ path: `${SHOTS}/construction-1-tier0.png` })

  // One step: half way, paid 50 test credits, the building on the map moves with it; no request names an amount.
  const action = card.getByTestId('construction-action')
  await expect(action).toHaveAttribute('data-role', 'owner')
  await expect(action).toHaveText('Test construction · 50 TEST credits')
  const sent: unknown[] = []
  ada.page.on('request', (r) => r.url().endsWith(CONSTRUCTIONS) && sent.push(r.postDataJSON()))
  await action.click()
  const status = card.getByTestId('construction-status')
  await expect(status).toHaveAttribute('data-outcome', 'built')
  await expect(status).toHaveText(`Built 50 test units as owner. Recorded at city sequence ${sequence + 1}.`)
  await expect(card).toHaveAttribute('data-built', '50')
  await expect(card.getByTestId('construction-credits')).toHaveText(String(CONSTRUCTION_CREDITS.ada - 50))
  await expect(ada.city).toHaveAttribute('data-world-sequence', String(sequence + 1))
  await expect(sprite(ada.page)).toHaveAttribute('data-total', '50')
  await expect(sprite(ada.page)).toHaveAttribute('data-tier', '0')
  expect(Object.keys(sent[0] as object).sort()).toEqual(['actionId', 'discordUserId', 'propertyId', 'role', 'sessionRef', 'worldId'])

  // The second step reaches Tier 1: the panel, the map and the city note all say so. The next goal is Tier 2 (C2-E3B),
  // which Ada's 20 remaining test credits do not pay a step toward: the action is there, and held.
  await action.click()
  await expect(status).toHaveText(`Built 50 test units as owner: Tier 1 reached. Recorded at city sequence ${sequence + 2}.`)
  await expect(card).toHaveAttribute('data-tier', '1')
  await expect(card).toHaveAttribute('data-standing', 'insufficient')
  await expect(card).toHaveAttribute('data-next-tier-at', '250')
  await expect(card.getByTestId('construction-goal')).toHaveText('Next goal: Tier 2 at 250 lifetime units, 3 more steps by anyone. Provisional LOCAL TEST goal, not a final tier rule.')
  await expect(card.getByTestId('construction-action')).toBeDisabled()
  await expect(card.getByTestId('construction-insufficient')).toHaveText(`You have ${CONSTRUCTION_CREDITS.ada - 100} test credits here; one step costs 50.`)
  await expect(panel.getByTestId('panel-tier')).toContainText('1')
  await expect(sprite(ada.page)).toHaveAttribute('data-tier', '1')
  await expect(sprite(ada.page)).toHaveAccessibleName(/Tier 1/)
  await expect(ada.city).toHaveAttribute('data-developed', '1')
  await expect(ada.page.getByTestId('play-world-note')).toContainText('1 property, 1 with local test construction.')
  await expect(card.page().getByTestId('construction-records').getByTestId('construction-history-entry')).toHaveCount(2)
  await expect(card.page().getByTestId('construction-records').getByTestId('investment-current-owner')).toHaveText('100')
  await expect(card.page().getByTestId('construction-records').getByTestId('construction-viewer-progress')).toHaveAttribute('data-owner-units', '100')
  await ada.page.screenshot({ path: `${SHOTS}/construction-2-tier1.png` })
  expect(await ledger(placed.propertyId)).toEqual([
    { account: REHEARSAL_ADA, kind: 'fixture-grant', delta: CONSTRUCTION_CREDITS.ada, balance_after: CONSTRUCTION_CREDITS.ada },
    { account: REHEARSAL_ADA, kind: 'construction-debit', delta: -50, balance_after: CONSTRUCTION_CREDITS.ada - 50 },
    { account: REHEARSAL_ADA, kind: 'construction-debit', delta: -50, balance_after: CONSTRUCTION_CREDITS.ada - 100 },
  ])
  // MY PROPERTIES lists it at Tier 1.
  await ada.page.getByTestId('nav-properties').click()
  await expect(ada.page.getByTestId('my-property')).toContainText('Tier 1 ·')

  // A reload reads it all again from the server.
  await ada.page.reload()
  await expect(ada.city).toHaveAttribute('data-source', 'session')
  await expect(sprite(ada.page)).toHaveAttribute('data-tier', '1')
  const again = await openProperty(ada.page, placed.plotId, placed.buildingId)
  await expect(again).toHaveAttribute('data-tier', '1')
  await expect(again.page().getByTestId('construction-records').getByTestId('construction-history-entry')).toHaveCount(2)
  await expect(again.getByTestId('construction-credits')).toHaveText(String(CONSTRUCTION_CREDITS.ada - 100))

  // Another player of the city sees the same Tier 1 building; the file names someone else as its controller.
  const bea = await player(browser, guild, 'Bea', REHEARSAL_BEA)
  await expect(sprite(bea.page)).toHaveAttribute('data-tier', '1')
  const beaCard = await openProperty(bea.page, placed.plotId, placed.buildingId)
  await expect(beaCard).toHaveAttribute('data-control', 'other')
  // Bea may contribute toward Tier 2, as a patron only.
  await expect(beaCard.getByTestId('construction-action')).toHaveAttribute('data-role', 'patron')
  await expect(beaCard.getByTestId('construction-action')).toBeEnabled()
  await expect(beaCard.page().getByTestId('construction-records').getByTestId('investment-current-owner')).toHaveText('100')
  await expect(beaCard.page().getByTestId('construction-records').getByTestId('construction-history-entry').first()).toHaveAttribute('data-by', 'other')
  // Nobody is told it is "their NFT", and Bea is never told who Ada is.
  for (const page of [ada.page, bea.page]) expect(await page.getByTestId('drawer').innerText()).not.toMatch(/your nft/i)
  expect(await bea.page.getByTestId('drawer').innerText()).not.toMatch(/Ada/)
  await ada.context.close()
  await bea.context.close()
})

test('a patron\'s contribution develops the property as community investment, never the owner\'s own progression; a player with no test credits sees it read only', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 1))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  await ada.page.getByTestId('construction-action').click()
  await expect(ada.page.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'built')

  const bea = await player(browser, guild, 'Bea', REHEARSAL_BEA)
  const card = await openProperty(bea.page, placed.plotId, placed.buildingId)
  await expect(card).toHaveAttribute('data-control', 'other')
  await expect(card.getByTestId('construction-control')).toContainText('names another player as this NFT’s current controller. You can contribute as a patron.')
  const action = card.getByTestId('construction-action')
  await expect(action).toHaveAttribute('data-role', 'patron')
  await expect(action).toHaveText('Test patron contribution · 50 TEST credits')
  await action.click()
  await expect(card.getByTestId('construction-status')).toHaveText(/^Built 50 test units as a patron: Tier 1 reached\./)
  await expect(card.page().getByTestId('construction-records').getByTestId('investment-current-owner')).toHaveText('50')
  await expect(card.page().getByTestId('construction-records').getByTestId('investment-community')).toHaveText('50')
  await expect(card.page().getByTestId('construction-records').getByTestId('investment-total')).toHaveText('100')
  await expect(card.page().getByTestId('construction-records').getByTestId('construction-viewer-progress')).toHaveAttribute('data-owner-units', '0')
  await expect(card.page().getByTestId('construction-records').getByTestId('construction-viewer-progress')).toHaveAttribute('data-patron-units', '50')
  await expect(card.getByTestId('construction-credits')).toHaveText('0')
  await expect(sprite(bea.page)).toHaveAttribute('data-tier', '1')
  await bea.page.screenshot({ path: `${SHOTS}/construction-3-patron.png` })

  // Ada's own progression counts her own 50 units only.
  await ada.page.reload()
  const mine = await openProperty(ada.page, placed.plotId, placed.buildingId)
  await expect(mine.page().getByTestId('construction-records').getByTestId('construction-viewer-progress')).toHaveAttribute('data-owner-units', '50')
  await expect(mine.page().getByTestId('construction-records').getByTestId('construction-viewer-progress')).toHaveAttribute('data-patron-units', '0')
  await expect(mine.page().getByTestId('construction-records').getByTestId('investment-community')).toHaveText('50')
  expect((await ledger(placed.propertyId)).filter((e) => e.kind === 'construction-debit').map((e) => [e.account, e.delta])).toEqual([
    [REHEARSAL_ADA, -50],
    [REHEARSAL_BEA, -50],
  ])

  // A player the local file grants nothing reads the property, and is offered no control at all.
  const visitor = await player(browser, guild, 'Visitor', snowflake())
  const read = await openProperty(visitor.page, placed.plotId, placed.buildingId)
  await expect(read.getByTestId('construction-action')).toHaveCount(0)
  await expect(read.page().getByTestId('construction-records').getByTestId('construction-history-entry')).toHaveCount(2)
  // Cy has credits, and the property's next goal is Tier 2 (C2-E3B): Cy may contribute toward it, as a patron.
  const cy = await player(browser, guild, 'Cy', REHEARSAL_CY)
  const cyCard = await openProperty(cy.page, placed.plotId, placed.buildingId)
  await expect(cyCard).toHaveAttribute('data-standing', 'ready')
  await expect(cyCard.getByTestId('construction-action')).toHaveAttribute('data-role', 'patron')
  await expect(cyCard.getByTestId('construction-goal')).toContainText('Next goal: Tier 2 at 250 lifetime units, 3 more steps by anyone.')
  for (const p of [ada, bea, visitor, cy]) await p.context.close()
})

test('a press whose answer was lost is checked again as the same press: built and paid once; a double press builds once', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 2))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  const card = ada.page.getByTestId('construction-card')
  const sent: { actionId: string }[] = []
  ada.page.on('request', (r) => r.url().endsWith(CONSTRUCTIONS) && sent.push(r.postDataJSON()))
  // The server builds, and the answer never reaches the page.
  let lose = true
  await ada.page.route(`**${CONSTRUCTIONS}`, async (route) => {
    if (!lose) return route.continue()
    lose = false
    await route.fetch()
    await route.abort('failed')
  })
  await card.getByTestId('construction-action').click()
  await expect(card.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'unconfirmed')
  await expect(card.getByTestId('construction-status')).toHaveText(UNCONFIRMED)
  // The page read the property again (it was built once), and the one action now checks that press.
  await expect(card).toHaveAttribute('data-built', '50')
  await expect(card.getByTestId('construction-action')).toHaveText('Check this build · same press')
  await expect(card.getByTestId('construction-action')).toHaveAttribute('data-pending', 'here')
  await card.getByTestId('construction-action').click()
  await expect(card.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'repeat')
  await expect(card.getByTestId('construction-status')).toContainText('Already built by this press')
  await expect(card).toHaveAttribute('data-built', '50')
  await expect(card.getByTestId('construction-credits')).toHaveText(String(CONSTRUCTION_CREDITS.ada - 50))
  expect(sent.map((s) => s.actionId)).toEqual([sent[0].actionId, sent[0].actionId])

  // A double press: the button holds while the first is answered, so exactly one more construction is made.
  await card.getByTestId('construction-action').dblclick()
  await expect(card).toHaveAttribute('data-tier', '1')
  expect(sent).toHaveLength(3)
  expect(new Set(sent.map((s) => s.actionId)).size).toBe(2)
  expect((await ledger(placed.propertyId)).map((e) => e.delta)).toEqual([CONSTRUCTION_CREDITS.ada, -50, -50])
  await ada.context.close()
})

test('two installations stay apart: the same player and NFT build in one city, and the other city is untouched', async ({ browser }, testInfo) => {
  const one = await installed(guildFor(testInfo, 3))
  const two = await installed(guildFor(testInfo, 3, 1))
  const ada = await player(browser, one.guild, 'Ada', REHEARSAL_ADA)
  const first = await claim(ada.page, CONSTRUCTION_KEEPER)
  for (let i = 0; i < 2; i++) {
    await ada.page.getByTestId('construction-action').click()
    await expect(ada.page.getByTestId('construction-card')).toHaveAttribute('data-built', String(50 * (i + 1)))
  }
  await expect(sprite(ada.page)).toHaveAttribute('data-tier', '1')
  const otherCity = await arrive(ada.page, launchHref(await launch(two.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await expect(otherCity).toHaveAttribute('data-developed', '0')
  const second = await claim(ada.page, CONSTRUCTION_KEEPER)
  expect(second.propertyId).not.toBe(first.propertyId)
  const card = ada.page.getByTestId('construction-card')
  await expect(card).toHaveAttribute('data-tier', '0')
  await expect(card.getByTestId('construction-credits')).toHaveText(String(CONSTRUCTION_CREDITS.ada))
  await expect(sprite(ada.page)).toHaveAttribute('data-tier', '0')
  await ada.context.close()
})

/*
 * INDEPENDENT AUDIT M1, in the browser: a construction the server committed whose answer the page could not use. Before the
 * fix, a 503 after the commit was said as "nothing was placed" and the next press took a new id: built and paid twice
 * (120 -> 70 -> 20). Now the page keeps the press until the server answers it, across a relaunch too.
 */
test('M1: a build the server committed but answered 503 is never said to have placed nothing; after a relaunch (a new session) the same press is checked, then a new press builds once more', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 4))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  const card = ada.page.getByTestId('construction-card')
  const sent = presses(ada.page)
  // The server builds; the page is given exactly what the server answered before the fix.
  let fail = true
  await ada.page.route(`**${CONSTRUCTIONS}`, async (route) => {
    if (!fail) return route.continue()
    fail = false
    expect((await route.fetch()).status()).toBe(200)
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'play_session_unavailable' }) })
  })
  await card.getByTestId('construction-action').click()
  const status = card.getByTestId('construction-status')
  await expect(status).toHaveAttribute('data-outcome', 'unconfirmed')
  await expect(status).toHaveText(UNCONFIRMED)
  await expect(ada.page.getByTestId('drawer')).not.toContainText(/nothing was (placed|built)/i)
  await expect(card).toHaveAttribute('data-built', '50')
  await expect(card.getByTestId('construction-action')).toHaveText('Check this build · same press')
  await ada.page.screenshot({ path: `${SHOTS}/construction-4-unconfirmed.png` })

  // Ada launches again from Proofy Play: a new page and a new session of the same player. The press is still unresolved.
  const firstSession = await ada.city.getAttribute('data-session-ref')
  await arrive(ada.page, launchHref(await launch(guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await expect(ada.city).not.toHaveAttribute('data-session-ref', firstSession!)
  const again = await openProperty(ada.page, placed.plotId, placed.buildingId)
  await expect(again.getByTestId('construction-unresolved')).toHaveText(UNCONFIRMED)
  await expect(again.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'unconfirmed')
  await again.getByTestId('construction-action').click()
  await expect(again.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'repeat')
  await expect(again.getByTestId('construction-status')).toContainText('Already built by this press')
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual({ ...sent[0], sessionRef: sent[1].sessionRef })
  expect(sent[1].sessionRef).not.toBe(sent[0].sessionRef)
  expect((await ledger(placed.propertyId)).map((e) => e.balance_after)).toEqual([CONSTRUCTION_CREDITS.ada, CONSTRUCTION_CREDITS.ada - 50])
  await expect(again.getByTestId('construction-credits')).toHaveText(String(CONSTRUCTION_CREDITS.ada - 50))

  // Confirmed: the next press is a new, deliberate construction with its own id, and Tier 1.
  await expect(again.getByTestId('construction-action')).toHaveText('Test construction · 50 TEST credits')
  await again.getByTestId('construction-action').click()
  await expect(again.getByTestId('construction-status')).toHaveText(/^Built 50 test units as owner: Tier 1 reached\./)
  expect(sent).toHaveLength(3)
  expect(sent[2].actionId).not.toBe(sent[0].actionId)
  expect(await ledger(placed.propertyId)).toEqual([
    { account: REHEARSAL_ADA, kind: 'fixture-grant', delta: CONSTRUCTION_CREDITS.ada, balance_after: CONSTRUCTION_CREDITS.ada },
    { account: REHEARSAL_ADA, kind: 'construction-debit', delta: -50, balance_after: CONSTRUCTION_CREDITS.ada - 50 },
    { account: REHEARSAL_ADA, kind: 'construction-debit', delta: -50, balance_after: CONSTRUCTION_CREDITS.ada - 100 },
  ])
  expect((await constructionsOf(placed.propertyId)).map((c) => c.action_id)).toEqual([sent[0].actionId, sent[2].actionId])
  // The property is as before: founded by Ada, never verified ownership, the file's controller building as owner, both steps in era 1.
  const panel = ada.page.getByTestId('building-panel')
  await expect(panel.getByTestId('property-founder')).toHaveText('You')
  await expect(panel.getByTestId('property-holder')).toHaveText('Not verified')
  await expect(again).toHaveAttribute('data-control', 'viewer')
  await expect(again.page().getByTestId('construction-records').getByTestId('construction-history-entry')).toHaveCount(2)
  for (const entry of await again.page().getByTestId('construction-records').getByTestId('construction-history-entry').all()) await expect(entry).toContainText('Owner · You · +50 test units · control era 1')
  await expect(sprite(ada.page)).toHaveAttribute('data-tier', '1')
  await ada.context.close()
})

test('M1: while a build is unconfirmed (its answer unreadable), no other property spends: the earlier press is checked first, exactly as sent, then the other property builds with its own press', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 5))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const keeper = await claim(ada.page, CONSTRUCTION_KEEPER)
  const sent = presses(ada.page)
  // The server builds; the answer's body breaks off.
  let fail = true
  await ada.page.route(`**${CONSTRUCTIONS}`, async (route) => {
    if (!fail) return route.continue()
    fail = false
    const real = await route.fetch()
    await route.fulfill({ response: real, body: (await real.text()).slice(0, 40) })
  })
  await ada.page.getByTestId('construction-action').click()
  await expect(ada.page.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'unconfirmed')

  // Another property of Ada's: nobody controls it, so she would build there as a patron. Not before the first press is known.
  const pass = await claim(ada.page, CONSTRUCTION_PASS)
  const card = ada.page.getByTestId('construction-card')
  await expect(card).toHaveAttribute('data-control', 'unknown')
  const action = card.getByTestId('construction-action')
  await expect(action).toHaveCount(1)
  await expect(action).toHaveAttribute('data-pending', 'elsewhere')
  await expect(action).toHaveText('Check your earlier build first')
  await expect(card.getByTestId('construction-unresolved')).toContainText('We could not confirm your last build, on another of this city’s properties.')
  await action.click()
  await expect(card.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'repeat')
  await expect(card.getByTestId('construction-status')).toContainText('Your earlier build is confirmed: it had built 50 test units on another property')
  expect(sent[1]).toEqual(sent[0])
  expect(sent[1]).toMatchObject({ propertyId: keeper.propertyId, role: 'owner' })
  await expect(card).toHaveAttribute('data-built', '0')

  // Now this property's own press: a patron step, a new id.
  await expect(action).toHaveText('Test patron contribution · 50 TEST credits')
  await action.click()
  await expect(card.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'built')
  expect(sent[2]).toMatchObject({ propertyId: pass.propertyId, role: 'patron' })
  expect(sent[2].actionId).not.toBe(sent[0].actionId)
  expect((await constructionsOf(keeper.propertyId)).map((c) => [c.property_id, c.role, c.units])).toEqual([
    [keeper.propertyId, 'owner', 50],
    [pass.propertyId, 'patron', 50],
  ])
  expect((await ledger(keeper.propertyId)).map((e) => e.balance_after)).toEqual([CONSTRUCTION_CREDITS.ada, CONSTRUCTION_CREDITS.ada - 50, CONSTRUCTION_CREDITS.ada - 100])
  await ada.context.close()
})

test('M1/M2: a failure before the server wrote anything recovers with the same press, spent once; Tier 1 from local test construction is drawn, but earns no Crown, Capital or monument', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 6))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  const card = ada.page.getByTestId('construction-card')
  const sent = presses(ada.page)
  // The request never reaches the construction store.
  let fail = true
  await ada.page.route(`**${CONSTRUCTIONS}`, async (route) => {
    if (!fail) return route.continue()
    fail = false
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'construction_unconfirmed' }) })
  })
  await card.getByTestId('construction-action').click()
  await expect(card.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'unconfirmed')
  await expect(card.getByTestId('construction-status')).toHaveText(UNCONFIRMED)
  await expect(card).toHaveAttribute('data-built', '0')
  expect(await ledger(placed.propertyId)).toEqual([])
  await card.getByTestId('construction-action').click()
  await expect(card.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'built')
  expect(sent.map((s) => s.actionId)).toEqual([sent[0].actionId, sent[0].actionId])
  expect((await ledger(placed.propertyId)).map((e) => e.balance_after)).toEqual([CONSTRUCTION_CREDITS.ada, CONSTRUCTION_CREDITS.ada - 50])

  // The second step: Tier 1, drawn at Tier 1. Before the fix the first step took the Crown, and Tier 1 the Capital.
  await card.getByTestId('construction-action').click()
  await expect(card).toHaveAttribute('data-tier', '1')
  await expect(sprite(ada.page)).toHaveAttribute('data-tier', '1')
  await expect(ada.page.getByTestId('crown-spire')).toHaveCount(0)
  await expect(ada.page.getByTestId('hud-crown')).toContainText('—')
  await expect(ada.page.getByTestId('hud-capital')).toHaveAttribute('data-capital', '')
  await expect(ada.page.getByTestId('hud-capital')).toContainText('Unclaimed')
  await expect(ada.page.getByTestId('city-hall')).toHaveAttribute('data-capital', '')
  await expect(ada.page.getByTestId('capital-crest')).toHaveCount(0)
  await expect(ada.page.locator('[data-testid^="monument-m"]')).toHaveCount(0)
  await expect(ada.page.getByTestId('play-world-note')).toContainText('Local test construction draws tiers only: it earns no Crown, Capital or monument.')
  await ada.page.screenshot({ path: `${SHOTS}/construction-5-no-civic-award.png` })
  await ada.context.close()
})
