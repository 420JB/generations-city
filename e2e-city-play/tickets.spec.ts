import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { BRAND_A } from './brands'
import { install, launch, launchHref, publish, snowflake } from './play'
import { CAPTAIN, nft, REHEARSAL_ADA, REHEARSAL_BEA, REHEARSAL_CY, REHEARSAL_DEE, REHEARSAL_EVE, RESTRICTED_RULES } from './rehearsal'

/**
 * DISTRICT TICKETS (P1-C2-D1), end to end against a REAL local Proofy Play, through the LOCAL
 * PROPERTY REHEARSAL: players entering a city are assigned districts at once from its citywide
 * round-robin rotation (MCD 46B, owner-locked), hold them together, place in any order, release them
 * for the next entrant, have an explicit rule reassign an NFT's district before any plot is chosen,
 * and claim a second NFT without signing out. Eligibility and rules come from the local test file
 * (`rehearsal.ts`), never from Proofy Core: the page says so.
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

const ticketOf = async (page: Page) => {
  const badge = page.getByTestId('play-ticket').getByTestId('assigned-district')
  return { district: await badge.getAttribute('data-district'), ordinal: await badge.getAttribute('data-ordinal'), generation: await badge.getAttribute('data-generation'), kind: await badge.getAttribute('data-kind'), id: await badge.getAttribute('data-ticket') }
}
/** The instant the ticket's claim window ends, as the page shows it. */
const endOf = (page: Page) => page.getByTestId('play-ticket').getByTestId('assigned-district').locator('time').getAttribute('datetime')

/** BRAND_A with every district restricted, each by its own Proofy rule (policy D1). */
const ALL_RESTRICTED = { ...BRAND_A, districts: BRAND_A.districts.map((d) => ({ ...d, proofyRule: { verificationRuleId: RESTRICTED_RULES[d.key as keyof typeof RESTRICTED_RULES], label: `${d.name} pass` } })) }

/** Open the plot choice in the player's assigned district, select an NFT, and wait for the server's answer for it. */
async function openWith(page: Page, asset: string) {
  const district = (await page.getByTestId('play-city').getAttribute('data-ticket-district'))!
  await page.getByTestId('nav-overview').click()
  await still(page)
  await page.getByTestId(`district-label-${district}`).click()
  await page.getByTestId('choose-plot').click()
  await expect(page.getByTestId('rehearsal-panel')).toBeVisible()
  await page.locator(`[data-asset="${asset}"]`).check()
  await expect(page.getByTestId('rehearsal-panel')).toHaveAttribute('data-assigned', 'yes')
}

/** A highlighted plot the player can actually click: the first candidate whose center no drawer, bar or HUD covers. */
async function visiblePlot(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-testid^="candidate-plot-"]')) {
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      if (hit && el.contains(hit)) return el.getAttribute('data-testid')
    }
    return null
  })
  if (!id) throw new Error('no highlighted plot is visible')
  const [, district, ward, plot] = /^candidate-plot-(.+)-(\d+)-(\d+)$/.exec(id)!
  return `${district}-w${ward}-p${plot}`
}

/** Place on a highlighted plot of the assigned district (any the player can see), as a player does. Returns its plot id. */
async function placeOn(page: Page, district: string) {
  await expect(page.getByTestId('placement-layer')).toHaveAttribute('data-district', district)
  await still(page)
  const plotId = await visiblePlot(page)
  expect(plotId.startsWith(`${district}-w`)).toBe(true)
  const [, , ward, plot] = /^(.+)-w(\d+)-p(\d+)$/.exec(plotId)!
  await page.getByTestId(`candidate-plot-${district}-${ward}-${plot}`).click()
  await page.getByTestId('rehearsal-review').click()
  await page.getByTestId('rehearsal-activate').click()
  await expect(page.getByTestId('stored-property')).toHaveAttribute('data-plot-id', plotId)
  return plotId
}

test('A, B and C entering in order hold districts 1, 2 and 3 at once; B and C place while A is idle; A leaves and the next entrant gets District 1', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext()))
  const [ada, bea, cy, dee] = await Promise.all(contexts.map((c) => c.newPage()))
  const adaCity = await arrive(ada, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await arrive(bea, launchHref(await launch(a.guild, 'rare-city', 'Bea', REHEARSAL_BEA)))
  await arrive(cy, launchHref(await launch(a.guild, 'rare-city', 'Cy', REHEARSAL_CY)))
  // Each was assigned on entry, in entry order, without waiting for anyone to place: Districts 1, 2 and 3.
  expect(await ticketOf(ada)).toMatchObject({ district: 'lantern-quay', ordinal: '0', generation: '1', kind: 'fallback' })
  expect(await ticketOf(bea)).toMatchObject({ district: 'tidewater', ordinal: '1', generation: '1' })
  expect(await ticketOf(cy)).toMatchObject({ district: 'saltmarsh', ordinal: '2', generation: '1' })
  await expect(ada.getByTestId('play-ticket')).toContainText('Your district: Lantern Quay District · slot 1 · until')
  await ada.screenshot({ path: `${SHOTS}/tickets-1-ada-district-1.png` })
  await bea.screenshot({ path: `${SHOTS}/tickets-2-bea-district-2.png` })
  await cy.screenshot({ path: `${SHOTS}/tickets-3-cy-district-3.png` })

  // C and B place, in that order, in their own districts, while A does nothing.
  await openWith(cy, nft(BRAND_A, 'harbor-keepers', '300'))
  await placeOn(cy, 'saltmarsh')
  await openWith(bea, nft(BRAND_A, 'tide-pass', '5'))
  await placeOn(bea, 'tidewater')
  await bea.screenshot({ path: `${SHOTS}/tickets-4-bea-placed.png` })
  // A still holds District 1: a reload reads the same ticket and issues nothing.
  const held = await ticketOf(ada)
  await ada.reload()
  await expect(adaCity).toHaveAttribute('data-source', 'session')
  expect(await ticketOf(ada)).toEqual(held)
  await expect(adaCity).toHaveAttribute('data-buildings', '2')

  // A leaves the claim flow: District 1 is released.
  await ada.getByTestId('district-label-lantern-quay').click()
  await ada.getByTestId('choose-plot').click()
  await expect(ada.getByTestId('rehearsal-panel')).toBeVisible()
  await ada.getByTestId('rehearsal-leave').click()
  await expect(ada.getByTestId('preview-notice')).toContainText('your district was released for the next player')
  await expect(ada.getByTestId('play-ticket')).toHaveAttribute('data-state', 'none')
  await expect(adaCity).toHaveAttribute('data-ticket', '')

  // D enters next and receives A's released District 1 slot, at its next generation, with a new ticket.
  await arrive(dee, launchHref(await launch(a.guild, 'rare-city', 'Dee', REHEARSAL_DEE)))
  const deeTicket = await ticketOf(dee)
  expect(deeTicket).toMatchObject({ district: 'lantern-quay', ordinal: '0', generation: '2' })
  expect(deeTicket.id).not.toBe(held.id)
  await dee.screenshot({ path: `${SHOTS}/tickets-5-dee-reuses-district-1.png` })
  // A asks again: no gap left, so the next new slot, round the rotation (District 1 again, slot 4).
  await ada.getByTestId('play-ticket-enter').click()
  await expect(ada.getByTestId('play-ticket')).toHaveAttribute('data-state', 'held')
  expect(await ticketOf(ada)).toMatchObject({ district: 'lantern-quay', ordinal: '3', generation: '1' })
  // B's and C's properties did not move.
  await ada.getByTestId('nav-overview').click()
  await still(ada)
  await ada.getByTestId('district-label-tidewater').click()
  await expect(ada.getByTestId('district-buildings')).toHaveText('1')
  await Promise.all(contexts.map((c) => c.close()))
})

test('selecting an NFT an explicit rule assigns moves the claim to the rule\'s district before any plot; a second NFT is claimed without signing out', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  const city = await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  expect(await ticketOf(page)).toMatchObject({ district: 'lantern-quay', kind: 'fallback', ordinal: '0' })
  // The Captain: the local rule assigns Tidewater. The server swaps the ticket, and the placement follows it.
  await openWith(page, CAPTAIN)
  await expect(page.getByTestId('placement-layer')).toHaveAttribute('data-district', 'tidewater')
  const district = page.getByTestId('rehearsal-district')
  await expect(district).toHaveAttribute('data-district', 'tidewater')
  await expect(district).toHaveAttribute('data-kind', 'rule')
  await expect(district).toContainText('explicit district rule captains-to-tidewater for this NFT')
  expect(await ticketOf(page)).toMatchObject({ district: 'tidewater', kind: 'rule', ordinal: '' })
  await page.screenshot({ path: `${SHOTS}/tickets-6-rule-reassigns.png` })
  await placeOn(page, 'tidewater')
  await expect(city).toHaveAttribute('data-buildings', '1')

  // The next NFT, without signing out: a new, independently issued ticket. The Captain's unused District 1 slot was
  // released when the rule applied, so it is the oldest gap and comes back at its next generation.
  await page.getByTestId('play-ticket-enter').click()
  await expect(page.getByTestId('play-ticket')).toHaveAttribute('data-state', 'held')
  expect(await ticketOf(page)).toMatchObject({ district: 'lantern-quay', kind: 'fallback', ordinal: '0', generation: '2' })
  await openWith(page, nft(BRAND_A, 'tide-pass', '77'))
  await placeOn(page, 'lantern-quay')
  await expect(city).toHaveAttribute('data-buildings', '2')
  await expect(city).toHaveAttribute('data-original-activations', '2')
  await page.screenshot({ path: `${SHOTS}/tickets-7-second-nft.png` })
  await context.close()
})

test('an all-restricted city: the qualified player selects the NFT first and places it in its restricted district; an unqualified player views but cannot claim', async ({ browser }) => {
  const a = await installed(ALL_RESTRICTED)
  const contexts = await Promise.all([0, 1].map(() => browser.newContext()))
  const [ada, eve] = await Promise.all(contexts.map((c) => c.newPage()))
  const city = await arrive(ada, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  // No district at entry: it depends on the NFT. Nothing is held meanwhile.
  await expect(ada.getByTestId('play-ticket')).toHaveAttribute('data-state', 'awaiting-asset')
  await expect(ada.getByTestId('play-ticket')).toContainText('Every district here is restricted')
  await expect(city).toHaveAttribute('data-ticket', '')
  await ada.screenshot({ path: `${SHOTS}/tickets-8-all-restricted-awaiting.png` })
  // From any district: select the NFT. The server assigns its rule's restricted district, and the placement goes there.
  await ada.getByTestId('nav-overview').click()
  await still(ada)
  await ada.getByTestId('district-label-lantern-quay').click()
  await expect(ada.getByTestId('choose-plot')).toHaveText('Select your test NFT · local rehearsal')
  await ada.getByTestId('choose-plot').click()
  await expect(ada.getByTestId('rehearsal-panel')).toBeVisible()
  await ada.locator(`[data-asset="${CAPTAIN}"]`).check()
  await expect(ada.getByTestId('rehearsal-panel')).toHaveAttribute('data-assigned', 'yes')
  await expect(ada.getByTestId('placement-layer')).toHaveAttribute('data-district', 'tidewater')
  expect(await ticketOf(ada)).toMatchObject({ district: 'tidewater', kind: 'rule', ordinal: '' })
  await expect(ada.getByTestId('play-ticket').getByTestId('assigned-district')).toHaveAttribute('data-restricted', String(RESTRICTED_RULES.tidewater))
  await expect(ada.getByTestId('rehearsal-district')).toContainText(`Proofy rule ${RESTRICTED_RULES.tidewater} answered yes in this server's local test file (not verified by Proofy)`)
  const end = Date.parse((await endOf(ada))!)
  expect(end - Date.now()).toBeGreaterThan(890_000)
  expect(end - Date.now()).toBeLessThanOrEqual(900_000)
  await ada.screenshot({ path: `${SHOTS}/tickets-9-all-restricted-rule-ticket.png` })
  await placeOn(ada, 'tidewater')
  await expect(city).toHaveAttribute('data-buildings', '1')
  await ada.screenshot({ path: `${SHOTS}/tickets-10-all-restricted-placed.png` })

  // Eve's Proofy rule answered no: the city is hers to view, and the page says why nothing can be claimed.
  const eveCity = await arrive(eve, launchHref(await launch(a.guild, 'rare-city', 'Eve', REHEARSAL_EVE)))
  await expect(eveCity).toHaveAttribute('data-buildings', '1')
  await expect(eve.getByTestId('play-ticket')).toHaveAttribute('data-state', 'none')
  await expect(eve.getByTestId('play-ticket-note')).toContainText('restricted district whose Proofy rule this local server says you do not meet')
  await expect(eveCity).toHaveAttribute('data-ticket', '')
  await eve.screenshot({ path: `${SHOTS}/tickets-11-all-restricted-unqualified.png` })
  await Promise.all(contexts.map((c) => c.close()))
})

test('the claim window is never extended: a reload, an NFT switch, and leaving and entering again all keep the same end', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  const city = await arrive(page, launchHref(await launch(a.guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  const first = await ticketOf(page)
  const end = await endOf(page)
  expect(Date.parse(end!) - Date.now()).toBeGreaterThan(890_000)
  // A reload: the same ticket, the same end.
  await page.reload()
  await expect(city).toHaveAttribute('data-source', 'session')
  expect([await ticketOf(page), await endOf(page)]).toEqual([first, end])
  // Switching to the Captain (a rule ticket): another district, the same end.
  await openWith(page, CAPTAIN)
  expect(await ticketOf(page)).toMatchObject({ district: 'tidewater', kind: 'rule' })
  expect(await endOf(page)).toBe(end)
  // Leaving, then asking again: a new ticket, the same end.
  await page.getByTestId('rehearsal-leave').click()
  await expect(page.getByTestId('play-ticket')).toHaveAttribute('data-state', 'none')
  await page.getByTestId('play-ticket-enter').click()
  await expect(page.getByTestId('play-ticket')).toHaveAttribute('data-state', 'held')
  const again = await ticketOf(page)
  expect(again.id).not.toBe(first.id)
  expect(await endOf(page)).toBe(end)
  await page.screenshot({ path: `${SHOTS}/tickets-12-same-window.png` })
  await context.close()
})
