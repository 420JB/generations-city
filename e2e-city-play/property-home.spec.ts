import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { BRAND_A, BRAND_B } from './brands'
import { install, launch, launchHref, publish, snowflake } from './play'
import { CAPTAIN, nft, REHEARSAL_ADA, REHEARSAL_BEA, REHEARSAL_CY, RESTRICTED_RULES } from './rehearsal'

/**
 * THE PLAYER'S PROPERTY HOME (P1-C2-E2), end to end against a REAL local Proofy Play, through the
 * LOCAL PROPERTY REHEARSAL: MY PROPERTIES lists the properties the server's permanent record says the
 * session's player founded in this city, each one tap from its panel and the camera; a property's panel
 * keeps its founder apart from whoever holds the NFT now (never known here) and says what surrounds it
 * in the stored city. Nothing here builds, spends or writes: every list and count is read from
 * `GET /v1/play/city`. Test NFTs and rule results are the local file's (`rehearsal.ts`), never Core's.
 */
const SHOTS = resolve(import.meta.dirname, '../test-artifacts/city-play-evidence')
mkdirSync(SHOTS, { recursive: true })

/** Brand A with every district restricted, each by its own Proofy rule (policy D1). */
const ALL_RESTRICTED = { ...BRAND_A, districts: BRAND_A.districts.map((d) => ({ ...d, proofyRule: { verificationRuleId: RESTRICTED_RULES[d.key as keyof typeof RESTRICTED_RULES], label: `${d.name} pass` } })) }

async function installed(config: unknown) {
  const guild = snowflake()
  const installation = await install(guild)
  await publish(guild, installation, config)
  return { guild, installation }
}

async function arrive(page: Page, href: string) {
  await page.goto('about:blank')
  await page.goto(href)
  await expect(page.getByTestId('play-city')).toBeAttached()
  await expect(page.getByTestId('city-svg')).toBeVisible()
  return page.getByTestId('play-city')
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

const card = (page: Page) => page.getByTestId('play-ticket')
const home = (page: Page) => page.getByTestId('my-properties')

/**
 * One whole claim through the page, as a player makes it: the claim card (or MY PROPERTIES) opens the plot choice in the
 * district the server assigned, the player selects the NFT and a highlighted plot, reviews and activates. Returns the
 * plot and building the server stored.
 */
async function claim(page: Page, asset: string, start: () => Promise<void>) {
  await start()
  const panel = page.getByTestId('rehearsal-panel')
  await expect(panel).toBeVisible()
  await page.locator(`[data-asset="${asset}"]`).check()
  await expect(panel).toHaveAttribute('data-assigned', 'yes')
  const plotId = await visiblePlot(page)
  const [, d, ward, plot] = /^(.+)-w(\d+)-p(\d+)$/.exec(plotId)!
  await page.getByTestId(`candidate-plot-${d}-${ward}-${plot}`).click()
  await expect(page.getByTestId('selected-plot')).toHaveAttribute('data-plot-id', plotId)
  await panel.getByTestId('rehearsal-review').click()
  await panel.getByTestId('rehearsal-activate').click()
  const stored = page.getByTestId('building-panel').getByTestId('stored-property')
  await expect(stored).toHaveAttribute('data-plot-id', plotId)
  return { plotId, buildingId: `b-${await stored.getAttribute('data-property-id')}` }
}

const fromCard = (page: Page) => async () => {
  if ((await card(page).getAttribute('data-state')) !== 'held') await card(page).getByTestId('play-ticket-enter').click()
  await expect(card(page)).toHaveAttribute('data-state', 'held')
  await card(page).getByTestId('play-claim-continue').click()
}

async function openHome(page: Page) {
  await page.getByTestId('nav-properties').click()
  await expect(home(page)).toBeVisible()
  await expect(page.getByTestId('nav-properties')).toHaveAttribute('aria-pressed', 'true')
}

/** What MY PROPERTIES lists, in order: each item's plot and NFT. */
const listed = (page: Page) => home(page).getByTestId('my-property').evaluateAll((items) => items.map((i) => ({ plotId: i.getAttribute('data-plot-id'), asset: i.getAttribute('data-asset'), building: i.getAttribute('data-building') })))

const WORDS_OF_OWNERSHIP = /\b(own|owns|owned|owner|owners|ownership|yours)\b/i

test('a new player has no properties yet: MY PROPERTIES says so plainly and offers the one next step, the claim', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  const city = await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Cy', REHEARSAL_CY)))
  await expect(city).toHaveAttribute('data-founded', '0')
  await expect(page.getByTestId('nav-properties')).toHaveAttribute('data-count', '0')
  await expect(page.getByTestId('nav-properties')).toHaveAccessibleName('My properties: 0 founded')
  await openHome(page)
  await expect(home(page)).toHaveAttribute('data-count', '0')
  await expect(home(page)).toBeFocused()
  await expect(page.getByTestId('my-properties-list')).toHaveCount(0)
  await expect(page.getByTestId('my-properties-empty')).toHaveText('You have not founded a property in Harborlight yet. When you activate an NFT on a plot, it is recorded here for good.')
  // Entry assigned a district: the one next step is to continue that claim.
  await expect(page.getByTestId('my-properties-claim')).toHaveText('Continue claim')
  await page.screenshot({ path: `${SHOTS}/home-1-empty.png` })

  // A player the local server lists nothing for sees the same empty home, with nothing to claim.
  const otherContext = await browser.newContext()
  const other = await otherContext.newPage()
  await arrive(other, launchHref(await launch(a.guild, 'rare-city', 'Visitor', snowflake())))
  await expect(other.getByTestId('play-city')).toHaveAttribute('data-rehearsal', 'off')
  await openHome(other)
  await expect(other.getByTestId('my-properties-empty')).toBeVisible()
  await expect(other.getByTestId('my-properties-claim')).toHaveCount(0)
  await context.close()
  await otherContext.close()
})

test('one activation, then a second: MY PROPERTIES lists both, most recent first, each with its NFT, district and exact plot; WARP inspects and flies there; a reload keeps them', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  const city = await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))

  const keeper = nft(BRAND_A, 'harbor-keepers', '812')
  const first = await claim(page, keeper, fromCard(page))
  // Straight after the activation: the property's panel, with its founder (the player) kept apart from its holder (not known).
  const building = page.getByTestId('building-panel')
  await expect(building).toHaveAttribute('data-building', first.buildingId)
  await expect(building.getByTestId('property-founder')).toHaveText('You')
  await expect(building.getByTestId('property-holder')).toHaveText('Not verified')
  await expect(building.getByTestId('stored-property-order')).toHaveText('The 1st property founded in Harborlight.')
  await expect(page.getByTestId('play-claimed')).toContainText('✓ Property activated: Harbor Keepers #812')
  await expect(page.getByTestId('nav-properties')).toHaveAttribute('data-count', '1')
  // Its back arrow leads to MY PROPERTIES.
  await building.getByRole('button', { name: 'Back' }).click()
  await expect(home(page)).toHaveAttribute('data-count', '1')
  expect(await listed(page)).toEqual([{ plotId: first.plotId, asset: keeper, building: first.buildingId }])

  // A second NFT, from MY PROPERTIES itself.
  const pass = nft(BRAND_A, 'tide-pass', '77')
  await expect(page.getByTestId('my-properties-claim')).toHaveText('Claim another NFT')
  const second = await claim(page, pass, () => page.getByTestId('my-properties-claim').click())
  await expect(city).toHaveAttribute('data-founded', '2')
  await openHome(page)
  expect(await listed(page)).toEqual([
    { plotId: second.plotId, asset: pass, building: second.buildingId },
    { plotId: first.plotId, asset: keeper, building: first.buildingId },
  ])
  const item = home(page).getByTestId('my-property').last()
  await expect(item.getByTestId('my-property-name')).toHaveText('Harbor Keepers #812')
  const [, , ward, plot] = /^(.+)-w(\d+)-p(\d+)$/.exec(first.plotId)!
  await expect(item.getByTestId('my-property-address')).toContainText(`Lantern Quay District · Ward ${['I', 'II', 'III'][Number(ward)]} · Plot ${Number(plot) + 1}`)
  await expect(item).toContainText(first.plotId)
  await page.screenshot({ path: `${SHOTS}/home-2-two-properties.png` })

  // WARP from the list: from the city overview, the camera flies to the property and its panel opens with its exact address.
  await page.getByTestId('nav-overview').click()
  await still(page)
  const overview = await page.getByTestId('city-svg').getAttribute('viewBox')
  await item.getByTestId('my-property-view').click()
  await expect(building).toHaveAttribute('data-building', first.buildingId)
  await expect(page.getByTestId('drawer')).toBeFocused()
  await expect(building.getByTestId('stored-property')).toHaveAttribute('data-asset', keeper)
  await expect(building.getByTestId('building-address')).toContainText(first.plotId)
  await still(page)
  expect(await page.getByTestId('city-svg').getAttribute('viewBox')).not.toBe(overview)
  // The property is on screen, not behind the drawer.
  const box = await page.getByTestId('building-812').boundingBox()
  const drawer = (await page.getByTestId('drawer').boundingBox())!
  expect(box).not.toBeNull()
  expect(box!.x + box!.width / 2).toBeLessThan(drawer.x)
  expect(box!.y + box!.height / 2).toBeGreaterThan(0)
  expect(box!.y + box!.height / 2).toBeLessThan(900)
  // Same district: the other property counts in it; the city counts both.
  const context2 = building.getByTestId('property-context')
  await expect(context2).toHaveAttribute('data-city-properties', '2')
  await page.screenshot({ path: `${SHOTS}/home-3-detail.png` })

  // A reload reads everything again from the server: the same two properties, in the same order.
  await page.reload()
  await expect(city).toHaveAttribute('data-source', 'session')
  await expect(city).toHaveAttribute('data-founded', '2')
  await openHome(page)
  expect((await listed(page)).map((p) => p.building)).toEqual([second.buildingId, first.buildingId])
  await context.close()
})

test('founding is not holding: another player who lists the same NFT sees the property as founded privately, with its holder unverified, and never in their own list', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const adaContext = await browser.newContext()
  const ada = await adaContext.newPage()
  await arrive(ada, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  // Bea's local file lists Harbor Keepers #812 too: Ada founds it first.
  const keeper = nft(BRAND_A, 'harbor-keepers', '812')
  const founded = await claim(ada, keeper, fromCard(ada))
  // Nothing Ada reads anywhere calls her its owner.
  await ada.getByTestId('building-panel').getByRole('button', { name: 'Back' }).click()
  expect(await ada.getByTestId('drawer').innerText()).not.toMatch(WORDS_OF_OWNERSHIP)
  await ada.getByTestId('my-property-view').click()
  expect(await ada.getByTestId('drawer').innerText()).not.toMatch(WORDS_OF_OWNERSHIP)

  const beaContext = await browser.newContext()
  const bea = await beaContext.newPage()
  const city = await arrive(bea, launchHref(await launch(a.guild, 'rare-city', 'Bea', REHEARSAL_BEA)))
  await expect(city).toHaveAttribute('data-founded', '0')
  await openHome(bea)
  await expect(home(bea)).toHaveAttribute('data-count', '0')
  await expect(bea.getByTestId('my-property')).toHaveCount(0)
  // Her view of the property: founded, by someone she is not told of; held by whoever holds it, which nobody here checks.
  // She finds it as anyone would: in its district's panel.
  const district = /^(.+)-w\d+-p\d+$/.exec(founded.plotId)![1]
  await bea.getByTestId('nav-districts').click()
  await bea.getByTestId(`dtab-${district}`).click()
  await bea.getByTestId(`warp-${founded.buildingId}`).click()
  const building = bea.getByTestId('building-panel')
  await expect(building).toHaveAttribute('data-building', founded.buildingId)
  await expect(building.getByTestId('property-founder')).toHaveText('Recorded privately')
  await expect(building.getByTestId('property-holder')).toHaveText('Not verified')
  await expect(building.getByTestId('stored-property-activator')).toHaveAttribute('data-activated-by-viewer', 'false')
  await expect(building.getByRole('button', { name: 'Back' })).toHaveCount(0)
  expect(await bea.getByTestId('drawer').innerText()).not.toMatch(/Ada/)
  await bea.screenshot({ path: `${SHOTS}/home-4-founded-by-another.png` })
  await adaContext.close()
  await beaContext.close()
})

test('each installation\'s city lists only its own foundings: one player, two Discord servers, and a relaunch that keeps the record', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const b = await installed(BRAND_B)
  const context = await browser.newContext()
  const page = await context.newPage()
  const cityA = await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  const worldA = await cityA.getAttribute('data-world')
  const inA = await claim(page, nft(BRAND_A, 'harbor-keepers', '812'), fromCard(page))

  // The same player launches the other server's city: none of the first city's properties are listed or drawn there.
  const cityB = await arrive(page, launchHref(await launch(b.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  expect(await cityB.getAttribute('data-world')).not.toBe(worldA)
  await expect(cityB).toHaveAttribute('data-founded', '0')
  await openHome(page)
  await expect(home(page)).toHaveAttribute('data-count', '0')
  await expect(page.getByTestId(`building-812`)).toHaveCount(0)
  const sprite = nft(BRAND_B, 'orchard-sprites', '1')
  const inB = await claim(page, sprite, fromCard(page))
  await openHome(page)
  expect(await listed(page)).toEqual([{ plotId: inB.plotId, asset: sprite, building: inB.buildingId }])

  // A new launch into the first city (a new session) still lists the property founded there: the record is the player's, not the session's.
  const again = await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  expect(await again.getAttribute('data-world')).toBe(worldA)
  await expect(again).toHaveAttribute('data-founded', '1')
  await openHome(page)
  expect(await listed(page)).toEqual([{ plotId: inA.plotId, asset: nft(BRAND_A, 'harbor-keepers', '812'), building: inA.buildingId }])
  await context.close()
})

test('a property placed by rule in an all-restricted city is listed with its restricted district; browsing the home builds, spends and writes nothing', async ({ browser }) => {
  const a = await installed(ALL_RESTRICTED)
  const context = await browser.newContext()
  const page = await context.newPage()
  const city = await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  // Every district restricted: no district until the NFT is selected, and the home's step says so.
  await expect(card(page)).toHaveAttribute('data-state', 'awaiting-asset')
  await openHome(page)
  await expect(page.getByTestId('my-properties-claim')).toHaveText('Select your test NFT')
  const placed = await claim(page, CAPTAIN, () => page.getByTestId('my-properties-claim').click())
  expect(placed.plotId).toMatch(/^tidewater-w0-p\d+$/)
  await openHome(page)
  await expect(home(page).getByTestId('my-property')).toHaveAttribute('data-plot-id', placed.plotId)
  await expect(home(page).getByTestId('my-property-address')).toContainText('Tidewater District')

  // From here on, the page only reads: every panel of the home, a neighbour-less district, another district, back again.
  const sequence = await city.getAttribute('data-world-sequence')
  const writes: string[] = []
  page.on('request', (r) => {
    if (r.method() !== 'GET') writes.push(`${r.method()} ${r.url()}`)
  })
  await home(page).getByTestId('my-property-view').click()
  const building = page.getByTestId('building-panel')
  await expect(building.getByTestId('construction-note')).toContainText('Building upward is not open in this city yet')
  await expect(building.getByTestId('build-action')).toHaveCount(0)
  await expect(building.getByRole('progressbar')).toHaveCount(0)
  await expect(building.getByTestId('property-neighbours-none')).toHaveText('The only property in Tidewater so far.')
  await expect(building.getByTestId('explore-lantern-quay')).toHaveAttribute('data-properties', '0')
  await building.getByTestId('explore-lantern-quay').click()
  await expect(page.getByTestId('district-panel')).toHaveAttribute('data-district', 'lantern-quay')
  await openHome(page)
  await home(page).getByTestId('my-property-view').click()
  await expect(building).toHaveAttribute('data-building', placed.buildingId)
  await page.reload()
  await expect(city).toHaveAttribute('data-founded', '1')
  expect(writes).toEqual([])
  await expect(city).toHaveAttribute('data-world-sequence', sequence!)
  await context.close()
})

test('on a phone-width screen the home opens from the HUD icon, lists the property and flies to it', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  // Claim on the wide layout's flow, then look at the home as a phone shows it.
  await page.setViewportSize({ width: 1440, height: 900 })
  const placed = await claim(page, nft(BRAND_A, 'harbor-keepers', '812'), fromCard(page))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByTestId('drawer').getByLabel('Close panel').click()
  const nav = page.getByTestId('nav-properties')
  await expect(nav).toBeVisible()
  await expect(nav).toHaveAccessibleName('My properties: 1 founded')
  await nav.click()
  await expect(home(page)).toBeVisible()
  const width = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: `${SHOTS}/home-5-phone.png` })
  // Keyboard: the panel has focus; Tab reaches its WARP, and Enter flies there.
  await expect(home(page)).toBeFocused()
  const warp = home(page).getByTestId('my-property-view')
  for (let i = 0; i < 6 && !(await warp.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(warp).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', placed.buildingId)
  await page.screenshot({ path: `${SHOTS}/home-6-phone-detail.png` })
  await context.close()
})
