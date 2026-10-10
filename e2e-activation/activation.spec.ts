import { expect, test } from '@playwright/test'
import { ALICE, candidatePlots, friendRow, openFriends, openWorld, refusal, REHEARSED, reviewPlot, SIGNATURE, watchPage } from './world.ts'

const INTENTS = '/v1/activation/intents'
const COMMITS = '/v1/activations'
const buildings = (page: import('@playwright/test').Page) => page.locator('[data-testid^="building-"][data-total]')

test.describe('My Friends', () => {
  test('an activated Friend leads to its property and offers no Activate; an unactivated one offers it', async ({ page }) => {
    const { problems } = watchPage(page)
    const world = await openWorld(page)
    await openFriends(page)

    // The rehearsed Friend: a real Friend with its property, never a demo Friend, never activatable again.
    const rehearsed = friendRow(page, REHEARSED.tokenId)
    await expect(rehearsed).toHaveAttribute('data-property', REHEARSED.plotId)
    await expect(rehearsed).toContainText('Friend #345260')
    await expect(rehearsed).toContainText('Skeleton')
    await expect(rehearsed.getByTestId('friend-property')).toHaveText('Ward 1 · Plot 1')
    await expect(rehearsed.getByTestId('friend-activate')).toHaveCount(0)
    for (const tokenId of ['1204', '812']) {
      await expect(friendRow(page, tokenId)).toHaveAttribute('data-property', 'none')
      await expect(friendRow(page, tokenId).getByTestId('friend-activate')).toHaveText('Activate')
    }
    await expect(page.getByTestId('account-panel')).not.toContainText(/Demo Friend/i)
    await expect(page.getByTestId('activation-help')).toContainText('a signature only: no transaction and no gas')

    // Its property opens as the real Friend it is.
    await rehearsed.getByTestId('friend-view-property').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', REHEARSED.tokenId)
    await expect(page.getByTestId('building-panel').getByRole('heading', { level: 2 })).toHaveText('Friend #345260')
    await expect(page.getByTestId('building-panel')).not.toContainText(/Demo Friend/i)
    await expect(page.getByTestId('building-address')).toContainText('Skeleton District · Ward I')
    await expect(page.getByTestId('building-address')).toContainText('Plot 1')
    await expect(page.getByTestId(`building-${REHEARSED.tokenId}`)).toHaveAttribute('aria-label', /^Friend #345260, /)

    // Looking is all that happened.
    expect(world.activationRequests).toEqual([])
    expect((await world.walletCalls()).map((c) => c.method).filter((m) => m !== 'eth_accounts' && m !== 'eth_chainId')).toEqual([])
    expect(problems).toEqual([])
  })

  test('a search for a Friend with no property says so without calling it a demo Friend', async ({ page }) => {
    await openWorld(page)
    await page.getByTestId('friend-search').fill('812')
    await page.getByTestId('friend-search-go').click()
    await expect(page.getByTestId('notice')).toHaveText('Friend #812 has no property in Rare City yet.')
  })
})

test.describe('choosing a plot', () => {
  test('only the free plots of the family district are offered, and the exact one picked is shown one-based', async ({ page }) => {
    const world = await openWorld(page)
    await openFriends(page)
    await friendRow(page, '1204').getByTestId('friend-activate').click()

    await expect(page.getByTestId('account-panel')).toHaveCount(0)
    const bar = page.getByTestId('activation-bar')
    await expect(bar).toHaveAttribute('data-district', 'd8')
    await expect(bar).toHaveAttribute('data-token', '1204')
    await expect(page.getByTestId('activation-friend')).toHaveText('FRIEND #1204 · SKELETON')
    await expect(bar).not.toContainText(/demo/i)
    await expect(page.getByTestId('placement-layer')).toHaveAttribute('data-district', 'd8')

    // Every candidate is a Skeleton District plot, and the one the rehearsed Friend holds is not among them.
    const sites = await candidatePlots(page)
    expect(sites.length).toBeGreaterThan(3)
    expect(sites.every((id) => id.startsWith('d8-0-'))).toBe(true)
    expect(sites).not.toContain('d8-0-0')
    await expect(page.getByTestId('activation-count')).toHaveAttribute('data-count', String(sites.length))
    for (const d of ['d1', 'd4', 'd7']) await expect(page.locator(`[data-testid^="candidate-plot-${d}-"]`)).toHaveCount(0)

    // Not the first free plot: the one the owner points at.
    await page.getByTestId('candidate-plot-d8-0-3').click()
    await expect(page.getByTestId('candidate-plot-d8-0-3')).toHaveAttribute('data-selected', 'true')
    const selected = page.getByTestId('activation-selected')
    await expect(selected).toHaveAttribute('data-plot-id', 'd8-w0-p3')
    await expect(selected).toContainText('Ward 1 · Plot 4')
    await expect(bar).not.toContainText(/Ward 0|Plot 0|d8-w0/)
    await page.getByTestId('activation-reselect').click()
    await page.getByTestId('candidate-plot-d8-0-5').click()
    await expect(selected).toContainText('Ward 1 · Plot 6')

    expect(world.activationRequests).toEqual([])
    expect([world.server.sequence, world.server.mutations]).toEqual([2, 0])
  })

  test('Cancel, Escape, and backing out of the review ask the server and the wallet for nothing', async ({ page }) => {
    const { problems } = watchPage(page)
    const world = await openWorld(page)

    // Cancel from the map.
    await openFriends(page)
    await friendRow(page, '1204').getByTestId('friend-activate').click()
    await page.getByTestId('candidate-plot-d8-0-2').click()
    await page.getByTestId('activation-cancel').click()
    await expect(page.getByTestId('activation-bar')).toHaveCount(0)
    await expect(page.getByTestId('placement-layer')).toHaveCount(0)

    // Escape from the map.
    await openFriends(page)
    await friendRow(page, '1204').getByTestId('friend-activate').click()
    await page.getByTestId('candidate-plot-d8-0-2').click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('activation-bar')).toHaveCount(0)

    // Into the review and out again: Escape closes the review, then the map; Cancel closes everything.
    await reviewPlot(page, '1204', 'd8', 0, 4)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('activation-dialog')).toHaveCount(0)
    await expect(page.getByTestId('activation-selected')).toHaveAttribute('data-plot-id', 'd8-w0-p4')
    await page.getByTestId('activation-review-open').click()
    await page.getByTestId('activation-back').click()
    await expect(page.getByTestId('activation-bar')).toBeVisible()
    await page.getByTestId('activation-review-open').click()
    await page.getByTestId('activation-dialog').getByTestId('activation-cancel').click()
    await expect(page.getByTestId('activation-dialog')).toHaveCount(0)
    await expect(page.getByTestId('activation-bar')).toHaveCount(0)

    // Nothing was requested, signed or changed, and the Friend is still unactivated.
    expect(world.activationRequests).toEqual([])
    expect((await world.walletCalls()).map((c) => c.method).filter((m) => m !== 'eth_accounts' && m !== 'eth_chainId')).toEqual([])
    expect([world.server.sequence, world.server.mutations, world.server.intents.size]).toEqual([2, 0, 0])
    await expect(buildings(page)).toHaveCount(1)
    await openFriends(page)
    await expect(friendRow(page, '1204')).toHaveAttribute('data-property', 'none')
    expect(problems).toEqual([])
  })
})

test.describe('activating', () => {
  test('review, one signature, and the Friend has its permanent property on the exact plot', async ({ page }) => {
    const { problems, texts } = watchPage(page)
    const world = await openWorld(page)
    await reviewPlot(page, '1204', 'd8', 0, 3)

    // The review says what this is, before anything has been asked of the server.
    const dialog = page.getByTestId('activation-dialog')
    await expect(page.getByTestId('review-friend')).toHaveText('#1204')
    await expect(page.getByTestId('review-family')).toHaveText('Skeleton')
    await expect(page.getByTestId('review-district')).toHaveText('Skeleton District')
    await expect(page.getByTestId('review-ward')).toHaveText('1')
    await expect(page.getByTestId('review-plot')).toHaveText('4')
    const terms = page.getByTestId('activation-terms')
    await expect(terms).toContainText('permanent Rare City property')
    await expect(terms).toContainText('If the NFT changes owner, the property goes with it')
    await expect(terms).toContainText('a signature only: no transaction, no gas, no NFT transfer, no RF movement, and no token or NFT approval')
    await expect(page.getByTestId('review-plot-id')).toBeHidden()
    expect(world.activationRequests).toEqual([])

    await page.getByTestId('activation-confirm').click()

    // It lands on the property the server reported: selected, focused, and named as a real Friend.
    await expect(page.getByTestId('activation-success')).toContainText('Friend #1204 is activated. Skeleton District · Ward 1 · Plot 4 is now its permanent Rare City property.')
    await expect(page.getByTestId('activation-success')).toHaveAttribute('data-plot-id', 'd8-w0-p3')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('activation-bar')).toHaveCount(0)
    await expect(page.getByTestId('placement-layer')).toHaveCount(0)
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '1204')
    await expect(page.getByTestId('building-panel').getByRole('heading', { level: 2 })).toHaveText('Friend #1204')
    await expect(page.getByTestId('building-address')).toContainText('Plot 4')
    await expect(page.getByTestId('building-1204')).toHaveAttribute('data-selected', 'true')
    await expect(page.getByTestId('city')).toHaveAttribute('data-detail', 'near')

    // Exactly one intent for exactly this Friend and plot, and exactly one commit of exactly that intent.
    expect(world.posts(INTENTS).map((r) => r.body)).toEqual(['{"tokenId":"1204","plotId":"d8-w0-p3"}'])
    const [intentId, intent] = [...world.server.intents.entries()][0]
    expect(world.posts(COMMITS).map((r) => r.body)).toEqual([JSON.stringify({ intentId, signature: SIGNATURE })])

    // The wallet was asked for one thing: to sign the server's typed data, exactly as sent.
    const calls = await world.walletCalls()
    const signs = calls.filter((c) => c.method === 'eth_signTypedData_v4')
    expect(signs).toHaveLength(1)
    expect(signs[0].params).toEqual([ALICE.toLowerCase(), JSON.stringify(intent.typedData)])
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(['eth_accounts', 'eth_chainId', 'eth_signTypedData_v4']))

    // One building more, one change, and My Friends now shows the property instead of Activate.
    await expect(buildings(page)).toHaveCount(2)
    expect([world.server.mutations, world.server.sequence, Object.keys(world.server.game.buildings).sort()]).toEqual([1, 3, ['b-1204', 'b-345260']])
    await page.getByTestId('open-account').click()
    await expect(friendRow(page, '1204')).toHaveAttribute('data-property', 'd8-w0-p3')
    await expect(friendRow(page, '1204').getByTestId('friend-property')).toHaveText('Ward 1 · Plot 4')
    await expect(friendRow(page, '1204').getByTestId('friend-activate')).toHaveCount(0)
    await expect(friendRow(page, '812').getByTestId('friend-activate')).toBeVisible()

    // The signature was sent to the server and went nowhere else.
    const kept = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie, document.documentElement.outerHTML]))
    expect(kept).not.toContain(SIGNATURE.slice(2))
    expect(texts.join('\n')).not.toContain(SIGNATURE.slice(2))
    expect(await page.evaluate(async () => (await indexedDB.databases()).length)).toBe(0)
    expect(problems).toEqual([])
  })

  test('a Friend of another family goes to its own district', async ({ page }) => {
    const world = await openWorld(page)
    await openFriends(page)
    await friendRow(page, '812').getByTestId('friend-activate').click()
    await expect(page.getByTestId('activation-bar')).toHaveAttribute('data-district', 'd4')
    const sites = await candidatePlots(page)
    expect(sites.every((id) => id.startsWith('d4-0-'))).toBe(true)
    // The Family District is empty, so its first plot is on offer; it is taken only because it is picked.
    await page.getByTestId('candidate-plot-d4-0-0').click()
    await expect(page.getByTestId('activation-selected')).toContainText('Ward 1 · Plot 1')
    await page.getByTestId('activation-review-open').click()
    await page.getByTestId('activation-confirm').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '812')
    expect(world.posts(INTENTS).map((r) => r.body)).toEqual(['{"tokenId":"812","plotId":"d4-w0-p0"}'])
    expect(world.server.game.buildings['b-812']).toMatchObject({ districtId: 'd4', ward: 0, plot: 0 })
  })
})

test.describe('what can go wrong at the wallet', () => {
  test('a wallet answer that is not 65 bytes is never sent, kept or logged', async ({ page }) => {
    const { problems, texts } = watchPage(page)
    const world = await openWorld(page)
    const blob = `0x${'c0ffee'.repeat(140)}`
    await world.setWallet({ signature: blob })
    await reviewPlot(page, '1204', 'd8', 0, 2)
    await page.getByTestId('activation-confirm').click()

    const notice = page.getByTestId('activation-notice')
    await expect(notice).toHaveAttribute('data-kind', 'unsupported-signing-mode')
    await expect(notice).toContainText('This wallet signing mode is not supported yet')
    await expect(notice).toContainText('returned 420 bytes')
    await expect(page.getByTestId('activation-dialog')).toHaveAttribute('data-phase', 'review')

    expect(world.posts(INTENTS)).toHaveLength(1)
    expect(world.posts(COMMITS)).toEqual([])
    expect(world.server.mutations).toBe(0)
    const kept = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie, document.documentElement.outerHTML]))
    expect(kept).not.toContain('c0ffeec0ffee')
    expect(texts.join('\n')).not.toContain('c0ffeec0ffee')

    // With a standard signature the same review goes through.
    await world.setWallet({ signature: SIGNATURE })
    await page.getByTestId('activation-confirm').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '1204')
    expect(world.posts(COMMITS)).toHaveLength(1)
    expect(problems).toEqual([])
  })

  test('declining, the wrong account and the wrong network are each said plainly, and commit nothing', async ({ page }) => {
    const world = await openWorld(page)
    await reviewPlot(page, '1204', 'd8', 0, 2)
    const notice = page.getByTestId('activation-notice')

    await world.setWallet({ declineNext: 'eth_signTypedData_v4' })
    await page.getByTestId('activation-confirm').click()
    await expect(notice).toHaveAttribute('data-kind', 'wallet-declined')
    await expect(notice).toContainText('You declined the signature in your wallet. Nothing changed.')

    await world.setWallet({ account: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' })
    await page.getByTestId('activation-confirm').click()
    await expect(notice).toHaveAttribute('data-kind', 'account-changed')
    await expect(notice).toContainText('different account selected than the one you are signed in with')

    await world.setWallet({ account: ALICE.toLowerCase(), chainId: 1 })
    await page.getByTestId('activation-confirm').click()
    await expect(notice).toHaveAttribute('data-kind', 'wrong-chain')
    await expect(notice).toContainText('Switch it to Robinhood Chain')
    expect(world.posts(COMMITS)).toEqual([])
    expect(world.server.mutations).toBe(0)

    // The offered switch is a network switch and nothing else; then it goes through.
    await page.getByTestId('activation-switch-chain').click()
    await expect(notice).toHaveCount(0)
    await page.getByTestId('activation-confirm').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '1204')
    const methods = new Set((await world.walletCalls()).map((c) => c.method))
    expect([...methods].sort()).toEqual(['eth_accounts', 'eth_chainId', 'eth_signTypedData_v4', 'wallet_switchEthereumChain'])
  })
})

test.describe('what can go wrong at the server', () => {
  test('a lost commit answer is recovered from My Friends, with one signature and one commit', async ({ page }) => {
    const world = await openWorld(page)
    world.server.script.commits.push('lost')
    await reviewPlot(page, '1204', 'd8', 0, 6)
    await page.getByTestId('activation-confirm').click()

    await expect(page.getByTestId('activation-success')).toHaveAttribute('data-plot-id', 'd8-w0-p6')
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '1204')
    expect([world.posts(INTENTS).length, world.posts(COMMITS).length, world.server.mutations]).toEqual([1, 1, 1])
    expect((await world.walletCalls()).filter((c) => c.method === 'eth_signTypedData_v4')).toHaveLength(1)
    await expect(buildings(page)).toHaveCount(2)
  })

  test('a gateway answer nobody recognises, after the commit landed, is not a failure: the property is found', async ({ page }) => {
    const { problems } = watchPage(page)
    const world = await openWorld(page)
    world.server.script.commits.push({ workThen: refusal(502, 'bad_gateway') })
    await reviewPlot(page, '1204', 'd8', 0, 5)
    await page.getByTestId('activation-confirm').click()

    await expect(page.getByTestId('activation-success')).toHaveAttribute('data-plot-id', 'd8-w0-p5')
    await expect(page.getByTestId('activation-success')).toHaveAttribute('data-pending', 'false')
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '1204')
    await expect(page.getByTestId('activation-dialog')).toHaveCount(0)
    expect([world.posts(INTENTS).length, world.posts(COMMITS).length, world.server.mutations]).toEqual([1, 1, 1])
    expect((await world.walletCalls()).filter((c) => c.method === 'eth_signTypedData_v4')).toHaveLength(1)
    // The browser reports the 502 itself; the page adds nothing of its own.
    expect(problems.filter((p) => !/502/.test(p))).toEqual([])
  })

  test('the same answer with nothing committed keeps the signature: "Try again" sends it, and the wallet is not asked twice', async ({ page }) => {
    const world = await openWorld(page)
    world.server.script.commits.push(refusal(502, 'bad_gateway'), refusal(502, 'bad_gateway'), refusal(502, 'bad_gateway'))
    await reviewPlot(page, '1204', 'd8', 0, 5)
    await page.getByTestId('activation-confirm').click()

    // Sent, then twice more by itself with a pause between; then it is the person's call.
    const dialog = page.getByTestId('activation-dialog')
    await expect(dialog).toHaveAttribute('data-phase', 'unresolved', { timeout: 25_000 })
    const notice = page.getByTestId('activation-notice')
    await expect(notice).toHaveAttribute('data-kind', 'commit-unknown')
    await expect(notice).toHaveText('Rare City did not confirm whether your activation went through. You can try again without signing again, or stop and check My Friends in a moment.')
    await expect(dialog).not.toContainText(/nothing was (signed|activated)|nothing changed/i)
    await expect(page.getByTestId('activation-confirm')).toHaveCount(0)
    expect([world.posts(INTENTS).length, world.posts(COMMITS).length, world.server.mutations]).toEqual([1, 3, 0])

    await page.getByTestId('activation-retry').click()
    await expect(page.getByTestId('activation-success')).toHaveAttribute('data-plot-id', 'd8-w0-p5')
    // One intent, one signature, and four sends of exactly the same body.
    expect(world.posts(INTENTS)).toHaveLength(1)
    expect(new Set(world.posts(COMMITS).map((r) => r.body)).size).toBe(1)
    expect([world.posts(COMMITS).length, world.server.mutations]).toEqual([4, 1])
    expect((await world.walletCalls()).filter((c) => c.method === 'eth_signTypedData_v4')).toHaveLength(1)
  })

  test('a rate limit is a wait, not a failure: nothing is sent before Retry-After, then the same signature goes', async ({ page }) => {
    const world = await openWorld(page)
    world.server.script.commits.push({ status: 429, json: { error: 'rate_limited' }, headers: { 'retry-after': '3' } })
    await reviewPlot(page, '1204', 'd8', 0, 5)
    await page.getByTestId('activation-confirm').click()

    const dialog = page.getByTestId('activation-dialog')
    await expect(dialog).toHaveAttribute('data-phase', 'unresolved')
    const notice = page.getByTestId('activation-notice')
    await expect(notice).toHaveAttribute('data-kind', 'rate_limited')
    await expect(notice).toContainText('Rare City is limiting how often an activation can be sent. Wait about 3 seconds, then try again.')
    await expect(page.getByTestId('activation-stop')).toBeVisible()

    // Pressed at once, several times: the page sends nothing, and says how long is left.
    for (let i = 0; i < 4; i++) await page.getByTestId('activation-retry').click()
    await expect(dialog).toHaveAttribute('data-phase', 'unresolved')
    await expect(notice).toHaveAttribute('data-kind', 'rate_limited')
    expect([world.posts(COMMITS).length, world.server.mutations]).toEqual([1, 0])

    // After the wait it goes, with the signature already given.
    await page.waitForTimeout(3_100)
    await page.getByTestId('activation-retry').click()
    await expect(page.getByTestId('activation-success')).toHaveAttribute('data-plot-id', 'd8-w0-p5')
    expect([world.posts(INTENTS).length, world.posts(COMMITS).length, world.server.mutations]).toEqual([1, 2, 1])
    expect(new Set(world.posts(COMMITS).map((r) => r.body)).size).toBe(1)
    expect((await world.walletCalls()).filter((c) => c.method === 'eth_signTypedData_v4')).toHaveLength(1)
  })

  test('switched off at the commit, after signing: said as it is, and a later activation clears the closed notice', async ({ page }) => {
    const world = await openWorld(page)
    world.server.script.commits.push(refusal(403, 'activation_disabled'))
    await reviewPlot(page, '1204', 'd8', 0, 1)
    await page.getByTestId('activation-confirm').click()

    const dialog = page.getByTestId('activation-dialog')
    await expect(dialog).toHaveAttribute('data-phase', 'stopped')
    await expect(page.getByTestId('activation-notice')).toHaveText('Activation is currently disabled, so Rare City could not complete this activation. Check My Friends before trying again.')
    await expect(dialog).not.toContainText(/nothing was signed|nothing changed/i)
    expect((await world.walletCalls()).filter((c) => c.method === 'eth_signTypedData_v4')).toHaveLength(1)
    await page.getByTestId('activation-close').click()
    await openFriends(page)
    await expect(page.getByTestId('activation-closed')).toHaveText('Activation is not open in this city yet.')
    await expect(friendRow(page, '1204')).toHaveAttribute('data-property', 'none')

    // The server takes the next one: the closed notice goes with it.
    await friendRow(page, '1204').getByTestId('friend-activate').click()
    await page.getByTestId('candidate-plot-d8-0-1').click()
    await page.getByTestId('activation-review-open').click()
    await page.getByTestId('activation-confirm').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '1204')
    await page.getByTestId('open-account').click()
    await expect(page.getByTestId('my-friends')).toHaveAttribute('data-status', 'ready')
    await expect(page.getByTestId('activation-closed')).toHaveCount(0)
    await expect(page.getByTestId('activation-help')).toBeVisible()
    expect(world.server.mutations).toBe(1)
  })

  test('activation switched off is said plainly and nothing pretends otherwise', async ({ page }) => {
    const { problems } = watchPage(page)
    const world = await openWorld(page)
    world.server.script.intents.push(refusal(403, 'activation_disabled'))
    await reviewPlot(page, '1204', 'd8', 0, 1)
    await page.getByTestId('activation-confirm').click()

    const dialog = page.getByTestId('activation-dialog')
    await expect(dialog).toHaveAttribute('data-phase', 'stopped')
    await expect(page.getByTestId('activation-notice')).toHaveText('Activation is not open in this city yet. Nothing was signed and nothing changed.')
    for (const id of ['activation-confirm', 'activation-retry', 'activation-working']) await expect(page.getByTestId(id), id).toHaveCount(0)
    await page.getByTestId('activation-close').click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('activation-success')).toHaveCount(0)
    await expect(buildings(page)).toHaveCount(1)

    await openFriends(page)
    await expect(page.getByTestId('activation-closed')).toHaveText('Activation is not open in this city yet.')
    await expect(friendRow(page, '1204')).toHaveAttribute('data-property', 'none')
    expect((await world.walletCalls()).filter((c) => c.method === 'eth_signTypedData_v4')).toEqual([])
    expect(world.posts(COMMITS)).toEqual([])
    // The browser reports the 403 itself; the page adds nothing of its own.
    expect(problems.filter((p) => !/403/.test(p))).toEqual([])
  })

  test('a plot taken by somebody else returns to the map, and another plot works', async ({ page }) => {
    const world = await openWorld(page)
    world.server.script.commits.push(refusal(409, 'plot_unavailable'))
    await reviewPlot(page, '1204', 'd8', 0, 2)
    await page.getByTestId('activation-confirm').click()

    await expect(page.getByTestId('activation-bar')).toBeVisible()
    await expect(page.getByTestId('activation-dialog')).toHaveCount(0)
    await expect(page.getByTestId('activation-notice')).toHaveAttribute('data-kind', 'plot_unavailable')
    // Said after the wallet signed: what the refusal proves, and not that nothing was signed.
    await expect(page.getByTestId('activation-notice')).toHaveText('Somebody else took that plot first, so this Friend was not activated. Choose another plot.')
    await expect(page.getByTestId('activation-selected')).toHaveCount(0)

    await page.getByTestId('candidate-plot-d8-0-4').click()
    await page.getByTestId('activation-review-open').click()
    await page.getByTestId('activation-confirm').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '1204')
    expect(world.posts(INTENTS).map((r) => r.body)).toEqual(['{"tokenId":"1204","plotId":"d8-w0-p2"}', '{"tokenId":"1204","plotId":"d8-w0-p4"}'])
    expect(world.server.game.buildings['b-1204']).toMatchObject({ ward: 0, plot: 4 })
  })

  test('ownership that cannot be checked is temporary: nothing is activated and nothing is signed', async ({ page }) => {
    const world = await openWorld(page)
    world.server.script.intents.push(refusal(503, 'ownership_unavailable'))
    await reviewPlot(page, '1204', 'd8', 0, 2)
    await page.getByTestId('activation-confirm').click()
    await expect(page.getByTestId('activation-notice')).toHaveAttribute('data-kind', 'ownership_unavailable')
    await expect(page.getByTestId('activation-notice')).toContainText('cannot check who owns this Friend right now, so nothing was activated')
    await expect(page.getByTestId('activation-dialog')).toHaveAttribute('data-phase', 'review')
    expect((await world.walletCalls()).filter((c) => c.method === 'eth_signTypedData_v4')).toEqual([])
    expect(world.server.mutations).toBe(0)
  })
})
