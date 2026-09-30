import type { GameState, RadioEntry } from '../../game/types'
import type { RallyCall } from '../../game/dispatch'
import { getDistrict } from '../../config/districts'
import { PanelHeader } from '../common'

const RADIO_ICON: Record<RadioEntry['kind'], string> = {
  'tier-up': '▲',
  monument: '◆',
  capital: '★',
  crown: '♔',
  alert: '!',
  rally: '📣',
  patron: '✚',
  growth: '⌂',
  system: '📻',
}

const RALLY_ICON: Record<RallyCall['label'], string> = {
  MONUMENT: '◆',
  CAPITAL: '★',
  CROWN: '♔',
  BADGE: '✦',
  'NEAR TIER': '▲',
}

/** City Feed entry: history/flavour only, so it never carries a WARP call to action. */
export function RadioItem({ e }: { e: RadioEntry }) {
  const color = e.districtId ? getDistrict(e.districtId).color : '#9aa3b8'
  return (
    <li className={`radio-item kind-${e.kind}`} style={{ ['--dc' as string]: color }}>
      <span className="radio-icon" aria-hidden="true">
        {RADIO_ICON[e.kind]}
      </span>
      <div className="grow">
        <div className="radio-head">{e.headline}</div>
        <div className="radio-detail">{e.detail}</div>
      </div>
    </li>
  )
}

/** Rally Call: a current, actionable opportunity derived from live state. */
export function RallyCard({ call, onWarp, testId }: { call: RallyCall; onWarp: (id: string) => void; testId?: string }) {
  const color = getDistrict(call.districtId).color
  return (
    <li className={`radio-item rally-card rally-${call.label.toLowerCase().replace(' ', '-')}`} style={{ ['--dc' as string]: color }} data-testid={testId} data-kind={call.kind} data-building={call.friendId}>
      <span className="radio-icon" aria-hidden="true">
        {RALLY_ICON[call.label]}
      </span>
      <div className="grow">
        <div className="rally-tag">{call.label}</div>
        <div className="radio-head">{call.headline}</div>
        <div className="radio-detail">{call.reason}</div>
        {call.badges.length > 0 && (
          <div className="rally-badges" data-testid={testId ? `${testId}-badges` : undefined}>
            <span className="rally-earns">Earns</span>
            {call.badges.map((b) => (
              <span key={b} className="rally-chip">
                ✦ {b}
              </span>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="warp-btn sm" onClick={() => onWarp(call.buildingId)} aria-label={`Warp: ${call.headline}, ${call.rfNeeded} RF`} data-testid={testId ? `${testId}-warp` : undefined}>
        WARP · {call.rfNeeded.toLocaleString('en-US')} RF
      </button>
    </li>
  )
}

export function RadioPanel({ game, calls, onClose, onWarp, onRival }: { game: GameState; calls: RallyCall[]; onClose: () => void; onWarp: (id: string) => void; onRival: () => void }) {
  return (
    <section className="panel radio-panel" aria-label="District Radio" data-testid="radio">
      <PanelHeader kicker="GAME-GENERATED BROADCASTS · NO FREE-TEXT CHAT" title="District Radio" onClose={onClose} />
      <h3 className="section-title">📣 Rally Calls</h3>
      <p className="muted small radio-sub">Where your RF matters right now. Updates after every move.</p>
      {calls.length > 0 ? (
        <ul className="radio-list rally-list" data-testid="rally-calls">
          {calls.map((c, i) => (
            <RallyCard key={c.id} call={c} onWarp={onWarp} testId={`rally-${i}`} />
          ))}
        </ul>
      ) : (
        <p className="muted small" data-testid="rally-calls-empty">
          No urgent moves right now. The Build Board lists every opportunity.
        </p>
      )}
      <h3 className="section-title">City Feed</h3>
      <div className="rival-box">
        <div className="small muted">Rival districts are simulated. Advance the city to watch them counter-attack using the same economy rules.</div>
        <button type="button" className="btn sm" onClick={onRival} data-testid="rival-turn">
          ⏭ Simulate rival move
        </button>
      </div>
      <ul className="radio-list" data-testid="radio-list">
        {game.radio.map((e) => (
          <RadioItem key={e.id} e={e} />
        ))}
      </ul>
    </section>
  )
}
