import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { heightMeters, totalBuilt } from '../../game/economy'
import { CityView } from '../../ui/city/CityView'
import { plotWorldIn } from '../../ui/city/districtGeometry'
import { sceneDistrict, type ScenePlotCandidate } from '../../ui/city/scene'
import { SceneDistrictEmblem } from '../../ui/common'
import { mayAct, previewClaimAccess, type PreviewMember } from '../core/eligibility'
import { districtPlots, loadBrandCity, type LoadedBrandCity } from '../load'
import type { SampleBrand } from '../samples'
import type { WorldPoint } from '../../game/world'
import type { PropertyDesign } from '../../world/design'
import { withPropertyDesigns } from '../core/persisted'
import { ArchitectPanel } from './architect'
import type { ConstructionAccess } from './construction'
import { ArchitectDesignPanel, type DesignAccess } from './design'
import { MyPropertiesPanel, PropertyContextCard, type HomeClaim, type PropertyHome } from './home'
import { BuildingPreviewPanel, DistrictPanel, PlotPanel } from './panels'
import { propertyContext } from './properties'
import { RehearsalPlotPanel, type PlacementRehearsal, type StoredProperty } from './rehearsal'

/** A building panel opened from the Architect activity goes back to it; so does its design view, through the building panel. */
type Panel = { kind: 'district'; id: string } | { kind: 'building'; id: string; from?: 'architect' } | { kind: 'design'; id: string; from?: 'architect' } | { kind: 'properties' } | { kind: 'architect' } | null

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
 *
 * The Play page also passes `home`: the properties the signed-in player founded here, as the server's
 * permanent record says. The HUD then offers MY PROPERTIES, each a tap from its panel and the camera, and a
 * stored property's panel says what surrounds it in the stored city. In a local rehearsal it passes
 * `construction` too: a stored property's panel then shows its LOCAL TEST construction and the one test
 * action the server says this viewer has (`construction.tsx`), and the player's own construction record opens
 * from MY PROPERTIES and from the construction card (ARCHITECT ACTIVITY, `architect.tsx`). With `design` (P1-C2-E4A), a stored
 * property's panel shows its saved Architect design, and the NFT's named controller opens the ARCHITECT DESIGN view
 * (`design.tsx`): while it is open the city draws that one building with the choice being previewed, and only with it;
 * leaving the view drops the preview, and the city shows the saved design (as the page was given it) again.
 */
export function BrandCityPreview({
  city,
  members,
  bar,
  stored,
  rehearsal,
  home,
  construction,
  design,
}: {
  city: LoadedBrandCity
  members: readonly (PreviewMember | null)[]
  /** Above the city: where its data came from. A function is given the city's controls. */
  bar: ReactNode | ((controls: CityControls) => ReactNode)
  stored?: (buildingId: string) => StoredProperty | null
  rehearsal?: PlacementRehearsal | null
  home?: PropertyHome | null
  /** LOCAL TEST construction on stored properties' panels, when the server runs the local rehearsal (P1-C2-E3A). */
  construction?: ConstructionAccess | null
  /** Architect design on stored properties' panels, when the server runs the local rehearsal (P1-C2-E4A). */
  design?: DesignAccess | null
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
  // The building whose design is open stays selected on the map, so its preview is the one in view.
  const selectedId = panel?.kind === 'building' || panel?.kind === 'design' ? panel.id : null

  /** The choice the design view previews, for its building. Drawn only while that building's design view is open. */
  const [preview, setPreview] = useState<{ id: string; design: PropertyDesign } | null>(null)
  const designing = panel?.kind === 'design' ? panel.id : null
  const previewing = preview && preview.id === designing ? preview : null
  /** The city as drawn: exactly the city given, but for the one building a preview redraws. */
  const drawn = useMemo(() => (previewing ? withPropertyDesigns(state, { [previewing.id]: previewing.design }) : state), [state, previewing])
  const previewFor = useCallback((id: string) => (d: PropertyDesign | null) => setPreview((p) => (d ? { id, design: d } : p?.id === id ? null : p)), [])
  const onPreview = useMemo(() => (designing ? previewFor(designing) : null), [designing, previewFor])
  /** Open a property's design view, from its panel (or the Architect activity): the camera goes to the building. */
  const openDesign = useCallback((buildingId: string, from?: 'architect') => {
    setPreview(null)
    // An earlier notice (a claim, a release) would sit over the design view on a small screen: it has been read.
    setNotice(null)
    setPanel({ kind: 'design', id: buildingId, from })
    setFocus((f) => ({ buildingId, seq: (f?.seq ?? 0) + 1 }))
  }, [])

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
  /** As `warp`, from the Architect activity: the panel's back goes there. */
  const warpFromArchitect = useCallback((buildingId: string) => {
    setPanel({ kind: 'building', id: buildingId, from: 'architect' })
    setFocus((f) => ({ buildingId, seq: (f?.seq ?? 0) + 1 }))
  }, [])

  const openHome = useCallback(() => {
    setPlacing(null)
    setPanel({ kind: 'properties' })
  }, [])
  /** The player's own construction record: only where the server runs the local rehearsal's construction. */
  const openArchitect = useCallback(() => {
    setPlacing(null)
    setPanel({ kind: 'architect' })
  }, [])
  const loadActivity = useCallback(() => construction!.activity(), [construction])
  /** The player's properties, by building id. */
  const founded = useMemo(() => new Set(home?.founded.map((p) => p.buildingId)), [home])
  // A panel opened from the player's properties takes the keyboard with it (the list it was opened from is gone).
  const drawerRef = useRef<HTMLElement>(null)
  const [drawerFocus, setDrawerFocus] = useState(0)
  useEffect(() => {
    if (drawerFocus) drawerRef.current?.focus({ preventScroll: true })
  }, [drawerFocus])

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

  /** From the player's properties: continue the claim they hold, or start one (the server assigns the district). */
  const homeClaim: HomeClaim | null =
    !home || !rehearsal || playerIndex < 0
      ? null
      : rehearsal.ticket
        ? { label: 'Continue claim', run: controls.continueClaim }
        : rehearsal.awaitingAsset && rehearsal.nfts.length > 0
          ? { label: 'Select your test NFT', run: controls.continueClaim }
          : rehearsal.nfts.length > 0 && rehearsal.ticketNote?.kind !== 'refused' && rehearsal.ticketNote?.kind !== 'config'
            ? {
                label: home.founded.length > 0 ? 'Claim another NFT' : 'Claim an NFT',
                run: () =>
                  void rehearsal.enter().then((r) => {
                    if (!r.ok) say(r.message)
                    else if (r.ticket) {
                      setMemberIndex(playerIndex)
                      placeAt(r.ticket.districtKey, true)
                    }
                  }),
              }
            : null

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
          say(`${result.fresh ? 'Property activated' : 'Already founded by you'}: ${nft.collectionName} #${nft.tokenId} · city sequence ${result.sequence}. Local rehearsal, test NFT.`)
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
    ) : panel?.kind === 'properties' && home ? (
      <MyPropertiesPanel
        city={city}
        home={home}
        claim={homeClaim}
        onArchitect={construction ? openArchitect : undefined}
        onView={(buildingId) => {
          warp(buildingId)
          setDrawerFocus((n) => n + 1)
        }}
        onClose={() => setPanel(null)}
      />
    ) : panel?.kind === 'architect' && construction ? (
      <ArchitectPanel
        city={city}
        load={loadActivity}
        onView={(buildingId) => {
          if (!state.buildings[buildingId]) return
          warpFromArchitect(buildingId)
          setDrawerFocus((n) => n + 1)
        }}
        onDesign={
          design
            ? (buildingId) => {
                if (!state.buildings[buildingId] || !stored?.(buildingId)) return
                // The design view takes the keyboard itself.
                openDesign(buildingId, 'architect')
              }
            : undefined
        }
        onBack={home ? openHome : undefined}
        onClose={() => setPanel(null)}
      />
    ) : panel?.kind === 'design' && design && onPreview && state.buildings[panel.id] && stored?.(panel.id) ? (
      <ArchitectDesignPanel
        key={panel.id}
        city={city}
        buildingId={panel.id}
        propertyId={stored(panel.id)!.propertyId}
        access={design}
        onPreview={onPreview}
        onSaved={() => setPreview(null)}
        onBack={() => setPanel({ kind: 'building', id: panel.id, from: panel.from })}
        onClose={() => setPanel(null)}
      />
    ) : panel?.kind === 'building' && state.buildings[panel.id] ? (
      <BuildingPreviewPanel
        key={panel.id}
        city={city}
        buildingId={panel.id}
        member={member}
        stored={stored?.(panel.id) ?? null}
        context={home && <HomeContext city={city} buildingId={panel.id} onWarp={warp} onDistrict={openDistrict} />}
        construction={construction ?? null}
        design={design ?? null}
        onDesign={design ? () => openDesign(panel.id, panel.from) : undefined}
        onArchitect={construction ? openArchitect : undefined}
        onDistrict={openDistrict}
        onBack={panel.from === 'architect' ? openArchitect : founded.has(panel.id) ? openHome : undefined}
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
        game={drawn}
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
            {home && (
              <button
                type="button"
                className={`nav-btn home-nav${panel?.kind === 'properties' ? ' on' : ''}`}
                onClick={openHome}
                data-testid="nav-properties"
                data-count={home.founded.length}
                aria-pressed={panel?.kind === 'properties'}
                aria-label={`My properties: ${home.founded.length} founded`}
              >
                <span aria-hidden="true">◆</span>
                <span className="nav-label">My properties</span>
                <span className="home-count" aria-hidden="true">
                  {home.founded.length}
                </span>
              </button>
            )}
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
        <aside className="drawer" data-testid="drawer" ref={drawerRef} tabIndex={-1}>
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

/** The city around a stored property, read once per panel from the city on the page. */
function HomeContext({ city, buildingId, onWarp, onDistrict }: { city: LoadedBrandCity; buildingId: string; onWarp: (id: string) => void; onDistrict: (id: string) => void }) {
  const context = useMemo(() => propertyContext(city, buildingId), [city, buildingId])
  return context && <PropertyContextCard city={city} context={context} onWarp={onWarp} onDistrict={onDistrict} />
}

const NO_FX = {}
const NO_TRANSFERS: never[] = []
const noop = () => {}
