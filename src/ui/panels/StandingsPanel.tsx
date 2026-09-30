import { useMemo } from 'react'
import { CAPITAL_WEIGHTS, MAX_TIER } from '../../config/economy'
import { DISTRICTS, getDistrict, type DistrictId } from '../../config/districts'
import { districtGrowth, wardName } from '../../game/allocation'
import { seasonSignals } from '../../game/season'
import { friendLabel } from '../../config/identity'
import { MONUMENTS } from '../../config/monuments'
import { districtStandings } from '../../game/competition'
import { formatRF, heightMeters, totalBuilt } from '../../game/economy'
import { handleOf } from '../../game/narration'
import type { GameState } from '../../game/types'
import { DistrictChip, DistrictEmblem, PanelHeader } from '../common'
import { FAIRNESS_PRINCIPLE, FAMILIES, FAMILY_KEYS } from '../../config/districtIdentity'

const RARER_NAMES = FAMILY_KEYS.filter((k) => FAMILIES[k].supplyClass === 'rarer').map((k) => FAMILIES[k].name)
const RARER_LIST = `${RARER_NAMES.slice(0, -1).join(', ')} and ${RARER_NAMES[RARER_NAMES.length - 1]}`

export function StandingsPanel({ game, onClose, onWarp, onJoin }: { game: GameState; onClose: () => void; onWarp: (id: string) => void; onJoin: (d: DistrictId) => void }) {
  const rows = useMemo(() => districtStandings(Object.values(game.buildings), game.capital.holder), [game.buildings, game.capital.holder])
  const tallest = useMemo(
    () => Object.values(game.buildings).sort((a, b) => totalBuilt(b) - totalBuilt(a)).slice(0, 4),
    [game.buildings],
  )
  const top = rows[0]?.score || 1
  const signals = useMemo(() => seasonSignals(game), [game])
  return (
    <section className="panel standings-panel" aria-label="District standings" data-testid="standings">
      <PanelHeader kicker="THE RACE FOR CITY HALL" title="Districts & Monuments" onClose={onClose} />
      <h3 className="section-title">Capital Ranking</h3>
      <p className="muted small">
        Score = Σ cumulative tier counts × weights ({Object.entries(CAPITAL_WEIGHTS).map(([t, w]) => `T${t}×${w}`).join(' · ')}). Prestige only — no multipliers.
      </p>
      <ol className="standings">
        {rows.map((r) => {
          const d = getDistrict(r.districtId)
          return (
            <li key={r.districtId} className={r.districtId === game.capital.holder ? 'is-capital' : ''} style={{ ['--dc' as string]: d.color }} data-testid={`standing-${r.districtId}`}>
              <span className="rank">{r.rank}</span>
              <div className="grow">
                <div className="row-between">
                  <span className="strong row-inline">
                    <DistrictEmblem id={r.districtId} size={18} /> {d.name} {r.districtId === game.capital.holder && <span className="crown-tag">★ CAPITAL</span>}
                  </span>
                  <b>{r.score}</b>
                </div>
                <div className="score-bar">
                  <div style={{ width: `${(r.score / top) * 100}%`, background: d.color }} />
                </div>
                <div className="tier-counts small muted">
                  {Array.from({ length: MAX_TIER }, (_, i) => (
                    <span key={i}>
                      T{i + 1}+ {r.counts[i + 1]}
                    </span>
                  ))}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      <h3 className="section-title">Monuments</h3>
      <ul className="monument-rows">
        {MONUMENTS.map((m) => {
          const h = game.monuments[m.id].holder
          const hist = game.monumentHistory[m.id]
          return (
            <li key={m.id} className="mrow" data-testid={`monument-holder-${m.id}`} data-holder={h ?? ''}>
              <div className="grow">
                <div className="strong">{m.name}</div>
                <div className="small muted">{m.blurb} · held {hist.length} reign{hist.length === 1 ? '' : 's'}</div>
              </div>
              <DistrictChip id={h} small />
            </li>
          )
        })}
      </ul>
      <h3 className="section-title">{game.season.name} · Seasonal signals (preview)</h3>
      <p className="muted small">
        Permanent buildings persist forever; seasonal competition resets. Family supply is very uneven ({RARER_LIST} are far rarer than the other {FAMILY_KEYS.length - RARER_NAMES.length}), so production scoring will normalise against each family's <i>declared, active seasonal participants</i>, not raw NFT supply or building count (share active, RF per active representative with diminishing returns, tier-ups, unique builders…). <b>Not used by the current demo scoring</b>, which stays the simplified monument + Capital model above.
      </p>
      <p className="fairness-note small" data-testid="fairness-principle">
        “{FAIRNESS_PRINCIPLE}”
      </p>
      <table className="signals" data-testid="season-signals">
        <thead>
          <tr>
            <th>District</th>
            <th>Active</th>
            <th>RF</th>
            <th>Tier-ups</th>
            <th>Builders</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((x) => (
            <tr key={x.districtId}>
              <td>
                {getDistrict(x.districtId).name}
                {getDistrict(x.districtId).supplyClass === 'rarer' && <span className="rarer-tag" title="Lower-supply family (approximate planning input)">RARER</span>}
              </td>
              <td>{Math.round(x.activeShare * 100)}%</td>
              <td>{formatRF(x.seasonRF)}</td>
              <td>{x.tierUps}</td>
              <td>{x.builders}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="section-title">City Growth · Wards</h3>
      <p className="muted small">
        Properties exist only for Friends active in the city. When every plot in a district is taken, the next ward opens farther out, with no ward limit. Ward I is the Founding Ward, which is a prestige title only. Simulate a Friend joining (demo identity) to watch the city grow.
      </p>
      <ul className="growth-list">
        {DISTRICTS.map((d) => {
          const g = districtGrowth(game, d.id)
          return (
            <li key={d.id} style={{ ['--dc' as string]: d.color }} data-testid={`growth-${d.id}`} data-wards={g.openWards}>
              <span className="grow">
                <DistrictEmblem id={d.id} size={16} /> <b>{d.name}</b>
                <span className="muted small">
                  {' '}
                  · {g.wards.map((w) => `${wardName(w.ward).replace('Ward ', '')} ${w.population}/${w.capacity}`).join(' · ')}
                </span>
              </span>
              <button type="button" className="btn sm" onClick={() => onJoin(d.id)} data-testid={`join-${d.id}`}>
                + Friend joins
              </button>
            </li>
          )
        })}
      </ul>
      <h3 className="section-title">Crown Race · Tallest Buildings</h3>
      <ol className="crown-race">
        {tallest.map((b, i) => (
          <li key={b.id} className={game.crown.holder === b.id ? 'is-crown' : ''}>
            <span className="rank">{game.crown.holder === b.id ? '♔' : i + 1}</span>
            <span className="grow">
              {friendLabel(b.friendId)} <span className="muted small">· {handleOf(game, b.ownerId)} · {getDistrict(b.districtId).name}</span>
            </span>
            <span className="small">
              <b>{heightMeters(totalBuilt(b))} m</b> <span className="muted">({formatRF(totalBuilt(b))})</span>
            </span>
            <button type="button" className="warp-btn sm" onClick={() => onWarp(b.id)}>
              WARP
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
