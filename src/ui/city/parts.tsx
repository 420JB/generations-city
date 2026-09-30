import type { ReactNode } from 'react'
import { boxCorners, leftFace, rightFace } from './geometry'

export interface BoxColors {
  left: string
  right: string
  top: string
  edge?: string
}

/** Axis-aligned iso prism centred on the local origin, from z0 up to z1 (px). */
export function IsoBox({
  a,
  ay,
  z0,
  z1,
  colors,
  left,
  right,
  top,
  className,
}: {
  a: number
  /** Optional half-size along world y for rectangular boxes (defaults to `a`). */
  ay?: number
  z0: number
  z1: number
  colors: BoxColors
  left?: ReactNode
  right?: ReactNode
  top?: ReactNode
  className?: string
}) {
  const c = boxCorners(a, ay ?? a)
  const pt = (p: { x: number; y: number }, z: number) => `${p.x.toFixed(1)},${(p.y - z).toFixed(1)}`
  return (
    <g className={className}>
      <polygon points={`${pt(c.W, z0)} ${pt(c.Sx, z0)} ${pt(c.Sx, z1)} ${pt(c.W, z1)}`} fill={colors.left} />
      <polygon points={`${pt(c.Sx, z0)} ${pt(c.E, z0)} ${pt(c.E, z1)} ${pt(c.Sx, z1)}`} fill={colors.right} />
      {left && <g transform={leftFace(a, z1, ay ?? a)}>{left}</g>}
      {right && <g transform={rightFace(a, z1, ay ?? a)}>{right}</g>}
      <polygon points={`${pt(c.N, z1)} ${pt(c.E, z1)} ${pt(c.Sx, z1)} ${pt(c.W, z1)}`} fill={colors.top} />
      {colors.edge && (
        <line x1={c.Sx.x} y1={c.Sx.y - z0} x2={c.Sx.x} y2={c.Sx.y - z1} stroke={colors.edge} strokeWidth={0.8} opacity={0.7} />
      )}
      {top && <g transform={`translate(0 ${-z1})`}>{top}</g>}
    </g>
  )
}
