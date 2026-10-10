import { expect, test, type Page } from '@playwright/test'
import { watchCsp, watchErrors, withDatabase } from './harness.ts'
import { ACCOUNTS, installWallet, short } from './wallet.ts'

/**
 * FRIEND ACTIVATION, END TO END: the built app, served by the built server with
 * ACTIVATION_ENABLED=true, over a throwaway empty rehearsal city (the third test server,
 * see serve.ts). The server issues the real intent, verifies the real signature and writes
 * the real rows. Ownership is the deterministic fixture and the wallet is the mock one that
 * signs with the public development accounts: no chain, no real wallet, no real key.
 *
 * These tests share that one city and run in order.
 */
const LIVE = `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 4319) + 2}`
test.use({ baseURL: LIVE })
const ALICE = ACCOUNTS[0].address

const rows = () =>
  withDatabase(
    async (db) =>
      (
        await db.query(
          `SELECT (SELECT sequence::int FROM city) AS sequence, (SELECT count(*)::int FROM city_events) AS events, (SELECT count(*)::int FROM properties) AS properties,
                  (SELECT count(*)::int FROM ownership_eras) AS eras, (SELECT count(*)::int FROM activation_intents) AS intents,
                  (SELECT count(*)::int FROM activation_intents WHERE status = 'committed') AS committed`,
        )
      ).rows[0],
    'activation',
  )
const buildings = (page: Page) => page.locator('[data-testid^="building-"][data-total]')
const friendRow = (page: Page, tokenId: string) => page.locator(`[data-testid="owned-friend"][data-token="${tokenId}"]`)

/** Every request the page makes to an activation route. */
function watchActivation(page: Page) {
  const seen: { path: string; body: string }[] = []
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (path.startsWith('/v1/activation')) seen.push({ path, body: r.postData() ?? '' })
  })
  return { seen, to: (path: string) => seen.filter((r) => r.path === path) }
}

async function openAndSignIn(page: Page) {
  await page.goto('/')
  await expect(page.getByTestId('city')).toBeVisible()
  await page.getByTestId('connect-wallet').click()
  await page.getByTestId('wallet-connect').click()
  await expect(page.getByTestId('wallet-account')).toBeVisible()
  await page.getByTestId('sign-in').click()
  await expect(page.getByTestId('account-panel')).toHaveAttribute('data-viewer', 'authenticated')
  await expect(page.getByTestId('viewer-wallet')).toHaveText(short(ALICE))
  await expect(page.getByTestId('my-friends')).toHaveAttribute('data-status', 'ready')
}

/** From My Friends: Activate, pick the plot, open the review. Sends nothing. */
async function reviewPlot(page: Page, tokenId: string, district: string, ward: number, plot: number) {
  await friendRow(page, tokenId).getByTestId('friend-activate').click()
  await expect(page.getByTestId('activation-bar')).toHaveAttribute('data-district', district)
  await page.getByTestId(`candidate-plot-${district}-${ward}-${plot}`).click()
  await expect(page.getByTestId('activation-selected')).toHaveAttribute('data-plot-id', `${district}-w${ward}-p${plot}`)
  await page.getByTestId('activation-review-open').click()
  await expect(page.getByTestId('activation-dialog')).toHaveAttribute('data-phase', 'review')
}

test.beforeAll(async ({ request }) => {
  await expect.poll(async () => (await request.get(`${LIVE}/ready`).catch(() => null))?.status() ?? 0, { timeout: 30_000 }).toBe(200)
})

test.describe('activating a Friend against the real server', () => {
  test('My Friends offers Activate; choosing, reviewing, cancelling and Escape write nothing', async ({ context, page }) => {
    const violations = await watchCsp(context)
    const problems = watchErrors(page)
    const wallet = await installWallet(context)
    const activation = watchActivation(page)
    const before = await rows()
    expect(before).toEqual({ sequence: 1, events: 1, properties: 0, eras: 0, intents: 0, committed: 0 })
    await openAndSignIn(page)

    // Three owned Friends, none with a property: each can be activated, and the panel says what that means.
    for (const tokenId of ['812', '1204', '4471']) {
      await expect(friendRow(page, tokenId)).toHaveAttribute('data-property', 'none')
      await expect(friendRow(page, tokenId).getByTestId('friend-activate')).toBeVisible()
    }
    await expect(page.getByTestId('activation-help')).toContainText('a signature only: no transaction and no gas')

    // Cancel from the review.
    await reviewPlot(page, '1204', 'd8', 0, 2)
    await expect(page.getByTestId('activation-terms')).toContainText('permanent Rare City property')
    await page.getByTestId('activation-dialog').getByTestId('activation-cancel').click()
    await expect(page.getByTestId('activation-dialog')).toHaveCount(0)
    await expect(page.getByTestId('activation-bar')).toHaveCount(0)

    // Escape from the map.
    await page.getByTestId('open-account').click()
    await friendRow(page, '812').getByTestId('friend-activate').click()
    await expect(page.getByTestId('activation-bar')).toHaveAttribute('data-district', 'd4')
    await page.getByTestId('candidate-plot-d4-0-5').click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('activation-bar')).toHaveCount(0)

    // Not one request to an activation route, nothing asked of the wallet beyond sign-in, and no row anywhere.
    expect(activation.seen).toEqual([])
    expect(wallet.typed).toEqual([])
    expect(await rows()).toEqual(before)
    await expect(buildings(page)).toHaveCount(0)
    expect(violations).toEqual([])
    expect(problems).toEqual([])
  })

  test('an unsupported wallet answer is stopped in the page; a real signature activates the exact plot, once', async ({ context, page }) => {
    const violations = await watchCsp(context)
    const problems = watchErrors(page)
    const wallet = await installWallet(context)
    const activation = watchActivation(page)
    await openAndSignIn(page)
    await reviewPlot(page, '1204', 'd8', 0, 2)

    // The wallet answers with something that is not a 65-byte signature: it never leaves the page.
    const blob = `0x${'c0ffee'.repeat(140)}`
    await wallet.answerNextTypedWith(page, blob)
    await page.getByTestId('activation-confirm').click()
    await expect(page.getByTestId('activation-notice')).toHaveAttribute('data-kind', 'unsupported-signing-mode')
    await expect(page.getByTestId('activation-notice')).toContainText('This wallet signing mode is not supported yet')
    expect(activation.to('/v1/activation/intents')).toHaveLength(1)
    expect(activation.to('/v1/activations')).toEqual([])
    expect(await rows()).toEqual({ sequence: 1, events: 1, properties: 0, eras: 0, intents: 1, committed: 0 })

    // Confirmed again with a real signature. The server verifies it and writes everything together.
    await page.getByTestId('activation-confirm').click()
    await expect(page.getByTestId('activation-success')).toContainText('Friend #1204 is activated. Skeleton District · Ward 1 · Plot 3 is now its permanent Rare City property.')
    await expect(page.getByTestId('activation-dialog')).toHaveCount(0)
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '1204')
    // A real, ownership-backed property is a Friend, not a demo Friend.
    await expect(page.getByTestId('building-panel').getByRole('heading', { level: 2 })).toHaveText('Friend #1204')
    await expect(page.getByTestId('building-panel')).not.toContainText(/Demo Friend/i)
    await expect(page.getByTestId('building-address')).toContainText('Plot 3')
    await expect(page.getByTestId('building-1204')).toHaveAttribute('data-selected', 'true')
    await expect(buildings(page)).toHaveCount(1)

    // One building, one event, one property, its first era, one committed intent.
    expect(await rows()).toEqual({ sequence: 2, events: 2, properties: 1, eras: 1, intents: 1, committed: 1 })
    const property = await withDatabase(async (db) => (await db.query(`SELECT token_id::text AS token_id, plot_id, district_id, building_id, activated_sequence::int AS sequence FROM properties`)).rows[0], 'activation')
    expect(property).toEqual({ token_id: '1204', plot_id: 'd8-w0-p2', district_id: 'd8', building_id: 'b-1204', sequence: 2 })

    // What was sent: the exact Friend and zero-based plot id, then exactly the intent id and the wallet's signature.
    expect(activation.to('/v1/activation/intents').map((r) => r.body)).toEqual(['{"tokenId":"1204","plotId":"d8-w0-p2"}', '{"tokenId":"1204","plotId":"d8-w0-p2"}'])
    expect(wallet.typed).toHaveLength(1)
    const signedMessage = JSON.parse(wallet.typed[0].json).message
    expect(signedMessage).toMatchObject({ tokenId: '1204', plotId: 'd8-w0-p2', districtId: 'd8', ward: 0, plot: 2, familyName: 'Skeleton', wallet: ALICE, site: LIVE })
    const intentId = signedMessage.intentId.slice(2)
    expect(activation.to('/v1/activations').map((r) => r.body)).toEqual([JSON.stringify({ intentId, signature: wallet.typed[0].signature })])
    // Signatures only: the wallet was never asked to send, approve or switch anything.
    expect([...new Set(await wallet.calls(page))].sort()).toEqual(['eth_accounts', 'eth_chainId', 'eth_requestAccounts', 'eth_signTypedData_v4', 'personal_sign'])

    // Sending the same commit again changes nothing and answers with the same property.
    const again = await page.evaluate(async (body) => {
      const res = await fetch('/v1/activations', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      return { status: res.status, json: await res.json() }
    }, activation.to('/v1/activations')[0].body)
    expect(again).toMatchObject({ status: 200, json: { status: 'committed', property: { tokenId: '1204', plotId: 'd8-w0-p2', buildingId: 'b-1204', sequence: 2 } } })
    expect(await rows()).toEqual({ sequence: 2, events: 2, properties: 1, eras: 1, intents: 1, committed: 1 })

    // My Friends now shows the property, here and after a reload, and offers no second activation.
    await page.reload()
    await expect(page.getByTestId('building-1204')).toBeAttached()
    await page.getByTestId('open-account').click()
    await expect(friendRow(page, '1204')).toHaveAttribute('data-property', 'd8-w0-p2')
    await expect(friendRow(page, '1204').getByTestId('friend-property')).toHaveText('Ward 1 · Plot 3')
    await expect(friendRow(page, '1204').getByTestId('friend-activate')).toHaveCount(0)
    await friendRow(page, '1204').getByTestId('friend-view-property').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '1204')

    // The signature went to the server and nowhere else in the page.
    const kept = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]))
    expect(kept).not.toContain(wallet.typed[0].signature.slice(2, 40))
    expect(violations).toEqual([])
    expect(problems).toEqual([])
  })

  test('a commit whose answer is lost is recovered without a second signature or a second property', async ({ context, page }) => {
    const wallet = await installWallet(context)
    const activation = watchActivation(page)
    await openAndSignIn(page)
    // The server receives and commits the request; its answer never reaches the page.
    let dropped = 0
    await page.route('**/v1/activations', async (route) => {
      await route.fetch()
      dropped += 1
      await route.abort('connectionreset')
    })
    await reviewPlot(page, '812', 'd4', 0, 6)
    await page.getByTestId('activation-confirm').click()

    await expect(page.getByTestId('activation-success')).toHaveAttribute('data-plot-id', 'd4-w0-p6')
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '812')
    await expect(page.getByTestId('building-panel').getByRole('heading', { level: 2 })).toHaveText('Friend #812')
    await expect(page.getByTestId('building-812')).toHaveAttribute('data-selected', 'true')
    // The served city holds both properties and nothing else (up close, the map itself draws only what is in view).
    const served = await page.evaluate(async () => (await (await fetch('/v1/city', { cache: 'no-store' })).json()).state.buildings)
    expect(Object.keys(served).sort()).toEqual(['b-1204', 'b-812'])
    expect(served['b-812']).toMatchObject({ friendId: 812, districtId: 'd4', ward: 0, plot: 6 })
    // One intent, one signature, one commit sent, and the city changed exactly once more.
    expect([dropped, wallet.typed.length, activation.to('/v1/activation/intents').length, activation.to('/v1/activations').length]).toEqual([1, 1, 1, 1])
    expect(await rows()).toEqual({ sequence: 3, events: 3, properties: 2, eras: 2, intents: 2, committed: 2 })
    await page.getByTestId('open-account').click()
    await expect(friendRow(page, '812')).toHaveAttribute('data-property', 'd4-w0-p6')
    await expect(friendRow(page, '4471').getByTestId('friend-activate')).toBeVisible()
  })

  test('a gateway answer in place of the real one is not taken for a failure, whether or not the server committed', async ({ context, page }) => {
    const wallet = await installWallet(context)
    const activation = watchActivation(page)
    await openAndSignIn(page)
    // Something between the page and the server answers 502 with a code Rare City never sends. The first
    // time the request never reaches the server; the second time it does, and the real answer is thrown away.
    const gateway = { status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'bad_gateway' }) }
    let seen = 0
    await page.route('**/v1/activations', async (route) => {
      seen += 1
      if (seen === 2) await route.fetch()
      if (seen <= 2) return route.fulfill(gateway)
      return route.continue()
    })
    await reviewPlot(page, '4471', 'd2', 0, 1)
    await page.getByTestId('activation-confirm').click()

    // Never a failure and never a second signature: the second send landed, and My Friends showed it.
    await expect(page.getByTestId('activation-success')).toHaveAttribute('data-plot-id', 'd2-w0-p1', { timeout: 20_000 })
    await expect(page.getByTestId('activation-success')).toContainText('Friend #4471 is activated.')
    await expect(page.getByTestId('activation-dialog')).toHaveCount(0)
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '4471')
    expect([seen, wallet.typed.length, activation.to('/v1/activation/intents').length]).toEqual([2, 1, 1])
    // Both sends carried the one intent and the one signature.
    expect(new Set(activation.to('/v1/activations').map((r) => r.body))).toEqual(new Set([JSON.stringify({ intentId: JSON.parse(wallet.typed[0].json).message.intentId.slice(2), signature: wallet.typed[0].signature })]))
    expect(await rows()).toEqual({ sequence: 4, events: 4, properties: 3, eras: 3, intents: 3, committed: 3 })
    await page.getByTestId('open-account').click()
    await expect(friendRow(page, '4471')).toHaveAttribute('data-property', 'd2-w0-p1')
    await expect(friendRow(page, '4471').getByTestId('friend-activate')).toHaveCount(0)
  })
})
