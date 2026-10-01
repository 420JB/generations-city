import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { decodePng, openCity, type Pixels } from './helpers.ts'

/**
 * Render integrity up close.
 *
 * Close in on the city, any camera move (drag, rotate, wheel, + / -) used to leave whole
 * horizontal bands of the map unpainted: bare sky where ground and towers belong, with only a
 * few lit windows, beacons and labels left floating. Camera, viewBox and DOM were all correct
 * the whole time. Chrome had given every animated light inside the map its own compositor layer
 * and split what paints after each into further layers, dozens of them; up close on a large
 * screen it could not keep them all rastered while the camera moved, and dropped tiles.
 *
 * Camera-state assertions cannot see that failure, so these tests look at what Chrome does:
 *
 * - The compositor layers the map produces. This is the cause, it is deterministic, and it is
 *   the test that fails on the old build (some 60 layers inside the map; there must be none).
 * - Every frame Chrome presents while the camera moves, judged against the DOM: where the map's
 *   ground is mounted and covers the viewport, no band of the frame may show the bare sky.
 *   Automation does not drop bands the way a real window on a large display does (there they
 *   only showed up in OS screen captures), so this part guards the invariant rather than
 *   reproducing the old failure.
 */
const CROWN = 120
const MAX_ZOOM = 3.2
const BANDS = 12
/** Presented frames are recorded scaled down to this width: a dropped band is never subtle. */
const FRAME_WIDTH = 752
/** A band counts as unpainted when this share of its map pixels shows the bare sky. */
const BARE = 0.7

const zoomOf = (page: Page) => page.getByTestId('city').getAttribute('data-zoom').then(Number)

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

/** Drag the map along a path of offsets from a point clear of the HUD. */
async function drag(page: Page, ...path: [number, number][]) {
  const { width, height } = page.viewportSize()!
  const from = { x: width / 2, y: height * 0.45 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (const [dx, dy] of path) await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 })
  await page.mouse.up()
}

/** Screen centre of the Crown tower's plot (the lot it stands on). */
const crownPlot = (page: Page) =>
  page
    .locator(`[data-testid="building-${CROWN}"] > polygon`)
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })

/** Open the city and go to the closest zoom at the foot of the Crown tower (nothing selected). */
async function openUpClose(page: Page) {
  await openCity(page)
  await page.getByTestId('guide-hide').click()
  await still(page)
  // Bring the tower's plot under a point clear of the HUD, then wheel in about that point.
  const { width, height } = page.viewportSize()!
  const anchor = { x: width / 2, y: height * 0.6 }
  const plot = await crownPlot(page)
  await drag(page, [anchor.x - plot.x, anchor.y - plot.y])
  await expect
    .poll(async () => {
      const now = await crownPlot(page)
      return Math.hypot(now.x - anchor.x, now.y - anchor.y)
    })
    .toBeLessThan(3)
  await page.mouse.move(anchor.x, anchor.y)
  for (let i = 0; i < 40 && (await zoomOf(page)) < MAX_ZOOM - 0.01; i++) {
    await page.mouse.wheel(0, -300)
    await page.waitForTimeout(60)
  }
  expect(await zoomOf(page)).toBeCloseTo(MAX_ZOOM, 1)
  await expect(page.getByTestId('city')).toHaveAttribute('data-detail', 'near')
  await still(page)
}

/** Compositor layers owned by something inside the map (the map as a whole belongs to its page layer). */
async function mapLayers(page: Page): Promise<number> {
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
      functionDeclaration: `function () {
        const el = this.nodeType === 1 ? this : this.parentElement
        const svg = document.querySelector('[data-testid="city-svg"]')
        return !!el && el !== svg && svg.contains(el)
      }`,
      returnByValue: true,
    })
    if (result.value) inside++
  }
  await cdp.detach()
  return inside
}

/** Every frame Chrome presents while `during` runs, as PNGs scaled down to FRAME_WIDTH. */
async function record(page: Page, during: () => Promise<void>): Promise<Buffer[]> {
  const { width, height } = page.viewportSize()!
  const scale = Math.min(1, FRAME_WIDTH / width)
  const cdp = await page.context().newCDPSession(page)
  const frames: Buffer[] = []
  cdp.on('Page.screencastFrame', (frame) => {
    frames.push(Buffer.from(frame.data, 'base64'))
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: Math.round(width * scale), maxHeight: Math.round(height * scale) })
  await during()
  await cdp.send('Page.stopScreencast')
  await cdp.detach()
  return frames
}

interface Sky {
  /** The page with the map hidden: what shows through wherever the map failed to paint. */
  pixels: Pixels
  /** Per pixel: 1 where the HUD draws over the map (those pixels say nothing about the map). */
  hud: Uint8Array
}

const near = (p: Pixels, i: number, q: Pixels, j: number, tolerance = 6) =>
  Math.abs(p.data[i] - q.data[j]) <= tolerance && Math.abs(p.data[i + 1] - q.data[j + 1]) <= tolerance && Math.abs(p.data[i + 2] - q.data[j + 2]) <= tolerance

/** Reference frames taken with the camera at rest: the bare sky behind the map, and where the HUD is. */
async function bareSky(page: Page): Promise<Sky> {
  const presented = async () => decodePng((await record(page, () => page.waitForTimeout(500))).at(-1)!)
  const svg = page.getByTestId('city-svg')
  await svg.evaluate((el) => ((el as SVGSVGElement).style.visibility = 'hidden'))
  const pixels = await presented()
  const hide = await page.addStyleTag({ content: '.app > :not(.sky) { opacity: 0 !important; }' })
  const skyOnly = await presented()
  await hide.evaluate((el) => (el as HTMLStyleElement).remove())
  await svg.evaluate((el) => ((el as SVGSVGElement).style.visibility = ''))
  // Let the restored map reach the screen before anything else is recorded.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.waitForTimeout(400)
  expect(skyOnly.width).toBe(pixels.width)
  const hud = new Uint8Array(pixels.width * pixels.height)
  // Glass HUD panels tint the sky only slightly, so any difference at all counts as HUD.
  for (let k = 0; k < hud.length; k++) hud[k] = near(pixels, k * pixels.channels, skyOnly, k * skyOnly.channels, 1) ? 0 : 1
  return { pixels, hud }
}

/** Per horizontal band: the share of the map's pixels (HUD excluded) that show the bare sky instead. */
function skyShare(frame: Pixels, sky: Sky): number[] {
  const rows = Math.floor(frame.height / BANDS)
  const out: number[] = []
  for (let band = 0; band < BANDS; band++) {
    let same = 0
    let n = 0
    for (let y = band * rows; y < (band + 1) * rows; y++)
      for (let x = 0; x < frame.width; x++) {
        const k = y * frame.width + x
        if (sky.hud[k]) continue
        n++
        if (near(frame, k * frame.channels, sky.pixels, k * sky.pixels.channels)) same++
      }
    // A band the HUD mostly covers has too few map pixels to judge.
    out.push(n > rows * frame.width * 0.2 ? same / n : 0)
  }
  return out
}

/**
 * What the DOM says is on screen. The recorded frames are only judged against this: while the
 * map's ground is mounted and covers every band of the viewport, no band may show the sky.
 */
async function expectCityMounted(page: Page, label: string) {
  const dom = await page.evaluate((bands) => {
    const svg = document.querySelector('[data-testid="city-svg"]')!
    const onScreen = (el: Element) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight
    }
    const covered: boolean[] = []
    for (let band = 0; band < bands; band++) {
      const y = ((band + 0.5) * innerHeight) / bands
      covered.push([0.1, 0.3, 0.5, 0.7, 0.9].every((fx) => document.elementsFromPoint(fx * innerWidth, y).some((el) => !!el.closest('.ground-layer'))))
    }
    return {
      covered,
      groundMounted: !!svg.querySelector('.ground-layer .ground'),
      districtsOnScreen: [...svg.querySelectorAll('.district-ground')].filter(onScreen).length,
      buildingsOnScreen: [...svg.querySelectorAll('[data-testid^="building-"]')].filter(onScreen).length,
      rendered: Number(document.querySelector<HTMLElement>('[data-testid="city"]')!.dataset.rendered),
    }
  }, BANDS)
  expect(dom.groundMounted, `${label}: ground layer unmounted`).toBe(true)
  expect(dom.covered, `${label}: the map's ground no longer covers the viewport`).toEqual(dom.covered.map(() => true))
  expect(dom.districtsOnScreen, `${label}: no district ground on screen`).toBeGreaterThan(0)
  expect(dom.buildingsOnScreen, `${label}: no buildings on screen`).toBeGreaterThan(0)
  expect(dom.rendered, `${label}: nothing rendered`).toBeGreaterThan(0)
}

/** No presented frame may show a band of bare sky where the city belongs. */
async function expectEveryFramePainted(frames: Buffer[], sky: Sky, testInfo: TestInfo) {
  let judged = 0
  const bare: { frame: number; share: number[] }[] = []
  for (const [i, png] of frames.entries()) {
    const frame = decodePng(png)
    if (frame.width !== sky.pixels.width || frame.height !== sky.pixels.height) continue
    judged++
    const share = skyShare(frame, sky)
    if (Math.max(...share) < BARE) continue
    if (!bare.length) await testInfo.attach('first-unpainted-frame.png', { body: png, contentType: 'image/png' })
    bare.push({ frame: i, share })
  }
  expect(judged, 'too few frames were presented to judge').toBeGreaterThan(20)
  const first = bare[0]
  expect(
    bare.length,
    first ? `${bare.length} of ${judged} presented frames show bare sky where the city belongs (frame ${first.frame}, sky share per band, top to bottom: ${first.share.map((v) => v.toFixed(2)).join(' ')})` : '',
  ).toBe(0)
}

test.describe('High-zoom render integrity', () => {
  test('up close, nothing inside the map gets a compositor layer of its own', async ({ page }) => {
    await openUpClose(page)
    // The ambient lights are there and animating: they are what used to be promoted.
    const lights = await page.evaluate(
      () => [...document.querySelectorAll('.city-svg .flicker, .city-svg .blink')].filter((el) => el.getAnimations().some((a) => a.playState === 'running')).length,
    )
    expect(lights).toBeGreaterThan(5)
    expect(await mapLayers(page)).toBe(0)

    // Selecting a property adds its pulsing ground ring; rotating re-mounts what is in view.
    await page.getByTestId('hud-crown').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', String(CROWN))
    await still(page)
    await expect(page.locator('.select-ring')).toBeAttached()
    await page.getByTestId('rotate-right').click()
    await still(page)
    expect(await mapLayers(page)).toBe(0)
  })
})

test.describe('High-zoom render integrity on a large display', () => {
  // A maximised browser window on a 6K display: where the dropped bands were constant.
  test.use({ viewport: { width: 3008, height: 1600 }, deviceScaleFactor: 2 })

  test('pan, rotate, wheel and + / - up close paint the whole city in every frame', async ({ page }, testInfo) => {
    test.setTimeout(300_000)
    await openUpClose(page)
    const sky = await bareSky(page)
    const { width, height } = page.viewportSize()!
    const zoomButton = (name: string) => page.getByRole('button', { name, exact: true })

    const frames = await record(page, async () => {
      await drag(page, [-420, 0], [420, 0], [0, -250], [0, 250], [0, 0])
      await expectCityMounted(page, 'after panning')

      for (let i = 0; i < 6; i++) {
        await page.getByTestId('rotate-right').click()
        await page.waitForTimeout(200)
      }
      await still(page)
      await expectCityMounted(page, 'after rotating')

      await page.mouse.move(width / 2, height * 0.45)
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, Math.floor(i / 3) % 2 ? -50 : 50)
        await page.waitForTimeout(40)
      }
      await expectCityMounted(page, 'after wheel zoom')

      for (const name of ['Zoom out', 'Zoom in', 'Zoom out', 'Zoom in']) {
        await zoomButton(name).click()
        await page.waitForTimeout(400)
      }
      await still(page)
      await expectCityMounted(page, 'after + / -')

      // Combined, with no settling in between: pan -> rotate -> zoom, rotate -> pan -> zoom, zoom -> pan -> rotate.
      await drag(page, [-300, 80])
      await page.getByTestId('rotate-left').click()
      await page.mouse.wheel(0, 60)
      await page.getByTestId('rotate-left').click()
      await drag(page, [300, -80])
      await page.mouse.wheel(0, -60)
      await zoomButton('Zoom out').click()
      await drag(page, [0, 200])
      await page.getByTestId('rotate-right').click()
      await still(page)
      await expectCityMounted(page, 'after combined moves')
    })
    await expectEveryFramePainted(frames, sky, testInfo)
  })
})

test.describe('High-zoom render integrity on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true })

  /** Two-finger pinch about the middle of the map: the spread goes from `from` to `to` px. */
  async function pinch(page: Page, from: number, to: number) {
    const cdp = await page.context().newCDPSession(page)
    const points = (spread: number, count = 2) =>
      [
        { x: 195 - spread / 2, y: 400, id: 0 },
        { x: 195 + spread / 2, y: 400, id: 1 },
      ].slice(0, count)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from, 1) })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) })
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(from + ((to - from) * i) / 8) })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  }

  test('pinch, pan and rotate up close paint the whole city in every frame', async ({ page }, testInfo) => {
    test.setTimeout(120_000)
    await openUpClose(page)
    const sky = await bareSky(page)

    const frames = await record(page, async () => {
      await pinch(page, 200, 150)
      await pinch(page, 150, 200)
      expect(await zoomOf(page)).toBeGreaterThan(2.3)
      await expectCityMounted(page, 'after pinching')

      await drag(page, [-140, 0], [140, 0], [0, -160], [0, 160], [0, 0])
      await expectCityMounted(page, 'after panning')

      for (let i = 0; i < 4; i++) {
        await page.getByTestId('rotate-right').click()
        await page.waitForTimeout(200)
      }
      await still(page)
      await expectCityMounted(page, 'after rotating')

      await pinch(page, 180, 150)
      await drag(page, [100, -80])
      await page.getByTestId('rotate-left').click()
      await still(page)
      await expectCityMounted(page, 'after combined moves')
    })
    await expectEveryFramePainted(frames, sky, testInfo)
    expect(await mapLayers(page)).toBe(0)
  })
})
