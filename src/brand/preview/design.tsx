import { useEffect, useMemo, useRef, useState } from 'react'
import { FACADE_PALETTES } from '../../config/architecture'
import { tierFor, totalBuilt } from '../../game/economy'
import { BuildingSprite } from '../../ui/city/BuildingSprite'
import { roofHeightPx } from '../../ui/city/buildingGeometry'
import { buildingHeightPx } from '../../ui/city/geometry'
import { CitySceneContext, sceneDistrict } from '../../ui/city/scene'
import { PanelHeader } from '../../ui/common'
import { sameDesign, type PropertyDesign } from '../../world/design'
import type { RehearsalDesign, RehearsalDesignView } from '../../protocol/playRehearsal'
import { withPropertyDesigns } from '../core/persisted'
import type { LoadedBrandCity } from '../load'
import type { ClaimProblem } from './claim'
import { DESIGN_REFUSALS, designSettlementOf, type DesignSave, type DesignSaveBook } from './designPress'

/**
 * ARCHITECT DESIGN (P1-C2-E4A): a property's facade finish and roof silhouette, chosen by the NFT's CURRENT controller as
 * this local server's TEST file names them, from the server's design catalog. Only the Proofy Play page passes access to
 * it, and only when its server runs the local rehearsal.
 *
 *   - The property panel's design card shows every viewer the saved design (or the default every new building has) and
 *     who may change it. Only the named controller is offered the Architect design view; founding a property, building
 *     on it as a patron or having controlled it before offers nothing.
 *   - The design view previews each choice ON THE CITY ITSELF (the page redraws that one building with the choice) and
 *     beside the saved version, both drawn by the city's own building art at the building's real tier. A preview is the
 *     page's alone: nothing is sent until Save, and leaving the view (Cancel, Back, another building) drops it, so the
 *     city shows the saved design again.
 *   - Save sends the property, the catalog, the two identifiers, the revision the choice was made on and a fresh id
 *     (`designPress.ts`): a save whose answer is not known is checked again with the same id, exactly as first sent,
 *     before anything else is saved, and the page never says it was saved until the server says so.
 *
 * Every choice is free and none is earned, unlocked, ranked or paid for. A design stays with the property when its
 * controller changes. Nothing here is verified Proofy NFT ownership.
 */

export type DesignLoad = { ok: true; view: RehearsalDesignView } | { ok: false; problem: ClaimProblem }
export type DesignOutcome = { ok: true; fresh: boolean; design: RehearsalDesign; view: RehearsalDesignView | null } | { ok: false; problem: ClaimProblem }

export interface DesignAccess {
  /** The property's design as the server answers it for this viewer. */
  load(propertyId: string): Promise<DesignLoad>
  /** One save, exactly as the save book keeps it. On success the page draws the saved design in the city. */
  save(save: DesignSave): Promise<DesignOutcome>
  /** The saves of the player and world this page acts for. */
  saves(): DesignSaveBook
}

const FACADE_LABELS: Readonly<Record<string, { name: string; note: string }>> = {
  slate: { name: 'Slate', note: 'Cool blue-grey stone' },
  limestone: { name: 'Limestone', note: 'Warm pale stone' },
  brick: { name: 'Brick', note: 'Red fired brick' },
  copper: { name: 'Copper', note: 'Burnished copper, verdigris trim' },
  jade: { name: 'Jade', note: 'Deep green, pale trim' },
}
const ROOF_LABELS: Readonly<Record<string, { name: string; note: string }>> = {
  flat: { name: 'Flat deck', note: 'A low parapet deck' },
  terrace: { name: 'Roof terrace', note: 'A planted rooftop pavilion' },
  dome: { name: 'Dome', note: 'A rounded dome and finial' },
  spire: { name: 'Spire', note: 'A tall pointed spire' },
}
const facadeName = (id: string) => FACADE_LABELS[id]?.name ?? id
const roofName = (id: string) => ROOF_LABELS[id]?.name ?? id
const designName = (d: PropertyDesign) => `${facadeName(d.facade)} · ${roofName(d.roof)}`

const UNCONFIRMED = 'We could not confirm this save. It may already have been saved. Check it with the same save: one save is never applied twice, and never as a different design.'
const UNCONFIRMED_ELSEWHERE = 'We could not confirm your last design save, on another of this city’s properties. Check it before saving anything else: one save is never applied twice.'
/** Never a word of ownership (a founder's panel uses none, P1-C2-E2): who controls the NFT is the local file's test data, unverified. */
const LOCAL_TEST = 'LOCAL TEST control: this local server’s test file names the NFT’s current controller. Proofy has not verified who holds the NFT.'

const CONFLICT = DESIGN_REFUSALS.action_conflict

/** The building as the city draws it, with `design`: the same sprite, at its real tier and progress. Decorative: the caption says what it shows. */
function DesignThumb({ city, buildingId, design, caption, testId }: { city: LoadedBrandCity; buildingId: string; design: PropertyDesign; caption: string; testId: string }) {
  const b = useMemo(() => withPropertyDesigns(city.state, { [buildingId]: design }).buildings[buildingId], [city.state, buildingId, design])
  const total = totalBuilt(b)
  const top = buildingHeightPx(total) + roofHeightPx(design.roof, 1) + 46
  return (
    <figure className="design-thumb" data-testid={testId} data-facade={design.facade} data-roof={design.roof}>
      {/* Paint ids resolve against the map's own <defs>. Inert, and drawn without its label (detail "mid", unselected), so
          nothing in it can be focused, clicked or referenced in place of the city's own building. */}
      <div className="design-thumb-art" inert aria-hidden="true">
        <svg viewBox={`-60 ${-top} 120 ${top + 30}`} width="100%" height="150" focusable="false">
          <CitySceneContext.Provider value={city.scene}>
            <BuildingSprite building={b} total={total} users={city.state.users} selected={false} isPlayer={false} isCrown={false} detail="mid" fx={null} onSelect={noop} labelScale={0.9} isObjective={false} />
          </CitySceneContext.Provider>
        </svg>
      </div>
      <figcaption className="small">
        <b>{caption}</b> · {designName(design)}
      </figcaption>
    </figure>
  )
}
const noop = () => {}

/** A view's saved design (or the catalog's default), as a design: its two identifiers and nothing else. */
const savedOf = (view: RehearsalDesignView): PropertyDesign => {
  const d = view.saved ?? view.catalog.default
  return { facade: d.facade, roof: d.roof }
}

/** The saved design of a property, as every viewer may see it, and the one way in to change it (its named controller only). */
export function DesignCard({ propertyId, tier, founder, access, onDesign }: { propertyId: string; tier: number; founder: boolean; access: DesignAccess; onDesign: () => void }) {
  const [answer, setAnswer] = useState<DesignLoad | null>(null)
  useEffect(() => {
    let live = true
    void access.load(propertyId).then((r) => live && setAnswer(r))
    return () => {
      live = false
    }
  }, [access, propertyId])
  const view = answer?.ok ? answer.view : null
  const design = view?.saved ?? view?.catalog.default ?? null
  const editable = !!view && view.open && view.control === 'viewer'
  return (
    <div className="fund-box design-card" data-testid="design-card" data-state={view ? 'ready' : answer ? 'unavailable' : 'loading'} data-control={view?.control ?? ''} data-revision={view?.saved?.revision ?? 0} data-facade={design?.facade ?? ''} data-roof={design?.roof ?? ''}>
      <div className="row-between">
        <h3>Architect design</h3>
        <span className="sim-tag" data-testid="design-test-tag">
          LOCAL TEST
        </span>
      </div>
      {!view || !design ? (
        <p className="small" role="status" data-testid="design-status">
          {answer && !answer.ok ? answer.problem.message : 'Reading this property’s design…'}
        </p>
      ) : (
        <>
          <p className="small" data-testid="design-saved">
            <b>{designName(design)}</b>
            {view.saved ? ` · saved design, revision ${view.saved.revision}` : ' · the design every new building starts with'}
          </p>
          {tier === 0 && (
            <p className="muted small" data-testid="design-tier0-note">
              Tier 0 foundation: the facade shows now; the roof appears once the building reaches Tier 1.
            </p>
          )}
          <p className="muted small" data-testid="design-control" data-control={view.control}>
            {!view.open
              ? 'Property design is not open in this city on this local server.'
              : view.control === 'viewer'
                ? 'This local server’s test file names you as this NFT’s current controller, so you can change how its building looks. Free; nothing is spent.'
                : view.control === 'other'
                  ? 'Only the NFT’s current controller, as this local server’s test file names them, can change its design. You can look.'
                  : 'No current controller is named for this NFT on this local server, so nobody can change its design.'}
            {founder && view.control !== 'viewer' && ' Founding this property does not let you change it.'}
          </p>
          {editable && (
            <button type="button" className="btn primary" onClick={onDesign} data-testid="design-open">
              Open Architect design
            </button>
          )}
          {view.open && (
            <p className="muted small" data-testid="design-basis-note">
              {LOCAL_TEST} The design stays with the property if the NFT changes hands.
            </p>
          )}
        </>
      )}
    </div>
  )
}

/**
 * THE ARCHITECT DESIGN VIEW: choose a facade and a roof, see them on the city and beside the saved version, then save or
 * cancel. `onPreview` is called with each choice that differs from the saved design (and null when it no longer does);
 * the page draws it on the city for as long as this view is open. `onSaved` hands the page the design the server saved.
 */
export function ArchitectDesignPanel({
  city,
  buildingId,
  propertyId,
  access,
  onPreview,
  onSaved,
  onBack,
  onClose,
}: {
  city: LoadedBrandCity
  buildingId: string
  propertyId: string
  access: DesignAccess
  onPreview: (design: PropertyDesign | null) => void
  onSaved: (design: RehearsalDesign) => void
  onBack: () => void
  onClose: () => void
}) {
  const { scene, state } = city
  const b = state.buildings[buildingId]
  const d = sceneDistrict(scene, b.districtId)
  const tier = tierFor(totalBuilt(b))
  const [view, setView] = useState<RehearsalDesignView | null>(null)
  const [problem, setProblem] = useState<ClaimProblem | null>(null)
  const [choice, setChoice] = useState<PropertyDesign | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ design: RehearsalDesign; fresh: boolean; elsewhere: boolean } | null>(null)
  const [unresolved, setUnresolved] = useState<DesignSave | null>(() => access.saves().unresolved())
  const sending = useRef(false)
  const heading = useRef<HTMLElement>(null)

  /** The property's design as the server answers it now; `reset` also takes the choice back to it. */
  const read = async (reset: boolean) => {
    const r = await access.load(propertyId)
    if (r.ok) {
      setView(r.view)
      if (reset) setChoice(savedOf(r.view))
    } else setProblem(r.problem)
  }
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
    let live = true
    void access.load(propertyId).then((r) => {
      if (!live) return
      if (r.ok) {
        setView(r.view)
        setChoice(savedOf(r.view))
      } else setProblem(r.problem)
    })
    return () => {
      live = false
    }
  }, [access, propertyId])

  const saved = useMemo(() => (view ? savedOf(view) : null), [view])
  const changed = !!choice && !!saved && !sameDesign(choice, saved)
  // The city draws the choice while it differs from the saved design: never anything once this view is gone.
  useEffect(() => {
    onPreview(changed && choice ? choice : null)
  }, [changed, choice, onPreview])
  useEffect(() => () => onPreview(null), [onPreview])

  const editable = !!view && view.open && view.control === 'viewer'
  const pendingHere = unresolved !== null && unresolved.propertyId === propertyId

  async function save() {
    if (sending.current || !view || !choice) return
    sending.current = true
    const book = access.saves()
    // An unresolved save is sent again exactly as it was first sent, whatever is chosen now.
    const sent = book.next({ propertyId, baseRevision: view.saved?.revision ?? 0, catalog: view.catalog.key, facade: choice.facade, roof: choice.roof })
    const elsewhere = sent.propertyId !== propertyId
    setBusy(true)
    setProblem(null)
    setDone(null)
    const r = await access.save(sent)
    const settled = designSettlementOf(r)
    if (settled !== 'unknown') book.settle(sent)
    setUnresolved(book.unresolved())
    if (r.ok) {
      setDone({ design: r.design, fresh: r.fresh, elsewhere })
      onSaved(r.design)
    } else if (settled === 'conflict') setProblem({ message: CONFLICT, kind: 'retry', code: 'action_conflict' })
    else if (settled === 'settled') setProblem(elsewhere ? { ...r.problem, message: `Your earlier save, on another property, was not made: ${r.problem.message}` } : r.problem)
    else setProblem({ ...r.problem, message: elsewhere ? UNCONFIRMED_ELSEWHERE : UNCONFIRMED, kind: 'retry' })
    // This property as saved now. After a save here, or a refusal that moved it on, the choice follows the saved design.
    const reset = (r.ok && !elsewhere) || (!r.ok && r.problem.code === 'design_stale')
    if (r.ok && r.view && !elsewhere) {
      setView(r.view)
      setChoice(savedOf(r.view))
    } else await read(reset)
    setBusy(false)
    sending.current = false
  }

  const cancel = () => {
    if (saved) setChoice(saved)
    onPreview(null)
    onBack()
  }

  const outcome = done ? (done.fresh ? 'saved' : 'repeat') : problem ? (unresolved ? 'unconfirmed' : problem.code === 'action_conflict' ? 'conflict' : problem.kind) : unresolved ? 'unconfirmed' : ''
  const said = done
    ? done.elsewhere
      ? `Your earlier save is confirmed: revision ${done.design.revision} (${designName(done.design)}) on another property. You can save here now.`
      : done.fresh
        ? `Saved: ${designName(done.design)}, revision ${done.design.revision}. The city shows it now, for everyone.`
        : `Already saved by this save: ${designName(done.design)}, revision ${done.design.revision}. Nothing more was saved.`
    : problem
      ? problem.message
      : ''

  return (
    <section ref={heading} tabIndex={-1} className="panel architect-design" aria-label={`Architect design of ${scene.buildingLabel(b)}`} data-testid="design-panel" data-building={buildingId} data-state={view ? 'ready' : problem ? 'unavailable' : 'loading'}>
      <PanelHeader kicker="ARCHITECT DESIGN" title={scene.buildingLabel(b)} onBack={cancel} onClose={onClose} />
      <div className="row-between architect-tagline">
        <p className="small home-lede">
          {d.title} · Tier {tier}. Choose a facade and a roof: the city shows your choice on this building as you go. Nothing is saved until you save.
        </p>
        <span className="sim-tag" data-testid="design-panel-test-tag">
          LOCAL TEST
        </span>
      </div>
      {!view || !choice || !saved ? (
        <p className="small" role="status" data-testid="design-panel-status">
          {problem ? problem.message : 'Reading this property’s design…'}
        </p>
      ) : (
        <>
          <div className="design-compare" data-testid="design-compare" data-changed={String(changed)}>
            <DesignThumb city={city} buildingId={buildingId} design={saved} caption={view.saved ? `Saved · revision ${view.saved.revision}` : 'Saved · default'} testId="design-thumb-saved" />
            <DesignThumb city={city} buildingId={buildingId} design={choice} caption={changed ? 'Preview' : 'Preview · same as saved'} testId="design-thumb-preview" />
          </div>
          {tier === 0 && (
            <p className="muted small" data-testid="design-tier0-note">
              Tier 0 foundation: the facade shows now; the roof is drawn once the building reaches Tier 1, and keeps growing with it.
            </p>
          )}
          <fieldset className="design-options" disabled={!editable || busy} data-testid="design-facades">
            <legend>Facade</legend>
            {view.catalog.facades.map((id) => {
              const pal = FACADE_PALETTES[id] ?? FACADE_PALETTES.slate
              return (
                <label key={id} className={`design-option${choice.facade === id ? ' on' : ''}`} data-testid={`design-facade-${id}`}>
                  <input type="radio" name="design-facade" value={id} checked={choice.facade === id} onChange={() => setChoice({ ...choice, facade: id })} />
                  <svg className="design-swatch" viewBox="-12 -14 24 24" width="28" height="28" aria-hidden="true">
                    <polygon points="0,-12 10,-6 0,0 -10,-6" fill={pal.top} />
                    <polygon points="-10,-6 0,0 0,10 -10,4" fill={pal.left} />
                    <polygon points="0,0 10,-6 10,4 0,10" fill={pal.right} />
                    <line x1={-10} y1={-1} x2={0} y2={5} stroke={pal.trim} strokeWidth={1} />
                    <line x1={0} y1={5} x2={10} y2={-1} stroke={pal.trim} strokeWidth={1} />
                  </svg>
                  <span className="design-option-text">
                    <b>{FACADE_LABELS[id]?.name ?? id}</b>
                    <span className="muted small">{FACADE_LABELS[id]?.note}</span>
                  </span>
                </label>
              )
            })}
          </fieldset>
          <fieldset className="design-options" disabled={!editable || busy} data-testid="design-roofs">
            <legend>Roof</legend>
            {view.catalog.roofs.map((id) => (
              <label key={id} className={`design-option${choice.roof === id ? ' on' : ''}`} data-testid={`design-roof-${id}`}>
                <input type="radio" name="design-roof" value={id} checked={choice.roof === id} onChange={() => setChoice({ ...choice, roof: id })} />
                <RoofGlyph kind={id} />
                <span className="design-option-text">
                  <b>{ROOF_LABELS[id]?.name ?? id}</b>
                  <span className="muted small">{ROOF_LABELS[id]?.note}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {unresolved ? (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void save()} data-testid="design-save" data-pending={pendingHere ? 'here' : 'elsewhere'}>
              {busy ? 'Checking…' : pendingHere ? 'Check this save · same request' : 'Check your earlier save first'}
            </button>
          ) : editable ? (
            <div className="design-actions">
              <button type="button" className="btn primary" disabled={busy || !changed} onClick={() => void save()} data-testid="design-save" aria-describedby="design-save-note">
                {busy ? 'Saving…' : 'Save design'}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={cancel} data-testid="design-cancel">
                Cancel
              </button>
            </div>
          ) : (
            <p className="small" data-testid="design-read-only">
              {view.open ? 'Only the NFT’s current controller, as this local server’s test file names them, can change this design.' : 'Property design is not open in this city on this local server.'}
            </p>
          )}
          {unresolved && !busy && !problem && (
            <p className="small" data-testid="design-unresolved" data-pending={pendingHere ? 'here' : 'elsewhere'}>
              {pendingHere ? UNCONFIRMED : UNCONFIRMED_ELSEWHERE}
            </p>
          )}
          <p className="small construction-feedback" role="status" aria-live="polite" data-testid="design-feedback" data-outcome={outcome}>
            {said}
          </p>
          <p className="muted small" id="design-save-note" data-testid="design-basis">
            Free: a design spends no test credits, adds no construction, and earns no tier, Crown, Capital or monument. It stays with this property if the NFT changes hands. {LOCAL_TEST}
          </p>
          {view.history.length > 0 && (
            <>
              <p className="muted small home-sub">Design history, newest first</p>
              <ul className="patron-list" data-testid="design-history" data-count={view.historyCount}>
                {view.history.slice(0, 5).map((h) => (
                  <li key={h.revision} data-testid="design-history-entry" data-revision={h.revision} data-by={h.by} data-facade={h.facade} data-roof={h.roof}>
                    <span className="grow">
                      {designName(h)} · {h.by === 'viewer' ? 'You' : 'Another player'}
                    </span>
                    <span className="muted small">#{h.revision}</span>
                  </li>
                ))}
              </ul>
              {view.historyCount > 5 && <p className="muted small">and {view.historyCount - 5} earlier.</p>}
            </>
          )}
        </>
      )}
    </section>
  )
}

/** A small silhouette of each roof, for the option list only (the previews above draw the real one). */
function RoofGlyph({ kind }: { kind: string }) {
  const body = <polygon points="-8,0 8,0 8,10 -8,10" fill="#3b475e" />
  return (
    <svg className="design-swatch" viewBox="-12 -16 24 28" width="28" height="28" aria-hidden="true">
      {body}
      {kind === 'terrace' && (
        <>
          <rect x={-5} y={-5} width={10} height={5} fill="#465068" />
          <circle cx={-7} cy={-1.5} r={2} fill="#2f8a5f" />
          <circle cx={7} cy={-1.5} r={2} fill="#2f8a5f" />
        </>
      )}
      {kind === 'dome' && (
        <>
          <path d="M-7 0 A7 7 0 0 1 7 0 Z" fill="#8391ab" />
          <line x1={0} y1={-7} x2={0} y2={-11} stroke="#8391ab" />
          <circle cx={0} cy={-12} r={1.2} fill="#ffb34d" />
        </>
      )}
      {kind === 'spire' && <polygon points="-5,0 0,-15 5,0" fill="#8391ab" />}
      {kind === 'flat' && <rect x={-8} y={-2} width={16} height={2} fill="#8391ab" />}
    </svg>
  )
}
