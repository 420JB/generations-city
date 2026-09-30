import type { GameState, RadioEntry } from '../../game/types'
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

export function RadioItem({ e, onWarp }: { e: RadioEntry; onWarp: (id: string) => void }) {
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
      {e.buildingId && (
        <button type="button" className="warp-btn sm" onClick={() => onWarp(e.buildingId!)} aria-label={`Warp: ${e.headline}`}>
          WARP
        </button>
      )}
    </li>
  )
}

export function RadioPanel({ game, onClose, onWarp, onRival }: { game: GameState; onClose: () => void; onWarp: (id: string) => void; onRival: () => void }) {
  return (
    <section className="panel radio-panel" aria-label="District Radio" data-testid="radio">
      <PanelHeader kicker="GAME-GENERATED BROADCASTS · NO FREE-TEXT CHAT" title="District Radio" onClose={onClose} />
      <div className="rival-box">
        <div className="small muted">Rival districts are simulated. Advance the city to watch them counter-attack using the same economy rules.</div>
        <button type="button" className="btn sm" onClick={onRival} data-testid="rival-turn">
          ⏭ Simulate rival move
        </button>
      </div>
      <ul className="radio-list" data-testid="radio-list">
        {game.radio.map((e) => (
          <RadioItem key={e.id} e={e} onWarp={onWarp} />
        ))}
      </ul>
    </section>
  )
}
