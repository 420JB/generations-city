import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, request, test, type Browser, type Page } from '@playwright/test'
import pg from 'pg'
import { claim, designOption, openProperty, records, still } from '../e2e-city-play/constructionHelpers'
import { install, launch, launchHref, publish } from '../e2e-city-play/play'
import { ACCESS_PASSWORD, ACCESS_USER, KEEPER_101, ORIGIN, PREVIEW_ADA, PREVIEW_BEA, PREVIEW_CONFIG, PREVIEW_CY, PREVIEW_GUILD, STATE_FILE } from './preview'

/**
 * THE HOSTED PREVIEW, end to end, as a tester meets it: the access gate first, then a Proofy Play launch into the real
 * Districts Play client SERVED BY THE DISTRICTS SERVER ITSELF (no Vite), under the strict CSP, over https with Secure
 * `__Host-` cookies. The committed synthetic world (hosted-preview/): a claim and exact plot, Tier 1 and Tier 2 with
 * owner and patron TEST credits, a six-category Architect design, a reload, the Architect Portfolio and Property Legacy.
 *
 * PREVIEW_PHASE=founding (controller variant a) builds it; PREVIEW_PHASE=transfer (variant b: the same file but Bea named
 * keeper #101's controller), run after the server AND the database have restarted, checks it all survived and that the
 * previous controller's progress is kept. Synthetic NFTs, players and valueless TEST credits only. HEADLESS ONLY.
 */
const phase = process.env.PREVIEW_PHASE ?? 'founding'
const KEEPER_ID = KEEPER_101.slice(KEEPER_101.lastIndexOf('/') + 1)
const CREDENTIALS = { username: ACCESS_USER, password: ACCESS_PASSWORD, origin: ORIGIN }

let db: pg.Pool
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: process.env.PREVIEW_DATABASE_URL, max: 2 })
})
test.afterAll(async () => {
  await db.end()
})

interface Watch {
  csp: string[]
  foreign: string[]
  errors: string[]
}

/** A player's page in a browser that knows the preview's access credential, from a Proofy Play launch. */
async function player(browser: Browser, name: string, discordUserId: string) {
  const context = await browser.newContext({ httpCredentials: CREDENTIALS })
  const page = await context.newPage()
  const watch: Watch = { csp: [], foreign: [], errors: [] }
  await page.addInitScript(() => {
    ;(window as unknown as { __csp: string[] }).__csp = []
    document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
  // Nothing leaves this origin: no chain, wallet, payment or third-party request of any kind.
  page.on('request', (r) => !r.url().startsWith(`${ORIGIN}/`) && !r.url().startsWith('data:') && !r.url().startsWith('blob:') && watch.foreign.push(r.url()))
  page.on('console', (m) => m.type() === 'error' && watch.errors.push(m.text()))
  const answer = await page.goto(launchHref(await launch(PREVIEW_GUILD, 'rare-city', name, discordUserId)))
  expect(answer?.status()).toBe(200)
  await expect(page.getByTestId('play-city')).toBeAttached()
  await expect(page.getByTestId('city-svg')).toBeVisible()
  return { context, page, watch }
}

async function clean(page: Page, watch: Watch) {
  watch.csp.push(...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)))
  expect(watch.csp, 'CSP violations').toEqual([])
  expect(watch.foreign, 'requests to another origin').toEqual([])
  expect(watch.errors.filter((e) => /Content Security Policy|Refused to/i.test(e))).toEqual([])
}

const onMap = (page: Page) => page.getByTestId('city-svg').getByTestId(`building-${KEEPER_ID}`)

async function build(page: Page, built: number) {
  const card = page.getByTestId('construction-card')
  await card.getByTestId('construction-action').click()
  await expect(card).toHaveAttribute('data-built', String(built))
  return card
}

const designsOf = async (propertyId: string) =>
  (await db.query<{ revision: number; facade: string; landscaping: string; designer: string }>('SELECT revision, facade, landscaping, designer_discord_user_id AS designer FROM world_property_designs WHERE property_id = $1 ORDER BY revision', [propertyId])).rows

test.describe('founding', () => {
  test.skip(phase !== 'founding', 'PREVIEW_PHASE=founding')

  test('the access gate refuses the playable preview to anyone without the credential, in a real browser', async ({ browser }) => {
    expect(existsSync(STATE_FILE), 'the founding run needs empty databases (README.md)').toBe(false)
    const anonymous = await browser.newContext()
    const page = await anonymous.newPage()
    const challenges: string[] = []
    page.on('response', (r) => r.status() === 401 && challenges.push(r.headers()['www-authenticate'] ?? ''))
    for (const path of ['/', '/#runToken=x', '/some/route', '/v1/play/city']) {
      // A browser with no credential to offer cancels the challenge: the navigation fails, and nothing of the page loads.
      await expect(page.goto(path), path).rejects.toThrow(/ERR_INVALID_AUTH_CREDENTIALS/)
      await expect(page.getByTestId('play-city')).toHaveCount(0)
    }
    expect(challenges.length).toBeGreaterThanOrEqual(4)
    for (const c of challenges) expect(c).toMatch(/^Basic realm="Districts private preview"/)
    const html = await (await (await browser.newContext({ httpCredentials: CREDENTIALS })).request.get('/')).text()
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
    expect(assets.length).toBeGreaterThanOrEqual(2)
    const outside = await request.newContext({ baseURL: ORIGIN, ignoreHTTPSErrors: true })
    const wrong = await request.newContext({ baseURL: ORIGIN, ignoreHTTPSErrors: true, httpCredentials: { ...CREDENTIALS, password: 'guess', send: 'always' } })
    for (const path of assets) {
      expect((await outside.get(path)).status(), path).toBe(401)
      expect((await outside.head(path)).status(), path).toBe(401)
      expect((await wrong.get(path)).status(), path).toBe(401)
    }
    expect((await outside.post('/v1/play/session', { data: { runToken: 'x' } })).status()).toBe(401)
    expect((await outside.get('/health')).status()).toBe(200)
    await anonymous.close()
  })

  test('a tester claims, builds to Tier 2 with a patron, saves a six-category design, reloads, and reads the portfolio and legacy', async ({ browser }) => {
    // The preview's operator installs Rare City on the synthetic Discord server and publishes the synthetic configuration once.
    const installation = await install(PREVIEW_GUILD)
    await publish(PREVIEW_GUILD, installation, PREVIEW_CONFIG)

    const ada = await player(browser, 'Preview Ada', PREVIEW_ADA)
    // The play session is a Secure, HttpOnly, SameSite=Strict, host-only __Host- cookie for this origin.
    const cookies = await ada.context.cookies(ORIGIN)
    expect(cookies.map((c) => c.name)).toEqual(['__Host-rc_play'])
    expect(cookies[0]).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict', path: '/', domain: 'localhost' })
    expect(ada.page.url()).toBe(`${ORIGIN}/`)

    // Every change the page sends, as sent: replayed below without the play session.
    const sent: { path: string; body: unknown }[] = []
    ada.page.on('request', (r) => r.method() === 'POST' && r.url().includes('/v1/play/rehearsal/') && sent.push({ path: new URL(r.url()).pathname, body: r.postDataJSON() }))
    const placed = await claim(ada.page, KEEPER_101)
    let card = ada.page.getByTestId('construction-card')
    await expect(card).toHaveAttribute('data-recipe', 'local-test-tier2-v1')
    await build(ada.page, 50)
    await build(ada.page, 100)
    await expect(card).toHaveAttribute('data-tier', '1')

    // Cy builds on it as a patron.
    const cy = await player(browser, 'Preview Cy', PREVIEW_CY)
    const cyCard = await openProperty(cy.page, placed.plotId, placed.buildingId)
    await cyCard.getByTestId('construction-action').click()
    await expect(cyCard).toHaveAttribute('data-built', '150')

    // Ada, its controller, takes it to Tier 2.
    await ada.page.reload()
    await openProperty(ada.page, placed.plotId, placed.buildingId)
    await build(ada.page, 200)
    card = await build(ada.page, 250)
    await expect(card).toHaveAttribute('data-tier', '2')
    await expect(onMap(ada.page)).toHaveAttribute('data-tier', '2')

    // A six-category Architect design.
    await ada.page.getByTestId('design-card').getByTestId('design-open').click()
    const panel = ada.page.getByTestId('design-panel')
    await expect(panel).toHaveAttribute('data-state', 'ready')
    for (const id of ['design-facade-copper', 'design-roof-dome', 'design-windows-ribbon', 'design-lighting-warm', 'design-entrance-portico', 'design-landscaping-garden']) await (await designOption(panel, id)).click()
    await panel.getByTestId('design-save').click()
    await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'saved')
    expect(await designsOf(placed.propertyId)).toEqual([{ revision: 1, facade: 'copper', landscaping: 'garden', designer: PREVIEW_ADA }])

    // A reload keeps all of it.
    await ada.page.reload()
    await expect(ada.page.getByTestId('city-svg')).toBeVisible()
    await still(ada.page)
    await expect(onMap(ada.page)).toHaveAttribute('data-tier', '2')
    await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'copper')
    await expect(onMap(ada.page)).toHaveAttribute('data-grounds', 'garden')

    // The Architect Portfolio and the Property Legacy.
    await ada.page.getByTestId('nav-properties').click()
    await ada.page.getByTestId('my-properties-architect').click()
    const portfolio = ada.page.getByTestId('architect-activity')
    await expect(portfolio).toHaveAttribute('data-state', 'ready')
    await expect(portfolio.getByTestId('architect-totals')).toHaveAttribute('data-owner-units', '200')
    await expect(portfolio.getByTestId('portfolio-filter-controlled')).toHaveAttribute('data-count', '1')
    const item = portfolio.locator(`[data-testid="architect-property"][data-building="${placed.buildingId}"]`)
    await expect(item.getByTestId('architect-property-design-summary')).toContainText('Copper · Dome · Ribbon glass · Warm floodlights · Grand portico · Garden grounds · revision 1')
    await item.getByTestId('architect-property-legacy').click()
    const legacy = ada.page.getByTestId('property-legacy')
    await expect(legacy).toHaveAttribute('data-state', 'ready')
    await expect(legacy.getByTestId('legacy-founding')).toHaveAttribute('data-founding', 'viewer')
    await expect(legacy.getByTestId('legacy-control')).toHaveAttribute('data-control', 'viewer')
    const inv = legacy.getByTestId('legacy-investment')
    for (const [k, v] of Object.entries({ 'data-current-controller': '200', 'data-previous-controllers': '0', 'data-community': '50', 'data-total': '250' })) await expect(inv).toHaveAttribute(k, v)

    // The access credential alone is never game authority: Ada's own requests, exactly as her page sent them (her session,
    // world and player named in them), with the gate's credential but without her play session cookie, write nothing.
    const gateOnly = await request.newContext({ baseURL: ORIGIN, ignoreHTTPSErrors: true, httpCredentials: { ...CREDENTIALS, send: 'always' } })
    const before = { constructions: await records(db).constructionsOf(placed.propertyId), designs: await designsOf(placed.propertyId) }
    expect(new Set(sent.map((s) => s.path))).toEqual(new Set(['/v1/play/rehearsal/assignment', '/v1/play/rehearsal/activations', '/v1/play/rehearsal/constructions', '/v1/play/rehearsal/designs']))
    for (const { path, body } of sent) {
      const refused = await gateOnly.post(path, { headers: { origin: ORIGIN }, data: body })
      expect(refused.status(), path).toBe(401)
      expect(await refused.json(), path).toEqual({ error: 'play_session_required' })
    }
    expect((await gateOnly.get('/v1/play/city')).status()).toBe(401)
    expect({ constructions: await records(db).constructionsOf(placed.propertyId), designs: await designsOf(placed.propertyId) }).toEqual(before)
    // Wallet sign-in and activation are not there at all.
    expect(await (await gateOnly.post('/v1/auth/challenge', { headers: { origin: ORIGIN }, data: {} })).json()).toEqual({ error: 'auth_unavailable' })
    expect(await (await gateOnly.post('/v1/activation/intents', { headers: { origin: ORIGIN }, data: {} })).json()).toEqual({ error: 'activation_disabled' })

    await clean(ada.page, ada.watch)
    await clean(cy.page, cy.watch)
    await ada.page.screenshot({ path: 'test-artifacts/hosted-preview-founding.png' })
    writeFileSync(STATE_FILE, JSON.stringify(placed, null, 2))
  })
})

test.describe('transfer', () => {
  test.skip(phase !== 'transfer', 'PREVIEW_PHASE=transfer')

  test('after a restart under controller variant b, everything persisted; Bea controls it now and Ada keeps her progress', async ({ browser }) => {
    const placed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { plotId: string; propertyId: string; buildingId: string }
    const bea = await player(browser, 'Preview Bea', PREVIEW_BEA)
    // Persisted across the server and database restart: Tier 2 and the saved design, for a player who never saw them.
    await still(bea.page)
    await expect(onMap(bea.page)).toHaveAttribute('data-tier', '2')
    await expect(onMap(bea.page)).toHaveAttribute('data-facade', 'copper')
    const card = await openProperty(bea.page, placed.plotId, placed.buildingId)
    await expect(card).toHaveAttribute('data-built', '250')
    // Bea is the named controller now: she may save a design, as revision 2.
    await bea.page.getByTestId('design-card').getByTestId('design-open').click()
    const panel = bea.page.getByTestId('design-panel')
    await expect(panel).toHaveAttribute('data-state', 'ready')
    await (await designOption(panel, 'design-facade-jade')).click()
    await panel.getByTestId('design-save').click()
    await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'saved')
    expect(await designsOf(placed.propertyId)).toEqual([
      { revision: 1, facade: 'copper', landscaping: 'garden', designer: PREVIEW_ADA },
      { revision: 2, facade: 'jade', landscaping: 'garden', designer: PREVIEW_BEA },
    ])
    // Bea's view of the legacy: Ada's 200 units are an earlier controller's, kept.
    await panel.getByRole('button', { name: 'Close panel' }).click()
    await bea.page.reload()
    await openProperty(bea.page, placed.plotId, placed.buildingId)
    await bea.page.getByTestId('property-legacy-open').click()
    const legacy = bea.page.getByTestId('property-legacy')
    await expect(legacy).toHaveAttribute('data-state', 'ready')
    await expect(legacy.getByTestId('legacy-control')).toHaveAttribute('data-control', 'viewer')
    await expect(legacy.getByTestId('legacy-founding')).toHaveAttribute('data-founding', 'other')
    for (const [k, v] of Object.entries({ 'data-previous-controllers': '200', 'data-community': '50', 'data-total': '250' })) await expect(legacy.getByTestId('legacy-investment')).toHaveAttribute(k, v)
    await expect(legacy.getByTestId('legacy-design')).toHaveCount(2)

    // Ada: no longer its controller, but her founding and her 200 units are hers still, under earlier control.
    const ada = await player(browser, 'Preview Ada', PREVIEW_ADA)
    await ada.page.getByTestId('nav-properties').click()
    await ada.page.getByTestId('my-properties-architect').click()
    const portfolio = ada.page.getByTestId('architect-activity')
    await expect(portfolio).toHaveAttribute('data-state', 'ready')
    await expect(portfolio.getByTestId('architect-totals')).toHaveAttribute('data-owner-units', '200')
    await expect(portfolio.getByTestId('portfolio-filter-earlier')).toHaveAttribute('data-count', '1')
    await expect(portfolio.getByTestId('portfolio-filter-controlled')).toHaveAttribute('data-count', '0')
    await openProperty(ada.page, placed.plotId, placed.buildingId)
    await expect(ada.page.getByTestId('design-card').getByTestId('design-open')).toHaveCount(0)
    expect((await records(db).constructionsOf(placed.propertyId)).map((c) => [c.role, c.units, c.contributor_discord_user_id])).toEqual([
      ['owner', 50, PREVIEW_ADA],
      ['owner', 50, PREVIEW_ADA],
      ['patron', 50, PREVIEW_CY],
      ['owner', 50, PREVIEW_ADA],
      ['owner', 50, PREVIEW_ADA],
    ])
    await clean(bea.page, bea.watch)
    await clean(ada.page, ada.watch)
    await bea.page.screenshot({ path: 'test-artifacts/hosted-preview-transfer.png' })
  })
})
