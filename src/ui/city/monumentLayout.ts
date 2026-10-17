import type { MonumentId } from '../../config/monuments'
import type { WorldPoint } from '../../game/world'
import { civicSlotIn } from './districtGeometry'
import type { CityModel, CityScene } from './scene'

export interface MonumentTransfer {
  key: string
  monumentId: MonumentId
  from: string | null
  to: string | null
}

export interface PlacedMonument {
  monumentId: MonumentId
  districtId: string
  world: WorldPoint
  scale: number
  phase: 'standing' | 'rising' | 'falling'
  transferKey: string | null
}

/**
 * Lay out every district's civic square: held monuments plus any monument that is
 * currently being demolished there (so the ruin collapses where it stood).
 */
export function layoutMonuments(scene: CityScene, monuments: CityModel['monuments'], transfers: readonly MonumentTransfer[]): PlacedMonument[] {
  const out: PlacedMonument[] = []
  const byMonument = new Map(transfers.map((t) => [t.monumentId, t]))
  for (const d of scene.districts) {
    const here = scene.monuments.filter((m) => monuments[m.id].holder === d.id || byMonument.get(m.id)?.from === d.id)
    here.forEach((m, i) => {
      const t = byMonument.get(m.id)
      const falling = t?.from === d.id && monuments[m.id].holder !== d.id
      const slot = civicSlotIn(scene, d, i, here.length)
      out.push({
        monumentId: m.id,
        districtId: d.id,
        world: { x: slot.x, y: slot.y },
        scale: slot.scale,
        phase: falling ? 'falling' : t?.to === d.id ? 'rising' : 'standing',
        transferKey: t?.key ?? null,
      })
    })
  }
  return out
}
