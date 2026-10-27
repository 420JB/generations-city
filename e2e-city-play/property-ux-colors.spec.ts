import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import pg from 'pg'
import { claim, designOption, guildFor, installed, openProperty, player, presses, records, still } from './constructionHelpers'
import { snowflake } from './play'
import { CONSTRUCTION_CREDITS, CONSTRUCTION_KEEPER, CONSTRUCTION_PASS, REHEARSAL_ADA, REHEARSAL_BEA } from './rehearsal'

/**
 * PROPERTY UX AND EXTERIOR COLORS (P1-E6), end to end against a REAL local Proofy Play, in the original city view.
 *
 * A stored property's panel leads with what a player can do: its address, tier and who the local file names as its
 * controller, then BUILD (or CONTRIBUTE) and CUSTOMIZE, its construction and its Architect design, and only then its
 * records. The actions are the cards' own (one press book, one design answer) and are offered only as the server allows.
 *
 * An exterior color is chosen apart from the facade material, in the Building tab, previewed on the map's own building,
 * cancelled, saved as a revision of architect-design-v4 that every player sees after a reload, keeping every earlier
 * revision. FREE: no credit, construction, tier or sequence. LOCAL TEST control only. HEADLESS ONLY.
 */
const SHOTS = resolve(import.meta.dirname, '../test-artifacts/city-play-evidence')
mkdirSync(SHOTS, { recursive: true })
const KEEPER_ID = CONSTRUCTION_KEEPER.slice(CONSTRUCTION_KEEPER.lastIndexOf('/') + 1)
const PASS_ID = CONSTRUCTION_PASS.slice(CONSTRUCTION_PASS.lastIndexOf('/') + 1)
const DESIGNS = '/v1/play/rehearsal/designs'
const COLORS = ['natural', 'ivory', 'sand', 'terracotta', 'rose', 'crimson', 'copper-orange', 'forest-green', 'sage', 'ocean-blue', 'navy', 'lavender', 'charcoal']
const KEYS_V4 = ['actionId', 'baseRevision', 'catalog', 'color', 'discordUserId', 'entrance', 'facade', 'landscaping', 'lighting', 'propertyId', 'roof', 'sessionRef', 'windows', 'worldId']

const databaseUrl = process.env.CITY_PLAY_DATABASE_URL ?? ''
let db: pg.Pool
test.beforeAll(() => {
  db = new pg.Pool({ connectionString: databaseUrl, max: 2 })
})
test.afterAll(async () => {
  await db.end()
})

const onMap = (page: Page, id = KEEPER_ID) => page.getByTestId('city-svg').getByTestId(`building-${id}`)
function saves(page: Page) {
  const sent: Record<string, unknown>[] = []
  page.on('request', (r) => r.url().endsWith(DESIGNS) && r.method() === 'POST' && sent.push(r.postDataJSON()))
  return sent
}
const revisionsOf = async (propertyId: string) =>
  (
    await db.query<{ revision: number; catalog: string; facade: string; color: string | null; designer: string }>(
      'SELECT revision, catalog, facade, color, designer_discord_user_id AS designer FROM world_property_designs WHERE property_id = $1 ORDER BY revision',
      [propertyId],
    )
  ).rows
const sequenceOf = async (worldId: string) => (await db.query<{ sequence: string }>('SELECT c.sequence FROM city c JOIN worlds w ON w.city_id = c.id WHERE w.id = $1', [worldId])).rows[0].sequence
/** Whether `el` is inside the panel's first screen, as the panel is scrolled now. */
async function onFirstScreen(panel: Locator, el: Locator) {
  const [p, e] = [await panel.boundingBox(), await el.boundingBox()]
  return !!p && !!e && e.y >= p.y && e.y + e.height <= p.y + p.height
}
/** The document order of each test id inside `root`. */
const orderOf = (root: Locator, ids: string[]) =>
  root.evaluate((el, list) => list.map((id) => [...el.querySelectorAll('[data-testid]')].findIndex((x) => x.getAttribute('data-testid') === id)), ids)

test('the panel leads with build and customize; an exterior color previews on the city, cancels, saves apart from the material, and reloads, for free', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 22))
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  const placed = await claim(ada.page, CONSTRUCTION_KEEPER)
  const worldId = (await ada.city.getAttribute('data-world'))!
  const panel = ada.page.getByTestId('building-panel')
  await expect(panel.getByTestId('construction-card')).toHaveAttribute('data-state', 'ready')
  await expect(panel.getByTestId('design-card')).toHaveAttribute('data-state', 'ready')

  // A. The header says who controls it; B. both actions sit right under it, on the first screen, before any record.
  await panel.evaluate((el) => el.scrollTo(0, 0))
  await expect(panel.getByTestId('property-control')).toHaveAttribute('data-control', 'viewer')
  await expect(panel.getByTestId('property-control')).toContainText('You are its current test controller')
  const build = panel.getByTestId('property-action-build')
  const customize = panel.getByTestId('property-action-design')
  await expect(build).toHaveText(`Build · 50 TEST credits`)
  await expect(build).toHaveAttribute('data-role', 'owner')
  await expect(build).toBeEnabled()
  await expect(customize).toBeEnabled()
  for (const el of [panel.getByTestId('property-head'), build, customize]) expect(await onFirstScreen(panel, el)).toBe(true)
  const order = await orderOf(panel, ['property-head', 'property-actions', 'construction-card', 'design-card', 'property-records', 'property-founder', 'property-identifiers', 'stored-property', 'construction-records', 'property-legacy-open'])
  expect(order.every((i) => i >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  testInfo.annotations.push({ type: 'construction action on the first screen (1440x900)', description: String(await onFirstScreen(panel, panel.getByTestId('construction-card').getByTestId('construction-action'))) })
  await ada.page.screenshot({ path: `${SHOTS}/e6-1-panel-first-screen.png` })

  // The bar's Build is the card's own action, by keyboard: one press, one construction, one debit.
  const sentPresses = presses(ada.page)
  await build.focus()
  await ada.page.keyboard.press('Enter')
  await expect(panel.getByTestId('construction-card')).toHaveAttribute('data-built', '50')
  await expect(panel.getByTestId('construction-status')).toHaveAttribute('data-outcome', 'built')
  expect(sentPresses).toHaveLength(1)
  expect(await records(db).constructionsOf(placed.propertyId)).toHaveLength(1)
  await expect(panel.getByTestId('construction-credits')).toHaveText(String(CONSTRUCTION_CREDITS.ada - 50))
  await build.click()
  await expect(panel.getByTestId('construction-card')).toHaveAttribute('data-built', '100')
  await expect(onMap(ada.page)).toHaveAttribute('data-tier', '1')
  expect(sentPresses).toHaveLength(2)
  await ada.page.keyboard.press('Tab')
  await expect(customize).toBeFocused()
  const credits = await panel.getByTestId('construction-credits').textContent()
  const built = (await records(db).constructionsOf(placed.propertyId)).length
  const sequence = await sequenceOf(worldId)
  const sent = saves(ada.page)

  // Customize opens the Architect design view; the Building tab offers material, color and roof, in that order.
  await ada.page.keyboard.press('Enter')
  let design = ada.page.getByTestId('design-panel')
  await expect(design).toHaveAttribute('data-state', 'ready')
  await expect(design.getByTestId('design-tab-building')).toHaveAttribute('aria-selected', 'true')
  await expect(design.getByTestId('design-tab-building')).toContainText('Facade · Color · Roof')
  const fields = await orderOf(design.getByTestId('design-group-building'), ['design-facades', 'design-colors', 'design-roofs'])
  expect(fields.every((i) => i >= 0) && fields[0] < fields[1] && fields[1] < fields[2]).toBe(true)
  const colors = design.getByRole('group', { name: /^Exterior color/ })
  await expect(colors).toBeVisible()
  await expect(colors.getByRole('radio')).toHaveCount(COLORS.length)
  await expect(colors.getByRole('radio', { name: 'Natural', exact: true })).toBeChecked()

  // By keyboard, as one radio group: each color previews on the map's own building at once, named, nothing sent.
  await colors.getByRole('radio', { name: 'Natural', exact: true }).focus()
  await ada.page.keyboard.press('ArrowRight')
  await expect(colors.getByRole('radio', { name: 'Ivory', exact: true })).toBeChecked()
  await expect(colors.getByRole('radio', { name: 'Ivory', exact: true })).toBeFocused()
  await expect(onMap(ada.page)).toHaveAttribute('data-exterior', 'ivory')
  await expect(design.getByTestId('design-colors')).toHaveAttribute('data-chosen', 'ivory')
  await expect(design.getByTestId('design-unsaved')).toBeVisible()
  // Every palette color, on the city itself; natural takes the color away again.
  for (const color of [...COLORS.slice(1), 'natural']) {
    await (await designOption(design, `design-color-${color}`)).click()
    await expect(design.getByTestId(`design-color-${color}`)).toHaveClass(/\bon\b/)
    if (color === 'natural') await expect(onMap(ada.page)).not.toHaveAttribute('data-exterior', /.*/)
    else await expect(onMap(ada.page)).toHaveAttribute('data-exterior', color)
    await expect(design.getByTestId('design-thumb-preview')).toHaveAttribute('data-color', color)
  }
  await expect(design.getByTestId('design-unsaved')).toHaveCount(0)
  // A color and a material, chosen apart: either changes alone; the swatches show the material in each color.
  await (await designOption(design, 'design-color-ocean-blue')).click()
  await (await designOption(design, 'design-facade-brick')).click()
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'brick')
  await expect(onMap(ada.page)).toHaveAttribute('data-exterior', 'ocean-blue')
  await expect(onMap(ada.page).locator('rect[fill="url(#surface-brick)"]').first()).toBeAttached()
  await expect(design.getByTestId('design-color-navy').locator('svg')).toHaveAttribute('data-facade', 'brick')
  await expect(design.getByTestId('design-facade-jade').locator('svg')).toHaveAttribute('data-color', 'ocean-blue')
  await expect(design.getByTestId('design-tab-building')).toHaveAttribute('data-changes', '2')
  await expect(design.getByTestId('design-changes')).toHaveText('Preview changes facade (Slate → Brick), color (Natural → Ocean blue). Not saved yet.')
  await expect(design.getByTestId('design-thumb-saved')).toHaveAttribute('data-color', 'natural')
  await still(ada.page)
  await ada.page.screenshot({ path: `${SHOTS}/e6-2-editor-color-preview.png` })
  expect(sent).toEqual([])
  // Cancel: the saved design again, on the city and in the database; nothing was sent.
  await design.getByTestId('design-cancel').click()
  await expect(design).toHaveCount(0)
  await expect(onMap(ada.page)).not.toHaveAttribute('data-exterior', /.*/)
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'slate')
  expect(await revisionsOf(placed.propertyId)).toEqual([])
  expect(sent).toEqual([])

  // Save brick in navy: one revision of v4, its fourteen keys, drawn for everyone.
  await panel.getByTestId('property-action-design').click()
  design = ada.page.getByTestId('design-panel')
  await expect(design).toHaveAttribute('data-state', 'ready')
  await (await designOption(design, 'design-facade-brick')).click()
  await (await designOption(design, 'design-color-navy')).click()
  await design.getByTestId('design-save').click()
  await expect(design.getByTestId('design-feedback')).toHaveText('Saved: Brick in Navy · Flat deck · Standard grid · Standard lighting · Standard entry · Standard grounds, revision 1. The city shows it now, for everyone.')
  expect(sent).toHaveLength(1)
  expect(Object.keys(sent[0]).sort()).toEqual(KEYS_V4)
  expect(sent[0]).toMatchObject({ catalog: 'architect-design-v4', facade: 'brick', color: 'navy', baseRevision: 0 })
  // The material alone (the color stays), then the color alone (the material stays).
  await (await designOption(design, 'design-facade-jade')).click()
  await expect(design.getByTestId('design-changes')).toHaveText('Preview changes facade (Brick → Jade). Not saved yet.')
  await design.getByTestId('design-save').click()
  await expect(design.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'saved')
  await (await designOption(design, 'design-color-crimson')).click()
  await expect(design.getByTestId('design-changes')).toHaveText('Preview changes color (Navy → Crimson). Not saved yet.')
  await design.getByTestId('design-save').click()
  await expect(design.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'saved')
  expect(await revisionsOf(placed.propertyId)).toEqual([
    { revision: 1, catalog: 'architect-design-v4', facade: 'brick', color: 'navy', designer: REHEARSAL_ADA },
    { revision: 2, catalog: 'architect-design-v4', facade: 'jade', color: 'navy', designer: REHEARSAL_ADA },
    { revision: 3, catalog: 'architect-design-v4', facade: 'jade', color: 'crimson', designer: REHEARSAL_ADA },
  ])
  await expect(design.getByTestId('design-history-entry').first()).toHaveAttribute('data-color', 'crimson')
  // Free: no credit, construction, tier or city sequence for any of it.
  expect(await records(db).constructionsOf(placed.propertyId)).toHaveLength(built)
  expect(await sequenceOf(worldId)).toBe(sequence)
  await expect(onMap(ada.page)).toHaveAttribute('data-tier', '1')
  await design.getByRole('button', { name: 'Close panel' }).click()

  // A reload reads it back: the map, the design card, the panel's credits as they were; earlier revisions as saved.
  await ada.page.reload()
  await expect(ada.page.getByTestId('city-svg')).toBeVisible()
  await still(ada.page)
  await expect(onMap(ada.page)).toHaveAttribute('data-exterior', 'crimson')
  await expect(onMap(ada.page)).toHaveAttribute('data-facade', 'jade')
  const card = await openProperty(ada.page, placed.plotId, placed.buildingId)
  await expect(card.page().getByTestId('construction-credits')).toHaveText(credits!)
  const designCard = ada.page.getByTestId('design-card')
  await expect(designCard).toHaveAttribute('data-color', 'crimson')
  await expect(designCard.getByTestId('design-saved')).toHaveText('Jade in Crimson · Flat deck · Standard grid · Standard lighting · Standard entry · Standard grounds · saved design, revision 3')
  await ada.page.getByTestId('property-legacy-open').click()
  const legacy = ada.page.getByTestId('property-legacy')
  await expect(legacy).toHaveAttribute('data-state', 'ready')
  await expect(legacy.getByTestId('legacy-design')).toHaveCount(3)
  await expect(legacy.getByTestId('legacy-design').nth(0)).toContainText('Jade in Crimson')
  await expect(legacy.getByTestId('legacy-design').nth(2)).toContainText('Brick in Navy')
  await expect(legacy.getByTestId('legacy-thumb')).toHaveAttribute('data-color', 'crimson')
  // Up close, the material's surface over the color.
  await ada.page.getByTestId('property-legacy').getByRole('button', { name: 'Close panel' }).click()
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  for (let i = 0; i < 14 && (await ada.page.getByTestId('city').getAttribute('data-detail')) !== 'near'; i++) {
    await ada.page.getByRole('button', { name: 'Zoom in' }).click()
    await still(ada.page)
  }
  await expect(onMap(ada.page).locator('rect[fill="url(#surface-jade)"]').first()).toBeAttached()
  const box = (await onMap(ada.page).locator('polygon').first().boundingBox())!
  const view = ada.page.viewportSize()!
  const x = Math.max(0, Math.min(view.width - 360, box.x + box.width / 2 - 180))
  const y = Math.max(0, Math.min(view.height - 420, box.y + box.height - 380))
  await ada.page.screenshot({ path: `${SHOTS}/e6-3-colored-building-near.png`, clip: { x, y, width: 360, height: 420 } })

  // On a phone: the actions are still right under the header, on the first screen of the drawer.
  await ada.page.setViewportSize({ width: 390, height: 844 })
  await ada.page.reload()
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  const small = ada.page.getByTestId('building-panel')
  await small.evaluate((el) => el.scrollTo(0, 0))
  const overflow = await ada.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  const head = (await small.getByTestId('property-head').boundingBox())!
  const bar = (await small.getByTestId('property-actions').boundingBox())!
  expect(bar.y).toBeGreaterThanOrEqual(head.y + head.height - 1)
  expect(bar.y - head.y).toBeLessThan(140)
  testInfo.annotations.push({ type: 'phone: actions on the panel\'s first screen', description: String(await onFirstScreen(small, small.getByTestId('property-action-design'))) })
  await ada.page.screenshot({ path: `${SHOTS}/e6-4-panel-phone.png` })
  await ada.context.close()
})

test('a patron contributes but cannot customize; nobody named means nobody customizes; no credits means no build; a color is refused unless it is a catalog name and the controller saves it', async ({ browser }, testInfo) => {
  const { guild } = await installed(guildFor(testInfo, 23))
  // Bea founds #812; the local file names Ada its controller.
  const bea = await player(browser, guild, 'Bea', REHEARSAL_BEA)
  const placed = await claim(bea.page, CONSTRUCTION_KEEPER)
  let panel = bea.page.getByTestId('building-panel')
  await expect(panel.getByTestId('construction-card')).toHaveAttribute('data-state', 'ready')
  await expect(panel.getByTestId('property-control')).toHaveAttribute('data-control', 'other')
  await expect(panel.getByTestId('property-control')).toContainText('Another player is its current test controller')
  await expect(panel.getByTestId('property-action-design')).toBeDisabled()
  await expect(panel.getByTestId('property-actions-note')).toContainText('Only its current test controller can customize its design. Founding it does not let you change it.')
  await expect(panel.getByTestId('design-card').getByTestId('design-open')).toHaveCount(0)
  // As a patron, by keyboard: the bar's action is a contribution.
  const contribute = panel.getByTestId('property-action-build')
  await expect(contribute).toHaveText('Contribute · 50 TEST credits')
  await expect(contribute).toHaveAttribute('data-role', 'patron')
  await contribute.focus()
  await bea.page.keyboard.press('Enter')
  await expect(panel.getByTestId('construction-card')).toHaveAttribute('data-built', '50')
  expect((await records(db).constructionsOf(placed.propertyId)).map((c) => [c.role, c.contributor_discord_user_id])).toEqual([['patron', REHEARSAL_BEA]])
  // Out of credits (Bea's 50 are spent): the bar says why, and offers no build.
  await expect(contribute).toBeDisabled()
  await expect(panel.getByTestId('property-actions-note')).toContainText('Not enough test credits for one step (0 held).')

  // Asked outright, with a color: refused for the founder and patron; a value that is not a catalog name never gets that far.
  const actor = { sessionRef: await bea.city.getAttribute('data-session-ref'), worldId: await bea.city.getAttribute('data-world'), discordUserId: REHEARSAL_BEA }
  const askAs = (color: unknown) =>
    bea.page.evaluate(
      async ([path, body]) => {
        const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        return [res.status, await res.json()]
      },
      [DESIGNS, { ...actor, propertyId: placed.propertyId, actionId: crypto.randomUUID(), baseRevision: 0, catalog: 'architect-design-v4', facade: 'slate', roof: 'flat', windows: 'grid', lighting: 'standard', entrance: 'standard', landscaping: 'standard', color }] as const,
    )
  expect(await askAs('navy')).toEqual([403, { error: 'not_current_controller' }])
  for (const bad of ['#ff0000', 'rgb(1,2,3)', 'url(x)', 'Navy', null]) expect(await askAs(bad), String(bad)).toEqual([400, { error: 'invalid_request' }])
  expect(await askAs('teal')).toEqual([422, { error: 'design_unsupported' }])
  expect(await revisionsOf(placed.propertyId)).toEqual([])

  // Ada's Tide Pass #77: nobody is named its controller, so nobody customizes it; Ada, its founder, may contribute.
  const ada = await player(browser, guild, 'Ada', REHEARSAL_ADA)
  await claim(ada.page, CONSTRUCTION_PASS)
  panel = ada.page.getByTestId('building-panel')
  await expect(panel.getByTestId('construction-card')).toHaveAttribute('data-state', 'ready')
  await expect(panel.getByTestId('property-control')).toHaveAttribute('data-control', 'unknown')
  await expect(panel.getByTestId('property-control')).toContainText('No current controller is named')
  await expect(panel.getByTestId('property-action-design')).toBeDisabled()
  await expect(panel.getByTestId('property-actions-note')).toContainText('No current controller is named for this NFT, so nobody can customize it.')
  await expect(panel.getByTestId('property-action-build')).toHaveAttribute('data-role', 'patron')
  await expect(onMap(ada.page, PASS_ID)).not.toHaveAttribute('data-exterior', /.*/)

  // A player the file grants nothing reads #812 and is offered neither action.
  const visitor = await player(browser, guild, 'Visitor', snowflake())
  await openProperty(visitor.page, placed.plotId, placed.buildingId)
  const read = visitor.page.getByTestId('building-panel')
  await expect(read.getByTestId('property-action-build')).toBeDisabled()
  await expect(read.getByTestId('property-action-design')).toBeDisabled()
  await expect(read.getByTestId('property-actions-note')).toContainText('grants you no test credits here')
  await expect(read.getByTestId('property-records')).toBeVisible()

  // Ada, the controller who did not found it, colors #812; the founder and the visitor see it after a reload.
  await openProperty(ada.page, placed.plotId, placed.buildingId)
  panel = ada.page.getByTestId('building-panel')
  await expect(panel.getByTestId('property-control')).toHaveAttribute('data-control', 'viewer')
  await panel.getByTestId('property-action-design').click()
  const design = ada.page.getByTestId('design-panel')
  await expect(design).toHaveAttribute('data-state', 'ready')
  await (await designOption(design, 'design-color-sage')).click()
  await design.getByTestId('design-save').click()
  await expect(design.getByTestId('design-feedback')).toHaveAttribute('data-outcome', 'saved')
  expect(await revisionsOf(placed.propertyId)).toEqual([{ revision: 1, catalog: 'architect-design-v4', facade: 'slate', color: 'sage', designer: REHEARSAL_ADA }])
  for (const p of [bea, visitor]) {
    await p.page.reload()
    await expect(p.page.getByTestId('city-svg')).toBeVisible()
    await expect(onMap(p.page)).toHaveAttribute('data-exterior', 'sage')
  }
  expect((await db.query('SELECT activator_discord_user_id FROM world_properties WHERE id = $1', [placed.propertyId])).rows).toEqual([{ activator_discord_user_id: REHEARSAL_BEA }])
  for (const p of [ada, bea, visitor]) await p.context.close()
})
