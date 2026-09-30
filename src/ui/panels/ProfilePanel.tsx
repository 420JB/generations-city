import { useMemo } from 'react'
import { BADGES, BADGE_LEVEL_NAMES } from '../../config/badges'
import { getDistrict } from '../../config/districts'
import { DEMO_PLAYER_ID, friendLabel, IDENTITY_SOURCE } from '../../config/identity'
import { MONUMENTS } from '../../config/monuments'
import { profileSummary } from '../../game/badges'
import { formatRF } from '../../game/economy'
import { buildingLabel, districtName, handleOf } from '../../game/narration'
import type { GameState, HistoryEntry } from '../../game/types'
import { Avatar, DistrictChip, DistrictEmblem, PanelHeader } from '../common'
import { homeDistrict, ownedFriends } from '../../game/season'

function Reigns<T>({ title, entries, label, game }: { title: string; entries: HistoryEntry<T>[]; label: (t: T) => string; game: GameState }) {
  return (
    <div className="history-block">
      <div className="kicker">{title}</div>
      <ol className="history">
        {[...entries].reverse().map((h, i) => (
          <li key={i}>
            <b>{label(h.holder)}</b>
            <span className="muted small">
              {' '}
              {h.fromClock === 0 ? 'founding' : `from action #${h.fromClock}`}
              {h.toClock === null ? ' · current' : ` → #${h.toClock}`}
              {h.byUserId ? ` · by ${handleOf(game, h.byUserId)}` : ''}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

export function ProfilePanel({ game, onClose, onWarp }: { game: GameState; onClose: () => void; onWarp: (id: string) => void }) {
  const me = game.users[DEMO_PLAYER_ID]
  const summary = useMemo(() => profileSummary(game, DEMO_PLAYER_ID), [game])
  const earned = new Map((game.badges[DEMO_PLAYER_ID] ?? []).map((b) => [b.badgeId, b]))
  const rep = game.season.representatives[DEMO_PLAYER_ID]
  const seasonHome = homeDistrict(game, DEMO_PLAYER_ID)
  const home = seasonHome
  const owned = ownedFriends(game, DEMO_PLAYER_ID)
  const titles: string[] = []
  if (home && game.capital.holder === home) titles.push(`Citizen of the Capital (${getDistrict(home).title})`)
  if (game.crown.holder && game.buildings[game.crown.holder].ownerId === DEMO_PLAYER_ID) titles.push('Holder of the City Crown')
  for (const m of MONUMENTS) if (home && game.monuments[m.id].holder === home) titles.push(`The ${getDistrict(home).title} holds ${m.name}`)

  return (
    <section className="panel profile-panel" aria-label="Player profile" data-testid="profile">
      <PanelHeader kicker={`${IDENTITY_SOURCE.toUpperCase()} IDENTITY · NOT A REAL NFT`} title={`@${me.handle}`} onClose={onClose} />
      <div className="owner-row">
        <Avatar user={me} size={44} />
        <div>
          <div className="strong">{friendLabel(me.friendId)}</div>
          <div className="muted small">Season Home District: {seasonHome ? getDistrict(seasonHome).title : '—'}</div>
        </div>
      </div>
      <div className="season-card" data-testid="season-card" data-district={seasonHome ?? ''} style={seasonHome ? { ['--dc' as string]: getDistrict(seasonHome).color } : undefined}>
        {seasonHome && <img className="season-banner-art" src={getDistrict(seasonHome).art.secondaryTransparent} alt="" aria-hidden="true" decoding="async" />}
        <div className="row-between">
          <div className="kicker">
            {game.season.name.toUpperCase()} · ALLEGIANCE
          </div>
          <span className="lock" data-testid="allegiance-locked">
            🔒 LOCKED
          </span>
        </div>
        {seasonHome && (
          <div className="season-home">
            <DistrictEmblem id={seasonHome} size={52} />
            <div>
              <div className="kicker">HOME DISTRICT</div>
              <div className="season-home-name" data-testid="season-home" data-district={seasonHome} data-family={getDistrict(seasonHome).familyKey}>
                {getDistrict(seasonHome).name}
              </div>
            </div>
          </div>
        )}
        <p className="small" style={{ margin: '6px 0' }}>
          Representative Friend: <b data-testid="representative">{rep ? friendLabel(game.buildings[rep.buildingId].friendId) : 'Not chosen'}</b> → Home District{' '}
          <b>{seasonHome ? getDistrict(seasonHome).title : '—'}</b>
        </p>
        <ul className="season-friends">
          {owned.map((b) => (
            <li key={b.id}>
              <DistrictChip id={b.districtId} small />
              <span className="grow">{friendLabel(b.friendId)}</span>
              {rep?.buildingId === b.id ? <span className="rep-tag">REPRESENTATIVE</span> : <span className="muted small">builds for {getDistrict(b.districtId).name}</span>}
            </li>
          ))}
        </ul>
        <p className="muted small" style={{ margin: 0 }}>
          Each season you choose one Friend you own as your Representative. It sets your Home District, which is locked until the season ends, so there is no switching to whichever district is winning. You can still build every Friend you own; building outside your Home District strengthens that district. Choose a new Representative when the next season starts.
        </p>
        <button type="button" className="btn sm" disabled style={{ marginTop: 8 }} title="Available at the start of the next season" data-testid="change-representative">
          Change Representative · next season
        </button>
      </div>
      <dl className="stat-grid">
        <div>
          <dt>RF personally built</dt>
          <dd data-testid="stat-owner-rf">{formatRF(summary.ownerRF)}</dd>
        </div>
        <div>
          <dt>RF to others</dt>
          <dd data-testid="stat-contributed">{formatRF(summary.contributedRF)}</dd>
        </div>
        <div>
          <dt>Buildings supported</dt>
          <dd>{summary.buildingsSupported}</dd>
        </div>
        <div>
          <dt>Tier-ups caused</dt>
          <dd data-testid="stat-tierups">{summary.tierUpsCaused}</dd>
        </div>
        <div>
          <dt>Monument captures</dt>
          <dd data-testid="stat-captures">{summary.monumentCaptures}</dd>
        </div>
        <div>
          <dt>Capital captures</dt>
          <dd>{summary.capitalCaptures}</dd>
        </div>
      </dl>
      {titles.length > 0 && (
        <div className="titles">
          <div className="kicker">LIVE TITLES · TEMPORARY</div>
          {titles.map((t) => (
            <div key={t} className="title-pill">
              {t}
            </div>
          ))}
        </div>
      )}
      <div className="kicker">PERMANENT BADGES</div>
      <ul className="badge-grid">
        {BADGES.map((def) => {
          const a = earned.get(def.id)
          const levelName = a && def.thresholds.length > 1 ? BADGE_LEVEL_NAMES[a.level - 1] : null
          return (
            <li key={def.id} className={`badge ${a ? 'earned' : 'locked'} ${levelName ? `lvl-${levelName.toLowerCase()}` : ''}`} title={def.description} data-testid={`badge-${def.id}`} data-earned={a ? 'true' : 'false'}>
              <span className="badge-glyph">{def.glyph}</span>
              <span className="badge-name">{def.name}</span>
              {levelName && <span className="badge-level">{levelName}</span>}
            </li>
          )
        })}
      </ul>
      <div className="kicker">YOUR PROPERTY</div>
      <ul className="owned">
        {summary.ownedBuildingIds.map((id) => (
          <li key={id}>
            <span className="grow">{buildingLabel(game, id)}</span>
            <button type="button" className="warp-btn sm" onClick={() => onWarp(id)}>
              WARP
            </button>
          </li>
        ))}
      </ul>
      <Reigns title="CAPITAL HISTORY" entries={game.capitalHistory} label={(d) => districtName(d)} game={game} />
      <Reigns title="CROWN HISTORY" entries={game.crownHistory} label={(b) => buildingLabel(game, b)} game={game} />
      {MONUMENTS.filter((m) => game.monumentHistory[m.id].length > 0).map((m) => (
        <Reigns key={m.id} title={m.name.toUpperCase()} entries={game.monumentHistory[m.id]} label={(d) => districtName(d)} game={game} />
      ))}
    </section>
  )
}
