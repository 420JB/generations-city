import { describe, expect, it } from 'vitest'
import { contribute } from '../game/actions'
import { buildingIdFor, createSeedState, SCENARIO } from '../game/seed'
import { homeDistrict } from '../game/season'
import { DEMO_PLAYER_ID } from './identity'
import { DISTRICT_FAMILY, DISTRICT_IDENTITIES, FAIRNESS_PRINCIPLE, FAMILIES, FAMILY_KEYS, familyAssetPath } from './districtIdentity'
import { DISTRICT_IDS, DISTRICTS, getDistrict } from './districts'
import { FAMILY_ART_METRICS } from './familyArtMetrics'

/** Every SVG under public/assets/families, as raw text keyed by public URL path. */
const ASSETS = Object.fromEntries(
  Object.entries(import.meta.glob('/public/assets/families/**/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>).map(([k, v]) => [
    k.replace(/^\/public/, ''),
    v,
  ]),
)
const asset = (url: string) => ASSETS[url.replace(import.meta.env.BASE_URL, '/')]

const EXPECTED: Record<string, string> = {
  d1: 'Hollow',
  d2: 'Sparkling',
  d3: 'Colossus',
  d4: 'Family',
  d5: 'Cellular',
  d6: 'Mask',
  d7: 'Asymmetry',
  d8: 'Skeleton',
  d9: 'Hoverer',
}

function pathOf(svg: string): string {
  const m = svg.match(/<path\b[^>]*\/>/g)
  expect(m).toHaveLength(1)
  return m![0]
}

describe('official family identities', () => {
  it('populates all nine districts with the product-owner mapping', () => {
    expect(DISTRICT_IDS).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9'])
    for (const id of DISTRICT_IDS) {
      const identity = DISTRICT_IDENTITIES[id]
      const d = getDistrict(id)
      expect(identity.officialName).toBe(EXPECTED[id])
      expect(d.name).toBe(EXPECTED[id])
      expect(d.title).toBe(`${EXPECTED[id]} District`)
      expect(d.familyKey).toBe(EXPECTED[id].toLowerCase())
      expect(DISTRICT_FAMILY[id]).toBe(d.familyKey)
      expect(identity.accent).toMatch(/^#[0-9a-f]{6}$/)
      expect(d.color).toBe(identity.accent)
      expect(identity.credit).toMatch(/supplied/)
      expect(d.name).not.toMatch(/^District \d/)
    }
    expect(new Set(DISTRICTS.map((d) => d.familyKey)).size).toBe(9)
    expect(new Set(DISTRICTS.map((d) => d.color)).size).toBe(9)
  })

  it('exposes primary, secondary and transparent art for every district', () => {
    for (const d of DISTRICTS) {
      expect(d.art.primary).toBe(familyAssetPath(d.familyKey, 1, false))
      expect(d.art.secondary).toBe(familyAssetPath(d.familyKey, 2, false))
      expect(d.art.primaryTransparent).toBe(familyAssetPath(d.familyKey, 1, true))
      expect(d.art.secondaryTransparent).toBe(familyAssetPath(d.familyKey, 2, true))
      for (const url of Object.values(d.art)) expect(asset(url), url).toBeTypeOf('string')
    }
  })

  it('ships exactly 18 source SVGs and 18 matching transparent derivatives', () => {
    const sources = Object.keys(ASSETS).filter((k) => !k.includes('/transparent/'))
    const derived = Object.keys(ASSETS).filter((k) => k.includes('/transparent/'))
    expect(sources).toHaveLength(18)
    expect(derived).toHaveLength(18)
    for (const key of FAMILY_KEYS) for (const v of [1, 2] as const) expect(sources).toContain(`/assets/families/${key}-${v}.svg`)
  })

  it('derived SVGs are the source minus ONLY the full-canvas black background rect', () => {
    for (const key of FAMILY_KEYS) {
      for (const v of [1, 2] as const) {
        const src = asset(familyAssetPath(key, v, false))
        const out = asset(familyAssetPath(key, v, true))
        expect(src).toMatch(/<rect width="512" height="512" fill="#000"\/>/)
        expect(out).not.toMatch(/<rect\b/)
        expect(out).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*viewBox="0 0 512 512"[^>]*>/)
        expect(out.trim().endsWith('</svg>')).toBe(true)
        expect(pathOf(out)).toBe(pathOf(src))
        expect(out).toBe(src.replace('<rect width="512" height="512" fill="#000"/>', ''))
      }
    }
  })

  it('generated silhouette metrics match the actual asset geometry', () => {
    for (const key of FAMILY_KEYS) {
      for (const v of [1, 2] as const) {
        const p = pathOf(asset(familyAssetPath(key, v, false)))
        const [tx, ty, k] = p.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/)!.slice(1).map(Number)
        const cells = [...p.matchAll(/M(\d+) (\d+)h(\d+)v1H\d+Z/g)].map((m) => m.slice(1).map(Number))
        expect(FAMILY_ART_METRICS[key][v]).toEqual({
          x0: tx + Math.min(...cells.map((c) => c[0])) * k,
          y0: ty + Math.min(...cells.map((c) => c[1])) * k,
          x1: tx + Math.max(...cells.map((c) => c[0] + c[2])) * k,
          y1: ty + Math.max(...cells.map((c) => c[1] + 1)) * k,
        })
      }
    }
  })
})

describe('family population metadata (informational only)', () => {
  it('classifies the four lower-supply families as rarer', () => {
    expect(FAMILY_KEYS.filter((k) => FAMILIES[k].supplyClass === 'rarer')).toEqual(['hollow', 'sparkling', 'colossus', 'hoverer'])
    for (const k of FAMILY_KEYS) {
      const [lo, hi] = FAMILIES[k].approxPopulation
      expect(lo).toBeLessThanOrEqual(hi)
      expect(FAMILIES[k].supplyClass === 'rarer' ? hi : lo).toBe(FAMILIES[k].supplyClass === 'rarer' ? 3_350 : 23_500)
    }
    expect(FAIRNESS_PRINCIPLE).toMatch(/active representative population/)
  })

  it('is not read by any game or scoring logic', () => {
    const game = import.meta.glob('/src/game/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    expect(Object.keys(game).length).toBeGreaterThan(5)
    for (const [file, text] of Object.entries(game)) {
      expect(text, file).not.toMatch(/supplyClass|approxPopulation|FAMILIES\b/)
    }
  })
})

describe('family identity in game flows', () => {
  it("the demo player's Home District (internal d4) resolves to Family", () => {
    const s = createSeedState()
    const home = homeDistrict(s, DEMO_PLAYER_ID)
    expect(home).toBe('d4')
    expect(getDistrict(home!).name).toBe('Family')
  })

  it('Capital identity resolves through the district config', () => {
    let s = createSeedState()
    expect(getDistrict(s.capital.holder!).title).toBe('Colossus District')
    s = contribute(s, buildingIdFor(SCENARIO.kingmakerFriend), DEMO_PLAYER_ID, 38).state
    s = contribute(s, buildingIdFor(SCENARIO.capitalFriend), DEMO_PLAYER_ID, 63).state
    expect(s.capital.holder).toBe('d4')
    expect(getDistrict(s.capital.holder!).title).toBe('Family District')
  })

  it('District Radio uses family names, never placeholder "District N"', () => {
    let s = createSeedState()
    s = contribute(s, buildingIdFor(SCENARIO.kingmakerFriend), DEMO_PLAYER_ID, 38).state
    s = contribute(s, buildingIdFor(SCENARIO.capitalFriend), DEMO_PLAYER_ID, 63).state
    const text = s.radio.map((r) => `${r.headline} ${r.detail}`).join('\n')
    expect(text).toMatch(/The Grand Fountain STOLEN/)
    expect(text).toMatch(/Family takes it from Sparkling/)
    expect(text).toMatch(/FAMILY DISTRICT IS THE NEW CAPITAL/)
    expect(text).not.toMatch(/District \d/)
  })
})
