import { memo, type KeyboardEvent, type MouseEvent } from 'react'
import { getDistrict } from '../../config/districts'
import { wardName, type PlotCandidate } from '../../game/allocation'
import { plotWorld } from '../../game/world'
import { boxCorners, isoW } from './geometry'
import { propertyLotHalf } from './roads'

/**
 * Placement mode: the district's selectable property sites drawn on the real plot geometry
 * (same road-safe lot size as an open plot). Only these are interactive; the rest of the
 * city stays visible but inert. A next-ward candidate set is a PREVIEW (the ward is not open).
 * While placing, this layer is drawn above buildings and labels so no candidate is hidden
 * behind a tower; the plots themselves never move.
 */
/** Touch-target half-size (world units): generous, yet short of the ~5.2-unit plot spacing. */
const CANDIDATE_HIT_HALF = 2.3

export const PlacementLayer = memo(function PlacementLayer({
  candidates,
  selected,
  onPick,
  labelScale,
}: {
  candidates: PlotCandidate[]
  selected: { ward: number; plot: number } | null
  /** Screen-constant label scale from the camera (as used by building/monument labels). */
  labelScale: number
  onPick: (c: PlotCandidate, e: MouseEvent | KeyboardEvent) => void
}) {
  if (candidates.length === 0) return null
  const d = getDistrict(candidates[0].districtId)
  const preview = candidates[0].newWard ? candidates[0].ward : null
  // Centred over the previewed ward's plots (which the camera frames), just above the topmost
  // site, so the marker stays on screen at any width without covering a site's centre.
  const sites = preview !== null ? candidates.map((c) => isoW(plotWorld(c.districtId, c.ward, c.plot))) : []
  const label =
    sites.length > 0
      ? { x: (Math.min(...sites.map((p) => p.x)) + Math.max(...sites.map((p) => p.x))) / 2, y: Math.min(...sites.map((p) => p.y)) - 34 }
      : null
  return (
    <g className="placement-layer" data-testid="placement-layer" data-district={d.id}>
      {label && (
        // Screen-constant size (like other map labels); phones show the short form via CSS
        // because the placement bar already explains that this Friend opens the ward.
        <g transform={`translate(${label.x.toFixed(1)} ${label.y.toFixed(1)}) scale(${labelScale})`} className="placement-new-ward" pointerEvents="none" data-testid="placement-new-ward">
          <text className="placement-new-ward-full" textAnchor="middle" fontSize={12} fontWeight={900} letterSpacing={2} fill="#ffe7a6" stroke="#0b0f1a" strokeWidth={3} paintOrder="stroke">
            NEW WARD · {wardName(preview!).toUpperCase()} OPENS WITH THIS FRIEND
          </text>
          <text className="placement-new-ward-short" textAnchor="middle" fontSize={12} fontWeight={900} letterSpacing={2} fill="#ffe7a6" stroke="#0b0f1a" strokeWidth={3} paintOrder="stroke">
            NEW WARD · {wardName(preview!).toUpperCase()}
          </text>
        </g>
      )}
      {/* Forgiving touch targets: invisible, larger than the lot, drawn BENEATH every visible
          site so a tap on a site's own diamond always wins over a neighbour's hit area. */}
      <g className="candidate-hits" aria-hidden="true">
        {candidates.map((c) => {
          const p = isoW(plotWorld(c.districtId, c.ward, c.plot))
          const k = boxCorners(Math.max(propertyLotHalf(c.districtId, c.ward, c.plot), CANDIDATE_HIT_HALF))
          return (
            <polygon
              key={`${c.ward}-${c.plot}`}
              points={`${(p.x + k.W.x).toFixed(1)},${(p.y + k.W.y).toFixed(1)} ${(p.x + k.N.x).toFixed(1)},${(p.y + k.N.y).toFixed(1)} ${(p.x + k.E.x).toFixed(1)},${(p.y + k.E.y).toFixed(1)} ${(p.x + k.Sx.x).toFixed(1)},${(p.y + k.Sx.y).toFixed(1)}`}
              fill="transparent"
              className="candidate-hit"
              data-testid={`candidate-hit-${c.districtId}-${c.ward}-${c.plot}`}
              onClick={(e) => onPick(c, e)}
            />
          )
        })}
      </g>
      {candidates.map((c) => {
        const p = isoW(plotWorld(c.districtId, c.ward, c.plot))
        const k = boxCorners(propertyLotHalf(c.districtId, c.ward, c.plot))
        const on = selected?.ward === c.ward && selected.plot === c.plot
        const pts = `${k.W.x},${k.W.y} ${k.N.x},${k.N.y} ${k.E.x},${k.E.y} ${k.Sx.x},${k.Sx.y}`
        return (
          <g
            key={`${c.ward}-${c.plot}`}
            transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}
            className={`candidate-plot${on ? ' on' : ''}${c.newWard ? ' new-ward' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={`${d.title}, ${wardName(c.ward)}, plot ${c.plot + 1}${c.newWard ? ' (opens a new ward)' : ''}`}
            aria-pressed={on}
            data-testid={`candidate-plot-${c.districtId}-${c.ward}-${c.plot}`}
            data-new-ward={c.newWard ? 'true' : 'false'}
            data-selected={on ? 'true' : 'false'}
            onClick={(e) => onPick(c, e)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              onPick(c, e)
            }}
          >
            <polygon points={pts} className="candidate-fill" />
            {on && (
              <g className="candidate-pin" pointerEvents="none">
                <line x1={0} y1={0} x2={0} y2={-26} stroke="#ffd45a" strokeWidth={1.6} />
                <circle cx={0} cy={-30} r={6} fill="#ffd45a" stroke="#fff6cc" strokeWidth={1.2} />
              </g>
            )}
          </g>
        )
      })}
    </g>
  )
})
