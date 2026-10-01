import { expect, test, type Page } from '@playwright/test'
import { makePng, openCity, selectBuilding, warpToOwnBuilding } from './helpers.ts'

const STEP = 15

interface SavedState {
  residentSeq: number
  wards: Record<string, number>
  buildings: Record<string, { districtId: string; ward: number; plot: number }>
}

/** The raw persisted game state (what a reload would restore). */
async function savedRaw(page: Page): Promise<string> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('generations-city:state'))!
    return localStorage.getItem(key)!
  })
}

async function saved(page: Page): Promise<SavedState> {
  return JSON.parse(await savedRaw(page))
}

const rotation = (page: Page) => page.getByTestId('city').getAttribute('data-rotation').then(Number)

/** Wait until the camera has stopped moving (viewBox and a rotated label hold still). */
async function still(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __sig?: string; __n?: number }
    w.__sig = undefined
    w.__n = 0
  })
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __sig?: string; __n?: number }
      const sig = `${document.querySelector('[data-testid="city-svg"]')!.getAttribute('viewBox')}|${document.querySelector('[data-testid="district-label-d1"]')!.getAttribute('transform')}`
      if (w.__sig === sig) w.__n = (w.__n ?? 0) + 1
      else {
        w.__sig = sig
        w.__n = 0
      }
      return (w.__n ?? 0) >= 4
    },
    undefined,
    { polling: 60 },
  )
}

/** Press a rotate control `steps` times (negative = left) and wait for the turn to settle. */
async function rotate(page: Page, steps: number) {
  const start = await rotation(page)
  const button = page.getByTestId(steps > 0 ? 'rotate-right' : 'rotate-left')
  for (let i = 0; i < Math.abs(steps); i++) await button.click()
  await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', String((((start + steps * STEP) % 360) + 360) % 360))
  await still(page)
}

async function centre(page: Page, testId: string) {
  const box = (await page.getByTestId(testId).first().boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Screen centre of a selected property's ground ring (its plot centre). */
async function ringCentre(page: Page, friendId: number) {
  const box = (await page.locator(`[data-testid="building-${friendId}"] .select-ring`).boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * A viewport point inside `selector`'s on-screen box that really hit-tests to that element
 * (nothing drawn above it, no HUD over it). Null when the element has no such point.
 */
async function hitPoint(page: Page, selector: string, inner = ''): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    ({ selector, inner }) => {
      const el = document.querySelector(selector)
      const target = inner ? el?.querySelector(inner) : el
      if (!el || !target) return null
      const r = target.getBoundingClientRect()
      for (const fy of [0.5, 0.35, 0.65, 0.2, 0.8])
        for (const fx of [0.5, 0.35, 0.65]) {
          const x = r.left + r.width * fx
          const y = r.top + r.height * fy
          if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue
          const hit = document.elementFromPoint(x, y)
          if (hit && hit.closest('svg') && hit.closest(selector) === el) return { x, y }
        }
      return null
    },
    { selector, inner },
  )
}

async function candidateIds(page: Page, district: string): Promise<{ ward: number; plot: number }[]> {
  const ids = await page.locator(`[data-testid^="candidate-plot-${district}-"]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!))
  return ids.map((id) => id.split('-').slice(-2).map(Number)).map(([ward, plot]) => ({ ward, plot })).sort((a, b) => a.ward - b.ward || a.plot - b.plot)
}

async function openCityFreely(page: Page) {
  await openCity(page)
  await page.getByTestId('guide-hide').click()
  await still(page)
}

test.describe('City rotation', () => {
  test('rotate controls turn the visible city about City Hall and return exactly', async ({ page }) => {
    await openCityFreely(page)
    const city = page.getByTestId('city')
    const svg = page.getByTestId('city-svg')
    await expect(city).toHaveAttribute('data-rotation', '0')
    // Discoverable, labelled controls in the existing Camera group (shortcuts documented).
    const camera = page.getByRole('group', { name: 'Camera' })
    await expect(camera.getByRole('button', { name: 'Rotate city left (Q)' })).toHaveAttribute('title', 'Rotate left (Q)')
    await expect(camera.getByRole('button', { name: 'Rotate city right (E)' })).toHaveAttribute('aria-keyshortcuts', 'E')
    await expect(camera.getByRole('button', { name: /Reset orientation/ })).toBeVisible()

    const view0 = await svg.getAttribute('viewBox')
    const ground0 = await centre(page, 'district-d4')
    const tower0 = await centre(page, 'building-812')
    const hall0 = await centre(page, 'city-hall')

    await rotate(page, 1)
    const ground15 = await centre(page, 'district-d4')
    const tower15 = await centre(page, 'building-812')
    // The world visibly turned: ground and buildings moved together...
    expect(Math.hypot(ground15.x - ground0.x, ground15.y - ground0.y)).toBeGreaterThan(20)
    expect(Math.hypot(tower15.x - tower0.x, tower15.y - tower0.y)).toBeGreaterThan(20)
    // ...about City Hall, which stays where it was; the overview framing is untouched.
    const hall15 = await centre(page, 'city-hall')
    expect(Math.abs(hall15.x - hall0.x)).toBeLessThan(0.5)
    expect(Math.abs(hall15.y - hall0.y)).toBeLessThan(0.5)
    expect(await svg.getAttribute('viewBox')).toBe(view0)

    await rotate(page, -1)
    const back = await centre(page, 'district-d4')
    expect(Math.abs(back.x - ground0.x)).toBeLessThan(0.5)
    expect(Math.abs(back.y - ground0.y)).toBeLessThan(0.5)
    expect(await svg.getAttribute('viewBox')).toBe(view0)

    // Left from 0° wraps to 345°, and a rapid full orbit lands exactly back on the start.
    await rotate(page, -1)
    await expect(city).toHaveAttribute('data-rotation', '345')
    await rotate(page, 1)
    await rotate(page, 24)
    await expect(city).toHaveAttribute('data-rotation', '0')
    const orbit = await centre(page, 'building-812')
    expect(Math.abs(orbit.x - tower0.x)).toBeLessThan(0.5)
    expect(Math.abs(orbit.y - tower0.y)).toBeLessThan(0.5)
    expect(await svg.getAttribute('viewBox')).toBe(view0)
    // Still ONE svg root with one camera viewBox: ground and objects never split.
    await expect(page.locator('[data-testid="city"] > svg')).toHaveCount(1)
  })

  test('map text stays upright and HUD text never rotates', async ({ page }) => {
    await openCityFreely(page)
    await rotate(page, 6)
    // Mid zoom shows every kind of map text (ward names appear past the overview).
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Zoom in' }).click()
      await still(page)
    }
    await expect(page.getByTestId('city')).not.toHaveAttribute('data-detail', 'far')
    const report = await page.evaluate(() => {
      // Net rotation of an element's screen matrix, in degrees (0 = upright).
      const tilt = (el: Element) => {
        const m = (el as SVGGraphicsElement).getScreenCTM()!
        return Math.abs((Math.atan2(m.b, m.a) * 180) / Math.PI)
      }
      const texts = [...document.querySelectorAll('[data-testid="city-svg"] text')]
      const upright = (sel: string) => [...document.querySelectorAll(sel)].map(tilt)
      return {
        total: texts.length,
        labels: upright('.district-label text, .bldg-label text, .capital-sign text, .capital-crest text, [id^="ml-"] text, .ghost-ward text, .open-plots text'),
        wardMarkers: upright('.ward-marker text'),
        hudTransforms: [...document.querySelectorAll('.hud, .zoom-controls, .radio-ticker')].map((e) => getComputedStyle(e).transform),
      }
    })
    expect(report.total).toBeGreaterThan(20)
    expect(report.labels.length).toBeGreaterThan(10)
    for (const t of report.labels) expect(t).toBeLessThan(0.01)
    // Ward names run along their boundary street but never read upside down.
    expect(report.wardMarkers.length).toBeGreaterThan(0)
    for (const t of report.wardMarkers) expect(t).toBeLessThanOrEqual(90.01)
    for (const t of report.hudTransforms) expect(t).toBe('none')
  })

  test('keyboard Q / E rotate, but never while typing in the Friend search', async ({ page }) => {
    await openCityFreely(page)
    const city = page.getByTestId('city')
    await page.keyboard.press('e')
    await expect(city).toHaveAttribute('data-rotation', '15')
    await page.keyboard.press('E')
    await expect(city).toHaveAttribute('data-rotation', '30')
    await page.keyboard.press('q')
    await expect(city).toHaveAttribute('data-rotation', '15')
    await page.getByTestId('friend-search').focus()
    await page.keyboard.press('e')
    await page.keyboard.press('q')
    await page.keyboard.press('q')
    await page.waitForTimeout(300)
    await expect(city).toHaveAttribute('data-rotation', '15')
    // Escape still closes panels and is not hijacked.
    await page.getByTestId('nav-board').click()
    await expect(page.getByTestId('build-board')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('build-board')).toHaveCount(0)
  })

  test('pan and zoom still work after rotating, and City Overview keeps the orientation', async ({ page }) => {
    await openCityFreely(page)
    const city = page.getByTestId('city')
    const svg = page.getByTestId('city-svg')
    await rotate(page, 3)
    const home = await svg.getAttribute('viewBox')
    const zoom0 = Number(await city.getAttribute('data-zoom'))

    // Wheel zoom about the cursor.
    await page.mouse.move(720, 480)
    await page.mouse.wheel(0, -400)
    await expect.poll(async () => Number(await city.getAttribute('data-zoom'))).toBeGreaterThan(zoom0)
    // Button zoom.
    const zoom1 = Number(await city.getAttribute('data-zoom'))
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await expect.poll(async () => Number(await city.getAttribute('data-zoom'))).toBeGreaterThan(zoom1)
    await still(page)
    // Drag pan moves the map with the pointer.
    const before = await centre(page, 'city-hall')
    await page.mouse.move(700, 500)
    await page.mouse.down()
    await page.mouse.move(580, 430, { steps: 6 })
    await page.mouse.up()
    const after = await centre(page, 'city-hall')
    expect(after.x - before.x).toBeCloseTo(-120, 0)
    expect(after.y - before.y).toBeCloseTo(-70, 0)
    await expect(city).toHaveAttribute('data-rotation', '45')

    // Overview reframes the whole city but does not reset the orientation.
    await page.getByRole('button', { name: 'City overview' }).click()
    await expect.poll(() => svg.getAttribute('viewBox')).toBe(home)
    await expect(city).toHaveAttribute('data-rotation', '45')
    for (let i = 1; i <= 9; i++) await expect(page.getByTestId(`district-label-d${i}`)).toBeInViewport()

    // Only the explicit reset-orientation control returns to the default view.
    await page.getByTestId('rotate-reset').click()
    await expect(city).toHaveAttribute('data-rotation', '0')
    await still(page)
    expect(await svg.getAttribute('viewBox')).toBe(home)
  })

  test('WARP frames its target at a non-zero angle without resetting the rotation', async ({ page }) => {
    await openCityFreely(page)
    const city = page.getByTestId('city')
    await rotate(page, 4)

    // Build Board → WARP
    await page.getByTestId('nav-board').click()
    await page.getByTestId('impact-0-warp').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '812')
    await expect(page.getByTestId('building-812')).toHaveAttribute('data-selected', 'true')
    await expect(city).toHaveAttribute('data-detail', 'near')
    await still(page)
    await expect(city).toHaveAttribute('data-rotation', '60')
    // Framed in the map area left of the drawer, exactly as at 0°.
    const ring = await ringCentre(page, 812)
    expect(ring.x).toBeGreaterThan(380)
    expect(ring.x).toBeLessThan(640)
    expect(ring.y).toBeGreaterThan(320)
    expect(ring.y).toBeLessThan(780)

    // With a property selected up close, rotating orbits around it: it holds its place.
    await rotate(page, 2)
    const ring2 = await ringCentre(page, 812)
    expect(Math.abs(ring2.x - ring.x)).toBeLessThan(1)
    expect(Math.abs(ring2.y - ring.y)).toBeLessThan(1)
    await expect(city).toHaveAttribute('data-rotation', '90')

    // Find a Friend → WARP, and Profile → WARP, at the same orientation.
    await page.getByTestId('friend-search').fill('288')
    await page.getByTestId('friend-search-go').click()
    await expect(page.getByTestId('building-288')).toHaveAttribute('data-selected', 'true')
    await still(page)
    await expect(page.locator('[data-testid="building-288"] .select-ring')).toBeInViewport()
    await warpToOwnBuilding(page)
    await still(page)
    await expect(page.locator('[data-testid="building-4471"] .select-ring')).toBeInViewport()
    await expect(city).toHaveAttribute('data-rotation', '90')
  })

  test('clicks select the building under the pointer at non-zero rotation', async ({ page }) => {
    await openCityFreely(page)
    await rotate(page, 7)
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await still(page)
    // Several buildings that are actually exposed on the map right now.
    const ids = await page.locator('[data-testid^="building-"][role="button"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!))
    let checked = 0
    for (const id of ids) {
      if (checked >= 4) break
      const p = await hitPoint(page, `[data-testid="${id}"]`)
      if (!p || p.x > 900 || p.y < 170 || p.y > 640) continue
      await page.mouse.click(p.x, p.y)
      await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', id.replace('building-', ''))
      await expect(page.getByTestId(id)).toHaveAttribute('data-selected', 'true')
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('building-panel')).toHaveCount(0)
      checked++
    }
    expect(checked).toBe(4)
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '105')
    // Empty ground deselects, as before.
    await selectBuilding(page, 4471)
    const ground = await hitPoint(page, '[data-testid="city-svg"]', '.plaza-rim')
    expect(ground).not.toBeNull()
  })

  test('billboards, district labels and monuments stay correct at non-zero rotation', async ({ page }) => {
    await openCityFreely(page)
    const monuments = () =>
      page.locator('[data-testid^="monument-m"]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-testid')}@${e.getAttribute('data-district')}`).sort())
    const pylons = () => page.locator('[data-testid^="pylon-"]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-testid')}@${e.getAttribute('data-holder')}`).sort())
    const monuments0 = await monuments()
    const pylons0 = await pylons()

    // Give the player's tower a billboard image.
    await warpToOwnBuilding(page)
    await page.getByTestId('open-architect').click()
    await page.getByTestId('tab-billboard').click()
    await page.getByTestId('buy-billboard').click()
    await page.getByTestId('confirm-fixture-billboard').click()
    await page.getByTestId('billboard-input').setInputFiles({ name: 'ad.png', mimeType: 'image/png', buffer: makePng(200, 100) })
    await page.getByTestId('billboard-save').click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('building-panel')).toHaveCount(0)

    await rotate(page, 6)
    // The billboard is clickable where it is drawn and opens its own property's media.
    await page.getByTestId('billboard-4471').click()
    const viewer = page.getByTestId('billboard-viewer')
    await expect(viewer).toBeVisible()
    await expect(viewer).toContainText('Demo Friend #4471')
    await page.getByTestId('billboard-viewer-close').click()
    await expect(viewer).toHaveCount(0)
    await expect(page.getByTestId('building-panel')).toHaveCount(0)

    // District labels open their own district; civic state is untouched by rotation.
    await page.getByRole('button', { name: 'City overview' }).click()
    await still(page)
    for (const d of ['d7', 'd2']) {
      await page.getByTestId(`district-label-${d}`).click()
      await expect(page.getByTestId('build-board')).toBeVisible()
      await expect(page.getByTestId(`dtab-${d}`)).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('Escape')
      await still(page)
    }
    await expect(page.getByTestId('hud-capital')).toHaveAttribute('data-capital', 'd3')
    await expect(page.getByTestId('capital-ground')).toHaveAttribute('data-district', 'd3')
    await expect(page.getByTestId('city-hall')).toHaveAttribute('data-capital', 'd3')
    expect(await monuments()).toEqual(monuments0)
    expect(await pylons()).toEqual(pylons0)
    // A monument stands on its holder's civic square: inside that district's ground wedge.
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await still(page)
    const inWedge = await page.evaluate(() => {
      const mon = document.querySelector('[data-testid^="monument-m"]')!
      const pad = mon.querySelector('.monument-pad')!.getBoundingClientRect()
      const wedge = document.querySelector(`[data-testid="district-${mon.getAttribute('data-district')}"]`)!.getBoundingClientRect()
      const hall = document.querySelector('[data-testid="city-hall"]')!.getBoundingClientRect()
      const mid = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
      const m = mid(pad)
      const w = mid(wedge)
      const h = mid(hall)
      // Same side of City Hall as its district.
      return (m.x - h.x) * (w.x - h.x) + (m.y - h.y) * (w.y - h.y) > 0
    })
    expect(inWedge).toBe(true)
  })

  test('rotation is camera state only: nothing is saved, and a reload starts at 0°', async ({ page }) => {
    await openCityFreely(page)
    const before = await savedRaw(page)
    const keys = await page.evaluate(() => Object.keys(localStorage).sort())
    await rotate(page, 5)
    await page.keyboard.press('q')
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '60')
    await page.getByTestId('rotate-reset').click()
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '0')
    await still(page)
    await rotate(page, 2)
    expect(await savedRaw(page)).toBe(before)
    expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual(keys)
    expect(before).not.toMatch(/rotation|angle/i)
    await page.reload()
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '0')
    expect(await savedRaw(page)).toBe(before)
  })

  test('Reset Demo restores the game but leaves the camera orientation and controls working', async ({ page }) => {
    await openCityFreely(page)
    const city = page.getByTestId('city')
    const seed = await saved(page)
    await rotate(page, 3)
    const home = await page.getByTestId('city-svg').getAttribute('viewBox')
    // Change the game: place a Friend at the rotated orientation.
    await page.getByTestId('nav-standings').click()
    await page.getByTestId('join-d5').click()
    const [first] = await candidateIds(page, 'd5')
    await page.getByTestId(`candidate-plot-d5-${first.ward}-${first.plot}`).click()
    await page.getByTestId('placement-confirm').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '20001')
    expect((await saved(page)).residentSeq).toBe(1)

    await page.getByTestId('reset-demo').click()
    await page.getByTestId('confirm-reset').click()
    await expect(page.getByTestId('building-20001')).toHaveCount(0)
    const now = await saved(page)
    expect(now.residentSeq).toBe(0)
    expect(now.wards).toEqual(seed.wards)
    expect(Object.keys(now.buildings).length).toBe(Object.keys(seed.buildings).length)
    // Rotation is camera state, not demo state: Reset Demo reframes but does not un-rotate.
    await expect(city).toHaveAttribute('data-rotation', '45')
    await page.getByTestId('guide-hide').click()
    await expect.poll(() => page.getByTestId('city-svg').getAttribute('viewBox')).toBe(home)
    // Camera and selection still work normally afterwards.
    await rotate(page, -3)
    await expect(city).toHaveAttribute('data-rotation', '0')
    await selectBuilding(page, 4471)
    await expect(page.getByTestId('wallet')).toHaveText('25,000')
  })

  test('reduced motion: rotation applies at once, without animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    const city = page.getByTestId('city')
    const hall0 = await centre(page, 'city-hall')
    await page.getByTestId('rotate-right').click()
    await page.getByTestId('rotate-right').click()
    await expect(city).toHaveAttribute('data-rotation', '30')
    const hall = await centre(page, 'city-hall')
    expect(Math.abs(hall.x - hall0.x)).toBeLessThan(0.5)
    await page.getByTestId('rotate-reset').click()
    await expect(city).toHaveAttribute('data-rotation', '0')
  })
})

test.describe('Choose a plot while the city is rotated', () => {
  test('sites sit on their plots, and a click places the Friend on exactly that plot', async ({ page }) => {
    await openCityFreely(page)
    const city = page.getByTestId('city')
    await rotate(page, 5)
    await page.getByTestId('nav-standings').click()
    await expect(page.getByTestId('city-growth')).toContainText('Simulate Real City Growth')
    await page.getByTestId('join-d5').click()
    await expect(page.getByTestId('placement-bar')).toBeVisible()
    await still(page)
    await expect(city).toHaveAttribute('data-rotation', '75')
    const sites = await candidateIds(page, 'd5')
    expect(sites.length).toBeGreaterThanOrEqual(2)

    // Every site is drawn exactly over the open plot it stands for (same rotated ground spot).
    for (const s of sites) {
      const site = (await page.locator(`[data-testid="candidate-plot-d5-${s.ward}-${s.plot}"] .candidate-fill`).boundingBox())!
      const plot = (await page.locator(`[data-testid="open-plot-d5-${s.ward}-${s.plot}"] polygon`).boundingBox())!
      expect(Math.abs(site.x + site.width / 2 - (plot.x + plot.width / 2))).toBeLessThan(1)
      expect(Math.abs(site.y + site.height / 2 - (plot.y + plot.height / 2))).toBeLessThan(1)
      await expect(page.getByTestId(`candidate-plot-d5-${s.ward}-${s.plot}`)).toBeInViewport()
    }

    // Each site's own centre hit-tests to that site: pick the last one with a real mouse click.
    for (const s of sites) expect(await hitPoint(page, `[data-testid="candidate-plot-d5-${s.ward}-${s.plot}"]`, '.candidate-fill'), `site ${s.ward}/${s.plot}`).not.toBeNull()
    const pick = sites[sites.length - 1]
    expect(pick).not.toEqual(sites[0])
    const p = (await hitPoint(page, `[data-testid="candidate-plot-d5-${pick.ward}-${pick.plot}"]`, '.candidate-fill'))!
    await page.mouse.click(p.x, p.y)
    await expect(page.getByTestId('placement-selected')).toHaveAttribute('data-plot', String(pick.plot))
    await expect(page.getByTestId('placement-selected')).toHaveAttribute('data-ward', String(pick.ward))
    await expect(page.getByTestId('placement-selected')).toContainText(`d5-w${pick.ward}-p${pick.plot}`)
    await expect(page.getByTestId(`candidate-plot-d5-${pick.ward}-${pick.plot}`)).toHaveAttribute('data-selected', 'true')
    // Selecting is a preview: nothing is saved yet.
    expect((await saved(page)).residentSeq).toBe(0)

    await page.getByTestId('placement-confirm').click()
    await expect(page.getByTestId('placement-layer')).toHaveCount(0)
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '20001')
    await expect(page.getByTestId('building-address')).toContainText(`Plot ${pick.plot + 1}`)
    const s = await saved(page)
    expect(s.buildings['b-20001']).toMatchObject({ districtId: 'd5', ward: pick.ward, plot: pick.plot })
    expect(s.residentSeq).toBe(1)
    // The WARP that follows frames the new property at the same orientation.
    await expect(page.getByTestId('building-20001')).toHaveAttribute('data-selected', 'true')
    await expect(city).toHaveAttribute('data-detail', 'near')
    await still(page)
    await expect(city).toHaveAttribute('data-rotation', '75')
    await expect(page.locator('[data-testid="building-20001"] .select-ring')).toBeInViewport()
    const ring = await ringCentre(page, 20001)
    expect(ring.x).toBeGreaterThan(380)
    expect(ring.x).toBeLessThan(640)
  })

  test('Cancel, Escape and preview stay non-mutating; keyboard selection picks the focused site', async ({ page }) => {
    await openCityFreely(page)
    await rotate(page, -4)
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '300')
    const before = await savedRaw(page)
    for (const exit of ['cancel', 'escape'] as const) {
      await page.getByTestId('nav-standings').click()
      await expect(page.getByTestId('standings')).toBeVisible()
      await page.getByTestId('join-d7').click()
      await still(page)
      const sites = await candidateIds(page, 'd7')
      const site = sites[sites.length - 1]
      // Keyboard: focus a site and press Enter / Space.
      await page.getByTestId(`candidate-plot-d7-${site.ward}-${site.plot}`).focus()
      await page.keyboard.press(exit === 'cancel' ? 'Enter' : 'Space')
      await expect(page.getByTestId('placement-selected')).toHaveAttribute('data-plot', String(site.plot))
      // Rotating mid-placement is still only a camera move: the selection is kept.
      await rotate(page, 1)
      await expect(page.getByTestId('placement-selected')).toHaveAttribute('data-plot', String(site.plot))
      await rotate(page, -1)
      if (exit === 'cancel') await page.getByTestId('placement-cancel').click()
      else await page.keyboard.press('Escape')
      await expect(page.getByTestId('placement-bar')).toHaveCount(0)
      await expect(page.getByTestId('standings')).toBeVisible()
      await expect(page.getByTestId('building-20001')).toHaveCount(0)
      expect(await savedRaw(page)).toBe(before)
      await page.getByTestId('standings').getByRole('button', { name: 'Close panel' }).click()
    }
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '300')
  })

  test('a full district previews its next Ward in the rotated position and opens it on placement', async ({ page }) => {
    await openCityFreely(page)
    await rotate(page, 6)
    await page.getByTestId('nav-standings').click()
    await page.getByTestId('join-d4').click()
    await still(page)
    const sites = await candidateIds(page, 'd4')
    expect(sites.length).toBe(33)
    expect(sites.every((s) => s.ward === 1)).toBe(true)
    // The NEW WARD marker is readable, upright and on screen, just above the previewed sites.
    const marker = page.getByTestId('placement-new-ward')
    await expect(marker).toContainText('WARD II OPENS WITH THIS FRIEND')
    await expect(marker).toBeInViewport()
    const box = (await marker.boundingBox())!
    expect(box.height).toBeGreaterThanOrEqual(8)
    expect(box.width).toBeGreaterThan(box.height * 8)
    const tops = await page.locator('[data-testid^="candidate-plot-d4-"] .candidate-fill').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top))
    expect(box.y + box.height).toBeLessThanOrEqual(Math.min(...tops) + 1)
    // Preview only.
    expect((await saved(page)).wards.d4).toBe(1)
    await expect(page.getByTestId('ward-d4-1')).toHaveCount(0)

    // Sites match the ghost ward's plots at this rotation; all on-map sites hit-test to themselves.
    const stolen = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="candidate-plot-"] .candidate-fill')]
        .map((el) => {
          const r = el.getBoundingClientRect()
          const x = r.left + r.width / 2
          const y = r.top + r.height / 2
          const id = el.closest('[data-testid^="candidate-plot-"]')!.getAttribute('data-testid')
          if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null
          const hit = document.elementFromPoint(x, y)
          if (!hit || !hit.closest('svg')) return null
          return hit.closest('[data-testid^="candidate-plot-"]')?.getAttribute('data-testid') === id ? 'ok' : id
        })
        .filter((s) => s !== null),
    )
    expect(stolen.length).toBeGreaterThan(20)
    expect(stolen.filter((s) => s !== 'ok')).toEqual([])

    const p = (await hitPoint(page, '[data-testid="candidate-plot-d4-1-10"]', '.candidate-fill'))!
    await page.mouse.click(p.x, p.y)
    await expect(page.getByTestId('placement-selected')).toContainText('NEW WARD')
    await expect(page.getByTestId('placement-selected')).toHaveAttribute('data-plot', '10')
    await page.getByTestId('placement-confirm').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '20001')
    await expect(page.getByTestId('ward-d4-1')).toBeAttached()
    const s = await saved(page)
    expect(s.wards.d4).toBe(2)
    expect(s.buildings['b-20001']).toMatchObject({ districtId: 'd4', ward: 1, plot: 10 })
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '90')
  })
})

test.describe('City rotation on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  const boxOf = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!
  const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

  test('rotate controls fit beside the Demo Guide, are tappable and never cause page scroll', async ({ page }) => {
    await openCity(page)
    const city = page.getByTestId('city')
    const guide = await boxOf(page, 'demo-guide')
    for (const id of ['rotate-left', 'rotate-right', 'rotate-reset']) {
      const b = await boxOf(page, id)
      expect(b.width).toBeGreaterThanOrEqual(44)
      expect(b.height).toBeGreaterThanOrEqual(44)
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(390)
      expect(b.y + b.height).toBeLessThanOrEqual(844)
      expect(overlap(b, guide), `${id} overlaps the Demo Guide`).toBe(false)
    }
    await page.getByTestId('rotate-right').tap()
    await expect(city).toHaveAttribute('data-rotation', '15')
    await page.getByTestId('guide-hide').click()
    // The compact guide reminder does not cover them either.
    const reminder = await boxOf(page, 'guide-reminder')
    for (const id of ['rotate-left', 'rotate-right', 'rotate-reset']) expect(overlap(await boxOf(page, id), reminder)).toBe(false)
    await page.getByTestId('rotate-right').tap()
    await page.getByTestId('rotate-left').tap()
    await page.getByTestId('rotate-right').tap()
    await expect(city).toHaveAttribute('data-rotation', '30')
    await still(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    // The rotated city still pans, zooms and overview-frames.
    const svg = page.getByTestId('city-svg')
    const home = await svg.getAttribute('viewBox')
    await page.mouse.move(195, 420)
    await page.mouse.down()
    await page.mouse.move(120, 470, { steps: 5 })
    await page.mouse.up()
    expect(await svg.getAttribute('viewBox')).not.toBe(home)
    const z = Number(await city.getAttribute('data-zoom'))
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await expect.poll(async () => Number(await city.getAttribute('data-zoom'))).toBeGreaterThan(z)
    await page.getByRole('button', { name: 'City overview' }).click()
    await expect.poll(() => svg.getAttribute('viewBox')).toBe(home)
    await expect(page.getByTestId('city-hall')).toBeInViewport()
    await expect(city).toHaveAttribute('data-rotation', '30')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('with a property sheet open, rotation stays reachable above the sheet and orbits the selection', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    await page.getByTestId('rotate-right').tap()
    await page.getByTestId('nav-board').click()
    await page.getByTestId('impact-0-warp').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '812')
    await still(page)
    const drawer = await boxOf(page, 'drawer')
    for (const id of ['rotate-left', 'rotate-right', 'rotate-reset']) {
      const b = await boxOf(page, id)
      expect(overlap(b, drawer), `${id} overlaps the sheet`).toBe(false)
      expect(b.x + b.width).toBeLessThanOrEqual(390)
      expect(b.y).toBeGreaterThan(120)
    }
    const ring = await ringCentre(page, 812)
    await page.getByTestId('rotate-right').tap()
    await page.getByTestId('rotate-right').tap()
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '45')
    await still(page)
    const ring2 = await ringCentre(page, 812)
    expect(Math.abs(ring2.x - ring.x)).toBeLessThan(1)
    expect(Math.abs(ring2.y - ring.y)).toBeLessThan(1)
    await expect(page.getByTestId('building-812')).toHaveAttribute('data-selected', 'true')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('plot placement stays exact on a rotated phone map', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    for (let i = 0; i < 3; i++) await page.getByTestId('rotate-left').tap()
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '315')
    await page.getByTestId('nav-standings').click()
    await page.getByTestId('join-d4').click()
    await still(page)
    const marker = page.getByTestId('placement-new-ward')
    await expect(marker).toContainText('NEW WARD · WARD II')
    const box = (await marker.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const p = await hitPoint(page, '[data-testid="candidate-plot-d4-1-10"]', '.candidate-fill')
    expect(p).not.toBeNull()
    await page.touchscreen.tap(p!.x, p!.y)
    await expect(page.getByTestId('placement-selected')).toHaveAttribute('data-plot', '10')
    await expect(page.getByTestId('placement-selected')).toHaveAttribute('data-ward', '1')
    await expect(page.getByTestId('placement-confirm')).toBeVisible()
    await page.getByTestId('placement-confirm').tap()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '20001')
    expect((await saved(page)).buildings['b-20001']).toMatchObject({ districtId: 'd4', ward: 1, plot: 10 })
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '315')
  })
})
