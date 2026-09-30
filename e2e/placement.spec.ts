import { expect, test, type Page } from '@playwright/test'
import { openCity, selectBuilding } from './helpers.ts'

interface SavedState {
  residentSeq: number
  wards: Record<string, number>
  buildings: Record<string, { districtId: string; ward: number; plot: number }>
}

/** The persisted game state (what a reload would restore). */
async function saved(page: Page): Promise<SavedState> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('generations-city:state'))!
    return JSON.parse(localStorage.getItem(key)!)
  })
}

async function candidateIds(page: Page, district: string): Promise<{ ward: number; plot: number }[]> {
  const ids = await page.locator(`[data-testid^="candidate-plot-${district}-"]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!))
  return ids.map((id) => id.split('-').slice(-2).map(Number)).map(([ward, plot]) => ({ ward, plot })).sort((a, b) => a.ward - b.ward || a.plot - b.plot)
}

test.describe('Choose a plot: explicit Friend placement', () => {
  test('judge flow: pick a non-first plot and the Friend lands exactly there', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    await page.getByTestId('nav-standings').click()
    await expect(page.getByTestId('city-growth')).toContainText('Simulate Real City Growth')
    await page.getByTestId('join-d5').click()
    await expect(page.getByTestId('placement-bar')).toBeVisible()
    await expect(page.getByTestId('standings')).toHaveCount(0)
    const sites = await candidateIds(page, 'd5')
    expect(sites.length).toBeGreaterThanOrEqual(2)
    // The auto-allocator would take the first free plot; choose a different one.
    const pick = sites[sites.length - 1]
    expect(pick).not.toEqual(sites[0])
    await page.getByTestId(`candidate-plot-d5-${pick.ward}-${pick.plot}`).click()
    await expect(page.getByTestId('placement-selected')).toHaveAttribute('data-plot', String(pick.plot))
    await expect(page.getByTestId('placement-selected')).toContainText(`d5-w${pick.ward}-p${pick.plot}`)
    expect((await saved(page)).residentSeq).toBe(0)
    await page.getByTestId('placement-confirm').click()

    await expect(page.getByTestId('placement-bar')).toHaveCount(0)
    await expect(page.getByTestId('placement-layer')).toHaveCount(0)
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '20001')
    await expect(page.getByTestId('building-20001')).toHaveAttribute('data-selected', 'true')
    await expect(page.getByTestId('city')).toHaveAttribute('data-detail', 'near')
    await expect(page.getByTestId('building-address')).toContainText(`Plot ${pick.plot + 1}`)
    const s = await saved(page)
    expect(s.buildings['b-20001']).toMatchObject({ districtId: 'd5', ward: pick.ward, plot: pick.plot })
    expect(s.residentSeq).toBe(1)
  })

  test('Cancel and Escape leave the city unchanged and return to Districts', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    const before = await saved(page)
    for (const exit of ['cancel', 'escape'] as const) {
      await page.getByTestId('nav-standings').click()
      await expect(page.getByTestId('standings')).toBeVisible()
      await page.getByTestId('join-d7').click()
      const [first] = await candidateIds(page, 'd7')
      await page.getByTestId(`candidate-plot-d7-${first.ward}-${first.plot}`).click()
      await expect(page.getByTestId('placement-selected')).toBeVisible()
      if (exit === 'cancel') await page.getByTestId('placement-cancel').click()
      else await page.keyboard.press('Escape')
      await expect(page.getByTestId('placement-bar')).toHaveCount(0)
      await expect(page.getByTestId('standings')).toBeVisible()
      await expect(page.getByTestId('building-20001')).toHaveCount(0)
      const now = await saved(page)
      expect(now.residentSeq).toBe(before.residentSeq)
      expect(now.wards).toEqual(before.wards)
      expect(Object.keys(now.buildings).length).toBe(Object.keys(before.buildings).length)
      await page.getByTestId('standings').getByRole('button', { name: 'Close panel' }).click()
    }
  })

  test('only this district’s free plots are selectable; buildings and other districts are inert', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    await page.getByTestId('nav-standings').click()
    await page.getByTestId('join-d5').click()
    await expect(page.locator('[data-testid^="candidate-plot-"]').first()).toBeAttached()
    await expect(page.locator('[data-testid^="candidate-plot-"]:not([data-testid^="candidate-plot-d5-"])')).toHaveCount(0)
    // Another district's open plot is just ground: clicking it selects nothing.
    const other = page.locator('[data-testid^="open-plot-d1-"]').first()
    const box = await other.boundingBox()
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(page.getByTestId('placement-selected')).toHaveCount(0)
    // An existing building cannot be selected while placing.
    await page.getByTestId('building-4471').dispatchEvent('click')
    await expect(page.getByTestId('building-panel')).toHaveCount(0)
    // Keyboard: focus a site and press Enter.
    const [first] = await candidateIds(page, 'd5')
    await page.getByTestId(`candidate-plot-d5-${first.ward}-${first.plot}`).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('placement-selected')).toHaveAttribute('data-plot', String(first.plot))
  })

  test('a full district previews its next Ward and opens it only when the Friend is placed', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    await page.getByTestId('nav-standings').click()
    await page.getByTestId('join-d4').click()
    const sites = await candidateIds(page, 'd4')
    expect(sites.length).toBe(33)
    expect(sites.every((s) => s.ward === 1)).toBe(true)
    await expect(page.locator('[data-testid^="candidate-plot-d4-"][data-new-ward="true"]')).toHaveCount(33)
    await expect(page.getByTestId('placement-new-ward')).toContainText('WARD II OPENS WITH THIS FRIEND')
    await expect(page.getByTestId('placement-count')).toContainText('new Ward II')
    // Preview only: not in the saved city.
    await expect(page.getByTestId('ward-d4-1')).toHaveCount(0)
    expect((await saved(page)).wards.d4).toBe(1)

    await page.getByTestId('candidate-plot-d4-1-10').click()
    await expect(page.getByTestId('placement-selected')).toContainText('NEW WARD')
    await page.getByTestId('placement-confirm').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '20001')
    await expect(page.getByTestId('ward-d4-1')).toBeAttached()
    await expect(page.getByTestId('ghost-ward-d4')).toHaveAttribute('data-ward', '2')
    await expect(page.getByTestId('announcements')).toContainText('THE CITY GROWS')
    const s = await saved(page)
    expect(s.wards.d4).toBe(2)
    expect(s.buildings['b-20001']).toMatchObject({ districtId: 'd4', ward: 1, plot: 10 })
    for (const d of ['d1', 'd2', 'd3', 'd5', 'd6', 'd7', 'd8', 'd9']) expect(s.wards[d]).toBe(1)
  })

  test('Reset Demo during placement exits placement and drops the stale selection', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    // Grow the city first so the reset has something to undo.
    await page.getByTestId('nav-standings').click()
    await page.getByTestId('join-d5').click()
    const [first] = await candidateIds(page, 'd5')
    await page.getByTestId(`candidate-plot-d5-${first.ward}-${first.plot}`).click()
    await page.getByTestId('placement-confirm').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '20001')

    // Enter placement again and select a next-Ward plot, then reset mid-placement.
    await page.getByTestId('nav-standings').click()
    await page.getByTestId('join-d4').click()
    await page.getByTestId('candidate-plot-d4-1-10').click()
    await expect(page.getByTestId('placement-selected')).toContainText('NEW WARD')
    await page.getByTestId('reset-demo').click()
    await page.getByTestId('confirm-reset').click()

    await expect(page.getByTestId('placement-bar')).toHaveCount(0)
    await expect(page.getByTestId('placement-layer')).toHaveCount(0)
    await expect(page.getByTestId('placement-confirm')).toHaveCount(0)
    await expect(page.getByTestId('building-20001')).toHaveCount(0)
    const s = await saved(page)
    expect(s.residentSeq).toBe(0)
    expect(s.wards.d4).toBe(1)
    expect(s.buildings['b-20001']).toBeUndefined()

    // Ordinary city interaction is back: buildings select normally.
    await selectBuilding(page, 4471)
    // A fresh placement starts from the seeded city with nothing pre-selected.
    await page.getByTestId('nav-standings').click()
    await page.getByTestId('join-d4').click()
    await expect(page.getByTestId('placement-selected')).toHaveCount(0)
    await expect(page.getByTestId('placement-count')).toHaveAttribute('data-count', '33')
  })

  test('Demo Guide “Watch the city grow” opens City Growth', async ({ page }) => {
    await openCity(page)
    await expect(page.getByTestId('guide-grow')).toContainText('WATCH THE CITY GROW')
    await page.getByTestId('guide-grow-open').click()
    await expect(page.getByTestId('standings')).toBeVisible()
    await expect(page.getByTestId('city-growth')).toBeInViewport()
  })

  test('every candidate stays reachable: towers and labels never cover a site', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    await page.getByTestId('nav-standings').click()
    await page.getByTestId('join-d4').click()
    await page.waitForTimeout(1200) // camera framing settles
    // Placement sites are drawn after (above) city objects and labels while placing.
    const order = await page.evaluate(() => {
      const svg = document.querySelector('[data-testid="city-svg"]')!
      const kids = [...svg.children]
      const at = (sel: string) => kids.findIndex((k) => k.matches(sel))
      return { objects: at('.objects'), labels: at('.district-labels'), placement: at('.placement-layer') }
    })
    expect(order.placement).toBeGreaterThan(order.objects)
    expect(order.placement).toBeGreaterThan(order.labels)
    // Each on-screen site's own centre hit-tests to that site (unless an HTML panel covers it).
    const results = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="candidate-plot-"] .candidate-fill')].map((el) => {
        const r = el.getBoundingClientRect()
        const x = r.left + r.width / 2
        const y = r.top + r.height / 2
        const id = el.closest('[data-testid^="candidate-plot-"]')!.getAttribute('data-testid')
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { id, state: 'offscreen' }
        const hit = document.elementFromPoint(x, y)
        if (!hit || !hit.closest('svg')) return { id, state: 'html-overlay' }
        return { id, state: hit.closest('[data-testid^="candidate-plot-"]')?.getAttribute('data-testid') === id ? 'ok' : `stolen:${hit.tagName}.${hit.getAttribute('class')}` }
      }),
    )
    const onMap = results.filter((r) => r.state !== 'offscreen' && r.state !== 'html-overlay')
    expect(onMap.length).toBeGreaterThan(20)
    expect(onMap.filter((r) => r.state !== 'ok')).toEqual([])
  })
})

test.describe('Choose a plot on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the new-Ward marker stays inside the phone viewport without horizontal overflow', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    await page.getByTestId('nav-standings').click()
    await page.getByTestId('join-d4').click()
    await page.waitForTimeout(1200) // camera framing settles
    const marker = page.getByTestId('placement-new-ward')
    await expect(marker).toBeVisible()
    await expect(marker).toContainText('NEW WARD · WARD II')
    const box = (await marker.boundingBox())!
    const width = page.viewportSize()!.width
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    expect(box.height).toBeGreaterThanOrEqual(8) // readable, not shrunk to fit
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('a tap just outside a site’s drawn lot still selects that site', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    await page.getByTestId('nav-standings').click()
    await page.getByTestId('join-d4').click()
    await page.waitForTimeout(1200)
    const target = 'd4-1-10'
    // Find a point beside the visible diamond that belongs to this site's forgiving hit area.
    const point = await page.evaluate((t) => {
      const fill = document.querySelector(`[data-testid="candidate-plot-${t}"] .candidate-fill`)!.getBoundingClientRect()
      const cx = fill.left + fill.width / 2
      const cy = fill.top + fill.height / 2
      const tries = [
        [fill.right + 4, cy],
        [fill.left - 4, cy],
        [cx, fill.top - 3],
        [cx, fill.bottom + 3],
      ]
      for (const [x, y] of tries) {
        const hit = document.elementFromPoint(x, y)
        if (hit?.getAttribute('data-testid') === `candidate-hit-${t}`) return { x, y }
      }
      return null
    }, target)
    expect(point).not.toBeNull()
    await page.touchscreen.tap(point!.x, point!.y)
    await expect(page.getByTestId('placement-selected')).toHaveAttribute('data-plot', '10')
    await expect(page.getByTestId('placement-selected')).toHaveAttribute('data-ward', '1')
  })
})
