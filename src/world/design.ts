/**
 * ARCHITECT PROPERTY DESIGN, PURE (P1-C2-E4A): the small, versioned set of visual choices a property's current NFT
 * controller may make for its building, and nothing else. Portable and deterministic: no clock, database or renderer.
 *
 * A design is two identifiers, both from a CATALOG: a facade finish and a roof silhouette. Each identifier is one the
 * standard renderer already draws (`FACADE_PALETTES` and `Roof` in the city art), so a design never carries colors,
 * markup, URLs or anything a browser authored: the server stores only identifiers this catalog lists, and the page draws
 * them through the city's own art. A property with no saved design is drawn as every new building is, with the
 * catalog's default (`slate`, `flat`).
 *
 * Catalogs are versioned, and a catalog's key is permanent: every saved design names the catalog it was chosen from, and
 * is read by that catalog forever. `architect-design-v1` (P1-C2-E4A) is the only one, and the current one. It is LOCAL
 * TEST content: every choice is free, none is unlocked, earned, ranked or paid for, and what a later catalog offers is
 * not decided here.
 *
 * What a design is NOT: the building's tier or growth (construction's), its district identity (the administrator's
 * configuration), its NFT identity (drawn on its label whatever the design), or public owner media (billboards, which
 * have their own, separate transfer rules). A design belongs to the PROPERTY: it stays when the NFT's controller changes.
 */
export interface PropertyDesign {
  facade: string
  roof: string
}

export type DesignSlot = keyof PropertyDesign

export interface DesignCatalog {
  /** Permanent key: every saved design names the catalog it was chosen from. */
  key: string
  facades: readonly string[]
  roofs: readonly string[]
  /** What a property with no saved design is drawn with. Always in the catalog. */
  default: Readonly<PropertyDesign>
}

/** The first catalog (P1-C2-E4A): five facade finishes and four roof silhouettes the standard renderer draws at every tier. Mirrored by migration 0015. */
export const ARCHITECT_DESIGN_V1: DesignCatalog = Object.freeze({
  key: 'architect-design-v1',
  facades: Object.freeze(['slate', 'limestone', 'brick', 'copper', 'jade']),
  roofs: Object.freeze(['flat', 'terrace', 'dome', 'spire']),
  default: Object.freeze({ facade: 'slate', roof: 'flat' }),
})

/** The catalog every new design is chosen from. */
export const CURRENT_DESIGN_CATALOG: DesignCatalog = ARCHITECT_DESIGN_V1

/** The catalogs this build can read, by key: every saved design names one of them. */
export const DESIGN_CATALOGS: Readonly<Record<string, DesignCatalog>> = Object.freeze({ [ARCHITECT_DESIGN_V1.key]: ARCHITECT_DESIGN_V1 })

/** Whether `design` is exactly a choice of `catalog`: a listed facade and a listed roof, and nothing else. */
export function isCatalogDesign(catalog: DesignCatalog, design: unknown): design is PropertyDesign {
  if (typeof design !== 'object' || design === null || Array.isArray(design)) return false
  const d = design as Record<string, unknown>
  if (Object.keys(d).length !== 2 || typeof d.facade !== 'string' || typeof d.roof !== 'string') return false
  return catalog.facades.includes(d.facade) && catalog.roofs.includes(d.roof)
}

export const sameDesign = (a: PropertyDesign, b: PropertyDesign) => a.facade === b.facade && a.roof === b.roof

/** A saved design as the city draws it: the identifiers, by property, at the revision that saved them. */
export interface SavedPropertyDesign extends PropertyDesign {
  propertyId: string
  buildingId: string
  /** 1, 2, 3 ... per property: each save of its design is the next revision. */
  revision: number
  catalog: string
}
