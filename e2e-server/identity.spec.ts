import { expect, test, type Page } from '@playwright/test'
import { drawnCity, openSharedCity, readCity, watchErrors, withDatabase } from './harness.ts'
import { ACCOUNTS, installWallet, short } from './wallet.ts'

const [ALICE, BOB, CAROL] = ACCOUNTS.map((a) => a.address)

/** Open the account panel and take the wallet through connect and sign-in. */
async function signIn(page: Page) {
  await page.getByTestId('connect-wallet').click()
  await expect(page.getByTestId('account-panel')).toHaveAttribute('data-viewer', 'anonymous')
  await page.getByTestId('wallet-connect').click()
  await expect(page.getByTestId('wallet-account')).toBeVisible()
  await page.getByTestId('sign-in').click()
  await expect(page.getByTestId('account-panel')).toHaveAttribute('data-viewer', 'authenticated')
}
const viewer = (page: Page) => page.evaluate(async () => (await fetch('/v1/viewer', { cache: 'no-store' })).json())
const cityRows = () => withDatabase(async (db) => ({ sequence: (await db.query('SELECT sequence FROM city')).rows[0].sequence, events: (await db.query('SELECT count(*)::int AS n FROM city_events')).rows[0].n }))
const ownedFriends = (page: Page) => page.getByTestId('owned-friend').evaluateAll((items) => items.map((el) => `${el.getAttribute('data-token')}:${el.textContent}`))

test.describe('a visitor without a wallet', () => {
  test('browses as before, is offered Connect Wallet, and is told when there is no wallet', async ({ page }) => {
    const problems = watchErrors(page)
    await openSharedCity(page)
    await expect(page.getByTestId('connect-wallet')).toHaveText('Connect Wallet')
    expect(await viewer(page)).toEqual({ authenticated: false })

    await page.getByTestId('connect-wallet').click()
    await expect(page.getByTestId('session-box')).toContainText('Browsing as a visitor')
    await expect(page.getByTestId('no-wallet')).toBeVisible()
    for (const id of ['wallet-connect', 'sign-in', 'sign-out', 'my-friends', 'switch-chain']) await expect(page.getByTestId(id), id).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('account-panel')).toHaveCount(0)
    await expect(page.getByTestId('building-812')).toBeAttached()
    expect(problems).toEqual([])
  })
})

test.describe('wallet sign-in', () => {
  test('connects, signs the server challenge, and shows the wallet and the Friends it owns', async ({ context, page }) => {
    const problems = watchErrors(page)
    const wallet = await installWallet(context)
    await openSharedCity(page)
    const before = await readCity(page)
    const drawn = await drawnCity(page)
    const rows = await cityRows()

    // Nothing has been asked of the wallet beyond what it already shares.
    expect((await wallet.calls(page)).filter((m) => m !== 'eth_accounts' && m !== 'eth_chainId')).toEqual([])
    await signIn(page)

    // The wallet signed exactly one thing: a Rare City sign-in for this site, account and chain.
    expect(wallet.signed).toHaveLength(1)
    const lines = wallet.signed[0].split('\n')
    expect(lines[0]).toBe(`${new URL(page.url()).host} wants you to sign in with your Ethereum account:`)
    expect(lines[1]).toBe(ALICE)
    expect(lines).toContain('Chain ID: 4663')
    expect(lines).toContain(`URI: ${new URL(page.url()).origin}`)
    expect((await wallet.calls(page)).filter((m) => m.startsWith('eth_send') || m.includes('Transaction') || m.includes('signTypedData'))).toEqual([])

    await expect(page.getByTestId('viewer-authenticated')).toHaveAttribute('data-address', ALICE)
    await expect(page.getByTestId('viewer-wallet')).toHaveText(short(ALICE))
    await expect(page.getByTestId('viewer-anonymous')).toHaveCount(0)
    await expect(page.getByTestId('session-address')).toHaveText(ALICE)
    expect(await viewer(page)).toMatchObject({ authenticated: true, wallet: { address: ALICE, chainId: 4663 } })

    // My Friends: the owned token ids with their families, labelled as fixture data.
    await expect(page.getByTestId('my-friends')).toHaveAttribute('data-status', 'ready')
    expect(await ownedFriends(page)).toEqual(['812:Friend #812Family', '1204:Friend #1204Skeleton', '4471:Friend #4471Sparkling'])
    await expect(page.getByTestId('friends-source')).toHaveAttribute('data-source', 'fixture')
    await expect(page.getByTestId('friends-source')).toContainText('NOT REAL OWNERSHIP')

    // Signing in changed who is looking, and nothing about the city.
    const after = await readCity(page)
    expect(after).toEqual(before)
    expect(await cityRows()).toEqual(rows)
    await page.keyboard.press('Escape')
    expect(await drawnCity(page)).toBe(drawn)
    expect(problems).toEqual([])
  })

  test('keeps the session in an HttpOnly cookie that script cannot read, and across a reload', async ({ context, page }) => {
    await installWallet(context)
    await openSharedCity(page)
    await signIn(page)

    const cookies = (await context.cookies()).filter((c) => c.name.includes('rc_session'))
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatchObject({ name: 'rc_session', httpOnly: true, sameSite: 'Strict', path: '/' })
    expect(cookies[0].value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(cookies[0].expires - Date.now() / 1000).toBeGreaterThan(6.9 * 86_400)
    expect(await page.evaluate(() => document.cookie)).not.toContain('rc_session')
    // Nothing about the session is kept anywhere script can reach.
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))
    expect(stored).toBe('[{},{}]')

    await page.reload()
    await expect(page.getByTestId('viewer-authenticated')).toHaveAttribute('data-address', ALICE)
    await page.getByTestId('open-account').click()
    // The wallet is no longer connected to the reloaded page; the session does not depend on it.
    await expect(page.getByTestId('wallet-connect')).toBeVisible()
    await expect(page.getByTestId('session-address')).toHaveText(ALICE)
    await expect(page.getByTestId('owned-friend')).toHaveCount(3)
  })

  test('signs out: the server session ends and the visitor is anonymous again', async ({ context, page }) => {
    const problems = watchErrors(page)
    await installWallet(context)
    await openSharedCity(page)
    const before = await readCity(page)
    await signIn(page)
    const cookie = (await context.cookies()).find((c) => c.name === 'rc_session')!

    await page.getByTestId('sign-out').click()
    await expect(page.getByTestId('account-panel')).toHaveAttribute('data-viewer', 'anonymous')
    await expect(page.getByTestId('viewer-anonymous')).toBeVisible()
    await expect(page.getByTestId('my-friends')).toHaveCount(0)
    expect(await viewer(page)).toEqual({ authenticated: false })
    expect((await context.cookies()).filter((c) => c.name === 'rc_session')).toEqual([])

    // The old credential is dead on the server, not merely forgotten by the browser.
    const replay = await page.request.get('/v1/viewer', { headers: { cookie: `rc_session=${cookie.value}` } })
    expect(await replay.json()).toEqual({ authenticated: false })
    expect((await page.request.get('/v1/viewer/friends', { headers: { cookie: `rc_session=${cookie.value}` } })).status()).toBe(401)
    expect(await readCity(page)).toEqual(before)
    expect(problems).toEqual([])
  })

  test('requires an explicit switch to Robinhood Chain before signing in', async ({ context, page }) => {
    const wallet = await installWallet(context, { chainId: 1 })
    await openSharedCity(page)
    await page.getByTestId('connect-wallet').click()
    await page.getByTestId('wallet-connect').click()
    await expect(page.getByTestId('wallet-chain')).toHaveAttribute('data-chain', '1')
    await expect(page.getByTestId('sign-in')).toHaveCount(0)
    expect(await wallet.calls(page)).not.toContain('wallet_switchEthereumChain')

    await page.getByTestId('switch-chain').click()
    await expect(page.getByTestId('wallet-chain')).toHaveAttribute('data-chain', '4663')
    await page.getByTestId('sign-in').click()
    await expect(page.getByTestId('account-panel')).toHaveAttribute('data-viewer', 'authenticated')
  })

  test('stays anonymous when the wallet declines, and says why', async ({ context, page }) => {
    const wallet = await installWallet(context)
    const sessions = () => withDatabase(async (db) => (await db.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n)
    const before = await sessions()
    await openSharedCity(page)
    await page.getByTestId('connect-wallet').click()
    await wallet.declineNext(page, 'eth_requestAccounts')
    await page.getByTestId('wallet-connect').click()
    await expect(page.getByTestId('identity-error')).toHaveText('The request was declined in the wallet.')

    await page.getByTestId('wallet-connect').click()
    await wallet.declineNext(page, 'personal_sign')
    await page.getByTestId('sign-in').click()
    await expect(page.getByTestId('identity-error')).toHaveText('The request was declined in the wallet.')
    await expect(page.getByTestId('account-panel')).toHaveAttribute('data-viewer', 'anonymous')
    expect(await viewer(page)).toEqual({ authenticated: false })
    expect(await sessions()).toBe(before)
  })

  test('says ownership could not be read, rather than showing an empty wallet', async ({ context, page }) => {
    const problems = watchErrors(page, [/Failed to load resource/])
    // The fixture provider is "down" for this account.
    await installWallet(context, { account: 2 })
    await openSharedCity(page)
    await signIn(page)
    await expect(page.getByTestId('session-address')).toHaveText(CAROL)
    await expect(page.getByTestId('my-friends')).toHaveAttribute('data-status', 'unavailable')
    await expect(page.getByTestId('friends-unavailable')).toContainText('does not mean the wallet is empty')
    await expect(page.getByTestId('friends-empty')).toHaveCount(0)
    await expect(page.getByTestId('owned-friend')).toHaveCount(0)
    await expect(page.getByTestId('friends-retry')).toBeVisible()
    expect(problems).toEqual([])
  })
})

test.describe('the wallet account is not the session', () => {
  test('switching account in the wallet does not change who is signed in; signing as the new account does', async ({ context, page }) => {
    const problems = watchErrors(page)
    const wallet = await installWallet(context)
    await openSharedCity(page)
    await signIn(page)
    await expect(page.getByTestId('owned-friend')).toHaveCount(3)

    await wallet.selectAccount(page, 1)
    await expect(page.getByTestId('wallet-account')).toHaveAttribute('data-address', BOB.toLowerCase())
    await expect(page.getByTestId('account-mismatch')).toContainText(`still signed in as ${short(ALICE)}`)
    await expect(page.getByTestId('viewer-authenticated')).toHaveAttribute('data-mismatch', 'true')
    await expect(page.getByTestId('viewer-authenticated')).toContainText('WALLET ACCOUNT CHANGED')
    // The session, the header and the Friends are all still Alice's.
    await expect(page.getByTestId('viewer-authenticated')).toHaveAttribute('data-address', ALICE)
    await expect(page.getByTestId('session-address')).toHaveText(ALICE)
    expect(await ownedFriends(page)).toEqual(['812:Friend #812Family', '1204:Friend #1204Skeleton', '4471:Friend #4471Sparkling'])
    expect(await viewer(page)).toMatchObject({ authenticated: true, wallet: { address: ALICE } })
    expect(wallet.signed).toHaveLength(1)

    // Becoming Bob takes Bob's own signature.
    // The wallet's own account is shown as the wallet reports it; the session address is the server's.
    await expect(page.getByTestId('sign-in')).toHaveText(`Sign in as ${short(BOB.toLowerCase())}`)
    await page.getByTestId('sign-in').click()
    await expect(page.getByTestId('viewer-authenticated')).toHaveAttribute('data-address', BOB)
    await expect(page.getByTestId('account-mismatch')).toHaveCount(0)
    expect(wallet.signed).toHaveLength(2)
    expect(wallet.signed[1].split('\n')[1]).toBe(BOB)
    await expect(page.getByTestId('owned-friend')).toHaveCount(1)
    expect(await ownedFriends(page)).toEqual(['77:Friend #77Hoverer'])
    expect(await viewer(page)).toMatchObject({ authenticated: true, wallet: { address: BOB } })
    expect(problems).toEqual([])
  })
})

test.describe('sessions are separate', () => {
  test('a second browser does not inherit the first one, and each sees only its own wallet and Friends', async ({ browser }) => {
    const [a, b] = await Promise.all([browser.newContext(), browser.newContext()])
    await installWallet(a, { account: 0 })
    await installWallet(b, { account: 1 })
    const [pageA, pageB] = await Promise.all([a.newPage(), b.newPage()])
    const problems = [...[pageA, pageB].map((p) => watchErrors(p))]
    await Promise.all([openSharedCity(pageA), openSharedCity(pageB)])
    const before = await readCity(pageA)

    await signIn(pageA)
    // B has loaded the same city from the same server and is still nobody.
    await pageB.reload()
    await openSharedCity(pageB)
    expect(await viewer(pageB)).toEqual({ authenticated: false })
    await expect(pageB.getByTestId('viewer-authenticated')).toHaveCount(0)

    await signIn(pageB)
    await expect(pageA.getByTestId('viewer-authenticated')).toHaveAttribute('data-address', ALICE)
    await expect(pageB.getByTestId('viewer-authenticated')).toHaveAttribute('data-address', BOB)
    const [viewerA, viewerB] = [await viewer(pageA), await viewer(pageB)]
    expect(viewerA.wallet.address).toBe(ALICE)
    expect(viewerB.wallet.address).toBe(BOB)
    expect(viewerA.userId).not.toBe(viewerB.userId)
    expect(await ownedFriends(pageA)).toHaveLength(3)
    expect(await ownedFriends(pageB)).toEqual(['77:Friend #77Hoverer'])

    // Both still read the one shared city, byte for byte, at the same sequence.
    const [cityA, cityB] = [await readCity(pageA), await readCity(pageB)]
    expect(cityA).toEqual(before)
    expect(cityB).toEqual(before)

    // A signing out does not touch B.
    await pageA.getByTestId('sign-out').click()
    await expect(pageA.getByTestId('viewer-anonymous')).toBeVisible()
    expect(await viewer(pageB)).toMatchObject({ authenticated: true, wallet: { address: BOB } })
    expect(await cityRows()).toEqual({ sequence: String(before.sequence), events: before.sequence })
    expect(problems.flat()).toEqual([])
    await Promise.all([a.close(), b.close()])
  })
})

test.describe('a signed-in wallet in a read-only city', () => {
  test('is offered nothing that spends, builds, activates or edits', async ({ context, page }) => {
    const problems = watchErrors(page)
    await installWallet(context)
    await openSharedCity(page)
    const rows = await cityRows()
    await signIn(page)
    await page.keyboard.press('Escape')

    // No demo player appears, and the profile stays hidden: a session is not a city actor.
    for (const id of ['wallet', 'hud-season', 'reset-demo', 'nav-help', 'nav-profile', 'demo-guide', 'guide-reminder', 'player-marker']) await expect(page.getByTestId(id), id).toHaveCount(0)

    // Friend #812 is one the signed-in wallet "owns" in the fixture: its building is still just a building.
    await page.getByTestId('friend-search').fill('812')
    await page.getByTestId('friend-search-go').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '812')
    await expect(page.getByTestId('read-only-note')).toBeVisible()
    for (const id of ['amount-exact', 'amount-100', 'confirm-contribution', 'rally-btn', 'panel-wallet', 'open-architect', 'allegiance-note']) await expect(page.getByTestId(id), id).toHaveCount(0)
    await expect(page.locator('.own-tag')).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.getByTestId('nav-standings').click()
    await expect(page.locator('[data-testid^="join-"]')).toHaveCount(0)
    await page.getByTestId('nav-radio').click()
    for (const id of ['demo-tools', 'rival-turn', 'simulate-growth', 'rally-calls']) await expect(page.getByTestId(id), id).toHaveCount(0)
    await page.keyboard.press('Escape')

    // The account panel itself has two actions: sign out, and (when it applies) sign in.
    await page.getByTestId('open-account').click()
    const buttons = await page.getByTestId('account-panel').getByRole('button').evaluateAll((els) => els.map((el) => el.textContent?.trim()))
    expect(buttons).toEqual(['✕', 'Sign out'])
    await expect(page.getByTestId('account-panel')).toContainText('properties cannot be activated here')

    // With a session cookie the API is exactly as read-only as without one.
    const attempts = await page.evaluate(async () => {
      const out: number[] = []
      for (const [method, path] of [['POST', '/v1/city'], ['POST', '/v1/commands'], ['POST', '/v1/viewer'], ['POST', '/v1/viewer/friends'], ['PUT', '/v1/viewer'], ['DELETE', '/v1/viewer/friends'], ['POST', '/v1/properties'], ['POST', '/v1/activate']])
        out.push((await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : JSON.stringify({ type: 'contribute', buildingId: 'b-812', amount: 38, tokenId: '812' }) })).status)
      return out
    })
    expect(attempts).toEqual([405, 405, 405, 405, 405, 405, 405, 405])
    expect(await cityRows()).toEqual(rows)
    expect(problems.filter((p) => !/405/.test(p))).toEqual([])
  })
})
