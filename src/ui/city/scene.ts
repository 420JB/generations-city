import { createContext, useContext } from 'react'
import type { MonumentDef, MonumentId } from '../../config/monuments'
import type { Building, GameState } from '../../game/types'

/**
 * THE CITY SCENE: everything the city renderer needs to know about WHICH city it draws.
 *
 * The renderer (CityView, its ground, buildings, monuments, capital and camera) is one art
 * system. A scene changes what it shows: how many districts there are and where their wedges
 * sit, their names, accents and crests, the monument names, and what the District Monument
 * (T5) carries. It never changes how anything is drawn.
 *
 * Two adapters make scenes:
 *   - `legacyScene.ts`  the Rare Friends city (nine family districts), unchanged.
 *   - `src/brand`       a configured brand city (any district count the layout supports).
 *
 * Ward and plot radii are the STANDARD layout (`config/world.ts`) for every scene: a scene
 * places districts, it does not reshape wards, roads or lots.
 */
export interface SceneDistrict {
  /** Permanent district key. Plot ids and test ids are spelled with it. */
  readonly id: string
  /** 1-based position in the city's district order. */
  readonly index: number
  /** Centre angle of the district's wedge (degrees, world space). */
  readonly centerDeg: number
  /** Angular width of the wedge (degrees). */
  readonly spanDeg: number
  /** Running-text name, e.g. "Family". */
  readonly name: string
  /** Signage form, e.g. "Family District". */
  readonly title: string
  /** Short secondary reference (roman numeral). */
  readonly sigil: string
  readonly color: string
  readonly glow: string
  readonly ground: string
  /** Crest image for signage (labels, gates, City Hall). Already vetted by the adapter. */
  readonly crest: string
  /** Banner image for flags and facade banners. Already vetted by the adapter. */
  readonly banner: string
  /** Suffix of this district's SVG paint ids (`glow-…`, `beam-…`, `ground-…`). Unique in the scene. */
  readonly paint: string
  /** Legacy Rare Friends family key (data attribute only); null in brand cities. */
  readonly familyKey: string | null
}

/**
 * What the District Monument (the T5 statue) carries for a district:
 *   silhouette  a transparent figure used as the bronze casting's mask (legacy families)
 *   portrait    a configured NFT's artwork, mounted as a bronze-framed relief
 *   emblem      the standard fallback when no artwork is configured or available
 */
export type StatueArt =
  | {
      kind: 'silhouette'
      /** Inscription on the plinth. */
      name: string
      image: string
      imageX: number
      imageY: number
      imageSize: number
      width: number
      height: number
      familyKey: string | null
    }
  | { kind: 'portrait'; name: string; image: string; caption: string }
  | { kind: 'emblem'; name: string; monogram: string }

/** A building as the renderer reads it: the legacy building with any district key. */
export interface SceneBuilding extends Omit<Building, 'districtId'> {
  districtId: string
}

/** The parts of a city's state the renderer draws. A legacy `GameState` is one. */
export interface CityModel {
  users: GameState['users']
  buildings: Readonly<Record<string, SceneBuilding>>
  /** Open wards per district key (a district absent here has one). */
  wards: Readonly<Record<string, number>>
  monuments: Readonly<Record<MonumentId, { holder: string | null }>>
  capital: { holder: string | null }
  crown: { holder: string | null }
}

/** A plot the viewer may pick (placement mode). */
export interface ScenePlotCandidate {
  districtId: string
  ward: number
  plot: number
  /** True when the plot lies in a ward that is not open yet (a preview of the next ward). */
  newWard: boolean
}

export interface CityScene {
  /** Stable scene key (legacy `rare-city`, or a brand world id). Camera and caches reset when it changes. */
  readonly key: string
  /** The city's display name, e.g. "Rare City". */
  readonly cityName: string
  readonly districts: readonly SceneDistrict[]
  /** The standard tier monuments, named for this city. Always the same ids, tiers and kinds. */
  readonly monuments: readonly MonumentDef[]
  /** The central capital landmark. */
  readonly capital: {
    /** Name of the central landmark, e.g. "City Hall". */
    readonly name: string
    /** Kicker line on the floating Capital sign. */
    readonly signKicker: string
    /** The city's own crest, mounted on the landmark's front (a brand city's logo). Absent: none. */
    readonly crest?: string
  }
  /** What the people who join the city are called ("Friend" / "Friends"). */
  readonly resident: { readonly one: string; readonly many: string }
  /** What the District Monument carries when this district holds it. */
  statueFor(districtId: string): StatueArt
  /** Public name of a building, e.g. "Friend #812". */
  buildingLabel(b: SceneBuilding): string
}

const byScene = new WeakMap<CityScene, Map<string, SceneDistrict>>()

/** A district of the scene by key. Throws for a key the scene does not have: a building in no district is a bug. */
export function sceneDistrict(scene: CityScene, id: string): SceneDistrict {
  let map = byScene.get(scene)
  if (!map) {
    map = new Map(scene.districts.map((d) => [d.id, d]))
    byScene.set(scene, map)
  }
  const d = map.get(id)
  if (!d) throw new Error(`Unknown district ${id} in ${scene.key}`)
  return d
}

export function sceneMonument(scene: CityScene, id: MonumentId): MonumentDef {
  const m = scene.monuments.find((x) => x.id === id)
  if (!m) throw new Error(`Unknown monument ${id} in ${scene.key}`)
  return m
}

export const CitySceneContext = createContext<CityScene | null>(null)

/** The scene the surrounding CityView draws. */
export function useCityScene(): CityScene {
  const scene = useContext(CitySceneContext)
  if (!scene) throw new Error('City sprites render inside a CityView (no scene in context).')
  return scene
}
