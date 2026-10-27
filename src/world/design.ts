/**
 * ARCHITECT PROPERTY DESIGN, PURE (P1-C2-E4A, P1-C2-E4B, P1-C2-E4C, P1-E6): the small, versioned set of visual choices a property's current
 * NFT controller may make for its building, and nothing else. Portable and deterministic: no clock, database or renderer.
 *
 * A design is how one building is drawn: a facade finish, a roof silhouette, a window treatment, an exterior lighting
 * treatment, an entrance treatment, a landscaping treatment and an exterior color (`PropertyDesign`), each an identifier
 * from a CATALOG. Every identifier is one the standard renderer draws (`FACADE_PALETTES`, `Roof`, the window patterns, the
 * lighting colors, the entrances and the landscape pieces of the city art, and the named `EXTERIOR_COLORS`), so a design
 * never carries a color value, markup, URLs, positions or anything a browser authored: the server stores only
 * identifiers a catalog lists, and the page draws them through the city's own art. A property with no saved design is
 * drawn as every new building is, with the current catalog's default (`slate`, `flat`, `grid`, `standard`, `standard`,
 * `standard`, `natural`).
 *
 * Catalogs are versioned, and a catalog's key and meaning are permanent: every saved design names the catalog it was
 * chosen from, and is read by that catalog forever.
 *
 *   - `architect-design-v1` (P1-C2-E4A) chose a facade and a roof only. Its designs keep exactly that meaning: they name
 *     no window or lighting treatment (`null` in a stored choice), and are drawn with the treatments every building had
 *     when they were saved (`LEGACY_DETAILS`, the renderer's standard grid windows and warm glow, no floodlights).
 *     It is READ ONLY now: no new design is saved from it.
 *   - `architect-design-v2` (P1-C2-E4B) added a window treatment and an exterior lighting treatment. Its designs keep
 *     exactly that meaning: they name no entrance or landscaping treatment (`null`), and are drawn with the standard
 *     entrance and grounds every building had when they were saved (`LEGACY_DETAILS`). It is READ ONLY now.
 *   - `architect-design-v3` (P1-C2-E4C) added an entrance treatment and a landscaping treatment. Its designs keep exactly
 *     that meaning: they name no exterior color (`null`), and are drawn in their facade material's own color, as every
 *     building was when they were saved (`LEGACY_DETAILS`). It is READ ONLY now.
 *   - `architect-design-v4` (P1-E6) is the current one: v3's six slots, plus an exterior color chosen apart from the
 *     facade material. Its default color is `natural` (the material's own color), so its default draws exactly what v3's
 *     default did, and no building looks different until its controller saves another color.
 *
 * Every choice is LOCAL TEST content: free, none unlocked, earned, ranked or paid for, and what a later catalog offers is
 * not decided here.
 *
 * What a design is NOT: the building's tier or growth (construction's), its district identity (the administrator's
 * configuration), its NFT identity (drawn on its label whatever the design), its plot or any land beyond its own paved
 * lot (landscaping is a fixed arrangement drawn inside it, never placed, moved or collected), or public owner media
 * (billboards, which have their own, separate transfer rules). A design belongs to the PROPERTY: it stays when the NFT's
 * controller changes.
 */
export interface PropertyDesign {
  facade: string
  roof: string
  windows: string
  lighting: string
  entrance: string
  landscaping: string
  /** The exterior color the facade material is finished in; `natural` is the material's own color. */
  color: string
}

export type DesignSlot = keyof PropertyDesign

/** Every slot a design draws, in the order a catalog lists them. */
export const DESIGN_SLOTS: readonly DesignSlot[] = Object.freeze(['facade', 'roof', 'windows', 'lighting', 'entrance', 'landscaping', 'color'])

/**
 * A design as a save records it: one identifier per slot its catalog chooses, and `null` for a slot its catalog does not
 * have (a v1 design's windows, lighting, entrance, landscaping and color; a v2 design's entrance, landscaping and color; a
 * v3 design's color). Exactly these seven keys.
 */
export interface DesignChoice {
  facade: string
  roof: string
  windows: string | null
  lighting: string | null
  entrance: string | null
  landscaping: string | null
  color: string | null
}

export interface DesignCatalog {
  /** Permanent key: every saved design names the catalog it was chosen from. */
  key: string
  /** The slots a design of this catalog chooses. Every other slot is drawn with `LEGACY_DETAILS`. */
  slots: readonly DesignSlot[]
  facades: readonly string[]
  roofs: readonly string[]
  /** Empty where `windows` is not one of the catalog's slots. */
  windows: readonly string[]
  /** Empty where `lighting` is not one of the catalog's slots. */
  lighting: readonly string[]
  /** Empty where `entrance` is not one of the catalog's slots. */
  entrances: readonly string[]
  /** Empty where `landscaping` is not one of the catalog's slots. */
  landscaping: readonly string[]
  /** Empty where `color` is not one of the catalog's slots. */
  colors: readonly string[]
  /** What a property with no saved design is drawn with. Always the catalog's choice, with `LEGACY_DETAILS` for slots it does not have. */
  default: Readonly<PropertyDesign>
}

/**
 * The treatments every building was drawn with before the catalog that added them: the standard renderer's grid windows
 * and warm window glow with no exterior floodlights (before v2), its standard door with no landscaping (before v3), and
 * its facade material's own color (before v4). A design that names none of them (v1, v2 for the last three, v3 for the
 * color, or no design at all) is drawn so.
 */
export const LEGACY_DETAILS: Readonly<Pick<PropertyDesign, 'windows' | 'lighting' | 'entrance' | 'landscaping' | 'color'>> = Object.freeze({
  windows: 'grid',
  lighting: 'standard',
  entrance: 'standard',
  landscaping: 'standard',
  color: 'natural',
})

/** The first catalog (P1-C2-E4A): five facade finishes and four roof silhouettes the standard renderer draws at every tier. Mirrored by migration 0015. */
export const ARCHITECT_DESIGN_V1: DesignCatalog = Object.freeze({
  key: 'architect-design-v1',
  slots: Object.freeze(['facade', 'roof'] as DesignSlot[]),
  facades: Object.freeze(['slate', 'limestone', 'brick', 'copper', 'jade']),
  roofs: Object.freeze(['flat', 'terrace', 'dome', 'spire']),
  windows: Object.freeze([]),
  lighting: Object.freeze([]),
  entrances: Object.freeze([]),
  landscaping: Object.freeze([]),
  colors: Object.freeze([]),
  default: Object.freeze({ facade: 'slate', roof: 'flat', ...LEGACY_DETAILS }),
})

/**
 * The second catalog (P1-C2-E4B): v1's facades and roofs, four window treatments the renderer's window patterns draw
 * (`grid` standard, `arched` classic, `ribbon` contemporary glass bands, `lattice` industrial panes) and three exterior
 * lighting treatments (`standard`: the city's usual warm glow and no floodlights; `warm` and `cool`: static floodlights
 * washing the facade and lighting the cornice, with a matching window glow). Mirrored by migration 0016.
 */
export const ARCHITECT_DESIGN_V2: DesignCatalog = Object.freeze({
  key: 'architect-design-v2',
  slots: Object.freeze(['facade', 'roof', 'windows', 'lighting'] as DesignSlot[]),
  facades: ARCHITECT_DESIGN_V1.facades,
  roofs: ARCHITECT_DESIGN_V1.roofs,
  windows: Object.freeze(['grid', 'arched', 'ribbon', 'lattice']),
  lighting: Object.freeze(['standard', 'warm', 'cool']),
  entrances: Object.freeze([]),
  landscaping: Object.freeze([]),
  colors: Object.freeze([]),
  default: ARCHITECT_DESIGN_V1.default,
})

/**
 * The third catalog (P1-C2-E4C): v2's facades, roofs, windows and lighting, four entrance treatments the renderer's
 * entrance art draws on the podium (`standard`, the city's usual lit door; `canopy`, a glass door under a flat canopy;
 * `arched`, an arched doorway in a trim surround; `portico`, a columned portico and pediment fitted to the podium face)
 * and three landscaping treatments, fixed arrangements of the renderer's landscape pieces inside the property's own paved
 * lot (`standard`, bare paving as every building has had; `garden`, trees, shrubs and flower planters; `courtyard`, stone
 * planters, clipped shrubs, lamp posts and a bench). Mirrored by migration 0017.
 */
export const ARCHITECT_DESIGN_V3: DesignCatalog = Object.freeze({
  key: 'architect-design-v3',
  slots: Object.freeze(['facade', 'roof', 'windows', 'lighting', 'entrance', 'landscaping'] as DesignSlot[]),
  facades: ARCHITECT_DESIGN_V2.facades,
  roofs: ARCHITECT_DESIGN_V2.roofs,
  windows: ARCHITECT_DESIGN_V2.windows,
  lighting: ARCHITECT_DESIGN_V2.lighting,
  entrances: Object.freeze(['standard', 'canopy', 'arched', 'portico']),
  landscaping: Object.freeze(['standard', 'garden', 'courtyard']),
  colors: Object.freeze([]),
  default: ARCHITECT_DESIGN_V1.default,
})

/**
 * The fourth catalog (P1-E6): v3's six slots, and an exterior color the facade material is finished in, chosen apart from
 * the material: `natural` (the material's own color, as every building has been drawn) or one of twelve named colors the
 * renderer lists (`EXTERIOR_COLORS`). A colored facade keeps its material's surface (brick courses, slate panels,
 * limestone blocks, copper seams, jade tiles), so a blue brick building still reads as brick. Mirrored by migration 0018.
 */
export const ARCHITECT_DESIGN_V4: DesignCatalog = Object.freeze({
  key: 'architect-design-v4',
  slots: DESIGN_SLOTS,
  facades: ARCHITECT_DESIGN_V3.facades,
  roofs: ARCHITECT_DESIGN_V3.roofs,
  windows: ARCHITECT_DESIGN_V3.windows,
  lighting: ARCHITECT_DESIGN_V3.lighting,
  entrances: ARCHITECT_DESIGN_V3.entrances,
  landscaping: ARCHITECT_DESIGN_V3.landscaping,
  colors: Object.freeze(['natural', 'ivory', 'sand', 'terracotta', 'rose', 'crimson', 'copper-orange', 'forest-green', 'sage', 'ocean-blue', 'navy', 'lavender', 'charcoal']),
  default: ARCHITECT_DESIGN_V1.default,
})

/** The catalog every new design is chosen from. */
export const CURRENT_DESIGN_CATALOG: DesignCatalog = ARCHITECT_DESIGN_V4

/** The catalogs this build can read, by key, in the order they were introduced: every saved design names one of them. */
export const DESIGN_CATALOGS: Readonly<Record<string, DesignCatalog>> = Object.freeze({
  [ARCHITECT_DESIGN_V1.key]: ARCHITECT_DESIGN_V1,
  [ARCHITECT_DESIGN_V2.key]: ARCHITECT_DESIGN_V2,
  [ARCHITECT_DESIGN_V3.key]: ARCHITECT_DESIGN_V3,
  [ARCHITECT_DESIGN_V4.key]: ARCHITECT_DESIGN_V4,
})

const LISTS = { facade: 'facades', roof: 'roofs', windows: 'windows', lighting: 'lighting', entrance: 'entrances', landscaping: 'landscaping', color: 'colors' } as const satisfies Record<DesignSlot, keyof DesignCatalog>

/** The identifiers `catalog` offers for `slot` (none where it is not one of its slots). */
export const optionsOf = (catalog: DesignCatalog, slot: DesignSlot): readonly string[] => catalog[LISTS[slot]]

const exactKeys = (v: unknown): v is Record<DesignSlot, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const keys = Object.keys(v)
  return keys.length === DESIGN_SLOTS.length && DESIGN_SLOTS.every((s) => keys.includes(s))
}

/**
 * Whether `choice` is exactly a choice of `catalog`: for each of its slots an identifier it lists, `null` for every slot it
 * does not have, and nothing else.
 */
export function isCatalogChoice(catalog: DesignCatalog, choice: unknown): choice is DesignChoice {
  if (!exactKeys(choice)) return false
  return DESIGN_SLOTS.every((s) => {
    const v = choice[s]
    return catalog.slots.includes(s) ? typeof v === 'string' && optionsOf(catalog, s).includes(v) : v === null
  })
}

/** How a recorded choice is drawn: its own identifiers, and `LEGACY_DETAILS` for any slot its catalog does not have. */
export function appearanceOf(choice: DesignChoice): PropertyDesign {
  return {
    facade: choice.facade,
    roof: choice.roof,
    windows: choice.windows ?? LEGACY_DETAILS.windows,
    lighting: choice.lighting ?? LEGACY_DETAILS.lighting,
    entrance: choice.entrance ?? LEGACY_DETAILS.entrance,
    landscaping: choice.landscaping ?? LEGACY_DETAILS.landscaping,
    color: choice.color ?? LEGACY_DETAILS.color,
  }
}

/** Whether `design` is exactly an appearance some catalog this build has draws (any of its saved choices, or its default). */
export function isDrawableDesign(design: unknown): design is PropertyDesign {
  if (!exactKeys(design)) return false
  return DESIGN_SLOTS.every((s) => {
    const v = design[s]
    if (typeof v !== 'string') return false
    return Object.values(DESIGN_CATALOGS).some((c) => (c.slots.includes(s) ? optionsOf(c, s).includes(v) : v === (LEGACY_DETAILS as Record<string, string>)[s]))
  })
}

/** Whether two designs draw the same building. */
export const sameDesign = (a: PropertyDesign, b: PropertyDesign) => DESIGN_SLOTS.every((s) => a[s] === b[s])
