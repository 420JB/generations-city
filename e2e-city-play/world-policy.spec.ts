import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { BRAND_A } from './brands'
import { install, launch, launchHref, publish, snowflake } from './play'
import { DUNE_DOCK, nft, REHEARSAL_ADA, REHEARSAL_BEA } from './rehearsal'

/**
 * THE LOCKED WORLD POLICIES (P1-C2-B2C, migration 0008), end to end against a REAL local Proofy
 * Play, through the LOCAL PROPERTY REHEARSAL:
 *   - a city's district geometry follows its configuration until its FIRST PROPERTY, which freezes
 *     it; later configurations that move districts are refused, presentation changes still govern;
 *   - every property records its ORIGINAL ACTIVATOR (the Proofy player of the activating session),
 *     which outlives sign-out and relaunch and is never shown to anyone else;
 *   - (P1-C2-B2C-H) a plot chosen on districts that have since changed is refused and chosen again,
 *     and a city's first property waits for the configuration Play has active to be launched;
 *   - (P1-C2-D1) every placement is in the district the server assigned (a district ticket); a
 *     configuration that redraws an empty city's districts supersedes and reissues the tickets.
 * Local dev-issued Play runs stand in for Proofy Core here: nothing in this file is evidence of a
 * production Core identity integration.
 */
const SHOTS = resolve(import.meta.dirname, '../test-artifacts/city-play-evidence')
mkdirSync(SHOTS, { recursive: true })

const district = (key: string, name: string, accent: string) => ({ key, name, accent, monument: null, proofyRule: null })
/** Brand A with two more districts: the same collections, six wedges instead of four. */
const BRAND_A_SIX = { ...BRAND_A, districts: [...BRAND_A.districts, district('reef', 'Reef', '#e76f51'), district('dune', 'Dune', '#e9c46a')] }

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

async function refused(page: Page, href: string, code: string) {
  await page.goto('about:blank')
  await page.goto(href)
  await expect(page.getByTestId('play-gate')).toHaveAttribute('data-code', code)
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

/**
 * Choose a listed test NFT and an exact plot on the page, as a player does, up to the permanent confirmation: in the
 * district the server assigned (for an NFT an explicit rule assigns, the server moves the placement there first).
 */
async function choose(page: Page, asset: string, plotId: string) {
  const [, districtKey, ward, plot] = /^(.+)-w(\d+)-p(\d+)$/.exec(plotId)!
  const assigned = (await page.getByTestId('play-city').getAttribute('data-ticket-district'))!
  await page.getByTestId('nav-overview').click()
  await still(page)
  await page.getByTestId(`district-label-${assigned}`).click()
  await page.getByTestId('choose-plot').click()
  await expect(page.getByTestId('rehearsal-panel')).toBeVisible()
  await page.locator(`[data-asset="${asset}"]`).check()
  await expect(page.getByTestId('rehearsal-panel')).toHaveAttribute('data-assigned', 'yes')
  await expect(page.getByTestId('placement-layer')).toHaveAttribute('data-district', districtKey)
  await still(page)
  await page.getByTestId(`candidate-plot-${districtKey}-${ward}-${plot}`).click()
  await page.getByTestId('rehearsal-review').click()
  await expect(page.getByTestId('rehearsal-confirm')).toHaveAttribute('data-plot-id', plotId)
}

/** Place a listed test NFT on an exact plot through the page, as a player does. */
async function place(page: Page, asset: string, plotId: string) {
  await choose(page, asset, plotId)
  await page.getByTestId('rehearsal-activate').click()
  await expect(page.getByTestId('stored-property')).toHaveAttribute('data-plot-id', plotId)
}

/** The rehearsal route, asked directly from the page with its own cookie, naming the actor and ticket the page drew. */
async function placeByApi(page: Page, asset: string, plotId: string) {
  const city = page.getByTestId('play-city')
  const body = {
    sessionRef: await city.getAttribute('data-session-ref'),
    worldId: await city.getAttribute('data-world'),
    discordUserId: await city.getAttribute('data-player'),
    asset,
    plotId,
    geometryFingerprint: await city.getAttribute('data-geometry-fingerprint'),
    ticketId: (await city.getAttribute('data-ticket')) || '00000000-0000-7000-8000-000000000000',
  }
  return page.evaluate(async (b) => {
    const r = await fetch('/v1/play/rehearsal/activations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b), credentials: 'same-origin' })
    return { status: r.status, body: (await r.json()) as Record<string, unknown> }
  }, body)
}

/** This browser's session read of its city, as the page makes it. */
const cityRead = (page: Page) => page.evaluate(async () => (await (await fetch('/v1/play/city', { credentials: 'same-origin', cache: 'no-store' })).text()))

test('an empty city goes from four districts to six in the same world; its first property freezes the six; later moves are refused, presentation still governs', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  const city = await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  const world = (await city.getAttribute('data-world'))!
  await expect(city).toHaveAttribute('data-geometry-frozen', 'false')
  await expect(page.locator('[data-testid^="district-label-"]')).toHaveCount(4)
  await expect(city).toHaveAttribute('data-ticket-district', 'lantern-quay')
  const fourDistrictTicket = (await city.getAttribute('data-ticket'))!

  // Four to six districts while nothing stands anywhere: the same world governs the new geometry.
  await publish(a.guild, a.installation, BRAND_A_SIX)
  await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await expect(city).toHaveAttribute('data-world', world)
  await expect(city).toHaveAttribute('data-world-created', 'false')
  await expect(city).toHaveAttribute('data-governing-version', '2')
  await expect(page.locator('[data-testid^="district-label-"]')).toHaveCount(6)
  await expect(page.getByTestId('play-geometry')).toHaveText('districts open')
  // The adoption redrew the districts: Ada's ticket was superseded and reissued on the new rotation (District 1 again).
  await expect(city).toHaveAttribute('data-ticket-district', 'lantern-quay')
  expect(await city.getAttribute('data-ticket')).not.toBe(fourDistrictTicket)
  await expect(page.getByTestId('play-ticket').getByTestId('assigned-district')).toHaveAttribute('data-ordinal', '1')

  // A refused activation freezes nothing.
  expect(await placeByApi(page, nft(BRAND_A, 'harbor-keepers', '812'), 'compass-row-w0-p0')).toEqual({ status: 422, body: { error: 'plot_outside_assignment' } })
  expect(await placeByApi(page, nft(BRAND_A, 'harbor-keepers', '812'), 'nowhere-w0-p0')).toEqual({ status: 422, body: { error: 'unknown_plot' } })
  await page.reload()
  await expect(city).toHaveAttribute('data-geometry-frozen', 'false')

  // The first property, on one of the new districts (an explicit rule assigns this NFT to Dune), freezes the six.
  await place(page, DUNE_DOCK, 'dune-w0-p0')
  await expect(city).toHaveAttribute('data-world-sequence', '2')
  await expect(city).toHaveAttribute('data-geometry-frozen', 'true')
  await expect(page.getByTestId('play-geometry')).toHaveText('districts fixed')
  await expect(page.getByTestId('play-geometry')).toHaveAttribute('title', "Fixed by the city's first property, at sequence 2, under configuration v2.")
  const propertyId = (await page.getByTestId('stored-property').getAttribute('data-property-id'))!
  await page.screenshot({ path: `${SHOTS}/policy-1-frozen-at-first-property.png` })

  // Back to four districts, or the six reordered: refused, the city unchanged.
  for (const document of [BRAND_A, { ...BRAND_A_SIX, districts: [...BRAND_A_SIX.districts].reverse() }]) {
    await publish(a.guild, a.installation, document)
    await refused(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)), 'config_incompatible')
    await expect(page.getByTestId('play-problems')).toContainText('first property')
  }
  await page.screenshot({ path: `${SHOTS}/policy-2-move-refused.png` })

  // Presentation only (names, accents, a rule label): governs, and the property has not moved.
  await publish(a.guild, a.installation, { ...BRAND_A_SIX, cityName: 'Harborlight Six', districts: BRAND_A_SIX.districts.map((d) => ({ ...d, name: `${d.name} Ward`, accent: '#123456' })) })
  await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await expect(city).toHaveAttribute('data-world', world)
  await expect(city).toHaveAttribute('data-governing-version', '5')
  await expect(page.getByTestId('city-name')).toHaveText('HARBORLIGHT SIX')
  await expect(page.getByTestId('play-geometry')).toHaveText('districts fixed')
  await page.getByTestId('district-label-dune').click()
  await page.getByTestId(`warp-b-${propertyId}`).click()
  await expect(page.getByTestId('stored-property')).toHaveAttribute('data-plot-id', 'dune-w0-p0')
  // A second property stands on the same frozen ground, in the district the relaunch assigned (the released slot, reused).
  await expect(city).toHaveAttribute('data-ticket-district', 'lantern-quay')
  await place(page, nft(BRAND_A, 'tide-pass', '77'), 'lantern-quay-w0-p1')
  await expect(city).toHaveAttribute('data-world-sequence', '3')
  await page.screenshot({ path: `${SHOTS}/policy-3-presentation-governs.png` })
  await context.close()
})

test('the original activator is the launched player, outlives sign-out and relaunch, and is never anyone else\'s to see or claim', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const adaContext = await browser.newContext()
  const ada = await adaContext.newPage()
  const adaCity = await arrive(ada, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await place(ada, nft(BRAND_A, 'harbor-keepers', '812'), 'lantern-quay-w0-p2')
  const stored = ada.getByTestId('stored-property')
  const propertyId = (await stored.getAttribute('data-property-id'))!
  await expect(ada.getByTestId('stored-property-activator')).toHaveAttribute('data-activated-by-viewer', 'true')
  await expect(ada.getByTestId('stored-property-activator')).toContainText('Originally activated by you')
  await expect(adaCity).toHaveAttribute('data-original-activations', '1')
  const firstSession = (await adaCity.getAttribute('data-session-ref'))!
  await ada.screenshot({ path: `${SHOTS}/policy-4-activated-by-you.png` })

  // Sign out: the session is over. Launch again: a new session, the same original activator.
  await ada.getByTestId('play-signout').click()
  await expect(ada.getByTestId('play-gate')).toHaveAttribute('data-phase', 'signed-out')
  await arrive(ada, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  expect(await adaCity.getAttribute('data-session-ref')).not.toBe(firstSession)
  await expect(adaCity).toHaveAttribute('data-original-activations', '1')
  await ada.getByTestId('district-label-lantern-quay').click()
  await ada.getByTestId(`warp-b-${propertyId}`).click()
  await expect(ada.getByTestId('stored-property-activator')).toHaveAttribute('data-activated-by-viewer', 'true')
  // Repeating the activation from the new session is the same property.
  const again = await placeByApi(ada, nft(BRAND_A, 'harbor-keepers', '812'), 'lantern-quay-w0-p2')
  expect(again).toMatchObject({ status: 200, body: { fresh: false, property: { id: propertyId } } })
  expect(JSON.stringify(again.body)).not.toContain(REHEARSAL_ADA)

  // Bea (listed for the same NFT) sees the property, learns only that its activator is recorded privately, and cannot claim it.
  const beaContext = await browser.newContext()
  const bea = await beaContext.newPage()
  const beaCity = await arrive(bea, launchHref(await launch(a.guild, 'rare-city', 'Bea', REHEARSAL_BEA)))
  await expect(beaCity).toHaveAttribute('data-original-activations', '0')
  await bea.getByTestId('district-label-lantern-quay').click()
  await bea.getByTestId(`warp-b-${propertyId}`).click()
  await expect(bea.getByTestId('stored-property-activator')).toHaveAttribute('data-activated-by-viewer', 'false')
  await expect(bea.getByTestId('stored-property-activator')).toHaveText('Its original activator is recorded permanently and privately.')
  expect(await placeByApi(bea, nft(BRAND_A, 'harbor-keepers', '812'), 'lantern-quay-w0-p2')).toEqual({ status: 409, body: { error: 'asset_already_placed' } })
  const beaRead = await cityRead(bea)
  for (const secret of [REHEARSAL_ADA, firstSession, (await adaCity.getAttribute('data-session-ref'))!]) expect(beaRead).not.toContain(secret)
  expect(await bea.content()).not.toContain(REHEARSAL_ADA)
  await bea.screenshot({ path: `${SHOTS}/policy-5-other-player.png` })
  await adaContext.close()
  await beaContext.close()
})

test('a plot chosen on four districts is refused once six govern: nothing placed, the map redrawn, the plot chosen again', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const adaContext = await browser.newContext()
  const ada = await adaContext.newPage()
  const city = await arrive(ada, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  const drawn = (await city.getAttribute('data-geometry-fingerprint'))!
  const firstTicket = (await city.getAttribute('data-ticket'))!
  await choose(ada, nft(BRAND_A, 'harbor-keepers', '812'), 'lantern-quay-w0-p0')

  // While Ada reviews, the admin publishes six districts and Bea launches with them: the city now governs six.
  await publish(a.guild, a.installation, BRAND_A_SIX)
  const beaContext = await browser.newContext()
  const bea = await beaContext.newPage()
  await arrive(bea, launchHref(await launch(a.guild, 'rare-city', 'Bea', REHEARSAL_BEA)))

  // lantern-quay-w0-p0 still exists, on other ground: refused, nothing placed, the map shows the city as it is, and the
  // ticket the redraw reissued to Ada (still District 1 of the new rotation).
  await ada.getByTestId('rehearsal-activate').click()
  await expect(ada.getByTestId('rehearsal-error')).toHaveText('This city’s districts changed before your property was placed, so nothing was placed. The map now shows the city as it is: choose your plot again.')
  await expect(city).toHaveAttribute('data-world-sequence', '1')
  await expect(city).toHaveAttribute('data-governing-version', '2')
  await expect(city).toHaveAttribute('data-geometry-frozen', 'false')
  expect(await city.getAttribute('data-geometry-fingerprint')).not.toBe(drawn)
  await expect(ada.locator('[data-testid^="district-label-"]')).toHaveCount(6)
  await expect(ada.getByTestId('no-plot-selected')).toBeVisible()
  await expect(ada.getByTestId('selected-plot')).toHaveCount(0)
  await expect(city).toHaveAttribute('data-ticket-district', 'lantern-quay')
  expect(await city.getAttribute('data-ticket')).not.toBe(firstTicket)
  await ada.screenshot({ path: `${SHOTS}/policy-6-stale-map-refused.png` })

  // Chosen again, in the same panel, on the city as drawn now: placed there, and the six districts freeze.
  await still(ada)
  await ada.getByTestId('candidate-plot-lantern-quay-0-0').click()
  await ada.getByTestId('rehearsal-review').click()
  await expect(ada.getByTestId('rehearsal-confirm')).toHaveAttribute('data-plot-id', 'lantern-quay-w0-p0')
  await ada.getByTestId('rehearsal-activate').click()
  await expect(ada.getByTestId('stored-property')).toHaveAttribute('data-plot-id', 'lantern-quay-w0-p0')
  await expect(city).toHaveAttribute('data-world-sequence', '2')
  await expect(city).toHaveAttribute('data-geometry-frozen', 'true')
  await expect(ada.getByTestId('play-geometry')).toHaveAttribute('title', "Fixed by the city's first property, at sequence 2, under configuration v2.")
  await adaContext.close()
  await beaContext.close()
})

test('a configuration Play has active but no launch has taken up holds the first property until a relaunch', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  const city = await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await choose(page, nft(BRAND_A, 'harbor-keepers', '812'), 'lantern-quay-w0-p0')
  // The admin publishes six districts; nobody has launched with them yet. The page is not stale: four still govern.
  await publish(a.guild, a.installation, BRAND_A_SIX)
  await page.getByTestId('rehearsal-activate').click()
  await expect(page.getByTestId('rehearsal-error')).toHaveText('Proofy Play has a newer city configuration that this city has not taken up yet, so nothing was placed. Launch Rare City again from Proofy Play, then choose your plot.')
  await expect(city).toHaveAttribute('data-world-sequence', '1')
  await expect(city).toHaveAttribute('data-governing-version', '1')
  await expect(city).toHaveAttribute('data-geometry-frozen', 'false')
  await page.screenshot({ path: `${SHOTS}/policy-7-play-config-newer.png` })

  // Relaunched: the six districts govern, and the first property freezes them.
  await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await expect(city).toHaveAttribute('data-governing-version', '2')
  await place(page, nft(BRAND_A, 'harbor-keepers', '812'), 'lantern-quay-w0-p0')
  await expect(city).toHaveAttribute('data-geometry-frozen', 'true')
  await expect(page.locator('[data-testid^="district-label-"]')).toHaveCount(6)
  await expect(page.getByTestId('play-geometry')).toHaveAttribute('title', "Fixed by the city's first property, at sequence 2, under configuration v2.")
  await context.close()
})
