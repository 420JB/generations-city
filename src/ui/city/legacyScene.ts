import { DISTRICT_IDS, DISTRICTS, type DistrictId } from '../../config/districts'
import { buildingFriendLabel } from '../../config/identity'
import { MONUMENTS } from '../../config/monuments'
import { WORLD } from '../../config/world'
import { statueForm } from './familyStatue'
import type { CityScene, SceneDistrict, StatueArt } from './scene'

/**
 * COMPATIBILITY ADAPTER: the Rare Friends city as a scene.
 *
 * Everything Rare Friends-specific the renderer used to read directly (the nine family
 * districts, their silhouettes, "Friend" wording, the Friend Statue) is gathered here, from
 * the same configuration the legacy engine reads. The legacy city draws exactly as before.
 */
const districts: readonly SceneDistrict[] = Object.freeze(
  DISTRICTS.map((d) =>
    Object.freeze({
      id: d.id,
      index: d.index,
      // The legacy `districtAngle`: District 1 at the back of the map, then one span per index.
      centerDeg: -135 + (d.index - 1) * WORLD.districtSpanDeg,
      spanDeg: WORLD.districtSpanDeg,
      name: d.name,
      title: d.title,
      sigil: d.sigil,
      color: d.color,
      glow: d.glow,
      ground: d.ground,
      crest: d.art.primaryTransparent,
      banner: d.art.secondaryTransparent,
      paint: d.id,
      familyKey: d.familyKey,
    }),
  ),
)

function legacyStatue(districtId: string): StatueArt {
  const f = statueForm(toLegacyDistrictId(districtId))
  return { kind: 'silhouette', name: f.familyName, image: f.image, imageX: f.imageX, imageY: f.imageY, imageSize: f.imageSize, width: f.width, height: f.height, familyKey: f.familyKey }
}

export const RARE_CITY_SCENE: CityScene = Object.freeze({
  key: 'rare-city',
  cityName: 'Rare City',
  districts,
  monuments: MONUMENTS,
  capital: Object.freeze({ name: 'City Hall', signKicker: 'THE CAPITAL OF RARE CITY' }),
  resident: Object.freeze({ one: 'Friend', many: 'Friends' }),
  statueFor: legacyStatue,
  buildingLabel: buildingFriendLabel,
})

/** A scene district key back to the legacy district id. Throws for a key that is not one of the nine. */
export function toLegacyDistrictId(id: string): DistrictId {
  if (!(DISTRICT_IDS as readonly string[]).includes(id)) throw new Error(`Not a Rare City district: ${id}`)
  return id as DistrictId
}
