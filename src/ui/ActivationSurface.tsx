import { plotDisplay } from '../activation'
import { getDistrict } from '../config/districts'
import { RARE_FRIENDS_CHAIN } from '../config/rareFriends'
import type { PlotCandidate } from '../game/allocation'
import type { Activation } from './activation'
import { DistrictEmblem } from './common'

const STEP_TEXT = {
  intent: 'Preparing your activation…',
  signing: 'Check your wallet and sign the activation message. It is a signature only: no transaction and no gas.',
  committing: 'Recording your property with Rare City. Keep this page open.',
  confirming: 'Checking with Rare City…',
} as const

/**
 * Everything the page shows while a Friend is being activated: the plot bar over the map,
 * then the permanence review, then the wallet and the server.
 *
 * It only draws the flow's state and calls the flow. Until "Sign to activate" nothing here
 * sends anything anywhere: picking a plot, going back, cancelling and closing are page state.
 */
export function ActivationSurface({ activation, candidates }: { activation: Activation; candidates: PlotCandidate[] }) {
  const { snapshot, flow } = activation
  const { phase, friend, districtId, selected, step, notice } = snapshot
  if (phase === 'idle' || !friend || !districtId) return null
  const d = getDistrict(districtId)
  const site = selected ? plotDisplay(selected) : null
  const style = { ['--dc' as string]: d.color }
  const message = notice && (
    <p className={`small activation-notice${phase === 'choosing' ? '' : ' error'}`} role="alert" data-testid="activation-notice" data-kind={notice.kind}>
      {notice.text}
      {notice.kind === 'unsupported-signing-mode' && typeof notice.byteLength === 'number' && <span className="muted"> (The wallet returned {notice.byteLength} bytes; Rare City verifies 65-byte signatures today.)</span>}
    </p>
  )

  if (phase === 'choosing') {
    const newWard = candidates[0]?.newWard ? candidates[0].ward : null
    return (
      <section className="placement-bar" role="dialog" aria-label={`Choose a plot for Friend #${friend.tokenId} in the ${d.title}`} data-testid="activation-bar" data-district={districtId} data-token={friend.tokenId} style={style}>
        <div className="row-between">
          <div className="kicker placement-kicker">
            <DistrictEmblem id={districtId} size={18} /> CHOOSE A PLOT · {d.title.toUpperCase()}
          </div>
          <span className="rep-tag" data-testid="activation-friend">
            FRIEND #{friend.tokenId} · {friend.family.name.toUpperCase()}
          </span>
        </div>
        {message}
        {selected && site ? (
          <div className="placement-selected" data-testid="activation-selected" data-plot-id={site.protocolId}>
            <b>{site.label}</b>
            {selected.newWard && <span className="crown-tag">NEW WARD</span>}
            {selected.newWard && <div className="small muted">Activating here opens Ward {site.ward} for the whole district. Choosing it opens nothing.</div>}
          </div>
        ) : (
          <p className="small placement-help" data-testid="activation-count" data-count={candidates.length}>
            {newWard !== null ? (
              <>
                Every plot in the open Wards is taken. Pick any of the <b>{candidates.length}</b> highlighted plots in the new <b>Ward {newWard + 1}</b>.
              </>
            ) : (
              <>
                Pick any of the <b>{candidates.length}</b> highlighted plots. This Friend&apos;s family sets the district; the exact plot is your choice.
              </>
            )}{' '}
            <span className="muted">Location is personal preference only: no score, RF or progress advantage.</span>
          </p>
        )}
        <div className="row gap wrap">
          {selected && (
            <>
              <button type="button" className="btn primary sm" onClick={() => flow.review()} data-testid="activation-review-open" autoFocus>
                Review activation
              </button>
              <button type="button" className="btn ghost sm" onClick={() => flow.clearSelection()} data-testid="activation-reselect">
                Choose another plot
              </button>
            </>
          )}
          <button type="button" className="btn ghost sm" onClick={() => flow.cancel()} data-testid="activation-cancel">
            Cancel
          </button>
        </div>
      </section>
    )
  }

  const sending = phase === 'working' && (step === 'committing' || step === 'confirming')
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal activation-modal" role="dialog" aria-modal="true" aria-labelledby="activation-title" data-testid="activation-dialog" data-phase={phase} data-step={step ?? ''} style={style}>
        <div className="kicker placement-kicker">
          <DistrictEmblem id={districtId} size={18} /> PERMANENT ACTIVATION
        </div>
        <h2 id="activation-title">{phase === 'review' ? `Activate Friend #${friend.tokenId} here?` : phase === 'working' ? `Activating Friend #${friend.tokenId}` : `Friend #${friend.tokenId}`}</h2>

        {site && (
          <dl className="stat-grid activation-facts" data-testid="activation-review">
            <div>
              <dt>Friend</dt>
              <dd data-testid="review-friend">#{friend.tokenId}</dd>
            </div>
            <div>
              <dt>Family</dt>
              <dd data-testid="review-family">{friend.family.name}</dd>
            </div>
            <div>
              <dt>District</dt>
              <dd data-testid="review-district">{d.title}</dd>
            </div>
            <div>
              <dt>Ward · Plot</dt>
              <dd>
                Ward <span data-testid="review-ward">{site.ward}</span> · Plot <span data-testid="review-plot">{site.plot}</span>
              </dd>
            </div>
          </dl>
        )}

        {message}

        {phase === 'review' && (
          <>
            <ul className="activation-terms small" data-testid="activation-terms">
              <li>
                This becomes Friend #{friend.tokenId}&apos;s <b>permanent Rare City property</b>. A Friend has one property, and it stays on this plot.
              </li>
              <li>
                The property <b>belongs to the Friend</b>. If the NFT changes owner, the property goes with it.
              </li>
              <li>
                You will be asked for <b>a signature only</b>: no transaction, no gas, no NFT transfer, no RF movement, and no token or NFT approval.
              </li>
              {selected?.newWard && site && <li>This plot is in a new Ward. Activating here opens Ward {site.ward} for the whole district.</li>}
            </ul>
            <div className="row gap wrap">
              <button type="button" className="btn primary" onClick={() => void flow.confirm()} data-testid="activation-confirm">
                Sign to activate
              </button>
              {notice?.kind === 'wrong-chain' && (
                <button type="button" className="btn" onClick={() => void flow.switchChain()} data-testid="activation-switch-chain">
                  Switch to {RARE_FRIENDS_CHAIN.name}
                </button>
              )}
              <button type="button" className="btn ghost" onClick={() => flow.back()} data-testid="activation-back">
                Choose another plot
              </button>
              <button type="button" className="btn ghost" onClick={() => flow.cancel()} data-testid="activation-cancel">
                Cancel
              </button>
            </div>
            {site && (
              <details className="activation-tech muted small">
                <summary>Technical details</summary>
                Plot id <code data-testid="review-plot-id">{site.protocolId}</code> · {RARE_FRIENDS_CHAIN.name} (chain {RARE_FRIENDS_CHAIN.chainId})
              </details>
            )}
          </>
        )}

        {phase === 'working' && step && (
          <>
            <p className="small" role="status" data-testid="activation-working">
              {STEP_TEXT[step]}
            </p>
            {!sending && (
              <button type="button" className="btn ghost" onClick={() => flow.cancel()} data-testid="activation-cancel">
                Cancel
              </button>
            )}
          </>
        )}

        {phase === 'unresolved' && (
          <div className="row gap wrap">
            <button type="button" className="btn primary" onClick={() => void flow.retryCommit()} data-testid="activation-retry" autoFocus>
              Try again
            </button>
            <button type="button" className="btn ghost" onClick={() => flow.cancel()} data-testid="activation-stop">
              Stop
            </button>
            <p className="muted small activation-fineprint">Trying again sends the signature you already gave. Your wallet will not be asked to sign again.</p>
          </div>
        )}

        {phase === 'stopped' && (
          <button type="button" className="btn primary" onClick={() => flow.cancel()} data-testid="activation-close" autoFocus>
            Close
          </button>
        )}
      </div>
    </div>
  )
}
