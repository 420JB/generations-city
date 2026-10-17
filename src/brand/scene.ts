import { MONUMENTS } from '../config/monuments'
import type { World } from '../world/definition'
import { districtOf } from '../world/definition'
import type { BrandCityConfig } from './core/config'
import type { SampleNft } from './core/sampleCity'
import type { CityScene, SceneBuilding, SceneDistrict, StatueArt } from '../ui/city/scene'

/**
 * BRAND ADAPTER: a validated brand configuration (and its compiled world) as a scene for the
 * one city renderer. Only labels, accents, crests and monument art come from the brand;
 * every district's wedge comes from the compiled world, so what is drawn is exactly what the
 * engine's plot ids mean.
 *
 * Media in the configuration were vetted by `parseBrandCityConfig`; the only other image
 * this adapter makes is a monogram crest, drawn from a single letter or digit.
 */
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX']

/** Mix two `#rrggbb` colours: t = 0 gives `a`, t = 1 gives `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
  return `#${[0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0')).join('')}`
}

/** First letter or digit of a name, upper-cased; a star when there is none. */
export function monogramOf(name: string): string {
  const m = /[A-Za-z0-9]/.exec(name)
  return m ? m[0].toUpperCase() : '★'
}

/** A crest made here, never from configuration text beyond one vetted character. */
function monogramCrest(letter: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="3"/><text x="32" y="43" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="30" font-weight="900" fill="#f3f5fb">${letter === '★' ? '&#9733;' : letter}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** The standard monuments, with the T5 Friend Statue named as the brand-neutral District Monument. */
export const BRAND_MONUMENTS = MONUMENTS.map((m) =>
  m.kind === 'statue' ? { ...m, name: 'The District Monument', short: 'T5 Monument', blurb: "Bronze stele bearing the holding district's monument NFT · most Tier 5+ buildings" } : m,
)

export function brandScene(config: BrandCityConfig, world: World, nfts: Readonly<Record<string, SampleNft>> = {}): CityScene {
  const collections = new Map(config.collections.map((c) => [c.key, c]))
  const brandCrest = config.brand.logo
  const districts: SceneDistrict[] = config.districts.map((d, i) => {
    const geo = districtOf(world, d.key)
    if (!geo) throw new Error(`District ${d.key} is not in the compiled world`)
    const crest = brandCrest ?? monogramCrest(monogramOf(config.brand.name), d.accent)
    return Object.freeze({
      id: d.key,
      index: i + 1,
      centerDeg: geo.centerDeg,
      spanDeg: geo.spanDeg,
      name: d.name,
      title: `${d.name} District`,
      sigil: ROMAN[i] ?? String(i + 1),
      color: d.accent,
      glow: mixHex(d.accent, '#ffffff', 0.5),
      ground: mixHex(d.accent, '#0b0f1a', 0.86),
      crest,
      banner: crest,
      // Prefixed so a district key can never collide with the renderer's own paint ids (glow-warm, beam-gold, …).
      paint: `bd-${d.key}`,
      familyKey: null,
    })
  })
  const byKey = new Map(config.districts.map((d) => [d.key, d]))

  const statueFor = (districtId: string): StatueArt => {
    const d = byKey.get(districtId)
    if (!d) throw new Error(`Unknown district ${districtId}`)
    const m = d.monument
    if (m?.artwork) {
      const c = collections.get(m.collection)
      return { kind: 'portrait', name: d.name, image: m.artwork, caption: `${c?.displayName ?? m.collection} #${m.tokenId}` }
    }
    return { kind: 'emblem', name: d.name, monogram: monogramOf(d.name) }
  }

  const buildingLabel = (b: SceneBuilding): string => {
    const nft = nfts[b.id]
    const c = nft ? collections.get(nft.collection) : undefined
    return c ? `${c.displayName} #${nft!.tokenId}` : `Property #${b.friendId}`
  }

  return Object.freeze({
    key: config.worldId,
    cityName: config.cityName,
    districts: Object.freeze(districts),
    monuments: BRAND_MONUMENTS,
    capital: Object.freeze({ name: config.capital.name, signKicker: `${config.capital.name} · Capital of ${config.cityName}`.toUpperCase(), crest: config.capital.crest ?? brandCrest ?? undefined }),
    resident: Object.freeze({ one: 'Member', many: 'Members' }),
    statueFor,
    buildingLabel,
  })
}
