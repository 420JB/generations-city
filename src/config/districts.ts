import { DISTRICT_IDENTITIES, type FamilyArt, type FamilyKey, type SupplyClass } from './districtIdentity'
/**
 * District definitions. Stable internal ids (`d1`…`d9`) and geometry live here; every
 * public-facing name, family key, accent colour and piece of art comes from
 * `districtIdentity.ts`.
 */
export interface DistrictDef {
  id: DistrictId
  index: number
  /** Official family name, e.g. "Family". Use in running text. */
  name: string
  /** Signage form, e.g. "Family District". Use for headings, labels and signage. */
  title: string
  /** Subtle secondary roman-numeral reference (e.g. "IV"). */
  sigil: string
  color: string
  glow: string
  ground: string
  familyKey: FamilyKey
  art: FamilyArt
  supplyClass: SupplyClass
}

export type DistrictId = 'd1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd6' | 'd7' | 'd8' | 'd9'

const BASE_DISTRICTS: readonly { id: DistrictId; index: number; sigil: string; glow: string; ground: string }[] = [
  { id: 'd1', index: 1, sigil: 'I', glow: '#ffb38a', ground: '#2a1a16' },
  { id: 'd2', index: 2, sigil: 'II', glow: '#ffe08a', ground: '#28220f' },
  { id: 'd3', index: 3, sigil: 'III', glow: '#c2f5a8', ground: '#16261a' },
  { id: 'd4', index: 4, sigil: 'IV', glow: '#9af5e8', ground: '#0f2627' },
  { id: 'd5', index: 5, sigil: 'V', glow: '#a3d2ff', ground: '#111f33' },
  { id: 'd6', index: 6, sigil: 'VI', glow: '#c4c1ff', ground: '#191936' },
  { id: 'd7', index: 7, sigil: 'VII', glow: '#f4b4ff', ground: '#2a1530' },
  { id: 'd8', index: 8, sigil: 'VIII', glow: '#ffadc6', ground: '#2c141d' },
  { id: 'd9', index: 9, sigil: 'IX', glow: '#ffffff', ground: '#1c2229' },
]

export const DISTRICTS: readonly DistrictDef[] = BASE_DISTRICTS.map((d) => {
  const id = DISTRICT_IDENTITIES[d.id]
  return {
    ...d,
    name: id.officialName,
    title: id.title,
    color: id.accent,
    familyKey: id.familyKey,
    art: id.art,
    supplyClass: id.supplyClass,
  }
})

export const DISTRICT_IDS = DISTRICTS.map((d) => d.id)

const byId = new Map(DISTRICTS.map((d) => [d.id, d]))
export function getDistrict(id: DistrictId): DistrictDef {
  const d = byId.get(id)
  if (!d) throw new Error(`Unknown district ${id}`)
  return d
}
