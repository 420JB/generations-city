import type { DistrictId } from './districts'

/**
 * OFFICIAL FAMILY IDENTITY BOUNDARY.
 *
 * The nine official Rare Friends family/type names were supplied by the product owner
 * for this hackathon build, together with two Friend silhouettes per family
 * (`public/assets/families/<family>-{1,2}.svg`). Transparent copies (background rect
 * removed, geometry untouched) live in `public/assets/families/transparent/` and are
 * produced by `scripts/derive-transparent-families.mjs`.
 *
 * Every public-facing district name and every piece of family art is resolved here.
 * UI components must not hard-code family names or asset paths.
 */

export type FamilyKey = 'hollow' | 'sparkling' | 'colossus' | 'family' | 'cellular' | 'mask' | 'asymmetry' | 'skeleton' | 'hoverer'

export const FAMILY_KEYS: readonly FamilyKey[] = ['hollow', 'sparkling', 'colossus', 'family', 'cellular', 'mask', 'asymmetry', 'skeleton', 'hoverer']

/**
 * District → family mapping for the current build. This is a PRODUCT CONFIGURATION
 * choice, not a claim that Rare Friends assigns these families to numbered districts.
 * Change it here and every label, crest, banner and statue follows.
 */
export const DISTRICT_FAMILY: Record<DistrictId, FamilyKey> = {
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

/**
 * Approximate supply class. INFORMATIONAL ONLY: product-planning inputs supplied by the
 * product owner, not live on-chain counts, and not used by the current scoring.
 */
export type SupplyClass = 'rarer' | 'common'

export interface FamilyDef {
  key: FamilyKey
  /** Official family/type name. */
  name: string
  supplyClass: SupplyClass
  /** Approximate population range (planning input, not authoritative). */
  approxPopulation: readonly [number, number]
}

const RARER = [3_200, 3_350] as const
const COMMON = [23_500, 23_500] as const

export const FAMILIES: Record<FamilyKey, FamilyDef> = {
  hollow: { key: 'hollow', name: 'Hollow', supplyClass: 'rarer', approxPopulation: RARER },
  sparkling: { key: 'sparkling', name: 'Sparkling', supplyClass: 'rarer', approxPopulation: RARER },
  colossus: { key: 'colossus', name: 'Colossus', supplyClass: 'rarer', approxPopulation: RARER },
  family: { key: 'family', name: 'Family', supplyClass: 'common', approxPopulation: COMMON },
  cellular: { key: 'cellular', name: 'Cellular', supplyClass: 'common', approxPopulation: COMMON },
  mask: { key: 'mask', name: 'Mask', supplyClass: 'common', approxPopulation: COMMON },
  asymmetry: { key: 'asymmetry', name: 'Asymmetry', supplyClass: 'common', approxPopulation: COMMON },
  skeleton: { key: 'skeleton', name: 'Skeleton', supplyClass: 'common', approxPopulation: COMMON },
  hoverer: { key: 'hoverer', name: 'Hoverer', supplyClass: 'rarer', approxPopulation: RARER },
}

/**
 * Production fairness principle (documented, not implemented): district success measures
 * how effectively a seasonal community participates relative to its ACTIVE representative
 * population, rather than rewarding the family with the largest total supply. Seasonal
 * scoring must normalise against declared/active seasonal participation, never raw NFT
 * supply or raw permanent building count, and never by a naive supply multiplier.
 */
export const FAIRNESS_PRINCIPLE =
  'District success measures how effectively a seasonal community participates relative to its active representative population, rather than simply rewarding the family with the largest total supply.'

export interface FamilyArt {
  /** Original supplied art (black background). */
  primary: string
  secondary: string
  /** Derived transparent copies for civic/UI use. */
  primaryTransparent: string
  secondaryTransparent: string
}

const BASE = import.meta.env?.BASE_URL ?? '/'

/** Public URL of a family asset, relative to `public/`. */
export function familyAssetPath(key: FamilyKey, variant: 1 | 2, transparent: boolean): string {
  return `${BASE}assets/families/${transparent ? 'transparent/' : ''}${key}-${variant}.svg`
}

export function familyArt(key: FamilyKey): FamilyArt {
  return {
    primary: familyAssetPath(key, 1, false),
    secondary: familyAssetPath(key, 2, false),
    primaryTransparent: familyAssetPath(key, 1, true),
    secondaryTransparent: familyAssetPath(key, 2, true),
  }
}

export interface DistrictIdentity {
  districtId: DistrictId
  /** Official family/type name, e.g. "Family". */
  officialName: string
  /** Signage form, e.g. "Family District". */
  title: string
  familyKey: FamilyKey
  /**
   * Art roles: the PRIMARY silhouette is the district crest (chips, tabs, signage, crests,
   * the T5 statue); the SECONDARY silhouette is reserved for banners and flags so one
   * Friend does not stand for the whole family everywhere.
   */
  art: FamilyArt
  /** District accent colour (unchanged from the pre-family build). */
  accent: string
  supplyClass: SupplyClass
  credit: string
}

const ACCENTS: Record<DistrictId, string> = {
  d1: '#ff8a4c',
  d2: '#f4c542',
  d3: '#8fe36b',
  d4: '#2fe0c8',
  d5: '#4aa8ff',
  d6: '#8c86ff',
  d7: '#e867ff',
  d8: '#ff5f8f',
  d9: '#d6e4f0',
}

const CREDIT = 'Rare Friends family silhouettes supplied by the product owner for the Generations City hackathon build.'

function identityFor(districtId: DistrictId): DistrictIdentity {
  const fam = FAMILIES[DISTRICT_FAMILY[districtId]]
  return {
    districtId,
    officialName: fam.name,
    title: `${fam.name} District`,
    familyKey: fam.key,
    art: familyArt(fam.key),
    accent: ACCENTS[districtId],
    supplyClass: fam.supplyClass,
    credit: CREDIT,
  }
}

export const DISTRICT_IDENTITIES: Record<DistrictId, DistrictIdentity> = {
  d1: identityFor('d1'),
  d2: identityFor('d2'),
  d3: identityFor('d3'),
  d4: identityFor('d4'),
  d5: identityFor('d5'),
  d6: identityFor('d6'),
  d7: identityFor('d7'),
  d8: identityFor('d8'),
  d9: identityFor('d9'),
}
