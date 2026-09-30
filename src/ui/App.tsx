import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DistrictId } from '../config/districts'
import { DEMO_PLAYER_ID } from '../config/identity'
import { buildingIdFor, SCENARIO } from '../game/seed'
import { announcementsFor } from './announce'
import { Announcements } from './Announcements'
import { DemoGuide } from './DemoGuide'
import { demoProgress } from '../game/demo'
import { findBuildingByFriend } from '../game/actions'
import type { BuildFx } from './city/BuildingSprite'
import { CityView, type MonumentTransfer } from './city/CityView'
import { Hud } from './Hud'
import { ArchitectPanel } from './panels/ArchitectPanel'
import { BuildBoardPanel } from './panels/BuildBoardPanel'
import { BuildingPanel } from './panels/BuildingPanel'
import { ProfilePanel } from './panels/ProfilePanel'
import { RadioItem, RadioPanel } from './panels/RadioPanel'
import { StandingsPanel } from './panels/StandingsPanel'
import { useGameStore } from './store'

export type PanelKind = 'board' | 'standings' | 'profile' | 'radio' | 'building' | 'architect'

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
  const game = store.game
  const playerBuilding = useMemo(
    () => Object.values(game.buildings).find((b) => b.ownerId === DEMO_PLAYER_ID) ?? null,
    [game.buildings],
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

  // Derived, time-boxed presentation of the latest action.
  const { banners, badges } = useMemo(
    () => (last && last.seq !== dismissedSeq ? announcementsFor(game, last.events, last.seq) : { banners: [], badges: [] }),
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
      if (confirmReset) setConfirmReset(false)
      else if (panel) {
        setPanel(null)
        setBackTo(null)
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmReset, panel])

  const openPanel = useCallback((p: PanelKind) => {
    if (p === 'board') setBoardOpened(true)
    setPanel((cur) => (cur === p ? null : p))
    setBackTo(null)
  }, [])

  const warp = useCallback(
    (buildingId: string) => {
      if (buildingId === buildingIdFor(SCENARIO.kingmakerFriend)) setWarpedKing(true)
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
    else showNotice(`Demo Friend #${friendId} hasn't joined Generations City yet.`)
  }

  const joinDistrict = (districtId: DistrictId) => {
    // The next resident's building id is deterministic, so we can warp to it in the same update.
    const nextId = `b-${20_000 + game.residentSeq + 1}`
    act({ type: 'join', districtId })
    warp(nextId)
  }

  const closePanel = () => {
    setPanel(null)
    setBackTo(null)
  }

  const doReset = () => {
    act({ type: 'reset' })
    setConfirmReset(false)
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
  // The next guided objective stays labelled on the map even at overview zoom.
  const objectiveId = !progress.primaryComplete ? progress.kingmakerId : !progress.capital ? buildingIdFor(SCENARIO.capitalFriend) : null

  const drawer =
    panel === 'board' ? (
      <BuildBoardPanel game={game} districtId={boardDistrict} onDistrict={setBoardDistrict} onWarp={warp} onClose={closePanel} />
    ) : panel === 'standings' ? (
      <StandingsPanel game={game} onClose={closePanel} onWarp={warp} onJoin={joinDistrict} />
    ) : panel === 'profile' ? (
      <ProfilePanel game={game} onClose={closePanel} onWarp={warp} />
    ) : panel === 'radio' ? (
      <RadioPanel game={game} onClose={closePanel} onWarp={warp} onRival={() => act({ type: 'rival' })} />
    ) : panel === 'building' && selectedId && game.buildings[selectedId] ? (
      <BuildingPanel
        key={selectedId}
        game={game}
        buildingId={selectedId}
        act={act}
        onClose={() => select(null)}
        onBack={backTo ? () => { setPanel(backTo); setBackTo(null) } : undefined}
        onArchitect={() => setPanel('architect')}
      />
    ) : panel === 'architect' && selectedId && game.buildings[selectedId] ? (
      <ArchitectPanel game={game} buildingId={selectedId} act={act} onClose={() => select(null)} onBack={() => setPanel('building')} onBillboardDraft={onBillboardDraft} />
    ) : null

  return (
    <div className={`app${drawer ? ' has-drawer' : ''}${guideOpen ? ' has-intro' : ''}`}>
      <div className="sky" aria-hidden="true">
        <div className="stars" />
        <div className="stars stars-2" />
        <div className="moon" />
      </div>
      <CityView
        game={game}
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
      />
      <Hud game={game} panel={panel} onPanel={openPanel} onHelp={() => setGuideOpen((v) => !v)} guideOpen={guideOpen} onSearch={search} onFaucet={() => act({ type: 'faucet' })} onReset={() => setConfirmReset(true)} onWarp={warp} />

      <div className="radio-ticker" aria-label="Latest District Radio">
        <button type="button" className="ticker-head" onClick={() => openPanel('radio')}>
          <span className="live-dot" /> DISTRICT RADIO
        </button>
        <ul>
          {game.radio.slice(0, 2).map((e) => (
            <RadioItem key={e.id} e={e} onWarp={warp} />
          ))}
        </ul>
      </div>

      {guideOpen ? (
        <DemoGuide
          progress={progress}
          boardOpened={boardOpened}
          warpedKing={warpedKing}
          onOpenBoard={() => openPanel('board')}
          onWarpKing={() => warp(progress.kingmakerId)}
          onWarpCapital={() => warp(buildingIdFor(SCENARIO.capitalFriend))}
          onWarpMine={() => playerBuilding && warp(playerBuilding.id)}
          onHide={hideGuide}
        />
      ) : (
        !progress.primaryComplete && (
          <button type="button" className="guide-reminder" onClick={() => setGuideOpen(true)} data-testid="guide-reminder">
            ▶ 30-second demo guide
          </button>
        )
      )}

      {drawer && <aside className="drawer">{drawer}</aside>}

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
