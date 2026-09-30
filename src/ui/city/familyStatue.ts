import type { FamilyKey } from '../../config/districtIdentity'
import { getDistrict, type DistrictId } from '../../config/districts'
import { FAMILY_ART_METRICS, FAMILY_ART_VIEWBOX } from '../../config/familyArtMetrics'

/** Largest figure (screen px) the T5 plinth carries; wide families use the width budget. */
export const STATUE_MAX = { w: 128, h: 128 } as const

export interface StatueForm {
  familyKey: FamilyKey
  familyName: string
  /** Transparent PRIMARY silhouette, used as the sculpture's mask. */
  image: string
  /** Where to draw the 512×512 asset so the figure's feet sit at (0, 0), centred. */
  imageX: number
  imageY: number
  imageSize: number
  /** Visible figure size in px. */
  width: number
  height: number
}

/**
 * Sculptural form of the T5 Friend Statue for the district that holds (or, for a
 * collapsing ruin, held) it: that family's primary silhouette, scaled to fit the plinth.
 */
export function statueForm(districtId: DistrictId): StatueForm {
  const d = getDistrict(districtId)
  const b = FAMILY_ART_METRICS[d.familyKey][1]
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  const k = Math.min(STATUE_MAX.w / w, STATUE_MAX.h / h)
  return {
    familyKey: d.familyKey,
    familyName: d.name,
    image: d.art.primaryTransparent,
    imageX: -((b.x0 + b.x1) / 2) * k,
    imageY: -b.y1 * k,
    imageSize: FAMILY_ART_VIEWBOX * k,
    width: w * k,
    height: h * k,
  }
}
