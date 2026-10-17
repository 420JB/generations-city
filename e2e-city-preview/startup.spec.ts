import { expect, test } from '@playwright/test'

/**
 * Startup smoke test: the page must replace its "Raising the skyline…" placeholder with the real
 * city, cleanly. Runs against BOTH the dev server (`npm run dev:city-preview`) and the built page,
 * because the two resolve the entry script differently: a build-only test once passed while the
 * dev server 404'd the entry module and the page stayed on its placeholder.
 */
test('the city replaces the loading placeholder, survives a reload and a brand switch', async ({ page }) => {
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`) })
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`))
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`${r.status()}: ${r.url()}`) })

  const expectCity = async (districts: string) => {
    await expect(page.getByText('Raising the skyline')).toHaveCount(0)
    await expect(page.locator('.boot')).toHaveCount(0)
    await expect(page.getByTestId('city-svg')).toBeVisible()
    await expect(page.getByTestId('preview-app')).toHaveAttribute('data-districts', districts)
    expect(await page.locator('.bldg').count()).toBeGreaterThan(50)
  }

  await page.goto('/')
  await expectCity('4')
  await page.getByTestId('brand-1').click()
  await expectCity('6')
  await page.reload()
  await expectCity('4')
  expect(problems).toEqual([])
})
