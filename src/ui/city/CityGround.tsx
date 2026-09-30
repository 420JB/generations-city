import { memo } from 'react'
import { DISTRICTS, getDistrict, type DistrictId } from '../../config/districts'
import { WORLD } from '../../config/world'
import { isFoundingWard, wardName } from '../../game/allocation'
import { districtAngle, plotWorld, polar, usableHalfSpanDeg, wardBand, wardCapacity, wardStreetRadius } from '../../game/world'
import { PlazaGround } from './CapitalPlaza'
import { arcPath, boxCorners, isoEllipse, isoW, sectorPolygon, type Detail } from './geometry'

function StreetArc({ id, r, width = 11 }: { id: DistrictId; r: number; width?: number }) {
  const d = arcPath(id, r)
  return (
    <g>
      <polyline points={d} fill="none" stroke="#0c0f1a" strokeWidth={width} strokeLinecap="round" />
      <polyline points={d} fill="none" stroke="#f5d78a" strokeOpacity={0.22} strokeWidth={0.9} strokeDasharray="7 9" />
    </g>
  )
}

function StreetTrees({ id, r, count = 9, span = 34 }: { id: DistrictId; r: number; count?: number; span?: number }) {
  const a = districtAngle(id)
  return (
    <g>
      {Array.from({ length: count }, (_, i) => {
        const p = isoW(polar(r, a - span / 2 + (i * span) / (count - 1)))
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
function wardMarkerPlacement(id: DistrictId, ward: number, outermost: boolean) {
  const r = wardBand(ward).outer + (outermost ? 1 : 0)
  const deg = districtAngle(id) + usableHalfSpanDeg() * 0.6
  const p = isoW(polar(r, deg))
  // Run the text along the ward boundary as it appears on screen (never upside down).
  const q = isoW(polar(r, deg + 1))
  let rot = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI
  if (rot > 90) rot -= 180
  if (rot < -90) rot += 180
  return { p, rot }
}

/** Civic ground signage naming a ward; Ward I adds its Founding Ward title (prestige only). */
function WardMarker({ id, ward, outermost }: { id: DistrictId; ward: number; outermost: boolean }) {
  const { p, rot } = wardMarkerPlacement(id, ward, outermost)
  const founding = isFoundingWard(ward)
  // Thin dark halo in the ground colour (not a card) so roads/ground never swallow the text.
  const halo = { stroke: '#0b0f1a', strokeOpacity: 0.85, strokeWidth: 3, strokeLinejoin: 'round' as const, paintOrder: 'stroke' as const }
  return (
    <g className="ward-marker" data-testid={`ward-marker-${id}-${ward}`} data-ward={ward} data-founding={founding ? 'true' : 'false'} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${rot.toFixed(1)})`}>
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

/** Faint outline of the next ward that will open as more Friends join. */
function GhostWard({ id, ward, detail }: { id: DistrictId; ward: number; detail: Detail }) {
  const band = wardBand(ward)
  const cap = wardCapacity(ward)
  const mid = isoW(polar((band.inner + band.outer) / 2, districtAngle(id)))
  const c = boxCorners(1.6)
  return (
    <g className="ghost-ward" data-testid={`ghost-ward-${id}`} data-ward={ward}>
      <polygon points={sectorPolygon(id, band.inner + 0.6, band.outer)} fill="#8fb4ff" fillOpacity={0.035} stroke="#8fb4ff" strokeOpacity={0.3} strokeDasharray="10 10" strokeWidth={1.6} />
      {Array.from({ length: cap }, (_, i) => {
        const p = isoW(plotWorld(id, ward, i))
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
          {wardName(ward).toUpperCase()} · OPENS AS FRIENDS JOIN
        </text>
      )}
    </g>
  )
}

/** Temporary Capital identity on the ground: gold causeway, civic border, string lights. */
function CapitalGround({ id }: { id: DistrictId }) {
  const d = getDistrict(id)
  const a = districtAngle(id)
  const strip = (r0: number, r1: number, half: number) => {
    const pts = [polar(r0, a - (half / r0) * 57.3), polar(r1, a - (half / r1) * 57.3), polar(r1, a + (half / r1) * 57.3), polar(r0, a + (half / r0) * 57.3)]
    return pts.map((p) => isoW(p)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  }
  return (
    <g className="capital-ground" data-testid="capital-ground" data-district={id}>
      <polygon points={sectorPolygon(id, WORLD.ringRoadOuter, WORLD.coreWard.outer)} fill={d.color} fillOpacity={0.07} />
      <polygon points={sectorPolygon(id, WORLD.plazaRadius + 0.3, WORLD.ringRoadOuter - 0.3, 6)} fill="#ffd45a" fillOpacity={0.14} />
      <polygon points={strip(WORLD.plazaRadius - 2, WORLD.civicSquare.inner + 0.5, 2.2)} fill="#ffd45a" fillOpacity={0.35} stroke="#ffe7a6" strokeOpacity={0.8} />
      <polygon points={strip(WORLD.plazaRadius - 2, WORLD.civicSquare.inner + 0.5, 1)} fill="#b8322f" fillOpacity={0.55} />
      <polyline points={arcPath(id, WORLD.coreWard.outer - 0.8)} fill="none" stroke="#ffd45a" strokeWidth={2.4} strokeDasharray="1 9" strokeLinecap="round" />
      <polygon points={sectorPolygon(id, WORLD.civicSquare.inner, WORLD.civicSquare.outer, 2.6)} fill="none" stroke="#ffd45a" strokeWidth={2} strokeOpacity={0.8} />
    </g>
  )
}

/** Unclaimed plots in open wards: ready for the next Friend who joins this district. */
function OpenPlots({ id, open, occupied }: { id: DistrictId; open: number; occupied: Set<string> }) {
  const c = boxCorners(1.9)
  const out = []
  for (let w = 0; w < open; w++) {
    for (let i = 0; i < wardCapacity(w); i++) {
      if (occupied.has(`${w}:${i}`)) continue
      const p = isoW(plotWorld(id, w, i))
      out.push(
        <g key={`${w}-${i}`} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`} data-testid={`open-plot-${id}-${w}-${i}`}>
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
}: {
  wards: Record<DistrictId, number>
  capital: DistrictId | null
  radius: number
  detail: Detail
  occupied: Record<DistrictId, Set<string>>
}) {
  const city = isoEllipse(radius + 1.5)
  const water = isoEllipse(radius + WORLD.wardDepth + 14)
  return (
    <g className="ground">
      <ellipse rx={water.rx * 1.3} ry={water.ry * 1.3} fill="url(#city-halo)" />
      <ellipse rx={water.rx} ry={water.ry} fill="url(#water)" />
      <ellipse rx={city.rx} ry={city.ry} fill="#0a0d18" stroke="#2a3558" strokeWidth={2} opacity={0.6} />
      {DISTRICTS.map((d) => {
        const open = wards[d.id] ?? 1
        return (
          <g key={d.id}>
            {Array.from({ length: open }, (_, w) => {
              const band = wardBand(w)
              return (
                <polygon
                  key={w}
                  points={sectorPolygon(d.id, w === 0 ? WORLD.ringRoadOuter + 0.6 : band.inner + 0.9, band.outer)}
                  fill={`url(#ground-${d.id})`}
                  stroke={d.color}
                  strokeOpacity={capital === d.id ? 0.9 : 0.35}
                  strokeWidth={capital === d.id ? 3 : 1.5}
                  className="district-ground"
                  data-testid={w === 0 ? `district-${d.id}` : `ward-${d.id}-${w}`}
                />
              )
            })}
            {Array.from({ length: open }, (_, w) => (
              <polygon key={`blk-${w}`} points={sectorPolygon(d.id, w === 0 ? WORLD.civicSquare.outer + 2 : wardBand(w).inner + 1, wardBand(w).outer)} fill="url(#city-blocks)" />
            ))}
            {/* Civic square: a lawn park with paved promenade where monuments stand */}
            <polygon points={sectorPolygon(d.id, WORLD.civicSquare.inner, WORLD.civicSquare.outer, 2.6)} fill="#2b3040" stroke={d.color} strokeOpacity={0.35} />
            <polygon points={sectorPolygon(d.id, WORLD.civicSquare.inner + 1.4, WORLD.civicSquare.outer - 1.4, 4)} fill="#1b3a2b" fillOpacity={0.9} />
            <polyline points={arcPath(d.id, WORLD.civicSquare.center, 4)} fill="none" stroke="#3e4459" strokeWidth={12} />
            <polyline points={arcPath(d.id, WORLD.civicSquare.center, 4)} fill="none" stroke={d.color} strokeOpacity={0.25} strokeWidth={1} strokeDasharray="2 6" />
            <StreetTrees id={d.id} r={WORLD.civicSquare.inner + 1.9} count={8} span={30} />
            <StreetTrees id={d.id} r={WORLD.civicSquare.outer - 1.7} count={9} span={32} />
            <OpenPlots id={d.id} open={open} occupied={occupied[d.id]} />
            <StreetArc id={d.id} r={WORLD.civicSquare.outer + 1} />
            {Array.from({ length: open }, (_, w) => (
              <g key={`st-${w}`}>
                {w > 0 && <StreetArc id={d.id} r={wardBand(w).inner} width={12} />}
                <StreetArc id={d.id} r={wardStreetRadius(w)} width={10} />
                <StreetTrees id={d.id} r={wardStreetRadius(w) + 1.6} count={9 + w * 3} />
              </g>
            ))}
            <GhostWard id={d.id} ward={open} detail={detail} />
          </g>
        )
      })}
      {capital && <CapitalGround id={capital} />}
      {DISTRICTS.map((d) => {
        const a = districtAngle(d.id) + WORLD.districtSpanDeg / 2
        const outer = Math.max(wardBand((wards[d.id] ?? 1) - 1).outer, wardBand((wards[DISTRICTS[d.index % 9].id] ?? 1) - 1).outer)
        const s0 = isoW(polar(WORLD.ringRoadOuter, a))
        const s1 = isoW(polar(outer + 1, a))
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
          {DISTRICTS.flatMap((d) => {
            const open = wards[d.id] ?? 1
            return Array.from({ length: open }, (_, w) => <WardMarker key={`${d.id}-${w}`} id={d.id} ward={w} outermost={w === open - 1} />)
          })}
        </g>
      )}
      <PlazaGround capital={capital} />
    </g>
  )
})
