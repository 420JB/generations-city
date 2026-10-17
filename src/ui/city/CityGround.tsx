import { memo } from 'react'
import { WORLD } from '../../config/world'
import { isFoundingWard, wardName } from '../../game/allocation'
import { polar, wardBand, wardStreetRadius } from '../../game/world'
import { PlazaGround } from './CapitalPlaza'
import { CityPerimeter } from './CityPerimeter'
import { plotWorldIn, usableHalfSpanOf, wardCapacityIn } from './districtGeometry'
import { propertyLotHalf } from './roads'
import { arcPath, boxCorners, isoEllipse, isoW, sectorPolygon, type Detail } from './geometry'
import { sceneDistrict, useCityScene, type SceneDistrict } from './scene'

/** Street furniture was laid out for the legacy 40° wedge; wider wedges get proportionally more of it. */
const FURNITURE_SPAN_DEG = 40

function StreetArc({ d, r, width = 11, rot }: { d: SceneDistrict; r: number; width?: number; rot: number }) {
  const pts = arcPath(d, r, undefined, rot)
  return (
    <g>
      <polyline points={pts} fill="none" stroke="#0c0f1a" strokeWidth={width} strokeLinecap="round" />
      <polyline points={pts} fill="none" stroke="#f5d78a" strokeOpacity={0.22} strokeWidth={0.9} strokeDasharray="7 9" />
    </g>
  )
}

function StreetTrees({ d, r, count: baseCount = 9, span: baseSpan = 34, rot }: { d: SceneDistrict; r: number; count?: number; span?: number; rot: number }) {
  const a = d.centerDeg
  const k = d.spanDeg / FURNITURE_SPAN_DEG
  const span = baseSpan * k
  const count = Math.max(2, Math.round(baseCount * k))
  return (
    <g>
      {Array.from({ length: count }, (_, i) => {
        const p = isoW(polar(r, a - span / 2 + (i * span) / (count - 1)), rot)
        return (
          <g key={i} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}>
            <rect x={-0.6} y={-6} width={1.2} height={6} fill="#3d2e22" />
            <circle cx={0} cy={-9} r={4.6} fill="#1d5c42" />
            <circle cx={-1.4} cy={-10.4} r={2.4} fill="#2a7a57" />
          </g>
        )
      })}
    </g>
  )
}

/**
 * Where a ward's name sits: in the lot-free strip at the ward's outer boundary, well inside
 * the wedge (60% of the usable half-span off-centre), clear of the radial boundary avenues and
 * of the district label at the wedge centre, for every district. An inner ward's label sits
 * on the boundary itself (midway between its last lots and the next ward's first lots); the
 * outermost ward's label nudges out into the empty margin before the ghost ward.
 */
function wardMarkerPlacement(d: SceneDistrict, ward: number, outermost: boolean, cityRot: number) {
  const r = wardBand(ward).outer + (outermost ? 1 : 0)
  const deg = d.centerDeg + usableHalfSpanOf(d) * 0.6
  const p = isoW(polar(r, deg), cityRot)
  // Run the text along the ward boundary as it appears on screen (never upside down),
  // re-derived from the projected boundary so it stays readable at any city rotation.
  const q = isoW(polar(r, deg + 1), cityRot)
  let rot = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI
  if (rot > 90) rot -= 180
  if (rot < -90) rot += 180
  return { p, rot }
}

/** Civic ground signage naming a ward; Ward I adds its Founding Ward title (prestige only). */
function WardMarker({ d, ward, outermost, rot: cityRot }: { d: SceneDistrict; ward: number; outermost: boolean; rot: number }) {
  const { p, rot } = wardMarkerPlacement(d, ward, outermost, cityRot)
  const founding = isFoundingWard(ward)
  // Thin dark halo in the ground colour (not a card) so roads/ground never swallow the text.
  const halo = { stroke: '#0b0f1a', strokeOpacity: 0.85, strokeWidth: 3, strokeLinejoin: 'round' as const, paintOrder: 'stroke' as const }
  return (
    <g className="ward-marker" data-testid={`ward-marker-${d.id}-${ward}`} data-ward={ward} data-founding={founding ? 'true' : 'false'} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${rot.toFixed(1)})`}>
      <text x={0} y={founding ? -1 : 3} textAnchor="middle" fontSize={9} fontWeight={800} fill="#d3dbee" fillOpacity={0.72} letterSpacing={2.2} {...halo}>
        {wardName(ward).toUpperCase()}
      </text>
      {founding && (
        <text x={0} y={8} textAnchor="middle" fontSize={5.6} fontWeight={700} fill="#e8d7a6" fillOpacity={0.55} letterSpacing={2.6} {...halo}>
          FOUNDING WARD
        </text>
      )}
    </g>
  )
}

/** Faint outline of the next ward that will open as more residents join. */
function GhostWard({ d, ward, detail, rot, residents }: { d: SceneDistrict; ward: number; detail: Detail; rot: number; residents: string }) {
  const band = wardBand(ward)
  const cap = wardCapacityIn(d, ward)
  const mid = isoW(polar((band.inner + band.outer) / 2, d.centerDeg), rot)
  return (
    <g className="ghost-ward" data-testid={`ghost-ward-${d.id}`} data-ward={ward}>
      <polygon points={sectorPolygon(d, band.inner + 0.6, band.outer, undefined, rot)} fill="#8fb4ff" fillOpacity={0.035} stroke="#8fb4ff" strokeOpacity={0.3} strokeDasharray="10 10" strokeWidth={1.6} />
      {Array.from({ length: cap }, (_, i) => {
        const p = isoW(plotWorldIn(d, ward, i), rot)
        const c = boxCorners(propertyLotHalf(d, ward, i, 0, rot))
        return (
          <polygon
            key={i}
            points={`${(p.x + c.W.x).toFixed(1)},${p.y.toFixed(1)} ${p.x.toFixed(1)},${(p.y + c.N.y).toFixed(1)} ${(p.x + c.E.x).toFixed(1)},${p.y.toFixed(1)} ${p.x.toFixed(1)},${(p.y + c.Sx.y).toFixed(1)}`}
            fill="none"
            stroke="#8fb4ff"
            strokeOpacity={0.2}
            strokeDasharray="3 4"
          />
        )
      })}
      {detail !== 'far' && (
        <text x={mid.x} y={mid.y} textAnchor="middle" fontSize={11} fontWeight={700} fill="#8fb4ff" fillOpacity={0.55} letterSpacing={2}>
          {wardName(ward).toUpperCase()} · OPENS AS {residents.toUpperCase()} JOIN
        </text>
      )}
    </g>
  )
}

/** Temporary Capital identity on the ground: gold causeway, civic border, string lights. */
function CapitalGround({ d, rot }: { d: SceneDistrict; rot: number }) {
  const a = d.centerDeg
  const strip = (r0: number, r1: number, half: number) => {
    const pts = [polar(r0, a - (half / r0) * 57.3), polar(r1, a - (half / r1) * 57.3), polar(r1, a + (half / r1) * 57.3), polar(r0, a + (half / r0) * 57.3)]
    return pts.map((p) => isoW(p, rot)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  }
  return (
    <g className="capital-ground" data-testid="capital-ground" data-district={d.id}>
      <polygon points={sectorPolygon(d, WORLD.ringRoadOuter, WORLD.coreWard.outer, undefined, rot)} fill={d.color} fillOpacity={0.07} />
      <polygon points={sectorPolygon(d, WORLD.plazaRadius + 0.3, WORLD.ringRoadOuter - 0.3, 6, rot)} fill="#ffd45a" fillOpacity={0.14} />
      <polygon points={strip(WORLD.plazaRadius - 2, WORLD.civicSquare.inner + 0.5, 2.2)} fill="#ffd45a" fillOpacity={0.35} stroke="#ffe7a6" strokeOpacity={0.8} />
      <polygon points={strip(WORLD.plazaRadius - 2, WORLD.civicSquare.inner + 0.5, 1)} fill="#b8322f" fillOpacity={0.55} />
      <polyline points={arcPath(d, WORLD.coreWard.outer - 0.8, undefined, rot)} fill="none" stroke="#ffd45a" strokeWidth={2.4} strokeDasharray="1 9" strokeLinecap="round" />
      <polygon points={sectorPolygon(d, WORLD.civicSquare.inner, WORLD.civicSquare.outer, 2.6, rot)} fill="none" stroke="#ffd45a" strokeWidth={2} strokeOpacity={0.8} />
    </g>
  )
}

/** Unclaimed plots in open wards: ready for the next resident who joins this district. */
function OpenPlots({ d, open, occupied, rot }: { d: SceneDistrict; open: number; occupied: ReadonlySet<string> | undefined; rot: number }) {
  const out = []
  for (let w = 0; w < open; w++) {
    for (let i = 0; i < wardCapacityIn(d, w); i++) {
      if (occupied?.has(`${w}:${i}`)) continue
      const p = isoW(plotWorldIn(d, w, i), rot)
      const c = boxCorners(propertyLotHalf(d, w, i, 0, rot))
      out.push(
        <g key={`${w}-${i}`} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`} data-testid={`open-plot-${d.id}-${w}-${i}`}>
          <polygon points={`${c.W.x},0 0,${c.N.y} ${c.E.x},0 0,${c.Sx.y}`} fill="#ffffff" fillOpacity={0.03} stroke="#9fb6d9" strokeOpacity={0.35} strokeDasharray="4 4" />
          <text x={0} y={3} textAnchor="middle" fontSize={7} fill="#9fb6d9" fillOpacity={0.6} letterSpacing={1}>
            OPEN PLOT
          </text>
        </g>,
      )
    }
  }
  return <g className="open-plots">{out}</g>
}

export const CityGround = memo(function CityGround({
  wards,
  capital,
  radius,
  detail,
  occupied,
  rot,
}: {
  wards: Readonly<Record<string, number>>
  capital: string | null
  radius: number
  detail: Detail
  occupied: Readonly<Record<string, ReadonlySet<string>>>
  /** City rotation in degrees: the ground turns about City Hall, re-projected point by point. */
  rot: number
}) {
  const scene = useCityScene()
  const districts = scene.districts
  const city = isoEllipse(radius + 1.5)
  return (
    <g className="ground">
      <CityPerimeter radius={radius} rot={rot} />
      <ellipse rx={city.rx} ry={city.ry} fill="#0a0d18" stroke="#2a3558" strokeWidth={2} opacity={0.6} />
      {districts.map((d) => {
        const open = wards[d.id] ?? 1
        return (
          <g key={d.id}>
            {Array.from({ length: open }, (_, w) => {
              const band = wardBand(w)
              return (
                <polygon
                  key={w}
                  points={sectorPolygon(d, w === 0 ? WORLD.ringRoadOuter + 0.6 : band.inner + 0.9, band.outer, undefined, rot)}
                  fill={`url(#ground-${d.paint})`}
                  stroke={d.color}
                  strokeOpacity={capital === d.id ? 0.9 : 0.35}
                  strokeWidth={capital === d.id ? 3 : 1.5}
                  className="district-ground"
                  data-testid={w === 0 ? `district-${d.id}` : `ward-${d.id}-${w}`}
                />
              )
            })}
            {Array.from({ length: open }, (_, w) => (
              <polygon key={`blk-${w}`} points={sectorPolygon(d, w === 0 ? WORLD.civicSquare.outer + 2 : wardBand(w).inner + 1, wardBand(w).outer, undefined, rot)} fill="url(#city-blocks)" />
            ))}
            {/* Civic square: a lawn park with paved promenade where monuments stand */}
            <polygon points={sectorPolygon(d, WORLD.civicSquare.inner, WORLD.civicSquare.outer, 2.6, rot)} fill="#2b3040" stroke={d.color} strokeOpacity={0.35} />
            <polygon points={sectorPolygon(d, WORLD.civicSquare.inner + 1.4, WORLD.civicSquare.outer - 1.4, 4, rot)} fill="#1b3a2b" fillOpacity={0.9} />
            <polyline points={arcPath(d, WORLD.civicSquare.center, 4, rot)} fill="none" stroke="#3e4459" strokeWidth={12} />
            <polyline points={arcPath(d, WORLD.civicSquare.center, 4, rot)} fill="none" stroke={d.color} strokeOpacity={0.25} strokeWidth={1} strokeDasharray="2 6" />
            <StreetTrees d={d} r={WORLD.civicSquare.inner + 1.9} count={8} span={30} rot={rot} />
            <StreetTrees d={d} r={WORLD.civicSquare.outer - 1.7} count={9} span={32} rot={rot} />
            <OpenPlots d={d} open={open} occupied={occupied[d.id]} rot={rot} />
            <StreetArc d={d} r={WORLD.civicSquare.outer + 1} rot={rot} />
            {Array.from({ length: open }, (_, w) => (
              <g key={`st-${w}`}>
                {w > 0 && <StreetArc d={d} r={wardBand(w).inner} width={12} rot={rot} />}
                <StreetArc d={d} r={wardStreetRadius(w)} width={10} rot={rot} />
                <StreetTrees d={d} r={wardStreetRadius(w) + 1.6} count={9 + w * 3} rot={rot} />
              </g>
            ))}
            <GhostWard d={d} ward={open} detail={detail} rot={rot} residents={scene.resident.many} />
          </g>
        )
      })}
      {capital && <CapitalGround d={sceneDistrict(scene, capital)} rot={rot} />}
      {districts.map((d, i) => {
        // The boundary avenue on this wedge's far edge, running out as far as either neighbour's wards.
        const next = districts[(i + 1) % districts.length]
        const a = d.centerDeg + d.spanDeg / 2
        const outer = Math.max(wardBand((wards[d.id] ?? 1) - 1).outer, wardBand((wards[next.id] ?? 1) - 1).outer)
        const s0 = isoW(polar(WORLD.ringRoadOuter, a), rot)
        const s1 = isoW(polar(outer + 1, a), rot)
        return (
          <g key={d.id}>
            <line x1={s0.x} y1={s0.y} x2={s1.x} y2={s1.y} stroke="#0c0f1a" strokeWidth={20} strokeLinecap="round" />
            <line x1={s0.x} y1={s0.y} x2={s1.x} y2={s1.y} stroke="#f5d78a" strokeOpacity={0.3} strokeWidth={1} strokeDasharray="8 10" />
          </g>
        )
      })}
      {/* Ward names last in the ground layer: no road paints over them; buildings still sit above. */}
      {detail !== 'far' && (
        <g className="ward-markers">
          {districts.flatMap((d) => {
            const open = wards[d.id] ?? 1
            return Array.from({ length: open }, (_, w) => <WardMarker key={`${d.id}-${w}`} d={d} ward={w} outermost={w === open - 1} rot={rot} />)
          })}
        </g>
      )}
      <PlazaGround capital={capital} rot={rot} />
    </g>
  )
})
