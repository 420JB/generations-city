import type { FixtureId } from './fixtures'

/** Curated, modular architecture. Only the building owner may change these. */
export interface ArchitectureConfig {
  facade: string
  roof: string
  windows: string
  entrance: string
  crest: string
  rooftop: string
  lighting: string
}
export type ArchitectureSlot = keyof ArchitectureConfig

export interface ArchOption {
  id: string
  label: string
  minTier?: number
  minArchitectLevel?: number
  requiresFixture?: FixtureId
}

export interface FacadePalette {
  left: string
  right: string
  top: string
  trim: string
}

export const FACADE_PALETTES: Record<string, FacadePalette> = {
  slate: { left: '#2c3547', right: '#3b475e', top: '#56627a', trim: '#8391ab' },
  limestone: { left: '#6f685d', right: '#8d8577', top: '#aaa293', trim: '#d9cfbb' },
  brick: { left: '#5a3026', right: '#7a4436', top: '#935a49', trim: '#c98e73' },
  obsidian: { left: '#12151f', right: '#1d2230', top: '#2c3345', trim: '#6c7a9c' },
  copper: { left: '#8a4a28', right: '#b86b3c', top: '#cf8a5a', trim: '#6fd1b8' },
  jade: { left: '#1f574c', right: '#2f7d6d', top: '#46a18e', trim: '#b4f0dc' },
  aurora: { left: '#27406a', right: '#3c5f8f', top: '#5f86bb', trim: '#b7e3ff' },
}

/**
 * Exterior colors a brand city's Architect design may finish a facade material in (P1-E6), by name. Each is the three face
 * tones and the trim of a facade, in the value range of the material palettes above, so a colored building sits in the
 * night city as the materials do. `natural` is not here: it is the material's own palette, exactly as before.
 */
export const EXTERIOR_COLORS: Readonly<Record<string, FacadePalette>> = Object.freeze({
  ivory: { left: '#77705f', right: '#958d79', top: '#b2a991', trim: '#ebe2c9' },
  sand: { left: '#79623f', right: '#987d54', top: '#b3976a', trim: '#e9cf9d' },
  terracotta: { left: '#753523', right: '#984a31', top: '#b26245', trim: '#eba17c' },
  rose: { left: '#744155', right: '#94586e', top: '#b07489', trim: '#f2b6c8' },
  crimson: { left: '#621c25', right: '#852833', top: '#a33b46', trim: '#ec8088' },
  'copper-orange': { left: '#87471b', right: '#ad612b', top: '#c77d44', trim: '#f3b47e' },
  'forest-green': { left: '#1c472c', right: '#28613d', top: '#3a7c52', trim: '#9ed6aa' },
  sage: { left: '#4b604d', right: '#637c66', top: '#7f977c', trim: '#c6dabf' },
  'ocean-blue': { left: '#1c466c', right: '#28608d', top: '#3c7bab', trim: '#a9d5f5' },
  navy: { left: '#182245', right: '#22305b', top: '#324273', trim: '#8d9dd3' },
  lavender: { left: '#4b436c', right: '#62598b', top: '#7f73a6', trim: '#cfc2f1' },
  charcoal: { left: '#222429', right: '#2e3137', top: '#40444c', trim: '#9ca2ac' },
})

/** Mixes a `#rrggbb` color toward white (t > 0) or black (t < 0) by |t|. Pure; used only on this file's constants. */
function tone(hex: string, t: number): string {
  const to = t > 0 ? 255 : 0
  const k = Math.abs(t)
  const ch = (i: number) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - k) + to * k)
  return `#${[1, 3, 5].map((i) => ch(i).toString(16).padStart(2, '0')).join('')}`
}

/**
 * How each Architect facade material carries an exterior color (P1-E6): a tone the material gives every color (pale
 * limestone, dark slate) and, for copper, its verdigris trim, so a material keeps its character in any color. Its surface
 * (brick courses, slate cladding, ...) is drawn over the color by the renderer (`surface-<material>` paint, `CityDefs`).
 */
const MATERIAL_FINISH: Readonly<Record<string, { tone: number; trim?: string }>> = Object.freeze({
  slate: { tone: -0.1 },
  limestone: { tone: 0.12 },
  brick: { tone: -0.03 },
  copper: { tone: 0.02, trim: FACADE_PALETTES.copper.trim },
  jade: { tone: 0.04 },
})

/** The facade materials that have a drawn surface under an exterior color. */
export const SURFACE_MATERIALS: readonly string[] = Object.freeze(Object.keys(MATERIAL_FINISH))

const exteriorCache = new Map<string, FacadePalette>()

/**
 * The palette of `facade` finished in exterior color `color` (an `EXTERIOR_COLORS` key): the color's tones as the material
 * carries them. Null for any other color (`natural` included: the material's own palette is drawn, exactly as before) or a
 * material with no finish.
 */
export function exteriorPalette(facade: string, color: string): FacadePalette | null {
  if (!Object.hasOwn(EXTERIOR_COLORS, color) || !Object.hasOwn(MATERIAL_FINISH, facade)) return null
  const key = `${facade}/${color}`
  let pal = exteriorCache.get(key)
  if (!pal) {
    const c = EXTERIOR_COLORS[color]
    const m = MATERIAL_FINISH[facade]
    pal = { left: tone(c.left, m.tone), right: tone(c.right, m.tone), top: tone(c.top, m.tone), trim: m.trim ?? c.trim }
    exteriorCache.set(key, pal)
  }
  return pal
}

export const LIGHTING_COLORS: Record<string, { window: string; accent: string }> = {
  warm: { window: '#ffd48a', accent: '#ffb34d' },
  cool: { window: '#bfe6ff', accent: '#7cc8ff' },
  neon: { window: '#ff9df0', accent: '#5ff3ff' },
  gold: { window: '#ffe9a8', accent: '#ffc933' },
}

export const ARCH_OPTIONS: Record<ArchitectureSlot, readonly ArchOption[]> = {
  facade: [
    { id: 'slate', label: 'Slate' },
    { id: 'limestone', label: 'Limestone' },
    { id: 'brick', label: 'Brick' },
    { id: 'obsidian', label: 'Obsidian', minArchitectLevel: 2 },
    { id: 'copper', label: 'Copper', requiresFixture: 'premium-facade' },
    { id: 'jade', label: 'Jade', requiresFixture: 'premium-facade' },
    { id: 'aurora', label: 'Aurora Glass', requiresFixture: 'premium-facade', minTier: 4 },
  ],
  roof: [
    { id: 'flat', label: 'Flat Deck' },
    { id: 'terrace', label: 'Terrace', minTier: 2 },
    { id: 'dome', label: 'Dome', minTier: 2, minArchitectLevel: 1 },
    { id: 'spire', label: 'Spire', minTier: 3 },
    { id: 'crown-deck', label: 'Crown Deck', minTier: 3, requiresFixture: 'premium-roof' },
    { id: 'halo', label: 'Halo', minTier: 4, requiresFixture: 'premium-roof' },
  ],
  windows: [
    { id: 'grid', label: 'Grid' },
    { id: 'ribbon', label: 'Ribbon' },
    { id: 'arched', label: 'Arched', minArchitectLevel: 1 },
    { id: 'lattice', label: 'Lattice', minArchitectLevel: 2 },
    { id: 'panoramic', label: 'Panoramic', minTier: 4 },
  ],
  entrance: [
    { id: 'simple', label: 'Simple' },
    { id: 'awning', label: 'Awning' },
    { id: 'arch', label: 'Arch', requiresFixture: 'entrance-upgrade' },
    { id: 'portico', label: 'Grand Portico', minTier: 3, requiresFixture: 'entrance-upgrade' },
  ],
  crest: [
    { id: 'none', label: 'None' },
    { id: 'star', label: 'Star', requiresFixture: 'crest' },
    { id: 'leaf', label: 'Leaf', requiresFixture: 'crest' },
    { id: 'wave', label: 'Wave', requiresFixture: 'crest' },
    { id: 'sun', label: 'Sun', requiresFixture: 'crest' },
  ],
  rooftop: [
    { id: 'none', label: 'None' },
    { id: 'antenna', label: 'Antenna' },
    { id: 'garden', label: 'Roof Garden', minArchitectLevel: 1 },
    { id: 'beacon', label: 'Beacon Light', minArchitectLevel: 3 },
    { id: 'helipad', label: 'Helipad', minTier: 4 },
    { id: 'sign', label: 'Rooftop Sign', requiresFixture: 'rooftop-sign' },
  ],
  lighting: [
    { id: 'warm', label: 'Warm' },
    { id: 'cool', label: 'Cool' },
    { id: 'neon', label: 'Neon', minArchitectLevel: 2 },
    { id: 'gold', label: 'Gold', minArchitectLevel: 4 },
  ],
}

export const ARCH_SLOT_LABELS: Record<ArchitectureSlot, string> = {
  facade: 'Facade',
  roof: 'Roof',
  windows: 'Windows',
  entrance: 'Entrance',
  crest: 'Crest',
  rooftop: 'Rooftop Fixture',
  lighting: 'Lighting',
}

export const DEFAULT_ARCHITECTURE: ArchitectureConfig = {
  facade: 'slate',
  roof: 'flat',
  windows: 'grid',
  entrance: 'simple',
  crest: 'none',
  rooftop: 'none',
  lighting: 'warm',
}
