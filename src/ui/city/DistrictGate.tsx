import { memo } from 'react'
import { getDistrict, type DistrictId } from '../../config/districts'
import { districtAngle, polar } from '../../game/world'
import { CrestDisc } from './CapitalPlaza'
import { iso, type Detail } from './geometry'
import { IsoBox } from './parts'

/** Half-span between the two pylons (world units); clears the Capital causeway. */
const GATE_HALF = 2.9
const H = 38

/**
 * District gateway: two pale-stone pylons with a lintel carrying the family's PRIMARY
 * crest and a name plaque. Wayfinding at mid/near zoom; decorative for screen readers
 * (the district label and panels already name the district).
 */
export const DistrictGate = memo(function DistrictGate({ id, detail, isCapital }: { id: DistrictId; detail: Detail; isCapital: boolean }) {
  const d = getDistrict(id)
  const perp = polar(GATE_HALF, districtAngle(id) + 90)
  const pylons = [iso(-perp.x, -perp.y), iso(perp.x, perp.y)].sort((a, b) => a.y - b.y)
  const trim = isCapital ? '#ffd45a' : d.color
  const plaqueW = Math.max(52, d.title.length * 4.7 + 14)
  return (
    <g className="district-gate" data-testid={`district-gate-${id}`} data-family={d.familyKey} aria-hidden="true" pointerEvents="none">
      <line x1={pylons[0].x} y1={pylons[0].y - H - 1} x2={pylons[1].x} y2={pylons[1].y - H - 1} stroke="#e6dcc2" strokeWidth={3.2} strokeLinecap="round" />
      <line x1={pylons[0].x} y1={pylons[0].y - H - 1} x2={pylons[1].x} y2={pylons[1].y - H - 1} stroke={trim} strokeWidth={0.9} strokeOpacity={0.9} />
      {pylons.map((p, i) => (
        <g key={i} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}>
          <ellipse cx={0} cy={1} rx={10} ry={5} fill="url(#glow-warm)" opacity={0.35} />
          <IsoBox a={0.52} z0={0} z1={5} colors={{ left: '#3a3f52', right: '#4b5269', top: '#5d6581' }} />
          <IsoBox
            a={0.34}
            z0={5}
            z1={H}
            colors={{ left: '#b9b09c', right: '#d8cfba', top: '#ebe3d0' }}
            left={<rect x={0} y={4} width={9.4} height={2.2} fill={trim} />}
            right={<rect x={0} y={4} width={9.4} height={2.2} fill={trim} opacity={0.8} />}
          />
          <IsoBox a={0.44} z0={H} z1={H + 3} colors={{ left: '#cbbf9f', right: '#e6dcc2', top: '#f4ecd8' }} />
          <circle cx={0} cy={-H - 6} r={1.8} fill="#ffd45a" />
        </g>
      ))}
      <CrestDisc href={d.art.primaryTransparent} color={d.color} cx={0} cy={-H - 14} r={11} />
      {/* Name plaque only up close; at mid zoom the crest alone keeps monument labels clear. */}
      {detail === 'near' && (
        <g transform={`translate(0 ${-H + 9})`}>
          <rect x={-plaqueW / 2} y={-6} width={plaqueW} height={12} rx={3} fill="#0b0f1cee" stroke={trim} strokeWidth={0.9} />
          <text x={0} y={2.2} textAnchor="middle" fontSize={6} fontWeight={800} fill="#f3f5fb" letterSpacing={1.2}>
            {d.title.toUpperCase()}
          </text>
        </g>
      )}
    </g>
  )
})
