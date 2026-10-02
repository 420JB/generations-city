import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DistrictId } from '../config/districts'
import { buildingIdFor, SCENARIO } from '../game/seed'
import { announcementsFor } from './announce'
import { Announcements } from './Announcements'
import { BillboardViewer } from './BillboardViewer'
import { PlacementBar } from './PlacementBar'
import { availablePlots, wardName, type PlotCandidate } from '../game/allocation'
import { plotWorld, type WorldPoint } from '../game/world'
import { DemoGuide } from './DemoGuide'
import { demoProgress } from '../game/demo'
import { previewNextDemoFriendId } from '../game/demoCommands'
import type { GameState } from '../game/types'
import { findBuildingByFriend } from '../game/actions'
import type { BuildFx } from './city/BuildingSprite'
import { CityView, type MonumentTransfer } from './city/CityView'
import { Hud } from './Hud'
import { useIdentity } from './identity'
import { AccountPanel } from './panels/AccountPanel'
import { ArchitectPanel } from './panels/ArchitectPanel'
import { BuildBoardPanel } from './panels/BuildBoardPanel'
import { BuildingPanel } from './panels/BuildingPanel'
import { ProfilePanel } from './panels/ProfilePanel'
import { RadioItem, RadioPanel, RallyCard } from './panels/RadioPanel'
import { radioDispatches } from '../game/dispatch'
import { homeDistrict as seasonHome } from '../game/season'
import { StandingsPanel } from './panels/StandingsPanel'
import { useGameStore, type GameAction, type StoreState } from './store'
import { useMediaQuery } from './motion'
import { WalletChip } from './WalletChip'

/** Phone layout breakpoint (matches the bottom-sheet drawer in index.css). */
const MOBILE_QUERY = '(max-width: 820px)'
/** Mobile build reveal: roughly the construction FX payoff (+RF float 2.2s, tween 1.1s). */
export const BUILD_REVEAL_MS = 2000

export type PanelKind = 'board' | 'standings' | 'profile' | 'radio' | 'building' | 'architect' | 'account'

// Legacy prefix kept after the Rare City rename so returning players keep their guide state.
const INTRO_KEY = 'generations-city:intro-dismissed'

function readIntro(): boolean {
  try {
    return window.localStorage.getItem(INTRO_KEY) !== '1'
  } catch {
    return true
  }
}

export default function App() {
  const { store, act } = useGameStore()
  // A server-backed city is not on screen until the server has sent one.
  if (!store.game) {
    const { status, message } = store.connection
    return (
      <div className="boot" role="status" aria-live="polite" data-testid="city-connecting" data-status={status}>
        <div>
          <b>RARE CITY</b>
          {status === 'unavailable' ? (message ?? 'Rare City is unavailable right now. Retrying…') : 'Raising the skyline…'}
        </div>
      </div>
    )
  }
  return <CityApp store={store} game={store.game} act={act} />
}

function CityApp({ store, game, act }: { store: StoreState; game: GameState; act: (a: GameAction) => StoreState }) {
  // WHO IS LOOKING. An anonymous visitor has no id: nothing below may invent one.
  const viewerId = store.viewer.userId
  // The local demo's guide, faucet, reset and simulations exist only for the demo player.
  const isDemo = store.viewer.source === 'demo'
  // WHO IS SIGNED IN (server-backed city only). A session is not a city actor: `viewerId` stays as it is.
  const identity = useIdentity()
  const playerBuilding = useMemo(
    () => (viewerId ? (Object.values(game.buildings).find((b) => b.ownerId === viewerId) ?? null) : null),
    [game.buildings, viewerId],
  )
  const homeDistrict: DistrictId = playerBuilding?.districtId ?? 'd4'

  const [panel, setPanel] = useState<PanelKind | null>(null)
  const [backTo, setBackTo] = useState<PanelKind | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [boardDistrict, setBoardDistrict] = useState<DistrictId>(homeDistrict)
  const [focus, setFocus] = useState<{ buildingId: string; seq: number } | null>(null)
  const [homeSeq, setHomeSeq] = useState(0)
  const [dismissedSeq, setDismissedSeq] = useState(-1)
  const [transferSeqDone, setTransferSeqDone] = useState(-1)
  const [confirmReset, setConfirmReset] = useState(false)
  const [mediaView, setMediaView] = useState<string | null>(null)
  // PLACEMENT MODE (UI-only): which district a joining Friend belongs to and the plot picked.
  // Entering, previewing and cancelling never touch game state; only "Place Friend here" does.
  const [placement, setPlacement] = useState<{ districtId: DistrictId; backTo: PanelKind | null; selected: PlotCandidate | null } | null>(null)
  const [frame, setFrame] = useState<{ seq: number; points: WorldPoint[] } | null>(null)
  const [growthFocusSeq, setGrowthFocusSeq] = useState(0)
  const [guideOpen, setGuideOpen] = useState(readIntro)
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null)
  const showNotice = (text: string) => setNotice({ id: Date.now(), text })
  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 3500)
    return () => window.clearTimeout(t)
  }, [notice])
  const [boardOpened, setBoardOpened] = useState(false)
  const [warpedKing, setWarpedKing] = useState(false)
  const [billboardDraft, setBillboardDraft] = useState<{ buildingId: string; image: string | null } | null>(null)
  const onBillboardDraft = useCallback(
    (image: string | null) => setBillboardDraft(image && selectedId ? { buildingId: selectedId, image } : null),
    [selectedId],
  )

  const last = store.last
  const lastSeq = last?.seq ?? 0

  // MOBILE BUILD REVEAL: after a successful spend that visibly builds the selected property,
  // the bottom-sheet drawer slides away so the growth / tier-up FX is unobstructed, then
  // returns on its own (still mounted, so the same building, tab and state come back).
  const isMobile = useMediaQuery(MOBILE_QUERY)
  const buildSeq = last && last.events.some((e) => e.type === 'build') ? last.seq : -1
  const [revealDoneSeq, setRevealDoneSeq] = useState(-1)
  useEffect(() => {
    if (buildSeq < 0) return
    // A newer build replaces this timer, so back-to-back builds extend the reveal cleanly.
    const t = window.setTimeout(() => setRevealDoneSeq(buildSeq), BUILD_REVEAL_MS)
    return () => window.clearTimeout(t)
  }, [buildSeq])

  // Derived, time-boxed presentation of the latest action.
  const { banners, badges } = useMemo(
    () => (last && last.seq !== dismissedSeq ? announcementsFor(game, last.events, last.seq, viewerId) : { banners: [], badges: [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [last, dismissedSeq],
  )
  const transfers: MonumentTransfer[] = useMemo(() => {
    if (!last || last.seq === transferSeqDone) return []
    return last.events.flatMap((e, i) => (e.type === 'monument-transfer' ? [{ key: `${last.seq}-${i}`, monumentId: e.monumentId, from: e.from, to: e.to }] : []))
  }, [last, transferSeqDone])
  const fx = useMemo(() => {
    const out: Record<string, BuildFx> = {}
    if (!last) return out
    for (const e of last.events) {
      if (e.type === 'build') out[e.buildingId] = { seq: last.seq, amount: e.amount, tierUp: null }
      if (e.type === 'tier-up' && out[e.buildingId]) out[e.buildingId] = { ...out[e.buildingId], tierUp: e.toTier }
    }
    return out
  }, [last])

  useEffect(() => {
    if (!lastSeq) return
    const t1 = window.setTimeout(() => setDismissedSeq(lastSeq), 6500)
    const t2 = window.setTimeout(() => setTransferSeqDone(lastSeq), 4200)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [lastSeq])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (mediaView) setMediaView(null)
      else if (placement) cancelPlacement()
      else if (confirmReset) setConfirmReset(false)
      else if (panel) {
        setPanel(null)
        setBackTo(null)
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmReset, panel, mediaView, placement])

  const openPanel = useCallback((p: PanelKind) => {
    setPlacement(null)
    if (p === 'board') setBoardOpened(true)
    setPanel((cur) => (cur === p ? null : p))
    setBackTo(null)
  }, [])

  const warp = useCallback(
    (buildingId: string) => {
      if (buildingId === buildingIdFor(SCENARIO.kingmakerFriend)) setWarpedKing(true)
      setPlacement(null)
      setSelectedId(buildingId)
      setBackTo(panel && panel !== 'building' && panel !== 'architect' ? panel : backTo)
      setPanel('building')
      setFocus((f) => ({ buildingId, seq: (f?.seq ?? 0) + 1 }))
    },
    [panel, backTo],
  )

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id)
      if (id) {
        setBackTo(panel && panel !== 'building' && panel !== 'architect' ? panel : backTo)
        setPanel('building')
      } else if (panel === 'building' || panel === 'architect') {
        setPanel(null)
      }
    },
    [panel, backTo],
  )

  const search = (friendId: number) => {
    const b = findBuildingByFriend(game, friendId)
    if (b) warp(b.id)
    else showNotice(`Demo Friend #${friendId} hasn't joined Rare City yet.`)
  }

  const candidates = useMemo(() => (placement ? availablePlots(game, placement.districtId) : []), [game, placement])

  /** "+ Add Friend": enter placement mode for a family district and frame its sites. */
  const startPlacement = (districtId: DistrictId) => {
    const sites = availablePlots(game, districtId)
    setPlacement({ districtId, backTo: panel, selected: null })
    setPanel(null)
    setSelectedId(null)
    setFrame((f) => ({ seq: (f?.seq ?? 0) + 1, points: sites.map((c) => plotWorld(c.districtId, c.ward, c.plot)) }))
  }

  function cancelPlacement() {
    const back = placement?.backTo ?? null
    setPlacement(null)
    if (back) setPanel(back)
  }

  const confirmPlacement = () => {
    const pick = placement?.selected
    if (!pick) return
    // The new property's id comes from the authority's own result, never from a guess.
    const after = act({ type: 'join-at', districtId: pick.districtId, ward: pick.ward, plot: pick.plot })
    const joined = after.last?.seq === after.seq ? after.last.events.find((e) => e.type === 'resident-joined') : undefined
    if (joined) warp(joined.buildingId)
    else setPlacement(null)
  }

  const showCityGrowth = () => {
    setPlacement(null)
    setPanel('standings')
    setBackTo(null)
    setGrowthFocusSeq((n) => n + 1)
  }

  const closePanel = () => {
    setPanel(null)
    setBackTo(null)
  }

  const visitorNote = store.connection.canonical === false ? 'NON-CANONICAL TEST CITY · READ-ONLY' : 'READ-ONLY'

  const doReset = () => {
    act({ type: 'reset' })
    setConfirmReset(false)
    // Leave placement mode too: its selected plot belongs to the city that was just discarded.
    setPlacement(null)
    setPanel(null)
    setSelectedId(null)
    setBackTo(null)
    setHomeSeq((n) => n + 1)
    // RESET DEMO also restores the guided path.
    setGuideOpen(true)
    setBoardOpened(false)
    setWarpedKing(false)
    try {
      window.localStorage.removeItem(INTRO_KEY)
    } catch {
      // ignore
    }
  }

  const hideGuide = () => {
    setGuideOpen(false)
    try {
      window.localStorage.setItem(INTRO_KEY, '1')
    } catch {
      // ignore
    }
  }

  const progress = useMemo(() => demoProgress(game), [game])
  // Demo growth targets the player's Home District (Family in the seeded demo).
  const growDistrict: DistrictId = (viewerId ? seasonHome(game, viewerId) : null) ?? homeDistrict
  // Rally Calls are derived from current state (never persisted) and refresh after every action.
  // They are personal (what this player's RF could do), so a visitor has none.
  const rallyCalls = useMemo(() => (viewerId ? radioDispatches(game, viewerId) : []), [game, viewerId])
  // The next guided objective stays labelled on the map even at overview zoom.
  const objectiveId = !isDemo ? null : !progress.primaryComplete ? progress.kingmakerId : !progress.capital ? buildingIdFor(SCENARIO.capitalFriend) : null
  const showGuide = isDemo && guideOpen

  const drawer =
    panel === 'board' ? (
      <BuildBoardPanel game={game} districtId={boardDistrict} onDistrict={setBoardDistrict} onWarp={warp} onClose={closePanel} />
    ) : panel === 'standings' ? (
      <StandingsPanel game={game} onClose={closePanel} onWarp={warp} onJoin={isDemo ? startPlacement : undefined} growthFocusSeq={growthFocusSeq} />
    ) : panel === 'profile' && viewerId ? (
      <ProfilePanel game={game} viewerId={viewerId} onClose={closePanel} onWarp={warp} />
    ) : panel === 'radio' ? (
      <RadioPanel
        game={game}
        calls={rallyCalls}
        onClose={closePanel}
        onWarp={warp}
        demoTools={
          isDemo
            ? {
                growth: { districtId: growDistrict, nextWard: wardName(game.wards[growDistrict] ?? 1) },
                onRival: () => act({ type: 'rival' }),
                onGrow: () => {
                  act({ type: 'grow', districtId: growDistrict })
                  // Existing overview framing (radius-aware) so the newly opened ward is in view.
                  setHomeSeq((n) => n + 1)
                },
              }
            : null
        }
      />
    ) : panel === 'building' && selectedId && game.buildings[selectedId] ? (
      <BuildingPanel
        key={selectedId}
        game={game}
        viewerId={viewerId}
        buildingId={selectedId}
        act={act}
        onClose={() => select(null)}
        onBack={backTo ? () => { setPanel(backTo); setBackTo(null) } : undefined}
        onArchitect={() => setPanel('architect')}
      />
    ) : panel === 'architect' && viewerId && selectedId && game.buildings[selectedId] ? (
      <ArchitectPanel game={game} viewerId={viewerId} buildingId={selectedId} act={act} onClose={() => select(null)} onBack={() => setPanel('building')} onBillboardDraft={onBillboardDraft} />
    ) : panel === 'account' && identity ? (
      <AccountPanel identity={identity} onClose={closePanel} />
    ) : null

  const revealing =
    isMobile &&
    buildSeq > revealDoneSeq &&
    (panel === 'building' || panel === 'architect') &&
    !!last?.events.some((e) => e.type === 'build' && e.buildingId === selectedId)

  return (
    <div className={`app${placement ? ' has-placement' : ''}${drawer ? ' has-drawer' : ''}${showGuide ? ' has-intro' : isDemo && !progress.primaryComplete ? ' has-reminder' : ''}`}>
      <div className="sky" aria-hidden="true">
        <div className="stars" />
        <div className="stars stars-2" />
        <div className="moon" />
      </div>
      <CityView
        game={game}
        viewerId={viewerId}
        selectedId={selectedId}
        onSelect={select}
        onSelectDistrict={(d) => {
          setBoardDistrict(d)
          setPanel('board')
          setBackTo(null)
        }}
        focus={focus}
        fx={fx}
        transfers={transfers}
        drawerOpen={!!drawer}
        homeSeq={homeSeq}
        billboardDraft={billboardDraft}
        objectiveId={objectiveId}
        onViewMedia={setMediaView}
        placement={placement ? { candidates, selected: placement.selected } : null}
        onPickPlot={(c) => setPlacement((p) => (p ? { ...p, selected: c } : p))}
        frame={frame}
      />
      {placement && (
        <PlacementBar
          districtId={placement.districtId}
          candidates={candidates}
          selected={placement.selected}
          nextFriendId={previewNextDemoFriendId(game)}
          onConfirm={confirmPlacement}
          onClearSelection={() => setPlacement((p) => (p ? { ...p, selected: null } : p))}
          onCancel={cancelPlacement}
        />
      )}
      <Hud
        game={game}
        viewerId={viewerId}
        visitorNote={visitorNote}
        visitor={identity ? <WalletChip identity={identity} note={visitorNote} onOpen={() => openPanel('account')} /> : undefined}
        panel={panel}
        onPanel={openPanel}
        guideOpen={showGuide}
        onSearch={search}
        onWarp={warp}
        demo={isDemo ? { onHelp: () => setGuideOpen((v) => !v), onFaucet: () => act({ type: 'faucet' }), onReset: () => setConfirmReset(true) } : null}
      />

      <div className="radio-ticker" aria-label="Latest District Radio">
        <button type="button" className="ticker-head" onClick={() => openPanel('radio')}>
          <span className="live-dot" /> DISTRICT RADIO
        </button>
        <ul>
          {rallyCalls[0] && <RallyCard key={rallyCalls[0].id} call={rallyCalls[0]} onWarp={warp} testId="ticker-rally" />}
          {game.radio.slice(0, 1).map((e) => (
            <RadioItem key={e.id} e={e} />
          ))}
        </ul>
      </div>

      {!isDemo ? null : guideOpen ? (
        <DemoGuide
          progress={progress}
          boardOpened={boardOpened}
          warpedKing={warpedKing}
          onOpenBoard={() => openPanel('board')}
          onWarpKing={() => warp(progress.kingmakerId)}
          onWarpCapital={() => warp(buildingIdFor(SCENARIO.capitalFriend))}
          onWarpMine={() => playerBuilding && warp(playerBuilding.id)}
          onHide={hideGuide}
          onCityGrowth={showCityGrowth}
        />
      ) : (
        !progress.primaryComplete && (
          <button type="button" className="guide-reminder" onClick={() => setGuideOpen(true)} data-testid="guide-reminder">
            ▶ 30-second demo guide
          </button>
        )
      )}

      {drawer && (
        <aside className={`drawer${revealing ? ' revealing' : ''}`} data-testid="drawer" data-revealing={revealing ? 'true' : 'false'} inert={revealing || undefined}>
          {drawer}
        </aside>
      )}

      <Announcements banners={banners} badges={badges} onDismiss={() => setDismissedSeq(lastSeq)} />

      {notice && (
        <div className="error-toast notice" role="status" key={notice.id} data-testid="notice">
          {notice.text}
        </div>
      )}
      {store.error && (
        <div className="error-toast" role="alert" key={store.error.seq}>
          {store.error.message}
        </div>
      )}
      {store.restored && lastSeq === 0 && <div className="restore-note">Restored your local demo city</div>}
      {store.connection.status === 'stale' && (
        <div className="restore-note" role="status" style={{ animation: 'none' }} data-testid="city-stale">
          Showing the last city received · {store.connection.message}
        </div>
      )}

      {mediaView && <BillboardViewer game={game} buildingId={mediaView} onClose={() => setMediaView(null)} />}

      {confirmReset && (
        <div className="modal-backdrop" role="presentation" onClick={() => setConfirmReset(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="reset-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="reset-title">Reset the demo city?</h2>
            <p className="muted">This clears all local progress, badges, history and billboard images, and reseeds the deterministic demo.</p>
            <div className="row gap">
              <button type="button" className="btn primary" onClick={doReset} data-testid="confirm-reset" autoFocus>
                Reset Demo
              </button>
              <button type="button" className="btn ghost" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
