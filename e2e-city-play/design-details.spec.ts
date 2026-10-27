import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import pg from 'pg'
import { arrive, claim, designOption, guildFor, installed, openProperty, player, records, still } from './constructionHelpers'
import { launch, launchHref } from './play'
import { CONSTRUCTION_CREDITS, CONSTRUCTION_KEEPER, REHEARSAL_ADA, REHEARSAL_BEA, REHEARSAL_CY } from './rehearsal'

/**
 * ARCHITECT DETAILS (P1-C2-E4B), end to end against a REAL local Proofy Play, in the original city view: windows and
 * exterior lighting join facade and roof in the same Architect design view. Each choice is previewed on the map's own
 * building and beside the saved one; Cancel leaves the stored design as it was; Save writes all four as one revision of
 * catalog architect-design-v2 (v3 since P1-C2-E4C), drawn for everyone, after a reload, at every tier, turned and from afar. A save an E4A page
 * kept (catalog v1) is checked exactly as it was kept: answered with its receipt if it was recorded, refused if not.
 * LOCAL TEST control only; free: no credit, construction, tier, sequence, Crown, Capital or monument.
 */
const SHOTS = resolve(import.meta.dirname, '../test-artifacts/city-play-evidence')
mkdirSync(SHOTS, { recursive: true })
const KEEPER_ID = CONSTRUCTION_KEEPER.slice(CONSTRUCTION_KEEPER.lastIndexOf('/') + 1)
const DESIGNS = '/v1/play/rehearsal/designs'
const KEPT = 'rare-city-design-saves'
const STD = ' · Standard grid · Standard lighting · Standard entry · Standard grounds'
/** Catalog v3's standard street level (P1-C2-E4C): how every E4B design is drawn and named now. */
const STREET = ' · Standard entry · Standard grounds'

const databaseUrl = process.env.CITY_PLAY_DATABASE_URL ?? ''
let db: pg.Pool
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: databaseUrl, max: 2 })
})
test.afterAll(async () => {
  await db.end()
})

const onMap = (page: Page, id = KEEPER_ID) => page.getByTestId('city-svg').getByTestId(`building-${id}`)
/** The window pattern the map's building is drawn with (its first lit facade). */
const windowsOn = (b: Locator) => b.locator('rect[fill^="url(#win-"]').first().getAttribute('fill')
function saves(page: Page) {
  const sent: Record<string, unknown>[] = []
  page.on('request', (r) => r.url().endsWith(DESIGNS) && r.method() === 'POST' && sent.push(r.postDataJSON()))
  return sent
}
const revisionsOf = async (propertyId: string) =>
  (
    await db.query<{ revision: number; catalog: string; facade: string; roof: string; windows: string | null; lighting: string | null }>(
      'SELECT revision, catalog, facade, roof, windows, lighting FROM world_property_designs WHERE property_id = $1 ORDER BY revision',
      [propertyId],
    )
  ).rows
const sequenceOf = async (worldId: string) => (await db.query<{ sequence: string }>('SELECT c.sequence FROM city c JOIN worlds w ON w.city_id = c.id WHERE w.id = $1', [worldId])).rows[0].sequence
async function openDesign(page: Page) {
  await page.getByTestId('design-card').getByTestId('design-open').click()
  const panel = page.getByTestId('design-panel')
  await expect(panel).toHaveAttribute('data-state', 'ready')
  return panel
}

test('3-5, 9-12, 24-26. windows and lighting preview on the city, cancel, and save with facade and roof as one revision that every player sees, at every tier, turned and from afar', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 15))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  const worldId = (await ada.city.getAttribute('data-world'))!
  const sent = saves(ada.page)
  const card = ada.page.getByTestId('design-card')
  await expect(card).toHaveAttribute('data-windows', 'grid')
  await expect(card).toHaveAttribute('data-lighting', 'standard')
  await expect(card.getByTestId('design-saved')).toHaveText(`Slate · Flat deck${STD} · the design every new building starts with`)

  // 6. Tier 0: lighting is kept for Tier 1, so the foundation draws no floodlights yet; the view says so.
  let panel = await openDesign(ada.page)
  await (await designOption(panel, 'design-lighting-cool')).click()
  await expect(panel.getByTestId('design-thumb-preview')).toHaveAttribute('data-lighting', 'cool')
  await expect(onMap(ada.page)).not.toHaveAttribute('data-floodlights', /.*/)
  await expect(panel.getByTestId('design-tier0-note')).toContainText('the roof, windows, lighting, entrance and landscaping are drawn once the building reaches Tier 1')
  await panel.getByTestId('design-cancel').click()

  // Tier 1, by the controller's own construction.
  const construction = ada.page.getByTestId('construction-card')
  for (let i = 0; i < 2; i++) {
    await construction.getByTestId('construction-action').click()
    await expect(construction).toHaveAttribute('data-built', String(50 * (i + 1)))
  }
  await expect(onMap(ada.page)).toHaveAttribute('data-tier', '1')
  expect(await windowsOn(onMap(ada.page))).toBe('url(#win-grid-warm)')
  // One design card, however often the panel redraws (E4A's card shared its sibling's key and was left behind in copies).
  await expect(ada.page.getByTestId('design-card')).toHaveCount(1)
  const credits = await ada.page.getByTestId('construction-credits').textContent()
  const built = (await records(db).constructionsOf(placed.propertyId)).length

  // 3-4. Preview each window and lighting treatment on the map's building; nothing is sent or stored.
  panel = await openDesign(ada.page)
  for (const windows of ['arched', 'ribbon', 'lattice', 'grid']) {
    await (await designOption(panel, `design-windows-${windows}`)).click()
    await expect.poll(() => windowsOn(onMap(ada.page))).toBe(`url(#win-${windows}-warm)`)
    await expect(panel.getByTestId('design-thumb-preview')).toHaveAttribute('data-windows', windows)
  }
  for (const [lighting, glow] of [
    ['warm', 'warm'],
    ['cool', 'cool'],
  ] as const) {
    await (await designOption(panel, `design-lighting-${lighting}`)).click()
    await expect(onMap(ada.page)).toHaveAttribute('data-floodlights', lighting)
    await expect(onMap(ada.page)).toHaveAttribute('data-lighting', glow)
    await expect(onMap(ada.page).locator('[data-floodlight-face]')).not.toHaveCount(0)
  }
  await (await designOption(panel, 'design-windows-ribbon')).click()
  await expect(panel.getByTestId('design-changes')).toHaveText('Preview changes windows (Standard grid → Ribbon glass), lighting (Standard lighting → Cool floodlights). Not saved yet.')
  await expect(panel.getByTestId('design-thumb-saved')).toHaveAttribute('data-lighting', 'standard')
  await still(ada.page)
  await ada.page.screenshot({ path: `${SHOTS}/details-1-preview-tier1-ribbon-cool.png` })
  await (await designOption(panel, 'design-lighting-standard')).click()
  await expect(onMap(ada.page)).not.toHaveAttribute('data-floodlights', /.*/)
  expect(sent).toHaveLength(0)
  expect(await revisionsOf(placed.propertyId)).toEqual([])

  // 10. Cancel: the map draws the stored design again.
  await (await designOption(panel, 'design-lighting-cool')).click()
  await panel.getByTestId('design-cancel').click()
  await expect(ada.page.getByTestId('building-panel')).toHaveAttribute('data-building', placed.buildingId)
  await expect(onMap(ada.page)).not.toHaveAttribute('data-floodlights', /.*/)
  expect(await windowsOn(onMap(ada.page))).toBe('url(#win-grid-warm)')
  expect(sent).toHaveLength(0)

  // 5, 11. All four categories, one save, one revision.
  const before = await sequenceOf(worldId)
  panel = await openDesign(ada.page)
  await (await designOption(panel, 'design-facade-brick')).click()
  await (await designOption(panel, 'design-roof-dome')).click()
  await (await designOption(panel, 'design-windows-lattice')).click()
  await (await designOption(panel, 'design-lighting-warm')).click()
  await expect(panel.getByTestId('design-changes')).toHaveText(
    'Preview changes facade (Slate → Brick), roof (Flat deck → Dome), windows (Standard grid → Industrial lattice), lighting (Standard lighting → Warm floodlights). Not saved yet.',
  )
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveText(`Saved: Brick · Dome · Industrial lattice · Warm floodlights${STREET}, revision 1. The city shows it now, for everyone.`)
  await expect(panel.getByTestId('design-changes')).toHaveText('Preview matches the saved design.')
  expect(sent).toHaveLength(1)
  expect(Object.keys(sent[0]).sort()).toEqual(['actionId', 'baseRevision', 'catalog', 'color', 'discordUserId', 'entrance', 'facade', 'landscaping', 'lighting', 'propertyId', 'roof', 'sessionRef', 'windows', 'worldId'])
  expect(sent[0]).toMatchObject({ catalog: 'architect-design-v4', facade: 'brick', roof: 'dome', windows: 'lattice', lighting: 'warm', entrance: 'standard', landscaping: 'standard', baseRevision: 0 })
  expect(await revisionsOf(placed.propertyId)).toEqual([{ revision: 1, catalog: 'architect-design-v4', facade: 'brick', roof: 'dome', windows: 'lattice', lighting: 'warm' }])
  // 24-26. Free, and no city change: credits, constructions and the city's sequence as they were.
  expect(await records(db).constructionsOf(placed.propertyId)).toHaveLength(built)
  expect(await sequenceOf(worldId)).toBe(before)
  await panel.getByRole('button', { name: 'Back' }).click()
  await expect(card).toHaveAttribute('data-windows', 'lattice')
  await expect(card).toHaveAttribute('data-lighting', 'warm')
  await expect(ada.page.getByTestId('construction-card')).toHaveAttribute('data-tier', '1')
  await expect(ada.page.getByTestId('construction-credits')).toHaveText(credits!)

  // 12. A reload keeps it; reopening shows every saved choice checked.
  await ada.page.reload()
  await expect(onMap(ada.page)).toHaveAttribute('data-floodlights', 'warm')
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'brick')
  await expect(onMap(ada.page)).toHaveAttribute('data-roof', 'dome')
  expect(await windowsOn(onMap(ada.page))).toBe('url(#win-lattice-warm)')
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  panel = await openDesign(ada.page)
  await expect((await designOption(panel, 'design-windows-lattice')).getByRole('radio')).toBeChecked()
  await expect((await designOption(panel, 'design-lighting-warm')).getByRole('radio')).toBeChecked()
  await expect(panel.getByTestId('design-history-entry')).toHaveAttribute('data-windows', 'lattice')
  await panel.getByRole('button', { name: 'Close panel' }).click()

  // Everyone sees it; patrons take it to Tier 2 and it stays.
  const cy = await player(browser, guild, 'Cy', REHEARSAL_CY)
  await expect(onMap(cy.page)).toHaveAttribute('data-floodlights', 'warm')
  const cyCard = await openProperty(cy.page, placed.plotId, placed.buildingId)
  await expect(cy.page.getByTestId('design-card')).toHaveAttribute('data-lighting', 'warm')
  await expect(cy.page.getByTestId('design-card').getByTestId('design-open')).toHaveCount(0)
  for (let i = 0; i < 2; i++) {
    await cyCard.getByTestId('construction-action').click()
    await expect(cyCard).toHaveAttribute('data-built', String(150 + 50 * i))
  }
  const bea = await player(browser, guild, 'Bea', REHEARSAL_BEA)
  const beaCard = await openProperty(bea.page, placed.plotId, placed.buildingId)
  await beaCard.getByTestId('construction-action').click()
  await expect(beaCard).toHaveAttribute('data-tier', '2')
  await ada.page.reload()
  await expect(onMap(ada.page)).toHaveAttribute('data-tier', '2')
  await expect(onMap(ada.page)).toHaveAttribute('data-floodlights', 'warm')
  expect(await windowsOn(onMap(ada.page))).toBe('url(#win-lattice-warm)')
  expect(await revisionsOf(placed.propertyId)).toHaveLength(1)

  // WARP to it, turned: still drawn floodlit, and a click on the building still selects it.
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  await still(ada.page)
  await ada.page.screenshot({ path: `${SHOTS}/details-2a-tier2-warp.png` })
  await ada.page.getByTestId('building-panel').getByRole('button', { name: 'Close panel' }).click()
  await ada.page.getByTestId('rotate-right').click()
  await still(ada.page)
  await expect(onMap(ada.page)).toHaveAttribute('data-floodlights', 'warm')
  await ada.page.screenshot({ path: `${SHOTS}/details-2-tier2-lattice-warm-turned.png` })
  const box = (await onMap(ada.page).locator('[data-floodlight-face]').first().boundingBox())!
  await ada.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(ada.page.getByTestId('building-panel')).toHaveAttribute('data-building', placed.buildingId)
  await ada.page.getByTestId('rotate-reset').click()

  // From afar (far detail) the beams are dropped and the lit cornice stays: less drawn, never more.
  const near = await onMap(ada.page).locator('[data-floodlight-face]').count()
  for (let i = 0; i < 12 && (await ada.page.getByTestId('city').getAttribute('data-detail')) !== 'far'; i++) await ada.page.getByRole('button', { name: 'Zoom out' }).click()
  await expect(ada.page.getByTestId('city')).toHaveAttribute('data-detail', 'far')
  await still(ada.page)
  await expect(onMap(ada.page).locator('[data-floodlight-face^="wash"]')).toHaveCount(0)
  await expect(onMap(ada.page).locator('[data-floodlight-face="cornice"]')).toHaveCount(2)
  expect(near).toBeGreaterThanOrEqual(2)
  await ada.page.screenshot({ path: `${SHOTS}/details-3-overview.png` })
  // No Crown, Capital or monument for a design.
  await expect(ada.page.getByTestId('crown-spire')).toHaveCount(0)
  expect(CONSTRUCTION_CREDITS.ada).toBeGreaterThan(0)
  for (const p of [ada, cy, bea]) await p.context.close()
})

test('21-22, 27. a save an E4A page kept is checked exactly as kept: its receipt if it was recorded, refused if not; then v2 builds on the v1 design, on a phone and by keyboard', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 16))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  const worldId = (await ada.city.getAttribute('data-world'))!
  const sent = saves(ada.page)

  // A v1 design exactly as the E4A build recorded it (catalog v1, no treatment), written past 0016's guard, which takes
  // no new v1 row (the database upgrade itself is server/tests/propertyDesignDetails.db.test.ts).
  const recorded = randomUUID()
  const session = (await db.query<{ id: string }>('SELECT id FROM play_sessions WHERE world_id = $1 AND discord_user_id = $2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [worldId, REHEARSAL_ADA])).rows[0].id
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL session_replication_role = 'replica'`)
    await c.query(
      `INSERT INTO world_property_designs (world_id, city_id, city_instance_id, property_id, revision, action_id, catalog, facade, roof, designer_core_user_id, designer_discord_user_id, designed_in_play_session, authority, at_city_sequence)
       SELECT w.id, w.city_id, w.city_instance_id, $2, 1, $3, 'architect-design-v1', 'brick', 'dome', s.core_user_id, s.discord_user_id, s.id, 'local-fixture-controller', c.sequence
         FROM worlds w JOIN city c ON c.id = w.city_id JOIN play_sessions s ON s.id = $4 WHERE w.id = $1`,
      [worldId, placed.propertyId, recorded, session],
    )
    await c.query('COMMIT')
  } finally {
    c.release()
  }
  // The answer to it was lost: the E4A page kept exactly this, in exactly its shape.
  const legacy = { actionId: recorded, worldId, discordUserId: REHEARSAL_ADA, propertyId: placed.propertyId, baseRevision: 0, catalog: 'architect-design-v1', facade: 'brick', roof: 'dome' }
  await ada.page.evaluate(([key, kept]) => localStorage.setItem(key, JSON.stringify([kept])), [KEPT, legacy] as const)
  await ada.page.reload()
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  const card = ada.page.getByTestId('design-card')
  await expect(card).toHaveAttribute('data-catalog', 'architect-design-v1')
  await expect(card.getByTestId('design-saved')).toHaveText(`Brick · Dome${STD} · saved design, revision 1 (chosen before windows and lighting could be chosen: standard windows, lighting, entrance and grounds)`)
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'brick')
  await expect(onMap(ada.page)).not.toHaveAttribute('data-floodlights', /.*/)

  // Checked exactly as kept: the same nine keys, no treatment added; answered with its receipt; nothing written.
  let panel = await openDesign(ada.page)
  await expect(panel.getByTestId('design-save')).toHaveText('Check this save · same request')
  await (await designOption(panel, 'design-lighting-cool')).click()
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'repeat')
  await expect(panel.getByTestId('design-feedback')).toHaveText(`Already saved by this save: Brick · Dome${STD}, revision 1. Nothing more was saved.`)
  expect(sent).toHaveLength(1)
  expect(Object.keys(sent[0]).sort()).toEqual(['actionId', 'baseRevision', 'catalog', 'discordUserId', 'facade', 'propertyId', 'roof', 'sessionRef', 'worldId'])
  expect(sent[0]).toMatchObject(legacy)
  expect(await ada.page.evaluate((key) => localStorage.getItem(key), KEPT)).toBe('[]')
  expect(await revisionsOf(placed.propertyId)).toEqual([{ revision: 1, catalog: 'architect-design-v1', facade: 'brick', roof: 'dome', windows: null, lighting: null }])
  await panel.getByRole('button', { name: 'Close panel' }).click()

  // A kept v1 save that never reached the server: refused (settled), never applied as a design of a later catalog.
  const lost = { ...legacy, actionId: randomUUID(), baseRevision: 1, facade: 'jade', roof: 'spire' }
  await ada.page.evaluate(([key, kept]) => localStorage.setItem(key, JSON.stringify([kept])), [KEPT, lost] as const)
  await ada.page.reload()
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  panel = await openDesign(ada.page)
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'renew')
  await expect(panel.getByTestId('design-feedback')).toHaveText(
    'That unsaved design was chosen in an earlier version of the Architect design view, which no longer saves, so nothing was saved. This property’s saved design is shown now: choose again on it.',
  )
  expect(sent[1]).toMatchObject(lost)
  expect(Object.keys(sent[1])).not.toContain('windows')
  expect(await ada.page.evaluate((key) => localStorage.getItem(key), KEPT)).toBe('[]')
  expect(await revisionsOf(placed.propertyId)).toHaveLength(1)
  await expect((await designOption(panel, 'design-facade-brick')).getByRole('radio')).toBeChecked()
  await expect((await designOption(panel, 'design-windows-grid')).getByRole('radio')).toBeChecked()

  // 27. On a phone, by keyboard: windows and lighting are radio groups too; the current catalog keeps the v1 facade and roof it builds on.
  await ada.page.setViewportSize({ width: 390, height: 844 })
  await panel.getByRole('tab', { name: /^Details/ }).click()
  await expect(panel.getByRole('group', { name: 'Windows' })).toBeVisible()
  await panel.getByRole('radio', { name: /^Standard grid/ }).focus()
  await ada.page.keyboard.press('ArrowDown')
  await expect(panel.getByRole('radio', { name: /^Classic arched/ })).toBeChecked()
  await panel.getByRole('radio', { name: /^Standard lighting/ }).focus()
  await ada.page.keyboard.press('ArrowDown')
  await ada.page.keyboard.press('ArrowDown')
  await expect(panel.getByRole('radio', { name: /^Cool floodlights/ })).toBeChecked()
  await panel.getByRole('button', { name: 'Save design' }).focus()
  await ada.page.keyboard.press('Enter')
  await expect(panel.getByRole('status').filter({ hasText: 'Saved:' })).toHaveText(`Saved: Brick · Dome · Classic arched · Cool floodlights${STREET}, revision 2. The city shows it now, for everyone.`)
  await expect(panel.getByTestId('design-history-entry')).toHaveCount(2)
  await expect(panel.getByTestId('design-history-entry').nth(0)).toHaveAttribute('data-catalog', 'architect-design-v4')
  await expect(panel.getByTestId('design-history-entry').nth(1)).toHaveAttribute('data-catalog', 'architect-design-v1')
  await expect(panel.getByTestId('design-history-entry').nth(1)).toContainText('chosen before windows and lighting could be chosen')
  const overflow = await ada.page.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth, drawer: (document.querySelector('[data-testid="drawer"]') as HTMLElement).getBoundingClientRect().right - window.innerWidth }))
  expect(overflow.page).toBeLessThanOrEqual(0)
  expect(overflow.drawer).toBeLessThanOrEqual(0)
  await panel.evaluate((el) => el.scrollTo(0, el.scrollHeight / 3))
  await ada.page.screenshot({ path: `${SHOTS}/details-4-mobile-options.png` })
  expect(await revisionsOf(placed.propertyId)).toEqual([
    { revision: 1, catalog: 'architect-design-v1', facade: 'brick', roof: 'dome', windows: null, lighting: null },
    { revision: 2, catalog: 'architect-design-v4', facade: 'brick', roof: 'dome', windows: 'arched', lighting: 'cool' },
  ])
  // A relaunch reads it all back.
  await arrive(ada.page, launchHref(await launch(guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'brick')
  await ada.page.context().close()
})
