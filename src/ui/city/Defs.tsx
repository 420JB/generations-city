import { memo, type ReactElement } from 'react'
import { LIGHTING_COLORS } from '../../config/architecture'
import { prng } from '../../game/seed'
import { FLOOR_PX, WINDOW_TILES } from './geometry'
import { useCityScene } from './scene'


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

/**
 * The surface of each Architect facade material (P1-E6), drawn over a brand building's exterior color so the material
 * still reads in any color: brick courses, split slate cladding, limestone ashlar, copper standing seams and glazed jade
 * tiles. Neutral light and shade only, never a color of its own; static, face-local (a face's own x and y). Only a
 * building with an exterior color refers to them (the legacy city never does).
 */
function MaterialSurfaces() {
  const light = (x: number, y: number, width: number, height: number, opacity: number) => <rect x={x} y={y} width={width} height={height} fill="#fff" fillOpacity={opacity} />
  const shade = (x: number, y: number, width: number, height: number, opacity: number) => <rect x={x} y={y} width={width} height={height} fill="#000" fillOpacity={opacity} />
  return (
    <>
      <pattern id="surface-brick" width={8} height={4} patternUnits="userSpaceOnUse">
        {shade(4.5, 0.5, 3.5, 1.5, 0.09)}
        {shade(0.5, 2.5, 3.5, 1.5, 0.05)}
        {light(0, 0, 8, 0.5, 0.15)}
        {light(0, 2, 8, 0.5, 0.15)}
        {light(0, 0.5, 0.5, 1.5, 0.13)}
        {light(4, 2.5, 0.5, 1.5, 0.13)}
      </pattern>
      <pattern id="surface-slate" width={12} height={6} patternUnits="userSpaceOnUse">
        {shade(0, 0, 12, 0.6, 0.24)}
        {light(0, 0.6, 12, 0.4, 0.07)}
        {shade(0, 3, 12, 0.6, 0.24)}
        {light(0, 3.6, 12, 0.4, 0.07)}
        {shade(0, 0, 0.5, 3, 0.16)}
        {shade(6, 3, 0.5, 3, 0.16)}
      </pattern>
      <pattern id="surface-limestone" width={16} height={12} patternUnits="userSpaceOnUse">
        {light(0, 0.5, 16, 2.5, 0.05)}
        {light(0, 6.5, 16, 2.5, 0.05)}
        {shade(0, 0, 16, 0.5, 0.15)}
        {shade(0, 6, 16, 0.5, 0.15)}
        {shade(0, 0, 0.5, 6, 0.13)}
        {shade(8, 6, 0.5, 6, 0.13)}
      </pattern>
      <pattern id="surface-copper" width={6} height={12} patternUnits="userSpaceOnUse">
        {light(0, 0, 0.7, 12, 0.22)}
        {shade(0.7, 0, 0.6, 12, 0.18)}
        {light(3.2, 0, 0.4, 12, 0.06)}
      </pattern>
      <pattern id="surface-jade" width={4} height={4} patternUnits="userSpaceOnUse">
        {shade(0, 0, 4, 0.4, 0.22)}
        {shade(0, 0, 0.4, 4, 0.22)}
        {light(0.9, 0.9, 1.2, 0.6, 0.2)}
      </pattern>
    </>
  )
}

export const CityDefs = memo(function CityDefs() {
  const scene = useCityScene()
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
      <MaterialSurfaces />
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
      {/* Open sea around the island: deepens away from the city, then dissolves into the night. */}
      <radialGradient id="perimeter-sea" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0.5" stopColor="#101c40" />
        <stop offset="0.68" stopColor="#0b1431" />
        <stop offset="0.86" stopColor="#070d22" stopOpacity="0.55" />
        <stop offset="1" stopColor="#050810" stopOpacity="0" />
      </radialGradient>
      {scene.districts.map((d) => (
        <g key={d.id}>
          <linearGradient id={`beam-${d.paint}`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor={d.color} stopOpacity="0.55" />
            <stop offset="1" stopColor={d.color} stopOpacity="0" />
          </linearGradient>
          <radialGradient id={`glow-${d.paint}`}>
            <stop offset="0" stopColor={d.glow} stopOpacity="0.85" />
            <stop offset="1" stopColor={d.color} stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`ground-${d.paint}`} cx="0.5" cy="0.5" r="0.7">
            <stop offset="0" stopColor={d.ground} />
            <stop offset="1" stopColor="#101524" />
          </radialGradient>
        </g>
      ))}
    </defs>
  )
})
