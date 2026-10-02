import { useState } from 'react'
import { getDistrict } from '../../config/districts'
import { PATRON_LEVELS, QUICK_AMOUNTS, STAGES_PER_TIER } from '../../config/economy'
import { friendLabel } from '../../config/identity'
import {
  architectLevel,
  buildSplit,
  formatRF,
  heightMeters,
  patronLevelIndex,
  rankedPatrons,
  rfToNextTier,
  stageFor,
  tierFor,
  tierProgress,
  uniqueSupporters,
} from '../../game/economy'
import { describeImpact, handleOf } from '../../game/narration'
import { isFoundingWard, wardName } from '../../game/allocation'
import { contributionAllegiance, homeDistrict } from '../../game/season'
import { mediaTierFor, nextMediaTier } from '../../config/media'
import { projectImpact } from '../../game/projection'
import type { GameState } from '../../game/types'
import { Avatar, DistrictChip, PanelHeader, ProgressBar, SimTag } from '../common'
import type { GameAction } from '../store'

interface Props {
  game: GameState
  /** null = an anonymous visitor: the property is shown, nothing can be funded. */
  viewerId: string | null
  buildingId: string
  act: (a: GameAction) => void
  onClose: () => void
  onBack?: () => void
  onArchitect: () => void
}

export function BuildingPanel({ game, viewerId, buildingId, act, onClose, onBack, onArchitect }: Props) {
  const b = game.buildings[buildingId]
  const [pending, setPending] = useState<number | null>(null)
  const [custom, setCustom] = useState('')
  const [showPatrons, setShowPatrons] = useState(false)
  const split = buildSplit(b)
  const tier = tierFor(split.total)
  const stage = stageFor(split.total)
  const need = rfToNextTier(split.total)
  const isOwner = b.ownerId === viewerId
  const owner = game.users[b.ownerId]
  const district = getDistrict(b.districtId)
  const wallet = viewerId ? (game.wallets[viewerId] ?? 0) : 0
  const patrons = rankedPatrons(b)
  const nextLines = need === null ? [] : describeImpact(game, projectImpact(game, buildingId, need))
  const pendingLines = pending ? describeImpact(game, projectImpact(game, buildingId, pending)) : []
  const pendingTier = pending ? tierFor(split.total + pending) : tier
  const isCrown = game.crown.holder === b.id
  const allegiance = viewerId ? contributionAllegiance(game, viewerId, buildingId) : { allegiance: 'unaligned' as const, warning: null }
  const home = viewerId ? homeDistrict(game, viewerId) : null
  const homeName = home ? getDistrict(home).name : 'none'
  const media = mediaTierFor(tier)
  const nextMedia = nextMediaTier(tier)

  const choose = (amt: number) => setPending(amt)
  const confirm = () => {
    if (!pending) return
    act({ type: 'contribute', buildingId, amount: pending })
    setPending(null)
    setCustom('')
  }
  const customAmt = Math.floor(Number(custom))

  return (
    <section className="panel building-panel" aria-label={`${friendLabel(b.friendId)} details`} data-testid="building-panel" data-building={b.friendId}>
      <PanelHeader
        kicker={
          <>
            <DistrictChip id={b.districtId} small /> {isOwner && <span className="own-tag">YOUR BUILDING</span>}
            {isCrown && <span className="crown-tag">♔ CITY CROWN</span>}
          </>
        }
        title={friendLabel(b.friendId)}
        onClose={onClose}
        onBack={onBack}
      />
      <div className="owner-row">
        <Avatar user={owner} size={30} />
        <div>
          <div className="muted small">Owner</div>
          <div className="strong">{handleOf(game, b.ownerId)}</div>
        </div>
        <div className="tier-medal" style={{ ['--dc' as string]: district.color }} data-testid="panel-tier">
          <span>TIER</span>
          <b>{tier}</b>
        </div>
      </div>

      <div className="address small muted" data-testid="building-address">
        {district.title} · {wardName(b.ward)}
        {isFoundingWard(b.ward) && <span className="founding-tag"> Founding Ward</span>} · Plot {b.plot + 1}
      </div>

      <div className="tier-progress">
        <div className="row-between small">
          <span>
            Stage {stage}/{STAGES_PER_TIER}
          </span>
          <span data-testid="rf-to-next">{need === null ? 'Max tier' : `${formatRF(need)} RF to Tier ${tier + 1}`}</span>
        </div>
        <ProgressBar value={tierProgress(split.total)} color={district.color} label="Progress to next tier" />
      </div>

      <dl className="stat-grid">
        <div>
          <dt>Total Built</dt>
          <dd data-testid="total-built">{formatRF(split.total)}</dd>
        </div>
        <div>
          <dt>Owner Built</dt>
          <dd data-testid="owner-built">{formatRF(split.owner)}</dd>
        </div>
        <div>
          <dt>Community Built</dt>
          <dd data-testid="community-built">{formatRF(split.community)}</dd>
        </div>
        <div>
          <dt>Height</dt>
          <dd>{heightMeters(split.total)} m</dd>
        </div>
      </dl>
      <div className="split-bar" aria-label={`Owner ${split.ownerPct.toFixed(0)} percent, community ${split.communityPct.toFixed(0)} percent`}>
        <div className="split-owner" style={{ width: `${split.ownerPct}%` }} />
        <div className="split-comm" style={{ width: `${split.communityPct}%` }} />
      </div>
      <div className="row-between small muted">
        <span>
          OWNER <b data-testid="owner-pct">{split.ownerPct.toFixed(0)}%</b> {split.ownerPct >= 75 && tier >= 3 ? '· Self-Made' : ''}
        </span>
        <span>
          COMMUNITY <b>{split.communityPct.toFixed(0)}%</b> · {uniqueSupporters(b)} supporters{uniqueSupporters(b) >= 8 ? " · People's Tower" : ''}
        </span>
      </div>

      {nextLines.length > 0 && (
        <div className="impact-callout">
          <div className="kicker">NEXT TIER IMPACT</div>
          {nextLines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}

      {viewerId ? (
        <div className="fund-box">
          <div className="row-between">
            <h3>{isOwner ? 'Build your tower' : 'Fund construction'}</h3>
            <SimTag />
          </div>
          {allegiance.allegiance === 'rival' && (
            <div className="allegiance-note small" data-testid="allegiance-note">
              ⚑ Not your Home District. Building here strengthens the {district.title}.
            </div>
          )}
          <p className="muted small">
            {isOwner
              ? 'Owner spend advances Total Build, Owner Build and your Architect level.'
              : 'Your RF advances Total + Community Build and earns patron recognition. Only the owner controls the design.'}
          </p>
          <div className="chip-row">
            {QUICK_AMOUNTS.map((a) => (
              <button key={a} type="button" className={`chip${pending === a ? ' on' : ''}`} onClick={() => choose(a)} disabled={a > wallet} data-testid={`amount-${a}`}>
                +{a}
              </button>
            ))}
            {need !== null && (
              <button type="button" className={`chip chip-exact${pending === need ? ' on' : ''}`} onClick={() => choose(need)} disabled={need > wallet} data-testid="amount-exact">
                +{formatRF(need)} → T{tier + 1}
              </button>
            )}
          </div>
          <form
            className="custom-row"
            onSubmit={(e) => {
              e.preventDefault()
              if (customAmt >= 1 && customAmt <= wallet) choose(customAmt)
            }}
          >
            <label className="sr-only" htmlFor="custom-amt">
              Custom amount
            </label>
            <input id="custom-amt" inputMode="numeric" placeholder="Custom amount" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, ''))} />
            <button type="submit" className="btn ghost" disabled={!(customAmt >= 1 && customAmt <= wallet)}>
              Set
            </button>
          </form>
          {pending !== null && (
            <div className="confirm-box" role="dialog" aria-label="Confirm simulated contribution" data-testid="confirm-box">
              <div className="confirm-amount">
                {formatRF(pending)} <span>SIMULATED RF</span>
              </div>
              <div className="confirm-note">No real tokens move.</div>
              {allegiance.warning && (
                <div className="allegiance-warning" role="note" data-testid="allegiance-warning">
                  ⚠ {allegiance.warning} <span className="muted">({district.title}; your season Home District is {homeName}.)</span>
                </div>
              )}
              <ul className="confirm-effects">
                <li>
                  Total Build {formatRF(split.total)} → <b>{formatRF(split.total + pending)}</b>
                </li>
                {pendingTier > tier && <li className="hl">Tier {tier} → Tier {pendingTier}</li>}
                {pendingLines.map((l) => (
                  <li key={l} className="hl">
                    {l}
                  </li>
                ))}
              </ul>
              <div className="row gap">
                <button type="button" className="btn primary" onClick={confirm} data-testid="confirm-contribution">
                  Confirm {isOwner ? 'build' : 'contribution'}
                </button>
                <button type="button" className="btn ghost" onClick={() => setPending(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          <div className="row-between small muted">
            <span>
              Wallet: <b data-testid="panel-wallet">{formatRF(wallet)}</b> SIMULATED RF
            </span>
            <button type="button" className="link-btn" onClick={() => act({ type: 'rally', buildingId })} data-testid="rally-btn">
              📣 Rally District Radio
            </button>
          </div>
        </div>
      ) : (
        <div className="fund-box" data-testid="read-only-note">
          <h3>Browsing as a visitor</h3>
          <p className="muted small">This is the shared city. Funding and building are not available here yet.</p>
        </div>
      )}

      {tier >= 3 && (
        <div className="media-line small" data-testid="media-line">
          <b>Property media:</b> {media ? media.label : 'None yet'}
          {nextMedia && <span className="muted"> · Tier {nextMedia.minTier} unlocks {nextMedia.label}</span>}
        </div>
      )}

      {isOwner && (
        <button type="button" className="btn architect-btn" onClick={onArchitect} data-testid="open-architect">
          ◭ Open Architect Mode <span className="muted small">Lv {architectLevel(b.ownerBuilt)}</span>
        </button>
      )}

      <div className="patron-zone">
        <div className="row-between">
          <h3>Patron Zone</h3>
          <span className="muted small">Top 3 shown on the building</span>
        </div>
        {patrons.length === 0 && <p className="muted small">No patrons yet. Be the first.</p>}
        <ul className="patron-list">
          {(showPatrons ? patrons : patrons.slice(0, 3)).map((p, i) => {
            const lvl = patronLevelIndex(p.amount)
            return (
              <li key={p.userId} className={i < 3 ? 'featured' : ''} data-testid={`patron-${p.userId}`}>
                <Avatar user={game.users[p.userId]} size={24} />
                <span className="grow">
                  {handleOf(game, p.userId)}
                  <span className="muted small"> · {PATRON_LEVELS[lvl]?.label}</span>
                </span>
                <b>{formatRF(p.amount)}</b>
              </li>
            )
          })}
        </ul>
        {patrons.length > 3 && (
          <button type="button" className="link-btn" onClick={() => setShowPatrons((v) => !v)} data-testid="view-patrons">
            {showPatrons ? 'Show fewer' : `View all patrons (${patrons.length})`}
          </button>
        )}
      </div>

      {b.milestones.length > 0 && (
        <div className="milestones small muted">
          Milestones:{' '}
          {b.milestones.map((m) => (
            <span key={m.tier} className="ms">
              T{m.tier}
              {m.clock > 0 ? ` by ${handleOf(game, m.byUserId)}` : ''}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
