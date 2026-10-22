import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { heightMeters, totalBuilt } from '../../game/economy'
import { CityView } from '../../ui/city/CityView'
import { plotWorldIn } from '../../ui/city/districtGeometry'
import { sceneDistrict, type ScenePlotCandidate } from '../../ui/city/scene'
import { SceneDistrictEmblem } from '../../ui/common'
import { mayAct, previewClaimAccess, type PreviewMember } from '../core/eligibility'
import { districtPlots, loadBrandCity, type LoadedBrandCity } from '../load'
import type { SampleBrand } from '../samples'
import type { WorldPoint } from '../../game/world'
import { BuildingPreviewPanel, DistrictPanel, PlotPanel } from './panels'
import { RehearsalPlotPanel, type PlacementRehearsal, type StoredProperty } from './rehearsal'

type Panel = { kind: 'district'; id: string } | { kind: 'building'; id: string } | null

/** A plot the engine offers, as the renderer's placement layer takes it. */
export type PreviewCandidate = ScenePlotCandidate & { plotId: string }

/** What the bar above a city may ask of it (the Proofy Play page's claim card). */
export interface CityControls {
  /** The rehearsal's plot choice is open: the player is claiming, not browsing. */
  claiming: boolean
  /** Open the plot choice in the player's assigned district (in a city whose every district is restricted, to select the NFT first), as the player themselves. */
  continueClaim: () => void
  /** Warp to a building and open its panel. */
  viewProperty: (buildingId: string) => void
}

export interface Placement {
  districtId: string
  candidates: PreviewCandidate[]
  selected: PreviewCandidate | null
}

interface Loaded {
  brand: SampleBrand
  city: LoadedBrandCity
}

/**
 * LOCAL PREVIEW of the configurable city: the standard Rare City renderer (CityView, unchanged
 * art, camera and interaction) drawing simulated brand cities. Nothing here claims, verifies,
 * spends or persists anything.
 */
export function PreviewApp({ brands }: { brands: readonly SampleBrand[] }) {
  const loaded = useMemo(
    () =>
      brands.map((brand): Loaded => {
        const r = loadBrandCity(brand.config, brand.city)
        if (!r.ok) throw new Error(`Sample brand is invalid: ${r.problems.map((p) => `${p.path} ${p.detail}`).join('; ')}`)
        return { brand, city: r.city }
      }),
    [brands],
  )
  const [brandIndex, setBrandIndex] = useState(0)
  const current = loaded[brandIndex]
  const chips = loaded.map((l) => ({ key: l.city.scene.key, name: l.city.config.cityName, districts: l.city.config.districts.length }))
  // Everything below belongs to one brand. Keying by the city remounts it on a switch, so no
  // selection, placement, camera or viewer can leak from one brand into another.
  return (
    <BrandCityPreview
      key={current.city.scene.key}
      city={current.city}
      members={current.brand.members}
      bar={
        <div className="preview-bar" role="region" aria-label="Preview controls" data-testid="preview-bar">
          <span className="preview-flag">LOCAL PREVIEW</span>
          <span className="preview-note">Simulated brands, members, roles and progress. Nothing is claimed, verified or spent.</span>
          <div className="preview-brands" role="group" aria-label="Sample brand">
            {chips.map((b, i) => (
              <button key={b.key} type="button" className={`chip${i === brandIndex ? ' on' : ''}`} aria-pressed={i === brandIndex} onClick={() => setBrandIndex(i)} data-testid={`brand-${i}`}>
                {b.name} · {b.districts}
              </button>
            ))}
          </div>
        </div>
      }
    />
  )
}

/** The plots the engine offers in a district now, as the placement layer takes them. */
const candidatesIn = (city: LoadedBrandCity, districtId: string): PreviewCandidate[] =>
  districtPlots(city, districtId).map((c) => ({ districtId: c.districtKey, ward: c.ward, plot: c.plot, newWard: c.newWard, plotId: c.plotId }))

/**
 * ONE CONFIGURED CITY on the standard renderer, with the standard HUD and panels. Shared by
 * the sample preview and the Proofy Play launch page, so both draw exactly the same city for
 * the same data; only the bar above (`bar`) says where the data came from.
 *
 * The Play page may also pass `stored` (a building's record as the city stores it, for its panel)
 * and, in a local rehearsal only, `rehearsal`: the player may then place a test NFT on a plot they
 * choose IN THE DISTRICT THE SERVER ASSIGNED THEM (their district ticket): placement always follows
 * the ticket's district, moves when the server reassigns it (an explicit rule for the selected NFT),
 * and closes when the ticket ends. The city it is given may change (the page reads it again after a
 * placement): plot candidates always follow the city on the page, and a selected plot that is no
 * longer free is dropped.
 */
export function BrandCityPreview({
  city,
  members,
  bar,
  stored,
  rehearsal,
}: {
  city: LoadedBrandCity
  members: readonly (PreviewMember | null)[]
  /** Above the city: where its data came from. A function is given the city's controls. */
  bar: ReactNode | ((controls: CityControls) => ReactNode)
  stored?: (buildingId: string) => StoredProperty | null
  rehearsal?: PlacementRehearsal | null
}) {
  const { scene, state, config } = city
  const [memberIndex, setMemberIndex] = useState(1)
  const member: PreviewMember | null = members[memberIndex] ?? null
  const [panel, setPanel] = useState<Panel>(null)
  // A plot is chosen on one geometry. A plot id names other ground on another, so a city redrawn on other districts
  // keeps no selected plot (and no placement at all in a district that is gone): the player chooses again.
  const geometry = city.world.layout.geometryFingerprint
  // In a rehearsal a plot is also chosen under one district ticket: a ticket the server reissued or replaced keeps none.
  const [placing, setPlacing] = useState<{ districtId: string; selected: PreviewCandidate | null; geometry: string; ticket: string | null } | null>(null)
  /** The player places for real (on the local server) only as themselves, never as a simulated viewer. */
  const rehearsing = rehearsal && member?.kind === 'player' ? rehearsal : null
  /** In a rehearsal, the district the server assigned the player (their ticket): the only one they place in, while they hold it. */
  const assigned = rehearsing?.ticket?.districtKey ?? null
  // Without a ticket only in a city whose every district is restricted: the player selects the NFT first, wherever they are.
  const ticketId = rehearsing?.ticket?.id ?? null
  const placingAt =
    placing && rehearsing
      ? assigned
        ? { ...placing, districtId: assigned, selected: placing.districtId === assigned && placing.ticket === ticketId ? placing.selected : null }
        : rehearsing.awaitingAsset
          ? placing
          : null
      : placing
  const placingNow = placingAt && (placingAt.geometry === geometry || city.world.districts.some((d) => d.key === placingAt.districtId)) ? placingAt : null
  const placingIn = placingNow?.districtId ?? null
  const candidates = useMemo(() => (placingIn ? candidatesIn(city, placingIn) : []), [city, placingIn])
  const placement: Placement | null = placingNow && {
    districtId: placingNow.districtId,
    candidates,
    selected: placingNow.geometry === geometry && placingNow.selected && candidates.some((c) => c.plotId === placingNow.selected!.plotId) ? placingNow.selected : null,
  }
  const [focus, setFocus] = useState<{ buildingId: string; seq: number } | null>(null)
  const [frame, setFrame] = useState<{ seq: number; points: WorldPoint[] } | null>(null)
  const [homeSeq, setHomeSeq] = useState(0)
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null)

  const say = useCallback((text: string) => setNotice({ id: Date.now(), text }), [])
  const selectedId = panel?.kind === 'building' ? panel.id : null

  const select = useCallback((id: string | null) => {
    setPanel(id ? { kind: 'building', id } : null)
  }, [])

  const openDistrict = useCallback((id: string) => {
    setPlacing(null)
    setPanel({ kind: 'district', id })
  }, [])

  const warp = useCallback((buildingId: string) => {
    setPanel({ kind: 'building', id: buildingId })
    setFocus((f) => ({ buildingId, seq: (f?.seq ?? 0) + 1 }))
  }, [])

  /** Re-checked at every action, not only by the buttons' state (the server will check again for real). */
  const allowedIn = (districtId: string) => mayAct(previewClaimAccess(config.districts.find((x) => x.key === districtId)?.gate ?? null, member))

  /** Open the plot choice in a district and frame its free plots. In a rehearsal the server's ticket decides, not the preview's viewers. */
  const placeAt = (districtId: string, rehearsed = !!rehearsing) => {
    if (!scene.districts.some((x) => x.id === districtId) || (!rehearsed && !allowedIn(districtId))) return
    const d = sceneDistrict(scene, districtId)
    const offered = candidatesIn(city, districtId)
    setPlacing({ districtId, selected: null, geometry, ticket: ticketId })
    setPanel(null)
    setFrame((f) => ({ seq: (f?.seq ?? 0) + 1, points: offered.map((c) => plotWorldIn(d, c.ward, c.plot)) }))
  }

  /** A rehearsal places only in the assigned district, whichever district the player was looking at. */
  const startPlacement = (requested: string) => {
    const districtId = rehearsing ? (assigned ?? (rehearsing.awaitingAsset ? requested : null)) : requested
    if (districtId) placeAt(districtId)
  }

  const playerIndex = members.findIndex((m) => m?.kind === 'player')
  const controls: CityControls = {
    claiming: placement !== null && !!rehearsing,
    continueClaim: () => {
      if (!rehearsal || playerIndex < 0) return
      const districtId = rehearsal.ticket?.districtKey ?? (rehearsal.awaitingAsset ? (panel?.kind === 'district' ? panel.id : scene.districts[0].id) : null)
      if (!districtId) return
      // Claims are made as the player themselves, never as a simulated viewer.
      setMemberIndex(playerIndex)
      placeAt(districtId, true)
    },
    viewProperty: (buildingId) => state.buildings[buildingId] && warp(buildingId),
  }

  const capital = state.capital.holder ? sceneDistrict(scene, state.capital.holder) : null
  const crown = state.crown.holder ? state.buildings[state.crown.holder] : null
  const drawer =
    placement !== null && rehearsing ? (
      <RehearsalPlotPanel
        // One panel for the whole claim: a district the server reassigns (a rule for the selected NFT) keeps the selection.
        key="rehearsal-placement"
        city={city}
        placement={placement}
        rehearsal={rehearsing}
        onCancel={() => {
          setPlacing(null)
          setPanel({ kind: 'district', id: placement.districtId })
        }}
        onAssigned={(ticket) => {
          // The server assigned another district for the selected NFT (an explicit rule): the camera goes there.
          if (ticket && ticket.districtKey !== placing?.districtId) placeAt(ticket.districtKey)
        }}
        onLeave={() => {
          setPlacing(null)
          setPanel({ kind: 'district', id: placement.districtId })
          say('You left the claim flow: your district was released for the next player. Nothing was placed.')
        }}
        onActivated={(result, nft) => {
          setPlacing(null)
          warp(result.buildingId)
          say(`${result.fresh ? 'Property activated' : 'Already your property'}: ${nft.collectionName} #${nft.tokenId} · city sequence ${result.sequence}. Local rehearsal, test NFT.`)
        }}
      />
    ) : placement !== null ? (
      <PlotPanel
        city={city}
        member={member}
        placement={placement}
        onCancel={() => {
          setPlacing(null)
          setPanel({ kind: 'district', id: placement.districtId })
        }}
        onClaim={() => allowedIn(placement.districtId) && say('Preview only: nothing was claimed. A live claim will be decided by the server (NFT ownership and, where set, the Proofy rule).')}
      />
    ) : panel?.kind === 'district' ? (
      <DistrictPanel
        key={panel.id}
        city={city}
        districtId={panel.id}
        member={member}
        rehearsal={!!rehearsing}
        assigned={rehearsing ? assigned : undefined}
        selectAsset={!!rehearsing && !assigned && rehearsing.awaitingAsset && rehearsing.nfts.length > 0}
        onEnter={
          rehearsing && !assigned && rehearsing.nfts.length > 0
            ? () =>
                void rehearsing.enter().then((r) => {
                  if (!r.ok) say(r.message)
                  else if (r.ticket) say(`Your district: ${sceneDistrict(scene, r.ticket.districtKey).title}, assigned by the server. Choose your plot in it.`)
                })
            : undefined
        }
        onDistrict={openDistrict}
        onWarp={warp}
        onChoosePlot={() => startPlacement(panel.id)}
        onClose={() => setPanel(null)}
      />
    ) : panel?.kind === 'building' && state.buildings[panel.id] ? (
      <BuildingPreviewPanel
        key={panel.id}
        city={city}
        buildingId={panel.id}
        member={member}
        stored={stored?.(panel.id) ?? null}
        onDistrict={openDistrict}
        onClose={() => setPanel(null)}
        onBuild={() => allowedIn(state.buildings[panel.id].districtId) && say('Preview only: nothing was built or spent. Building will use the shared Proofy community points, which are not connected yet.')}
      />
    ) : null

  return (
    <div className={`app preview-app${placement ? ' has-placement' : ''}${drawer ? ' has-drawer' : ''}`} data-testid="preview-app" data-brand={scene.key} data-districts={scene.districts.length}>
      <div className="sky" aria-hidden="true">
        <div className="stars" />
        <div className="stars stars-2" />
        <div className="moon" />
      </div>
      <CityView
        scene={scene}
        game={state}
        viewerId={null}
        selectedId={selectedId}
        onSelect={select}
        onSelectDistrict={openDistrict}
        placement={placement ? { candidates: placement.candidates, selected: placement.selected } : null}
        onPickPlot={(c) => setPlacing((p) => (p ? { ...p, selected: c, geometry, ticket: ticketId } : p))}
        frame={frame}
        focus={focus}
        fx={NO_FX}
        transfers={NO_TRANSFERS}
        drawerOpen={!!drawer}
        homeSeq={homeSeq}
        billboardDraft={null}
        objectiveId={null}
        onViewMedia={noop}
      />

      <header className="hud">
        <div className="hud-brand">
          {config.brand.logo ? <img className="brand-logo" src={config.brand.logo} alt="" width={40} height={40} /> : <div className="logo" aria-hidden="true"><span /><span /><span /></div>}
          <div>
            <h1 data-testid="city-name">{config.cityName.toUpperCase()}</h1>
            <p>
              {config.brand.name} · {scene.districts.length} districts · {config.collections.length} collections
            </p>
          </div>
        </div>
        <div className="hud-status">
          <button type="button" className="status-pill capital" style={{ ['--dc' as string]: capital?.color ?? '#888' }} onClick={() => capital && openDistrict(capital.id)} data-testid="hud-capital" data-capital={capital?.id ?? ''}>
            <span className="pill-k">{config.capital.name.toUpperCase()}</span>
            <span className="pill-v">
              {capital ? <SceneDistrictEmblem district={capital} size={20} /> : <i className="dot" />} {capital?.name ?? 'Unclaimed'}
            </span>
          </button>
          <button type="button" className="status-pill crown" onClick={() => crown && warp(crown.id)} data-testid="hud-crown">
            <span className="pill-k">♔ CROWN</span>
            <span className="pill-v">{crown ? `${scene.buildingLabel(crown)} · ${heightMeters(totalBuilt(crown))} m` : '—'}</span>
          </button>
          <div className="status-pill monuments" aria-label="Monument holders">
            <span className="pill-k">MONUMENTS</span>
            <span className="pill-v mon-dots">
              {scene.monuments.map((m) => {
                const h = state.monuments[m.id].holder
                const hd = h ? sceneDistrict(scene, h) : null
                return (
                  <i key={m.id} title={`${m.name}: ${hd?.name ?? 'Unclaimed'}`} style={{ background: hd?.color ?? 'transparent' }} className={hd ? '' : 'empty'} data-testid={`hud-mon-${m.id}`} data-holder={h ?? ''}>
                    {m.tier}
                  </i>
                )
              })}
            </span>
          </div>
        </div>
        <div className="hud-right">
          <label className="player-chip viewer-chip" title={member?.kind === 'player' ? 'The player Proofy Play launched: their Proofy rules are not checked here' : 'Simulated viewer: no sign-in, no real roles'}>
            <div>
              <div className="player-name">Viewing as</div>
              <select value={memberIndex} onChange={(e) => setMemberIndex(Number(e.target.value))} data-testid="viewer-select" aria-label="Simulated viewer">
                {members.map((m, i) => (
                  <option key={m?.id ?? 'visitor'} value={i}>
                    {m ? m.label : 'Visitor · not signed in'}
                  </option>
                ))}
              </select>
              <div className="wallet">
                <span className="sim-tag">{member?.kind === 'player' ? 'PROOFY PLAY PLAYER · RULES NOT CHECKED' : 'SIMULATED MEMBER'}</span>
              </div>
            </div>
          </label>
          <nav className="hud-nav" aria-label="City panels">
            <button type="button" className={`nav-btn board-nav${panel?.kind === 'district' ? ' on' : ''}`} onClick={() => openDistrict(panel?.kind === 'district' ? panel.id : scene.districts[0].id)} data-testid="nav-districts" aria-pressed={panel?.kind === 'district'}>
              <span aria-hidden="true">▦</span>
              <span className="nav-label">Districts</span>
            </button>
            <button type="button" className="nav-btn" onClick={() => setHomeSeq((s) => s + 1)} data-testid="nav-overview">
              <span aria-hidden="true">⌂</span>
              <span className="nav-label">Overview</span>
            </button>
          </nav>
        </div>
      </header>

      {typeof bar === 'function' ? bar(controls) : bar}

      {drawer && (
        <aside className="drawer" data-testid="drawer">
          {drawer}
        </aside>
      )}

      {notice && (
        <div className="error-toast notice" role="status" key={notice.id} data-testid="preview-notice">
          {notice.text}
        </div>
      )}
    </div>
  )
}

const NO_FX = {}
const NO_TRANSFERS: never[] = []
const noop = () => {}
