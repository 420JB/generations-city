import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { BRAND_A, BRAND_B } from './brands'
import { install, launch, launchHref, publish, snowflake } from './play'
import { MAX_UINT256, nft, REHEARSAL_ADA, REHEARSAL_BEA } from './rehearsal'

/**
 * THE LOCAL PROPERTY REHEARSAL, end to end, against a REAL local Proofy Play (P1-C2-B2B): a
 * launched player chooses one of their LOCAL TEST NFTs, a district and an exact plot on the
 * standard city renderer, reviews what is permanent, and activates a Tier 0 property. The server
 * (APP_MODE=local, started with the rehearsal file by serve.ts) decides everything again. Then
 * the page, a reload, a relaunch and another player all show the same stored property.
 *
 * Test NFTs come from `rehearsal.ts`, never from a wallet or Proofy: the page says so.
 */
const SHOTS = resolve(import.meta.dirname, '../test-artifacts/city-play-evidence')
mkdirSync(SHOTS, { recursive: true })

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

/** Open a district's plot choice as the launched player. */
async function choosePlotIn(page: Page, district: string) {
  await page.getByTestId('nav-overview').click()
  await still(page)
  await page.getByTestId(`district-label-${district}`).click()
  await expect(page.getByTestId('district-panel')).toHaveAttribute('data-district', district)
  await expect(page.getByTestId('choose-plot')).toHaveText('Choose a plot · local rehearsal')
  await page.getByTestId('choose-plot').click()
  await expect(page.getByTestId('rehearsal-panel')).toBeVisible()
  await expect(page.getByTestId('placement-layer')).toHaveAttribute('data-district', district)
  await still(page)
}

/** Pick a highlighted plot by its plot id. */
async function pick(page: Page, plotId: string) {
  const [, district, ward, plot] = /^(.+)-w(\d+)-p(\d+)$/.exec(plotId)!
  await page.getByTestId(`candidate-plot-${district}-${ward}-${plot}`).click()
  await expect(page.getByTestId('selected-plot')).toHaveAttribute('data-plot-id', plotId)
}

/** The rehearsal route, asked directly from the page with its own cookie, naming the actor the page drew. */
async function placeByApi(page: Page, asset: string, plotId: string, override: Record<string, string> = {}) {
  const city = page.getByTestId('play-city')
  const body = {
    sessionRef: await city.getAttribute('data-session-ref'),
    worldId: await city.getAttribute('data-world'),
    discordUserId: await city.getAttribute('data-player'),
    asset,
    plotId,
    geometryFingerprint: await city.getAttribute('data-geometry-fingerprint'),
    ...override,
  }
  return page.evaluate(async (b) => {
    const r = await fetch('/v1/play/rehearsal/activations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b), credentials: 'same-origin' })
    return { status: r.status, body: (await r.json()) as Record<string, unknown> }
  }, body)
}

test('a player places a test NFT on the exact plot they chose; reload, relaunch and another player see the same permanent property', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  const city = await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await expect(city).toHaveAttribute('data-rehearsal', 'local')
  await expect(city).toHaveAttribute('data-buildings', '0')
  // Marked as local rehearsal data wherever it shows.
  await expect(page.getByTestId('play-rehearsal-flag')).toHaveText('LOCAL REHEARSAL · TEST NFTS')
  await expect(page.getByTestId('preview-bar').getByTestId('rehearsal-flag')).toContainText('not verified NFT holdings')
  await expect(page.getByTestId('play-world-note')).toContainText('lists 3 test NFTs for you (0 placed)')

  // A district with a Proofy rule cannot take one: nothing can check the rule.
  await page.getByTestId('district-label-compass-row').click()
  await expect(page.getByTestId('choose-plot')).toBeDisabled()

  await choosePlotIn(page, 'tidewater')
  const panel = page.getByTestId('rehearsal-panel')
  await expect(panel.getByTestId('rehearsal-flag')).toContainText('LOCAL REHEARSAL')
  // Exactly this city's test NFTs for Ada (three of her six are another city's), each marked TEST NFT.
  const nfts = panel.getByTestId('rehearsal-nft')
  await expect(nfts).toHaveCount(3)
  await expect(panel.locator('.rehearsal-nft .sim-tag')).toHaveText(['TEST NFT', 'TEST NFT', 'TEST NFT'])
  await expect(panel.locator('.rehearsal-nft').first()).toContainText(`Harbor Keepers #${MAX_UINT256}`)
  await panel.locator(`[data-asset="${nft(BRAND_A, 'harbor-keepers', MAX_UINT256)}"]`).check()
  await expect(panel.getByTestId('rehearsal-district')).toHaveAttribute('data-district', 'tidewater')
  // The highlighted plots are exactly the engine's free plots of the district.
  const free = Number(await panel.getByTestId('rehearsal-candidates').getAttribute('data-count'))
  await expect(page.locator('[data-testid^="candidate-plot-tidewater-"]')).toHaveCount(free)
  await expect(panel.getByTestId('rehearsal-review')).toBeDisabled()
  await pick(page, 'tidewater-w0-p3')
  await page.screenshot({ path: `${SHOTS}/rehearsal-1-plot-selected.png` })
  await panel.getByTestId('rehearsal-review').click()
  const confirm = panel.getByTestId('rehearsal-confirm')
  await expect(confirm).toContainText('This is permanent')
  await expect(confirm).toContainText(`Harbor Keepers #${MAX_UINT256} becomes a Tier 0 property on tidewater-w0-p3`)
  await expect(confirm).toContainText('never be moved, replaced or removed')
  await page.screenshot({ path: `${SHOTS}/rehearsal-2-confirm.png` })
  await panel.getByTestId('rehearsal-activate').click()

  // The page reads the city again and warps to the new property; its panel shows what the city stores.
  await expect(page.getByTestId('preview-notice')).toContainText(`Property activated: Harbor Keepers #${MAX_UINT256} · city sequence 2`)
  await expect(city).toHaveAttribute('data-world-sequence', '2')
  await expect(city).toHaveAttribute('data-buildings', '1')
  const building = page.getByTestId('building-panel')
  await expect(building).toBeVisible()
  await expect(building.locator('h2')).toHaveText(`Harbor Keepers #${MAX_UINT256}`)
  await expect(building.getByTestId('panel-tier')).toContainText('0')
  const stored = building.getByTestId('stored-property')
  await expect(stored).toHaveAttribute('data-asset', nft(BRAND_A, 'harbor-keepers', MAX_UINT256))
  await expect(stored).toHaveAttribute('data-plot-id', 'tidewater-w0-p3')
  await expect(stored).toHaveAttribute('data-sequence', '2')
  // The permanent original activator, as this player is told it (0008).
  await expect(building.getByTestId('stored-property-activator')).toHaveAttribute('data-activated-by-viewer', 'true')
  const propertyId = (await stored.getAttribute('data-property-id'))!
  const buildingId = `b-${propertyId}`
  await expect(building).toHaveAttribute('data-building', buildingId)
  // The map label shows the whole uint256 token id (L4), never a rounded number.
  await expect(page.locator(`[id="bl-${buildingId}"]`)).toContainText(`#${MAX_UINT256} · T0`)
  await page.screenshot({ path: `${SHOTS}/rehearsal-3-activated.png` })
  await expect(page.getByTestId('play-world-note')).toContainText('(1 placed)')

  // A duplicate confirmation is the same property, not a second one.
  const again = await placeByApi(page, nft(BRAND_A, 'harbor-keepers', MAX_UINT256), 'tidewater-w0-p3')
  expect(again.status).toBe(200)
  expect(again.body).toMatchObject({ fresh: false, sequence: 2, property: { id: propertyId } })
  expect(JSON.stringify(again.body)).not.toContain((await city.getAttribute('data-session-ref'))!)

  // Reload: the same stored property, from the session.
  await page.reload()
  await expect(city).toHaveAttribute('data-source', 'session')
  await expect(city).toHaveAttribute('data-world-sequence', '2')
  await page.getByTestId('district-label-tidewater').click()
  await page.getByTestId(`warp-${buildingId}`).click()
  await expect(page.getByTestId('stored-property')).toHaveAttribute('data-property-id', propertyId)

  // Relaunch from Proofy Play: the same world, the same property.
  const world = await city.getAttribute('data-world')
  await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await expect(city).toHaveAttribute('data-world', world!)
  await expect(city).toHaveAttribute('data-world-created', 'false')
  await expect(city).toHaveAttribute('data-buildings', '1')

  // Another player of the same server sees exactly the same city, and cannot take the plot or the NFT.
  const other = await browser.newContext()
  const bea = await other.newPage()
  const theirs = await arrive(bea, launchHref(await launch(a.guild, 'rare-city', 'Bea', REHEARSAL_BEA)))
  await expect(theirs).toHaveAttribute('data-world', world!)
  await expect(theirs).toHaveAttribute('data-buildings', '1')
  await bea.getByTestId('district-label-tidewater').click()
  await bea.getByTestId(`warp-${buildingId}`).click()
  await expect(bea.getByTestId('stored-property')).toHaveAttribute('data-property-id', propertyId)
  await expect(bea.getByTestId('stored-property-activator')).toHaveAttribute('data-activated-by-viewer', 'false')
  await bea.screenshot({ path: `${SHOTS}/rehearsal-4-other-player.png` })
  expect(await placeByApi(bea, nft(BRAND_A, 'tide-pass', '5'), 'tidewater-w0-p3')).toEqual({ status: 409, body: { error: 'plot_unavailable' } })
  // The occupied plot is not offered to her either.
  await choosePlotIn(bea, 'tidewater')
  await expect(bea.getByTestId('candidate-plot-tidewater-0-3')).toHaveCount(0)
  // Ada's NFT is not listed for Bea; Bea's #812 is also listed for Ada, but placed by Bea it is hers.
  expect(await placeByApi(bea, nft(BRAND_A, 'harbor-keepers', MAX_UINT256), 'tidewater-w0-p4')).toEqual({ status: 403, body: { error: 'rehearsal_asset_not_granted' } })
  expect((await placeByApi(bea, nft(BRAND_A, 'harbor-keepers', '812'), 'tidewater-w0-p4')).status).toBe(200)
  expect(await placeByApi(page, nft(BRAND_A, 'harbor-keepers', '812'), 'tidewater-w0-p4')).toEqual({ status: 409, body: { error: 'asset_already_placed' } })
  // Naming Bea's session from Ada's browser does nothing as Bea.
  const beaCity = bea.getByTestId('play-city')
  expect(await placeByApi(page, nft(BRAND_A, 'tide-pass', '77'), 'tidewater-w0-p5', { sessionRef: (await beaCity.getAttribute('data-session-ref'))!, discordUserId: REHEARSAL_BEA })).toEqual({ status: 409, body: { error: 'play_actor_mismatch' } })
  await context.close()
  await other.close()
})

test('two players choose the same plot: one property, and the other is told and shown the city as it is now', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const ada = await ctxA.newPage()
  const bea = await ctxB.newPage()
  await arrive(ada, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  const beaCity = await arrive(bea, launchHref(await launch(a.guild, 'rare-city', 'Bea', REHEARSAL_BEA)))
  for (const p of [ada, bea]) {
    await choosePlotIn(p, 'lantern-quay')
    await pick(p, 'lantern-quay-w0-p1')
  }
  await ada.getByTestId('rehearsal-nft').first().check()
  await bea.getByTestId('rehearsal-nft').first().check()
  await ada.getByTestId('rehearsal-review').click()
  await bea.getByTestId('rehearsal-review').click()
  await ada.getByTestId('rehearsal-activate').click()
  await expect(ada.getByTestId('stored-property')).toHaveAttribute('data-plot-id', 'lantern-quay-w0-p1')
  await bea.getByTestId('rehearsal-activate').click()
  await expect(bea.getByTestId('rehearsal-error')).toHaveText('Someone placed a property on that plot first. The city has been updated: choose another plot.')
  // Bea's page now shows Ada's property, no longer offers the plot, and dropped her selection.
  await expect(beaCity).toHaveAttribute('data-buildings', '1')
  await expect(bea.getByTestId('candidate-plot-lantern-quay-0-1')).toHaveCount(0)
  await expect(bea.getByTestId('no-plot-selected')).toBeVisible()
  await bea.screenshot({ path: `${SHOTS}/rehearsal-5-plot-taken.png` })
  // She picks another plot and places hers.
  await pick(bea, 'lantern-quay-w0-p2')
  await bea.getByTestId('rehearsal-review').click()
  await bea.getByTestId('rehearsal-activate').click()
  await expect(beaCity).toHaveAttribute('data-buildings', '2')
  await expect(bea.getByTestId('stored-property')).toHaveAttribute('data-plot-id', 'lantern-quay-w0-p2')
  await ctxA.close()
  await ctxB.close()
})

test('several collections in one city; another community\'s city cannot be written from this session', async ({ browser }) => {
  const b = await installed(BRAND_B)
  const other = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  const city = await arrive(page, launchHref(await launch(b.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await expect(page.getByTestId('play-world-note')).toContainText('lists 3 test NFTs for you (0 placed)')
  const placements: [string, string][] = [
    [nft(BRAND_B, 'orchard-sprites', '1'), 'plum-arcade-w0-p0'],
    [nft(BRAND_B, 'neon-seeds', '9007199254740993'), 'kiwi-docks-w0-p2'],
    [nft(BRAND_B, 'grove-pass', '3'), 'citrus-strand-w0-p4'],
  ]
  for (const [asset, plotId] of placements) {
    await choosePlotIn(page, plotId.replace(/-w\d+-p\d+$/, ''))
    await page.locator(`[data-asset="${asset}"]`).check()
    await pick(page, plotId)
    await page.getByTestId('rehearsal-review').click()
    await page.getByTestId('rehearsal-activate').click()
    await expect(page.getByTestId('stored-property')).toHaveAttribute('data-asset', asset)
  }
  await expect(city).toHaveAttribute('data-buildings', '3')
  await expect(city).toHaveAttribute('data-world-sequence', '4')
  // 2^53 + 1 is shown exactly, never as 2^53.
  await expect(page.getByTestId('building-panel').locator('h2')).toHaveText('Grove Pass #3')
  await page.getByTestId('nav-overview').click()
  await still(page)
  await page.getByTestId('district-label-kiwi-docks').click()
  await page.locator('[data-testid^="warp-b-"]').first().click()
  await expect(page.getByTestId('building-panel').locator('h2')).toHaveText('Neon Seeds #9007199254740993')
  await page.screenshot({ path: `${SHOTS}/rehearsal-6-three-collections.png` })
  // The same NFT again, on another plot: one NFT, one property.
  expect(await placeByApi(page, nft(BRAND_B, 'grove-pass', '3'), 'pear-commons-w0-p0')).toEqual({ status: 409, body: { error: 'asset_already_placed' } })

  // Another community's city: Ada's session there is a different session; this page's session cannot name that world.
  const otherContext = await browser.newContext()
  const outsider = await otherContext.newPage()
  const otherCity = await arrive(outsider, launchHref(await launch(other.guild, 'rare-city', 'Bea', REHEARSAL_BEA)))
  const otherWorld = (await otherCity.getAttribute('data-world'))!
  expect(await placeByApi(page, nft(BRAND_A, 'harbor-keepers', '812'), 'tidewater-w0-p0', { worldId: otherWorld })).toEqual({ status: 409, body: { error: 'play_actor_mismatch' } })
  // The other city's collections are not this city's, on its plots or on this city's.
  expect(await placeByApi(page, nft(BRAND_A, 'harbor-keepers', '812'), 'tidewater-w0-p0')).toEqual({ status: 422, body: { error: 'asset_not_in_world' } })
  expect(await placeByApi(page, nft(BRAND_A, 'harbor-keepers', '812'), 'plum-arcade-w0-p9')).toEqual({ status: 422, body: { error: 'asset_not_in_world' } })
  await outsider.reload()
  await expect(otherCity).toHaveAttribute('data-buildings', '0')
  await context.close()
  await otherContext.close()
})
