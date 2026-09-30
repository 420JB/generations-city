import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type WheelEvent as RWheelEvent } from 'react'
import { DISTRICTS, getDistrict, type DistrictId } from '../../config/districts'
import { DEMO_PLAYER_ID } from '../../config/identity'
import { MONUMENTS } from '../../config/monuments'
import { WORLD } from '../../config/world'
import { totalBuilt } from '../../game/economy'
import { intersects, representativeBuildings, wardRenderMode, type Rect } from '../../game/lod'
import type { Building, GameState } from '../../game/types'
import { cityRadius, districtAngle, polar, wardBand } from '../../game/world'
import { easeInOutCubic, prefersReducedMotion } from '../motion'
import { BuildingSprite, MassingSprite, type BuildFx } from './BuildingSprite'
import { CapitalSign, CityHall, CrestDisc, Fountain, RegistryPylon } from './CapitalPlaza'
import { CityGround } from './CityGround'
import { CityDefs } from './Defs'
import { buildingFocus, buildingHeightPx, detailFor, districtLabelPos, iso, isoW, place, placeBuilding, pylonWorld, gateWorld, type Detail } from './geometry'
import { DistrictGate } from './DistrictGate'
import { layoutMonuments, type MonumentTransfer } from './monumentLayout'
import { EmptyCivicSite, MonumentSprite } from './MonumentSprite'

export type { MonumentTransfer }

/** Camera: centre in screen-space world pixels, zoom = screen px per world px. */
export interface Camera {
  x: number
  y: number
  zoom: number
}

const MAX_ZOOM = 3.2
const HEADROOM = 420

/** Overview framing for the current city radius (grows as wards open). */
function homeFor(w: number, h: number, radius: number, drawerOpen = false): Camera {
  const e = { rx: (radius + 13) * 1.2247 * 16, ry: (radius + 13) * 0.7071 * 16 }
  const fit = Math.min(w / (2 * e.rx), h / (2 * e.ry + HEADROOM))
  if (w < 820) return { x: 0, y: -120, zoom: fit * Math.min(2.4, Math.max(1.4, h / w)) }
  const zoom = drawerOpen ? fit * 0.86 : fit
  return { x: drawerOpen ? 212 / zoom : 0, y: -HEADROOM / 2 + 40, zoom }
}

const DistrictLabels = memo(function DistrictLabels({
  capital,
  monumentsHeld,
  onSelect,
  scale,
  radii,
}: {
  capital: DistrictId | null
  monumentsHeld: Record<string, number>
  onSelect: (d: DistrictId) => void
  scale: number
  radii: Record<DistrictId, number>
}) {
  return (
    <g className="district-labels">
      {DISTRICTS.map((d) => {
        const p = districtLabelPos(d.id, radii[d.id])
        const isCap = capital === d.id
        const w = 50 + Math.max(64, d.name.length * 9.2) + (isCap ? 78 : 0)
        return (
          <g
            key={d.id}
            transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) scale(${scale})`}
            className="district-label"
            role="button"
            aria-label={`${d.title} Build Board`}
            data-testid={`district-label-${d.id}`}
            data-family={d.familyKey}
            onClick={(e) => {
              e.stopPropagation()
              onSelect(d.id)
            }}
          >
            <rect x={-w / 2} y={-17} width={w} height={34} rx={17} fill={isCap ? '#2a2106f0' : '#0b0f1ce6'} stroke={isCap ? '#ffd45a' : d.color} strokeWidth={isCap ? 2.2 : 1.2} />
            <CrestDisc href={d.art.primaryTransparent} color={d.color} cx={-w / 2 + 18} cy={0} r={13} />
            <text x={-w / 2 + 38} y={2} fontSize={12.5} fontWeight={800} fill="#f3f5fb" letterSpacing={1.2}>
              {d.name.toUpperCase()}
            </text>
            <text x={-w / 2 + 38.5} y={11} fontSize={6.2} fontWeight={700} fill={d.glow} fillOpacity={0.75} letterSpacing={2.2}>
              DISTRICT · {d.sigil}
            </text>
            {isCap && (
              <text x={w / 2 - 14} y={4} textAnchor="end" fontSize={9.5} fill="#ffd45a" fontWeight={900} letterSpacing={1}>
                ★ CAPITAL
              </text>
            )}
            {(monumentsHeld[d.id] ?? 0) > 0 && (
              <text x={0} y={30} textAnchor="middle" fontSize={10} fill={d.glow} fontWeight={700} letterSpacing={1.5}>
                {'◆'.repeat(monumentsHeld[d.id])}
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
})

/** Capital flags lining the district's edge toward City Hall (depth-sorted object). */
function CapitalFlags({ id, detail }: { id: DistrictId; detail: Detail }) {
  const d = getDistrict(id)
  const a = districtAngle(id)
  // Flags flank the district gateway (±7°) rather than standing in front of it.
  const offs = [-17, -13.5, -10, 10, 13.5, 17]
  return (
    <g className="capital-flags" data-testid="capital-flags">
      {offs.map((o) => {
        const p = isoW(polar(WORLD.civicSquare.inner - 0.6, a + o))
        return (
          <g key={o} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}>
            <circle cx={0} cy={-2} r={8} fill="url(#glow-warm)" opacity={0.45} />
            <rect x={-0.9} y={-52} width={1.8} height={52} fill="#e6e1d2" />
            <circle cx={0} cy={-53} r={2} fill="#ffd45a" />
            <path d="M0.9 -50 C 8 -52, 12 -46, 20 -48 L20 -34 C 12 -32, 8 -38, 0.9 -36 Z" fill={d.color} />
            <path d="M0.9 -50 C 8 -52, 12 -46, 20 -48 L20 -46 C 12 -44, 8 -50, 0.9 -48 Z" fill="#ffd45a" />
            {detail !== 'far' && <image href={d.art.secondaryTransparent} x={5.2} y={-46.5} width={10} height={10} />}
          </g>
        )
      })}
    </g>
  )
}

/** Floating crest above the Capital district's civic square (overlay layer). */
function CapitalCrest({ id, scale, compact }: { id: DistrictId; scale: number; compact: boolean }) {
  const d = getDistrict(id)
  const p = isoW(polar(WORLD.civicSquare.center, districtAngle(id)))
  // Away from near zoom the district label (★ CAPITAL) and the City Hall sign already name
  // the Capital, so the crest shrinks to a gold medallion marking the district's square.
  if (compact)
    return (
      <g transform={`translate(${p.x.toFixed(1)} ${(p.y - 300).toFixed(1)}) scale(${scale})`} pointerEvents="none" className="capital-crest" data-testid="capital-crest" data-family={d.familyKey} data-compact="true">
        <line x1={0} y1={22} x2={0} y2={150} stroke="#ffd45a" strokeOpacity={0.3} strokeDasharray="3 5" />
        <circle r={21} fill="#1e1705ee" stroke="#ffd45a" strokeWidth={2} />
        <CrestDisc href={d.art.primaryTransparent} color={d.color} cx={0} cy={0} r={15} />
        <text x={0} y={-24} textAnchor="middle" fontSize={11} fill="#ffd45a">
          ★
        </text>
      </g>
    )
  return (
    <g transform={`translate(${p.x.toFixed(1)} ${(p.y - 250).toFixed(1)}) scale(${scale})`} pointerEvents="none" className="capital-crest" data-testid="capital-crest" data-family={d.familyKey}>
      <line x1={0} y1={22} x2={0} y2={120} stroke="#ffd45a" strokeOpacity={0.35} strokeDasharray="3 5" />
      <rect x={-118} y={-21} width={236} height={42} rx={21} fill="#1e1705ee" stroke="#ffd45a" strokeWidth={2} />
      <CrestDisc href={d.art.primaryTransparent} color={d.color} cx={-96} cy={0} r={16} />
      <text x={14} y={-3} textAnchor="middle" fontSize={12} fontWeight={900} fill="#fff" letterSpacing={2}>
        {d.title.toUpperCase()}
      </text>
      <text x={14} y={11} textAnchor="middle" fontSize={8.5} fontWeight={900} fill="#ffd45a" letterSpacing={2.6}>
        ★ HOLDS THE CAPITAL ★
      </text>
    </g>
  )
}

interface Props {
  game: GameState
  selectedId: string | null
  onSelect: (id: string | null) => void
  onSelectDistrict: (d: DistrictId) => void
  focus: { buildingId: string; seq: number } | null
  fx: Record<string, BuildFx>
  transfers: MonumentTransfer[]
  drawerOpen: boolean
  homeSeq: number
  billboardDraft: { buildingId: string; image: string | null } | null
  /** Open the property-media viewer for a building's billboard. */
  onViewMedia: (buildingId: string) => void
  /** Current guided objective building (always labelled, always full detail). */
  objectiveId: string | null
}

interface CityObject {
  depth: number
  key: string
  bbox: Rect
  render: () => ReactNode
}

export function CityView({ game, selectedId, onSelect, onSelectDistrict, focus, fx, transfers, drawerOpen, homeSeq, billboardDraft, objectiveId, onViewMedia }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1280, h: 800 })
  const radius = useMemo(() => cityRadius(game.wards), [game.wards])
  const [cam, setCamState] = useState<Camera>(() => homeFor(1280, 800, radius))
  const camRef = useRef(cam)
  const setCam = useCallback((c: Camera) => {
    camRef.current = c
    setCamState(c)
  }, [])
  const animRef = useRef(0)
  const touched = useRef(false)
  const radiusRef = useRef(radius)
  useEffect(() => {
    radiusRef.current = radius
  }, [radius])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      if (r.width > 0 && r.height > 0) {
        setSize({ w: r.width, h: r.height })
        if (!touched.current) setCam(homeFor(r.width, r.height, radiusRef.current))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [setCam])

  const home = homeFor(size.w, size.h, radius)
  const minZoom = home.zoom * 0.7
  const clampZoom = useCallback((z: number) => Math.min(MAX_ZOOM, Math.max(minZoom, z)), [minZoom])
  const vbW = size.w / cam.zoom
  const vbH = size.h / cam.zoom
  const viewBox = `${(cam.x - vbW / 2).toFixed(1)} ${(cam.y - vbH / 2).toFixed(1)} ${vbW.toFixed(1)} ${vbH.toFixed(1)}`
  const detail = detailFor(cam.zoom)
  // Labels stay roughly constant on screen; quantised so sprites only re-render on steps.
  const labelScale = Math.round(Math.min(2.4, Math.max(0.6, 1 / cam.zoom)) * 10) / 10
  const view: Rect = { x0: cam.x - vbW / 2 - 60, y0: cam.y - vbH / 2 - 60, x1: cam.x + vbW / 2 + 60, y1: cam.y + vbH / 2 + 60 }

  const animateTo = useCallback(
    (target: Camera, duration = 1000) => {
      touched.current = true
      cancelAnimationFrame(animRef.current)
      if (prefersReducedMotion()) {
        animRef.current = requestAnimationFrame(() => setCam(target))
        return
      }
      const from = camRef.current
      const start = performance.now()
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration)
        const e = easeInOutCubic(t)
        // Pull back mid-flight for a "warp" arc.
        const hop = 1 - Math.sin(Math.PI * t) * 0.22
        const zoom = Math.exp(Math.log(from.zoom) + (Math.log(target.zoom) - Math.log(from.zoom)) * e) * hop
        setCam({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, zoom })
        if (t < 1) animRef.current = requestAnimationFrame(tick)
      }
      animRef.current = requestAnimationFrame(tick)
    },
    [setCam],
  )

  // Warp requests
  useEffect(() => {
    if (!focus) return
    const b = game.buildings[focus.buildingId]
    if (!b) return
    const p = buildingFocus(b, totalBuilt(b))
    const zoom = size.w < 820 ? 0.62 : Math.min(1.5, Math.max(0.85, size.w / 560))
    const offsetX = drawerOpen && size.w > 820 ? 210 / zoom : 0
    const offsetY = drawerOpen && size.w <= 820 ? (size.h * 0.16) / zoom : 0
    animateTo({ x: p.x + offsetX, y: p.y + offsetY, zoom })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq])

  useEffect(() => {
    if (homeSeq > 0) animateTo(homeFor(size.w, size.h, radiusRef.current, drawerOpen), 800)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeSeq, animateTo])

  // Pointer pan + pinch
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const drag = useRef<{ x: number; y: number; cam: Camera; moved: boolean; pinch?: number } | null>(null)
  const suppressClick = useRef(false)

  const onPointerDown = (e: RPointerEvent) => {
    touched.current = true
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    cancelAnimationFrame(animRef.current)
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      drag.current = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, cam: camRef.current, moved: true, pinch: Math.hypot(a.x - b.x, a.y - b.y) }
    } else {
      drag.current = { x: e.clientX, y: e.clientY, cam: camRef.current, moved: false }
    }
  }
  const onPointerMove = (e: RPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const d = drag.current
    if (!d) return
    if (d.pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      setCam({ ...d.cam, zoom: clampZoom(d.cam.zoom * (dist / d.pinch)) })
      return
    }
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 5) return
    if (!d.moved) (e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    d.moved = true
    setCam({ ...d.cam, x: d.cam.x - dx / d.cam.zoom, y: d.cam.y - dy / d.cam.zoom })
  }
  const onPointerUp = (e: RPointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (drag.current?.moved) suppressClick.current = true
    if (pointers.current.size === 0) drag.current = null
  }
  const onWheel = (e: RWheelEvent) => {
    touched.current = true
    cancelAnimationFrame(animRef.current)
    const rect = wrapRef.current!.getBoundingClientRect()
    const c = camRef.current
    const mx = e.clientX - rect.left - rect.width / 2
    const my = e.clientY - rect.top - rect.height / 2
    const wx = c.x + mx / c.zoom
    const wy = c.y + my / c.zoom
    const zoom = clampZoom(c.zoom * Math.exp(-e.deltaY * 0.0015))
    setCam({ zoom, x: wx - mx / zoom, y: wy - my / zoom })
  }
  const zoomBy = (f: number) => animateTo({ ...camRef.current, zoom: clampZoom(camRef.current.zoom * f) }, 350)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const stop = (e: WheelEvent) => e.preventDefault()
    el.addEventListener('wheel', stop, { passive: false })
    return () => el.removeEventListener('wheel', stop)
  }, [])

  const handleSelect = useCallback(
    (id: string) => {
      if (suppressClick.current) {
        suppressClick.current = false
        return
      }
      onSelect(id)
    },
    [onSelect],
  )

  const handleViewMedia = useCallback(
    (id: string) => {
      // A drag that ended on a billboard is a pan, not a click.
      if (suppressClick.current) {
        suppressClick.current = false
        return
      }
      onViewMedia(id)
    },
    [onViewMedia],
  )

  const monumentsHeld = useMemo(() => {
    const out: Record<string, number> = {}
    for (const m of MONUMENTS) {
      const h = game.monuments[m.id].holder
      if (h) out[h] = (out[h] ?? 0) + 1
    }
    return out
  }, [game.monuments])

  const labelRadii = useMemo(() => {
    const out = {} as Record<DistrictId, number>
    for (const d of DISTRICTS) out[d.id] = wardBand((game.wards[d.id] ?? 1) - 1).outer
    return out
  }, [game.wards])

  const featuredFriend = useMemo(() => {
    if (!game.capital.holder) return null
    const best = Object.values(game.buildings)
      .filter((b) => b.districtId === game.capital.holder)
      .sort((a, b) => totalBuilt(b) - totalBuilt(a))[0]
    return best?.friendId ?? null
  }, [game.buildings, game.capital.holder])

  const occupied = useMemo(() => {
    const out = Object.fromEntries(DISTRICTS.map((d) => [d.id, new Set<string>()])) as Record<DistrictId, Set<string>>
    for (const b of Object.values(game.buildings)) out[b.districtId].add(`${b.ward}:${b.plot}`)
    return out
  }, [game.buildings])

  const placedMonuments = useMemo(() => layoutMonuments(game.monuments, transfers), [game.monuments, transfers])

  // Level of detail: which buildings render individually vs as simple massing.
  const lodFull = useMemo(() => {
    const keep = new Set<string>([selectedId ?? '', game.crown.holder ?? '', objectiveId ?? ''])
    for (const b of Object.values(game.buildings)) if (b.ownerId === DEMO_PLAYER_ID) keep.add(b.id)
    const groups = new Map<string, Building[]>()
    for (const b of Object.values(game.buildings)) {
      const k = `${b.districtId}:${b.ward}`
      groups.set(k, [...(groups.get(k) ?? []), b])
    }
    const full = new Set<string>()
    for (const list of groups.values()) {
      if (wardRenderMode(list.length, detail) === 'individual') list.forEach((b) => full.add(b.id))
      else representativeBuildings(list, keep).forEach((id) => full.add(id))
    }
    return full
  }, [game.buildings, game.crown.holder, selectedId, detail, objectiveId])

  const objects = useMemo(() => {
    const out: CityObject[] = []
    for (const b of Object.values(game.buildings)) {
      const p = placeBuilding(b)
      const total = totalBuilt(b)
      const H = buildingHeightPx(total)
      const full = lodFull.has(b.id)
      const draft = billboardDraft?.buildingId === b.id ? billboardDraft : null
      out.push({
        depth: p.depth,
        key: b.id,
        bbox: { x0: p.screen.x - 90, x1: p.screen.x + 90, y0: p.screen.y - H - 220, y1: p.screen.y + 60 },
        render: () => (
          <g key={b.id} transform={`translate(${p.screen.x.toFixed(1)} ${p.screen.y.toFixed(1)})`}>
            {full ? (
              <BuildingSprite
                building={draft ? { ...b, billboard: { ...b.billboard, image: draft.image } } : b}
                total={total}
                users={game.users}
                selected={selectedId === b.id}
                isPlayer={b.ownerId === DEMO_PLAYER_ID}
                isCrown={game.crown.holder === b.id}
                detail={detail}
                fx={fx[b.id] ?? null}
                onSelect={handleSelect}
                labelScale={labelScale}
                isObjective={objectiveId === b.id}
                onViewMedia={handleViewMedia}
              />
            ) : (
              <MassingSprite building={b} total={total} onSelect={handleSelect} onViewMedia={handleViewMedia} />
            )}
          </g>
        ),
      })
    }
    for (const m of placedMonuments) {
      const p = place(m.world)
      out.push({
        depth: p.depth,
        key: `mon-${m.districtId}-${m.monumentId}`,
        bbox: { x0: p.screen.x - 150, x1: p.screen.x + 150, y0: p.screen.y - 420, y1: p.screen.y + 90 },
        render: () => (
          <g key={`mon-${m.districtId}-${m.monumentId}`} transform={`translate(${p.screen.x.toFixed(1)} ${p.screen.y.toFixed(1)})`}>
            <MonumentSprite
              key={m.phase === 'falling' ? `ruin-${m.transferKey}` : `${m.districtId}-${m.monumentId}`}
              monumentId={m.monumentId}
              districtId={m.districtId}
              phase={m.phase}
              detail={detail}
              scale={m.scale}
              labelScale={labelScale}
            />
          </g>
        ),
      })
    }
    for (const d of DISTRICTS) {
      if (placedMonuments.some((m) => m.districtId === d.id)) continue
      const p = place(polar(WORLD.civicSquare.center, districtAngle(d.id)))
      out.push({
        depth: p.depth,
        key: `civic-${d.id}`,
        bbox: { x0: p.screen.x - 60, x1: p.screen.x + 60, y0: p.screen.y - 40, y1: p.screen.y + 40 },
        render: () => (
          <g key={`civic-${d.id}`} transform={`translate(${p.screen.x.toFixed(1)} ${p.screen.y.toFixed(1)})`}>
            <EmptyCivicSite />
          </g>
        ),
      })
    }
    if (game.capital.holder) {
      const cp = place(polar(WORLD.civicSquare.inner - 0.6, districtAngle(game.capital.holder)))
      const holder = game.capital.holder
      out.push({
        depth: cp.depth,
        key: 'capital-flags',
        bbox: { x0: cp.screen.x - 260, x1: cp.screen.x + 260, y0: cp.screen.y - 200, y1: cp.screen.y + 200 },
        render: () => <CapitalFlags key="capital-flags" id={holder} detail={detail} />,
      })
    }
    MONUMENTS.forEach((m, i) => {
      const w = pylonWorld(i)
      const s = iso(w.x, w.y)
      out.push({
        depth: w.x + w.y,
        key: `pylon-${m.id}`,
        bbox: { x0: s.x - 30, x1: s.x + 30, y0: s.y - 80, y1: s.y + 20 },
        render: () => (
          <g key={`pylon-${m.id}`} transform={`translate(${s.x} ${s.y})`}>
            <RegistryPylon monumentId={m.id} holder={game.monuments[m.id].holder} />
          </g>
        ),
      })
    })
    out.push({ depth: 0, key: 'city-hall', bbox: { x0: -200, x1: 200, y0: -260, y1: 120 }, render: () => <CityHall key="city-hall" capital={game.capital.holder} /> })
    const f = iso(9.5, 9.5)
    out.push({ depth: 19, key: 'fountain', bbox: { x0: f.x - 50, x1: f.x + 50, y0: f.y - 40, y1: f.y + 30 }, render: () => <g key="fountain" transform={`translate(${f.x} ${f.y})`}><Fountain /></g> })
    return out.sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key))
  }, [game.buildings, game.users, game.crown.holder, game.monuments, game.capital.holder, selectedId, detail, fx, handleSelect, handleViewMedia, placedMonuments, lodFull, billboardDraft, labelScale, objectiveId])

  // Viewport culling: only mount what intersects the camera view.
  const visible = objects.filter((o) => intersects(o.bbox, view))

  // District gateways (mid/near only). Drawn beneath city objects so monument name pills,
  // which carry higher priority, always read on top of them.
  const gates =
    detail === 'far'
      ? []
      : DISTRICTS.map((d) => ({ d, g: place(gateWorld(d.id)) })).filter(({ g }) =>
          intersects({ x0: g.screen.x - 90, x1: g.screen.x + 90, y0: g.screen.y - 110, y1: g.screen.y + 40 }, view),
        )

  // Monument name pills are re-drawn above neighbouring monuments/flags (same <use> trick).
  const monumentLabels =
    detail === 'far'
      ? []
      : placedMonuments
          .filter((m) => m.phase !== 'falling' && visible.some((o) => o.key === `mon-${m.districtId}-${m.monumentId}`))
          .map((m) => ({ key: `${m.districtId}-${m.monumentId}`, p: place(m.world).screen, s: m.scale * 1.15 }))

  // Priority building labels (selected, yours, Crown, objective) are re-drawn above the
  // district labels with a cheap <use> of the label each sprite already renders.
  const priorityLabels = [...new Set([selectedId, objectiveId, game.crown.holder, ...Object.values(game.buildings).filter((b) => b.ownerId === DEMO_PLAYER_ID).map((b) => b.id)])]
    .filter((id): id is string => !!id && !!game.buildings[id] && lodFull.has(id) && visible.some((o) => o.key === id))
    .map((id) => ({ id, p: placeBuilding(game.buildings[id]).screen }))

  return (
    <div className={`city-wrap detail-${detail}`} ref={wrapRef} data-testid="city" data-zoom={cam.zoom.toFixed(2)} data-detail={detail} data-rendered={visible.length} data-radius={radius}>
      {/* ONE svg root with ONE camera viewBox: ground and objects always repaint together
          (separate roots could tear apart during production pan/zoom). Ground draws first. */}
      <svg
        className="city-svg"
        data-testid="city-svg"
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false
            return
          }
          onSelect(null)
        }}
        role="application"
        aria-label="Generations City map. Drag to pan, scroll to zoom, Tab to buildings."
      >
        <CityDefs />
        <g className="ground-layer" aria-hidden="true">
          <CityGround wards={game.wards} capital={game.capital.holder} radius={radius} detail={detail} occupied={occupied} />
        </g>
        <g className="gates">
          {gates.map(({ d, g }) => (
            <g key={d.id} transform={`translate(${g.screen.x.toFixed(1)} ${g.screen.y.toFixed(1)})`}>
              <DistrictGate id={d.id} detail={detail} isCapital={game.capital.holder === d.id} />
            </g>
          ))}
        </g>
        <g className="objects">{visible.map((o) => o.render())}</g>
        <g className="monument-labels" pointerEvents="none" aria-hidden="true">
          {monumentLabels.map(({ key, p, s }) => (
            <use key={key} href={`#ml-${key}`} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) scale(${s})`} />
          ))}
        </g>
        {/* District identity reads above ordinary towers; priority building labels above that. */}
        <DistrictLabels capital={game.capital.holder} monumentsHeld={monumentsHeld} onSelect={onSelectDistrict} scale={Math.max(0.8, labelScale * 0.95)} radii={labelRadii} />
        <g className="priority-labels" pointerEvents="none" aria-hidden="true">
          {priorityLabels.map(({ id, p }) => (
            <use key={id} href={`#bl-${id}`} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`} />
          ))}
        </g>
        <CapitalSign capital={game.capital.holder} featuredFriend={featuredFriend} detail={detail} />
        {game.capital.holder && <CapitalCrest id={game.capital.holder} scale={Math.min(1.15, labelScale)} compact={detail !== 'near'} />}
        <TransferArcs transfers={transfers} placed={placedMonuments} />
      </svg>
      <div className="zoom-controls" role="group" aria-label="Camera">
        <button type="button" onClick={() => zoomBy(1.4)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.4)} aria-label="Zoom out">
          −
        </button>
        <button type="button" onClick={() => animateTo(homeFor(size.w, size.h, radius, drawerOpen), 800)} aria-label="City overview" title="City overview">
          ⌂
        </button>
      </div>
    </div>
  )
}

function TransferArcs({ transfers, placed }: { transfers: MonumentTransfer[]; placed: ReturnType<typeof layoutMonuments> }) {
  return (
    <g pointerEvents="none">
      {transfers.map((t) => {
        if (!t.from || !t.to) return null
        const from = placed.find((m) => m.monumentId === t.monumentId && m.districtId === t.from)
        const to = placed.find((m) => m.monumentId === t.monumentId && m.districtId === t.to)
        if (!from || !to) return null
        const a = isoW(from.world)
        const b = isoW(to.world)
        const mx = (a.x + b.x) / 2
        const my = Math.min(a.y, b.y) - 520
        const color = getDistrict(t.to).glow
        const d = `M${a.x} ${a.y - 90} Q${mx} ${my} ${b.x} ${b.y - 90}`
        return (
          <g key={t.key} className="transfer-arc">
            <path d={d} stroke={color} strokeWidth={14} fill="none" opacity={0.18} />
            <path d={d} stroke={color} strokeWidth={4} fill="none" strokeDasharray="2200" className="arc-draw" />
            <circle r={9} fill="#fff" className="arc-comet">
              <animateMotion dur="1.6s" fill="freeze" path={d} />
            </circle>
          </g>
        )
      })}
    </g>
  )
}
