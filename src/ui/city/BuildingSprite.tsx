import { memo, type KeyboardEvent, type MouseEvent } from 'react'
import { FACADE_PALETTES, LIGHTING_COLORS } from '../../config/architecture'
import { getDistrict } from '../../config/districts'
import { MAX_VISIBLE_PATRONS } from '../../config/economy'
import { friendLabel } from '../../config/identity'
import { patronLevelIndex, rankedPatrons, stageFor, tierFor } from '../../game/economy'
import type { Building, DemoUser, LandscapeKind } from '../../game/types'
import { useTween } from '../motion'
import { facadeBillboardWidth, landscapeSlotPos, sectionsFor } from './buildingGeometry'
import { boxCorners, buildingHeightPx, FLOOR_PX, footprintHalf, hsl, iso, isoEllipse, leftFace, rightFace, S, TAN30, WINDOW_TILES, type Detail } from './geometry'
import { lotHalfWithin, propertyLotHalf } from './roads'
import { IsoBox } from './parts'

export type { Detail }

export interface BuildFx {
  seq: number
  amount: number
  tierUp: number | null
}

export function LandscapeItem({ kind, accent }: { kind: LandscapeKind; accent: string }) {
  switch (kind) {
    case 'tree':
      return (
        <g className="ls-tree">
          <rect x={-0.8} y={-8} width={1.6} height={8} fill="#4a3526" />
          <circle cx={0} cy={-12} r={6.5} fill="#1f6b4a" />
          <circle cx={-2} cy={-13.5} r={3.6} fill="#2f8a5f" />
          <circle cx={2.4} cy={-11} r={1} fill={accent} />
          <circle cx={-2.6} cy={-9.8} r={0.9} fill={accent} />
        </g>
      )
    case 'shrub':
      return (
        <g>
          <ellipse cx={-2.5} cy={-2} rx={3.4} ry={2.6} fill="#23704f" />
          <ellipse cx={2.2} cy={-2.2} rx={3} ry={2.4} fill="#2c8a60" />
        </g>
      )
    case 'planter':
      return (
        <g>
          <polygon points="-4,-4 4,-4 3,0 -3,0" fill="#8e8a82" />
          <circle cx={-1.8} cy={-5.5} r={1.7} fill="#ff7aa8" />
          <circle cx={1.6} cy={-5.8} r={1.6} fill="#ffd36b" />
          <circle cx={0} cy={-6.8} r={1.3} fill="#9be15d" />
        </g>
      )
    case 'bench':
      return (
        <g>
          <rect x={-5} y={-4} width={10} height={1.8} fill="#9a6b43" />
          <rect x={-5} y={-6.6} width={10} height={1.3} fill="#b07c4f" />
          <rect x={-4.4} y={-2.4} width={1} height={2.4} fill="#333" />
          <rect x={3.4} y={-2.4} width={1} height={2.4} fill="#333" />
        </g>
      )
    case 'lamp':
      return (
        <g>
          <circle cx={0} cy={-15} r={7} fill="url(#glow-warm)" opacity={0.7} />
          <rect x={-0.6} y={-15} width={1.2} height={15} fill="#555c6e" />
          <circle cx={0} cy={-15.5} r={1.8} fill="#ffe3a0" />
        </g>
      )
  }
}

function Crest({ kind, color }: { kind: string; color: string }) {
  const glyph =
    kind === 'star' ? (
      <path d="M0 -3.4 L1 -1 L3.4 -1 L1.5 0.6 L2.2 3 L0 1.6 L-2.2 3 L-1.5 0.6 L-3.4 -1 L-1 -1 Z" fill={color} />
    ) : kind === 'leaf' ? (
      <path d="M-2.6 2.6 C-2.6 -1.5 0 -3.2 2.8 -3 C2.8 0 1 2.6 -2.6 2.6 Z" fill={color} />
    ) : kind === 'wave' ? (
      <path d="M-3.2 0.8 Q-1.6 -2 0 0.8 T3.2 0.8" stroke={color} strokeWidth={1.2} fill="none" />
    ) : (
      <g fill={color}>
        <circle r={1.6} />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((d) => (
          <rect key={d} x={-0.35} y={-3.4} width={0.7} height={1.2} transform={`rotate(${d})`} />
        ))}
      </g>
    )
  return (
    <g>
      <circle r={5} fill="#141824" stroke={color} strokeWidth={0.9} />
      {glyph}
    </g>
  )
}

function Roof({ kind, a, trim, accent }: { kind: string; a: number; trim: string; accent: string }) {
  const k = a * S
  switch (kind) {
    case 'terrace':
      return (
        <g>
          <IsoBox a={a * 0.55} z0={0} z1={7} colors={{ left: '#2a3040', right: '#3a4256', top: '#465068' }} />
          <circle cx={-k * 0.6} cy={-2} r={2} fill="#2f8a5f" />
          <circle cx={k * 0.7} cy={-1} r={2.2} fill="#2f8a5f" />
          <circle cx={0} cy={k * 0.5} r={1.8} fill="#2f8a5f" />
        </g>
      )
    case 'dome':
      return (
        <g>
          <path d={`M${-k * 1.05} 0 A${k * 1.05} ${k * 1.0} 0 0 1 ${k * 1.05} 0 A${k * 1.05} ${k * 0.55} 0 0 1 ${-k * 1.05} 0 Z`} fill={trim} opacity={0.9} />
          <path d={`M${-k * 0.5} ${-k * 0.3} A${k * 0.7} ${k * 0.7} 0 0 1 ${k * 0.3} ${-k * 0.85}`} stroke="#fff" strokeOpacity={0.35} strokeWidth={1.2} fill="none" />
          <line x1={0} y1={-k * 1.0} x2={0} y2={-k * 1.0 - 10} stroke={trim} strokeWidth={1.2} />
          <circle cx={0} cy={-k * 1.0 - 11} r={1.6} fill={accent} />
        </g>
      )
    case 'spire':
      return (
        <g>
          <polygon points={`${-k * 0.45},0 0,${-k * 0.25} ${k * 0.45},0 0,${k * 0.25}`} fill={trim} />
          <polygon points={`${-k * 0.45},0 0,-46 0,${k * 0.25}`} fill={trim} opacity={0.75} />
          <polygon points={`0,${k * 0.25} 0,-46 ${k * 0.45},0`} fill={trim} />
          <circle cx={0} cy={-47} r={2} fill={accent} className="blink" />
        </g>
      )
    case 'crown-deck':
      return (
        <g>
          <IsoBox a={a * 0.72} z0={0} z1={6} colors={{ left: '#a8801e', right: '#d4a52c', top: '#f2cf63' }} />
          {[-0.9, -0.3, 0.3, 0.9].map((f) => (
            <polygon key={f} points={`${f * k - 3},${-6 + Math.abs(f) * k * 0.2} ${f * k},${-14 + Math.abs(f) * k * 0.2} ${f * k + 3},${-6 + Math.abs(f) * k * 0.2}`} fill="#ffd45a" />
          ))}
        </g>
      )
    case 'halo':
      return (
        <g>
          <line x1={0} y1={0} x2={0} y2={-18} stroke={trim} strokeWidth={1.4} />
          <ellipse cx={0} cy={-20} rx={k * 1.5} ry={k * 0.55} fill="none" stroke={accent} strokeWidth={4} opacity={0.25} />
          <ellipse cx={0} cy={-20} rx={k * 1.5} ry={k * 0.55} fill="none" stroke={accent} strokeWidth={1.6} className="halo-spin" />
        </g>
      )
    default:
      return (
        <polygon
          points={`${-2 * 0.866 * k},0 0,${-k} ${2 * 0.866 * k},0 0,${k}`}
          fill="none"
          stroke={trim}
          strokeWidth={1}
          opacity={0.6}
        />
      )
  }
}

function Rooftop({ kind, a, accent, friendId, detail }: { kind: string; a: number; accent: string; friendId: number; detail: Detail }) {
  const k = a * S
  const dx = k * 0.9
  switch (kind) {
    case 'antenna':
      return (
        <g transform={`translate(${dx} ${-k * 0.1})`}>
          <line x1={0} y1={0} x2={0} y2={-28} stroke="#9aa3b8" strokeWidth={1} />
          <line x1={-3} y1={-18} x2={3} y2={-18} stroke="#9aa3b8" strokeWidth={0.8} />
          <circle cx={0} cy={-29} r={1.7} fill="#ff4d5e" className="blink" />
        </g>
      )
    case 'garden':
      return (
        <g>
          {[[-0.8, 0], [0.4, -0.3], [0.9, 0.2], [-0.2, 0.4], [0.1, -0.1]].map(([x, y], i) => (
            <circle key={i} cx={x * k} cy={y * k} r={2.6} fill={i % 2 ? '#2f8a5f' : '#3fa56f'} />
          ))}
        </g>
      )
    case 'beacon':
      return (
        <g transform={`translate(${dx * 0.6} 0)`}>
          <rect x={-2} y={-9} width={4} height={9} fill="#3a4256" />
          <circle cx={0} cy={-11} r={10} fill={accent} opacity={0.3} className="pulse" />
          <circle cx={0} cy={-11} r={2.6} fill={accent} />
        </g>
      )
    case 'helipad':
      return (
        <g>
          <ellipse cx={0} cy={0} rx={k * 1.1} ry={k * 0.62} fill="#2a2f3d" stroke="#ffd45a" strokeWidth={1} />
          <text x={0} y={3} textAnchor="middle" fontSize={9} fill="#ffd45a" fontWeight={700} transform="scale(1 0.62)">
            H
          </text>
        </g>
      )
    case 'sign':
      return (
        <g transform={`translate(0 ${-4})`}>
          <line x1={-10} y1={0} x2={-10} y2={-6} stroke="#666" />
          <line x1={10} y1={0} x2={10} y2={-6} stroke="#666" />
          <rect x={-22} y={-19} width={44} height={13} rx={2} fill="#0d1120" stroke={accent} strokeWidth={1} />
          {detail !== 'far' && (
            <text x={0} y={-9.5} textAnchor="middle" fontSize={8} fontWeight={800} fill={accent} letterSpacing={0.5}>
              #{friendId}
            </text>
          )}
        </g>
      )
    default:
      return null
  }
}

function FaceWindows({ w, h, style, light, lobby, accent }: { w: number; h: number; style: string; light: string; lobby?: boolean; accent: string }) {
  if (w < 6 || h < 6) return null
  const tile = WINDOW_TILES[style] ?? 8
  const x0 = 3
  const ww = Math.max(0, Math.floor((w - 6) / tile) * tile)
  const off = (w - ww) / 2
  return (
    <g>
      <rect x={off} y={3} width={ww} height={h - (lobby ? 12 : 4)} fill={`url(#win-${style}-${light})`} opacity={0.9} />
      <rect x={off} y={3} width={ww} height={h - (lobby ? 12 : 4)} fill={`url(#mask-${style})`} />
      {lobby && <rect x={x0} y={h - 9} width={w - 6} height={7} fill={accent} opacity={0.35} />}
    </g>
  )
}

interface Props {
  building: Building
  total: number
  users: Record<string, DemoUser>
  selected: boolean
  isPlayer: boolean
  isCrown: boolean
  detail: Detail
  fx: BuildFx | null
  onSelect: (id: string) => void
  /** Screen-constant label scale (quantised by the camera). */
  labelScale: number
  /** Current guided objective (e.g. the Kingmaker target): always labelled. */
  isObjective: boolean
  /** Open the property-media viewer (billboards with an image are clickable). */
  onViewMedia?: (id: string) => void
  /**
   * Road-safe lot envelope of this plot while the city is rotated (capped at the property's
   * full lot, so it only changes for plots a turned road actually trims). Omitted at 0°.
   */
  roadSafe?: number
}

/**
 * Click/keyboard affordance for a billboard that has an image. Stops propagation so the
 * building underneath is not (de)selected; pointer-down is untouched so panning still works.
 */
function mediaHit(b: Building, onViewMedia?: (id: string) => void) {
  if (!onViewMedia || !b.billboard.image) return {}
  const open = (e: MouseEvent | KeyboardEvent) => {
    e.stopPropagation()
    onViewMedia(b.id)
  }
  return {
    className: 'billboard-hit',
    role: 'button',
    tabIndex: 0,
    'aria-label': `View property media on ${friendLabel(b.friendId)}`,
    onClick: open,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      open(e)
    },
  }
}

export const BuildingSprite = memo(function BuildingSprite({ building: b, total: target, users, selected, isPlayer, isCrown, detail, fx, onSelect, labelScale, isObjective, onViewMedia, roadSafe }: Props) {
  const total = useTween(target)
  const tier = tierFor(total)
  const stage = stageFor(total)
  const H = buildingHeightPx(total)
  const a0 = footprintHalf(tier)
  const pal = FACADE_PALETTES[b.architecture.facade] ?? FACADE_PALETTES.slate
  const light = LIGHTING_COLORS[b.architecture.lighting] ? b.architecture.lighting : 'warm'
  const accent = LIGHTING_COLORS[light].accent
  const district = getDistrict(b.districtId)
  const sections = sectionsFor(tier, H, a0)
  const topSec = sections[sections.length - 1]
  const shaft = sections.find((s) => s.kind === 'shaft') ?? sections[0]
  const podium = sections[0]
  const cPod = boxCorners(podium.a)
  // Paved lot trimmed to the plot's road-safe envelope (never paints over asphalt).
  const lot = roadSafe === undefined ? propertyLotHalf(b.districtId, b.ward, b.plot, tier) : lotHalfWithin(tier, roadSafe)
  const cl = boxCorners(lot)
  const patrons = rankedPatrons(b).slice(0, MAX_VISIBLE_PATRONS)
  // Dense city: at far/mid zoom only important buildings carry labels.
  const showLabel = detail === 'near' || selected || isPlayer || isCrown || isObjective
  // Small buildings only reveal their label on hover/focus, even up close.
  const minorLabel = !(selected || isPlayer || isCrown || isObjective) && tierFor(target) < 3
  const roofH = b.architecture.roof === 'spire' ? 48 : b.architecture.roof === 'halo' ? 26 : b.architecture.roof === 'dome' ? topSec.a * S + 12 : 12
  const topY = -topSec.z1 - roofH - (isCrown ? (detail === 'far' ? 92 : 64) : 0)
  const label = `${friendLabel(b.friendId)}, Tier ${tierFor(target)}, ${district.name}${isPlayer ? ', your building' : ''}`

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(b.id)
    }
  }

  return (
    <g
      className={`bldg${selected ? ' is-selected' : ''}${isPlayer ? ' is-player' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={label}
      data-testid={`building-${b.friendId}`}
      data-tier={tierFor(target)}
      data-total={target}
      data-facade={b.architecture.facade}
      data-roof={b.architecture.roof}
      data-lighting={b.architecture.lighting}
      data-selected={selected ? 'true' : 'false'}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(b.id)
      }}
      onKeyDown={onKey}
    >
      {/* Generous hit area: at the back, so interactive parts (billboards) stay clickable */}
      <rect x={cPod.W.x} y={topY - 20} width={cPod.E.x - cPod.W.x} height={cl.Sx.y - topY + 20} fill="transparent" />
      {/* Lot */}
      <polygon
        points={`${cl.W.x},${cl.W.y} ${cl.N.x},${cl.N.y} ${cl.E.x},${cl.E.y} ${cl.Sx.x},${cl.Sx.y}`}
        fill={tier === 0 ? '#3a2e25' : '#1a1f2c'}
        stroke={selected ? district.glow : tier === 0 ? '#a07a4a' : '#2d3446'}
        strokeWidth={selected ? 2 : 1}
        strokeDasharray={tier === 0 ? '4 3' : undefined}
      />
      {selected && (
        <ellipse cx={0} cy={0} rx={isoEllipse(lot * 1.1).rx} ry={isoEllipse(lot * 1.1).ry} fill="none" stroke={district.glow} strokeWidth={2.5} className="select-ring" />
      )}
      {(stage >= 9 || tier >= 4) && tier > 0 && <ellipse cx={0} cy={2} rx={cPod.E.x * 1.25} ry={cPod.Sx.y * 1.25} fill={`url(#glow-${b.districtId})`} opacity={0.35} />}

      {/* Structure */}
      {sections.map((sec, i) => {
        const c = boxCorners(sec.a)
        const h = sec.z1 - sec.z0
        const isPodium = sec.kind === 'podium'
        const windowsOn = tier > 0
        const trims = stage >= 3 && h > FLOOR_PX * 4
        return (
          <IsoBox
            key={i}
            a={sec.a}
            z0={sec.z0}
            z1={sec.z1}
            colors={{ left: pal.left, right: pal.right, top: pal.top, edge: stage >= 5 ? accent : pal.trim }}
            left={
              <>
                {windowsOn && <FaceWindows w={c.faceW} h={h} style={b.architecture.windows} light={light} lobby={isPodium} accent={accent} />}
                <rect x={0} y={0} width={c.faceW} height={h} fill="url(#face-shade)" />
                {trims &&
                  Array.from({ length: Math.floor(h / (FLOOR_PX * 4)) }, (_, j) => (
                    <rect key={j} x={0} y={(j + 1) * FLOOR_PX * 4 - 1} width={c.faceW} height={1.2} fill={pal.trim} opacity={0.45} />
                  ))}
                {windowsOn && !isPodium && (
                  <rect x={c.faceW * 0.3} y={FLOOR_PX + 3 + ((b.friendId * 7) % Math.max(1, h - 30))} width={4} height={6} fill={LIGHTING_COLORS[light].window} className="flicker" style={{ animationDelay: `${(b.friendId % 9) * 0.7}s` }} />
                )}
              </>
            }
            right={
              <>
                {windowsOn && <FaceWindows w={c.faceW} h={h} style={b.architecture.windows} light={light} lobby={isPodium} accent={accent} />}
                <rect x={0} y={0} width={c.faceW} height={h} fill="url(#face-shade)" opacity={0.6} />
                {trims &&
                  Array.from({ length: Math.floor(h / (FLOOR_PX * 4)) }, (_, j) => (
                    <rect key={j} x={0} y={(j + 1) * FLOOR_PX * 4 - 1} width={c.faceW} height={1.2} fill={pal.trim} opacity={0.45} />
                  ))}
              </>
            }
          />
        )
      })}

      {/* Construction site for Tier 0 */}
      {tier === 0 && (
        <g stroke="#d9a441" strokeWidth={1} fill="none" opacity={0.85}>
          <line x1={cPod.W.x} y1={cPod.W.y - podium.z1} x2={cPod.W.x} y2={cPod.W.y - podium.z1 - 18} />
          <line x1={0} y1={cPod.Sx.y - podium.z1} x2={0} y2={cPod.Sx.y - podium.z1 - 18} />
          <line x1={cPod.E.x} y1={-podium.z1} x2={cPod.E.x} y2={-podium.z1 - 18} />
          <polyline points={`${cPod.W.x},${cPod.W.y - podium.z1 - 18} 0,${cPod.Sx.y - podium.z1 - 18} ${cPod.E.x},${-podium.z1 - 18}`} />
        </g>
      )}

      {/* Entrance + owner crest on the podium */}
      {tier > 0 && (
        <g transform={leftFace(podium.a, podium.z1)}>
          <Entrance kind={b.architecture.entrance} w={cPod.faceW} h={podium.z1} accent={accent} trim={pal.trim} />
          {detail !== 'far' &&
            patrons
              .filter((p) => patronLevelIndex(p.amount) >= 1)
              .map((p, i) => (
                <rect key={p.userId} x={cPod.faceW / 2 + 9 + i * 5} y={podium.z1 - 8} width={3.6} height={4.4} fill="#d8b45a" stroke="#8a6a24" strokeWidth={0.4} data-patron-plaque={p.userId} />
              ))}
        </g>
      )}
      {tier > 0 && b.architecture.crest !== 'none' && b.fixtures.includes('crest') && (
        <g transform={rightFace(podium.a, podium.z1)}>
          <g transform={`translate(${cPod.faceW * 0.5} ${Math.max(6, podium.z1 * 0.35)})`}>
            <Crest kind={b.architecture.crest} color="#f2cf63" />
          </g>
        </g>
      )}

      {/* Patron zone: banners / crests on the shaft */}
      {detail !== 'far' && shaft.kind !== 'podium' && (
        <g transform={leftFace(shaft.a, shaft.z1)}>
          {patrons.map((p, i) => {
            const lvl = patronLevelIndex(p.amount)
            const u = users[p.userId]
            const color = hsl(u?.hue ?? 200, 70, 58)
            const fw = boxCorners(shaft.a).faceW
            const x = fw - 9 - i * 9
            if (lvl === 3 && x < 0) return null
            if (lvl >= 4)
              return (
                <g key={p.userId} transform={`translate(${fw * 0.5 - i * 12} 14)`} data-patron-crest={p.userId}>
                  <circle r={9} fill={color} opacity={0.25} className="pulse" />
                  <circle r={5.5} fill="#10131e" stroke={color} strokeWidth={1.4} />
                  <text y={2.4} textAnchor="middle" fontSize={6} fontWeight={800} fill={color}>
                    {(u?.handle ?? '?').slice(0, 1).toUpperCase()}
                  </text>
                </g>
              )
            if (lvl === 3)
              return (
                <g key={p.userId} data-patron-banner={p.userId}>
                  <rect x={x} y={4} width={6} height={Math.min(34, shaft.z1 - shaft.z0 - 8)} fill={color} opacity={0.9} />
                  <polygon points={`${x},${4 + Math.min(34, shaft.z1 - shaft.z0 - 8)} ${x + 3},${Math.min(34, shaft.z1 - shaft.z0 - 8)} ${x + 6},${4 + Math.min(34, shaft.z1 - shaft.z0 - 8)}`} fill="#0b0e18" />
                  {detail === 'near' && (
                    <text x={x + 3} y={13} textAnchor="middle" fontSize={4.6} fontWeight={800} fill="#0b0e18">
                      {(u?.handle ?? '?').slice(0, 1).toUpperCase()}
                    </text>
                  )}
                </g>
              )
            return null
          })}
        </g>
      )}

      {/* Property media ladder: T4 facade billboard; T5+ rooftop (see config/media.ts) */}
      {b.fixtures.includes('billboard') && shaft.kind !== 'podium' && tier < 5 && (
        <g transform={rightFace(shaft.a, shaft.z1)} data-testid={`billboard-${b.friendId}`} data-media="facade" data-detail={detail} {...mediaHit(b, onViewMedia)}>
          <Billboard w={boxCorners(shaft.a).faceW} id={b.id} image={b.billboard.image} accent={accent} detail={detail} />
        </g>
      )}

      {/* Roof + rooftop fixture */}
      <g transform={`translate(0 ${-topSec.z1})`}>
        {tier > 0 && <Roof kind={b.architecture.roof} a={topSec.a} trim={pal.trim} accent={accent} />}
        {tier > 0 && <Rooftop kind={b.architecture.rooftop} a={topSec.a} accent={accent} friendId={b.friendId} detail={detail} />}
      </g>

      {b.fixtures.includes('billboard') && tier >= 5 && (
        <g transform={`translate(0 ${-topSec.z1})`} data-testid={`billboard-${b.friendId}`} data-media={tier >= 6 ? 'landmark' : 'skyline'} data-detail={detail} {...mediaHit(b, onViewMedia)}>
          <RooftopBillboard id={b.id} image={b.billboard.image} accent={accent} landmark={tier >= 6} detail={detail} />
        </g>
      )}

      {/* Next section under construction (late stages) */}
      {tier > 0 && tier < 6 && stage >= 7 && <Scaffold a={topSec.a * 0.8} z={topSec.z1} stage={stage} />}

      {/* Landscaping */}
      {tier > 0 &&
        b.landscapeSlots.map((kind, i) => {
          if (!kind) return null
          const p = landscapeSlotPos(a0, i, lot)
          return (
            <g key={i} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) scale(0.72)`}>
              <LandscapeItem kind={kind} accent={accent} />
            </g>
          )
        })}

      {/* Friend markers for 500+ patrons */}
      {detail === 'near' &&
        patrons
          .filter((p) => patronLevelIndex(p.amount) === 2)
          .map((p, i) => {
            const u = users[p.userId]
            // Along the lot's front-right edge, inside the paving.
            const pos = iso(lot - 0.2, Math.max(-(lot - 0.2), lot - 0.6 - i * 1.1))
            return (
              <g key={p.userId} transform={`translate(${pos.x} ${pos.y})`} data-patron-marker={p.userId}>
                <line x1={0} y1={0} x2={0} y2={-14} stroke="#8a93a8" strokeWidth={0.8} />
                <circle cx={0} cy={-17} r={4} fill={hsl(u?.hue ?? 200)} stroke="#fff" strokeWidth={0.6} />
              </g>
            )
          })}

      {/* City Crown */}
      {isCrown && (
        <g transform={`translate(0 ${-topSec.z1 - roofH}) scale(${detail === 'far' ? 2 : 1.4})`} className="crown-spire" data-testid="crown-spire">
          <rect x={-3} y={-900} width={6} height={900} fill="url(#beam-gold)" opacity={0.55} />
          <circle cx={0} cy={-28} r={30} fill="url(#glow-gold)" opacity={0.8} className="pulse" />
          <line x1={0} y1={0} x2={0} y2={-18} stroke="#ffd45a" strokeWidth={2} />
          <path d="M-12 -20 L-12 -36 L-6 -28 L0 -40 L6 -28 L12 -36 L12 -20 Z" fill="#ffd45a" stroke="#fff6cc" strokeWidth={0.8} />
          <circle cx={0} cy={-42} r={2.2} fill="#fff" />
        </g>
      )}

      {/* Selection beam */}
      {selected && <rect x={-2} y={topY - 600} width={4} height={600} fill={`url(#beam-${b.districtId})`} opacity={0.8} />}

      {/* Label */}
      {showLabel && (
        <g id={`bl-${b.id}`} transform={`translate(0 ${topY - 12}) scale(${labelScale})`} className={`bldg-label${isPlayer ? ' is-player-label' : ''}${minorLabel ? ' minor' : ''}`}>
          <BuildingLabel text={`${isObjective && !isPlayer ? '★ ' : ''}#${b.friendId} · T${tierFor(target)}`} isPlayer={isPlayer} stroke={isObjective ? '#ffd45a' : isCrown ? '#ffd45a' : district.color} objective={isObjective} far={detail === 'far'} />
        </g>
      )}

      {/* Construction FX */}
      {fx && (
        <g key={fx.seq} className="fx" pointerEvents="none">
          {fx.tierUp !== null && (
            <g transform={`translate(0 ${-H * 0.5})`}>
              <circle r={20} fill="none" stroke={district.glow} strokeWidth={4} className="fx-ring" />
              <circle r={40} fill="url(#glow-white)" className="fx-flash" />
            </g>
          )}
          {Array.from({ length: 10 }, (_, i) => (
            <circle key={i} cx={((i * 37) % 60) - 30} cy={-H * ((i % 5) / 5)} r={1.8} fill={i % 2 ? '#ffd45a' : district.glow} className="fx-spark" style={{ animationDelay: `${i * 0.06}s` }} />
          ))}
          <text x={0} y={topY - 34} textAnchor="middle" className="fx-float" fontSize={fx.tierUp !== null ? 22 : 14} fontWeight={900} fill={fx.tierUp !== null ? '#ffe38a' : '#ffffff'} stroke="#0b0f1c" strokeWidth={3} paintOrder="stroke">
            {fx.tierUp !== null ? `TIER ${fx.tierUp}!` : `+${fx.amount} RF`}
          </text>
        </g>
      )}

    </g>
  )
})

/** Auto-sized label pill. The player's marker is a high-contrast light pill with a YOU tab. */
function BuildingLabel({ text, isPlayer, stroke, objective, far }: { text: string; isPlayer: boolean; stroke: string; objective?: boolean; far?: boolean }) {
  if (!isPlayer) {
    // Font size is an attribute (not a CSS rule) so <use> copies in the priority layer match.
    const fs = far ? 12 : 9.5
    const w = text.length * fs * 0.6 + 22
    return (
      <g data-testid={objective ? 'objective-marker' : undefined}>
        <rect x={-w / 2} y={-19} width={w} height={20} rx={10} fill={objective ? '#2a2106f0' : '#0b0f1ce0'} stroke={stroke} strokeWidth={objective ? 2 : 1.2} />
        <text x={0} y={-5} textAnchor="middle" fontSize={fs} fontWeight={700} fill={objective ? '#ffe7a6' : '#f3f5fb'}>
          {text}
        </text>
      </g>
    )
  }
  const tabW = 40
  const w = text.length * 6.4 + tabW + 26
  const x0 = -w / 2
  return (
    <g data-testid="player-marker">
      <rect x={x0 - 4} y={-31} width={w + 8} height={34} rx={17} fill="#5ff3d6" opacity={0.28} />
      <rect x={x0} y={-27} width={w} height={26} rx={13} fill="#ffffff" stroke="#5ff3d6" strokeWidth={2} />
      <rect x={x0 + 3} y={-24} width={tabW} height={20} rx={10} fill="#0b0f1c" />
      <text x={x0 + 3 + tabW / 2} y={-10} textAnchor="middle" fontSize={10} fontWeight={900} fill="#5ff3d6" letterSpacing={1}>
        YOU
      </text>
      <text x={x0 + tabW + 3 + (w - tabW - 3) / 2} y={-9.5} textAnchor="middle" fontSize={11} fontWeight={800} fill="#0b0f1c">
        {text}
      </text>
      <path d="M-6 -1 L0 7 L6 -1 Z" fill="#ffffff" stroke="#5ff3d6" strokeWidth={1.5} strokeLinejoin="round" />
      <rect x={-5} y={-2.4} width={10} height={2.4} fill="#ffffff" />
    </g>
  )
}

/** Level-of-detail stand-in: plain massing for dense wards at far zoom. */
export const MassingSprite = memo(function MassingSprite({ building: b, total, onSelect, onViewMedia }: { building: Building; total: number; onSelect: (id: string) => void; onViewMedia?: (id: string) => void }) {
  const tier = tierFor(total)
  const d = getDistrict(b.districtId)
  const hasMedia = b.fixtures.includes('billboard') && tier >= 4
  const H = buildingHeightPx(total)
  const accent = LIGHTING_COLORS[b.architecture.lighting]?.accent ?? LIGHTING_COLORS.warm.accent
  return (
    <g
      className="bldg massing"
      data-testid={`massing-${b.friendId}`}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(b.id)
      }}
    >
      <IsoBox
        a={footprintHalf(tier)}
        z0={0}
        z1={buildingHeightPx(total)}
        colors={{ left: '#1b2031', right: '#262d45', top: '#3a4158', edge: d.color }}
        left={<rect x={2} y={3} width={boxCorners(footprintHalf(tier)).faceW - 4} height={Math.max(0, buildingHeightPx(total) - 6)} fill="url(#win-grid-warm)" opacity={0.55} />}
        right={<rect x={2} y={3} width={boxCorners(footprintHalf(tier)).faceW - 4} height={Math.max(0, buildingHeightPx(total) - 6)} fill="url(#win-grid-warm)" opacity={0.4} />}
      />
      {/* Property media stays visible on massing stand-ins too (lightweight far treatment). */}
      {hasMedia &&
        (tier < 5 ? (
          <g transform={rightFace(footprintHalf(tier), H * 0.7)} data-testid={`billboard-${b.friendId}`} data-media="facade" data-detail="far" {...mediaHit(b, onViewMedia)}>
            <Billboard w={boxCorners(footprintHalf(tier)).faceW} id={`${b.id}-m`} image={b.billboard.image} accent={accent} detail="far" />
          </g>
        ) : (
          <g transform={`translate(0 ${-H})`} data-testid={`billboard-${b.friendId}`} data-media={tier >= 6 ? 'landmark' : 'skyline'} data-detail="far" {...mediaHit(b, onViewMedia)}>
            <RooftopBillboard id={`${b.id}-m`} image={b.billboard.image} accent={accent} landmark={tier >= 6} detail="far" />
          </g>
        ))}
    </g>
  )
})

function Entrance({ kind, w, h, accent, trim }: { kind: string; w: number; h: number; accent: string; trim: string }) {
  const cx = w / 2
  switch (kind) {
    case 'awning':
      return (
        <g>
          <rect x={cx - 4} y={h - 11} width={8} height={11} fill={accent} opacity={0.85} />
          <polygon points={`${cx - 8},${h - 13} ${cx + 8},${h - 13} ${cx + 6},${h - 9} ${cx - 6},${h - 9}`} fill={trim} />
        </g>
      )
    case 'arch':
      return (
        <g>
          <path d={`M${cx - 5} ${h} V${h - 9} A5 5 0 0 1 ${cx + 5} ${h - 9} V${h} Z`} fill={accent} opacity={0.9} />
          <path d={`M${cx - 6.5} ${h} V${h - 9} A6.5 6.5 0 0 1 ${cx + 6.5} ${h - 9} V${h}`} fill="none" stroke={trim} strokeWidth={1.2} />
        </g>
      )
    case 'portico':
      return (
        <g>
          <rect x={cx - 5} y={h - 12} width={10} height={12} fill={accent} opacity={0.8} />
          {[-11, -6, 6, 11].map((d) => (
            <rect key={d} x={cx + d - 1} y={h - 14} width={2} height={14} fill={trim} />
          ))}
          <polygon points={`${cx - 14},${h - 14} ${cx},${h - 21} ${cx + 14},${h - 14}`} fill={trim} />
        </g>
      )
    default:
      return <rect x={cx - 3.5} y={h - 10} width={7} height={10} fill={accent} opacity={0.8} />
  }
}

/**
 * T4 facade billboard: a lit 2:1 panel on the shaft's right face. Width follows the facade
 * (a slim shaft gets a slimmer panel, never less than a useful surface), with a steel
 * catwalk ledge, two brackets into the facade and gooseneck lamps above. The 2:1 image
 * crop is unchanged, so framing/edit behaviour is identical.
 */
function Billboard({ w, id, image, accent, detail }: { w: number; id: string; image: string | null; accent: string; detail: Detail }) {
  const bw = facadeBillboardWidth(w)
  const bh = bw * 0.5
  const x = (w - bw) / 2
  const y = 9
  const clip = `bb-clip-${id}`
  const brackets = [Math.max(1.5, w * 0.22), Math.min(w - 1.5, w * 0.78)]
  // far: framed panel only · mid: + catwalk ledge · near: + brackets, lamp arms, caption
  const near = detail === 'near'
  return (
    <g>
      {near &&
        brackets.map((bx) => (
          <g key={bx} stroke="#7d8598" strokeWidth={0.9}>
            <line x1={bx} y1={y + bh + 2} x2={bx} y2={y + bh + 6} />
            <line x1={bx} y1={y - 2} x2={bx} y2={y - 5.5} />
            <line x1={bx} y1={y - 5.5} x2={bx + 1.5} y2={y - 5.5} />
          </g>
        ))}
      <rect x={x - 2} y={y - 2} width={bw + 4} height={bh + 4} fill="#0a0d16" stroke={accent} strokeWidth={detail === 'far' ? 1.4 : 0.9} />
      <clipPath id={clip}>
        <rect x={x} y={y} width={bw} height={bh} />
      </clipPath>
      {image ? (
        <image href={image} x={x} y={y} width={bw} height={bh} preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clip})`} data-billboard-image="true" />
      ) : (
        <g>
          {/* No image yet: a lit accent panel (never a black hole at overview zoom). */}
          <rect x={x} y={y} width={bw} height={bh} fill={accent} opacity={detail === 'far' ? 0.55 : 0.18} />
          {detail !== 'far' && (
            <text x={x + bw / 2} y={y + bh / 2 + 2.2} textAnchor="middle" fontSize={bw < 34 ? 5 : 6} fontWeight={800} fill={accent} letterSpacing={0.8}>
              BILLBOARD
            </text>
          )}
        </g>
      )}
      {near && <rect x={x} y={y} width={bw} height={bh} fill="url(#face-shade)" opacity={0.4} />}
      {detail !== 'far' && <rect x={x - 2.5} y={y + bh + 2} width={bw + 5} height={1.4} fill="#5d6477" />}
      {near &&
        brackets.map((bx) => (
          <circle key={bx} cx={bx + 1.5} cy={y - 5} r={0.9} fill="#fff4cf" />
        ))}
    </g>
  )
}

/** T5 skyline rooftop billboard / T6 landmark crown screen standing on the roof. */
function RooftopBillboard({ id, image, accent, landmark, detail }: { id: string; image: string | null; accent: string; landmark: boolean; detail: Detail }) {
  const W = landmark ? 92 : 68
  const H = W / 2
  const legs = landmark ? 14 : 10
  const clip = `rb-clip-${id}`
  const frame = landmark ? '#ffd45a' : accent
  return (
    <g>
      {landmark && <ellipse cx={0} cy={-legs - H / 2} rx={W * 0.75} ry={H * 0.9} fill="url(#glow-gold)" opacity={0.35} />}
      <line x1={-W * 0.22} y1={0} x2={-W * 0.22} y2={-legs - 4} stroke="#8a93a8" strokeWidth={1.4} />
      <line x1={W * 0.22} y1={0} x2={W * 0.22} y2={-legs - 4} stroke="#8a93a8" strokeWidth={1.4} />
      <g transform={`matrix(1 ${TAN30} 0 1 ${-W / 2} ${(-W / 2) * TAN30 - H - legs})`}>
        <rect x={-3} y={-3} width={W + 6} height={H + 6} fill="#0a0d16" stroke={frame} strokeWidth={landmark ? 2.4 : 1.4} />
        <clipPath id={clip}>
          <rect x={0} y={0} width={W} height={H} />
        </clipPath>
        {image ? (
          <image href={image} x={0} y={0} width={W} height={H} preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clip})`} data-billboard-image="true" />
        ) : (
          <g>
            <rect x={0} y={0} width={W} height={H} fill={frame} opacity={detail === 'far' ? 0.5 : 0.18} />
            {detail !== 'far' && (
              <text x={W / 2} y={H / 2 + 3} textAnchor="middle" fontSize={8} fontWeight={800} fill={frame} letterSpacing={1}>
                {landmark ? 'LANDMARK SCREEN' : 'SKYLINE BILLBOARD'}
              </text>
            )}
          </g>
        )}
        {detail === 'near' &&
          [0.2, 0.5, 0.8].map((f) => (
            <circle key={f} cx={W * f} cy={-3} r={1.4} fill="#fff6cc" />
          ))}
      </g>
    </g>
  )
}

function Scaffold({ a, z, stage }: { a: number; z: number; stage: number }) {
  const c = boxCorners(a)
  const h = (stage - 6) * 6
  const t = z + h
  return (
    <g stroke="#d9a441" strokeWidth={0.9} fill="none" opacity={0.85} className="scaffold">
      <line x1={c.W.x} y1={c.W.y - z} x2={c.W.x} y2={c.W.y - t} />
      <line x1={0} y1={c.Sx.y - z} x2={0} y2={c.Sx.y - t} />
      <line x1={c.E.x} y1={-z} x2={c.E.x} y2={-t} />
      <polyline points={`${c.W.x},${c.W.y - t} 0,${c.Sx.y - t} ${c.E.x},${-t} 0,${c.N.y - t} ${c.W.x},${c.W.y - t}`} />
      <line x1={c.W.x} y1={c.W.y - z} x2={0} y2={c.Sx.y - t} strokeOpacity={0.5} />
      {stage >= 8 && (
        <g>
          <line x1={0} y1={c.N.y - t} x2={0} y2={c.N.y - t - 34} strokeWidth={1.4} />
          <line x1={-14} y1={c.N.y - t - 32} x2={30} y2={c.N.y - t - 32} strokeWidth={1.4} />
          <line x1={24} y1={c.N.y - t - 32} x2={24} y2={c.N.y - t - 18} strokeWidth={0.6} />
          <circle cx={0} cy={c.N.y - t - 36} r={1.6} fill="#ff4d5e" stroke="none" className="blink" />
        </g>
      )}
    </g>
  )
}
