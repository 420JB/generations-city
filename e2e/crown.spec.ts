import { expect, test, type Locator, type Page } from '@playwright/test'
import { makePng, openCity, warpToOwnBuilding } from './helpers.ts'

const PLAYER = 4471

/**
 * Make the demo player's tower the City Crown holder WITH a rooftop billboard, entirely
 * through the UI (faucet, billboard fixture + image, one simulated contribution).
 * `contribution` 170,000 reaches Tier 5 (skyline billboard); 237,000 reaches Tier 6 (landmark).
 */
async function crownThePlayerTower(page: Page, contribution: number) {
  const faucet = page.getByRole('button', { name: 'Claim simulated demo RF' })
  for (let i = 0; i < Math.ceil((contribution + 2_000 - 25_000) / 10_000); i++) await faucet.click()
  await warpToOwnBuilding(page)
  await page.getByTestId('open-architect').click()
  await page.getByTestId('tab-billboard').click()
  await page.getByTestId('buy-billboard').click()
  await page.getByTestId('confirm-fixture-billboard').click()
  await page.getByTestId('billboard-input').setInputFiles({ name: 'ad.png', mimeType: 'image/png', buffer: makePng(200, 100) })
  await page.getByTestId('billboard-save').click()
  await page.keyboard.press('Escape')
  await warpToOwnBuilding(page)
  await page.locator('#custom-amt').fill(String(contribution))
  await page.getByRole('button', { name: 'Set', exact: true }).click()
  await expect(page.getByTestId('confirm-box')).toContainText('Takes the City Crown')
  await page.getByTestId('confirm-contribution').click()
  await expect(page.getByTestId('hud-crown')).toHaveAttribute('data-crown', String(PLAYER))
  const tier = contribution >= 237_000 ? 6 : 5
  await expect(page.getByTestId(`building-${PLAYER}`)).toHaveAttribute('data-tier', String(tier))
  await expect(page.getByTestId(`billboard-${PLAYER}`)).toHaveAttribute('data-media', tier === 6 ? 'landmark' : 'skyline')
  // Clear the achievement toasts (they sit over the map) and close the panel; the
  // construction tween (growing tower, rising Crown) has finished once the Crown rests.
  await page.locator('.badge-toasts .dismiss').click()
  await expect(page.locator('.badge-toasts')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('building-panel')).toHaveCount(0)
  await atRest(page.getByTestId('crown-spire').locator('path'))
}

/** Wait until an on-map element stops moving (camera flights and build tweens are done). */
async function atRest(target: Locator) {
  let last = ''
  let same = 0
  await expect
    .poll(
      async () => {
        const b = await target.boundingBox()
        const sig = b ? `${b.x.toFixed(1)},${b.y.toFixed(1)},${b.width.toFixed(1)},${b.height.toFixed(1)}` : ''
        same = sig === last ? same + 1 : 0
        last = sig
        return same
      },
      { intervals: [120], timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(3)
}

/** Drag the map until `target`'s centre is at a free spot of the viewport. */
async function panIntoView(page: Page, target: Locator, to: { x: number; y: number }, grab: { x: number; y: number }) {
  for (let i = 0; i < 8; i++) {
    const b = (await target.boundingBox())!
    const dx = to.x - (b.x + b.width / 2)
    const dy = to.y - (b.y + b.height / 2)
    if (Math.hypot(dx, dy) < 10) break
    const clamp = (v: number) => Math.max(-240, Math.min(240, v))
    await page.mouse.move(grab.x, grab.y)
    await page.mouse.down()
    await page.mouse.move(grab.x + clamp(dx), grab.y + clamp(dy), { steps: 5 })
    await page.mouse.up()
  }
  await atRest(target)
}

interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/** Screen geometry of the Crown and the billboard of one building, plus hit-testing of the media. */
async function measure(page: Page, friendId: number) {
  return page.evaluate((id) => {
    const building = document.querySelector(`[data-testid="building-${id}"]`)!
    const crown = building.querySelector('[data-testid="crown-spire"]')!
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
    }
    const lot = box(building.querySelector(':scope > polygon')!)
    const out = {
      body: box(crown.querySelector('path')!),
      mast: box(crown.querySelector('[data-crown-mast]')!),
      beam: box(crown.querySelector('rect')!),
      axisX: (lot.left + lot.right) / 2,
      crownPointerEvents: getComputedStyle(crown).pointerEvents,
      glowPointerEvents: getComputedStyle(building.querySelector('.crown-glow')!).pointerEvents,
      billboard: null as Box | null,
      /** Screen y of the media's top edge under the Crown's mast and under both beam edges. */
      mediaTopUnderMast: 0,
      mediaTopUnderBeam: 0,
      glowBeneathMedia: false,
      /** Media sample points whose topmost element is NOT this billboard (should be none). */
      stolen: [] as string[],
      samples: 0,
      /** A media point right under the Crown: top-centre of the image. */
      nearCrown: { x: 0, y: 0 },
    }
    const billboard = building.querySelector(`[data-testid="billboard-${id}"]`)
    const image = billboard?.querySelector('[data-billboard-image]') as SVGImageElement | null
    if (!billboard || !image) return out
    out.billboard = box(billboard)
    const m = image.getScreenCTM()!
    const x = image.x.baseVal.value
    const y = image.y.baseVal.value
    const w = image.width.baseVal.value
    const h = image.height.baseVal.value
    const at = (u: number, v: number) => ({ x: m.a * (x + u * w) + m.c * (y + v * h) + m.e, y: m.b * (x + u * w) + m.d * (y + v * h) + m.f })
    const tl = at(0, 0)
    const tr = at(1, 0)
    const topAt = (sx: number) => tl.y + ((tr.y - tl.y) * (sx - tl.x)) / (tr.x - tl.x)
    out.mediaTopUnderMast = Math.min(topAt(out.mast.left), topAt(out.mast.right))
    out.mediaTopUnderBeam = Math.min(topAt(out.beam.left), topAt(out.beam.right))
    out.glowBeneathMedia = !!(building.querySelector('.crown-glow')!.compareDocumentPosition(billboard) & Node.DOCUMENT_POSITION_FOLLOWING)
    for (const v of [0.1, 0.5, 0.9])
      for (const u of [0.08, 0.3, 0.5, 0.7, 0.92]) {
        const p = at(u, v)
        if (p.x < 0 || p.y < 0 || p.x > innerWidth || p.y > innerHeight) continue
        const hit = document.elementFromPoint(p.x, p.y)
        if (!hit?.closest('svg')) continue
        out.samples++
        if (hit.closest(`[data-testid="billboard-${id}"]`) !== billboard) out.stolen.push(`${u},${v}:${hit.tagName}.${hit.getAttribute('class')}`)
      }
    out.nearCrown = at(0.5, 0.12)
    return out
  }, friendId)
}

/** The Crown sits above the billboard with a small gap, centred, and never over the media. */
async function expectCrownClearOfBillboard(page: Page) {
  const zoom = Number(await page.getByTestId('city').getAttribute('data-zoom'))
  const m = await measure(page, PLAYER)
  expect(m.billboard).not.toBeNull()
  // Vertically above the highest point of the billboard, by a small intentional gap.
  const gap = m.billboard!.top - m.body.bottom
  expect(gap, 'gap between Crown and billboard').toBeGreaterThanOrEqual(1)
  expect(gap, 'Crown stays close to its building').toBeLessThanOrEqual(24 * Math.max(zoom, 0.5))
  // Horizontally centred on the property (never shoved aside).
  const crownX = (m.body.left + m.body.right) / 2
  expect(Math.abs(crownX - m.axisX)).toBeLessThan(1)
  expect(Math.abs(crownX - (m.billboard!.left + m.billboard!.right) / 2)).toBeLessThan(1)
  // Its mast and light beam start above the media's top edge: nothing crosses the image.
  expect(m.mast.bottom).toBeLessThanOrEqual(m.mediaTopUnderMast)
  expect(m.beam.bottom).toBeLessThanOrEqual(m.mediaTopUnderBeam)
  expect(m.mast.bottom).toBeGreaterThan(m.body.bottom)
  // The glow is painted beneath the media, and the Crown never takes pointer events.
  expect(m.glowBeneathMedia).toBe(true)
  expect(m.crownPointerEvents).toBe('none')
  expect(m.glowPointerEvents).toBe('none')
  expect(m.samples).toBeGreaterThanOrEqual(9)
  expect(m.stolen).toEqual([])
  return m
}

async function expectBillboardOpensViewer(page: Page, point: { x: number; y: number }, tap = false) {
  if (tap) await page.touchscreen.tap(point.x, point.y)
  else await page.mouse.click(point.x, point.y)
  const viewer = page.getByTestId('billboard-viewer')
  await expect(viewer).toBeVisible()
  await expect(viewer).toContainText(`Demo Friend #${PLAYER}`)
  await page.getByTestId('billboard-viewer-close').click()
  await expect(viewer).toHaveCount(0)
  // Opening media never (de)selects the building underneath.
  await expect(page.getByTestId('building-panel')).toHaveCount(0)
}

async function rotateTo(page: Page, steps: number, degrees: number) {
  for (let i = 0; i < steps; i++) await page.getByTestId('rotate-right').click()
  await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', String(degrees))
  await atRest(page.getByTestId('crown-spire').locator('path'))
}

const DESK_SPOT = { x: 760, y: 400 }
const DESK_GRAB = { x: 300, y: 520 }

test.describe('City Crown above rooftop media', () => {
  test('without a billboard the Crown keeps its classic place and the tower stays selectable', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    const city = page.getByTestId('city')
    await expect(page.getByTestId('hud-crown')).toHaveAttribute('data-crown', '120')
    await expect(page.getByTestId('billboard-120')).toHaveCount(0)
    for (const turn of [0, 6]) {
      if (turn) await rotateTo(page, turn, 90)
      const zoom = Number(await city.getAttribute('data-zoom'))
      const m = await measure(page, 120)
      expect(await city.getAttribute('data-detail')).toBe('far')
      // Classic stem (18 units at the far-zoom Crown scale of 2) standing on the roofline,
      // with the crown body resting just above its tip, centred on the property.
      expect(m.mast.bottom - m.mast.top).toBeCloseTo(18 * 2 * zoom, 0)
      expect(m.mast.top - m.body.bottom).toBeGreaterThanOrEqual(0)
      expect(m.mast.top - m.body.bottom).toBeLessThan(2 * 2 * zoom + 1)
      expect(Math.abs((m.body.left + m.body.right) / 2 - m.axisX)).toBeLessThan(1)
      expect(m.beam.bottom).toBeCloseTo(m.mast.bottom, 0)
      expect(m.crownPointerEvents).toBe('none')
    }
    // The Crown passes clicks through to its own building (it is never a dead zone).
    const m = await measure(page, 120)
    await page.mouse.click((m.body.left + m.body.right) / 2, (m.body.top + m.body.bottom) / 2)
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '120')
  })

  test('the Crown floats above a Tier 5 rooftop billboard at near, mid and far zoom', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    const city = page.getByTestId('city')
    await crownThePlayerTower(page, 170_000)
    const billboard = page.getByTestId(`billboard-${PLAYER}`)
    await expect(billboard.locator('[data-billboard-image]')).toHaveAttribute('href', /^data:image\/jpeg;base64,/)

    for (const detail of ['near', 'mid', 'far'] as const) {
      if (detail !== 'near') {
        await page.getByRole('button', { name: 'Zoom out' }).click()
        if (detail === 'far') await page.getByRole('button', { name: 'Zoom out' }).click()
      }
      await expect(city).toHaveAttribute('data-detail', detail)
      await panIntoView(page, billboard, DESK_SPOT, DESK_GRAB)
      const m = await expectCrownClearOfBillboard(page)
      // The media point nearest the Crown still opens this property's media.
      await expectBillboardOpensViewer(page, m.nearCrown)
    }
    // Playwright's own actionability check agrees: the billboard is a real click target.
    await billboard.click()
    await expect(page.getByTestId('billboard-viewer')).toContainText(`Demo Friend #${PLAYER}`)
  })

  test('the separation holds for the Tier 6 landmark screen at every rotation', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    await crownThePlayerTower(page, 237_000)
    const billboard = page.getByTestId(`billboard-${PLAYER}`)
    await page.getByRole('button', { name: 'Zoom out' }).click()
    await expect(page.getByTestId('city')).toHaveAttribute('data-detail', 'mid')

    await panIntoView(page, billboard, DESK_SPOT, DESK_GRAB)
    const upright = await expectCrownClearOfBillboard(page)
    const gap0 = upright.billboard!.top - upright.body.bottom
    await expectBillboardOpensViewer(page, upright.nearCrown)

    let degrees = 0
    for (const steps of [3, 3, 6, 7]) {
      degrees = (degrees + steps * 15) % 360
      await rotateTo(page, steps, degrees)
      await panIntoView(page, billboard, DESK_SPOT, DESK_GRAB)
      const m = await expectCrownClearOfBillboard(page)
      // Rotation moves the property, never the Crown relative to its billboard.
      expect(m.billboard!.top - m.body.bottom).toBeCloseTo(gap0, 0)
      expect(m.billboard!.right - m.billboard!.left).toBeCloseTo(upright.billboard!.right - upright.billboard!.left, 0)
      await expectBillboardOpensViewer(page, m.nearCrown)
    }
    expect(degrees).toBe(285)
    await expect(page.getByTestId('hud-crown')).toHaveAttribute('data-crown', String(PLAYER))
  })
})

test.describe('City Crown above rooftop media on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('Crown and billboard stay separate, and a tap opens the media', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    await crownThePlayerTower(page, 170_000)
    const billboard = page.getByTestId(`billboard-${PLAYER}`)
    const spot = { x: 170, y: 470 }
    const grab = { x: 60, y: 620 }
    await panIntoView(page, billboard, spot, grab)
    const m = await expectCrownClearOfBillboard(page)
    await expectBillboardOpensViewer(page, m.nearCrown, true)

    // Rotate around the selected tower (the rotate controls sit above the property sheet),
    // so it stays on the small screen while the city turns.
    await warpToOwnBuilding(page)
    await page.getByTestId('rotate-right').tap()
    await page.getByTestId('rotate-right').tap()
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '30')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('building-panel')).toHaveCount(0)
    await atRest(page.getByTestId('crown-spire').locator('path'))
    await panIntoView(page, billboard, spot, grab)
    const turned = await expectCrownClearOfBillboard(page)
    await expectBillboardOpensViewer(page, turned.nearCrown, true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
