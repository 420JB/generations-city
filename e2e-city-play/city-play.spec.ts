import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { BRAND_A, BRAND_B, keysOf } from './brands'
import { call, createConfigVersion, install, launch, launchHref, operator, publish, snowflake, type Launch } from './play'

/**
 * Proofy Play installations, end to end, against a REAL local Proofy Play: installs and
 * configuration versions go through Play's server-admin routes, launches through Play's player
 * route, and the Rare City server redeems the run token and loads the pinned configuration
 * with its own service credential. Only Proofy Core is stood in for (its token issuer key).
 * Every test uses fresh Discord servers, so tests never share an installation.
 *
 * Each installation's city is PERSISTENT: its first launch founds it in the Rare City server's
 * database, and every later launch opens the same city, whatever configuration version it runs.
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHOTS = resolve(import.meta.dirname, '../test-artifacts/city-play-evidence')
mkdirSync(SHOTS, { recursive: true })

const districtKeys = (page: Page) => page.locator('[data-testid^="district-label-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('district-label-', '')))

/** Wait until the camera stops moving. */
async function still(page: Page) {
  let last = ''
  for (let i = 0; i < 80; i++) {
    const now = await page.getByTestId('city-svg').getAttribute('viewBox')
    if (now === last) return
    last = now ?? ''
    await page.waitForTimeout(120)
  }
}

/** Arrive from elsewhere, as a launch from the Proofy lobby does (a fresh document every time). */
async function arrive(page: Page, href: string) {
  await page.goto('about:blank')
  await page.goto(href)
}

async function openCity(page: Page, l: Launch) {
  await arrive(page, launchHref(l))
  await expect(page.getByTestId('play-city')).toBeAttached()
  await expect(page.getByTestId('city-svg')).toBeVisible()
}

async function openRefused(page: Page, href: string, code: string) {
  await arrive(page, href)
  await expect(page.getByTestId('play-gate')).toHaveAttribute('data-code', code)
  // Nothing is drawn instead: no city, no sample, no default.
  await expect(page.getByTestId('city-svg')).toHaveCount(0)
  await expect(page.getByTestId('city-name')).toHaveCount(0)
}

/** Open a launch over HTTP, as the page does, and return the answer. */
async function session(request: APIRequestContext, l: Launch) {
  const res = await request.post('/v1/play/session', { data: { runToken: l.runToken }, headers: { origin: 'http://localhost:4352' } })
  return { status: res.status(), body: (await res.json()) as { error?: string; world: { id: string; created: boolean; definition: { governingConfigVersion: number } }; play: { installationId: string } } }
}

/** A Discord server with Rare City installed and the given configuration active. */
async function installed(config: unknown) {
  const guild = snowflake()
  const installation = await install(guild)
  const published = await publish(guild, installation, config)
  return { guild, installation, ...published }
}

test.describe('two installations, two brands', () => {
  test('installation A loads Brand A and installation B loads Brand B, each from its own pinned configuration', async ({ page }) => {
    const a = await installed(BRAND_A)
    const b = await installed(BRAND_B)

    await openCity(page, await launch(a.guild, 'rare-city', 'Ada'))
    const city = page.getByTestId('play-city')
    await expect(city).toHaveAttribute('data-installation', a.installation)
    await expect(city).toHaveAttribute('data-guild', a.guild)
    await expect(city).toHaveAttribute('data-config-version', '1')
    await expect(city).toHaveAttribute('data-config-hash', a.configHash)
    await expect(page.getByTestId('city-name')).toHaveText('HARBORLIGHT')
    expect((await districtKeys(page)).sort()).toEqual(keysOf(BRAND_A).sort())
    await expect(page.locator('[data-testid^="district-"].district-ground')).toHaveCount(4)
    await expect(page.getByTestId('play-guild')).toHaveText(a.guild)
    // Its first launch founded A's persistent city, and it is empty: nothing simulated, nothing claimed.
    await expect(city).toHaveAttribute('data-world-created', 'true')
    await expect(city).toHaveAttribute('data-buildings', '0')
    await expect(page.locator('.bldg')).toHaveCount(0)
    await expect(page.getByTestId('play-world-note')).toContainText('just founded')
    await expect(page.getByTestId('viewer-select').locator('option').nth(1)).toHaveText('Ada · Proofy rules not checked')
    // The run token was taken out of the address bar and history as soon as the page read it.
    expect(page.url()).toBe('http://localhost:4352/')
    await still(page)
    await page.screenshot({ path: `${SHOTS}/installation-a-brand-a.png` })
    const worldA = await city.getAttribute('data-world')
    expect(worldA).toMatch(UUID_V7)

    // Relaunched: the same city, not a new one.
    await openCity(page, await launch(a.guild, 'rare-city', 'Ada'))
    await expect(city).toHaveAttribute('data-world', worldA!)
    await expect(city).toHaveAttribute('data-world-created', 'false')

    await openCity(page, await launch(b.guild, 'rare-city', 'Bea'))
    await expect(city).toHaveAttribute('data-installation', b.installation)
    await expect(city).toHaveAttribute('data-guild', b.guild)
    await expect(city).toHaveAttribute('data-config-hash', b.configHash)
    await expect(page.getByTestId('city-name')).toHaveText('NEON ORCHARD')
    expect((await districtKeys(page)).sort()).toEqual(keysOf(BRAND_B).sort())
    await expect(page.locator('[data-testid^="district-"].district-ground')).toHaveCount(6)
    await expect(page.getByTestId('district-label-fig-terrace').locator('rect').first()).toHaveAttribute('stroke', '#ef476f')
    await still(page)
    await page.screenshot({ path: `${SHOTS}/installation-b-brand-b.png` })
    const worldB = await city.getAttribute('data-world')
    expect(worldB).toMatch(UUID_V7)
    expect(worldB).not.toBe(worldA)
    await expect(city).toHaveAttribute('data-world-created', 'true')
    await openCity(page, await launch(b.guild, 'rare-city', 'Bea'))
    await expect(city).toHaveAttribute('data-world', worldB!)
    await expect(city).toHaveAttribute('data-world-created', 'false')
  })

  test('updating Brand A changes only installation A, and a run keeps the version it was launched with', async ({ page }) => {
    const a = await installed(BRAND_A)
    const b = await installed(BRAND_B)
    // The first launch founds A's city on version 1.
    const founded = await session(page.request, await launch(a.guild))
    expect(founded.body.world.definition.governingConfigVersion).toBe(1)
    const beforeUpdate = await launch(a.guild)

    const updated = { ...BRAND_A, cityName: 'Harborlight Reach', districts: BRAND_A.districts.map((d) => (d.key === 'saltmarsh' ? { ...d, name: 'Salt Flats', accent: '#e9c46a' } : d)) }
    const v2 = await publish(a.guild, a.installation, updated)
    expect(v2.version).toBe(2)
    expect(v2.configHash).not.toBe(a.configHash)

    await openCity(page, await launch(a.guild))
    await expect(page.getByTestId('city-name')).toHaveText('HARBORLIGHT REACH')
    // A new configuration version governs the SAME city: nothing was reset or replaced.
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-world', founded.body.world.id)
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-governing-version', '2')
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-config-version', '2')
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-config-hash', v2.configHash)
    await expect(page.getByTestId('district-label-saltmarsh')).toContainText('SALT FLATS')
    await expect(page.getByTestId('district-label-saltmarsh').locator('rect').first()).toHaveAttribute('stroke', '#e9c46a')
    await still(page)
    await page.screenshot({ path: `${SHOTS}/installation-a-brand-a-v2.png` })

    await openCity(page, await launch(b.guild))
    await expect(page.getByTestId('city-name')).toHaveText('NEON ORCHARD')
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-config-version', '1')
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-config-hash', b.configHash)

    // Launched before the update: pinned to v1 by Play, and Rare City loads exactly that version, in the same
    // city, without turning the city back to it.
    await openCity(page, beforeUpdate)
    await expect(page.getByTestId('city-name')).toHaveText('HARBORLIGHT')
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-config-version', '1')
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-config-hash', a.configHash)
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-world', founded.body.world.id)
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-governing-version', '2')
  })
})

test.describe('one persistent city per installation', () => {
  test('first launches racing each other found one city', async ({ request }) => {
    const a = await installed(BRAND_A)
    const launches = await Promise.all(Array.from({ length: 8 }, () => launch(a.guild)))
    const answers = await Promise.all(launches.map((l) => session(request, l)))
    expect(answers.map((x) => x.status)).toEqual(Array(8).fill(200))
    expect(new Set(answers.map((x) => x.body.world.id)).size).toBe(1)
    expect(answers.filter((x) => x.body.world.created)).toHaveLength(1)
  })

  test('a city with no property may still move its districts, and one that drops a collection is refused; the city is unchanged', async ({ page }) => {
    const a = await installed(BRAND_A)
    const first = await session(page.request, await launch(a.guild))
    // Reordered districts: no property stands anywhere yet, so this governs the same city (0008: geometry freezes at the first property).
    await publish(a.guild, a.installation, { ...BRAND_A, districts: [...BRAND_A.districts].reverse() })
    await openCity(page, await launch(a.guild))
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-world', first.body.world.id)
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-governing-version', '2')
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-geometry-frozen', 'false')
    await expect(page.getByTestId('play-geometry')).toHaveText('districts open')
    // Dropping a founding collection is refused whatever the city holds.
    await publish(a.guild, a.installation, { ...BRAND_A, collections: [BRAND_A.collections[0]], districts: BRAND_A.districts.map((d) => ({ ...d, monument: d.monument?.collection === 'tide-pass' ? null : d.monument })) })
    await openRefused(page, launchHref(await launch(a.guild)), 'config_incompatible')
    await expect(page.getByTestId('play-refusal')).toContainText('The city is unchanged')
    await expect(page.getByTestId('play-problems')).toContainText('cannot be removed')
    await page.screenshot({ path: `${SHOTS}/incompatible-config-refused.png` })
    await publish(a.guild, a.installation, { ...BRAND_A, cityName: 'Harborlight Bay' })
    await openCity(page, await launch(a.guild))
    await expect(page.getByTestId('city-name')).toHaveText('HARBORLIGHT BAY')
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-world', first.body.world.id)
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-governing-version', '4')
  })

  test('a server\'s launches only ever answer with its own city', async ({ request }) => {
    const a = await installed(BRAND_A)
    const b = await installed(BRAND_B)
    const worldB = (await session(request, await launch(b.guild))).body.world.id
    for (let i = 0; i < 3; i++) {
      const answer = await session(request, await launch(a.guild))
      expect(answer.body.play.installationId).toBe(a.installation)
      expect(answer.body.world.id).not.toBe(worldB)
      expect(JSON.stringify(answer.body)).not.toContain(worldB)
    }
    // A body that names a world is refused before Play is asked.
    const named = await request.post('/v1/play/session', { data: { runToken: (await launch(a.guild)).runToken, worldId: worldB }, headers: { origin: 'http://localhost:4352' } })
    expect([named.status(), await named.json()]).toEqual([422, { error: 'invalid_request' }])
  })
})

test.describe('authority: only Play decides which installation a launch belongs to', () => {
  test('a launch opens once; a replayed token is refused', async ({ page }) => {
    const a = await installed(BRAND_A)
    const l = await launch(a.guild)
    await openCity(page, l)
    await openRefused(page, launchHref(l), 'run_already_used')
  })

  test('a run token re-pointed at another installation is refused (the client cannot choose an installation)', async ({ page }) => {
    const a = await installed(BRAND_A)
    const b = await installed(BRAND_B)
    const l = await launch(a.guild)
    const [header, payload, signature] = l.runToken.split('.')
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    const forged = Buffer.from(JSON.stringify({ ...claims, iid: b.installation, discordGuildId: b.guild })).toString('base64url')
    await openRefused(page, `${l.launchUrl}#runToken=${header}.${forged}.${signature}`, 'run_token_refused')
    // The genuine token was not spent by the forgery and still opens Brand A only.
    await openCity(page, l)
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-installation', a.installation)
  })

  test('another game\'s run token is refused, even on a server that has Rare City installed', async ({ page }) => {
    const a = await installed(BRAND_A)
    // A second game on the same server, with its own credential, schema and configuration.
    const minted = await operator('POST', '/v1/operator/games/other-game/credentials', {})
    const otherCredential = minted.body.secret as string
    await call('PUT', '/v1/game/config-schemas/1', otherCredential, { jsonSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, properties: {} } })
    const other = await install(a.guild, 'other-game')
    await publish(a.guild, other, {})
    const l = await launch(a.guild, 'other-game')
    await openRefused(page, `http://localhost:4352/#runToken=${l.runToken}`, 'run_token_refused')
  })

  test('without a run token the page explains how to launch and draws nothing', async ({ page }) => {
    await openRefused(page, '/', '')
    await expect(page.getByTestId('play-gate')).toHaveAttribute('data-phase', 'no-token')
  })

  test('a new launch into an already open page starts a fresh city', async ({ page }) => {
    const a = await installed(BRAND_A)
    const b = await installed(BRAND_B)
    await openCity(page, await launch(a.guild))
    await expect(page.getByTestId('city-name')).toHaveText('HARBORLIGHT')
    // Same document, new fragment: the page reloads itself and opens the new launch (the same player, so it replaces
    // their own session).
    await page.goto(launchHref(await launch(b.guild)))
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-installation', b.installation)
    await expect(page.getByTestId('city-name')).toHaveText('NEON ORCHARD')
    expect(page.url()).toBe('http://localhost:4352/')
  })

  test('the session route takes exactly a run token, from this origin only', async ({ request }) => {
    const a = await installed(BRAND_A)
    const l = await launch(a.guild)
    const named = await request.post('/v1/play/session', { data: { runToken: l.runToken, installationId: a.installation }, headers: { origin: 'http://localhost:4352' } })
    expect(named.status()).toBe(422)
    expect(await named.json()).toEqual({ error: 'invalid_request' })
    const foreign = await request.post('/v1/play/session', { data: { runToken: l.runToken }, headers: { origin: 'https://evil.example' } })
    expect(foreign.status()).toBe(403)
    expect(await foreign.json()).toEqual({ error: 'origin_mismatch' })
  })
})

test.describe('invalid configuration is refused, never replaced', () => {
  test('Play refuses documents outside Rare City\'s registered schema: no art, camera, mechanics or outside media', async () => {
    const guild = snowflake()
    const installation = await install(guild)
    const cases: [string, unknown][] = [
      ['camera', { ...BRAND_A, camera: { zoom: 4 } }],
      ['economy', { ...BRAND_A, economy: { pointsPerBuild: 1000 } }],
      ['building style', { ...BRAND_A, districts: BRAND_A.districts.map((d) => ({ ...d, buildingStyle: 'pagoda' })) }],
      ['road art', { ...BRAND_A, roads: { texture: 'gold' } }],
      ['too many districts', { ...BRAND_A, districts: Array.from({ length: 10 }, (_, i) => ({ ...BRAND_A.districts[2], key: `d-${i}`, name: `District ${i}` })) }],
      ['external logo', { ...BRAND_A, brand: { ...BRAND_A.brand, logo: 'https://tracker.example/logo.png' } }],
      ['traversing logo', { ...BRAND_A, brand: { ...BRAND_A.brand, logo: '/brand-media/a/../../x.png' } }],
      ['repeated separator in crest', { ...BRAND_A, capital: { ...BRAND_A.capital, crest: '/brand-media/a//b.png' } }],
      ['traversing monument artwork', { ...BRAND_A, districts: BRAND_A.districts.map((d, i) => (i === 0 ? { ...d, monument: { ...d.monument!, artwork: '/brand-media/samples/../secret.svg' } } : d)) }],
      ['encoded traversal', { ...BRAND_A, brand: { ...BRAND_A.brand, logo: '/brand-media/%2e%2e/x.png' } }],
      ['hidden segment', { ...BRAND_A, brand: { ...BRAND_A.brand, logo: '/brand-media/.hidden.png' } }],
      ['not an image', { ...BRAND_A, brand: { ...BRAND_A.brand, logo: '/brand-media/page.html' } }],
      ['rule id not a Core id', { ...BRAND_A, districts: BRAND_A.districts.map((d) => ({ ...d, proofyRule: { verificationRuleId: 0, label: 'x' } })) }],
      ['missing districts', { ...BRAND_A, districts: undefined }],
    ]
    for (const [label, config] of cases) {
      const answer = await createConfigVersion(guild, installation, config)
      expect(answer.status, label).toBe(422)
      expect(answer.body.error?.code, label).toBe('config_invalid')
    }
  })

  test('a document Play accepts but Rare City cannot build is refused at launch, with the problems, and nothing is drawn', async ({ page }) => {
    // Each passes the JSON Schema; Rare City's own validator catches what a schema cannot express.
    const broken = {
      ...BRAND_A,
      districts: [
        ...BRAND_A.districts.slice(0, 3),
        { ...BRAND_A.districts[3], key: 'lantern-quay' },
      ].map((d, i) => (i === 1 ? { ...d, monument: { collection: 'no-such-collection', tokenId: '7', artwork: null } } : d)),
    }
    const a = await installed(broken)
    await openRefused(page, launchHref(await launch(a.guild)), 'config_invalid')
    const problems = page.getByTestId('play-problems')
    await expect(problems).toContainText('district lantern-quay is listed twice')
    await expect(problems).toContainText('is not one of this city\'s collections')
  })
})

test.describe('the standard renderer, unchanged', () => {
  test('a Play city is drawn exactly as stored: the standard civic city, with no buildings until someone builds', async ({ page }) => {
    const a = await installed(BRAND_A)
    await openCity(page, await launch(a.guild))
    await expect(page.getByTestId('play-city')).toHaveAttribute('data-buildings', '0')
    await expect(page.locator('.bldg')).toHaveCount(0)
    await expect(page.getByTestId('city-hall')).toBeAttached()
    await expect(page.locator('[data-testid^="district-"].district-ground')).toHaveCount(4)
    expect((await districtKeys(page)).sort()).toEqual(keysOf(BRAND_A).sort())
    await still(page)
    await page.screenshot({ path: `${SHOTS}/persistent-empty-city-brand-a.png` })
  })

  test('camera, district selection, plot preview and the standard art all work on a Play city', async ({ page }) => {
    const b = await installed(BRAND_B)
    await openCity(page, await launch(b.guild))
    await expect(page.locator('.bldg')).toHaveCount(0)
    await expect(page.getByTestId('city-hall')).toBeAttached()
    // The registry pylons stand; nothing holds a monument in an empty city, so none is raised.
    await expect(page.locator('[data-testid^="pylon-"]')).toHaveCount(5)
    await expect(page.locator('[data-testid^="pylon-"][data-holder=""]')).toHaveCount(5)
    await expect(page.locator('[data-testid^="monument-m"]')).toHaveCount(0)
    await still(page)
    const before = await page.getByTestId('city-svg').getAttribute('viewBox')
    await page.mouse.move(720, 450)
    await page.mouse.wheel(0, -600)
    await still(page)
    expect(await page.getByTestId('city-svg').getAttribute('viewBox')).not.toBe(before)

    await page.getByTestId('nav-overview').click()
    await still(page)
    await page.getByTestId('district-label-pear-commons').click()
    await expect(page.getByTestId('district-panel')).toHaveAttribute('data-district', 'pear-commons')
    // The real player: an ungated district is open; choosing a plot previews engine candidates.
    await expect(page.getByTestId('district-access')).toHaveAttribute('data-access', 'open')
    await page.getByTestId('choose-plot').click()
    await expect(page.getByTestId('plot-panel')).toBeVisible()
    expect(await page.locator('[data-testid^="candidate-plot-pear-commons-"]').count()).toBeGreaterThan(0)
  })

  test('a Proofy rule reference is shown as a Core rule; the real player is never treated as eligible', async ({ page }) => {
    const b = await installed(BRAND_B)
    await openCity(page, await launch(b.guild, 'rare-city', 'Cy'))
    await page.getByTestId('district-label-fig-terrace').click()
    await expect(page.getByTestId('rule-ref')).toHaveAttribute('data-rule-id', '77')
    await expect(page.getByTestId('rule-ref')).toHaveAttribute('data-rule-source', 'proofy-core')
    await expect(page.getByTestId('rule-ref')).not.toContainText('SAMPLE RULE')
    // The launched player: rules are not checked here, so the gated district stays closed.
    await expect(page.getByTestId('district-access')).toHaveAttribute('data-access', 'restricted')
    await expect(page.getByTestId('district-access')).toContainText('has not been checked yet')
    await expect(page.getByTestId('choose-plot')).toBeDisabled()
    await expect(page.locator('.viewer-chip .sim-tag')).toHaveText('PROOFY PLAY PLAYER · RULES NOT CHECKED')
    // Simulated viewers are labelled as such and only simulate the answer.
    await page.getByTestId('viewer-select').selectOption({ index: 2 })
    await expect(page.getByTestId('district-access')).toHaveAttribute('data-access', 'eligible')
    await expect(page.getByTestId('district-access')).toContainText('simulated answer')
    await expect(page.locator('.viewer-chip .sim-tag')).toHaveText('SIMULATED MEMBER')
  })
})
