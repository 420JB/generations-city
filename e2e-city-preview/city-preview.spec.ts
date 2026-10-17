import { expect, test, type Page } from '@playwright/test'

/**
 * The configurable city, drawn by Rare City's own renderer for two simulated brands:
 * Harborlight (4 districts) and Neon Orchard (6 districts).
 */
const HARBORLIGHT = ['lantern-quay', 'tidewater', 'saltmarsh', 'compass-row']
const NEON_ORCHARD = ['plum-arcade', 'citrus-strand', 'fig-terrace', 'pear-commons', 'kiwi-docks', 'cherry-row']

async function open(page: Page, brand = 0) {
  await page.goto('/')
  await expect(page.getByTestId('city-svg')).toBeVisible()
  if (brand) await page.getByTestId(`brand-${brand}`).click()
  await expect(page.getByTestId('preview-app')).toHaveAttribute('data-districts', brand ? '6' : '4')
}

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

test.describe('genuine district counts', () => {
  test('Harborlight renders exactly its 4 districts, with their names, accents and wedges', async ({ page }) => {
    await open(page)
    expect(await districtKeys(page)).toEqual(HARBORLIGHT)
    // Each district's ground, gate geometry and label come from the configuration, not nine renamed wedges.
    await expect(page.locator('[data-testid^="district-"].district-ground')).toHaveCount(4)
    await expect(page.getByTestId('district-label-tidewater')).toContainText('TIDEWATER')
    await expect(page.getByTestId('district-label-tidewater').locator('rect').first()).toHaveAttribute('stroke', '#2ec4b6')
    await expect(page.locator('[data-testid^="district-label-d"]')).toHaveCount(0)
    await expect(page.getByTestId('city-name')).toHaveText('HARBORLIGHT')
  })

  test('Neon Orchard renders exactly its 6 districts', async ({ page }) => {
    await open(page, 1)
    expect(await districtKeys(page)).toEqual(NEON_ORCHARD)
    await expect(page.locator('[data-testid^="district-"].district-ground')).toHaveCount(6)
    await expect(page.getByTestId('district-label-fig-terrace').locator('rect').first()).toHaveAttribute('stroke', '#ef476f')
    await expect(page.getByTestId('city-name')).toHaveText('NEON ORCHARD')
  })

  test('the standard renderer draws the standard art: original towers, City Hall, monuments, perimeter', async ({ page }) => {
    await open(page)
    expect(await page.locator('.bldg').count()).toBeGreaterThan(50)
    await expect(page.getByTestId('city-hall')).toHaveAttribute('aria-label', 'Beacon Hall. Capital: the Lantern Quay District')
    await expect(page.getByTestId('capital-ground')).toHaveAttribute('data-district', 'lantern-quay')
    await expect(page.locator('.perimeter, [data-testid="city-perimeter"]').first()).toBeAttached()
    await expect(page.locator('[data-testid^="pylon-"]')).toHaveCount(5)
    await expect(page.getByRole('application')).toHaveAttribute('aria-label', /^Harborlight map\./)
  })
})

test.describe('brand switching', () => {
  test('switching brands leaves nothing behind: districts, panel, selection and viewer all reset', async ({ page }) => {
    await open(page)
    await page.getByTestId('district-label-compass-row').click()
    await expect(page.getByTestId('district-panel')).toBeVisible()
    await page.getByTestId('viewer-select').selectOption({ index: 2 })
    await page.getByTestId('brand-1').click()
    await expect(page.getByTestId('district-panel')).toHaveCount(0)
    expect(await districtKeys(page)).toEqual(NEON_ORCHARD)
    await expect(page.locator('[data-testid^="district-label-compass-row"]')).toHaveCount(0)
    await expect(page.getByTestId('viewer-select')).toHaveValue('1')
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '0')
    await page.getByTestId('brand-0').click()
    expect(await districtKeys(page)).toEqual(HARBORLIGHT)
  })
})

test.describe('District Monument', () => {
  test('the T5 monument carries the holding district\'s NFT artwork on the standard plinth', async ({ page }) => {
    await open(page)
    const statue = page.getByTestId('monument-m5')
    await expect(statue).toHaveAttribute('data-district', 'lantern-quay')
    await expect(statue).toHaveAttribute('aria-label', 'The District Monument, showing Harbor Keepers #1004, held by the Lantern Quay District')
    await expect(statue.getByTestId('monument-artwork')).toHaveAttribute('href', '/brand-media/samples/harbor-keeper-1004.svg')
    // Same plinth, inscription and casting as every T5 monument.
    await expect(statue.locator('.statue[data-statue-kind="portrait"]')).toBeAttached()
    await expect(statue.locator('text', { hasText: 'LANTERN QUAY' })).toBeAttached()
  })

  test('each district shows its own monument: artwork, unavailable artwork and none fall back to the standard emblem', async ({ page }) => {
    await open(page, 1)
    await page.getByTestId('district-label-fig-terrace').click()
    await expect(page.getByTestId('district-monument')).toHaveAttribute('data-monument-kind', 'portrait')
    await expect(page.getByTestId('district-monument').getByTestId('monument-artwork')).toHaveAttribute('href', '/brand-media/samples/neon-seed-2003.svg')
    await expect(page.getByTestId('monument-nft')).toContainText('Neon Seeds')
    await page.getByTestId('dtab-kiwi-docks').click()
    await expect(page.getByTestId('district-monument')).toHaveAttribute('data-monument-kind', 'emblem')
    await expect(page.getByTestId('district-monument').getByTestId('monument-fallback')).toBeAttached()
    await expect(page.getByTestId('monument-note')).toContainText('Artwork unavailable')
    await page.getByTestId('dtab-citrus-strand').click()
    await expect(page.getByTestId('monument-note')).toContainText('No monument NFT configured')
  })

  test('no image on the page comes from anywhere but this origin or a local data: URL', async ({ page }) => {
    for (const brand of [0, 1]) {
      await open(page, brand)
      const hrefs = await page.locator('image').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''))
      for (const href of hrefs) expect(href.startsWith('/') || href.startsWith('data:'), href).toBe(true)
    }
  })
})

test.describe('district rule gates (simulated)', () => {
  test('a gated district can be explored but not claimed by a member who does not meet the rule', async ({ page }) => {
    await open(page)
    await page.getByTestId('district-label-compass-row').click()
    const access = page.getByTestId('district-access')
    await expect(access).toHaveAttribute('data-access', 'restricted')
    await expect(access).toContainText('Requires Verified Captain role')
    await expect(page.getByTestId('rule-ref')).toHaveAttribute('data-rule-id', '9001')
    await expect(page.getByTestId('rule-ref')).toHaveAttribute('data-rule-source', 'sample')
    await expect(page.getByTestId('choose-plot')).toBeDisabled()
    // Exploring stays open: its buildings can be inspected.
    await page.locator('[data-testid^="warp-"]').first().click()
    await expect(page.getByTestId('building-panel')).toBeVisible()
    await expect(page.getByTestId('build-access')).toHaveAttribute('data-access', 'restricted')
    await expect(page.getByTestId('build-action')).toBeDisabled()
  })

  test('a member who meets the rule may (pretend to) claim; ungated districts are open to all members', async ({ page }) => {
    await open(page)
    await page.getByTestId('viewer-select').selectOption({ index: 2 })
    await page.getByTestId('district-label-compass-row').click()
    await expect(page.getByTestId('district-access')).toHaveAttribute('data-access', 'eligible')
    await expect(page.getByTestId('choose-plot')).toBeEnabled()
    await page.getByTestId('dtab-tidewater').click()
    await expect(page.getByTestId('district-access')).toHaveAttribute('data-access', 'open')
    await expect(page.getByTestId('rule-ref')).toHaveCount(0)
  })

  test('an unknown rule answer fails closed, and a visitor can explore but never claim', async ({ page }) => {
    await open(page, 1)
    await page.getByTestId('district-label-cherry-row').click()
    await expect(page.getByTestId('district-access')).toHaveAttribute('data-access', 'restricted')
    await expect(page.getByTestId('district-access')).toContainText('has not been checked yet')
    await page.getByTestId('viewer-select').selectOption({ index: 3 })
    await expect(page.getByTestId('district-access')).toHaveAttribute('data-access', 'eligible')
    await page.getByTestId('viewer-select').selectOption({ index: 2 })
    await expect(page.getByTestId('district-access')).toHaveAttribute('data-access', 'restricted')
    await page.getByTestId('viewer-select').selectOption({ index: 0 })
    await expect(page.getByTestId('district-access')).toHaveAttribute('data-access', 'visitor')
    await expect(page.getByTestId('choose-plot')).toBeDisabled()
    await page.getByTestId('dtab-plum-arcade').click()
    await expect(page.getByTestId('choose-plot')).toBeDisabled()
  })

  test('re-enabling a disabled claim button in the page does not bypass the gate', async ({ page }) => {
    await open(page)
    await page.getByTestId('district-label-compass-row').click()
    await page.getByTestId('choose-plot').evaluate((b) => b.removeAttribute('disabled'))
    await page.getByTestId('choose-plot').click({ force: true })
    // React keeps the button disabled and no placement starts.
    await expect(page.getByTestId('plot-panel')).toHaveCount(0)
    await expect(page.getByTestId('placement-layer')).toHaveCount(0)
  })
})

test.describe('plots and properties', () => {
  test('choosing a plot offers the engine\'s free plots and the pick is a real, empty plot', async ({ page }) => {
    await open(page)
    await page.getByTestId('district-label-tidewater').click()
    const free = Number(await page.getByTestId('district-free-plots').textContent())
    await page.getByTestId('choose-plot').click()
    await expect(page.getByTestId('placement-layer')).toHaveAttribute('data-district', 'tidewater')
    await expect(page.locator('[data-testid^="candidate-plot-tidewater-"]')).toHaveCount(free)
    await still(page)
    const site = page.locator('[data-testid^="candidate-plot-tidewater-0-"]').nth(3)
    const id = (await site.getAttribute('data-testid'))!.replace('candidate-plot-', '')
    await site.click()
    const [, ward, plot] = /^tidewater-(\d+)-(\d+)$/.exec(id)!
    await expect(page.getByTestId('selected-plot')).toHaveAttribute('data-plot-id', `tidewater-w${ward}-p${plot}`)
    // The same plot is drawn as an OPEN PLOT on the ground, so no building stands on it.
    await expect(page.getByTestId(`open-plot-tidewater-${ward}-${plot}`)).toBeAttached()
    await page.getByTestId('claim-plot').click()
    await expect(page.getByTestId('preview-notice')).toContainText('Preview only: nothing was claimed')
  })

  test('a full Founding Ward opens Ward II: occupied wards and the next ward are real', async ({ page }) => {
    await open(page)
    await expect(page.locator('[data-testid="ward-saltmarsh-1"]')).toBeAttached()
    await expect(page.getByTestId('ghost-ward-saltmarsh')).toHaveAttribute('data-ward', '2')
    await expect(page.getByTestId('ghost-ward-tidewater')).toHaveAttribute('data-ward', '1')
  })

  test('selecting a building shows its NFT, tier, plot and permanent property id', async ({ page }) => {
    await open(page)
    await page.getByTestId('hud-crown').click()
    const panel = page.getByTestId('building-panel')
    await expect(panel).toBeVisible()
    await expect(panel.locator('h2')).toHaveText('Harbor Keepers #1000')
    await expect(page.getByTestId('panel-tier')).toContainText('6')
    await expect(page.getByTestId('building-address')).toContainText(/lantern-quay-w0-p\d+/)
    await expect(page.getByTestId('property-id')).toHaveText(/^[0-9a-f]{8}…$/)
    await expect(page.getByTestId('build-action')).toBeEnabled()
    await page.getByTestId('build-action').click()
    await expect(page.getByTestId('preview-notice')).toContainText('nothing was built or spent')
  })
})

test.describe('camera', () => {
  test('pan, zoom and rotation work as in Rare City', async ({ page }) => {
    await open(page, 1)
    await still(page)
    const city = page.getByTestId('city')
    const z0 = Number(await city.getAttribute('data-zoom'))
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await expect.poll(async () => Number(await city.getAttribute('data-zoom'))).toBeGreaterThan(z0 * 1.2)
    await page.keyboard.press('e')
    await expect(city).toHaveAttribute('data-rotation', '15')
    await page.getByTestId('rotate-left').click()
    await page.getByTestId('rotate-left').click()
    await expect(city).toHaveAttribute('data-rotation', '345')
    await still(page)
    const vb = await page.getByTestId('city-svg').getAttribute('viewBox')
    await page.mouse.move(700, 450)
    await page.mouse.down()
    await page.mouse.move(560, 380, { steps: 8 })
    await page.mouse.up()
    expect(await page.getByTestId('city-svg').getAttribute('viewBox')).not.toBe(vb)
    // Labels stay attached to their districts after rotating.
    expect(await districtKeys(page)).toEqual(NEON_ORCHARD)
  })

  test('up close the map still owns no compositor layers (the Chrome high-zoom fix holds)', async ({ page }) => {
    await open(page)
    for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Zoom in' }).click()
    await still(page)
    const cdp = await page.context().newCDPSession(page)
    let layers: { backendNodeId?: number; drawsContent: boolean }[] = []
    cdp.on('LayerTree.layerTreeDidChange', (e) => {
      if (e.layers) layers = e.layers
    })
    await cdp.send('DOM.enable')
    await cdp.send('LayerTree.enable')
    await expect.poll(() => layers.length).toBeGreaterThan(0)
    await page.waitForTimeout(300)
    let inside = 0
    for (const layer of layers) {
      if (!layer.drawsContent || !layer.backendNodeId) continue
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: layer.backendNodeId })
      const { result } = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function () { const el = this.nodeType === 1 ? this : this.parentElement; const svg = document.querySelector('[data-testid="city-svg"]'); return !!el && el !== svg && svg.contains(el) }`,
        returnByValue: true,
      })
      if (result.value) inside++
    }
    expect(inside).toBe(0)
    expect(await page.getByTestId('city-svg').evaluate((el) => getComputedStyle(el).willChange)).toBe('contents')
  })
})

/** On-screen scale of each name overlay: 1 is its drawn size at zoom 1. */
const overlayScales = (page: Page) =>
  page.evaluate(() => {
    const at = (el: Element | null) => (el ? +(el as SVGGraphicsElement).getScreenCTM()!.a.toFixed(3) : null)
    return {
      labels: [...document.querySelectorAll('[data-testid^="district-label-"]')].map(at),
      crest: at(document.querySelector('[data-testid="capital-crest"]')),
      sign: at(document.querySelector('.capital-sign')),
    }
  })

test.describe('district labels up close', () => {
  for (const brand of [0, 1]) {
    test(`brand ${brand}: labels, the Capital crest and the City Hall sign stop growing at high zoom`, async ({ page }) => {
      await open(page, brand)
      await still(page)
      const far = await overlayScales(page)
      // Ordinary zoom: labels stay at their usual, readable size.
      for (const s of far.labels) expect(s!).toBeGreaterThan(0.6)
      const city = page.getByTestId('city')
      while (Number(await city.getAttribute('data-zoom')) < 3.19) {
        await page.getByRole('button', { name: 'Zoom in' }).click()
        await still(page)
      }
      const near = await overlayScales(page)
      // Before the cap these reached 2.56x (labels), 1.92x (crest) and 3.2x (sign) on screen.
      for (const s of near.labels) expect(s!).toBeLessThanOrEqual(1.101)
      expect(near.crest!).toBeLessThanOrEqual(1.101)
      expect(near.sign!).toBeLessThanOrEqual(1.001)
      await expect(page.locator('[data-testid="capital-crest"]:not([data-compact])')).toHaveCount(1)
      // Still the same labels, still clickable.
      expect(await districtKeys(page)).toEqual(brand ? NEON_ORCHARD : HARBORLIGHT)
    })
  }

  test('the City Hall sign fits a brand\'s longer capital and district names between its crests', async ({ page }) => {
    for (const brand of [0, 1]) {
      await open(page, brand)
      const widths = await page.locator('.capital-sign text').evaluateAll((els) => els.slice(0, 2).map((t) => (t as SVGTextElement).getBBox().width))
      // The crests stand at x = ±176 with radius 21: text must stay within ±155.
      for (const w of widths) expect(w).toBeLessThanOrEqual(310)
    }
  })
})

test.describe('narrow window', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('the city and panels fit a phone without sideways scrolling', async ({ page }) => {
    await open(page, 1)
    expect(await districtKeys(page)).toEqual(NEON_ORCHARD)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    // The back district's label sits under the HUD on a phone (as in Rare City); the front one is clear.
    await page.getByTestId('district-label-pear-commons').click()
    await expect(page.getByTestId('district-panel')).toBeVisible()
    const box = (await page.getByTestId('drawer').boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
  })
})
