import { memo, useId } from 'react'
import { getDistrict, type DistrictId } from '../../config/districts'
import { getMonument, type MonumentId } from '../../config/monuments'
import { boxCorners, COS30, iso, S, type Detail } from './geometry'
import { statueForm } from './familyStatue'
import { MONUMENT_PAD_A, MONUMENT_SPRITE_SCALE } from '../../game/world'
import { IsoBox } from './parts'

export type MonumentPhase = 'standing' | 'rising' | 'falling'

const STONE = { left: '#8f877a', right: '#b3aa98', top: '#cfc6b2' }
const STONE_DARK = { left: '#3a3f52', right: '#4b5269', top: '#5d6581' }
const GOLD = '#ffd45a'

/** Stepped civic pad every monument stands on: paving, lamps, district banners. */
function MonumentPad({ color, glow }: { color: string; glow: string }) {
  const lamps = [iso(-2.6, -2.6), iso(2.6, -2.6), iso(2.6, 2.6), iso(-2.6, 2.6)]
  return (
    <g className="monument-pad">
      <IsoBox a={MONUMENT_PAD_A} z0={0} z1={4} colors={STONE_DARK} />
      <IsoBox a={2.7} z0={4} z1={8} colors={{ left: '#555c72', right: '#6a7290', top: '#7d86a4' }} />
      <g transform="translate(0 -8)">
        <polygon
          points={`${boxCorners(2.2).W.x},0 0,${boxCorners(2.2).N.y} ${boxCorners(2.2).E.x},0 0,${boxCorners(2.2).Sx.y}`}
          fill="none"
          stroke={color}
          strokeWidth={1.6}
          opacity={0.9}
        />
        <polygon
          points={`${boxCorners(1.4).W.x},0 0,${boxCorners(1.4).N.y} ${boxCorners(1.4).E.x},0 0,${boxCorners(1.4).Sx.y}`}
          fill={glow}
          opacity={0.12}
        />
      </g>
      {lamps.map((p, i) => (
        <g key={i} transform={`translate(${p.x} ${p.y - 8})`}>
          <circle cx={0} cy={-17} r={7} fill="url(#glow-warm)" opacity={0.6} />
          <rect x={-0.7} y={-17} width={1.4} height={17} fill="#9aa3b8" />
          <circle cx={0} cy={-17.5} r={1.9} fill="#ffe7a8" />
        </g>
      ))}
    </g>
  )
}

/** Front banner poles are drawn after the monument so they read in front of it. */
function PadBanners({ color, glow }: { color: string; glow: string }) {
  const poles = [iso(3.0, 1.2), iso(1.2, 3.0)]
  return (
    <g>
      {poles.map((p, i) => (
        <g key={i} transform={`translate(${p.x} ${p.y - 4})`}>
          <rect x={-0.8} y={-44} width={1.6} height={44} fill="#c9ccd6" />
          <circle cx={0} cy={-45} r={1.8} fill={GOLD} />
          <path d={`M0.8 -42 h11 v18 l-5.5 -4 l-5.5 4 Z`} fill={color} />
          <rect x={0.8} y={-42} width={11} height={2} fill={glow} />
        </g>
      ))}
    </g>
  )
}

function Fountain({ color, glow }: { color: string; glow: string }) {
  const water = glow
  const basin = { rx: 2.5 * Math.SQRT2 * COS30 * S, ry: 2.5 * Math.SQRT2 * 0.5 * S }
  const mid = { rx: basin.rx * 0.5, ry: basin.ry * 0.5 }
  const top = { rx: basin.rx * 0.26, ry: basin.ry * 0.26 }
  return (
    <g className="fountain">
      <circle cx={0} cy={-40} r={70} fill="url(#glow-white)" opacity={0.12} />
      {/* Lower basin: stone drum + rim + water */}
      <ellipse cx={0} cy={0} rx={basin.rx} ry={basin.ry} fill="#6f6a60" />
      <rect x={-basin.rx} y={-12} width={basin.rx * 2} height={12} fill="#8f877a" />
      <ellipse cx={0} cy={-12} rx={basin.rx} ry={basin.ry} fill="#d9d0bb" />
      <ellipse cx={0} cy={-12} rx={basin.rx * 0.9} ry={basin.ry * 0.9} fill={water} opacity={0.85} />
      <ellipse cx={0} cy={-12} rx={basin.rx * 0.9} ry={basin.ry * 0.9} fill="url(#water-sheen)" />
      <ellipse cx={0} cy={-12} rx={basin.rx * 0.6} ry={basin.ry * 0.6} fill="none" stroke="#fff" strokeOpacity={0.45} className="ripple" />
      {/* Arcing jets from the rim toward the centre */}
      {[-0.8, -0.35, 0.35, 0.8].map((f) => (
        <path key={f} d={`M${f * basin.rx * 0.88} ${-12 + Math.abs(f) * 6} Q${f * basin.rx * 0.5} -46 ${f * 8} -20`} stroke="#e8f7ff" strokeWidth={1.6} fill="none" opacity={0.75} />
      ))}
      {/* Column + middle bowl */}
      <rect x={-4} y={-46} width={8} height={34} fill="#bdb4a0" />
      <ellipse cx={0} cy={-46} rx={mid.rx} ry={mid.ry} fill="#a79f8c" />
      <rect x={-mid.rx} y={-52} width={mid.rx * 2} height={6} fill="#c4bba6" />
      <ellipse cx={0} cy={-52} rx={mid.rx} ry={mid.ry} fill="#e2d9c4" />
      <ellipse cx={0} cy={-52} rx={mid.rx * 0.85} ry={mid.ry * 0.85} fill={water} opacity={0.85} />
      {/* Water curtains spilling from the middle bowl */}
      {[-1, 1].map((sgn) => (
        <path key={sgn} d={`M${sgn * mid.rx * 0.95} -50 Q${sgn * mid.rx * 1.35} -36 ${sgn * mid.rx * 1.25} -14`} stroke="#dff4ff" strokeWidth={3} fill="none" opacity={0.7} className="water-fall" />
      ))}
      <path d={`M${-mid.rx * 0.6} -46 Q0 -38 ${mid.rx * 0.6} -46`} stroke="#dff4ff" strokeWidth={2} fill="none" opacity={0.5} />
      {/* Upper column + top bowl */}
      <rect x={-2.6} y={-76} width={5.2} height={24} fill="#cfc6b2" />
      <ellipse cx={0} cy={-76} rx={top.rx} ry={top.ry} fill="#b3aa98" />
      <rect x={-top.rx} y={-80} width={top.rx * 2} height={4} fill="#d5ccb7" />
      <ellipse cx={0} cy={-80} rx={top.rx} ry={top.ry} fill={water} />
      {/* Central jet and spray crown */}
      <rect x={-1.6} y={-122} width={3.2} height={42} fill="#f2fbff" opacity={0.9} className="jet" />
      {[-1, 1].map((sgn) => (
        <path key={sgn} d={`M0 -120 Q${sgn * 16} -130 ${sgn * top.rx * 1.1} -80`} stroke="#eaf8ff" strokeWidth={1.8} fill="none" opacity={0.75} />
      ))}
      <circle cx={0} cy={-122} r={9} fill="url(#glow-white)" opacity={0.9} />
      {/* District-coloured underwater lights */}
      <ellipse cx={0} cy={-12} rx={basin.rx * 0.9} ry={basin.ry * 0.9} fill="none" stroke={color} strokeWidth={2} opacity={0.8} />
    </g>
  )
}

function Arch({ color, glow }: { color: string; glow: string }) {
  const ax = 2.8
  const ay = 0.95
  const h = 104
  const fw = boxCorners(ax, ay).faceW
  const fr = boxCorners(ax, ay).faceWR
  const ow = 34
  const spring = 58
  return (
    <g className="arch">
      <IsoBox
        a={ax}
        ay={ay}
        z0={0}
        z1={h}
        colors={STONE}
        left={
          <g>
            {/* Central archway with light glowing through it */}
            <path d={`M${fw / 2 - ow / 2} ${h} V${h - spring} A${ow / 2} ${ow / 2} 0 0 1 ${fw / 2 + ow / 2} ${h - spring} V${h} Z`} fill="#1a1d2c" />
            <path d={`M${fw / 2 - ow / 2 + 3} ${h} V${h - spring} A${ow / 2 - 3} ${ow / 2 - 3} 0 0 1 ${fw / 2 + ow / 2 - 3} ${h - spring} V${h} Z`} fill={glow} opacity={0.35} />
            <path d={`M${fw / 2 - ow / 2 - 3} ${h} V${h - spring} A${ow / 2 + 3} ${ow / 2 + 3} 0 0 1 ${fw / 2 + ow / 2 + 3} ${h - spring} V${h}`} fill="none" stroke="#efe6d0" strokeWidth={2} />
            {/* Side passages */}
            {[fw * 0.14, fw * 0.86].map((x) => (
              <path key={x} d={`M${x - 6} ${h} V${h - 30} A6 6 0 0 1 ${x + 6} ${h - 30} V${h} Z`} fill="#1a1d2c" />
            ))}
            {/* Columns */}
            {[fw * 0.25, fw * 0.32, fw * 0.68, fw * 0.75].map((x) => (
              <rect key={x} x={x - 2} y={16} width={4} height={h - 16} fill="#efe6d0" opacity={0.85} />
            ))}
            {/* Inscription frieze in the holder's colour */}
            <rect x={6} y={4} width={fw - 12} height={10} fill={color} />
            <rect x={6} y={4} width={fw - 12} height={2} fill={glow} />
          </g>
        }
        right={
          <g>
            <path d={`M${fr / 2 - 6} ${h} V${h - 34} A6 6 0 0 1 ${fr / 2 + 6} ${h - 34} V${h} Z`} fill="#1a1d2c" />
            <rect x={2} y={4} width={fr - 4} height={10} fill={color} />
          </g>
        }
      />
      {/* Attic + gilded crown group */}
      <IsoBox a={ax + 0.15} ay={ay + 0.15} z0={h} z1={h + 14} colors={{ left: '#a79f8c', right: '#c8bfaa', top: '#ddd4be' }} />
      <g transform={`translate(0 ${-(h + 14)})`}>
        <path d="M-14 0 L-14 -14 L-7 -7 L0 -20 L7 -7 L14 -14 L14 0 Z" fill={GOLD} stroke="#fff3c4" strokeWidth={0.8} />
        <circle cx={0} cy={-22} r={2.4} fill="#fff" />
        {[-1, 1].map((sgn) => {
          const p = iso(sgn * (ax - 0.3), sgn * -0.2)
          return (
            <g key={sgn} transform={`translate(${p.x} ${p.y})`}>
              <rect x={-0.7} y={-30} width={1.4} height={30} fill="#d6d9e2" />
              <path d="M0.7 -29 h13 l-3 5 l3 5 h-13 Z" fill={color} />
            </g>
          )
        })}
      </g>
    </g>
  )
}

function Obelisk({ color, glow }: { color: string; glow: string }) {
  const z0 = 22
  const z1 = 176
  const b = boxCorners(0.78)
  const t = boxCorners(0.46)
  const pt = (p: { x: number; y: number }, z: number) => `${p.x.toFixed(1)},${(p.y - z).toFixed(1)}`
  return (
    <g className="obelisk">
      <IsoBox a={1.7} z0={0} z1={9} colors={STONE_DARK} />
      <IsoBox a={1.3} z0={9} z1={16} colors={{ left: '#4b5269', right: '#5d6581', top: '#707a99' }} />
      <IsoBox a={0.98} z0={16} z1={z0} colors={{ left: color, right: glow, top: glow }} />
      {/* Tapered shaft */}
      <polygon points={`${pt(b.W, z0)} ${pt(b.Sx, z0)} ${pt(t.Sx, z1)} ${pt(t.W, z1)}`} fill="#7c7667" />
      <polygon points={`${pt(b.Sx, z0)} ${pt(b.E, z0)} ${pt(t.E, z1)} ${pt(t.Sx, z1)}`} fill="#a59e8c" />
      {/* Carved glyph lines */}
      {[40, 64, 88, 112, 136].map((z) => (
        <line key={z} x1={-6} y1={2 - z} x2={-2} y2={4.4 - z} stroke={GOLD} strokeWidth={1.2} opacity={0.75} />
      ))}
      <line x1={0} y1={b.Sx.y - z0} x2={0} y2={t.Sx.y - z1} stroke="#d8d0bc" strokeWidth={0.8} />
      {/* Gilded pyramidion */}
      <polygon points={`${pt(t.W, z1)} ${pt(t.Sx, z1)} 0,${-(z1 + 30)}`} fill="#d9a82e" />
      <polygon points={`${pt(t.Sx, z1)} ${pt(t.E, z1)} 0,${-(z1 + 30)}`} fill={GOLD} />
      <circle cx={0} cy={-(z1 + 30)} r={16} fill="url(#glow-gold)" opacity={0.9} />
    </g>
  )
}

const PALE = { left: '#b9b09c', right: '#d8cfba', top: '#ebe3d0' }
const CORNICE = { left: '#cbbf9f', right: '#e6dcc2', top: '#f4ecd8' }
/** Extrusion steps (back → front) giving the cast its thickness. */
const DEPTH = [8, 7, 6, 5, 4, 3, 2, 1]

/**
 * T5 Friend Statue: a monumental bronze cast of the HOLDING family's Friend silhouette on
 * a pale-stone plinth with a gilded inscription and architectural uplighting. The official
 * transparent silhouette is used as a mask (not pasted flat): an extruded dark-bronze body
 * gives it thickness, a pale-gold rim catches the light and a polished gradient forms the
 * face. Works for every family because it is driven entirely by `statueForm()`.
 */
function Statue({ districtId, color, glow }: { districtId: DistrictId; color: string; glow: string }) {
  const uid = useId().replace(/[^\w-]/g, '')
  const f = statueForm(districtId)
  const mask = `statue-mask-${uid}`
  const metal = `statue-metal-${uid}`
  const sheen = `statue-sheen-${uid}`
  /** Plinth height (px); the bronze casting base adds BASE on top. */
  const top = 66
  const BASE = 5
  const die = boxCorners(1.3)
  const dieH = top - 8 - 18
  const fig = { x: -f.width / 2 - 2, y: -f.height - 2, w: f.width + 4, h: f.height + 4 }
  const cast = (fill: string, dx = 0, dy = 0, opacity = 1) => (
    <rect x={fig.x} y={fig.y} width={fig.w} height={fig.h} fill={fill} opacity={opacity} mask={`url(#${mask})`} transform={dx || dy ? `translate(${dx} ${dy})` : undefined} />
  )
  const name = f.familyName.toUpperCase()
  return (
    <g className="statue" data-statue-family={f.familyKey}>
      <defs>
        <mask id={mask} style={{ maskType: 'alpha' }}>
          <image href={f.image} x={f.imageX} y={f.imageY} width={f.imageSize} height={f.imageSize} />
        </mask>
        <linearGradient id={metal} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f3dca2" />
          <stop offset="0.22" stopColor="#d4a458" />
          <stop offset="0.5" stopColor="#a06c2c" />
          <stop offset="0.78" stopColor="#6f4a1d" />
          <stop offset="1" stopColor="#43290f" />
        </linearGradient>
        <linearGradient id={`${metal}-wash`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#ffe3a0" stopOpacity="0.5" />
          <stop offset="0.55" stopColor="#ffe3a0" stopOpacity="0.08" />
          <stop offset="1" stopColor="#ffe3a0" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={sheen} x1="0" y1="0" x2="1" y2="0.35">
          <stop offset="0.3" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.42" stopColor="#fff6dc" stopOpacity="0.55" />
          <stop offset="0.52" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Civic plinth: three granite/stone steps, a pale-stone die with panel moulding and a
          gilded family inscription, washed by ground uplights, then a gold-filleted cornice. */}
      <IsoBox a={2.05} z0={0} z1={7} colors={STONE_DARK} />
      <IsoBox a={1.78} z0={7} z1={13} colors={{ left: '#5d6581', right: '#707a99', top: '#8a93b0' }} />
      <IsoBox a={1.52} z0={13} z1={18} colors={{ left: '#a39a86', right: '#c2b9a4', top: '#d6cdb8' }} />
      <IsoBox
        a={1.3}
        z0={18}
        z1={top - 8}
        colors={PALE}
        left={
          <g>
            <rect x={3} y={4} width={die.faceW - 6} height={dieH - 8} fill="none" stroke="#9d8f74" strokeWidth={0.7} />
            <rect x={5} y={10} width={die.faceW - 10} height={11} fill="#d9b25a" />
            <rect x={5} y={10} width={die.faceW - 10} height={1.2} fill="#fff1c4" />
            <text x={die.faceW / 2} y={18} textAnchor="middle" fontSize={5.6} fontWeight={900} fill="#3b2a0e" textLength={Math.min(die.faceW - 14, name.length * 4.3)} lengthAdjust="spacingAndGlyphs">
              {name}
            </text>
            <rect x={0} y={0} width={die.faceW} height={dieH} fill={`url(#${metal}-wash)`} />
          </g>
        }
        right={
          <g>
            <rect x={3} y={4} width={die.faceW - 6} height={dieH - 8} fill="none" stroke="#b3a68a" strokeWidth={0.7} />
            <rect x={die.faceW / 2 - 7} y={10} width={14} height={11} fill={color} />
            <rect x={die.faceW / 2 - 7} y={10} width={14} height={1.6} fill={glow} />
            <rect x={0} y={0} width={die.faceW} height={dieH} fill={`url(#${metal}-wash)`} opacity={0.7} />
          </g>
        }
      />
      <IsoBox a={1.5} z0={top - 8} z1={top - 4} colors={CORNICE} />
      <IsoBox a={1.4} z0={top - 4} z1={top - 3} colors={{ left: '#c9a24c', right: '#e2bd63', top: '#f0d58a' }} />
      <IsoBox a={1.36} z0={top - 3} z1={top} colors={CORNICE} />
      {/* Ground uplights on the lowest step, washing the die */}
      {[iso(1.9, 0.9), iso(0.9, 1.9)].map((p, i) => (
        <g key={i} transform={`translate(${p.x.toFixed(1)} ${(p.y - 7).toFixed(1)})`}>
          <polygon points={`-2,0 2,0 ${i ? 5 : 9},-34 ${i ? -9 : -5},-34`} fill="url(#beam-gold)" opacity={0.3} />
          <rect x={-1.6} y={-1.6} width={3.2} height={1.6} fill="#2a2e3c" />
          <circle cx={0} cy={-1.8} r={1.1} fill="#fff4cf" />
        </g>
      ))}
      {/* Bronze casting base the figure stands on */}
      <IsoBox a={1.12} z0={top} z1={top + BASE} colors={{ left: '#4a2f12', right: '#6f4a1d', top: '#a97a3c' }} />
      <g transform={`translate(0 ${-(top + BASE)})`}>
        {/* District halo + restrained gold uplight cones from the cornice lamps */}
        <ellipse cx={0} cy={-f.height * 0.55} rx={f.width * 0.62} ry={f.height * 0.62} fill={`url(#glow-${districtId})`} opacity={0.32} />
        {[-1, 1].map((s) => (
          <polygon key={s} points={`${s * 16},2 ${s * 5},2 ${s * (f.width * 0.32)},${-f.height - 24} ${s * (f.width * 0.62 + 10)},${-f.height - 24}`} fill="url(#beam-gold)" opacity={0.28} />
        ))}
        <ellipse cx={0} cy={1} rx={Math.min(40, f.width * 0.42)} ry={7} fill="#1b140c" opacity={0.45} />
        {/* Cast body: shadowed depth (back → front), lit top faces, rim light, polished face, sheen */}
        {DEPTH.map((i) => (
          <g key={i}>{cast(i === DEPTH[0] ? '#1d1208' : '#3a2410', i * 1.02, -i * 0.64)}</g>
        ))}
        {DEPTH.map((i) => (
          <g key={`t${i}`}>{cast(i === DEPTH[0] ? '#9a6f36' : '#d6a865', i * 0.5, -i * 0.64)}</g>
        ))}
        {cast('#fff3d0', 0, -0.9, 0.75)}
        {cast('#ffecb8', -1, -0.3, 0.85)}
        {cast(`url(#${metal})`)}
        {cast(`url(#${sheen})`)}
        {[-1, 1].map((s) => (
          <circle key={s} cx={s * 19} cy={BASE - 1} r={1.8} fill="#fff4cf" />
        ))}
      </g>
    </g>
  )
}

function Beacon({ color, glow }: { color: string; glow: string }) {
  const bands = [14, 44, 74, 104, 134, 164, 194]
  const pt = (p: { x: number; y: number }, z: number) => `${p.x.toFixed(1)},${(p.y - z).toFixed(1)}`
  const b = boxCorners(1.35)
  const t = boxCorners(0.85)
  const zTop = 214
  return (
    <g className="beacon">
      <IsoBox a={2} z0={0} z1={14} colors={STONE_DARK} />
      <polygon points={`${pt(b.W, 14)} ${pt(b.Sx, 14)} ${pt(t.Sx, zTop)} ${pt(t.W, zTop)}`} fill="#d7dbe6" />
      <polygon points={`${pt(b.Sx, 14)} ${pt(b.E, 14)} ${pt(t.E, zTop)} ${pt(t.Sx, zTop)}`} fill="#eef1f7" />
      {bands.slice(1).map((z, i) =>
        i % 2 === 0 ? (
          <g key={z}>
            <polygon
              points={`${pt(boxCorners(1.35 - (0.5 * (z - 14)) / 200).W, z)} ${pt(boxCorners(1.35 - (0.5 * (z - 14)) / 200).Sx, z)} ${pt(boxCorners(1.35 - (0.5 * (z + 16)) / 200).Sx, z + 30)} ${pt(boxCorners(1.35 - (0.5 * (z + 16)) / 200).W, z + 30)}`}
              fill={color}
            />
            <polygon
              points={`${pt(boxCorners(1.35 - (0.5 * (z - 14)) / 200).Sx, z)} ${pt(boxCorners(1.35 - (0.5 * (z - 14)) / 200).E, z)} ${pt(boxCorners(1.35 - (0.5 * (z + 16)) / 200).E, z + 30)} ${pt(boxCorners(1.35 - (0.5 * (z + 16)) / 200).Sx, z + 30)}`}
              fill={glow}
            />
          </g>
        ) : null,
      )}
      <IsoBox a={1.2} z0={zTop} z1={zTop + 6} colors={STONE_DARK} />
      <IsoBox a={0.8} z0={zTop + 6} z1={zTop + 34} colors={{ left: '#fff4c8', right: '#fffbe6', top: '#fff' }} />
      <polygon points={`${boxCorners(0.95).W.x},${-(zTop + 34)} 0,${-(zTop + 58)} ${boxCorners(0.95).E.x},${-(zTop + 34)} 0,${boxCorners(0.95).Sx.y - (zTop + 34)}`} fill={color} />
      <circle cx={0} cy={-(zTop + 20)} r={34} fill="url(#glow-white)" opacity={0.85} />
      <g className="beacon-sweep" style={{ transformOrigin: `0px ${-(zTop + 20)}px` }}>
        <polygon points={`0,${-(zTop + 20)} 260,${-(zTop + 70)} 260,${-(zTop + 30)}`} fill="#fffbe6" opacity={0.18} />
        <polygon points={`0,${-(zTop + 20)} -260,${-(zTop + 10)} -260,${-(zTop - 28)}`} fill="#fffbe6" opacity={0.12} />
      </g>
    </g>
  )
}

export function MonumentShape({ monumentId, districtId, color, glow }: { monumentId: MonumentId; districtId: DistrictId; color: string; glow: string }) {
  switch (getMonument(monumentId).kind) {
    case 'fountain':
      return <Fountain color={color} glow={glow} />
    case 'arch':
      return <Arch color={color} glow={glow} />
    case 'obelisk':
      return <Obelisk color={color} glow={glow} />
    case 'statue':
      return <Statue districtId={districtId} color={color} glow={glow} />
    case 'beacon':
      return <Beacon color={color} glow={glow} />
  }
}

export const MonumentSprite = memo(function MonumentSprite({
  monumentId,
  districtId,
  phase,
  detail,
  scale,
  labelScale,
}: {
  monumentId: MonumentId
  districtId: DistrictId
  phase: MonumentPhase
  detail: Detail
  scale: number
  labelScale: number
}) {
  const d = getDistrict(districtId)
  const m = getMonument(monumentId)
  const c = boxCorners(MONUMENT_PAD_A)
  return (
    <g
      className={`monument monument-${phase}`}
      data-testid={phase === 'falling' ? `monument-ruin-${monumentId}` : `monument-${monumentId}`}
      data-district={districtId}
      data-kind={m.kind}
      data-family={d.familyKey}
      aria-label={`${m.name}${m.kind === 'statue' ? ` in ${d.name} form` : ''}, ${phase === 'falling' ? 'collapsing in' : 'held by'} the ${d.title}`}
      role="img"
      transform={`scale(${scale * MONUMENT_SPRITE_SCALE})`}
    >
      <ellipse cx={0} cy={2} rx={c.E.x * 1.5} ry={c.Sx.y * 1.5} fill={`url(#glow-${districtId})`} opacity={phase === 'falling' ? 0.1 : 0.55} />
      <g className="monument-padwrap">
        <MonumentPad color={d.color} glow={d.glow} />
      </g>
      {phase === 'rising' && (
        <g className="capture-fx" pointerEvents="none">
          <ellipse cx={0} cy={-8} rx={c.E.x} ry={c.Sx.y} fill="none" stroke={d.glow} strokeWidth={5} className="shockwave" />
          <ellipse cx={0} cy={-8} rx={c.E.x} ry={c.Sx.y} fill="none" stroke="#fff" strokeWidth={2} className="shockwave shockwave-b" />
          <rect x={-26} y={-700} width={52} height={692} fill={`url(#beam-${districtId})`} className="capture-column" />
        </g>
      )}
      <g transform="translate(0 -8)">
        <g className="monument-body">
          <MonumentShape monumentId={monumentId} districtId={districtId} color={d.color} glow={d.glow} />
        </g>
      </g>
      {phase !== 'falling' && <PadBanners color={d.color} glow={d.glow} />}
      {phase === 'falling' && (
        <g className="dust" pointerEvents="none">
          {[-40, -22, -6, 10, 26, 42].map((x, i) => (
            <circle key={x} cx={x} cy={-10 - (i % 3) * 12} r={12 + (i % 3) * 5} fill="#9a8f80" opacity={0.4} />
          ))}
          {[-30, -10, 14, 34].map((x, i) => (
            <rect key={x} x={x} y={-6 - i * 3} width={6} height={4} fill="#6f685d" transform={`rotate(${i * 25} ${x} 0)`} />
          ))}
        </g>
      )}
      {detail !== 'far' && phase !== 'falling' && (
        <g id={`ml-${districtId}-${monumentId}`} transform={`translate(0 ${c.Sx.y + 18}) scale(${labelScale / (scale * MONUMENT_SPRITE_SCALE)})`}>
          <rect x={-66} y={-10} width={132} height={18} rx={9} fill="#0b0f1cee" stroke={d.color} strokeWidth={1.2} />
          <text x={0} y={2.8} textAnchor="middle" fontSize={8.5} fontWeight={800} fill="#f3f5fb" letterSpacing={0.5}>
            {m.name.replace(/^The /, '').toUpperCase()} · T{m.tier}
          </text>
        </g>
      )}
    </g>
  )
})

/** Empty civic square marker when the district holds no monument. */
export function EmptyCivicSite() {
  const c = boxCorners(2.4)
  return (
    <polygon
      points={`${c.W.x},0 0,${c.N.y} ${c.E.x},0 0,${c.Sx.y}`}
      fill="none"
      stroke="#ffffff"
      strokeOpacity={0.12}
      strokeDasharray="5 5"
    />
  )
}
