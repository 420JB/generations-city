import { expect, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test'
import pg from 'pg'
import { BRAND_A } from './brands'
import { install, launch, launchHref, publish } from './play'
import { constructionGuilds } from './rehearsal'

/** What the construction specs share: a player's page on a construction city, a claim through the page, and the stored records. */
export const CONSTRUCTIONS = '/v1/play/rehearsal/constructions'
export const ARCHITECT = '/v1/play/rehearsal/architect'

/** This test's own construction Discord server: slot `slot`, `n` of its two (each test, and each of up to five repetitions, founds its own cities). */
export function guildFor(testInfo: TestInfo, slot: number, n = 0) {
  const guilds = constructionGuilds()
  const index = slot * 10 + testInfo.repeatEachIndex * 2 + n
  if (index >= guilds.length) throw new Error('not enough construction Discord servers for this run')
  return guilds[index]
}

export async function installed(guild: string) {
  const installation = await install(guild)
  await publish(guild, installation, BRAND_A)
  return { guild, installation }
}

export async function arrive(page: Page, href: string) {
  await page.goto('about:blank')
  await page.goto(href)
  await expect(page.getByTestId('play-city')).toBeAttached()
  await expect(page.getByTestId('city-svg')).toBeVisible()
  return page.getByTestId('play-city')
}

export async function player(browser: Browser, guild: string, name: string, discordUserId: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const city = await arrive(page, launchHref(await launch(guild, 'rare-city', name, discordUserId)))
  return { context, page, city }
}

/** Until the camera stops moving. */
export async function still(page: Page) {
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
export async function claim(page: Page, asset: string) {
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
export async function openProperty(page: Page, plotId: string, buildingId: string) {
  await page.getByTestId('nav-districts').click()
  await page.getByTestId(`dtab-${/^(.+)-w\d+-p\d+$/.exec(plotId)![1]}`).click()
  await page.getByTestId(`warp-${buildingId}`).click()
  await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', buildingId)
  const card = page.getByTestId('construction-card')
  await expect(card).toHaveAttribute('data-state', 'ready')
  return card
}

/** Every construction request the page sends, as sent. */
export function presses(page: Page) {
  const sent: Record<string, unknown>[] = []
  page.on('request', (r) => r.url().endsWith(CONSTRUCTIONS) && r.method() === 'POST' && sent.push(r.postDataJSON()))
  return sent
}

/** The stored records of a property's world, read straight from the disposable database. */
export function records(db: pg.Pool) {
  return {
    constructionsOf: async (propertyId: string) =>
      (
        await db.query<{ property_id: string; action_id: string; recipe: string; role: string; units: number; built_after: number; tier_after: number; contributor_discord_user_id: string }>(
          `SELECT c.property_id, c.action_id, c.recipe, c.role, c.units, c.built_after, c.tier_after, c.contributor_discord_user_id
             FROM world_property_constructions c WHERE c.property_id = $1 ORDER BY c.sequence`,
          [propertyId],
        )
      ).rows,
    ledger: async (propertyId: string) =>
      (
        await db.query<{ account: string; kind: string; delta: number; balance_after: number }>(
          `SELECT t.account_discord_user_id AS account, t.kind, t.delta, t.balance_after FROM world_test_credit_entries t JOIN world_properties p ON p.world_id = t.world_id
            WHERE p.id = $1 ORDER BY t.account_discord_user_id, t.entry_seq`,
          [propertyId],
        )
      ).rows,
  }
}

/**
 * A building's drawn height in the city's own coordinates, on a freshly loaded page once its camera is still: the same
 * overview every time, so two heights compare one drawing of the building with another, not two levels of detail.
 */
export async function drawnHeight(page: Page, friendId: string) {
  await page.reload()
  await expect(page.getByTestId('city-svg')).toBeVisible()
  await still(page)
  return page.getByTestId(`building-${friendId}`).evaluate((g) => (g as SVGGraphicsElement).getBBox().height)
}

/** The Architect design view's tab for each category (P1-C2-E4C): a category's options are shown while its tab is chosen. */
const DESIGN_GROUPS: Readonly<Record<string, string>> = { facade: 'building', roof: 'building', windows: 'details', lighting: 'details', entrance: 'street', landscaping: 'street' }

/** One option of the design view (`design-<category>-<id>`), with its category's tab chosen first. */
export async function designOption(panel: Locator, testId: string) {
  const category = /^design-([a-z]+)-/.exec(testId)?.[1] ?? ''
  if (!Object.hasOwn(DESIGN_GROUPS, category)) throw new Error(`not a design option: ${testId}`)
  const tab = panel.getByTestId(`design-tab-${DESIGN_GROUPS[category]}`)
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  return panel.getByTestId(testId)
}
