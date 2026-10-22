import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { BRAND_A } from './brands'
import { leaveOnly } from './claimWindow'
import { install, launch, launchHref, publish, snowflake } from './play'
import { CAPTAIN, EVE_CAPTAIN, FAY_TWIN, nft, REHEARSAL_ADA, REHEARSAL_BEA, REHEARSAL_EVE, REHEARSAL_FAY, RESTRICTED_RULES } from './rehearsal'

/**
 * THE PLAYER CLAIM EXPERIENCE (P1-C2-E1), end to end against a REAL local Proofy Play, through the
 * LOCAL PROPERTY REHEARSAL: the claim card in the bar and the plot panel guide a player from entry to
 * a permanent property, with a countdown read from the server's claim window (900 s by the
 * database's clock, never renewed) and refusals said as what they ask of the player. Eligibility,
 * rules and rule results are the local test file's (`rehearsal.ts`), never Proofy Core's. Where a test
 * needs time to pass it moves the claim window in the disposable database (`claimWindow.ts`); the
 * page is never told, and must learn it from the server.
 */
const SHOTS = resolve(import.meta.dirname, '../test-artifacts/city-play-evidence')
mkdirSync(SHOTS, { recursive: true })

const district = (key: string, name: string, accent: string) => ({ key, name, accent, monument: null, proofyRule: null })
/** Brand A with two more districts, Dune among them: both of Fay's keeper's rules name a district of this city. */
const BRAND_A_SIX = { ...BRAND_A, districts: [...BRAND_A.districts, district('reef', 'Reef', '#e76f51'), district('dune', 'Dune', '#e9c46a')] }
/** Brand A with every district restricted, each by its own Proofy rule (policy D1). */
const ALL_RESTRICTED = { ...BRAND_A, districts: BRAND_A.districts.map((d) => ({ ...d, proofyRule: { verificationRuleId: RESTRICTED_RULES[d.key as keyof typeof RESTRICTED_RULES], label: `${d.name} pass` } })) }
/** A MIXED city: Tidewater restricted (Eve's rule result says no), the other unrestricted districts in the rotation. */
const MIXED = { ...BRAND_A, districts: BRAND_A.districts.map((d) => (d.key === 'tidewater' ? { ...d, proofyRule: { verificationRuleId: RESTRICTED_RULES.tidewater, label: 'Tidewater pass' } } : d)) }

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

async function pick(page: Page, plotId: string) {
  const [, d, ward, plot] = /^(.+)-w(\d+)-p(\d+)$/.exec(plotId)!
  await page.getByTestId(`candidate-plot-${d}-${ward}-${plot}`).click()
  await expect(page.getByTestId('selected-plot')).toHaveAttribute('data-plot-id', plotId)
}

/** The bar's claim card, and its countdown. */
const card = (page: Page) => page.getByTestId('play-ticket')
const barCountdown = (page: Page) => card(page).getByTestId('claim-countdown')
const secondsOf = async (countdown: Locator) => Number(await countdown.getAttribute('data-seconds'))

/** The ticket the server holds for this page's player now, read as the page reads it (same origin, its session). */
const serverTicket = (page: Page) =>
  page.evaluate(async () => {
    const r = await fetch('/v1/play/rehearsal/ticket', { credentials: 'same-origin', cache: 'no-store' })
    return ((await r.json()) as { ticket: { id: string; districtKey: string; expiresAt: string } | null }).ticket
  })

/** An activation sent straight to the server with a ticket the page no longer shows: the server, not the page, refuses it. */
async function activateWith(page: Page, ticketId: string, asset: string, plotId: string) {
  const city = page.getByTestId('play-city')
  const body = {
    sessionRef: await city.getAttribute('data-session-ref'),
    worldId: await city.getAttribute('data-world'),
    discordUserId: await city.getAttribute('data-player'),
    asset,
    plotId,
    geometryFingerprint: await city.getAttribute('data-geometry-fingerprint'),
    ticketId,
  }
  return page.evaluate(async (b) => {
    const r = await fetch('/v1/play/rehearsal/activations', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
    return { status: r.status, error: ((await r.json()) as { error?: string }).error ?? null }
  }, body)
}

/** Continue the claim from the bar: the plot choice opens in the assigned district. */
async function continueClaim(page: Page) {
  await card(page).getByTestId('play-claim-continue').click()
  await expect(page.getByTestId('rehearsal-panel')).toBeVisible()
  await expect(card(page)).toHaveAttribute('data-claiming', 'true')
}

async function selectNft(page: Page, asset: string) {
  await page.locator(`[data-asset="${asset}"]`).check()
  await expect(page.getByTestId('rehearsal-panel')).toHaveAttribute('data-assigned', 'yes')
}

test('a default claim, guided: the assigned district and its basis, the server\'s countdown, the next action, a permanent property one tap away, and a second NFT', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  const city = await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))

  // Entry assigned District 1 of the rotation: the card names it, its basis, the claim time left and what to do next.
  await expect(card(page)).toHaveAttribute('data-state', 'held')
  await expect(card(page).getByTestId('assigned-district')).toHaveAttribute('data-kind', 'fallback')
  await expect(card(page)).toContainText('Your district: Lantern Quay District · slot 1 · until')
  await expect(card(page).getByTestId('play-ticket-next')).toContainText('Next: choose a test NFT and an exact plot in Lantern Quay. No plot is held for you until you activate.')
  // The countdown is the server's claim window, exactly: its end is the ticket's expiresAt, and it started at entry.
  const held = (await serverTicket(page))!
  await expect(barCountdown(page)).toHaveAttribute('data-expires-at', held.expiresAt)
  await expect(barCountdown(page)).toHaveAttribute('role', 'timer')
  expect(await secondsOf(barCountdown(page))).toBeGreaterThan(880)
  expect(await secondsOf(barCountdown(page))).toBeLessThanOrEqual(900)
  await expect(barCountdown(page)).toHaveAttribute('data-state', 'open')
  await expect(barCountdown(page)).toHaveAttribute('aria-label', /^Claim time left: 1[45] minutes/)
  await page.screenshot({ path: `${SHOTS}/claim-1-entry-card.png` })

  // Continue claim: the plot choice opens in the assigned district, the step is the NFT, and the card says "claiming".
  await continueClaim(page)
  await expect(page.getByTestId('placement-layer')).toHaveAttribute('data-district', 'lantern-quay')
  await expect(card(page).getByTestId('play-claim-continue')).toHaveCount(0)
  const panel = page.getByTestId('rehearsal-panel')
  await expect(panel.getByTestId('claim-steps')).toHaveAttribute('data-step', 'nft')
  await expect(panel.getByTestId('claim-next')).toHaveText('Select the test NFT you want to place.')
  await expect(panel.getByTestId('claim-countdown')).toHaveAttribute('data-expires-at', held.expiresAt)
  await expect(panel.getByTestId('claim-basis')).toContainText('DEFAULT ASSIGNMENT')
  await expect(panel.getByTestId('claim-hold')).toContainText('No plot is held: until you activate, another player may take any free plot.')
  await expect(panel.getByTestId('rehearsal-review')).toBeDisabled()

  const first = nft(BRAND_A, 'harbor-keepers', '812')
  await selectNft(page, first)
  await expect(panel.getByTestId('claim-steps')).toHaveAttribute('data-step', 'plot')
  await expect(panel.getByTestId('rehearsal-confirm')).toHaveCount(0)
  const plotId = await visiblePlot(page)
  await pick(page, plotId)
  await expect(panel.getByTestId('claim-steps')).toHaveAttribute('data-step', 'review')
  await panel.getByTestId('rehearsal-review').click()
  const confirm = panel.getByTestId('rehearsal-confirm')
  await expect(confirm).toContainText(`Harbor Keepers #812 becomes a Tier 0 property on ${plotId}`)
  await expect(confirm.getByTestId('claim-summary')).toContainText('Lantern Quay')
  await expect(confirm).toContainText('You are recorded as its original activator, for good.')
  await page.screenshot({ path: `${SHOTS}/claim-2-review.png` })
  await confirm.getByTestId('rehearsal-activate').click()

  // The permanent property: the building panel shows the stored record; the card says what was placed, and the countdown stopped.
  const stored = page.getByTestId('building-panel').getByTestId('stored-property')
  await expect(stored).toHaveAttribute('data-plot-id', plotId)
  await expect(page.getByTestId('stored-property-activator')).toHaveAttribute('data-activated-by-viewer', 'true')
  const buildingId = `b-${await stored.getAttribute('data-property-id')}`
  await expect(card(page)).toHaveAttribute('data-state', 'none')
  await expect(page.getByTestId('play-claim-card')).toHaveAttribute('data-claimed', buildingId)
  const [, , ward, plot] = /^(.+)-w(\d+)-p(\d+)$/.exec(plotId)!
  const label = `Ward ${['I', 'II', 'III', 'IV', 'V'][Number(ward)]} · Plot ${Number(plot) + 1}`
  await expect(page.getByTestId('play-claimed')).toContainText(`✓ Property activated: Harbor Keepers #812 · Lantern Quay District · ${label}. Permanent in Harborlight.`)
  await expect(page.getByTestId('claim-countdown')).toHaveCount(0)
  await expect(card(page).getByTestId('play-ticket-enter')).toHaveText('Claim another NFT')
  await page.screenshot({ path: `${SHOTS}/claim-3-activated.png` })

  // WARP from the card, after looking elsewhere: back to the property and its panel.
  await page.getByTestId('drawer').getByLabel('Close panel').click()
  await page.getByTestId('nav-overview').click()
  await still(page)
  const overview = await page.getByTestId('city-svg').getAttribute('viewBox')
  await page.getByTestId('play-claimed-view').click()
  await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', buildingId)
  await still(page)
  expect(await page.getByTestId('city-svg').getAttribute('viewBox')).not.toBe(overview)

  // A second NFT, without signing out: a new claim window (the first closed with its property).
  await card(page).getByTestId('play-ticket-enter').click()
  await expect(card(page)).toHaveAttribute('data-state', 'held')
  await continueClaim(page)
  const second = (await serverTicket(page))!
  expect(second.id).not.toBe(held.id)
  await expect(barCountdown(page)).toHaveAttribute('data-expires-at', second.expiresAt)
  expect(await secondsOf(barCountdown(page))).toBeGreaterThan(880)
  await selectNft(page, nft(BRAND_A, 'tide-pass', '77'))
  await pick(page, await visiblePlot(page))
  await page.getByTestId('rehearsal-review').click()
  await page.getByTestId('rehearsal-activate').click()
  await expect(city).toHaveAttribute('data-buildings', '2')
  await expect(city).toHaveAttribute('data-original-activations', '2')
  await expect(page.getByTestId('play-claimed')).toContainText('Tide Pass #77')
  await context.close()
})

test('the countdown never restarts: a reload, an NFT switch, leaving and entering again, and a second tab all read the same server end', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  const city = await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  const worldId = (await city.getAttribute('data-world'))!
  const first = (await city.getAttribute('data-ticket'))!

  // Five minutes pass (in the database). The page is not told; a reload reads the window as the server has it: ten left.
  await leaveOnly(worldId, REHEARSAL_ADA, 600)
  await page.reload()
  await expect(city).toHaveAttribute('data-source', 'session')
  const end = (await serverTicket(page))!.expiresAt
  await expect(barCountdown(page)).toHaveAttribute('data-expires-at', end)
  expect(await city.getAttribute('data-ticket')).toBe(first)
  expect(await secondsOf(barCountdown(page))).toBeLessThanOrEqual(600)
  expect(await secondsOf(barCountdown(page))).toBeGreaterThan(580)

  // An NFT an explicit rule assigns: another district and ticket, the same end.
  await continueClaim(page)
  await selectNft(page, CAPTAIN)
  await expect(page.getByTestId('rehearsal-district')).toHaveAttribute('data-kind', 'rule')
  await expect(city).toHaveAttribute('data-ticket-district', 'tidewater')
  expect(await city.getAttribute('data-ticket')).not.toBe(first)
  await expect(barCountdown(page)).toHaveAttribute('data-expires-at', end)
  expect(await secondsOf(barCountdown(page))).toBeLessThanOrEqual(600)

  // Leaving and entering again: a new ticket, the same end.
  await page.getByTestId('rehearsal-leave').click()
  await expect(card(page)).toHaveAttribute('data-state', 'none')
  await card(page).getByTestId('play-ticket-enter').click()
  await expect(card(page)).toHaveAttribute('data-state', 'held')
  const third = (await city.getAttribute('data-ticket'))!
  await expect(barCountdown(page)).toHaveAttribute('data-expires-at', end)
  expect(await secondsOf(barCountdown(page))).toBeLessThanOrEqual(600)

  // A second tab of the same browser reads the same ticket and end; leaving and entering there still keeps the end.
  const tab = await context.newPage()
  await tab.goto('/')
  await expect(tab.getByTestId('play-city')).toHaveAttribute('data-ticket', third)
  await expect(barCountdown(tab)).toHaveAttribute('data-expires-at', end)
  await continueClaim(tab)
  await tab.getByTestId('rehearsal-leave').click()
  await expect(card(tab)).toHaveAttribute('data-state', 'none')
  await card(tab).getByTestId('play-ticket-enter').click()
  await expect(card(tab)).toHaveAttribute('data-state', 'held')
  const fourth = (await tab.getByTestId('play-city').getAttribute('data-ticket'))!
  expect(fourth).not.toBe(third)
  await expect(barCountdown(tab)).toHaveAttribute('data-expires-at', end)
  await tab.screenshot({ path: `${SHOTS}/claim-4-second-tab-same-end.png` })
  // The first tab, reloaded, shows the second tab's ticket, with the same end. No tab ever extended it.
  await page.reload()
  await expect(city).toHaveAttribute('data-ticket', fourth)
  await expect(barCountdown(page)).toHaveAttribute('data-expires-at', end)
  expect((await serverTicket(page))!.expiresAt).toBe(end)
  await context.close()
})

test('at zero the page stops offering activation and asks the server; the server ends the claim, the old ticket is refused, and a fresh claim starts a new window', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  const city = await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  const worldId = (await city.getAttribute('data-world'))!
  // Most of the window has passed (in the database): 30 seconds left. The page learns it on a reload, as any page would.
  await leaveOnly(worldId, REHEARSAL_ADA, 30)
  await page.reload()
  await expect(barCountdown(page)).toHaveAttribute('data-state', 'ending')
  expect(await secondsOf(barCountdown(page))).toBeLessThanOrEqual(30)
  const old = (await city.getAttribute('data-ticket'))!
  // The player gets as far as the confirmation…
  await continueClaim(page)
  const asset = nft(BRAND_A, 'harbor-keepers', '812')
  await selectNft(page, asset)
  const plotId = await visiblePlot(page)
  await pick(page, plotId)
  await page.getByTestId('rehearsal-review').click()
  await expect(page.getByTestId('rehearsal-confirm')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/claim-5-nearly-over.png` })
  // …and lets the time run out. At zero the confirmation goes; the server, asked once, holds no ticket: the claim ended.
  await expect(card(page)).toHaveAttribute('data-note-kind', 'renew', { timeout: 45_000 })
  await expect(card(page)).toHaveAttribute('data-state', 'none')
  await expect(page.getByTestId('rehearsal-panel')).toHaveCount(0)
  await expect(page.getByTestId('rehearsal-activate')).toHaveCount(0)
  await expect(card(page).getByTestId('play-ticket-note')).toContainText('Your claim time ran out before a property was placed, so nothing was placed.')
  await expect(card(page).getByTestId('play-ticket-enter')).toHaveText('Start a fresh claim')
  await expect(city).toHaveAttribute('data-buildings', '0')
  await page.screenshot({ path: `${SHOTS}/claim-6-window-ended.png` })
  // The expired ticket cannot place anything, whatever a page sends.
  const refused = await activateWith(page, old, asset, plotId)
  expect(refused.status).toBe(409)
  expect(['ticket_expired', 'ticket_not_live']).toContain(refused.error)
  // A fresh, validated claim opens a new window: fifteen minutes again, by the server.
  await card(page).getByTestId('play-ticket-enter').click()
  await expect(card(page)).toHaveAttribute('data-state', 'held')
  expect(await city.getAttribute('data-ticket')).not.toBe(old)
  expect(await secondsOf(barCountdown(page))).toBeGreaterThan(880)
  await context.close()
})

test('a browser clock ten minutes fast still counts the server\'s window: the page corrects it from the server, never from itself', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.clock.install({ time: new Date(Date.now() + 10 * 60_000) })
  await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  const held = (await serverTicket(page))!
  await expect(barCountdown(page)).toHaveAttribute('data-expires-at', held.expiresAt)
  // Uncorrected, this clock would read five minutes left; corrected by the server's Date header, the whole window.
  expect(await secondsOf(barCountdown(page))).toBeGreaterThan(880)
  await expect(barCountdown(page)).toHaveAttribute('data-state', 'open')
  await context.close()
})

test('a configuration change supersedes the ticket: the page shows the reissued ticket in the same window, and the old one never places anything', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const adaContext = await browser.newContext()
  const ada = await adaContext.newPage()
  const city = await arrive(ada, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  const old = (await city.getAttribute('data-ticket'))!
  const end = (await serverTicket(ada))!.expiresAt
  await continueClaim(ada)
  const asset = nft(BRAND_A, 'harbor-keepers', '812')
  await selectNft(ada, asset)
  const plotId = await visiblePlot(ada)
  await pick(ada, plotId)
  await ada.getByTestId('rehearsal-review').click()

  // While Ada reviews, six districts are published and Bea launches with them: every ticket is superseded and reissued.
  await publish(a.guild, a.installation, BRAND_A_SIX)
  const beaContext = await browser.newContext()
  await arrive(await beaContext.newPage(), launchHref(await launch(a.guild, 'rare-city', 'Bea', REHEARSAL_BEA)))

  await ada.getByTestId('rehearsal-activate').click()
  const box = ada.getByTestId('rehearsal-error-box')
  await expect(box).toHaveAttribute('data-kind', 'renew')
  await expect(box).toContainText('Your claim changed')
  await expect(city).toHaveAttribute('data-buildings', '0')
  // The reissued ticket, in the same claim window; the selection made on the old districts is gone, the NFT asked about again.
  await expect(city).not.toHaveAttribute('data-ticket', old)
  await expect(barCountdown(ada)).toHaveAttribute('data-expires-at', end)
  await expect(ada.getByTestId('no-plot-selected')).toBeVisible()
  await expect(ada.getByTestId('rehearsal-panel')).toHaveAttribute('data-assigned', 'yes')
  await expect(ada.getByTestId('claim-steps')).toHaveAttribute('data-step', 'plot')
  await ada.screenshot({ path: `${SHOTS}/claim-7-superseded.png` })
  // The previous generation is never revived: the old ticket is refused by the server.
  const refused = await activateWith(ada, old, asset, plotId)
  expect(refused.status).toBe(409)
  expect(['ticket_superseded', 'ticket_not_live']).toContain(refused.error)
  await expect(city).toHaveAttribute('data-buildings', '0')
  await adaContext.close()
  await beaContext.close()
})

test('a city whose every district is restricted waits for the NFT with no claim time running; the qualified player claims, the unqualified player is told why and offered no override', async ({ browser }) => {
  const a = await installed(ALL_RESTRICTED)
  const contexts = await Promise.all([0, 1].map(() => browser.newContext()))
  const [ada, eve] = await Promise.all(contexts.map((c) => c.newPage()))
  const city = await arrive(ada, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await expect(card(ada)).toHaveAttribute('data-state', 'awaiting-asset')
  await expect(card(ada)).toContainText('No claim time runs until then.')
  await expect(ada.getByTestId('claim-countdown')).toHaveCount(0)
  await expect(city).toHaveAttribute('data-ticket', '')
  await ada.screenshot({ path: `${SHOTS}/claim-8-all-restricted-awaiting.png` })

  await expect(card(ada).getByTestId('play-claim-continue')).toHaveText('Select your test NFT')
  await card(ada).getByTestId('play-claim-continue').click()
  await expect(ada.getByTestId('claim-steps')).toHaveAttribute('data-step', 'nft')
  await selectNft(ada, CAPTAIN)
  await expect(ada.getByTestId('placement-layer')).toHaveAttribute('data-district', 'tidewater')
  // Now a claim window runs, and the restricted basis is said as local test data, never as verified.
  expect(await secondsOf(barCountdown(ada))).toBeGreaterThan(880)
  const basis = ada.getByTestId('claim-basis')
  await expect(basis).toHaveAttribute('data-restricted', 'true')
  await expect(basis).toContainText('RESTRICTED · LOCAL TEST RESULT')
  await expect(basis).toContainText('Not verified by Proofy.')
  expect((await ada.getByTestId('rehearsal-panel').innerText()).replace(/not verified/gi, '')).not.toMatch(/verified/i)
  await ada.screenshot({ path: `${SHOTS}/claim-9-all-restricted-rule-ticket.png` })
  await pick(ada, await visiblePlot(ada))
  await ada.getByTestId('rehearsal-review').click()
  await ada.getByTestId('rehearsal-activate').click()
  await expect(city).toHaveAttribute('data-buildings', '1')
  await expect(ada.getByTestId('play-claimed')).toContainText('Tidewater District')

  // Eve's rule result says no: she views the city, is told why, and nothing offers to ask again.
  const eveCity = await arrive(eve, launchHref(await launch(a.guild, 'rare-city', 'Eve', REHEARSAL_EVE)))
  await expect(eveCity).toHaveAttribute('data-buildings', '1')
  await expect(card(eve)).toHaveAttribute('data-state', 'none')
  await expect(card(eve)).toHaveAttribute('data-note-kind', 'refused')
  await expect(card(eve).getByTestId('play-ticket-note')).toContainText('restricted district whose Proofy rule this local server says you do not meet')
  await expect(card(eve)).toContainText('You can still explore the whole city.')
  await expect(card(eve).getByTestId('play-ticket-enter')).toHaveCount(0)
  await expect(eve.getByTestId('claim-countdown')).toHaveCount(0)
  await eve.screenshot({ path: `${SHOTS}/claim-10-all-restricted-refused.png` })
  await Promise.all(contexts.map((c) => c.close()))
})

test('conflicting district rules are explained, never guessed away; a mixed city\'s fallback district is never offered for an NFT its rule keeps out (L1 unchanged)', async ({ browser }) => {
  // Fay's keeper: both explicit rules apply, naming Tidewater and Dune. No precedence is approved: it cannot be placed.
  const six = await installed(BRAND_A_SIX)
  const contexts = await Promise.all([0, 1].map(() => browser.newContext()))
  const [fay, eve] = await Promise.all(contexts.map((c) => c.newPage()))
  const fayCity = await arrive(fay, launchHref(await launch(six.guild, 'rare-city', 'Fay', REHEARSAL_FAY)))
  const fallback = (await fayCity.getAttribute('data-ticket'))!
  const fallbackDistrict = (await fayCity.getAttribute('data-ticket-district'))!
  await continueClaim(fay)
  await fay.locator(`[data-asset="${FAY_TWIN}"]`).check()
  const box = fay.getByTestId('rehearsal-error-box')
  await expect(box).toHaveAttribute('data-kind', 'config')
  await expect(box).toHaveAttribute('data-code', 'district_rule_ambiguous')
  await expect(box).toContainText('Needs the city’s administrator')
  await expect(fay.getByTestId('rehearsal-error')).toHaveText('District rules for this NFT name different districts, so it cannot be placed until the city’s administrator fixes them.')
  // Nothing was picked for her: the same fallback ticket and district, no review, the NFT step again.
  await expect(fayCity).toHaveAttribute('data-ticket', fallback)
  await expect(fay.getByTestId('placement-layer')).toHaveAttribute('data-district', fallbackDistrict)
  await expect(fay.getByTestId('rehearsal-review')).toBeDisabled()
  await expect(fay.getByTestId('claim-steps')).toHaveAttribute('data-step', 'nft')
  await fay.screenshot({ path: `${SHOTS}/claim-11-rules-conflict.png` })

  // L1, as it is: in a mixed city Eve holds a fallback district, but her Captain's rule district (restricted) refuses her.
  const mixed = await installed(MIXED)
  const eveCity = await arrive(eve, launchHref(await launch(mixed.guild, 'rare-city', 'Eve', REHEARSAL_EVE)))
  await expect(card(eve)).toHaveAttribute('data-state', 'held')
  const eveTicket = (await eveCity.getAttribute('data-ticket'))!
  await continueClaim(eve)
  await eve.locator(`[data-asset="${EVE_CAPTAIN}"]`).check()
  await expect(eve.getByTestId('rehearsal-error-box')).toHaveAttribute('data-kind', 'refused')
  await expect(eve.getByTestId('rehearsal-error')).toContainText('restricted district whose Proofy rule this local server says you do not meet')
  await expect(eve.getByTestId('rehearsal-kept-out')).toContainText('is still held for you, but it cannot take this NFT. You have no other test NFT for it: leave to release the district.')
  await expect(eve.getByTestId('rehearsal-review')).toBeDisabled()
  await expect(eve.getByTestId('rehearsal-retry')).toHaveCount(0)
  // Ticket issuance is unchanged: the same fallback ticket is held (the open owner decision L1).
  await expect(eveCity).toHaveAttribute('data-ticket', eveTicket)
  await eve.screenshot({ path: `${SHOTS}/claim-12-l1-kept-out.png` })
  await Promise.all(contexts.map((c) => c.close()))
})

test('a plot another player placed first is named, the selection is dropped, and no other plot is chosen for the player', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const contexts = await Promise.all([0, 1].map(() => browser.newContext()))
  const [ada, bea] = await Promise.all(contexts.map((c) => c.newPage()))
  const adaCity = await arrive(ada, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await arrive(bea, launchHref(await launch(a.guild, 'rare-city', 'Bea', REHEARSAL_BEA)))
  // Ada's Captain takes her claim to Tidewater by rule; Bea holds Tidewater from the rotation. Both pick the same plot.
  await continueClaim(ada)
  await selectNft(ada, CAPTAIN)
  await expect(ada.getByTestId('placement-layer')).toHaveAttribute('data-district', 'tidewater')
  const plotId = await visiblePlot(ada)
  await pick(ada, plotId)
  await ada.getByTestId('rehearsal-review').click()
  const ticket = (await adaCity.getAttribute('data-ticket'))!

  await continueClaim(bea)
  await selectNft(bea, nft(BRAND_A, 'tide-pass', '5'))
  await expect(bea.getByTestId('placement-layer')).toHaveAttribute('data-district', 'tidewater')
  await still(bea)
  await pick(bea, plotId)
  await bea.getByTestId('rehearsal-review').click()
  await bea.getByTestId('rehearsal-activate').click()
  await expect(bea.getByTestId('stored-property')).toHaveAttribute('data-plot-id', plotId)

  await ada.getByTestId('rehearsal-activate').click()
  await expect(ada.getByTestId('rehearsal-error-box')).toHaveAttribute('data-kind', 'plot')
  await expect(ada.getByTestId('rehearsal-error')).toHaveText('Someone placed a property on that plot first. The city has been updated: choose another plot.')
  await expect(ada.getByTestId('rehearsal-lost-plot')).toHaveAttribute('data-plot-id', plotId)
  await expect(ada.getByTestId('rehearsal-lost-plot')).toContainText('No other plot was chosen for you.')
  await expect(ada.getByTestId('selected-plot')).toHaveCount(0)
  await expect(ada.getByTestId('rehearsal-confirm')).toHaveCount(0)
  const [, d, ward, plot] = /^(.+)-w(\d+)-p(\d+)$/.exec(plotId)!
  await expect(ada.getByTestId(`candidate-plot-${d}-${ward}-${plot}`)).toHaveCount(0)
  // Her claim stands: the same ticket and district, the same NFT, the plot step.
  await expect(adaCity).toHaveAttribute('data-ticket', ticket)
  await expect(adaCity).toHaveAttribute('data-buildings', '1')
  await expect(ada.getByTestId('claim-steps')).toHaveAttribute('data-step', 'plot')
  await ada.screenshot({ path: `${SHOTS}/claim-13-plot-lost.png` })
  await Promise.all(contexts.map((c) => c.close()))
})
