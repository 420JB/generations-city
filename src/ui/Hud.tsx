import { useState, type ReactNode } from 'react'
import { getDistrict } from '../config/districts'
import { friendLabel } from '../config/identity'
import { MONUMENTS } from '../config/monuments'
import { formatRF, heightMeters, totalBuilt } from '../game/economy'
import type { GameState } from '../game/types'
import { Avatar, DistrictEmblem } from './common'
import { homeDistrict } from '../game/season'
import type { PanelKind } from './App'

interface Props {
  game: GameState
  /** null = an anonymous visitor: no player chip, no wallet, no profile. */
  viewerId: string | null
  /** What the visitor chip says in place of a wallet. */
  visitorNote: string
  /** Replaces the plain visitor chip (a server-backed city puts wallet sign-in here). */
  visitor?: ReactNode
  panel: PanelKind | null
  onPanel: (p: PanelKind) => void
  onWarp: (id: string) => void
  guideOpen: boolean
  onSearch: (friendId: number) => void
  /** Local-demo-only controls. null hides them. */
  demo: { onHelp: () => void; onFaucet: () => void; onReset: () => void } | null
}

export function Hud({ game, viewerId, visitorNote, visitor, panel, onPanel, onWarp, guideOpen, onSearch, demo }: Props) {
  const [query, setQuery] = useState('')
  const me = viewerId ? game.users[viewerId] : undefined
  const home = viewerId ? homeDistrict(game, viewerId) : null
  const cap = game.capital.holder ? getDistrict(game.capital.holder) : null
  const crownB = game.crown.holder ? game.buildings[game.crown.holder] : null
  const nav: [PanelKind, string, string][] = [
    ['board', 'Build Board', '▦'],
    ['standings', 'Districts', '★'],
    ['profile', 'Profile', '◉'],
    ['radio', 'Radio', '📻'],
  ]
  const shownNav = nav.filter(([k]) => k !== 'profile' || !!me)
  return (
    <header className="hud">
      <div className="hud-brand">
        <div className="logo" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <h1>RARE CITY</h1>
          <p>Build your Friend. Build your district. Build the city.</p>
        </div>
      </div>

      <div className="hud-status">
        <button type="button" className="status-pill capital" style={{ ['--dc' as string]: cap?.color ?? '#888' }} onClick={() => onPanel('standings')} data-testid="hud-capital" data-capital={game.capital.holder ?? ''} aria-label={`Capital: ${cap?.title ?? 'Unclaimed'}`}>
          <span className="pill-k">CAPITAL</span>
          <span className="pill-v">
            {game.capital.holder ? <DistrictEmblem id={game.capital.holder} size={20} /> : <i className="dot" />} {cap?.name ?? 'Unclaimed'}
          </span>
        </button>
        <button type="button" className="status-pill crown" onClick={() => crownB && onWarp(crownB.id)} data-testid="hud-crown" data-crown={crownB?.friendId ?? ''}>
          <span className="pill-k">♔ CROWN</span>
          <span className="pill-v">{crownB ? `#${crownB.friendId} · ${heightMeters(totalBuilt(crownB))} m` : '—'}</span>
        </button>
        <form
          className="status-pill search-pill"
          role="search"
          onSubmit={(e) => {
            e.preventDefault()
            const n = Number(query.replace(/[^0-9]/g, ''))
            if (n > 0) onSearch(n)
          }}
        >
          <label className="pill-k" htmlFor="friend-search">
            FIND A FRIEND
          </label>
          <span className="pill-v">
            <span aria-hidden="true">#</span>
            <input id="friend-search" inputMode="numeric" placeholder="812" value={query} onChange={(e) => setQuery(e.target.value.replace(/[^0-9]/g, '').slice(0, 7))} data-testid="friend-search" />
            <button type="submit" className="search-go" aria-label="Warp to Friend" data-testid="friend-search-go">
              WARP
            </button>
          </span>
        </form>
        <div className="status-pill monuments" aria-label="Monument holders">
          <span className="pill-k">MONUMENTS</span>
          <span className="pill-v mon-dots">
            {MONUMENTS.map((m) => {
              const h = game.monuments[m.id].holder
              return (
                <i key={m.id} title={`${m.name}: ${h ? getDistrict(h).name : 'Unclaimed'}`} style={{ background: h ? getDistrict(h).color : 'transparent' }} className={h ? '' : 'empty'} data-testid={`hud-mon-${m.id}`} data-holder={h ?? ''}>
                  {m.tier}
                </i>
              )
            })}
          </span>
        </div>
      </div>

      <div className="hud-right">
        {me && viewerId ? (
          <div className="player-chip" title={`${friendLabel(me.friendId)} — demo identity`}>
            <Avatar user={me} size={30} />
            <div>
              <div className="player-name">@{me.handle}</div>
              <div className="wallet">
                <b data-testid="wallet">{formatRF(game.wallets[viewerId] ?? 0)}</b> <span className="sim-tag">SIMULATED RF</span>
              </div>
              <button type="button" className="season-line link-btn" onClick={() => onPanel('profile')} data-testid="hud-season" title="Season allegiance: locked until next season">
                {game.season.name.toUpperCase()} · Home District {home && <DistrictEmblem id={home} size={14} />} <b data-district={home ?? ''}>{home ? getDistrict(home).name : 'not chosen'}</b> 🔒
              </button>
            </div>
            {demo && (
              <button type="button" className="icon-btn sm" onClick={demo.onFaucet} title="Claim 10,000 simulated demo RF" aria-label="Claim simulated demo RF">
                ＋
              </button>
            )}
          </div>
        ) : visitor ? (
          visitor
        ) : (
          <div className="player-chip" title="You are browsing Rare City as a visitor" data-testid="viewer-anonymous">
            <div>
              <div className="player-name">Visitor</div>
              <div className="wallet">
                <span className="sim-tag">{visitorNote}</span>
              </div>
            </div>
          </div>
        )}
        <nav className="hud-nav" aria-label="Game panels">
          {shownNav.map(([k, label, icon]) => (
            <button key={k} type="button" className={`nav-btn${k === 'board' ? ' board-nav' : ''}${panel === k ? ' on' : ''}`} aria-label={label} onClick={() => onPanel(k)} aria-pressed={panel === k} data-testid={`nav-${k}`}>
              <span aria-hidden="true">{icon}</span>
              <span className="nav-label">{label}</span>
            </button>
          ))}
          {demo && (
            <>
              <button type="button" className={`nav-btn help${guideOpen ? ' on' : ''}`} onClick={demo.onHelp} aria-pressed={guideOpen} aria-label="Demo guide" title="Demo guide" data-testid="nav-help">
                <span aria-hidden="true">?</span>
                <span className="nav-label">Guide</span>
              </button>
              <button type="button" className="nav-btn reset" onClick={demo.onReset} data-testid="reset-demo">
                <span aria-hidden="true">↺</span>
                <span className="nav-label">Reset Demo</span>
              </button>
            </>
          )}
        </nav>
      </div>
    </header>
  )
}
