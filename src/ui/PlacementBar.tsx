import { getDistrict, type DistrictId } from '../config/districts'
import { plotId } from '../game/world'
import { wardName, type PlotCandidate } from '../game/allocation'
import { DistrictEmblem } from './common'

/**
 * Compact placement controls: what to do, what is selected, and confirm / cancel. Nothing is
 * committed until "Place Friend here"; cancelling leaves the city exactly as it was.
 */
export function PlacementBar({
  districtId,
  candidates,
  selected,
  nextFriendId,
  onConfirm,
  onClearSelection,
  onCancel,
}: {
  districtId: DistrictId
  candidates: PlotCandidate[]
  selected: PlotCandidate | null
  nextFriendId: number
  onConfirm: () => void
  onClearSelection: () => void
  onCancel: () => void
}) {
  const d = getDistrict(districtId)
  const newWard = candidates[0]?.newWard ? candidates[0].ward : null
  return (
    <section className="placement-bar" role="dialog" aria-label={`Choose a plot in the ${d.title}`} data-testid="placement-bar" data-district={districtId} style={{ ['--dc' as string]: d.color }}>
      <div className="row-between">
        <div className="kicker placement-kicker">
          <DistrictEmblem id={districtId} size={18} /> CHOOSE A PLOT · {d.title.toUpperCase()}
        </div>
        <span className="sim-tag">DEMO FRIEND #{nextFriendId}</span>
      </div>
      {selected ? (
        <div className="placement-selected" data-testid="placement-selected" data-ward={selected.ward} data-plot={selected.plot}>
          <b>{wardName(selected.ward)}</b>
          {selected.newWard && <span className="crown-tag">NEW WARD</span>} · plot {selected.plot + 1} · <code>{plotId(districtId, selected.ward, selected.plot)}</code>
          {selected.newWard && <div className="small muted">Placing here opens {wardName(selected.ward)} for the whole district.</div>}
        </div>
      ) : (
        <p className="small placement-help" data-testid="placement-count" data-count={candidates.length}>
          {newWard !== null ? (
            <>
              Every plot in the open Wards is taken. Pick any of the <b>{candidates.length}</b> highlighted plots in the new <b>{wardName(newWard)}</b>. This Friend opens it.
            </>
          ) : (
            <>
              Pick any of the <b>{candidates.length}</b> highlighted plots. The Friend&apos;s family sets the district; the exact plot is your choice.
            </>
          )}{' '}
          <span className="muted">Location is personal preference only: no gameplay advantage.</span>
        </p>
      )}
      <div className="row gap wrap">
        {selected && (
          <>
            <button type="button" className="btn primary sm" onClick={onConfirm} data-testid="placement-confirm" autoFocus>
              Place Friend here
            </button>
            <button type="button" className="btn ghost sm" onClick={onClearSelection} data-testid="placement-reselect">
              Choose another plot
            </button>
          </>
        )}
        <button type="button" className="btn ghost sm" onClick={onCancel} data-testid="placement-cancel">
          Cancel
        </button>
      </div>
    </section>
  )
}
