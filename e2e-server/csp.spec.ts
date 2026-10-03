import { expect, test, type Page } from '@playwright/test'
import { openSharedCity, watchCsp, watchErrors } from './harness.ts'
import { ACCOUNTS, installWallet, short } from './wallet.ts'

/**
 * The Content-Security-Policy, proven in a real browser.
 *
 * The server tests pin the header text. These run the built server-mode app in Chromium
 * under that policy and listen for `securitypolicyviolation`: the app must work with
 * none, and the policy must actually refuse what it says it refuses.
 *
 * The test server runs in local mode (plain http), so the policy here is the deployed one
 * without `upgrade-insecure-requests` and without HSTS. Neither affects what may execute.
 */
const DOCUMENT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'self'"
const API_CSP = "default-src 'none'; frame-ancestors 'none'"
const ALICE = ACCOUNTS[0].address
/** A 1x1 transparent PNG. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const directives = (violations: string[]) => violations.map((v) => v.split(' ')[0])

async function signIn(page: Page) {
  await page.getByTestId('connect-wallet').click()
  await page.getByTestId('wallet-connect').click()
  await expect(page.getByTestId('wallet-account')).toBeVisible()
  await page.getByTestId('sign-in').click()
  await expect(page.getByTestId('account-panel')).toHaveAttribute('data-viewer', 'authenticated')
}

test.describe('security headers as served', () => {
  test('the app shell carries the document policy; data and files carry the restrictive one', async ({ request }) => {
    for (const path of ['/', '/friend/812']) {
      const shell = (await request.get(path)).headers()
      expect(shell['content-security-policy'], path).toBe(DOCUMENT_CSP)
      expect(shell['x-frame-options']).toBe('SAMEORIGIN')
      expect(shell['referrer-policy']).toBe('same-origin')
      expect(shell['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(), payment=()')
      expect(shell['cross-origin-opener-policy']).toBe('same-origin-allow-popups')
      expect(shell['x-content-type-options']).toBe('nosniff')
      // Plain http on a developer machine: nothing tells the browser to insist on https.
      expect(shell['strict-transport-security']).toBeUndefined()
    }
    for (const path of ['/v1/city', '/v1/viewer', '/version', '/favicon.svg']) {
      const headers = (await request.get(path)).headers()
      expect([path, headers['content-security-policy'], headers['x-frame-options']]).toEqual([path, API_CSP, 'DENY'])
    }
  })
})

test.describe('the app under the strict policy', () => {
  test('a visitor can load the city, explore it and open the wallet panel with no violation', async ({ context, page }) => {
    const violations = await watchCsp(context)
    const problems = watchErrors(page)
    await openSharedCity(page)

    // The city itself: buildings, the perimeter, the Crown, district art.
    await expect(page.getByTestId('building-812')).toHaveAttribute('data-total', '9962')
    await expect(page.getByTestId('city-perimeter')).toBeAttached()
    await expect(page.getByTestId('crown-spire')).toBeAttached()
    expect(await page.locator('.city-svg image, .city-svg img, img').count()).toBeGreaterThan(0)
    // The stylesheet applied (it is a file from this origin), and React's style properties applied too.
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.city-svg')!).willChange)).toBe('contents')
    expect(await page.locator('[style]').count()).toBeGreaterThan(0)

    // Build Board, WARP, rotation.
    await page.getByTestId('nav-board').click()
    await expect(page.getByTestId('impact-0')).toHaveAttribute('data-building', '812')
    await page.getByTestId('impact-0-warp').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '812')
    await page.keyboard.press('Escape')
    await page.getByTestId('rotate-right').click()
    await page.getByTestId('rotate-right').click()
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '30')
    await expect(page.getByTestId('crown-spire')).toBeAttached()
    await page.getByTestId('rotate-reset').click()
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '0')

    // Every panel, then the wallet panel.
    await page.getByTestId('nav-standings').click()
    await expect(page.getByTestId('city-growth')).toBeVisible()
    await page.getByTestId('nav-radio').click()
    await expect(page.getByTestId('radio-list')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('connect-wallet').click()
    await expect(page.getByTestId('session-box')).toContainText('Browsing as a visitor')
    await expect(page.getByTestId('no-wallet')).toBeVisible()

    // A second read of the city, and a poll, happen under the policy as well.
    await page.reload()
    await openSharedCity(page)
    expect(violations).toEqual([])
    expect(problems).toEqual([])
  })

  test('wallet connect, sign-in, My Friends and sign-out work with no violation', async ({ context, page }) => {
    const violations = await watchCsp(context)
    const problems = watchErrors(page)
    await installWallet(context)
    await openSharedCity(page)
    await signIn(page)

    await expect(page.getByTestId('viewer-authenticated')).toHaveAttribute('data-address', ALICE)
    await expect(page.getByTestId('viewer-wallet')).toHaveText(short(ALICE))
    await expect(page.getByTestId('my-friends')).toHaveAttribute('data-status', 'ready')
    await expect(page.getByTestId('owned-friend')).toHaveCount(3)
    expect(await page.evaluate(async () => (await fetch('/v1/viewer', { cache: 'no-store' })).json())).toMatchObject({ authenticated: true })

    await page.getByTestId('sign-out').click()
    await expect(page.getByTestId('account-panel')).toHaveAttribute('data-viewer', 'anonymous')
    await expect(page.getByTestId('viewer-anonymous')).toBeVisible()
    expect(violations).toEqual([])
    expect(problems).toEqual([])
  })
})

test.describe('what the policy refuses', () => {
  test('inline script, eval, inline style text and other origins are blocked; style properties and local images are not', async ({ context, page }) => {
    const violations = await watchCsp(context)
    await openSharedCity(page)

    const outcome = await page.evaluate(async (pixel) => {
      const flags = window as unknown as { __inlineRan?: boolean }
      const probe = document.createElement('div')
      document.body.appendChild(probe)

      // 1. Inline script.
      const script = document.createElement('script')
      script.textContent = 'window.__inlineRan = true'
      document.body.appendChild(script)

      // 2. Code from a string. Tried from a timer, in the page's own turn: the debugger call that runs this
      //    test body is itself exempt from the policy, and would make eval look allowed.
      const evalBlocked = await new Promise<boolean>((done) =>
        setTimeout(() => {
          const refused = (attempt: () => unknown) => {
            try {
              attempt()
              return false
            } catch (err) {
              return err instanceof EvalError
            }
          }
          done(refused(() => (0, eval)('1 + 1')) && refused(() => new Function('return 1')()))
        }, 0),
      )

      // 3. Style as text: an attribute, and a <style> element.
      probe.setAttribute('style', 'outline-width: 7px; outline-style: solid')
      const attributeApplied = getComputedStyle(probe).outlineWidth === '7px'
      const sheet = document.createElement('style')
      sheet.textContent = 'body { outline: 9px solid red }'
      document.head.appendChild(sheet)
      const styleElementApplied = getComputedStyle(document.body).outlineWidth === '9px'

      // 4. Style as a property, which is how React applies `style={{…}}`.
      probe.removeAttribute('style')
      probe.style.outlineStyle = 'solid'
      probe.style.outlineWidth = '5px'
      probe.style.setProperty('--probe', '1')
      const propertyApplied = getComputedStyle(probe).outlineWidth === '5px' && getComputedStyle(probe).getPropertyValue('--probe') === '1'

      // 5. Another origin: a request, and a frame.
      const fetched = await fetch('http://127.0.0.1:9/elsewhere').then(
        () => 'sent',
        () => 'blocked',
      )
      const frame = document.createElement('iframe')
      frame.src = 'http://127.0.0.1:9/frame'
      document.body.appendChild(frame)

      // 6. Images the app does use: a data URL and a blob.
      const load = (src: string) =>
        new Promise<boolean>((done) => {
          const img = new Image()
          img.onload = () => done(true)
          img.onerror = () => done(false)
          img.src = src
        })
      const bytes = Uint8Array.from(atob(pixel.slice(pixel.indexOf(',') + 1)), (c) => c.charCodeAt(0))
      const blob = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
      const images = [await load(pixel), await load(blob), await load('/favicon.svg')]

      await new Promise((r) => setTimeout(r, 300))
      probe.remove()
      frame.remove()
      sheet.remove()
      return { inlineRan: flags.__inlineRan === true, evalBlocked, attributeApplied, styleElementApplied, propertyApplied, fetched, images }
    }, PIXEL)

    expect(outcome).toEqual({ inlineRan: false, evalBlocked: true, attributeApplied: false, styleElementApplied: false, propertyApplied: true, fetched: 'blocked', images: [true, true, true] })
    await expect.poll(() => [...new Set(directives(violations))].sort()).toEqual(['connect-src', 'frame-src', 'script-src', 'script-src-elem', 'style-src-attr', 'style-src-elem'])
    // The app is still standing.
    await expect(page.getByTestId('building-812')).toBeAttached()
  })

  test('another site cannot frame the app; this origin can', async ({ page, baseURL }) => {
    // A page on another site that tries to frame Rare City.
    await page.route('http://parent.example/**', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>parent</title><iframe id="rc" src="${baseURL}/" width="800" height="600"></iframe>` }))
    await page.goto('http://parent.example/')
    const outside = page.frames().find((f) => f !== page.mainFrame())!
    await expect.poll(() => outside.url()).toMatch(/^chrome-error:/)
    await expect(outside.getByTestId('city')).toHaveCount(0)

    // A page on this origin framing itself is allowed.
    await page.route(`${baseURL}/__frame-test`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>self</title><iframe id="rc" src="/" width="1200" height="800"></iframe>' }))
    await page.goto(`${baseURL}/__frame-test`)
    await expect(page.frameLocator('#rc').getByTestId('city')).toBeVisible()
    await expect(page.frameLocator('#rc').getByTestId('building-812')).toBeAttached()
  })
})
