import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import pg from 'pg'
import { arrive, claim, designOption, guildFor, installed, openProperty, player, records, still } from './constructionHelpers'
import { launch, launchHref } from './play'
import { CONSTRUCTION_CREDITS, CONSTRUCTION_KEEPER, REHEARSAL_ADA, REHEARSAL_BEA, REHEARSAL_CY } from './rehearsal'

/**
 * ARCHITECT ENTRANCES AND LANDSCAPING (P1-C2-E4C), end to end against a REAL local Proofy Play, in the original city view:
 * an entrance and a landscaping treatment join the facade, roof, windows and lighting in the same Architect design view,
 * grouped in three tabs. Each choice is previewed on the map's own building and beside the saved one; Cancel leaves the
 * stored design as it was; Save writes all six as one revision of catalog architect-design-v3, drawn for everyone, after
 * a reload, at every tier, turned and from afar, inside the property's own lot. A save an E4B page kept (catalog v2) is
 * checked exactly as it was kept. LOCAL TEST control only; free: no credit, construction, tier, sequence, Crown, Capital
 * or monument.
 */
const SHOTS = resolve(import.meta.dirname, '../test-artifacts/city-play-evidence')
mkdirSync(SHOTS, { recursive: true })
const KEEPER_ID = CONSTRUCTION_KEEPER.slice(CONSTRUCTION_KEEPER.lastIndexOf('/') + 1)
const DESIGNS = '/v1/play/rehearsal/designs'
const KEPT = 'rare-city-design-saves'
const KEYS_V3 = ['actionId', 'baseRevision', 'catalog', 'discordUserId', 'entrance', 'facade', 'landscaping', 'lighting', 'propertyId', 'roof', 'sessionRef', 'windows', 'worldId']

const databaseUrl = process.env.CITY_PLAY_DATABASE_URL ?? ''
let db: pg.Pool
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: databaseUrl, max: 2 })
})
test.afterAll(async () => {
  await db.end()
})

const onMap = (page: Page, id = KEEPER_ID) => page.getByTestId('city-svg').getByTestId(`building-${id}`)
/** The landscape pieces the map's building draws, in order. */
const piecesOn = (b: Locator) => b.locator('[data-grounds-piece]').evaluateAll((els) => els.map((e) => e.getAttribute('data-grounds-piece')))
function saves(page: Page) {
  const sent: Record<string, unknown>[] = []
  page.on('request', (r) => r.url().endsWith(DESIGNS) && r.method() === 'POST' && sent.push(r.postDataJSON()))
  return sent
}
const revisionsOf = async (propertyId: string) =>
  (
    await db.query<{ revision: number; catalog: string; facade: string; roof: string; windows: string | null; lighting: string | null; entrance: string | null; landscaping: string | null; designer: string }>(
      'SELECT revision, catalog, facade, roof, windows, lighting, entrance, landscaping, designer_discord_user_id AS designer FROM world_property_designs WHERE property_id = $1 ORDER BY revision',
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
/** The building's hit area once its growth has finished animating (a tier is drawn growing into place). */
async function settledHit(b: Locator) {
  const read = () => b.locator('rect[fill="transparent"]').first().evaluate((r) => r.outerHTML)
  let last = ''
  for (let i = 0; i < 40; i++) {
    const now = await read()
    if (now === last) return now
    last = now
    await b.page().waitForTimeout(150)
  }
  throw new Error('the building never stopped growing')
}
/** Zoom the camera until the city draws at `detail`. */
async function zoomTo(page: Page, detail: 'far' | 'near') {
  const button = detail === 'far' ? 'Zoom out' : 'Zoom in'
  // Each step animates (and a WARP may still be flying): let the camera settle before reading or zooming again.
  await still(page)
  for (let i = 0; i < 14 && (await page.getByTestId('city').getAttribute('data-detail')) !== detail; i++) {
    await page.getByRole('button', { name: button }).click()
    await still(page)
  }
  await expect(page.getByTestId('city')).toHaveAttribute('data-detail', detail)
  await still(page)
}

test('5-17, 29-34. entrances and landscaping preview on the city, cancel, and save with the other four as one revision that every player sees, at every tier, turned and from afar, on the property\'s own lot', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 17))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  const worldId = (await ada.city.getAttribute('data-world'))!
  const sent = saves(ada.page)
  const card = ada.page.getByTestId('design-card')
  await expect(card).toHaveAttribute('data-entrance', 'standard')
  await expect(card).toHaveAttribute('data-landscaping', 'standard')
  await expect(card.getByTestId('design-saved')).toHaveText('Slate · Flat deck · Standard grid · Standard lighting · Standard entry · Standard grounds · the design every new building starts with')

  // 9. Tier 0: a foundation has no door or finished grounds yet; the choice is drawn from Tier 1, and the view says so.
  let panel = await openDesign(ada.page)
  await (await designOption(panel, 'design-entrance-portico')).click()
  await (await designOption(panel, 'design-landscaping-garden')).click()
  await expect(panel.getByTestId('design-thumb-preview')).toHaveAttribute('data-entrance', 'portico')
  await expect(onMap(ada.page)).not.toHaveAttribute('data-entrance', /.*/)
  await expect(onMap(ada.page).locator('[data-grounds-piece]')).toHaveCount(0)
  await expect(panel.getByTestId('design-tier0-note')).toContainText('the roof, windows, lighting, entrance and landscaping are drawn once the building reaches Tier 1')
  await panel.getByTestId('design-cancel').click()

  // Tier 1, by the controller's own construction.
  const construction = ada.page.getByTestId('construction-card')
  for (let i = 0; i < 2; i++) {
    await construction.getByTestId('construction-action').click()
    await expect(construction).toHaveAttribute('data-built', String(50 * (i + 1)))
  }
  await expect(onMap(ada.page)).toHaveAttribute('data-tier', '1')
  const credits = await ada.page.getByTestId('construction-credits').textContent()
  const built = (await records(db).constructionsOf(placed.propertyId)).length
  const hitBefore = await settledHit(onMap(ada.page))

  // 5. Each entrance previewed on the map's own building; nothing is sent or stored.
  panel = await openDesign(ada.page)
  const street = panel.getByTestId('design-tab-street')
  await street.click()
  await expect(panel.getByTestId('design-group-street')).toBeVisible()
  await expect(panel.getByTestId('design-group-building')).toBeHidden()
  for (const [entrance, drawn] of [
    ['canopy', 'awning'],
    ['arched', 'arch'],
    ['portico', 'grand-portico'],
  ] as const) {
    await (await designOption(panel, `design-entrance-${entrance}`)).click()
    await expect(onMap(ada.page)).toHaveAttribute('data-entrance', drawn)
    await expect(panel.getByTestId('design-thumb-preview')).toHaveAttribute('data-entrance', entrance)
    await expect(street).toHaveAttribute('data-changes', '1')
  }
  await still(ada.page)
  await onMap(ada.page).screenshot({ path: `${SHOTS}/street-1-portico-tier1.png` })
  // 6. Each landscaping treatment on the paved lot: its pieces, never a pointer target; the hit area is the same.
  for (const [landscaping, pieces] of [
    ['garden', ['tree', 'shrub', 'tree', 'planter', 'shrub', 'planter']],
    ['courtyard', ['lamp', 'shrub', 'lamp', 'planter', 'planter', 'bench']],
  ] as const) {
    await (await designOption(panel, `design-landscaping-${landscaping}`)).click()
    await expect(onMap(ada.page)).toHaveAttribute('data-grounds', landscaping)
    await expect.poll(() => piecesOn(onMap(ada.page))).toEqual(pieces)
    await expect(onMap(ada.page).locator('[data-grounds-pieces]')).toHaveAttribute('pointer-events', 'none')
    await expect(street).toHaveAttribute('data-changes', '2')
    await onMap(ada.page).screenshot({ path: `${SHOTS}/street-2-${landscaping}-tier1.png` })
  }
  expect(await settledHit(onMap(ada.page))).toBe(hitBefore)
  await expect(panel.getByTestId('design-changes')).toHaveText('Preview changes entrance (Standard entry → Grand portico), landscaping (Standard grounds → Stone courtyard). Not saved yet.')
  await expect(panel.getByTestId('design-thumb-saved')).toHaveAttribute('data-landscaping', 'standard')
  // 7-8 in the real page: every piece stands inside the building's own lot polygon on screen.
  const outside = await onMap(ada.page).evaluate((b) => {
    const lot = b.querySelector('polygon')!.getBoundingClientRect()
    return [...b.querySelectorAll('[data-grounds-piece]')].filter((p) => {
      const r = p.getBoundingClientRect()
      const foot = { x: r.x + r.width / 2, y: r.bottom }
      return foot.x < lot.left || foot.x > lot.right || foot.y < lot.top || foot.y > lot.bottom
    }).length
  })
  expect(outside).toBe(0)
  await (await designOption(panel, 'design-entrance-standard')).click()
  await (await designOption(panel, 'design-landscaping-standard')).click()
  await expect(onMap(ada.page)).not.toHaveAttribute('data-entrance', /.*/)
  await expect(onMap(ada.page).locator('[data-grounds-piece]')).toHaveCount(0)
  await expect(street).toHaveAttribute('data-changes', '0')
  expect(sent).toHaveLength(0)

  // 13-14. Cancel: the map draws the stored design again, and nothing was written.
  await (await designOption(panel, 'design-landscaping-garden')).click()
  await panel.getByTestId('design-cancel').click()
  await expect(ada.page.getByTestId('building-panel')).toHaveAttribute('data-building', placed.buildingId)
  await expect(onMap(ada.page)).not.toHaveAttribute('data-grounds', /.*/)
  expect(sent).toHaveLength(0)
  expect(await revisionsOf(placed.propertyId)).toEqual([])

  // 12, 15. All six categories, across all three tabs, one save, one revision.
  const before = await sequenceOf(worldId)
  panel = await openDesign(ada.page)
  await (await designOption(panel, 'design-facade-jade')).click()
  await (await designOption(panel, 'design-roof-dome')).click()
  await (await designOption(panel, 'design-windows-ribbon')).click()
  await (await designOption(panel, 'design-lighting-warm')).click()
  await (await designOption(panel, 'design-entrance-portico')).click()
  await (await designOption(panel, 'design-landscaping-garden')).click()
  for (const [tab, n] of [
    ['building', '2'],
    ['details', '2'],
    ['street', '2'],
  ] as const)
    await expect(panel.getByTestId(`design-tab-${tab}`)).toHaveAttribute('data-changes', n)
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'jade')
  await expect(onMap(ada.page)).toHaveAttribute('data-floodlights', 'warm')
  await expect(onMap(ada.page)).toHaveAttribute('data-entrance', 'grand-portico')
  await expect(onMap(ada.page)).toHaveAttribute('data-grounds', 'garden')
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveText('Saved: Jade · Dome · Ribbon glass · Warm floodlights · Grand portico · Garden grounds, revision 1. The city shows it now, for everyone.')
  await expect(panel.getByTestId('design-changes')).toHaveText('Preview matches the saved design.')
  expect(sent).toHaveLength(1)
  expect(Object.keys(sent[0]).sort()).toEqual(KEYS_V3)
  expect(sent[0]).toMatchObject({ catalog: 'architect-design-v3', facade: 'jade', roof: 'dome', windows: 'ribbon', lighting: 'warm', entrance: 'portico', landscaping: 'garden', baseRevision: 0 })
  expect(await revisionsOf(placed.propertyId)).toEqual([{ revision: 1, catalog: 'architect-design-v3', facade: 'jade', roof: 'dome', windows: 'ribbon', lighting: 'warm', entrance: 'portico', landscaping: 'garden', designer: REHEARSAL_ADA }])
  // 29-31. Free, and no city change: credits, constructions, the city's sequence and the plot as they were.
  expect(await records(db).constructionsOf(placed.propertyId)).toHaveLength(built)
  expect(await sequenceOf(worldId)).toBe(before)
  expect((await db.query('SELECT plot_id, activator_discord_user_id FROM world_properties WHERE id = $1', [placed.propertyId])).rows).toEqual([{ plot_id: placed.plotId, activator_discord_user_id: REHEARSAL_ADA }])
  await panel.getByRole('button', { name: 'Back' }).click()
  await expect(card).toHaveAttribute('data-entrance', 'portico')
  await expect(card).toHaveAttribute('data-landscaping', 'garden')
  await expect(ada.page.getByTestId('construction-card')).toHaveAttribute('data-tier', '1')
  await expect(ada.page.getByTestId('construction-credits')).toHaveText(credits!)

  // 16. A reload keeps it; reopening shows every saved choice checked, in its own tab.
  await ada.page.reload()
  await expect(onMap(ada.page)).toHaveAttribute('data-entrance', 'grand-portico')
  await expect(onMap(ada.page)).toHaveAttribute('data-grounds', 'garden')
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  panel = await openDesign(ada.page)
  for (const id of ['design-facade-jade', 'design-roof-dome', 'design-windows-ribbon', 'design-lighting-warm', 'design-entrance-portico', 'design-landscaping-garden'])
    await expect((await designOption(panel, id)).getByRole('radio'), id).toBeChecked()
  await expect(panel.getByTestId('design-history-entry')).toHaveAttribute('data-landscaping', 'garden')
  await panel.getByRole('button', { name: 'Close panel' }).click()

  // Everyone sees it; patrons take it to Tier 2 and it stays (32).
  const cy = await player(browser, guild, 'Cy', REHEARSAL_CY)
  await expect(onMap(cy.page)).toHaveAttribute('data-grounds', 'garden')
  const cyCard = await openProperty(cy.page, placed.plotId, placed.buildingId)
  await expect(cy.page.getByTestId('design-card')).toHaveAttribute('data-entrance', 'portico')
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
  await expect(onMap(ada.page)).toHaveAttribute('data-entrance', 'grand-portico')
  expect(await revisionsOf(placed.propertyId)).toHaveLength(1)

  // 34. WARP to it, up close, and turned: still drawn on its lot, and a click on a landscape piece selects the building.
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  await zoomTo(ada.page, 'near')
  await expect.poll(() => piecesOn(onMap(ada.page))).toEqual(['tree', 'shrub', 'tree', 'planter', 'shrub', 'planter'])
  await onMap(ada.page).screenshot({ path: `${SHOTS}/street-3-tier2-near.png` })
  await ada.page.getByTestId('building-panel').getByRole('button', { name: 'Close panel' }).click()
  await ada.page.getByTestId('rotate-right').click()
  await still(ada.page)
  await expect(onMap(ada.page)).toHaveAttribute('data-grounds', 'garden')
  await onMap(ada.page).screenshot({ path: `${SHOTS}/street-4-tier2-turned.png` })
  const tree = (await onMap(ada.page).locator('[data-grounds-piece="tree"]').first().boundingBox())!
  await ada.page.mouse.click(tree.x + tree.width / 2, tree.y + tree.height * 0.8)
  await expect(ada.page.getByTestId('building-panel')).toHaveAttribute('data-building', placed.buildingId)
  await ada.page.getByTestId('building-panel').getByRole('button', { name: 'Close panel' }).click()
  await ada.page.getByTestId('rotate-reset').click()

  // From afar the pieces are dropped (the overview stays as light as before); the entrance stays on the podium.
  await zoomTo(ada.page, 'far')
  await expect(onMap(ada.page).locator('[data-grounds-piece]')).toHaveCount(0)
  await expect(onMap(ada.page)).toHaveAttribute('data-entrance', 'grand-portico')
  await ada.page.screenshot({ path: `${SHOTS}/street-5-overview.png` })
  // No Crown, Capital or monument for a design.
  await expect(ada.page.getByTestId('crown-spire')).toHaveCount(0)
  expect(CONSTRUCTION_CREDITS.ada).toBeGreaterThan(0)
  for (const p of [ada, cy, bea]) await p.context.close()
})

test('18-22. the founder who is not the controller, and a patron, cannot change the entrance or landscaping; the controller, who did not found it, can', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 18))
  // Bea founds #812; the local file names Ada its controller.
  const bea = await player(browser, guild, 'Bea', REHEARSAL_BEA)
  const placed = await claim(bea.page, CONSTRUCTION_KEEPER)
  await expect(bea.page.getByTestId('design-card')).toHaveAttribute('data-control', 'other')
  await expect(bea.page.getByTestId('design-card').getByTestId('design-open')).toHaveCount(0)
  const ask = (page: Page, actor: Record<string, unknown>, design: Record<string, string>) =>
    page.evaluate(
      async ([path, body]) => {
        const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        return [res.status, await res.json()]
      },
      [DESIGNS, { ...actor, propertyId: placed.propertyId, actionId: crypto.randomUUID(), baseRevision: 0, catalog: 'architect-design-v3', facade: 'slate', roof: 'flat', windows: 'grid', lighting: 'standard', ...design }] as const,
    )
  const beaActor = { sessionRef: await bea.city.getAttribute('data-session-ref'), worldId: await bea.city.getAttribute('data-world'), discordUserId: REHEARSAL_BEA }
  // 20. The founder alone, asked outright: refused, nothing written.
  expect(await ask(bea.page, beaActor, { entrance: 'portico', landscaping: 'standard' })).toEqual([403, { error: 'not_current_controller' }])
  // 21. A patron builds, and still may not.
  await bea.page.getByTestId('construction-action').click()
  await expect(bea.page.getByTestId('construction-card')).toHaveAttribute('data-built', '50')
  const cy = await player(browser, guild, 'Cy', REHEARSAL_CY)
  const cyCard = await openProperty(cy.page, placed.plotId, placed.buildingId)
  await cyCard.getByTestId('construction-action').click()
  await expect(cyCard).toHaveAttribute('data-built', '100')
  await expect(cy.page.getByTestId('design-card').getByTestId('design-open')).toHaveCount(0)
  const cyActor = { sessionRef: await cy.city.getAttribute('data-session-ref'), worldId: await cy.city.getAttribute('data-world'), discordUserId: REHEARSAL_CY }
  expect(await ask(cy.page, cyActor, { entrance: 'standard', landscaping: 'garden' })).toEqual([403, { error: 'not_current_controller' }])
  // 22. Not a catalog identifier: refused before anything is judged.
  expect(await ask(cy.page, cyActor, { entrance: 'standard', landscaping: 'url(x)' })).toEqual([400, { error: 'invalid_request' }])
  // 23. Another player's session named from this page: refused.
  expect(await ask(cy.page, beaActor, { entrance: 'canopy', landscaping: 'garden' })).toEqual([409, { error: 'play_actor_mismatch' }])
  expect(await revisionsOf(placed.propertyId)).toEqual([])

  // The controller, who did not found it, saves an entrance and landscaping only.
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  const panel = await openDesign(ada.page)
  await (await designOption(panel, 'design-entrance-canopy')).click()
  await (await designOption(panel, 'design-landscaping-courtyard')).click()
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'saved')
  expect(await revisionsOf(placed.propertyId)).toEqual([{ revision: 1, catalog: 'architect-design-v3', facade: 'slate', roof: 'flat', windows: 'grid', lighting: 'standard', entrance: 'canopy', landscaping: 'courtyard', designer: REHEARSAL_ADA }])
  // The founder and the patron see it; the founding record is still Bea's.
  await bea.page.reload()
  await expect(onMap(bea.page)).toHaveAttribute('data-entrance', 'awning')
  await expect(onMap(bea.page)).toHaveAttribute('data-grounds', 'courtyard')
  expect((await db.query('SELECT activator_discord_user_id FROM world_properties WHERE id = $1', [placed.propertyId])).rows).toEqual([{ activator_discord_user_id: REHEARSAL_BEA }])
  for (const p of [ada, bea, cy]) await p.context.close()
})

test('25-28. a save an E4B page kept is checked exactly as kept: its receipt if recorded, refused if not; a lost v3 answer is checked as the same save; then v3 builds on the v2 design, on a phone and by keyboard', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 19))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  const worldId = (await ada.city.getAttribute('data-world'))!
  const sent = saves(ada.page)
  const construction = ada.page.getByTestId('construction-card')
  for (let i = 0; i < 2; i++) {
    await construction.getByTestId('construction-action').click()
    await expect(construction).toHaveAttribute('data-built', String(50 * (i + 1)))
  }

  // A v2 design exactly as the E4B build recorded it (no entrance or landscaping), written past 0017's guard, which takes no
  // new v2 row (the database upgrade itself is server/tests/propertyDesignStreet.db.test.ts).
  const recorded = randomUUID()
  const session = (await db.query<{ id: string }>('SELECT id FROM play_sessions WHERE world_id = $1 AND discord_user_id = $2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [worldId, REHEARSAL_ADA])).rows[0].id
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL session_replication_role = 'replica'`)
    await c.query(
      `INSERT INTO world_property_designs (world_id, city_id, city_instance_id, property_id, revision, action_id, catalog, facade, roof, windows, lighting, designer_core_user_id, designer_discord_user_id, designed_in_play_session, authority, at_city_sequence)
       SELECT w.id, w.city_id, w.city_instance_id, $2, 1, $3, 'architect-design-v2', 'copper', 'spire', 'lattice', 'cool', s.core_user_id, s.discord_user_id, s.id, 'local-fixture-controller', c.sequence
         FROM worlds w JOIN city c ON c.id = w.city_id JOIN play_sessions s ON s.id = $4 WHERE w.id = $1`,
      [worldId, placed.propertyId, recorded, session],
    )
    await c.query('COMMIT')
  } finally {
    c.release()
  }
  // The answer to it was lost: the E4B page kept exactly this, in exactly its 11-key shape.
  const kept2 = { actionId: recorded, worldId, discordUserId: REHEARSAL_ADA, propertyId: placed.propertyId, baseRevision: 0, catalog: 'architect-design-v2', facade: 'copper', roof: 'spire', windows: 'lattice', lighting: 'cool' }
  await ada.page.evaluate(([key, kept]) => localStorage.setItem(key, JSON.stringify([kept])), [KEPT, kept2] as const)
  await ada.page.reload()
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  const card = ada.page.getByTestId('design-card')
  await expect(card).toHaveAttribute('data-catalog', 'architect-design-v2')
  await expect(card.getByTestId('design-saved')).toHaveText(
    'Copper · Spire · Industrial lattice · Cool floodlights · Standard entry · Standard grounds · saved design, revision 1 (chosen before entrances and landscaping could be chosen: standard entrance and grounds)',
  )
  // 2-3. Drawn exactly as E4B drew it: floodlit, no entrance or grounds of its own.
  await expect(onMap(ada.page)).toHaveAttribute('data-floodlights', 'cool')
  await expect(onMap(ada.page)).not.toHaveAttribute('data-entrance', /.*/)

  // 27. Checked exactly as kept: the same eleven keys, nothing added; answered with its receipt; nothing written.
  let panel = await openDesign(ada.page)
  await expect(panel.getByTestId('design-save')).toHaveText('Check this save · same request')
  await (await designOption(panel, 'design-entrance-portico')).click()
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'repeat')
  await expect(panel.getByTestId('design-feedback')).toHaveText('Already saved by this save: Copper · Spire · Industrial lattice · Cool floodlights · Standard entry · Standard grounds, revision 1. Nothing more was saved.')
  expect(sent).toHaveLength(1)
  expect(JSON.stringify(Object.keys(sent[0]).sort())).toBe(JSON.stringify(['actionId', 'baseRevision', 'catalog', 'discordUserId', 'facade', 'lighting', 'propertyId', 'roof', 'sessionRef', 'windows', 'worldId']))
  expect(sent[0]).toMatchObject(kept2)
  expect(await ada.page.evaluate((key) => localStorage.getItem(key), KEPT)).toBe('[]')
  expect(await revisionsOf(placed.propertyId)).toHaveLength(1)
  await panel.getByRole('button', { name: 'Close panel' }).click()

  // 28. A kept v2 save that never reached the server: refused (settled), never applied as a v3 design.
  const lost = { ...kept2, actionId: randomUUID(), baseRevision: 1, windows: 'ribbon' }
  await ada.page.evaluate(([key, kept]) => localStorage.setItem(key, JSON.stringify([kept])), [KEPT, lost] as const)
  await ada.page.reload()
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  panel = await openDesign(ada.page)
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'renew')
  expect(sent[1]).toMatchObject(lost)
  expect(Object.keys(sent[1])).not.toContain('entrance')
  expect(await ada.page.evaluate((key) => localStorage.getItem(key), KEPT)).toBe('[]')
  expect(await revisionsOf(placed.propertyId)).toHaveLength(1)
  await expect((await designOption(panel, 'design-windows-lattice')).getByRole('radio')).toBeChecked()
  await expect((await designOption(panel, 'design-entrance-standard')).getByRole('radio')).toBeChecked()

  // 26. A v3 save whose answer is lost: kept as all thirteen keys, checked again exactly so after a reload and another choice.
  let lose = true
  await ada.page.route(`**${DESIGNS}`, async (route) => {
    if (!lose) return route.continue()
    lose = false
    await route.fetch()
    await route.abort('failed')
  })
  await (await designOption(panel, 'design-landscaping-garden')).click()
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'unconfirmed')
  expect(await revisionsOf(placed.propertyId)).toHaveLength(2)
  const keptV3 = JSON.parse((await ada.page.evaluate((key) => localStorage.getItem(key), KEPT))!) as Record<string, unknown>[]
  expect(keptV3).toEqual([{ actionId: sent[2].actionId, worldId, discordUserId: REHEARSAL_ADA, propertyId: placed.propertyId, baseRevision: 1, catalog: 'architect-design-v3', facade: 'copper', roof: 'spire', windows: 'lattice', lighting: 'cool', entrance: 'standard', landscaping: 'garden' }])
  await ada.page.reload()
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  panel = await openDesign(ada.page)
  await (await designOption(panel, 'design-entrance-arched')).click()
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'repeat')
  expect(sent[3]).toEqual(sent[2])
  expect(await revisionsOf(placed.propertyId)).toHaveLength(2)
  await panel.getByRole('button', { name: 'Close panel' }).click()

  // On a phone, by keyboard: the tabs are a tablist, and the entrance and landscaping are radio groups; v3 keeps the v2 choices it builds on.
  await ada.page.setViewportSize({ width: 390, height: 844 })
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  await ada.page.getByTestId('design-card').getByTestId('design-open').scrollIntoViewIfNeeded()
  panel = await openDesign(ada.page)
  await panel.getByRole('tab', { name: /^Building/ }).focus()
  await ada.page.keyboard.press('End')
  await expect(panel.getByRole('tab', { name: /^Street level/ })).toBeFocused()
  await expect(panel.getByRole('tab', { name: /^Street level/ })).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('group', { name: 'Entrance' })).toBeVisible()
  await expect(panel.getByRole('group', { name: 'Landscaping' })).toBeVisible()
  await panel.getByRole('radio', { name: /^Standard entry/ }).focus()
  await ada.page.keyboard.press('ArrowDown')
  await expect(panel.getByRole('radio', { name: /^Canopy entry/ })).toBeChecked()
  await panel.getByRole('radio', { name: /^Garden grounds/ }).focus()
  await ada.page.keyboard.press('ArrowDown')
  await expect(panel.getByRole('radio', { name: /^Stone courtyard/ })).toBeChecked()
  await panel.getByRole('button', { name: 'Save design' }).focus()
  await ada.page.keyboard.press('Enter')
  await expect(panel.getByRole('status').filter({ hasText: 'Saved:' })).toHaveText('Saved: Copper · Spire · Industrial lattice · Cool floodlights · Canopy entry · Stone courtyard, revision 3. The city shows it now, for everyone.')
  await expect(panel.getByTestId('design-history-entry')).toHaveCount(3)
  await expect(panel.getByTestId('design-history-entry').nth(2)).toHaveAttribute('data-catalog', 'architect-design-v2')
  await expect(panel.getByTestId('design-history-entry').nth(2)).toContainText('chosen before entrances and landscaping could be chosen')
  const overflow = await ada.page.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth, drawer: (document.querySelector('[data-testid="drawer"]') as HTMLElement).getBoundingClientRect().right - window.innerWidth }))
  expect(overflow.page).toBeLessThanOrEqual(0)
  expect(overflow.drawer).toBeLessThanOrEqual(0)
  // Recorded for the report: how tall the whole view is at phone width, with its three tabs.
  const height = await panel.evaluate((el) => el.scrollHeight)
  await panel.evaluate((el) => el.scrollTo(0, 0))
  await ada.page.screenshot({ path: `${SHOTS}/street-6-mobile-tabs.png` })
  await panel.evaluate((el) => el.scrollTo(0, el.scrollHeight / 3))
  await ada.page.screenshot({ path: `${SHOTS}/street-7-mobile-options.png` })
  testInfo.annotations.push({ type: 'mobile design view height (px)', description: String(height) })
  expect(await revisionsOf(placed.propertyId)).toEqual([
    { revision: 1, catalog: 'architect-design-v2', facade: 'copper', roof: 'spire', windows: 'lattice', lighting: 'cool', entrance: null, landscaping: null, designer: REHEARSAL_ADA },
    { revision: 2, catalog: 'architect-design-v3', facade: 'copper', roof: 'spire', windows: 'lattice', lighting: 'cool', entrance: 'standard', landscaping: 'garden', designer: REHEARSAL_ADA },
    { revision: 3, catalog: 'architect-design-v3', facade: 'copper', roof: 'spire', windows: 'lattice', lighting: 'cool', entrance: 'canopy', landscaping: 'courtyard', designer: REHEARSAL_ADA },
  ])
  // 17. A relaunch reads it all back.
  await arrive(ada.page, launchHref(await launch(guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await expect(onMap(ada.page)).toHaveAttribute('data-entrance', 'awning')
  await expect(onMap(ada.page)).toHaveAttribute('data-grounds', 'courtyard')
  await ada.page.context().close()
})
