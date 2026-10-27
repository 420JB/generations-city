import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import pg from 'pg'
import { ARCHITECT, claim, designOption, guildFor, installed, openProperty, player, records } from './constructionHelpers'
import { launch, launchHref } from './play'
import { CONSTRUCTION_KEEPER, CONSTRUCTION_PASS, REHEARSAL_ADA, REHEARSAL_BEA, REHEARSAL_CY } from './rehearsal'

/**
 * ARCHITECT PORTFOLIO AND PROPERTY LEGACY (P1-C2-E5A), end to end against a REAL local Proofy Play. READ ONLY: the portfolio
 * groups the player's own Architect record by relationship (controlled now, founded, patron, earlier control) and says each
 * property's saved design; a property's legacy tells its founding, whom the local file names its controller, its control
 * eras, its investment by the current controller, earlier controllers and patrons, the viewer's own part, and its design
 * history by relation, from `GET /v1/play/rehearsal/legacy`. Nothing here writes: every read is a GET, and the stored
 * constructions, designs, credits and city sequence are exactly as they were. LOCAL TEST control only, never verified
 * ownership; no rank, level, XP or reward.
 */
const SHOTS = resolve(import.meta.dirname, '../test-artifacts/city-play-evidence')
mkdirSync(SHOTS, { recursive: true })
const LEGACY = '/v1/play/rehearsal/legacy'
const KEEPER_ID = CONSTRUCTION_KEEPER.slice(CONSTRUCTION_KEEPER.lastIndexOf('/') + 1)
const NEVER = /\b(rank(ed)?|level \d|xp|badge|leaderboard|you own|owned by you|verified owner)\b/i

const databaseUrl = process.env.CITY_PLAY_DATABASE_URL ?? ''
let db: pg.Pool
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: databaseUrl, max: 2 })
})
test.afterAll(async () => {
  await db.end()
})

/** Every read of the portfolio and the legacy the page makes, by method. */
function reads(page: Page) {
  const sent: string[] = []
  page.on('request', (r) => (r.url().includes(LEGACY) || r.url().includes(ARCHITECT)) && sent.push(r.method()))
  return sent
}
/** What a read must leave as it was: the world's constructions, designs, credits and city sequence. */
const stored = async (propertyId: string) => ({
  ...(await records(db).constructionsOf(propertyId).then((c) => ({ constructions: c }))),
  ledger: await records(db).ledger(propertyId),
  designs: (await db.query('SELECT to_jsonb(d) AS r FROM world_property_designs d JOIN world_properties p ON p.world_id = d.world_id WHERE p.id = $1 ORDER BY d.property_id, d.revision', [propertyId])).rows,
  sequence: (await db.query<{ s: string }>('SELECT c.sequence AS s FROM city c JOIN worlds w ON w.city_id = c.id JOIN world_properties p ON p.world_id = w.id WHERE p.id = $1', [propertyId])).rows[0].s,
})

test('the portfolio groups the record by relationship and opens each property\'s legacy; founder, controller, patrons and designs stay apart; reads write nothing', async ({ browser }, testInfo) => {
  test.setTimeout(240_000)
  const { guild } = await installed(guildFor(testInfo, 20))
  // Ada founds her keeper #812 (the file names her its controller) and her Tide Pass #77 (nobody controls it).
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const keeper = await claim(ada.page, CONSTRUCTION_KEEPER)
  const pass = await claim(ada.page, CONSTRUCTION_PASS)
  // Ada builds her keeper to Tier 1 as its owner, and saves a design on it.
  const card = await openProperty(ada.page, keeper.plotId, keeper.buildingId)
  for (let i = 0; i < 2; i++) {
    await card.getByTestId('construction-action').click()
    await expect(card).toHaveAttribute('data-built', String(50 * (i + 1)))
  }
  await ada.page.getByTestId('design-card').getByTestId('design-open').click()
  const design = ada.page.getByTestId('design-panel')
  await expect(design).toHaveAttribute('data-state', 'ready')
  await (await designOption(design, 'design-facade-copper')).click()
  await (await designOption(design, 'design-roof-dome')).click()
  await design.getByTestId('design-save').click()
  await expect(design.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'saved')
  // Bea builds on the keeper as a patron; Cy on the pass, which nobody controls, as a patron too.
  const bea = await player(browser, guild, 'Bea', REHEARSAL_BEA)
  const beaCard = await openProperty(bea.page, keeper.plotId, keeper.buildingId)
  await beaCard.getByTestId('construction-action').click()
  await expect(beaCard).toHaveAttribute('data-built', '150')
  const cy = await player(browser, guild, 'Cy', REHEARSAL_CY)
  const cyCard = await openProperty(cy.page, pass.plotId, pass.buildingId)
  await cyCard.getByTestId('construction-action').click()
  await expect(cyCard).toHaveAttribute('data-built', '50')

  const before = { keeper: await stored(keeper.propertyId), pass: await stored(pass.propertyId) }
  const adaReads = reads(ada.page)

  // Ada's portfolio, from MY PROPERTIES after a reload: grouped totals, and a filter by relationship.
  await ada.page.reload()
  await ada.page.getByTestId('nav-properties').click()
  await ada.page.getByTestId('my-properties-architect').click()
  const portfolio = ada.page.getByTestId('architect-activity')
  await expect(portfolio).toHaveAttribute('data-state', 'ready')
  await expect(portfolio.getByTestId('architect-totals')).toHaveAttribute('data-owner-units', '100')
  await expect(portfolio.getByTestId('architect-totals')).toHaveAttribute('data-patron-units', '0')
  const counts = Object.fromEntries(await Promise.all(['all', 'controlled', 'founded', 'patron', 'earlier'].map(async (k) => [k, await portfolio.getByTestId(`portfolio-filter-${k}`).getAttribute('data-count')])))
  expect(counts).toEqual({ all: '2', controlled: '1', founded: '2', patron: '0', earlier: '0' })
  const items = portfolio.getByTestId('architect-property')
  await expect(items).toHaveCount(2)
  const keeperItem = portfolio.locator(`[data-testid="architect-property"][data-building="${keeper.buildingId}"]`)
  await expect(keeperItem.getByTestId('architect-property-design-summary')).toHaveText('Design: Copper · Dome · Standard grid · Standard lighting · Standard entry · Standard grounds · revision 1')
  await expect(portfolio.locator(`[data-testid="architect-property"][data-building="${pass.buildingId}"]`).getByTestId('architect-property-design-summary')).toHaveText(
    'Design: the standard design every new building starts with',
  )
  // Controlled now: only the keeper. Patron: none, and said so.
  await portfolio.getByTestId('portfolio-filter-controlled').click()
  await expect(portfolio.getByTestId('portfolio-filter-controlled')).toHaveAttribute('aria-pressed', 'true')
  await expect(items).toHaveCount(1)
  await expect(items).toHaveAttribute('data-building', keeper.buildingId)
  await portfolio.getByTestId('portfolio-filter-patron').click()
  await expect(items).toHaveCount(0)
  await expect(portfolio.getByTestId('portfolio-filter-empty')).toHaveText('You have not built on any of these properties as a patron.')
  await portfolio.getByTestId('portfolio-filter-all').click()
  expect(await portfolio.innerText()).not.toMatch(NEVER)
  await ada.page.screenshot({ path: `${SHOTS}/e5a-1-portfolio.png` })

  // The keeper's legacy, from the portfolio: the camera goes to it, the panel takes the keyboard.
  await keeperItem.getByTestId('architect-property-legacy').click()
  const legacy = ada.page.getByTestId('property-legacy')
  await expect(legacy).toHaveAttribute('data-state', 'ready')
  await expect(legacy).toBeFocused()
  // The building it tells stays selected on the map.
  await expect(ada.page.getByTestId('city-svg').getByTestId(`building-${KEEPER_ID}`)).toHaveAttribute('data-selected', 'true')
  await expect(legacy.getByTestId('legacy-founding')).toHaveAttribute('data-founding', 'viewer')
  await expect(legacy.getByTestId('legacy-founding')).toContainText('Founded by you')
  await expect(legacy.getByTestId('legacy-control')).toHaveAttribute('data-control', 'viewer')
  const inv = legacy.getByTestId('legacy-investment')
  for (const [k, v] of Object.entries({ 'data-current-controller': '100', 'data-previous-controllers': '0', 'data-community': '50', 'data-total': '150' })) await expect(inv).toHaveAttribute(k, v)
  await expect(legacy.getByTestId('legacy-contributors')).toHaveText('Built by 1 controller and 1 patron. Tier 1: 100 more lifetime units to Tier 2.')
  await expect(legacy.getByTestId('legacy-yours')).toHaveAttribute('data-owner-units', '100')
  await expect(legacy.getByTestId('legacy-yours')).toHaveAttribute('data-patron-units', '0')
  const eras = legacy.getByTestId('legacy-era')
  await expect(eras).toHaveCount(1)
  await expect(eras).toHaveAttribute('data-current', 'true')
  await expect(eras).toHaveAttribute('data-yours', 'true')
  await expect(eras).toContainText('100 test units by its controller · 50 test units by patrons · 3 steps')
  const revisions = legacy.getByTestId('legacy-design')
  await expect(revisions).toHaveCount(1)
  await expect(revisions).toHaveAttribute('data-catalog', 'architect-design-v4')
  await expect(revisions.getByTestId('legacy-design-by')).toHaveText('Saved by you while test controller')
  await expect(legacy.getByTestId('legacy-thumb')).toHaveAttribute('data-facade', 'copper')
  // Read only: nothing in it builds, saves or spends.
  await expect(legacy.getByTestId('construction-action')).toHaveCount(0)
  await expect(legacy.getByTestId('design-save')).toHaveCount(0)
  expect(await legacy.innerText()).not.toMatch(NEVER)
  await ada.page.screenshot({ path: `${SHOTS}/e5a-2-legacy-controller.png` })
  // Back goes to the portfolio it came from.
  await legacy.getByRole('button', { name: 'Back' }).click()
  await expect(ada.page.getByTestId('architect-activity')).toBeVisible()

  // The pass's legacy: nobody in control, Cy's patron step before any controller was named, Tier 0.
  await portfolio.locator(`[data-testid="architect-property"][data-building="${pass.buildingId}"]`).getByTestId('architect-property-legacy').click()
  await expect(legacy).toHaveAttribute('data-state', 'ready')
  await expect(legacy).toHaveAttribute('data-property-id', pass.propertyId)
  await expect(legacy.getByTestId('legacy-control')).toHaveAttribute('data-control', 'unknown')
  await expect(legacy.getByTestId('legacy-summary')).toHaveAttribute('data-tier', '0')
  await expect(legacy.getByTestId('legacy-era-unattributed')).toHaveAttribute('data-patron-units', '50')
  await expect(legacy.getByTestId('legacy-era-unattributed')).toContainText('While no controller was named')
  await expect(legacy.getByTestId('legacy-era-unattributed')).toContainText('before, between or after the recorded eras')
  await expect(legacy.getByTestId('legacy-eras-caveat')).toContainText('Changes of control without building activity may not appear')
  await expect(legacy.getByTestId('legacy-yours-none')).toBeVisible()
  await expect(legacy.getByTestId('legacy-designs-none')).toBeVisible()

  // Bea, a patron: the keeper's legacy from its panel. Another's founding and control; her own patron step; nobody named.
  const beaReads = reads(bea.page)
  await openProperty(bea.page, keeper.plotId, keeper.buildingId)
  await bea.page.getByTestId('property-legacy-open').click()
  const hers = bea.page.getByTestId('property-legacy')
  await expect(hers).toHaveAttribute('data-state', 'ready')
  await expect(hers.getByTestId('legacy-founding')).toHaveAttribute('data-founding', 'other')
  await expect(hers.getByTestId('legacy-control')).toHaveAttribute('data-control', 'other')
  await expect(hers.getByTestId('legacy-yours')).toHaveAttribute('data-owner-units', '0')
  await expect(hers.getByTestId('legacy-yours')).toHaveAttribute('data-patron-units', '50')
  await expect(hers.getByTestId('legacy-era')).toHaveAttribute('data-yours', 'false')
  await expect(hers.getByTestId('legacy-design-by')).toHaveText('Saved by the player named test controller now, while test controller')
  expect(await hers.innerText()).not.toMatch(/Ada|Cy\b/)
  await bea.page.screenshot({ path: `${SHOTS}/e5a-3-legacy-patron.png` })
  // Back goes to the property's panel.
  await hers.getByRole('button', { name: 'Back' }).click()
  await expect(bea.page.getByTestId('building-panel')).toHaveAttribute('data-building', keeper.buildingId)
  // Her portfolio: a patron of the keeper, never its controller or founder; patron units are not her own building.
  await bea.page.getByTestId('construction-records').getByTestId('construction-architect').click()
  const beaPortfolio = bea.page.getByTestId('architect-activity')
  await expect(beaPortfolio.getByTestId('architect-totals')).toHaveAttribute('data-owner-units', '0')
  await expect(beaPortfolio.getByTestId('architect-totals')).toHaveAttribute('data-patron-units', '50')
  await expect(beaPortfolio.getByTestId('portfolio-filter-patron')).toHaveAttribute('data-count', '1')
  await expect(beaPortfolio.getByTestId('portfolio-filter-controlled')).toHaveAttribute('data-count', '0')
  await expect(beaPortfolio.getByTestId('portfolio-filter-founded')).toHaveAttribute('data-count', '0')
  await expect(beaPortfolio.getByTestId('architect-property-design')).toHaveCount(0)

  // Nothing any of it read was written: GETs only, and every stored record as it was.
  expect(adaReads.length).toBeGreaterThanOrEqual(3)
  expect([...adaReads, ...beaReads].every((m) => m === 'GET')).toBe(true)
  expect({ keeper: await stored(keeper.propertyId), pass: await stored(pass.propertyId) }).toEqual(before)
  for (const p of [ada, bea, cy]) await p.context.close()
})

test('on a phone, by keyboard: the portfolio filter and the legacy are reachable, focused and fit the screen', async ({ browser }, testInfo) => {
  test.setTimeout(180_000)
  const { guild } = await installed(guildFor(testInfo, 21))
  const desktop = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const keeper = await claim(desktop.page, CONSTRUCTION_KEEPER)
  const card = await openProperty(desktop.page, keeper.plotId, keeper.buildingId)
  await card.getByTestId('construction-action').click()
  await expect(card).toHaveAttribute('data-built', '50')
  await desktop.context.close()

  // The same player on a phone-sized screen, signed in again from Play.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  await page.goto(launchHref(await launch(guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await expect(page.getByTestId('city-svg')).toBeVisible()
  await page.getByTestId('nav-properties').click()
  await page.getByTestId('my-properties-architect').focus()
  await page.keyboard.press('Enter')
  const portfolio = page.getByTestId('architect-activity')
  await expect(portfolio).toHaveAttribute('data-state', 'ready')
  await expect(portfolio).toBeFocused()
  // Tab into the filter; Space presses a chip.
  const controlled = portfolio.getByTestId('portfolio-filter-controlled')
  for (let i = 0; i < 40 && !(await controlled.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(controlled).toBeFocused()
  await page.keyboard.press('Space')
  await expect(controlled).toHaveAttribute('aria-pressed', 'true')
  // Tab on to the keeper's LEGACY, Enter opens it, focused.
  const open = portfolio.getByTestId('architect-property-legacy')
  for (let i = 0; i < 40 && !(await open.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(open).toBeFocused()
  await expect(open).toHaveAccessibleName(/^Property legacy of /)
  await page.keyboard.press('Enter')
  const legacy = page.getByTestId('property-legacy')
  await expect(legacy).toHaveAttribute('data-state', 'ready')
  await expect(legacy).toBeFocused()
  await expect(legacy).toHaveAccessibleName(/^Property legacy of /)
  await expect(legacy.getByRole('heading', { level: 3 })).toHaveText(['Founded by you', 'Control now', 'Lifetime investment', 'Your part in it', 'Recorded building eras', 'Design history'])
  await expect(legacy.getByTestId('legacy-bar')).toHaveAttribute('role', 'img')
  // Nothing wider than the screen: no sideways scrolling in the panel or the page.
  const overflow = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="property-legacy"]')!
    return { panel: panel.scrollWidth - panel.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth }
  })
  expect(overflow.panel).toBeLessThanOrEqual(1)
  expect(overflow.page).toBeLessThanOrEqual(1)
  await page.screenshot({ path: `${SHOTS}/e5a-4-legacy-mobile.png`, fullPage: false })
  await legacy.getByRole('button', { name: 'Back' }).click()
  await expect(portfolio).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/e5a-5-portfolio-mobile.png`, fullPage: false })
  await context.close()
})
