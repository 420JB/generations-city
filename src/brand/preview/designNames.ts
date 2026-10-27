import { appearanceOf, ARCHITECT_DESIGN_V1, ARCHITECT_DESIGN_V2, ARCHITECT_DESIGN_V3, DESIGN_SLOTS, type DesignChoice, type DesignSlot, type PropertyDesign } from '../../world/design'

/**
 * How the city's design catalogs are said to a player: each choice's name and note, a whole design, and a saved revision of an
 * earlier catalog with what it did not choose. Shared by the Architect design view (`design.tsx`), the Architect portfolio
 * (`architect.tsx`) and the property legacy (`legacy.tsx`, P1-C2-E5A), so all three say a design in exactly the same words.
 */

/** Each material by its surface and its natural color: in any other exterior color the surface stays (P1-E6). */
const FACADE_LABELS: Readonly<Record<string, { name: string; note: string }>> = {
  slate: { name: 'Slate', note: 'Split stone cladding · natural blue-grey' },
  limestone: { name: 'Limestone', note: 'Pale dressed blocks · natural warm stone' },
  brick: { name: 'Brick', note: 'Coursed brick · natural red' },
  copper: { name: 'Copper', note: 'Standing seams, verdigris trim · natural copper' },
  jade: { name: 'Jade', note: 'Glazed tile · natural deep green' },
}
const ROOF_LABELS: Readonly<Record<string, { name: string; note: string }>> = {
  flat: { name: 'Flat deck', note: 'A low parapet deck' },
  terrace: { name: 'Roof terrace', note: 'A planted rooftop pavilion' },
  dome: { name: 'Dome', note: 'A rounded dome and finial' },
  spire: { name: 'Spire', note: 'A tall pointed spire' },
}
const WINDOW_LABELS: Readonly<Record<string, { name: string; note: string }>> = {
  grid: { name: 'Standard grid', note: 'The city’s usual punched windows' },
  arched: { name: 'Classic arched', note: 'Tall arched openings' },
  ribbon: { name: 'Ribbon glass', note: 'Continuous horizontal glass bands' },
  lattice: { name: 'Industrial lattice', note: 'Four-pane factory windows' },
}
const LIGHTING_LABELS: Readonly<Record<string, { name: string; note: string }>> = {
  standard: { name: 'Standard lighting', note: 'The city’s usual warm glow, no floodlights' },
  warm: { name: 'Warm floodlights', note: 'Amber uplights and a lit cornice' },
  cool: { name: 'Cool floodlights', note: 'Blue-white uplights, cool glow, lit cornice' },
}
const ENTRANCE_LABELS: Readonly<Record<string, { name: string; note: string }>> = {
  standard: { name: 'Standard entry', note: 'The city’s usual lit door' },
  canopy: { name: 'Canopy entry', note: 'A glass door under a flat canopy' },
  arched: { name: 'Arched entry', note: 'An arched doorway in a trim surround' },
  portico: { name: 'Grand portico', note: 'Columns and a pediment across the podium' },
}
const LANDSCAPING_LABELS: Readonly<Record<string, { name: string; note: string }>> = {
  standard: { name: 'Standard grounds', note: 'Bare paving, as every lot starts' },
  garden: { name: 'Garden grounds', note: 'Trees, shrubs and flower planters' },
  courtyard: { name: 'Stone courtyard', note: 'Stone planters, lamp posts and a bench' },
}
const COLOR_LABELS: Readonly<Record<string, { name: string; note: string }>> = {
  natural: { name: 'Natural', note: 'The facade material’s own color' },
  ivory: { name: 'Ivory', note: 'Soft warm white' },
  sand: { name: 'Sand', note: 'Pale golden sand' },
  terracotta: { name: 'Terracotta', note: 'Fired clay red-orange' },
  rose: { name: 'Rose', note: 'Dusty pink' },
  crimson: { name: 'Crimson', note: 'Deep red' },
  'copper-orange': { name: 'Copper orange', note: 'Burnished orange' },
  'forest-green': { name: 'Forest green', note: 'Deep woodland green' },
  sage: { name: 'Sage', note: 'Soft grey-green' },
  'ocean-blue': { name: 'Ocean blue', note: 'Clear sea blue' },
  navy: { name: 'Navy', note: 'Deep night blue' },
  lavender: { name: 'Lavender', note: 'Muted violet' },
  charcoal: { name: 'Charcoal', note: 'Dark neutral grey' },
}
export const LABELS: Readonly<Record<DesignSlot, Readonly<Record<string, { name: string; note: string }>>>> = {
  facade: FACADE_LABELS,
  roof: ROOF_LABELS,
  windows: WINDOW_LABELS,
  lighting: LIGHTING_LABELS,
  entrance: ENTRANCE_LABELS,
  landscaping: LANDSCAPING_LABELS,
  color: COLOR_LABELS,
}
export const nameOf = (slot: DesignSlot, id: string) => LABELS[slot][id]?.name ?? id
/** A facade material as it is finished: its name alone in its natural color (as every design was said before P1-E6), else "Brick in Ocean blue". */
const finishName = (d: PropertyDesign) => (d.color === 'natural' ? nameOf('facade', d.facade) : `${nameOf('facade', d.facade)} in ${nameOf('color', d.color)}`)
/** A whole design, said as its choices, the exterior color with its facade. Also said by the Architect portfolio and the property legacy (P1-C2-E5A). */
export const designName = (d: PropertyDesign) => [finishName(d), ...DESIGN_SLOTS.filter((slot) => slot !== 'facade' && slot !== 'color').map((slot) => nameOf(slot, d[slot]))].join(' · ')
/** A saved design from catalog v1, which chose no windows, lighting, entrance or landscaping: said as such. */
const V1_NOTE = 'chosen before windows and lighting could be chosen: standard windows, lighting, entrance and grounds'
/** A saved design from catalog v2, which chose no entrance or landscaping: said as such. */
const V2_NOTE = 'chosen before entrances and landscaping could be chosen: standard entrance and grounds'
/** A saved design from catalog v3, which chose no exterior color: said as such. */
const V3_NOTE = 'chosen before exterior colors could be chosen: its facade material’s own color'
/** How a saved design of an earlier catalog is said: what it chose, and what it did not. */
export const catalogNote = (catalog: string) => (catalog === ARCHITECT_DESIGN_V1.key ? V1_NOTE : catalog === ARCHITECT_DESIGN_V2.key ? V2_NOTE : catalog === ARCHITECT_DESIGN_V3.key ? V3_NOTE : null)
/** A saved revision as its history says it: what its catalog chose, and for an earlier catalog what it did not. */
export const revisionName = (h: DesignChoice & { catalog: string }) =>
  h.catalog === ARCHITECT_DESIGN_V1.key
    ? `${nameOf('facade', h.facade)} · ${nameOf('roof', h.roof)} (${V1_NOTE})`
    : h.catalog === ARCHITECT_DESIGN_V2.key
      ? `${DESIGN_SLOTS.slice(0, 4).map((slot) => nameOf(slot, appearanceOf(h)[slot])).join(' · ')} (${V2_NOTE})`
      : h.catalog === ARCHITECT_DESIGN_V3.key
        ? `${designName(appearanceOf(h))} (${V3_NOTE})`
        : designName(appearanceOf(h))
