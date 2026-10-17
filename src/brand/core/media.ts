/**
 * BRAND MEDIA SAFETY: which image references a brand configuration may put on the map.
 *
 * A brand's logo, capital crest and District Monument artwork come from configuration,
 * which is not this app's code. Before any of it reaches an `<image href>`, it must be one of:
 *
 *   - a same-origin path under an approved media prefix (`/brand-media/…`): plain path
 *     characters only, no `..`, no `//`, no query or fragment, a raster or SVG extension;
 *   - a bounded base64 `data:` URL of a raster type (PNG, JPEG, WebP), never SVG.
 *
 * Everything else (http/https URLs, protocol-relative `//host`, `javascript:`, `blob:`,
 * IPFS gateways, SVG data, anything malformed) is refused, and the renderer draws the
 * standard fallback instead. So a configuration cannot make the city fetch from a third
 * party (tracking, mixed content, an unvetted image host) or smuggle markup, whatever the
 * page's Content-Security-Policy says. Real NFT artwork must first be fetched, checked and
 * re-served same-origin by a server-side media proxy, which does not exist yet.
 *
 * Portable: no browser or server dependency.
 */
export const BRAND_MEDIA_PREFIX = '/brand-media/'

const MAX_PATH = 200
const PATH = /^\/brand-media\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.(?:png|jpe?g|webp|svg)$/
/** Longest accepted data URL (characters): about 190 KB of image. */
export const MAX_DATA_URL = 256_000
const DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/

export type MediaRefProblem = 'not-a-string' | 'external-url' | 'unsafe-path' | 'unsupported-data' | 'too-large'

export type VettedMedia = { ok: true; href: string } | { ok: false; problem: MediaRefProblem }

/** Vet one media reference. Pure: nothing is fetched. */
export function vetMediaRef(input: unknown): VettedMedia {
  if (typeof input !== 'string') return { ok: false, problem: 'not-a-string' }
  if (input.startsWith('data:')) {
    if (input.length > MAX_DATA_URL) return { ok: false, problem: 'too-large' }
    return DATA_URL.test(input) ? { ok: true, href: input } : { ok: false, problem: 'unsupported-data' }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) || input.startsWith('//')) return { ok: false, problem: 'external-url' }
  if (input.length > MAX_PATH || input.includes('..') || input.includes('//') || !PATH.test(input)) return { ok: false, problem: 'unsafe-path' }
  return { ok: true, href: input }
}

/** The vetted href, or null (draw the fallback). */
export function safeMediaHref(input: unknown): string | null {
  const v = vetMediaRef(input)
  return v.ok ? v.href : null
}
