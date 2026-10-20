import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import pg from 'pg'
import { hashSessionToken } from '../server/src/auth/service'
import { silentLogger } from '../server/src/log'
import { createPlaySessionStore, type LivePlaySession } from '../server/src/play/session'
import { createWorldPropertyStore } from '../server/src/world/properties'
import { BRAND_A, BRAND_B } from './brands'
import { install, launch, launchHref, publish, snowflake } from './play'

/**
 * A PERSISTENT CITY WITH PROPERTIES, end to end, against a REAL local Proofy Play: the standard
 * renderer draws exactly what the world stores, and nothing else.
 *
 * This INTERNAL TEST HARNESS writes properties directly through the server's own property store on
 * the same disposable database, for the session the browser holds (the player flow through the
 * local rehearsal route is `rehearsal.spec.ts`). The page is
 * then only reloaded: everything it shows comes from `GET /v1/play/city` and the launch path.
 */
const ORIGIN = 'http://localhost:4352'
const SHOTS = resolve(import.meta.dirname, '../test-artifacts/city-play-evidence')
mkdirSync(SHOTS, { recursive: true })

const databaseUrl = process.env.CITY_PLAY_DATABASE_URL ?? ''
const db = new pg.Pool({ connectionString: databaseUrl, max: 2 })
test.afterAll(async () => {
  await db.end()
})
const store = createWorldPropertyStore(db, { mode: 'local', log: silentLogger })

async function installed(config: unknown) {
  const guild = snowflake()
  const installation = await install(guild)
  const active = await publish(guild, installation, config)
  return { guild, installation, active }
}

/**
 * What the internal harness passes the property store, as the activation service would: the geometry the page drew, and
 * for a city's first property Play's active configuration, here the version Play itself answered when it activated it
 * (nothing else is activated in between).
 */
async function placedAs(page: Page, active: { version: number; configHash: string }) {
  const geometryFingerprint = (await page.getByTestId('play-city').getAttribute('data-geometry-fingerprint'))!
  return { geometryFingerprint, options: { activeConfig: async () => active } }
}

async function cityOn(page: Page) {
  await expect(page.getByTestId('play-city')).toBeAttached()
  await expect(page.getByTestId('city-svg')).toBeVisible()
  return page.getByTestId('play-city')
}

/** The live session behind the browser's cookie, exactly as the server finds it. */
async function sessionOf(context: BrowserContext): Promise<LivePlaySession> {
  const cookie = (await context.cookies(ORIGIN)).find((c) => c.name === 'rc_play')!
  const hash = hashSessionToken(cookie.value)
  const env = (await db.query<{ play_environment: 'dev' | 'test' }>('SELECT play_environment FROM play_sessions WHERE token_hash = $1', [hash])).rows[0].play_environment
  const live = await createPlaySessionStore(db).find(hash, new Date(), env, 'rare-city')
  if (!live) throw new Error('no live session behind the browser cookie')
  return live
}

const nft = (collections: { key: string; chain: string; contract: string }[], key: string, tokenId: string) => {
  const c = collections.find((x) => x.key === key)!
  return { chain: c.chain, contract: c.contract, tokenId }
}

test('a four-district city with two collections: empty as installed, then exactly its stored properties, through reload and relaunch', async ({ browser }) => {
  const a = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(launchHref(await launch(a.guild)))
  const city = await cityOn(page)
  // A new real city is empty: nothing seeded on first launch.
  await expect(city).toHaveAttribute('data-world-created', 'true')
  await expect(city).toHaveAttribute('data-world-sequence', '1')
  await expect(city).toHaveAttribute('data-buildings', '0')
  const offered = Number(await city.getAttribute('data-candidates'))
  expect(offered).toBeGreaterThan(0)
  await expect(page.getByTestId('play-world-note')).toContainText('Nothing has been claimed or built yet.')
  await expect(page.locator('[data-testid^="building-"]')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/persistent-1-empty.png` })

  // The internal harness activates three properties, from both collections, on exact plots.
  const actor = await sessionOf(context)
  const { geometryFingerprint, options } = await placedAs(page, a.active)
  const placed = [
    await store.activate(actor, { asset: nft(BRAND_A.collections, 'harbor-keepers', '812'), plotId: 'lantern-quay-w0-p3', geometryFingerprint }, options),
    await store.activate(actor, { asset: nft(BRAND_A.collections, 'tide-pass', '77'), plotId: 'tidewater-w0-p0', geometryFingerprint }, options),
    await store.activate(actor, { asset: nft(BRAND_A.collections, 'harbor-keepers', '9'), plotId: 'compass-row-w0-p1', geometryFingerprint }, options),
  ]
  expect(placed.map((p) => p.sequence)).toEqual([2, 3, 4])

  // A reload reads them back from the session: the city as stored, drawn by the standard renderer.
  await page.reload()
  await cityOn(page)
  await expect(city).toHaveAttribute('data-source', 'session')
  await expect(city).toHaveAttribute('data-world-sequence', '4')
  await expect(city).toHaveAttribute('data-buildings', '3')
  await expect(city).toHaveAttribute('data-candidates', String(offered - 3))
  await expect(page.getByTestId('play-world-note')).toContainText('3 properties, nothing built yet.')
  for (const token of ['812', '77', '9']) await expect(page.getByTestId(`building-${token}`)).toHaveCount(1)
  await page.screenshot({ path: `${SHOTS}/persistent-2-three-properties.png` })

  // A relaunch from Play opens the same world, with the same properties.
  const world = await city.getAttribute('data-world')
  await page.goto('about:blank')
  await page.goto(launchHref(await launch(a.guild)))
  await cityOn(page)
  await expect(city).toHaveAttribute('data-source', 'launch')
  await expect(city).toHaveAttribute('data-world', world!)
  await expect(city).toHaveAttribute('data-world-created', 'false')
  await expect(city).toHaveAttribute('data-buildings', '3')
  await context.close()
})

test('a six-district city with three collections keeps its own properties; another installation\'s city stays empty', async ({ browser }) => {
  const b = await installed(BRAND_B)
  const other = await installed(BRAND_A)
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(launchHref(await launch(b.guild)))
  const city = await cityOn(page)
  await expect(city).toHaveAttribute('data-buildings', '0')
  const actor = await sessionOf(context)
  const { geometryFingerprint, options } = await placedAs(page, b.active)
  await store.activate(actor, { asset: nft(BRAND_B.collections, 'orchard-sprites', '1'), plotId: 'plum-arcade-w0-p0', geometryFingerprint }, options)
  await store.activate(actor, { asset: nft(BRAND_B.collections, 'neon-seeds', '1'), plotId: 'kiwi-docks-w0-p2', geometryFingerprint }, options)
  await store.activate(actor, { asset: nft(BRAND_B.collections, 'grove-pass', '1'), plotId: 'cherry-row-w0-p4', geometryFingerprint }, options)
  await page.reload()
  await cityOn(page)
  await expect(city).toHaveAttribute('data-buildings', '3')
  await expect(city).toHaveAttribute('data-world-sequence', '4')
  // Token #1 of three collections: three properties, three buildings.
  await expect(page.getByTestId('building-1')).toHaveCount(3)
  await page.screenshot({ path: `${SHOTS}/persistent-3-six-districts.png` })

  const otherContext = await browser.newContext()
  const otherPage = await otherContext.newPage()
  await otherPage.goto(launchHref(await launch(other.guild)))
  const otherCity = await cityOn(otherPage)
  await expect(otherCity).toHaveAttribute('data-buildings', '0')
  await expect(otherCity).not.toHaveAttribute('data-world', (await city.getAttribute('data-world'))!)
  await context.close()
  await otherContext.close()
})
