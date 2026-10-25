import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import pg from 'pg'
import { arrive, claim, drawnHeight, guildFor, installed, openProperty, player, records, still } from './constructionHelpers'
import { launch, launchHref } from './play'
import { CONSTRUCTION_CREDITS, CONSTRUCTION_KEEPER, REHEARSAL_ADA, REHEARSAL_BEA, REHEARSAL_CY } from './rehearsal'

/**
 * ARCHITECT DESIGN (P1-C2-E4A), end to end against a REAL local Proofy Play, in the original city view. The player the
 * local file names as an NFT's current controller (TEST DATA, never verified ownership) opens the property's Architect
 * design view, previews a facade and a roof on the city itself and beside the saved version, cancels or saves; the saved
 * design is drawn for everyone, survives a reload and grows with the building's tier. Founding, patronage and other players
 * change nothing. A design is free: no test credit, construction unit, tier, Crown, Capital or monument.
 */
const SHOTS = resolve(import.meta.dirname, '../test-artifacts/city-play-evidence')
mkdirSync(SHOTS, { recursive: true })
const KEEPER_ID = CONSTRUCTION_KEEPER.slice(CONSTRUCTION_KEEPER.lastIndexOf('/') + 1)
const DESIGNS = '/v1/play/rehearsal/designs'
const UNCONFIRMED = 'We could not confirm this save. It may already have been saved. Check it with the same save: one save is never applied twice, and never as a different design.'

const databaseUrl = process.env.CITY_PLAY_DATABASE_URL ?? ''
let db: pg.Pool
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: databaseUrl, max: 2 })
})
test.afterAll(async () => {
  await db.end()
})

/** The building on the MAP (the design view's previews draw the same sprite, so the map's is named through the map). */
const onMap = (page: Page, id = KEEPER_ID) => page.getByTestId('city-svg').getByTestId(`building-${id}`)
/** Every design save the page sends, as sent. */
function saves(page: Page) {
  const sent: Record<string, unknown>[] = []
  page.on('request', (r) => r.url().endsWith(DESIGNS) && r.method() === 'POST' && sent.push(r.postDataJSON()))
  return sent
}
const revisionsOf = async (propertyId: string) =>
  (await db.query<{ revision: number; facade: string; roof: string; designer: string }>('SELECT revision, facade, roof, designer_discord_user_id AS designer FROM world_property_designs WHERE property_id = $1 ORDER BY revision', [propertyId])).rows
async function openDesign(page: Page) {
  await page.getByTestId('design-card').getByTestId('design-open').click()
  const panel = page.getByTestId('design-panel')
  await expect(panel).toHaveAttribute('data-state', 'ready')
  return panel
}

test('preview on the city does not save; Cancel restores the saved design; Save persists it for everyone and a reload keeps it; nothing is spent or built', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 10))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  const sent = saves(ada.page)
  const card = ada.page.getByTestId('design-card')
  await expect(card).toHaveAttribute('data-state', 'ready')
  await expect(card).toHaveAttribute('data-control', 'viewer')
  await expect(card).toHaveAttribute('data-revision', '0')
  await expect(card.getByTestId('design-saved')).toHaveText('Slate · Flat deck · the design every new building starts with')
  await expect(card.getByTestId('design-test-tag')).toHaveText('LOCAL TEST')
  await expect(card.getByTestId('design-tier0-note')).toBeVisible()
  await expect(card.getByTestId('design-basis-note')).toHaveText('LOCAL TEST control: this local server’s test file names the NFT’s current controller. Proofy has not verified who holds the NFT. The design stays with the property if the NFT changes hands.')
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'slate')
  const credits = ada.page.getByTestId('construction-credits')
  await expect(credits).toHaveText(String(CONSTRUCTION_CREDITS.ada))

  // 6. Preview: the map's building takes each choice at once; nothing is sent or stored.
  let panel = await openDesign(ada.page)
  await expect(panel.getByTestId('design-panel-test-tag')).toHaveText('LOCAL TEST')
  await expect(panel.getByTestId('design-thumb-saved')).toHaveAttribute('data-facade', 'slate')
  await panel.getByTestId('design-facade-copper').click()
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'copper')
  await expect(panel.getByTestId('design-compare')).toHaveAttribute('data-changed', 'true')
  await expect(panel.getByTestId('design-thumb-preview')).toHaveAttribute('data-facade', 'copper')
  await expect(panel.getByTestId('design-thumb-saved')).toHaveAttribute('data-facade', 'slate')
  await panel.getByTestId('design-roof-dome').click()
  await expect(panel.getByTestId('design-thumb-preview')).toHaveAttribute('data-roof', 'dome')
  // A Tier 0 foundation has no roof yet: the map draws it as before, and the view says when the roof appears.
  await expect(onMap(ada.page)).toHaveAttribute('data-roof', 'flat')
  await expect(panel.getByTestId('design-tier0-note')).toBeVisible()
  await still(ada.page)
  await ada.page.screenshot({ path: `${SHOTS}/design-1-preview-tier0.png` })
  expect(sent).toHaveLength(0)
  expect(await revisionsOf(placed.propertyId)).toEqual([])

  // 7. Cancel: back to the property, and the map shows the saved design again.
  await panel.getByTestId('design-cancel').click()
  await expect(ada.page.getByTestId('building-panel')).toHaveAttribute('data-building', placed.buildingId)
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'slate')
  await expect(ada.page.getByTestId('design-panel')).toHaveCount(0)
  // Leaving another way (another building, the close button) drops a preview just the same.
  panel = await openDesign(ada.page)
  await panel.getByTestId('design-facade-jade').click()
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'jade')
  await panel.getByRole('button', { name: 'Close panel' }).click()
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'slate')
  expect(sent).toHaveLength(0)

  // 8. Save: exactly one request of identifiers, one revision, drawn at once.
  await ada.page.getByTestId('nav-districts').click()
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  panel = await openDesign(ada.page)
  await expect(panel.getByTestId('design-save')).toBeDisabled()
  await panel.getByTestId('design-facade-copper').click()
  await panel.getByTestId('design-roof-dome').click()
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'saved')
  await expect(panel.getByTestId('design-feedback')).toHaveText('Saved: Copper · Dome, revision 1. The city shows it now, for everyone.')
  await expect(panel.getByTestId('design-thumb-saved')).toHaveAttribute('data-facade', 'copper')
  await expect(panel.getByTestId('design-save')).toBeDisabled()
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'copper')
  expect(sent).toHaveLength(1)
  expect(Object.keys(sent[0]).sort()).toEqual(['actionId', 'baseRevision', 'catalog', 'discordUserId', 'facade', 'propertyId', 'roof', 'sessionRef', 'worldId'])
  expect(sent[0]).toMatchObject({ propertyId: placed.propertyId, baseRevision: 0, catalog: 'architect-design-v1', facade: 'copper', roof: 'dome' })
  expect(await revisionsOf(placed.propertyId)).toEqual([{ revision: 1, facade: 'copper', roof: 'dome', designer: REHEARSAL_ADA }])
  await expect(panel.getByTestId('design-history-entry')).toHaveCount(1)
  await ada.page.screenshot({ path: `${SHOTS}/design-2-saved-tier0.png` })

  // Back to the property: its card shows the saved design. 20-22: no credit, unit or tier moved.
  await panel.getByRole('button', { name: 'Back' }).click()
  await expect(ada.page.getByTestId('design-card')).toHaveAttribute('data-revision', '1')
  await expect(ada.page.getByTestId('design-card').getByTestId('design-saved')).toHaveText('Copper · Dome · saved design, revision 1')
  await expect(ada.page.getByTestId('construction-card')).toHaveAttribute('data-built', '0')
  await expect(credits).toHaveText(String(CONSTRUCTION_CREDITS.ada))
  const { constructionsOf, ledger } = records(db)
  expect(await constructionsOf(placed.propertyId)).toEqual([])
  expect(await ledger(placed.propertyId)).toEqual([])
  await expect(onMap(ada.page)).toHaveAttribute('data-tier', '0')

  // 9. A reload, and a relaunch, keep it; reopening the view shows it saved.
  await ada.page.reload()
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'copper')
  await arrive(ada.page, launchHref(await launch(guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'copper')
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  panel = await openDesign(ada.page)
  await expect(panel.getByTestId('design-thumb-saved')).toHaveAttribute('data-roof', 'dome')
  await expect(panel.getByTestId('design-facade-copper').getByRole('radio')).toBeChecked()
  await expect(panel.getByTestId('design-roof-dome').getByRole('radio')).toBeChecked()

  // Everyone in the city sees it; another player has no way to change it.
  const cy = await player(browser, guild, 'Cy', REHEARSAL_CY)
  await expect(onMap(cy.page)).toHaveAttribute('data-facade', 'copper')
  await openProperty(cy.page, placed.plotId, placed.buildingId)
  const theirs = cy.page.getByTestId('design-card')
  await expect(theirs).toHaveAttribute('data-control', 'other')
  await expect(theirs).toHaveAttribute('data-revision', '1')
  await expect(theirs.getByTestId('design-open')).toHaveCount(0)
  await expect(theirs.getByTestId('design-control')).toHaveText('Only the NFT’s current controller, as this local server’s test file names them, can change its design. You can look.')
  // No Crown, Capital or monument for a design.
  await expect(ada.page.getByTestId('hud-crown')).toContainText('—')
  await expect(ada.page.getByTestId('hud-capital')).toHaveAttribute('data-capital', '')
  for (const p of [ada, cy]) await p.context.close()
})

test('1-5, 23. a saved design grows with the building: the roof appears at Tier 1, both stay at Tier 2, roofs and facades are told apart on the map; construction is unchanged', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 11))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  let panel = await openDesign(ada.page)
  await panel.getByTestId('design-facade-jade').click()
  await panel.getByTestId('design-roof-spire').click()
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'saved')
  await panel.getByRole('button', { name: 'Back' }).click()
  // Tier 0: the facade, no roof yet.
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'jade')
  await expect(onMap(ada.page)).toHaveAttribute('data-roof', 'flat')
  const tier0 = await drawnHeight(ada.page, KEEPER_ID)

  // 23. Construction works exactly as before; at Tier 1 the saved spire is drawn.
  const card = await openProperty(ada.page, placed.plotId, placed.buildingId)
  for (let i = 0; i < 2; i++) {
    await card.getByTestId('construction-action').click()
    await expect(card).toHaveAttribute('data-built', String(50 * (i + 1)))
  }
  await expect(onMap(ada.page)).toHaveAttribute('data-tier', '1')
  await expect(onMap(ada.page)).toHaveAttribute('data-roof', 'spire')
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'jade')
  const tier1Spire = await drawnHeight(ada.page, KEEPER_ID)
  expect(tier1Spire).toBeGreaterThan(tier0)
  await ada.page.screenshot({ path: `${SHOTS}/design-3-tier1-spire.png` })

  // The same Tier 1 building with another roof is another silhouette on the map (a preview, not saved).
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  panel = await openDesign(ada.page)
  const heights: Record<string, number> = {}
  for (const roof of ['flat', 'terrace', 'dome', 'spire']) {
    await panel.getByTestId(`design-roof-${roof}`).click()
    await expect(onMap(ada.page)).toHaveAttribute('data-roof', roof)
    heights[roof] = await onMap(ada.page).evaluate((g) => Math.round((g as SVGGraphicsElement).getBBox().height * 10) / 10)
  }
  expect(heights.spire).toBeGreaterThan(heights.dome)
  expect(heights.dome).toBeGreaterThan(heights.flat)
  expect(new Set(Object.values(heights)).size).toBeGreaterThanOrEqual(3)
  await panel.getByTestId('design-roof-dome').click()
  await panel.getByTestId('design-facade-copper').click()
  await still(ada.page)
  await ada.page.screenshot({ path: `${SHOTS}/design-3b-tier1-preview-vs-saved.png` })
  await panel.getByTestId('design-cancel').click()
  await expect(onMap(ada.page)).toHaveAttribute('data-roof', 'spire')

  // Patrons take it to Tier 2: the saved design is still the one drawn, taller.
  const cy = await player(browser, guild, 'Cy', REHEARSAL_CY)
  const cyCard = await openProperty(cy.page, placed.plotId, placed.buildingId)
  for (let i = 0; i < 2; i++) {
    await cyCard.getByTestId('construction-action').click()
    await expect(cyCard).toHaveAttribute('data-built', String(150 + 50 * i))
  }
  const bea = await player(browser, guild, 'Bea', REHEARSAL_BEA)
  const beaCard = await openProperty(bea.page, placed.plotId, placed.buildingId)
  await beaCard.getByTestId('construction-action').click()
  await expect(beaCard).toHaveAttribute('data-tier', '2')
  await expect(onMap(bea.page)).toHaveAttribute('data-tier', '2')
  await expect(onMap(bea.page)).toHaveAttribute('data-roof', 'spire')
  await expect(onMap(bea.page)).toHaveAttribute('data-facade', 'jade')
  const tier2 = await drawnHeight(ada.page, KEEPER_ID)
  expect(tier2).toBeGreaterThan(tier1Spire)
  await expect(onMap(ada.page)).toHaveAttribute('data-roof', 'spire')

  // The controller changes it at Tier 2 (revision 2): every player sees it after their next read.
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  panel = await openDesign(ada.page)
  await panel.getByTestId('design-facade-limestone').click()
  await panel.getByTestId('design-roof-terrace').click()
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveText('Saved: Limestone · Roof terrace, revision 2. The city shows it now, for everyone.')
  await panel.getByRole('button', { name: 'Back' }).click()
  await still(ada.page)
  await ada.page.screenshot({ path: `${SHOTS}/design-4-tier2-terrace.png` })
  await bea.page.reload()
  await expect(onMap(bea.page)).toHaveAttribute('data-facade', 'limestone')
  await expect(onMap(bea.page)).toHaveAttribute('data-roof', 'terrace')
  await expect(onMap(bea.page)).toHaveAttribute('data-tier', '2')
  expect((await revisionsOf(placed.propertyId)).map((r) => [r.revision, r.facade, r.roof])).toEqual([
    [1, 'jade', 'spire'],
    [2, 'limestone', 'terrace'],
  ])
  const { constructionsOf } = records(db)
  expect((await constructionsOf(placed.propertyId)).map((c) => [c.role, c.built_after])).toEqual([
    ['owner', 50],
    ['owner', 100],
    ['patron', 150],
    ['patron', 200],
    ['patron', 250],
  ])
  await expect(ada.page.getByTestId('crown-spire')).toHaveCount(0)
  for (const p of [ada, cy, bea]) await p.context.close()
})

test('13-14. the founder who is not the controller, and a patron, cannot change a design; the controller (not the founder) can, from the Architect activity too', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 12))
  // Bea founds #812; the local file names Ada its controller.
  const bea = await player(browser, guild, 'Bea', REHEARSAL_BEA)
  const placed = await claim(bea.page, CONSTRUCTION_KEEPER)
  const card = bea.page.getByTestId('design-card')
  await expect(card).toHaveAttribute('data-control', 'other')
  await expect(card.getByTestId('design-open')).toHaveCount(0)
  await expect(card.getByTestId('design-control')).toContainText('Founding this property does not let you change it.')
  await expect(bea.page.getByTestId('building-panel').getByTestId('property-founder')).toHaveText('You')
  // Asked outright from her page: refused, nothing written.
  const actor = { sessionRef: await bea.city.getAttribute('data-session-ref'), worldId: await bea.city.getAttribute('data-world'), discordUserId: REHEARSAL_BEA }
  const asked = await bea.page.evaluate(
    async ([path, body]) => {
      const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return [res.status, await res.json()]
    },
    [DESIGNS, { ...actor, propertyId: placed.propertyId, actionId: crypto.randomUUID(), baseRevision: 0, catalog: 'architect-design-v1', facade: 'brick', roof: 'dome' }] as const,
  )
  expect(asked).toEqual([403, { error: 'not_current_controller' }])
  // A patron contributes, and still has no design view.
  await bea.page.getByTestId('construction-action').click()
  await expect(bea.page.getByTestId('construction-card')).toHaveAttribute('data-built', '50')
  await expect(bea.page.getByTestId('construction-credits')).toHaveText(String(CONSTRUCTION_CREDITS.bea - 50))
  await expect(bea.page.getByTestId('design-card').getByTestId('design-open')).toHaveCount(0)
  expect(await revisionsOf(placed.propertyId)).toEqual([])

  // Ada controls it without having founded it: her Architect activity offers its design view.
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  await ada.page.getByTestId('nav-properties').click()
  await expect(ada.page.getByTestId('my-property')).toHaveCount(0)
  await ada.page.getByTestId('my-properties-architect').click()
  const item = ada.page.getByTestId('architect-property')
  await expect(item).toHaveAttribute('data-control', 'viewer')
  await expect(item).toHaveAttribute('data-founded', 'false')
  await item.getByTestId('architect-property-design').click()
  const panel = ada.page.getByTestId('design-panel')
  await expect(panel).toHaveAttribute('data-state', 'ready')
  await expect(panel).toBeFocused()
  await panel.getByTestId('design-facade-brick').click()
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'saved')
  // Back goes to the property's panel, and its Back to the Architect activity it came from.
  await panel.getByRole('button', { name: 'Back' }).click()
  await expect(ada.page.getByTestId('building-panel')).toHaveAttribute('data-building', placed.buildingId)
  await expect(ada.page.getByTestId('building-panel').getByTestId('property-founder')).toHaveText('Recorded privately')
  await ada.page.getByTestId('building-panel').getByRole('button', { name: 'Back' }).click()
  await expect(ada.page.getByTestId('architect-activity')).toBeVisible()
  expect(await revisionsOf(placed.propertyId)).toEqual([{ revision: 1, facade: 'brick', roof: 'flat', designer: REHEARSAL_ADA }])
  // The founder sees the design Ada saved; the founding record is still hers.
  await bea.page.reload()
  await expect(onMap(bea.page)).toHaveAttribute('data-facade', 'brick')
  expect((await db.query('SELECT activator_discord_user_id FROM world_properties WHERE id = $1', [placed.propertyId])).rows).toEqual([{ activator_discord_user_id: REHEARSAL_BEA }])
  for (const p of [ada, bea]) await p.context.close()
})

test('18-19. a save whose answer was lost is checked as exactly the same save, even after a reload and another choice; it is saved once; a double press sends one', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 13))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  const sent = saves(ada.page)
  let lose = true
  await ada.page.route(`**${DESIGNS}`, async (route) => {
    if (!lose) return route.continue()
    lose = false
    await route.fetch()
    await route.abort('failed')
  })
  let panel = await openDesign(ada.page)
  await panel.getByTestId('design-facade-copper').click()
  await panel.getByTestId('design-roof-terrace').click()
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'unconfirmed')
  await expect(panel.getByTestId('design-feedback')).toHaveText(UNCONFIRMED)
  await expect(panel.getByTestId('design-save')).toHaveText('Check this save · same request')
  // It was saved; the page never said so.
  expect(await revisionsOf(placed.propertyId)).toHaveLength(1)
  const kept = JSON.parse((await ada.page.evaluate(() => localStorage.getItem('rare-city-design-saves')))!) as Record<string, unknown>[]
  expect(kept).toEqual([{ actionId: sent[0].actionId, worldId: sent[0].worldId, discordUserId: REHEARSAL_ADA, propertyId: placed.propertyId, baseRevision: 0, catalog: 'architect-design-v1', facade: 'copper', roof: 'terrace' }])

  // A reload, then another choice: the check still sends exactly the first request, and is answered with what it saved.
  await ada.page.reload()
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  panel = await openDesign(ada.page)
  await expect(panel.getByTestId('design-save')).toHaveText('Check this save · same request')
  await panel.getByTestId('design-facade-jade').click()
  await panel.getByTestId('design-save').click()
  await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'repeat')
  await expect(panel.getByTestId('design-feedback')).toHaveText('Already saved by this save: Copper · Roof terrace, revision 1. Nothing more was saved.')
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual(sent[0])
  expect(await revisionsOf(placed.propertyId)).toEqual([{ revision: 1, facade: 'copper', roof: 'terrace', designer: REHEARSAL_ADA }])
  expect(await ada.page.evaluate(() => localStorage.getItem('rare-city-design-saves'))).toBe('[]')
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'copper')
  // The choice followed the saved design; a double press of the next save sends one request.
  await expect(panel.getByTestId('design-facade-copper').getByRole('radio')).toBeChecked()
  await panel.getByTestId('design-facade-limestone').click()
  await panel.getByTestId('design-save').dblclick()
  await expect(panel.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'saved')
  expect(sent).toHaveLength(3)
  expect(sent[2]).toMatchObject({ baseRevision: 1, facade: 'limestone', roof: 'terrace' })
  expect((await revisionsOf(placed.propertyId)).map((r) => r.revision)).toEqual([1, 2])
  await ada.page.context().close()
})

test('the design view works by keyboard and on a phone-sized screen, and is labelled for screen readers', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 14))
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await arrive(page, launchHref(await launch(guild, 'rare-city', 'Ada', REHEARSAL_ADA)))
  const placed = await claim(page, CONSTRUCTION_KEEPER)
  // Then a phone-sized screen, for the rest.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByTestId('design-card').getByTestId('design-open').scrollIntoViewIfNeeded()
  await page.getByTestId('design-card').getByTestId('design-open').focus()
  await page.keyboard.press('Enter')
  const panel = page.getByTestId('design-panel')
  await expect(panel).toHaveAttribute('data-state', 'ready')
  await expect(panel).toHaveAccessibleName(/^Architect design of /)
  await expect(panel.getByRole('group', { name: 'Facade' })).toBeVisible()
  await expect(panel.getByRole('group', { name: 'Roof' })).toBeVisible()
  // Arrow keys move through each choice, as a radio group does.
  await panel.getByRole('radio', { name: /^Slate/ }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(panel.getByRole('radio', { name: /^Limestone/ })).toBeChecked()
  await expect(onMap(page)).toHaveAttribute('data-facade', 'limestone')
  await panel.getByRole('radio', { name: /^Flat deck/ }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(panel.getByRole('radio', { name: /^Roof terrace/ })).toBeChecked()
  await panel.getByRole('button', { name: 'Save design' }).focus()
  await page.keyboard.press('Enter')
  await expect(panel.getByRole('status').filter({ hasText: 'Saved:' })).toHaveText('Saved: Limestone · Roof terrace, revision 1. The city shows it now, for everyone.')
  // Nothing on the page scrolls sideways at phone width; the drawer stays inside the screen.
  const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth, drawer: (document.querySelector('[data-testid="drawer"]') as HTMLElement).getBoundingClientRect().right - window.innerWidth }))
  expect(overflow.page).toBeLessThanOrEqual(0)
  expect(overflow.drawer).toBeLessThanOrEqual(0)
  await page.screenshot({ path: `${SHOTS}/design-5-mobile-actions.png` })
  await panel.evaluate((el) => el.scrollTo(0, 0))
  await page.screenshot({ path: `${SHOTS}/design-5-mobile-compare.png` })
  expect(await revisionsOf(placed.propertyId)).toEqual([{ revision: 1, facade: 'limestone', roof: 'terrace', designer: REHEARSAL_ADA }])
  await context.close()
})

test('a refused or uncertain save is said as what happened to the DESIGN: never a build, a spend, an owner or a placement; an uncertain one is checked again and saved once (audit L3)', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 13, 1))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  const sent = saves(ada.page)
  const panel = await openDesign(ada.page)
  const feedback = panel.getByTestId('design-feedback')
  const kept = async () => JSON.parse((await ada.page.evaluate(() => localStorage.getItem('rare-city-design-saves'))) ?? '[]') as Record<string, unknown>[]
  /** The next save is answered by `status` and `error` without reaching the server: nothing is written. */
  const answerOnce = (status: number, error: string) =>
    ada.page.route(`**${DESIGNS}`, (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error }) }), { times: 1 })
  await panel.getByTestId('design-facade-copper').click()

  // Refusals decided before any write: design wording, LOCAL TEST control, no revision recorded, nothing kept to resend.
  for (const [error, text] of [
    ['not_current_controller', 'This local server’s test file does not name you as this NFT’s current controller (LOCAL TEST control, not verified by Proofy), so you are not authorized to change this property’s design. Founding a property, or contributing to it as a patron, does not grant that. No design revision was recorded.'],
    ['control_unverified', 'Current LOCAL TEST control of this NFT could not be established: this local server’s test file names no current controller for it, so nobody can change this property’s design. No design revision was recorded.'],
  ] as const) {
    await answerOnce(403, error)
    await panel.getByTestId('design-save').click()
    await expect(feedback).toHaveAttribute('data-outcome', 'refused')
    await expect(feedback).toHaveText(text)
    expect(await kept()).toEqual([])
  }
  // An id recorded for another save: nothing applied under it, and nothing claimed about that other save.
  await answerOnce(409, 'action_conflict')
  await panel.getByTestId('design-save').click()
  await expect(feedback).toHaveAttribute('data-outcome', 'conflict')
  await expect(feedback).toHaveText('This save’s id is already recorded for a different design save, so this request was not applied under it. How that other save went is not known here: check this property’s saved design and history before you save again.')
  // A conflict at the same moment is not known to have saved nothing: the save is kept, and checked again as sent.
  await answerOnce(409, 'sequence_conflict')
  await panel.getByTestId('design-save').click()
  await expect(feedback).toHaveAttribute('data-outcome', 'unconfirmed')
  await expect(feedback).toHaveText(UNCONFIRMED)
  expect(await kept()).toHaveLength(1)
  expect(await feedback.textContent()).not.toMatch(/\bbuil[dt]|spen[dt]|credit|owner|placed|nothing was saved/i)
  expect(await revisionsOf(placed.propertyId)).toEqual([])
  await panel.getByTestId('design-save').click()
  await expect(feedback).toHaveAttribute('data-outcome', 'saved')
  expect(sent[sent.length - 1]).toEqual(sent[sent.length - 2])
  expect(await revisionsOf(placed.propertyId)).toEqual([{ revision: 1, facade: 'copper', roof: 'flat', designer: REHEARSAL_ADA }])
  expect(await kept()).toEqual([])
  await ada.page.context().close()
})
