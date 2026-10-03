import { expect, test, type Page } from '@playwright/test'
import { watchCsp, watchErrors } from './harness.ts'
import { ACCOUNTS, installWallet, short } from './wallet.ts'

/**
 * AN EMPTY CITY: the state canonical genesis installs and an activation rehearsal starts
 * from. No users, no buildings, nothing held.
 *
 * Served by the second test server (see serve.ts), under the same Content-Security-Policy
 * as every other page. The app must show a whole city with nobody in it, and must not
 * make anybody up.
 */
const PORT = 4320
test.use({ baseURL: `http://127.0.0.1:${PORT}` })

const DISTRICTS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9']
const MONUMENTS = ['m2', 'm3', 'm4', 'm5', 'm6']
const ALICE = ACCOUNTS[0].address

async function openEmptyCity(page: Page) {
  await page.goto('/')
  await expect(page.getByTestId('city')).toBeVisible()
  await expect(page.getByTestId('viewer-anonymous')).toBeVisible()
}
const buildings = (page: Page) => page.locator('[data-testid^="building-"][data-total]')

test.describe('the empty city as served', () => {
  test('is a non-canonical rehearsal city at sequence 1 with nobody and nothing in it', async ({ request }) => {
    const body = await (await request.get('/v1/city')).json()
    expect(body.city).toMatchObject({ id: 'main', sequence: 1, stateVersion: 5, canonical: false, origin: 'demo-fixture' })
    expect(Object.keys(body)).toEqual(['city', 'server', 'state'])
    const s = body.state
    expect([Object.keys(s.users).length, Object.keys(s.buildings).length, Object.keys(s.wallets).length, s.radio.length]).toEqual([0, 0, 0, 0])
    expect(s.capital.holder).toBeNull()
    expect(s.crown.holder).toBeNull()
    expect(Object.values(s.monuments).map((m) => (m as { holder: unknown }).holder)).toEqual([null, null, null, null, null])
    expect(s.season).toEqual({ id: 'preseason', name: 'Preseason', number: 0, representatives: {}, activity: {}, joinedClock: {} })
    expect(s.wards).toEqual(Object.fromEntries(DISTRICTS.map((d) => [d, 1])))
  })
})

test.describe('the app on an empty city', () => {
  test('boots and draws the whole civic world, with no building, no Crown and no Capital', async ({ context, page }) => {
    const violations = await watchCsp(context)
    const problems = watchErrors(page)
    await openEmptyCity(page)

    // The city is there: the ground, the perimeter, City Hall, and every district by name.
    await expect(page.getByTestId('city-perimeter')).toBeAttached()
    await expect(page.getByTestId('city-hall')).toBeAttached()
    // No district is the Capital, so no district's ground is dressed as one.
    await expect(page.getByTestId('capital-ground')).toHaveCount(0)
    for (const d of DISTRICTS) await expect(page.getByTestId(`district-label-${d}`), d).toBeAttached()
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.city-svg')!).willChange)).toBe('contents')

    // Nobody lives here, and nothing was made up to fill it.
    await expect(buildings(page)).toHaveCount(0)
    await expect(page.locator('[data-testid^="building-"]')).toHaveCount(0)
    await expect(page.getByTestId('crown-spire')).toHaveCount(0)
    await expect(page.getByTestId('player-marker')).toHaveCount(0)

    // Nothing is held: no Capital, no Crown, no monument.
    await expect(page.getByTestId('hud-capital')).toHaveAttribute('data-capital', '')
    await expect(page.getByTestId('hud-capital')).toContainText('Unclaimed')
    for (const m of MONUMENTS) await expect(page.getByTestId(`hud-mon-${m}`), m).toHaveAttribute('data-holder', '')
    await expect(page.getByTestId('capital-flags')).toHaveCount(0)

    // It is labelled for what it is, and offers nothing that builds.
    await expect(page.getByTestId('viewer-anonymous')).toContainText('NON-CANONICAL TEST CITY')
    for (const id of ['wallet', 'reset-demo', 'demo-guide', 'guide-reminder', 'confirm-contribution']) await expect(page.getByTestId(id), id).toHaveCount(0)
    await expect(page.locator('[data-testid^="join-"]')).toHaveCount(0)
    expect(violations).toEqual([])
    expect(problems).toEqual([])
  })

  test('every panel, the camera and a search for a Friend that is not here all work', async ({ context, page }) => {
    const violations = await watchCsp(context)
    const problems = watchErrors(page)
    await openEmptyCity(page)

    await page.getByTestId('nav-board').click()
    await expect(page.getByTestId('impact-0')).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.getByTestId('nav-standings').click()
    await expect(page.getByTestId('city-growth')).toBeVisible()
    for (const d of ['d1', 'd5', 'd9']) await expect(page.getByTestId(`growth-${d}`), d).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByTestId('nav-radio').click()
    await expect(page.getByTestId('radio')).toBeVisible()
    await page.keyboard.press('Escape')

    // No Friend has a property, so a search finds nothing and opens nothing.
    await page.getByTestId('friend-search').fill('812')
    await page.getByTestId('friend-search-go').click()
    await expect(page.getByTestId('building-panel')).toHaveCount(0)

    await page.getByTestId('rotate-right').click()
    await page.getByTestId('rotate-right').click()
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '30')
    await page.getByTestId('rotate-reset').click()
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '0')
    await expect(buildings(page)).toHaveCount(0)

    // A second read, and a poll, on the empty city.
    await page.reload()
    await openEmptyCity(page)
    await page.waitForTimeout(5_500)
    await expect(page.getByTestId('city')).toBeVisible()
    expect(violations).toEqual([])
    expect(problems).toEqual([])
  })

  test('a wallet can sign in and see the Friends it owns; owning one puts nothing in the city', async ({ context, page }) => {
    const violations = await watchCsp(context)
    const problems = watchErrors(page)
    await installWallet(context)
    await openEmptyCity(page)

    await page.getByTestId('connect-wallet').click()
    await expect(page.getByTestId('account-panel')).toHaveAttribute('data-viewer', 'anonymous')
    await page.getByTestId('wallet-connect').click()
    await expect(page.getByTestId('wallet-account')).toBeVisible()
    await page.getByTestId('sign-in').click()
    await expect(page.getByTestId('account-panel')).toHaveAttribute('data-viewer', 'authenticated')
    await expect(page.getByTestId('viewer-wallet')).toHaveText(short(ALICE))

    // The wallet owns three Friends (fixture ownership). None of them has a property, and none is drawn.
    await expect(page.getByTestId('my-friends')).toHaveAttribute('data-status', 'ready')
    await expect(page.getByTestId('owned-friend')).toHaveCount(3)
    await page.keyboard.press('Escape')
    await expect(buildings(page)).toHaveCount(0)
    await expect(page.getByTestId('player-marker')).toHaveCount(0)
    for (const id of ['wallet', 'nav-profile', 'confirm-contribution', 'open-architect']) await expect(page.getByTestId(id), id).toHaveCount(0)
    const city = await page.evaluate(async () => (await (await fetch('/v1/city', { cache: 'no-store' })).json()).city)
    expect(city).toMatchObject({ sequence: 1 })

    await page.getByTestId('open-account').click()
    await page.getByTestId('sign-out').click()
    await expect(page.getByTestId('account-panel')).toHaveAttribute('data-viewer', 'anonymous')
    expect(violations).toEqual([])
    expect(problems).toEqual([])
  })
})
