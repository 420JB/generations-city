import { expect, test } from '@playwright/test'
import { contributeExact, openCity, selectBuilding, SHOTS, warpToKingmaker, zoomOnMap } from './helpers.ts'

/** Product-owner mapping for this build (internal id -> official family). */
const FAMILY: Record<string, string> = {
  d1: 'hollow',
  d2: 'sparkling',
  d3: 'colossus',
  d4: 'family',
  d5: 'cellular',
  d6: 'mask',
  d7: 'asymmetry',
  d8: 'skeleton',
  d9: 'hoverer',
}
const PLACEHOLDER = /\bdistrict [1-9]\b/i

async function hideGuide(page: import('@playwright/test').Page) {
  await page.getByTestId('guide-hide').click()
}

test.describe('Rare Friends family identity', () => {
  test('every district is labelled with its official family and crest', async ({ page }) => {
    await openCity(page)
    for (const [id, family] of Object.entries(FAMILY)) {
      const label = page.getByTestId(`district-label-${id}`)
      await expect(label).toHaveAttribute('data-family', family)
      await expect(label).toContainText(family.toUpperCase())
    }
    await expect(page.getByTestId('district-label-d4')).toHaveAttribute('aria-label', 'Family District Build Board')
    // Crest art is decorative: images live inside aria-hidden crests.
    await expect(page.locator('.hud-status .district-crest[aria-hidden="true"] img[alt=""]').first()).toBeAttached()
    await expect(page.getByTestId('hud-capital')).toContainText('Colossus')
    await hideGuide(page)
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${SHOTS}/06-family-overview.png` })
  })

  test('no placeholder "District N" copy remains on family-facing surfaces', async ({ page }) => {
    await openCity(page)
    const check = async () => expect(await page.locator('body').textContent()).not.toMatch(PLACEHOLDER)
    await check()
    for (const nav of ['board', 'standings', 'profile', 'radio']) {
      await page.getByTestId(`nav-${nav}`).click()
      await check()
    }
    await page.getByTestId('nav-board').click()
    await page.getByTestId('dtab-d2').click()
    await expect(page.getByTestId('board-district')).toHaveAttribute('data-family', 'sparkling')
    await expect(page.getByTestId('board-district')).toContainText('Sparkling District')
    await expect(page.getByTestId('dtab-d4')).toHaveAttribute('aria-label', 'Family District')
    await check()
    // Core loop narration is family-forward too (Board stays open: switch back to Family).
    await page.getByTestId('dtab-d4').click()
    await expect(page.getByTestId('impact-0')).toHaveAttribute('data-building', '812')
    await page.getByTestId('impact-0-warp').click()
    await contributeExact(page)
    await expect(page.getByTestId('announcements')).toContainText('The Grand Fountain: Sparkling → Family')
    await expect(page.locator('.radio-ticker')).toContainText('Family takes it from Sparkling')
    await check()
  })

  test('season allegiance: Home District is Family (internal d4)', async ({ page }) => {
    await openCity(page)
    await hideGuide(page)
    await page.getByTestId('nav-profile').click()
    const home = page.getByTestId('season-home')
    await expect(home).toHaveText('Family')
    await expect(home).toHaveAttribute('data-district', 'd4')
    await expect(home).toHaveAttribute('data-family', 'family')
    await expect(page.getByTestId('season-card')).toContainText('HOME DISTRICT')
    await expect(page.getByTestId('representative')).toHaveText('Demo Friend #4471')
    await expect(page.getByTestId('allegiance-locked')).toBeVisible()
    await expect(page.getByTestId('change-representative')).toBeDisabled()
    // Family art: crest (primary) + faint banner (secondary), both decorative.
    await expect(page.locator('[data-testid="season-card"] .season-home .district-crest img')).toHaveAttribute('src', /families\/transparent\/family-1\.svg$/)
    await expect(page.locator('[data-testid="season-card"] .season-banner-art')).toHaveAttribute('src', /families\/transparent\/family-2\.svg$/)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/08-season-allegiance.png` })
  })

  test('Capital identity follows the family that holds City Hall', async ({ page }) => {
    await openCity(page)
    await expect(page.getByTestId('city-hall')).toHaveAttribute('data-family', 'colossus')
    await expect(page.getByTestId('capital-crest')).toHaveAttribute('data-family', 'colossus')
    await expect(page.getByTestId('capital-sign-name')).toHaveText('COLOSSUS DISTRICT')
    await warpToKingmaker(page)
    await contributeExact(page)
    await selectBuilding(page, 288)
    await contributeExact(page)
    await expect(page.getByTestId('hud-capital')).toHaveAttribute('data-capital', 'd4')
    await expect(page.getByTestId('announcements')).toContainText('The Family District takes City Hall from Colossus')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'City overview' }).click()
    await expect(page.getByTestId('city-hall')).toHaveAttribute('data-family', 'family')
    await expect(page.getByTestId('capital-crest')).toHaveAttribute('data-family', 'family')
    // Overview: compact medallion (the district label and City Hall sign already name it).
    await expect(page.getByTestId('capital-crest')).toHaveAttribute('data-compact', 'true')
    await expect(page.getByTestId('capital-sign-name')).toHaveText('FAMILY DISTRICT')
    // Capital and the T5 statue are separate systems: the statue stays with its holder.
    await expect(page.getByTestId('monument-m5')).toHaveAttribute('data-family', 'colossus')
    await hideGuide(page)
    await page.waitForTimeout(4500) // let capture/transfer effects settle
    await zoomOnMap(page, 'city-hall', 2, { x: 720, y: 560 })
    await page.screenshot({ path: `${SHOTS}/07-capital-family.png` })
    // District close-up: Family's civic square with the captured fountain, gateway crest and Capital flags.
    await page.getByRole('button', { name: 'City overview' }).click()
    await page.waitForTimeout(900)
    await zoomOnMap(page, 'monument-m4', 5, { x: 720, y: 560 })
    await expect(page.getByTestId('district-gate-d4')).toHaveAttribute('data-family', 'family')
    // Up close the floating Capital crest carries the full family name.
    await expect(page.getByTestId('capital-crest')).not.toHaveAttribute('data-compact', 'true')
    await expect(page.getByTestId('capital-crest')).toContainText('FAMILY DISTRICT')
    await expect(page.getByTestId('capital-flags').locator('image').first()).toHaveAttribute('href', /families\/transparent\/family-2\.svg$/)
    await page.screenshot({ path: `${SHOTS}/10-district-family-closeup.png` })
  })

  test('T5 Friend Statue is sculpted from the holding family silhouette', async ({ page }) => {
    await openCity(page)
    const statue = page.getByTestId('monument-m5')
    await expect(statue).toHaveAttribute('data-district', 'd3')
    await expect(statue).toHaveAttribute('data-kind', 'statue')
    await expect(statue).toHaveAttribute('data-family', 'colossus')
    await expect(statue).toHaveAttribute('aria-label', 'The Friend Statue in Colossus form, held by the Colossus District')
    await expect(statue.locator('[data-statue-family="colossus"] mask image')).toHaveAttribute('href', /families\/transparent\/colossus-1\.svg$/)
    await hideGuide(page)
    await zoomOnMap(page, 'monument-m5', 6, { x: 720, y: 600 })
    await page.screenshot({ path: `${SHOTS}/09-t5-family-statue.png` })
  })

  test('source SVGs are opaque and derived SVGs are genuinely transparent', async ({ page }) => {
    await openCity(page)
    const urls = Object.values(FAMILY).flatMap((f) => [1, 2].flatMap((v) => [`/assets/families/${f}-${v}.svg`, `/assets/families/transparent/${f}-${v}.svg`]))
    const results = await page.evaluate(
      (list) =>
        Promise.all(
          list.map(
            (u) =>
              new Promise<{ u: string; ok: boolean; corner: number; clear: number; solid: number }>((resolve) => {
                const img = new Image()
                img.onload = () => {
                  const c = document.createElement('canvas')
                  c.width = c.height = 64
                  const ctx = c.getContext('2d')!
                  ctx.drawImage(img, 0, 0, 64, 64)
                  const d = ctx.getImageData(0, 0, 64, 64).data
                  let clear = 0
                  let solid = 0
                  for (let i = 3; i < d.length; i += 4) {
                    if (d[i] === 0) clear++
                    else if (d[i] === 255) solid++
                  }
                  resolve({ u, ok: true, corner: d[3], clear, solid })
                }
                img.onerror = () => resolve({ u, ok: false, corner: -1, clear: 0, solid: 0 })
                img.src = u
              }),
          ),
        ),
      urls,
    )
    expect(results).toHaveLength(36)
    for (const r of results) {
      expect(r.ok, r.u).toBe(true)
      if (r.u.includes('/transparent/')) {
        expect(r.corner, r.u).toBe(0)
        expect(r.clear, r.u).toBeGreaterThan(1000)
        expect(r.solid, r.u).toBeGreaterThan(200)
      } else {
        expect(r.corner, r.u).toBe(255)
        expect(r.clear, r.u).toBe(0)
      }
    }
  })
})
