import { expect, test, type Page } from '@playwright/test'
import { contributeExact, makePng, openCity, selectBuilding, warpToOwnBuilding } from './helpers.ts'

async function rallyBuildings(page: Page): Promise<string[]> {
  return page.getByTestId('rally-calls').locator('[data-building]').evaluateAll((els) => els.map((e) => e.getAttribute('data-building') ?? ''))
}

test.describe('District Radio · Rally Calls', () => {
  test('dispatches current strategy, refreshes after the move, and keeps history WARP-free', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('nav-radio').click()
    const first = page.getByTestId('rally-0')
    await expect(first).toHaveAttribute('data-building', '812')
    await expect(first).toHaveAttribute('data-kind', 'monument')
    await expect(first).toContainText('TAKE THE GRAND FOUNTAIN')
    await expect(first).toContainText('captures The Grand Fountain from Sparkling')
    await expect(page.getByTestId('rally-0-badges')).toContainText('Kingmaker')
    await expect(page.getByTestId('rally-0-warp')).toHaveText('WARP · 38 RF')
    // City Feed is history: no WARP buttons, even on entries tied to a building.
    await expect(page.getByTestId('radio-list')).toContainText('RALLY DEMO FRIEND #812')
    await expect(page.getByTestId('radio-list').locator('.warp-btn')).toHaveCount(0)
    const seeded = await rallyBuildings(page)
    expect(new Set(seeded).size).toBe(seeded.length)

    await page.getByTestId('rally-0-warp').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '812')
    await contributeExact(page)
    await expect(page.getByTestId('hud-mon-m4')).toHaveAttribute('data-holder', 'd4')

    await page.getByTestId('nav-radio').click()
    // The completed Fountain call is gone; the Capital move surfaced in its place.
    const after = await rallyBuildings(page)
    expect(after).not.toContain('812')
    expect(new Set(after).size).toBe(after.length)
    const capital = page.locator('[data-testid="rally-calls"] [data-kind="capital"]')
    await expect(capital).toHaveAttribute('data-building', '288')
    await expect(capital).toContainText('makes Family the Capital')
    await expect(capital).toContainText('Capital Maker')
    await expect(page.getByTestId('radio-list')).toContainText('The Grand Fountain STOLEN')
    await expect(page.getByTestId('radio-list').locator('.warp-btn')).toHaveCount(0)
  })
})

test.describe('Clickable billboards + owner message', () => {
  test('owner message rejects links, and the billboard opens a viewer at far / mid / near zoom', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    await warpToOwnBuilding(page)
    await page.getByTestId('open-architect').click()
    await page.getByTestId('tab-billboard').click()
    await page.getByTestId('buy-billboard').click()
    await page.getByTestId('confirm-fixture-billboard').click()
    await page.getByTestId('billboard-input').setInputFiles({ name: 'ad.png', mimeType: 'image/png', buffer: makePng(200, 100) })
    await page.getByTestId('billboard-save').click()

    const input = page.getByTestId('billboard-message-input')
    for (const bad of ['https://example.com', 'example.xyz', 'www.example.com']) {
      await input.fill(bad)
      await page.getByTestId('billboard-message-save').click()
      await expect(page.getByTestId('billboard-message-error')).toContainText("Links aren't allowed")
      await expect(input).toHaveValue(bad)
    }
    await input.fill('  Follow @example on Twitter  ')
    await page.getByTestId('billboard-message-save').click()
    await expect(page.getByTestId('billboard-message-error')).toHaveCount(0)
    await expect(input).toHaveValue('Follow @example on Twitter')

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('building-panel')).toHaveCount(0)
    await page.getByRole('button', { name: 'City overview' }).click()
    const city = page.getByTestId('city')
    const billboard = page.getByTestId('billboard-4471')
    const viewer = page.getByTestId('billboard-viewer')
    for (const detail of ['far', 'mid', 'near'] as const) {
      await expect
        .poll(
          async () => {
            if ((await city.getAttribute('data-detail')) !== detail) {
              const box = (await page.getByTestId('building-4471').boundingBox())!
              await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3)
              await page.mouse.wheel(0, -150)
            }
            return city.getAttribute('data-detail')
          },
          { intervals: [300], timeout: 20_000 },
        )
        .toBe(detail)
      await page.waitForTimeout(300)
      await billboard.click()
      await expect(viewer).toBeVisible()
      await expect(viewer).toContainText('PROPERTY MEDIA')
      await expect(viewer).toContainText('Demo Friend #4471')
      await expect(page.getByTestId('billboard-viewer-owner')).toHaveText('@demo-player')
      await expect(viewer).toContainText('Family')
      await expect(page.getByTestId('billboard-viewer-message')).toHaveText('Follow @example on Twitter')
      await expect(viewer.locator('a')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(viewer).toHaveCount(0)
      // The click opened media only: it did not select the building underneath.
      await expect(page.getByTestId('building-panel')).toHaveCount(0)
    }
    // Keyboard activation.
    await billboard.focus()
    await page.keyboard.press('Enter')
    await expect(viewer).toBeVisible()
    await page.getByTestId('billboard-viewer-close').click()
    await expect(viewer).toHaveCount(0)

    // Persists through reload; Reset Demo restores the seeded (no billboard) state.
    await page.reload()
    await expect(page.getByTestId('billboard-4471').locator('[data-billboard-image]')).toBeAttached()
    await page.getByTestId('billboard-4471').click()
    await expect(page.getByTestId('billboard-viewer-message')).toHaveText('Follow @example on Twitter')
    await page.keyboard.press('Escape')
    await page.getByTestId('reset-demo').click()
    await page.getByTestId('confirm-reset').click()
    await expect(page.getByTestId('billboard-4471')).toHaveCount(0)
  })
})

test.describe('Mobile build reveal', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('a successful build slides the sheet away, then restores the same building', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    await selectBuilding(page, 288)
    const drawer = page.getByTestId('drawer')
    await expect(drawer).toHaveAttribute('data-revealing', 'false')

    // Cancelled confirmation and non-construction actions never hide the sheet.
    await page.getByTestId('amount-10').click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.getByTestId('rally-btn').click()
    await page.waitForTimeout(400)
    await expect(drawer).toHaveAttribute('data-revealing', 'false')

    // Successful construction: hides, then returns on its own to the same building.
    await page.getByTestId('amount-10').click()
    await page.getByTestId('confirm-contribution').click()
    await expect(drawer).toHaveAttribute('data-revealing', 'true')
    await expect(drawer).toHaveAttribute('data-revealing', 'false', { timeout: 10_000 })
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '288')
    await expect(page.getByTestId('building-288')).toHaveAttribute('data-selected', 'true')

    // Tier-crossing build (#288 → Tier 3) also gets the reveal.
    await contributeExact(page)
    await expect(drawer).toHaveAttribute('data-revealing', 'true')
    await expect(page.getByTestId('building-288')).toHaveAttribute('data-tier', '3')
    await expect(drawer).toHaveAttribute('data-revealing', 'false', { timeout: 10_000 })
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '288')
  })
})

test('desktop builds keep the drawer in place', async ({ page }) => {
  await openCity(page)
  await selectBuilding(page, 288)
  await page.getByTestId('amount-10').click()
  await page.getByTestId('confirm-contribution').click()
  await expect(page.getByTestId('total-built')).toHaveText('2,447')
  const drawer = page.getByTestId('drawer')
  await expect(drawer).toHaveAttribute('data-revealing', 'false')
  await page.waitForTimeout(500)
  await expect(drawer).toHaveAttribute('data-revealing', 'false')
})
