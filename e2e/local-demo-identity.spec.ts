import { expect, test } from '@playwright/test'
import { openCity } from './helpers.ts'

// The local demo (what rarecity.world serves) has no server, no wallet and no sign-in.
// Wallet identity exists only in the server-mode build.
test.describe('local demo is untouched by wallet identity', () => {
  test('still has its demo player, its perimeter, and no wallet UI', async ({ page }) => {
    const problems: string[] = []
    page.on('pageerror', (e) => problems.push(e.message))
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()))
    await openCity(page)

    await expect(page.getByTestId('wallet')).toHaveText('25,000')
    await expect(page.getByTestId('nav-profile')).toBeVisible()
    await expect(page.getByTestId('reset-demo')).toBeVisible()
    await expect(page.getByTestId('city-perimeter')).toBeAttached()
    for (const id of ['connect-wallet', 'viewer-anonymous', 'viewer-authenticated', 'open-account', 'account-panel']) await expect(page.getByTestId(id), id).toHaveCount(0)
    expect(problems).toEqual([])
  })

  test('never calls a server and never talks to an injected wallet', async ({ page }) => {
    const api: string[] = []
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/v1/')) api.push(r.url())
    })
    // A wallet is present in the browser; the demo must not so much as ask it for its accounts.
    await page.addInitScript(() => {
      const calls: string[] = []
      const provider = { request: async ({ method }: { method: string }) => (calls.push(method), method === 'eth_chainId' ? '0x1237' : []), on() {}, removeListener() {} }
      Object.assign(window, { ethereum: provider, __walletCalls: calls })
      window.addEventListener('eip6963:requestProvider', () => calls.push('eip6963:requestProvider'))
    })
    await openCity(page)
    await page.getByTestId('nav-board').click()
    await page.getByTestId('impact-0-warp').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '812')
    await page.waitForTimeout(500)

    expect(api).toEqual([])
    expect(await page.evaluate(() => (window as unknown as { __walletCalls: string[] }).__walletCalls)).toEqual([])
  })
})
