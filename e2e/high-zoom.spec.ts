import { expect, test, type Page } from '@playwright/test'
import { openCity } from './helpers.ts'

/**
 * Close inspection of a tall property (the City Crown tower, Demo Friend #120).
 *
 * Up close its plot is below the viewport while the tower fills the screen. The rotation pivot
 * used to fall back to the ground under mid-screen there, so turning the city swung the tower
 * (and most of the visible city) out of the view; zoom input during a turn finished the turn
 * about a different point again. The plot leaves a 900 px tall viewport at zoom ~1.96.
 */
const CROWN = 120
const STEP = 15
const MAX_ZOOM = 3.2
/** Screen point over the tower, clear of the HUD and the property panel. */
const OVER_TOWER = { x: 510, y: 300 }

const zoomOf = (page: Page) => page.getByTestId('city').getAttribute('data-zoom').then(Number)
const rotationOf = (page: Page) => page.getByTestId('city').getAttribute('data-rotation').then(Number)

/** The raw persisted game state (what a reload would restore). */
async function savedRaw(page: Page): Promise<string> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('generations-city:state'))!
    return localStorage.getItem(key)!
  })
}

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

interface Tower {
  /** Screen centre of the selected property's ground ring (its plot centre). */
  x: number
  y: number
  left: number
  right: number
  top: number
  bottom: number
}

/** The selected property on screen: its plot centre and the box of everything it draws. */
async function tower(page: Page): Promise<Tower> {
  const t = await page.evaluate(() => {
    const el = document.querySelector('.bldg.is-selected')
    const ring = el?.querySelector('.select-ring')
    if (!el || !ring) return null
    const b = el.getBoundingClientRect()
    const r = ring.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: b.left, right: b.right, top: b.top, bottom: b.bottom }
  })
  expect(t, 'the selected property is no longer drawn').not.toBeNull()
  return t!
}

/** The selected property is where it was, and still on screen (never a fragment-only view). */
async function expectAnchored(page: Page, want: Tower, label: string) {
  const now = await tower(page)
  const { width, height } = page.viewportSize()!
  expect(Math.abs(now.x - want.x), `${label}: plot moved sideways`).toBeLessThan(2)
  expect(Math.abs(now.y - want.y), `${label}: plot moved vertically`).toBeLessThan(2)
  expect(now.right > 0 && now.left < width && now.bottom > 0 && now.top < height, `${label}: tower left the screen`).toBe(true)
  await expect(page.getByTestId(`building-${CROWN}`)).toHaveAttribute('data-selected', 'true')
  expect(Number(await page.getByTestId('city').getAttribute('data-rendered'))).toBeGreaterThan(0)
}

async function openOnCrown(page: Page) {
  await openCity(page)
  await page.getByTestId('guide-hide').click()
  await page.getByTestId('hud-crown').click()
  await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', String(CROWN))
  await still(page)
}

/** Wheel-zoom about the tower to `target` (the wheel zooms by exp(-deltaY * 0.0015)). */
async function zoomTo(page: Page, target: number) {
  await page.mouse.move(OVER_TOWER.x, OVER_TOWER.y)
  await page.mouse.wheel(0, -Math.log(target / (await zoomOf(page))) / 0.0015)
  await expect.poll(async () => Math.abs((await zoomOf(page)) - target)).toBeLessThan(0.02)
  await still(page)
}

/** Press a rotate control `steps` times (negative = left) and wait for the turn to settle. */
async function rotate(page: Page, steps: number) {
  const start = await rotationOf(page)
  const button = page.getByTestId(steps > 0 ? 'rotate-right' : 'rotate-left')
  for (let i = 0; i < Math.abs(steps); i++) await button.click()
  await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', String((((start + steps * STEP) % 360) + 360) % 360))
  await still(page)
}

/** Small wheel zoom out and back in, about the tower. */
async function wheelOutAndIn(page: Page, deltaY = 60) {
  const zoom = await zoomOf(page)
  await page.mouse.move(OVER_TOWER.x, OVER_TOWER.y)
  await page.mouse.wheel(0, deltaY)
  await expect.poll(() => zoomOf(page)).toBeLessThan(zoom)
  await page.mouse.wheel(0, -deltaY)
  await expect.poll(async () => Math.abs((await zoomOf(page)) - zoom)).toBeLessThan(0.02)
}

/** Zoom out and back in with the + / - controls (each is a short flight about the screen centre). */
async function buttonsOutAndIn(page: Page) {
  const zoom = await zoomOf(page)
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click()
  await expect.poll(() => zoomOf(page)).toBeLessThan(zoom - 0.3)
  await still(page)
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect.poll(async () => Math.abs((await zoomOf(page)) - zoom)).toBeLessThan(0.02)
  await still(page)
}

/**
 * Press a rotate control and deliver other input in the same task, so that input is guaranteed
 * to land while the turn is still in flight (no timing involved).
 */
async function rotateAnd(page: Page, input: { wheel: number[] } | { click: string }, presses = 1) {
  await page.evaluate(
    ({ input, presses, at }) => {
      const svg = document.querySelector('[data-testid="city-svg"]')!
      for (let i = 0; i < presses; i++) document.querySelector<HTMLElement>('[data-testid="rotate-right"]')!.click()
      if ('wheel' in input) for (const deltaY of input.wheel) svg.dispatchEvent(new WheelEvent('wheel', { deltaY, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }))
      else document.querySelector<HTMLElement>(`[aria-label="${input.click}"]`)!.click()
    },
    { input, presses, at: OVER_TOWER },
  )
}

test.describe('High-zoom inspection of a tall property', () => {
  test('below the former failure range, rotating and zooming keep the tower in place', async ({ page }) => {
    await openOnCrown(page)
    await zoomTo(page, 1.75)
    const want = await tower(page)
    // Control case: the plot itself is still on screen here.
    expect(want.y).toBeLessThan(900)
    await rotate(page, 2)
    await expectAnchored(page, want, '30°')
    await wheelOutAndIn(page)
    await still(page)
    await expectAnchored(page, want, 'after a small zoom')
    await rotate(page, 4)
    await expectAnchored(page, want, '90°')
  })

  test('above it, the selected tower stays anchored through every rotation', async ({ page }) => {
    await openOnCrown(page)
    await zoomTo(page, 2.1)
    let want = await tower(page)
    // The formerly broken state: the plot is below the viewport, the tower fills the screen.
    expect(want.y).toBeGreaterThan(900)
    expect(want.top).toBeLessThan(0)
    let angle = 0
    for (const target of [30, 60, 90, 135, 180]) {
      await rotate(page, (target - angle) / STEP)
      angle = target
      await expectAnchored(page, want, `zoom 2.1, ${target}°`)
    }
    // Same again at maximum zoom, on round the orbit and back to 0°.
    await zoomTo(page, MAX_ZOOM)
    want = await tower(page)
    for (const target of [225, 270, 315, 360]) {
      await rotate(page, (target - angle) / STEP)
      angle = target
      await expectAnchored(page, want, `max zoom, ${target}°`)
    }
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '0')
    await rotate(page, -3)
    await expectAnchored(page, want, 'max zoom, 315° turning left')
  })

  test('small zoom changes at high zoom leave the view where it was, at every angle', async ({ page }) => {
    await openOnCrown(page)
    await zoomTo(page, MAX_ZOOM)
    const want = await tower(page)
    let angle = 0
    for (const target of [0, 30, 60, 90, 135, 180]) {
      await rotate(page, (target - angle) / STEP)
      angle = target
      for (let i = 0; i < 3; i++) {
        await wheelOutAndIn(page, 40 + i * 30)
        // The camera stays close in and finite throughout.
        expect(await zoomOf(page)).toBeGreaterThan(2.5)
      }
      await still(page)
      await expectAnchored(page, want, `wheel loop at ${target}°`)
      await buttonsOutAndIn(page)
      await expectAnchored(page, want, `+ / - at ${target}°`)
      const viewBox = (await page.getByTestId('city-svg').getAttribute('viewBox'))!.split(' ').map(Number)
      expect(viewBox.every(Number.isFinite)).toBe(true)
      expect(viewBox[2]).toBeCloseTo(1440 / MAX_ZOOM, 0)
    }
  })

  test('zoom input that cuts a turn short still turns the city about the tower', async ({ page }) => {
    await openOnCrown(page)
    await zoomTo(page, MAX_ZOOM)
    const want = await tower(page)
    const city = page.getByTestId('city')

    // Wheel out and back in while the 15° turn is in flight.
    await rotateAnd(page, { wheel: [40, -40] })
    await expect(city).toHaveAttribute('data-rotation', '15')
    await still(page)
    await expectAnchored(page, want, 'wheel during a turn')

    // Zoom control during a turn (already at maximum zoom, so the view must come back unchanged).
    await rotateAnd(page, { click: 'Zoom in' })
    await expect(city).toHaveAttribute('data-rotation', '30')
    await still(page)
    expect(await zoomOf(page)).toBeCloseTo(MAX_ZOOM, 1)
    await expectAnchored(page, want, '+ during a turn')

    // Several presses queued, then the wheel: the whole remaining turn finishes about the tower.
    await rotateAnd(page, { wheel: [25, -25] }, 3)
    await expect(city).toHaveAttribute('data-rotation', '75')
    await still(page)
    await expectAnchored(page, want, 'wheel during a three-step turn')
  })

  test('rotate then zoom, zoom then rotate: the tower stays put and nothing is saved', async ({ page }) => {
    await openOnCrown(page)
    const before = await savedRaw(page)
    await zoomTo(page, 2.6)
    const want = await tower(page)

    // High zoom -> rotate -> zoom.
    await rotate(page, 3)
    await wheelOutAndIn(page)
    await still(page)
    await expectAnchored(page, want, 'rotate then wheel')
    await buttonsOutAndIn(page)
    await expectAnchored(page, want, 'rotate then + / -')

    // High zoom -> zoom -> rotate.
    await wheelOutAndIn(page, 90)
    await still(page)
    await rotate(page, 6)
    await expectAnchored(page, want, 'wheel then rotate')
    await buttonsOutAndIn(page)
    await rotate(page, -2)
    await expectAnchored(page, want, '+ / - then rotate')
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '105')

    // Camera work is presentation only.
    expect(await savedRaw(page)).toBe(before)

    // Overview and WARP still behave, and keep the orientation.
    await page.getByRole('button', { name: 'City overview' }).click()
    await expect.poll(() => zoomOf(page)).toBeLessThan(0.6)
    await still(page)
    await expect(page.getByTestId('city-hall')).toBeInViewport()
    await page.getByTestId('hud-crown').click()
    await expect.poll(() => zoomOf(page)).toBeGreaterThan(1.4)
    await still(page)
    await expect(page.getByTestId('city')).toHaveAttribute('data-rotation', '105')
    await expect(page.getByTestId(`building-${CROWN}`)).toBeInViewport()
    expect(await savedRaw(page)).toBe(before)
  })
})

test.describe('High-zoom inspection on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  /** Two-finger pinch about a point on the map: the spread goes from `from` to `to` px. */
  async function pinch(page: Page, from: number, to: number) {
    const cdp = await page.context().newCDPSession(page)
    const [cx, cy] = [195, 250]
    const points = (d: number, n = 2) => [cx - d / 2, cx + d / 2].slice(0, n).map((x, id) => ({ x, y: cy, id }))
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from, 1) })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) })
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(from + ((to - from) * i) / 8) })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
    await still(page)
  }

  test('pinch and rotate up close: the selected tower stays put and the page never overflows', async ({ page }) => {
    await openOnCrown(page)
    const city = page.getByTestId('city')
    // Pinch from the WARP framing into high zoom.
    await pinch(page, 80, 200)
    await pinch(page, 80, 200)
    expect(await zoomOf(page)).toBeGreaterThan(2.5)
    // Pan up the tower until its plot is below the screen (the formerly broken state).
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(195, 190)
      await page.mouse.down()
      await page.mouse.move(195, 310, { steps: 4 })
      await page.mouse.up()
    }
    let want = await tower(page)
    expect(want.y).toBeGreaterThan(844)

    // Rotate while close in.
    for (let i = 0; i < 6; i++) await page.getByTestId('rotate-right').tap()
    await expect(city).toHaveAttribute('data-rotation', '90')
    await still(page)
    await expectAnchored(page, want, 'rotate at high zoom')

    // Small pinch out and in, then rotate.
    await pinch(page, 150, 120)
    await pinch(page, 120, 150)
    expect(await zoomOf(page)).toBeGreaterThan(2)
    want = await tower(page)
    await page.getByTestId('rotate-right').tap()
    await page.getByTestId('rotate-right').tap()
    await expect(city).toHaveAttribute('data-rotation', '120')
    await still(page)
    await expectAnchored(page, want, 'pinch then rotate')

    // Rotate, then pinch: the pinch only zooms.
    await page.getByTestId('rotate-left').tap()
    await expect(city).toHaveAttribute('data-rotation', '105')
    await still(page)
    await pinch(page, 150, 130)
    await expect(city).toHaveAttribute('data-rotation', '105')
    await tower(page)

    // The property sheet and the page layout are untouched.
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', String(CROWN))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})
