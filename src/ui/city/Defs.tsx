import { memo, type ReactElement } from 'react'
import { LIGHTING_COLORS } from '../../config/architecture'
import { DISTRICTS } from '../../config/districts'
import { prng } from '../../game/seed'
import { FLOOR_PX, WINDOW_TILES } from './geometry'


function WindowShape({ style, fill }: { style: string; fill: string }) {
  switch (style) {
    case 'ribbon':
      return <rect x={0} y={4} width={8} height={4.2} fill={fill} />
    case 'arched':
      return <path d="M2 10 V5.2 A2.5 2.5 0 0 1 7 5.2 V10 Z" fill={fill} />
    case 'lattice':
      return (
        <g fill={fill}>
          <rect x={1.2} y={2.5} width={2.6} height={3} />
          <rect x={4.6} y={2.5} width={2.6} height={3} />
          <rect x={1.2} y={6.4} width={2.6} height={3} />
          <rect x={4.6} y={6.4} width={2.6} height={3} />
        </g>
      )
    case 'panoramic':
      return <rect x={0.6} y={2.4} width={14.8} height={7.4} fill={fill} />
    default:
      return <rect x={1.6} y={3} width={4.2} height={6.4} rx={0.4} fill={fill} />
  }
}

/** Pseudo-random unlit windows so facades never look uniformly tiled. */
function DarkMask({ style }: { style: string }) {
  const w = WINDOW_TILES[style]
  const cols = 5
  const rows = 7
  const rand = prng(style.length * 977 + w)
  const cells: ReactElement[] = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (rand() < 0.38) cells.push(<rect key={`${r}-${c}`} x={c * w} y={r * FLOOR_PX + 1} width={w} height={FLOOR_PX - 2} fill="#0a0f1c" opacity={0.55 + rand() * 0.35} />)
  return (
    <pattern id={`mask-${style}`} width={w * cols} height={FLOOR_PX * rows} patternUnits="userSpaceOnUse">
      {cells}
    </pattern>
  )
}

export const CityDefs = memo(function CityDefs() {
  return (
    <defs>
      {Object.keys(WINDOW_TILES).flatMap((style) =>
        Object.entries(LIGHTING_COLORS).map(([light, c]) => (
          <pattern key={`${style}-${light}`} id={`win-${style}-${light}`} width={WINDOW_TILES[style]} height={FLOOR_PX} patternUnits="userSpaceOnUse">
            <WindowShape style={style} fill={c.window} />
          </pattern>
        )),
      )}
      {Object.keys(WINDOW_TILES).map((style) => (
        <DarkMask key={style} style={style} />
      ))}
      <linearGradient id="face-shade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity="0.08" />
        <stop offset="0.6" stopColor="#000" stopOpacity="0" />
        <stop offset="1" stopColor="#000" stopOpacity="0.35" />
      </linearGradient>
      <radialGradient id="glow-warm">
        <stop offset="0" stopColor="#ffd98a" stopOpacity="0.9" />
        <stop offset="1" stopColor="#ffd98a" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="glow-white">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
        <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="glow-gold">
        <stop offset="0" stopColor="#ffe38a" stopOpacity="1" />
        <stop offset="0.4" stopColor="#ffc933" stopOpacity="0.5" />
        <stop offset="1" stopColor="#ffc933" stopOpacity="0" />
      </radialGradient>
      <linearGradient id="beam-gold" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stopColor="#ffd45a" stopOpacity="0.6" />
        <stop offset="1" stopColor="#ffd45a" stopOpacity="0" />
      </linearGradient>
      <linearGradient id="beam-white" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0.45" />
        <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
      </linearGradient>
      <radialGradient id="plaza-floor" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stopColor="#3a3350" />
        <stop offset="0.7" stopColor="#221f33" />
        <stop offset="1" stopColor="#15141f" />
      </radialGradient>
      <radialGradient id="city-halo" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0.55" stopColor="#1b2446" stopOpacity="0.9" />
        <stop offset="0.8" stopColor="#0c1128" stopOpacity="0.6" />
        <stop offset="1" stopColor="#050810" stopOpacity="0" />
      </radialGradient>
      <pattern id="city-blocks" width={64} height={64} patternUnits="userSpaceOnUse" patternTransform="matrix(0.866 0.5 -0.866 0.5 0 0)">
        <rect x={0} y={0} width={64} height={64} fill="none" stroke="#ffffff" strokeOpacity={0.045} strokeWidth={1.2} />
        <rect x={6} y={6} width={22} height={22} fill="#ffffff" fillOpacity={0.018} />
        <rect x={36} y={36} width={22} height={22} fill="#ffffff" fillOpacity={0.018} />
      </pattern>
      <linearGradient id="water-sheen" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0.45" />
        <stop offset="0.45" stopColor="#ffffff" stopOpacity="0" />
        <stop offset="1" stopColor="#0b3a66" stopOpacity="0.35" />
      </linearGradient>
      <radialGradient id="water" cx="0.5" cy="0.45" r="0.5">
        <stop offset="0.7" stopColor="#0d1733" />
        <stop offset="1" stopColor="#060a18" />
      </radialGradient>
      {DISTRICTS.map((d) => (
        <g key={d.id}>
          <linearGradient id={`beam-${d.id}`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor={d.color} stopOpacity="0.55" />
            <stop offset="1" stopColor={d.color} stopOpacity="0" />
          </linearGradient>
          <radialGradient id={`glow-${d.id}`}>
            <stop offset="0" stopColor={d.glow} stopOpacity="0.85" />
            <stop offset="1" stopColor={d.color} stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`ground-${d.id}`} cx="0.5" cy="0.5" r="0.7">
            <stop offset="0" stopColor={d.ground} />
            <stop offset="1" stopColor="#101524" />
          </radialGradient>
        </g>
      ))}
    </defs>
  )
})
