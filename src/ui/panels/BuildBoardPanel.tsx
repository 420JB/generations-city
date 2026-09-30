import { useMemo } from 'react'
import { DISTRICTS, getDistrict, type DistrictId } from '../../config/districts'
import { friendLabel } from '../../config/identity'
import { getMonument } from '../../config/monuments'
import { buildBoard, cityHotlist, type Opportunity } from '../../game/buildBoard'
import { formatRF } from '../../game/economy'
import { districtName } from '../../game/narration'
import type { GameState } from '../../game/types'
import { DistrictBanner, DistrictChip, DistrictEmblem, PanelHeader } from '../common'

interface Props {
  game: GameState
  districtId: DistrictId
  onDistrict: (d: DistrictId) => void
  onWarp: (buildingId: string) => void
  onClose: () => void
}

function OppCard({ game, o, tag, onWarp, testId }: { game: GameState; o: Opportunity; tag: string; onWarp: (id: string) => void; testId?: string }) {
  const b = game.buildings[o.buildingId]
  const d = getDistrict(b.districtId)
  return (
    <li className={`opp-card${o.score >= 100 ? ' hot' : ''}`} style={{ ['--dc' as string]: d.color }} data-testid={testId} data-building={b.friendId}>
      <div className="opp-main">
        <div className="opp-tag">{tag}</div>
        <div className="opp-title">{friendLabel(b.friendId)}</div>
        <div className="opp-need">
          <b>{formatRF(o.rfNeeded)} RF</b> until Tier {o.nextTier}
        </div>
        {o.lines.map((l) => (
          <div key={l} className="opp-line">
            “{l}”
          </div>
        ))}
      </div>
      <button type="button" className="warp-btn" onClick={() => onWarp(o.buildingId)} aria-label={`Warp to ${friendLabel(b.friendId)}`} data-testid={testId ? `${testId}-warp` : undefined}>
        WARP
      </button>
    </li>
  )
}

export function BuildBoardPanel({ game, districtId, onDistrict, onWarp, onClose }: Props) {
  const board = useMemo(() => buildBoard(game, districtId), [game, districtId])
  const hot = useMemo(() => cityHotlist(game, 3), [game])
  const cap = board.capital
  return (
    <section className="panel board-panel" aria-label="District Build Board" data-testid="build-board">
      <PanelHeader kicker="STRATEGIC NAVIGATION" title="Build Board" onClose={onClose} />
      <div className="district-tabs" role="tablist" aria-label="District">
        {DISTRICTS.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={d.id === districtId}
            className={`dtab${d.id === districtId ? ' on' : ''}`}
            style={{ ['--dc' as string]: d.color }}
            onClick={() => onDistrict(d.id)}
            title={d.title}
            aria-label={d.title}
            data-testid={`dtab-${d.id}`}
          >
            <DistrictEmblem id={d.id} size={24} />
          </button>
        ))}
      </div>

      {hot.length > 0 && (
        <div className="board-section">
          <h3 className="section-title">🔥 City Hotlist</h3>
          <ul className="opp-list">
            {hot.map((o, i) => (
              <OppCard key={o.buildingId} game={game} o={o} tag={`CITY-WIDE · ${districtName(game.buildings[o.buildingId].districtId).toUpperCase()}`} onWarp={onWarp} testId={`hot-${i}`} />
            ))}
          </ul>
        </div>
      )}

      <DistrictBanner
        id={districtId}
        testId="board-district"
        kicker={`DISTRICT ${getDistrict(districtId).sigil}`}
        aside={
          <div className="banner-aside">
            {game.capital.holder === districtId && <span className="crown-tag">★ CAPITAL</span>}
            <span className="muted small">Capital score {cap.districtScore}</span>
          </div>
        }
      />

      <div className="board-section">
        <h3 className="section-title">Highest Impact</h3>
        {board.impact.length === 0 ? (
          <p className="muted small">No single tier-up here swings a monument or the Capital right now.</p>
        ) : (
          <ul className="opp-list">
            {board.impact.map((o, i) => (
              <OppCard key={o.buildingId} game={game} o={o} tag="HIGHEST IMPACT" onWarp={onWarp} testId={`impact-${i}`} />
            ))}
          </ul>
        )}
      </div>

      <div className="board-section">
        <h3 className="section-title">Closest to Next Tier</h3>
        <ul className="opp-list compact">
          {board.closest.map((o, i) => (
            <OppCard key={o.buildingId} game={game} o={o} tag="CLOSEST" onWarp={onWarp} testId={`closest-${i}`} />
          ))}
        </ul>
      </div>

      <div className="board-section">
        <h3 className="section-title">Monument Opportunities</h3>
        <ul className="monument-rows">
          {board.monuments.map((m) => {
            const def = getMonument(m.monumentId)
            const statusText =
              m.status === 'held'
                ? `Held · ${m.districtCount} T${def.tier}+ buildings`
                : m.status === 'capture-next'
                  ? `One tier-up captures (${m.districtCount} vs ${m.holderCount})`
                  : m.status === 'tie-next'
                    ? `One tier-up ties (${m.districtCount} vs ${m.holderCount})`
                    : m.status === 'unclaimed'
                      ? 'Unclaimed'
                      : `Behind ${m.districtCount} vs ${m.holderCount}`
            return (
              <li key={m.monumentId} className={`mrow status-${m.status}`} data-testid={`mrow-${m.monumentId}`}>
                <div className="grow">
                  <div className="strong">
                    {def.name} <span className="muted small">T{def.tier}</span>
                  </div>
                  <div className="small">
                    <DistrictChip id={m.holder} small /> <span className="muted">{statusText}</span>
                  </div>
                  {m.candidate && m.status !== 'held' && (
                    <div className="small muted">
                      Best candidate {friendLabel(game.buildings[m.candidate.buildingId].friendId)} · {formatRF(m.candidate.rfNeeded)} RF to T{def.tier}
                    </div>
                  )}
                </div>
                {m.candidate && m.status !== 'held' && (
                  <button type="button" className="warp-btn sm" onClick={() => onWarp(m.candidate!.buildingId)}>
                    WARP
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </div>

      <div className="board-section">
        <h3 className="section-title">Capital {cap.mode === 'defense' ? 'Defense' : 'Offense'}</h3>
        <div className={`capital-card ${cap.mode}`}>
          {cap.mode === 'defense' ? (
            <div>
              The <b>{getDistrict(districtId).title}</b> holds the Capital by <b>{cap.gap}</b> points over {districtName(cap.rivalDistrict)}.
            </div>
          ) : (
            <div>
              The <b>{getDistrict(districtId).title}</b> trails Capital {districtName(cap.capital)} by <b>{Math.max(0, cap.gap)}</b> points ({cap.districtScore} vs {cap.rivalScore}). Ties keep the incumbent.
            </div>
          )}
          <ul className="cap-cands">
            {cap.candidates.map((c) => (
              <li key={c.buildingId}>
                <span className="grow">
                  {friendLabel(game.buildings[c.buildingId].friendId)} · {formatRF(c.rfNeeded)} RF → <b>+{c.points} pts</b>
                </span>
                <button type="button" className="warp-btn sm" onClick={() => onWarp(c.buildingId)}>
                  WARP
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
