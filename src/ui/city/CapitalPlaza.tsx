import { memo } from 'react'
import { getDistrict, type DistrictId } from '../../config/districts'
import { friendLabel } from '../../config/identity'
import { MONUMENTS, type MonumentId } from '../../config/monuments'
import { iso, isoEllipse, leftFace, PLAZA_R, polar, RING_OUTER, rightFace } from './geometry'
import { IsoBox } from './parts'

/** Ground-level plaza, ring road and traffic. Rendered beneath all objects. */
export const PlazaGround = memo(function PlazaGround({ capital }: { capital: DistrictId | null }) {
  const plaza = isoEllipse(PLAZA_R)
  const ring = isoEllipse(RING_OUTER)
  const mid = isoEllipse((PLAZA_R + RING_OUTER) / 2)
  const d = capital ? getDistrict(capital) : null
  return (
    <g className="plaza-ground">
      <ellipse rx={ring.rx} ry={ring.ry} fill="#0f1220" stroke="#252b40" strokeWidth={2} />
      <ellipse rx={mid.rx} ry={mid.ry} fill="none" stroke="#f5d78a" strokeOpacity={0.35} strokeWidth={1.4} strokeDasharray="10 12" />
      <ellipse rx={mid.rx} ry={mid.ry} fill="none" stroke="#ffe7a8" strokeWidth={2.4} strokeDasharray="2 58" />
      <ellipse rx={mid.rx * 0.97} ry={mid.ry * 0.97} fill="none" stroke="#ff6b6b" strokeWidth={2.4} strokeDasharray="2 71" />
      <ellipse rx={plaza.rx} ry={plaza.ry} fill="url(#plaza-floor)" stroke={d?.color ?? '#6d6a80'} strokeWidth={3} strokeOpacity={0.9} className="plaza-rim" />
      {[0.82, 0.62, 0.42].map((f) => (
        <ellipse key={f} rx={plaza.rx * f} ry={plaza.ry * f} fill="none" stroke="#ffffff" strokeOpacity={0.06} strokeWidth={1} />
      ))}
      {Array.from({ length: 16 }, (_, i) => {
        const w = polar(PLAZA_R, i * 22.5)
        const w2 = polar(PLAZA_R * 0.42, i * 22.5)
        const p = iso(w.x, w.y)
        const p2 = iso(w2.x, w2.y)
        return <line key={i} x1={p2.x} y1={p2.y} x2={p.x} y2={p.y} stroke="#ffffff" strokeOpacity={0.05} />
      })}
      {d && <ellipse rx={plaza.rx * 0.98} ry={plaza.ry * 0.98} fill="none" stroke={d.glow} strokeWidth={6} strokeOpacity={0.18} />}
    </g>
  )
})

/** City Hall with Capital flag, holographic Capital sign and fountain. Depth ~0. */
export const CityHall = memo(function CityHall({ capital }: { capital: DistrictId | null }) {
  const d = capital ? getDistrict(capital) : null
  const color = d?.color ?? '#999'
  const glow = d?.glow ?? '#ccc'
  const stone = { left: '#bdb6a6', right: '#d9d2c1', top: '#ece6d8', edge: '#fff' }
  const base = { left: '#8f887a', right: '#a9a192', top: '#c4bcac' }
  return (
    <g className="city-hall" data-testid="city-hall" data-capital={capital ?? ''} data-family={d?.familyKey ?? ''} role="img" aria-label={`City Hall. Capital: ${d ? `the ${d.title}` : 'none'}`}>
      <ellipse cx={0} cy={4} rx={150} ry={80} fill={`url(#glow-${capital ?? 'd9'})`} opacity={0.25} />
      <IsoBox a={5.2} z0={0} z1={8} colors={base} />
      <IsoBox a={4.6} z0={8} z1={14} colors={base} />
      <IsoBox
        a={4}
        z0={14}
        z1={58}
        colors={stone}
        left={
          <g>
            {Array.from({ length: 9 }, (_, i) => (
              <rect key={i} x={6 + i * 12} y={4} width={4} height={40} fill="#f7f2e6" />
            ))}
            {Array.from({ length: 8 }, (_, i) => (
              <rect key={i} x={11.5 + i * 12} y={10} width={5} height={26} fill="#ffcf7a" opacity={0.75} />
            ))}
          </g>
        }
        right={
          <g>
            {Array.from({ length: 9 }, (_, i) => (
              <rect key={i} x={6 + i * 12} y={4} width={4} height={40} fill="#f7f2e6" />
            ))}
            {Array.from({ length: 8 }, (_, i) => (
              <rect key={i} x={11.5 + i * 12} y={10} width={5} height={26} fill="#ffcf7a" opacity={0.65} />
            ))}
          </g>
        }
      />
      {/* Capital banners hang on the facade, bearing the family's SECONDARY silhouette */}
      {[leftFace(4, 58), rightFace(4, 58)].map((t) => (
        <g key={t} transform={t}>
          {[18, 78].map((x) => (
            <g key={x} className="hall-banner">
              <path d={`M${x} 1 h14 v33 l-7 -5 l-7 5 Z`} fill={color} />
              <rect x={x} y={1} width={14} height={2.2} fill="#ffd45a" />
              {d && <image href={d.art.secondaryTransparent} x={x + 1.5} y={8} width={11} height={11} opacity={0.95} />}
            </g>
          ))}
        </g>
      ))}
      <IsoBox a={4.3} z0={58} z1={64} colors={base} />
      {/* Dome */}
      <g transform="translate(0 -64)">
        <IsoBox a={2.2} z0={0} z1={16} colors={stone} />
        <path d="M-52 -16 A52 50 0 0 1 52 -16 A52 20 0 0 1 -52 -16 Z" fill="#cfc7b4" />
        <path d="M-52 -16 A52 50 0 0 1 52 -16" fill="none" stroke={glow} strokeWidth={2} opacity={0.8} />
        <path d="M-30 -40 A40 40 0 0 1 10 -62" stroke="#fff" strokeOpacity={0.5} strokeWidth={2} fill="none" />
        <rect x={-4} y={-80} width={8} height={16} fill="#e8e1cf" />
        {/* Flag */}
        <line x1={0} y1={-80} x2={0} y2={-150} stroke="#e6e6e6" strokeWidth={2} />
        <g className="flag" data-testid="capital-flag" style={{ transformOrigin: '0px -146px' }}>
          <path d="M0 -148 C 20 -154, 34 -140, 58 -146 L58 -118 C 34 -112, 20 -126, 0 -120 Z" fill={color} />
          <path d="M0 -148 C 20 -154, 34 -140, 58 -146 L58 -144 C 34 -138, 20 -152, 0 -146 Z" fill="#ffd45a" />
          {d ? <CrestDisc href={d.art.primaryTransparent} color={color} cx={28} cy={-133} r={10} /> : null}
        </g>
      </g>
    </g>
  )
})

/** Floating holographic Capital sign; rendered above all city objects. */
export const CapitalSign = memo(function CapitalSign({
  capital,
  featuredFriend,
  detail,
}: {
  capital: DistrictId | null
  featuredFriend: number | null
  detail: 'far' | 'mid' | 'near'
}) {
  const d = capital ? getDistrict(capital) : null
  const color = d?.color ?? '#999'
  const glow = d?.glow ?? '#ccc'
  return (
    <g transform="translate(0 -266)" pointerEvents="none">
      <g className="capital-sign">
        <rect x={-204} y={-34} width={408} height={66} rx={12} fill="#0b0f1cdd" stroke="#ffd45a" strokeWidth={2} />
        <rect x={-201} y={-31} width={402} height={60} rx={10} fill={color} opacity={0.1} stroke={color} strokeOpacity={0.6} />
        <text x={0} y={-13} textAnchor="middle" fontSize={10.5} letterSpacing={3.5} fill="#ffe7a6" fontWeight={700}>
          THE CAPITAL OF RARE CITY
        </text>
        {d && [-1, 1].map((s) => <CrestDisc key={s} href={d.art.primaryTransparent} color={color} cx={s * 176} cy={-1} r={21} />)}
        <text x={0} y={14} textAnchor="middle" fontSize={d && d.title.length > 16 ? 21 : 24} fontWeight={900} fill="#fff" letterSpacing={2} data-testid="capital-sign-name" data-family={d?.familyKey ?? ''}>
          {d?.title.toUpperCase() ?? 'UNCLAIMED'}
        </text>
        {featuredFriend && detail !== 'far' && (
          <text x={0} y={26} textAnchor="middle" fontSize={7.5} fill={glow} letterSpacing={1}>
            FEATURED BUILDER · {friendLabel(featuredFriend).toUpperCase()}
          </text>
        )}
      </g>
    </g>
  )
})

/** Family crest roundel for SVG signage: primary silhouette on a dark disc, ringed in colour. */
export function CrestDisc({ href, color, cx, cy, r }: { href: string; color: string; cx: number; cy: number; r: number }) {
  return (
    <g className="crest-disc" aria-hidden="true">
      <circle cx={cx} cy={cy} r={r} fill="#0b0f1c" stroke={color} strokeWidth={Math.max(1.2, r * 0.12)} />
      <circle cx={cx} cy={cy} r={r * 0.86} fill="none" stroke="#ffd45a" strokeOpacity={0.55} strokeWidth={0.6} />
      <image href={href} x={cx - r * 0.72} y={cy - r * 0.72} width={r * 1.44} height={r * 1.44} />
    </g>
  )
}

/** Monument registry pylons ringing the plaza, coloured by the current holder. */
export function RegistryPylon({ monumentId, holder }: { monumentId: MonumentId; holder: DistrictId | null }) {
  const d = holder ? getDistrict(holder) : null
  const m = MONUMENTS.find((x) => x.id === monumentId)!
  return (
    <g data-testid={`pylon-${monumentId}`} data-holder={holder ?? ''}>
      <IsoBox a={0.9} z0={0} z1={6} colors={{ left: '#2b2f3f', right: '#3b4156', top: '#4d556e' }} />
      <IsoBox a={0.5} z0={6} z1={46} colors={{ left: d ? d.color : '#444', right: d ? d.glow : '#666', top: '#fff' }} />
      <circle cx={0} cy={-52} r={12} fill={d ? `url(#glow-${d.id})` : 'none'} opacity={0.8} />
      <text x={0} y={-56} textAnchor="middle" fontSize={9} fontWeight={900} fill="#fff" stroke="#0b0f1c" strokeWidth={2.5} paintOrder="stroke">
        T{m.tier}
      </text>
    </g>
  )
}

export function Fountain() {
  return (
    <g>
      <ellipse rx={34} ry={19} fill="#1a3350" stroke="#7fb8ff" strokeOpacity={0.5} />
      <ellipse rx={24} ry={13} fill="none" stroke="#bfe3ff" strokeOpacity={0.4} className="ripple" />
      <rect x={-2} y={-16} width={4} height={16} fill="#9fd0ff" opacity={0.7} />
      <circle cx={0} cy={-18} r={6} fill="url(#glow-white)" opacity={0.6} />
    </g>
  )
}
