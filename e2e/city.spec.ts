import { expect, test } from '@playwright/test'
import {
  contributeExact,
  makePng,
  num,
  openCity,
  selectBuilding,
  SHOTS,
  warpToKingmaker,
  warpToOwnBuilding,
} from './helpers.ts'

test.describe('Rare City', () => {
  test('loads the city with nine districts, Capital and Crown', async ({ page }) => {
    await openCity(page)
    await expect(page).toHaveTitle('Rare City')
    for (let i = 1; i <= 9; i++) await expect(page.getByTestId(`district-d${i}`)).toBeAttached()
    expect(await page.locator('[data-testid^="building-"][role="button"]').count()).toBeGreaterThanOrEqual(45)
    await expect(page.getByTestId('hud-capital')).toHaveAttribute('data-capital', 'd3')
    await expect(page.getByTestId('hud-crown')).toHaveAttribute('data-crown', '120')
    await expect(page.getByTestId('crown-spire')).toBeAttached()
    await expect(page.getByTestId('wallet')).toHaveText('25,000')
    // Season allegiance + guided objective are visible without extra screens.
    await expect(page.getByTestId('hud-season').locator('b')).toHaveAttribute('data-district', 'd4')
    await expect(page.getByTestId('hud-season')).toContainText('Home District')
    await expect(page.getByTestId('hud-season')).toContainText('Family')
    await expect(page.getByTestId('objective-marker')).toBeAttached()
    await expect(page.getByText('SIMULATED RF').first()).toBeVisible()
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${SHOTS}/01-city-overview.png` })
  })

  test('the map renders as one SVG root sharing a single camera viewBox', async ({ page }) => {
    await openCity(page)
    const roots = page.locator('[data-testid="city"] > svg')
    await expect(roots).toHaveCount(1)
    const svg = page.getByTestId('city-svg')
    await expect(svg).toHaveAttribute('role', 'application')
    // Ground and objects live in that same root.
    await expect(svg.locator('.ground-layer [data-testid="district-d4"]')).toBeAttached()
    await expect(svg.locator('[data-testid="building-812"]')).toBeAttached()
    const before = await svg.getAttribute('viewBox')
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(before)
    await expect(roots).toHaveCount(1)
  })

  test('Build Board surfaces the high-impact building and WARP flies to it', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('nav-board').click()
    const board = page.getByTestId('build-board')
    await expect(board).toBeVisible()
    const card = page.getByTestId('impact-0')
    await expect(card).toContainText('Demo Friend #812')
    await expect(card).toContainText('38 RF')
    await expect(card).toContainText('Captures The Grand Fountain from Sparkling')
    await page.getByTestId('impact-0-warp').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '812')
    await expect(page.getByTestId('building-812')).toHaveAttribute('data-selected', 'true')
    await expect(page.getByTestId('city')).toHaveAttribute('data-detail', 'near')
    await expect(page.getByTestId('rf-to-next')).toHaveText('38 RF to Tier 4')
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${SHOTS}/02-close-building.png` })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('building-panel')).toHaveCount(0)
  })

  test('simulated contribution changes Total and Community Build', async ({ page }) => {
    await openCity(page)
    await warpToKingmaker(page)
    const total = num(await page.getByTestId('total-built').textContent())
    const community = num(await page.getByTestId('community-built').textContent())
    const owner = num(await page.getByTestId('owner-built').textContent())
    await page.getByTestId('amount-10').click()
    await expect(page.getByTestId('confirm-box')).toContainText('No real tokens move.')
    await page.getByTestId('confirm-contribution').click()
    await expect(page.getByTestId('total-built')).toHaveText((total + 10).toLocaleString('en-US'))
    await expect(page.getByTestId('community-built')).toHaveText((community + 10).toLocaleString('en-US'))
    await expect(page.getByTestId('owner-built')).toHaveText(owner.toLocaleString('en-US'))
    await expect(page.getByTestId('wallet')).toHaveText('24,990')
    await expect(page.getByTestId('patron-demo-player')).toBeAttached({ timeout: 1 }).catch(() => undefined)
    await page.getByTestId('view-patrons').click()
    await expect(page.getByTestId('patron-demo-player')).toContainText('10')
  })

  test('seeded tier-up captures the T4 monument and awards Closer + Kingmaker', async ({ page }) => {
    await openCity(page)
    await expect(page.getByTestId('hud-mon-m4')).toHaveAttribute('data-holder', 'd2')
    await expect(page.getByTestId('monument-m4')).toHaveAttribute('data-district', 'd2')
    await expect(page.getByTestId('monument-m4')).toHaveAttribute('data-kind', 'fountain')
    await warpToKingmaker(page)
    await contributeExact(page)

    // Building crossed the tier
    await expect(page.getByTestId('panel-tier')).toContainText('4')
    await expect(page.getByTestId('building-812')).toHaveAttribute('data-tier', '4')
    // Monument moved Sparkling (internal d2) -> Family (internal d4)
    await expect(page.getByTestId('hud-mon-m4')).toHaveAttribute('data-holder', 'd4')
    await expect(page.getByTestId('monument-m4')).toHaveAttribute('data-district', 'd4')
    await expect(page.getByTestId('announcements')).toContainText('MONUMENT CAPTURED')
    await expect(page.locator('.radio-ticker')).toContainText('The Grand Fountain STOLEN')
    await expect(page.getByTestId('badge-toast').filter({ hasText: 'Kingmaker' })).toBeVisible()
    // Pull back to the overview while the old monument is still collapsing and the transfer arc is drawn.
    await page.getByRole('button', { name: 'City overview' }).click()
    // The old Sparkling fountain is still collapsing (it was culled while zoomed in on Family).
    await expect(page.getByTestId('monument-ruin-m4')).toHaveAttribute('data-district', 'd2')
    await page.waitForTimeout(1000)
    // City Hall's registry pylon (culled while zoomed in) now shows the new holder.
    await expect(page.getByTestId('pylon-m4')).toHaveAttribute('data-holder', 'd4')
    // The game viewport must never scroll (regression: focus used to scroll the fixed app shell).
    expect(await page.evaluate(() => { const a = document.querySelector('.app')!; return a.scrollTop + a.scrollLeft })).toBe(0)
    await page.screenshot({ path: `${SHOTS}/03-monument-capture.png` })

    await page.getByTestId('nav-profile').click()
    await expect(page.getByTestId('badge-closer')).toHaveAttribute('data-earned', 'true')
    await expect(page.getByTestId('badge-kingmaker')).toHaveAttribute('data-earned', 'true')
    await expect(page.getByTestId('badge-good-neighbor')).toHaveAttribute('data-earned', 'true')
    await expect(page.getByTestId('stat-tierups')).toHaveText('1')
    await expect(page.getByTestId('stat-captures')).toHaveText('1')
    await expect(page.getByTestId('stat-contributed')).toHaveText('38')
  })

  test('Capital and Crown can change hands through the same economy', async ({ page }) => {
    await openCity(page)
    await warpToKingmaker(page)
    await contributeExact(page)
    await expect(page.getByTestId('hud-capital')).toHaveAttribute('data-capital', 'd3')
    await selectBuilding(page, 288)
    await expect(page.getByTestId('rf-to-next')).toHaveText('63 RF to Tier 3')
    await contributeExact(page)
    await expect(page.getByTestId('hud-capital')).toHaveAttribute('data-capital', 'd4')
    await expect(page.getByTestId('announcements')).toContainText('NEW CAPITAL')
    await page.getByRole('button', { name: 'City overview' }).click()
    await expect(page.getByTestId('city-hall')).toHaveAttribute('data-capital', 'd4')
    await expect(page.getByTestId('capital-sign-name')).toHaveText('FAMILY DISTRICT')
    await expect(page.getByTestId('capital-sign-name')).toHaveAttribute('data-family', 'family')
    await expect(page.getByTestId('capital-ground')).toHaveAttribute('data-district', 'd4')
    await expect(page.getByTestId('capital-crest')).toBeAttached()

    await selectBuilding(page, 505)
    await page.locator('#custom-amt').fill('2501')
    await page.getByRole('button', { name: 'Set', exact: true }).click()
    await expect(page.getByTestId('confirm-box')).toContainText('Takes the City Crown')
    await page.getByTestId('confirm-contribution').click()
    await expect(page.getByTestId('hud-crown')).toHaveAttribute('data-crown', '505')
  })

  test('owner fixture purchase increases Owner Built and Total Built', async ({ page }) => {
    await openCity(page)
    await warpToOwnBuilding(page)
    await page.getByTestId('open-architect').click()
    const owner0 = num(await page.getByTestId('arch-owner-built').textContent())
    const total0 = num(await page.getByTestId('arch-total-built').textContent())
    await page.getByTestId('tab-fixtures').click()
    await page.getByTestId('buy-premium-roof').click()
    await expect(page.getByTestId('fixture-premium-roof')).toContainText('SIMULATED RF')
    await page.getByTestId('confirm-fixture-premium-roof').click()
    await expect(page.getByTestId('arch-owner-built')).toHaveText((owner0 + 1200).toLocaleString('en-US'))
    await expect(page.getByTestId('arch-total-built')).toHaveText((total0 + 1200).toLocaleString('en-US'))
    await expect(page.getByTestId('fixture-premium-roof')).toContainText('Installed')
    await expect(page.getByTestId('wallet')).toHaveText('23,800')
  })

  test('owner customization changes architecture and landscaping', async ({ page }) => {
    await openCity(page)
    await warpToOwnBuilding(page)
    await page.getByTestId('open-architect').click()
    const bldg = page.getByTestId('building-4471')
    await expect(bldg).toHaveAttribute('data-facade', 'limestone')
    await page.getByTestId('arch-facade-brick').click()
    await expect(bldg).toHaveAttribute('data-facade', 'brick')
    await expect(page.getByTestId('arch-facade-brick')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('arch-roof-crown-deck')).toBeDisabled()
    await page.getByTestId('arch-roof-spire').click()
    await expect(bldg).toHaveAttribute('data-roof', 'spire')
    await page.getByTestId('arch-lighting-neon').click()
    await expect(bldg).toHaveAttribute('data-lighting', 'neon')

    await page.getByTestId('tab-landscape').click()
    await expect(page.getByTestId('slot-0')).toHaveAttribute('data-item', 'tree')
    await page.getByTestId('slot-2').click()
    await page.getByTestId('place-lamp').click()
    await expect(page.getByTestId('slot-2')).toHaveAttribute('data-item', 'lamp')
    await page.getByTestId('slot-0').click()
    await page.getByTestId('slot-2').click()
    await expect(page.getByTestId('slot-0')).toHaveAttribute('data-item', 'lamp')
    await expect(page.getByTestId('slot-2')).toHaveAttribute('data-item', 'tree')
    await page.getByTestId('tab-design').click()
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${SHOTS}/04-architect-mode.png` })
  })

  test('billboard unlock, edit framing, save, cancel, replace and remove', async ({ page }) => {
    await openCity(page)
    await warpToOwnBuilding(page)
    await page.getByTestId('open-architect').click()
    await page.getByTestId('tab-billboard').click()
    await expect(page.getByTestId('media-ladder')).toContainText('Landmark crown screen')
    await page.getByTestId('buy-billboard').click()
    await page.getByTestId('confirm-fixture-billboard').click()
    await expect(page.getByTestId('billboard-4471')).toHaveAttribute('data-media', 'facade')
    await expect(page.getByTestId('billboard-preview')).toContainText('No image yet')

    // Upload -> EDIT mode with a 2:1 crop frame. Nothing is saved yet.
    await page.getByTestId('billboard-input').setInputFiles({ name: 'friend.png', mimeType: 'image/png', buffer: makePng(300, 300) })
    const frame = page.getByTestId('billboard-frame')
    await expect(frame).toBeVisible()
    const box = (await frame.boundingBox())!
    expect(Math.round(box.width / box.height)).toBe(2)
    const f0 = await frame.getAttribute('data-framing')
    await page.getByTestId('billboard-zoom').fill('250')
    await expect(frame).not.toHaveAttribute('data-framing', f0!)
    // Drag to reposition
    const f1 = await frame.getAttribute('data-framing')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20, { steps: 4 })
    await page.mouse.up()
    await expect(frame).not.toHaveAttribute('data-framing', f1!)
    // Live preview appears on the tower while editing
    await expect(page.getByTestId('billboard-4471').locator('[data-billboard-image]')).toBeAttached()
    await page.getByTestId('billboard-save').click()
    await expect(page.getByTestId('billboard-editor')).toHaveCount(0)
    await expect(page.getByTestId('billboard-preview').locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/)
    await expect(page.getByTestId('billboard-4471').locator('[data-billboard-image]')).toBeAttached()
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${SHOTS}/05-billboard.png` })
    const saved = await page.getByTestId('billboard-preview').locator('img').getAttribute('src')

    // Replace, then CANCEL -> previous billboard restored
    await page.getByTestId('billboard-input').setInputFiles({ name: 'friend2.png', mimeType: 'image/png', buffer: makePng(40, 120) })
    await expect(page.getByTestId('billboard-editor')).toBeVisible()
    await page.getByTestId('billboard-cancel').click()
    await expect(page.getByTestId('billboard-preview').locator('img')).toHaveAttribute('src', saved!)
    await expect(page.getByTestId('billboard-4471').locator('[data-billboard-image]')).toHaveAttribute('href', saved!)

    // Replace and SAVE -> new image
    await page.getByTestId('billboard-input').setInputFiles({ name: 'friend3.png', mimeType: 'image/png', buffer: makePng(40, 120) })
    await page.getByTestId('billboard-save').click()
    await expect.poll(async () => page.getByTestId('billboard-preview').locator('img').getAttribute('src')).not.toBe(saved)

    // Re-frame the current image
    await page.getByTestId('billboard-reframe').click()
    await expect(page.getByTestId('billboard-editor')).toBeVisible()
    await page.getByTestId('billboard-cancel').click()

    await page.getByTestId('billboard-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await expect(page.getByRole('alert')).toContainText('JPEG, PNG or WebP')

    await page.getByTestId('billboard-remove').click()
    await expect(page.getByTestId('billboard-preview')).toContainText('No image yet')
    await expect(page.getByTestId('billboard-4471').locator('[data-billboard-image]')).toHaveCount(0)
  })

  test('billboard media stays visible at far, mid and near zoom', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('guide-hide').click()
    await warpToOwnBuilding(page)
    await page.getByTestId('open-architect').click()
    await page.getByTestId('tab-billboard').click()
    await page.getByTestId('buy-billboard').click()
    await page.getByTestId('confirm-fixture-billboard').click()
    await page.getByTestId('billboard-input').setInputFiles({ name: 'ad.png', mimeType: 'image/png', buffer: makePng(200, 100) })
    await page.getByTestId('billboard-save').click()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'City overview' }).click()
    const city = page.getByTestId('city')
    const billboard = page.getByTestId('billboard-4471')
    // The wheel takes over the camera and cancels a flight in progress, so let the overview
    // actually reach far zoom before any wheel input.
    await expect(city).toHaveAttribute('data-detail', 'far')
    for (const detail of ['far', 'mid', 'near'] as const) {
      // Zoom about the tower (wheel zooms around the cursor) until this detail level is reached.
      await expect
        .poll(async () => {
          const current = await city.getAttribute('data-detail')
          if (current !== detail) {
            const box = (await page.getByTestId('building-4471').boundingBox())!
            await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3)
            await page.mouse.wheel(0, -150)
          }
          return city.getAttribute('data-detail')
        }, { intervals: [300], timeout: 20_000 })
        .toBe(detail)
      await expect(billboard).toHaveAttribute('data-detail', detail)
      await expect(billboard.locator('[data-billboard-image]')).toHaveAttribute('href', /^data:image\/jpeg;base64,/)
      await expect(billboard).toBeVisible()
    }
  })

  test('demo guide can be dismissed, reopened, survives reload and RESET restores it', async ({ page }) => {
    await openCity(page)
    const guide = page.getByTestId('demo-guide')
    await expect(guide).toBeVisible()
    await page.getByTestId('guide-hide').click()
    await expect(guide).toHaveCount(0)
    await expect(page.getByTestId('guide-reminder')).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('city')).toBeVisible()
    await expect(guide).toHaveCount(0)
    await page.getByTestId('nav-help').click()
    await expect(guide).toBeVisible()
    await page.getByTestId('guide-hide').click()
    await page.getByTestId('guide-reminder').click()
    await expect(guide).toBeVisible()
    // Guide tracks real progress
    await page.getByTestId('intro-open-board').click()
    await page.getByTestId('guide-warp').click()
    await contributeExact(page)
    await expect(guide).toHaveAttribute('data-complete', 'true')
    await page.getByTestId('guide-hide').click()
    await page.getByTestId('reset-demo').click()
    await page.getByTestId('confirm-reset').click()
    await expect(guide).toBeVisible()
    await expect(guide).toHaveAttribute('data-complete', 'false')
  })

  test('the city grows: a Friend joining a full district opens a new ward', async ({ page }) => {
    await openCity(page)
    await expect(page.getByTestId('ward-d4-1')).toHaveCount(0)
    await expect(page.getByTestId('ghost-ward-d4')).toHaveAttribute('data-ward', '1')
    await page.getByTestId('nav-standings').click()
    await expect(page.getByTestId('growth-d4')).toHaveAttribute('data-wards', '1')
    await page.getByTestId('join-d4').click()
    // Family is full: the picker previews Ward II; nothing opens until a plot is confirmed.
    await page.getByTestId('candidate-plot-d4-1-0').click()
    await expect(page.getByTestId('ward-d4-1')).toHaveCount(0)
    await page.getByTestId('placement-confirm').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '20001')
    await expect(page.getByTestId('ward-d4-1')).toBeAttached()
    await expect(page.getByTestId('ghost-ward-d4')).toHaveAttribute('data-ward', '2')
    await expect(page.getByTestId('announcements')).toContainText('THE CITY GROWS')
    await expect(page.locator('.radio-ticker')).toContainText('OPENS WARD II')
    await expect(page.getByTestId('building-20001')).toHaveAttribute('data-tier', '0')
    // Joining a district with a free plot does not open a ward
    await page.getByTestId('nav-standings').click()
    await page.getByTestId('join-d1').click()
    await page.locator('[data-testid^="candidate-plot-d1-0-"]').first().click()
    await page.getByTestId('placement-confirm').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '20002')
    await expect(page.getByTestId('ward-d1-1')).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('ward-d4-1')).toBeAttached()
  })

  test('season allegiance: locked Home District and cross-district warning', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('nav-profile').click()
    await expect(page.getByTestId('season-card')).toContainText('DEMO SEASON 1')
    await expect(page.getByTestId('representative')).toHaveText('Demo Friend #4471')
    await expect(page.getByTestId('allegiance-locked')).toBeVisible()
    await expect(page.getByTestId('change-representative')).toBeDisabled()
    // Home-district construction: no warning
    await page.getByTestId('friend-search').fill('812')
    await page.getByTestId('friend-search-go').click()
    await page.getByTestId('amount-10').click()
    await expect(page.getByTestId('confirm-box')).toBeVisible()
    await expect(page.getByTestId('allegiance-warning')).toHaveCount(0)
    // Rival district (the Crown holder in Asymmetry, internal d7): warned, still allowed
    await page.getByTestId('friend-search').fill('120')
    await page.getByTestId('friend-search-go').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '120')
    await page.getByTestId('amount-10').click()
    await expect(page.getByTestId('allegiance-warning')).toContainText('This construction strengthens another district.')
    const before = await page.getByTestId('total-built').textContent()
    await page.getByTestId('confirm-contribution').click()
    await expect(page.getByTestId('total-built')).not.toHaveText(before!)
    // The player's own Friend in another district is also flagged
    await page.getByTestId('friend-search').fill('3710')
    await page.getByTestId('friend-search-go').click()
    await expect(page.getByTestId('allegiance-note')).toContainText('Asymmetry District')
    await expect(page.getByTestId('building-address')).toContainText('Founding Ward')
  })

  test('search warps to any Friend and explains unknown ones', async ({ page }) => {
    await openCity(page)
    await page.getByTestId('friend-search').fill('288')
    await page.getByTestId('friend-search-go').click()
    await expect(page.getByTestId('building-panel')).toHaveAttribute('data-building', '288')
    await expect(page.getByTestId('building-288')).toHaveAttribute('data-selected', 'true')
    await page.getByTestId('friend-search').fill('999999')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('notice')).toContainText("hasn't joined")
    await expect(page.getByTestId('player-marker').first()).toBeAttached()
  })

  test('reload preserves localStorage state, and RESET DEMO restores the seed', async ({ page }) => {
    await openCity(page)
    await warpToKingmaker(page)
    await contributeExact(page)
    await expect(page.getByTestId('hud-mon-m4')).toHaveAttribute('data-holder', 'd4')

    await page.reload()
    await expect(page.getByTestId('city')).toBeVisible()
    await expect(page.getByTestId('hud-mon-m4')).toHaveAttribute('data-holder', 'd4')
    await expect(page.getByTestId('wallet')).toHaveText('24,962')
    await expect(page.getByTestId('building-812')).toHaveAttribute('data-tier', '4')

    await page.getByTestId('reset-demo').click()
    await page.getByTestId('confirm-reset').click()
    await expect(page.getByTestId('hud-mon-m4')).toHaveAttribute('data-holder', 'd2')
    await expect(page.getByTestId('wallet')).toHaveText('25,000')
    await expect(page.getByTestId('building-812')).toHaveAttribute('data-total', '9962')

    await page.reload()
    await expect(page.getByTestId('hud-mon-m4')).toHaveAttribute('data-holder', 'd2')
    await expect(page.getByTestId('building-812')).toHaveAttribute('data-total', '9962')
    await page.getByTestId('nav-profile').click()
    await expect(page.getByTestId('badge-kingmaker')).toHaveAttribute('data-earned', 'false')
  })

  test('reduced motion: WARP and contribution still work without animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openCity(page)
    await warpToKingmaker(page)
    await expect(page.getByTestId('city')).toHaveAttribute('data-detail', 'near')
    await contributeExact(page)
    await expect(page.getByTestId('hud-mon-m4')).toHaveAttribute('data-holder', 'd4')
  })

  test('District Radio rally ping and deterministic rival move', async ({ page }) => {
    await openCity(page)
    await selectBuilding(page, 288)
    await page.getByTestId('rally-btn').click()
    await expect(page.locator('.radio-ticker')).toContainText('RALLY DEMO FRIEND #288')
    await page.getByTestId('nav-radio').click()
    await page.getByTestId('rival-turn').click()
    await expect(page.getByTestId('radio-list')).toContainText('reached Tier')
  })
})
