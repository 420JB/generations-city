import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { FACADE_PALETTES, LIGHTING_COLORS } from '../../config/architecture'
import { tierFor, totalBuilt } from '../../game/economy'
import { BuildingSprite } from '../../ui/city/BuildingSprite'
import { roofHeightPx } from '../../ui/city/buildingGeometry'
import { buildingHeightPx } from '../../ui/city/geometry'
import { CitySceneContext, sceneDistrict } from '../../ui/city/scene'
import { PanelHeader } from '../../ui/common'
import { appearanceOf, DESIGN_SLOTS, sameDesign, type DesignSlot, type PropertyDesign } from '../../world/design'
import type { RehearsalDesign, RehearsalDesignCatalog, RehearsalDesignView } from '../../protocol/playRehearsal'
import { withPropertyDesigns } from '../core/persisted'
import type { LoadedBrandCity } from '../load'
import type { ClaimProblem } from './claim'
import { catalogNote, designName, LABELS, nameOf, revisionName } from './designNames'
import { DESIGN_REFUSALS, designSettlementOf, type DesignSave, type DesignSaveBook } from './designPress'

/**
 * ARCHITECT DESIGN (P1-C2-E4A, P1-C2-E4B, P1-C2-E4C): a property's facade finish, roof silhouette, window treatment,
 * exterior lighting, entrance and landscaping, chosen by the NFT's CURRENT controller as this local server's TEST file
 * names them, from the server's design catalog. Only the Proofy Play page passes access to
 * it, and only when its server runs the local rehearsal.
 *
 *   - The property panel's design card shows every viewer the saved design (or the default every new building has) and
 *     who may change it. Only the named controller is offered the Architect design view; founding a property, building
 *     on it as a patron or having controlled it before offers nothing.
 *   - The design view previews each choice ON THE CITY ITSELF (the page redraws that one building with the choice) and
 *     beside the saved version, both drawn by the city's own building art at the building's real tier. A preview is the
 *     page's alone: nothing is sent until Save, and leaving the view (Cancel, Back, another building) drops it, so the
 *     city shows the saved design again.
 *   - The six categories are grouped in three tabs (the building, its windows and lighting, its street level), so the
 *     view stays short; each tab says how many of its categories the preview changes.
 *   - Save sends the property, the catalog, its six identifiers (one coherent revision), the revision the choice was
 *     made on and a fresh id (`designPress.ts`): a save whose answer is not known is checked again with the same id, exactly as first sent,
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

const SLOT_NAMES: Readonly<Record<DesignSlot, string>> = { facade: 'Facade', roof: 'Roof', windows: 'Windows', lighting: 'Lighting', entrance: 'Entrance', landscaping: 'Landscaping' }

/** The view's three tabs, in order: each groups two categories. */
const GROUPS: readonly { key: string; name: string; slots: readonly DesignSlot[] }[] = [
  { key: 'building', name: 'Building', slots: ['facade', 'roof'] },
  { key: 'details', name: 'Details', slots: ['windows', 'lighting'] },
  { key: 'street', name: 'Street level', slots: ['entrance', 'landscaping'] },
]
/** Each category's fieldset test id (unchanged since the category was added). */
const FIELDSET_IDS: Readonly<Record<DesignSlot, string>> = { facade: 'design-facades', roof: 'design-roofs', windows: 'design-windows', lighting: 'design-lighting', entrance: 'design-entrances', landscaping: 'design-landscaping' }
const LEGENDS: Readonly<Record<DesignSlot, string>> = { facade: 'Facade', roof: 'Roof', windows: 'Windows', lighting: 'Exterior lighting', entrance: 'Entrance', landscaping: 'Landscaping' }
/** Where the server's catalog lists each category's choices. */
const CATALOG_LISTS = { facade: 'facades', roof: 'roofs', windows: 'windows', lighting: 'lighting', entrance: 'entrances', landscaping: 'landscaping' } as const satisfies Record<DesignSlot, keyof RehearsalDesignCatalog>

const UNCONFIRMED = 'We could not confirm this save. It may already have been saved. Check it with the same save: one save is never applied twice, and never as a different design.'
const UNCONFIRMED_ELSEWHERE = 'We could not confirm your last design save, on another of this city’s properties. Check it before saving anything else: one save is never applied twice.'
/** Never a word of ownership (a founder's panel uses none, P1-C2-E2): who controls the NFT is the local file's test data, unverified. */
const LOCAL_TEST = 'LOCAL TEST control: this local server’s test file names the NFT’s current controller. Proofy has not verified who holds the NFT.'

const CONFLICT = DESIGN_REFUSALS.action_conflict

/** The building as the city draws it, with `design`: the same sprite, at its real tier and progress. Decorative: the caption says what it shows. Also the property legacy's preview. */
export function DesignThumb({ city, buildingId, design, caption, testId }: { city: LoadedBrandCity; buildingId: string; design: PropertyDesign; caption: string; testId: string }) {
  const b = useMemo(() => withPropertyDesigns(city.state, { [buildingId]: design }).buildings[buildingId], [city.state, buildingId, design])
  const total = totalBuilt(b)
  const top = buildingHeightPx(total) + roofHeightPx(design.roof, 1) + 46
  return (
    <figure
      className="design-thumb"
      data-testid={testId}
      data-facade={design.facade}
      data-roof={design.roof}
      data-windows={design.windows}
      data-lighting={design.lighting}
      data-entrance={design.entrance}
      data-landscaping={design.landscaping}
    >
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

/** A view's saved design (or the catalog's default), as it is drawn: its six identifiers and nothing else (an earlier catalog's design with the standard treatments it was saved with). */
const savedOf = (view: RehearsalDesignView): PropertyDesign => appearanceOf(view.saved ?? view.catalog.default)

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
  const design = view ? savedOf(view) : null
  const editable = !!view && view.open && view.control === 'viewer'
  return (
    <div
      className="fund-box design-card"
      data-testid="design-card"
      data-state={view ? 'ready' : answer ? 'unavailable' : 'loading'}
      data-control={view?.control ?? ''}
      data-revision={view?.saved?.revision ?? 0}
      data-catalog={view?.saved?.catalog ?? ''}
      data-facade={design?.facade ?? ''}
      data-roof={design?.roof ?? ''}
      data-windows={design?.windows ?? ''}
      data-lighting={design?.lighting ?? ''}
      data-entrance={design?.entrance ?? ''}
      data-landscaping={design?.landscaping ?? ''}
    >
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
            {view.saved && catalogNote(view.saved.catalog) && ` (${catalogNote(view.saved.catalog)})`}
          </p>
          {tier === 0 && (
            <p className="muted small" data-testid="design-tier0-note">
              Tier 0 foundation: the facade shows now; the roof, windows, lighting, entrance and landscaping appear once the building reaches Tier 1.
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
 * THE ARCHITECT DESIGN VIEW: choose a facade, a roof, windows, lighting, an entrance and landscaping, see them on the city
 * and beside the saved version (and which categories change), then save them as one revision or cancel. `onPreview` is called with each choice that differs from the saved design (and null when it no longer does);
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
  const [group, setGroup] = useState(GROUPS[0].key)
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
  /** The categories the preview changes, in the order the view lists them. */
  const changes = choice && saved ? DESIGN_SLOTS.filter((slot) => choice[slot] !== saved[slot]) : []
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
    const sent = book.next({
      propertyId,
      baseRevision: view.saved?.revision ?? 0,
      catalog: view.catalog.key,
      facade: choice.facade,
      roof: choice.roof,
      windows: choice.windows,
      lighting: choice.lighting,
      entrance: choice.entrance,
      landscaping: choice.landscaping,
    })
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
    // This property as saved now. After a save here, or a refusal that moved it on (or an earlier editor's save that was
    // never made), the choice follows the saved design.
    const reset = (r.ok && !elsewhere) || (!r.ok && (r.problem.code === 'design_stale' || r.problem.code === 'design_retired'))
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
      ? `Your earlier save is confirmed: revision ${done.design.revision} (${designName(appearanceOf(done.design))}) on another property. You can save here now.`
      : done.fresh
        ? `Saved: ${designName(appearanceOf(done.design))}, revision ${done.design.revision}. The city shows it now, for everyone.`
        : `Already saved by this save: ${designName(appearanceOf(done.design))}, revision ${done.design.revision}. Nothing more was saved.`
    : problem
      ? problem.message
      : ''

  return (
    <section ref={heading} tabIndex={-1} className="panel architect-design" aria-label={`Architect design of ${scene.buildingLabel(b)}`} data-testid="design-panel" data-building={buildingId} data-state={view ? 'ready' : problem ? 'unavailable' : 'loading'}>
      <PanelHeader kicker="ARCHITECT DESIGN" title={scene.buildingLabel(b)} onBack={cancel} onClose={onClose} />
      <div className="row-between architect-tagline">
        <p className="small home-lede">
          {d.title} · Tier {tier}. Choose its building, details and street level: the city shows your choice on this building as you go. Nothing is saved until you save.
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
          <p className="small design-changes" data-testid="design-changes" data-count={changes.length}>
            {changes.length === 0
              ? 'Preview matches the saved design.'
              : `Preview changes ${changes.map((slot) => `${SLOT_NAMES[slot].toLowerCase()} (${nameOf(slot, saved[slot])} → ${nameOf(slot, choice[slot])})`).join(', ')}. Not saved yet.`}
          </p>
          {tier === 0 && (
            <p className="muted small" data-testid="design-tier0-note">
              Tier 0 foundation: the facade shows now; the roof, windows, lighting, entrance and landscaping are drawn once the building reaches Tier 1, and keep growing with it.
            </p>
          )}
          <DesignTabs
            group={group}
            onGroup={setGroup}
            counts={Object.fromEntries(GROUPS.map((g) => [g.key, g.slots.filter((slot) => changes.includes(slot)).length]))}
            render={(g) =>
              g.slots.map((slot) => (
                <OptionList key={slot} slot={slot} catalog={view.catalog} chosen={choice[slot]} disabled={!editable || busy} onChoose={(id) => setChoice({ ...choice, [slot]: id })} />
              ))
            }
          />
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
                  <li
                    key={h.revision}
                    data-testid="design-history-entry"
                    data-revision={h.revision}
                    data-by={h.by}
                    data-catalog={h.catalog}
                    data-facade={h.facade}
                    data-roof={h.roof}
                    data-windows={h.windows ?? ''}
                    data-lighting={h.lighting ?? ''}
                    data-entrance={h.entrance ?? ''}
                    data-landscaping={h.landscaping ?? ''}
                  >
                    <span className="grow">
                      {revisionName(h)}{' '}
                      · {h.by === 'viewer' ? 'You' : 'Another player'}
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

/**
 * The view's three tabs (ARIA tabs: arrow keys, Home and End move between them, and only the chosen one is in the tab
 * order). Each tab says how many of its categories the preview changes; only the chosen tab's categories are shown.
 */
function DesignTabs({ group, onGroup, counts, render }: { group: string; onGroup: (key: string) => void; counts: Readonly<Record<string, number>>; render: (g: (typeof GROUPS)[number]) => ReactNode }) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: KeyboardEvent, i: number) => {
    const next = e.key === 'ArrowRight' ? (i + 1) % GROUPS.length : e.key === 'ArrowLeft' ? (i + GROUPS.length - 1) % GROUPS.length : e.key === 'Home' ? 0 : e.key === 'End' ? GROUPS.length - 1 : -1
    if (next < 0) return
    e.preventDefault()
    onGroup(GROUPS[next].key)
    tabs.current[next]?.focus()
  }
  return (
    <div className="design-groups">
      <div className="design-tabs" role="tablist" aria-label="Design categories" data-testid="design-tabs">
        {GROUPS.map((g, i) => (
          <button
            key={g.key}
            ref={(el) => {
              tabs.current[i] = el
            }}
            type="button"
            role="tab"
            id={`design-tab-${g.key}`}
            aria-selected={group === g.key}
            aria-controls={`design-group-${g.key}`}
            tabIndex={group === g.key ? 0 : -1}
            className={`design-tab${group === g.key ? ' on' : ''}`}
            onClick={() => onGroup(g.key)}
            onKeyDown={(e) => onKey(e, i)}
            data-testid={`design-tab-${g.key}`}
            data-changes={counts[g.key] ?? 0}
          >
            <b>{g.name}</b>
            <span className="muted small">
              {g.slots.map((slot) => SLOT_NAMES[slot]).join(' · ')}
              {counts[g.key] ? <span className="design-tab-count"> · {counts[g.key]} changed</span> : null}
            </span>
          </button>
        ))}
      </div>
      {GROUPS.map((g) => (
        <div key={g.key} role="tabpanel" id={`design-group-${g.key}`} aria-labelledby={`design-tab-${g.key}`} hidden={group !== g.key} data-testid={`design-group-${g.key}`}>
          {render(g)}
        </div>
      ))}
    </div>
  )
}

/** One category's choices, as radio options with a small glyph each. */
function OptionList({ slot, catalog, chosen, disabled, onChoose }: { slot: DesignSlot; catalog: RehearsalDesignCatalog; chosen: string; disabled: boolean; onChoose: (id: string) => void }) {
  return (
    <fieldset className="design-options" disabled={disabled} data-testid={FIELDSET_IDS[slot]}>
      <legend>{LEGENDS[slot]}</legend>
      {catalog[CATALOG_LISTS[slot]].map((id) => (
        <label key={id} className={`design-option${chosen === id ? ' on' : ''}`} data-testid={`design-${slot}-${id}`}>
          <input type="radio" name={`design-${slot}`} value={id} checked={chosen === id} onChange={() => onChoose(id)} />
          <OptionGlyph slot={slot} id={id} />
          <span className="design-option-text">
            <b>{nameOf(slot, id)}</b>
            <span className="muted small">{LABELS[slot][id]?.note}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

function OptionGlyph({ slot, id }: { slot: DesignSlot; id: string }) {
  switch (slot) {
    case 'facade': {
      const pal = FACADE_PALETTES[id] ?? FACADE_PALETTES.slate
      return (
        <svg className="design-swatch" viewBox="-12 -14 24 24" width="28" height="28" aria-hidden="true">
          <polygon points="0,-12 10,-6 0,0 -10,-6" fill={pal.top} />
          <polygon points="-10,-6 0,0 0,10 -10,4" fill={pal.left} />
          <polygon points="0,0 10,-6 10,4 0,10" fill={pal.right} />
          <line x1={-10} y1={-1} x2={0} y2={5} stroke={pal.trim} strokeWidth={1} />
          <line x1={0} y1={5} x2={10} y2={-1} stroke={pal.trim} strokeWidth={1} />
        </svg>
      )
    }
    case 'roof':
      return <RoofGlyph kind={id} />
    case 'windows':
      return <WindowGlyph kind={id} />
    case 'lighting':
      return <LightingGlyph kind={id} />
    case 'entrance':
      return <EntranceGlyph kind={id} />
    case 'landscaping':
      return <LandscapingGlyph kind={id} />
  }
}

/** A small elevation of each entrance treatment, for the option list only (the previews above draw the real one). */
function EntranceGlyph({ kind }: { kind: string }) {
  const door = LIGHTING_COLORS.warm.accent
  const trim = '#8391ab'
  return (
    <svg className="design-swatch" viewBox="-12 -12 24 24" width="28" height="28" aria-hidden="true">
      <rect x={-11} y={-11} width={22} height={22} fill="#3b475e" />
      {kind === 'standard' && <rect x={-2.5} y={2} width={5} height={9} fill={door} opacity={0.85} />}
      {kind === 'canopy' && (
        <>
          <rect x={-3} y={1} width={6} height={10} fill={door} opacity={0.85} />
          <polygon points="-7,-1 7,-1 5.5,2 -5.5,2" fill={trim} />
        </>
      )}
      {kind === 'arched' && (
        <>
          <path d="M-4 11 V3 A4 4 0 0 1 4 3 V11 Z" fill={door} opacity={0.9} />
          <path d="M-5.3 11 V3 A5.3 5.3 0 0 1 5.3 3 V11" fill="none" stroke={trim} strokeWidth={1.2} />
        </>
      )}
      {kind === 'portico' && (
        <>
          <rect x={-3.5} y={2} width={7} height={9} fill={door} opacity={0.8} />
          {[-8, -4.5, 4.5, 8].map((x) => (
            <rect key={x} x={x - 0.8} y={0} width={1.6} height={11} fill={trim} />
          ))}
          <polygon points="-10,0 0,-5 10,0" fill={trim} />
        </>
      )}
    </svg>
  )
}

/** A small plan of each landscaping treatment, for the option list only. */
function LandscapingGlyph({ kind }: { kind: string }) {
  return (
    <svg className="design-swatch" viewBox="-12 -12 24 24" width="28" height="28" aria-hidden="true">
      <polygon points="0,-10 11,-1 0,8 -11,-1" fill="#1a1f2c" stroke="#2d3446" />
      <polygon points="0,-6 5,-2 0,2 -5,-2" fill="#3b475e" />
      {kind === 'garden' && (
        <>
          <circle cx={6} cy={1} r={2.6} fill="#1f6b4a" />
          <circle cx={2} cy={4.5} r={2} fill="#2c8a60" />
          <circle cx={-5} cy={2.5} r={1.4} fill="#ff7aa8" />
          <circle cx={-2.5} cy={4.5} r={1.4} fill="#ffd36b" />
        </>
      )}
      {kind === 'courtyard' && (
        <>
          <rect x={-6.5} y={1.5} width={3} height={2} fill="#8e8a82" />
          <rect x={-2.5} y={4} width={3} height={2} fill="#8e8a82" />
          <circle cx={6} cy={0} r={1.5} fill="#ffe3a0" />
          <circle cx={3} cy={3.5} r={1.5} fill="#ffe3a0" />
          <rect x={0.5} y={5.5} width={4} height={1.2} fill="#9a6b43" />
        </>
      )}
    </svg>
  )
}

/** A small elevation of each window treatment, for the option list only (the previews above draw the real one). */
function WindowGlyph({ kind }: { kind: string }) {
  const glow = LIGHTING_COLORS.warm.window
  const cells = [-5, 1]
  return (
    <svg className="design-swatch" viewBox="-10 -12 20 24" width="28" height="28" aria-hidden="true">
      <rect x={-9} y={-11} width={18} height={22} fill="#3b475e" />
      {kind === 'ribbon' && [-8, -1, 6].map((y) => <rect key={y} x={-8} y={y} width={16} height={3} fill={glow} />)}
      {kind === 'arched' &&
        cells.flatMap((x) => [-9, 1].map((y) => <path key={`${x}${y}`} d={`M${x} ${y + 8} V${y + 3} A2 2 0 0 1 ${x + 4} ${y + 3} V${y + 8} Z`} fill={glow} />))}
      {kind === 'lattice' &&
        cells.flatMap((x) =>
          [-9, 1].map((y) => (
            <g key={`${x}${y}`} fill={glow}>
              <rect x={x} y={y} width={1.8} height={3.4} />
              <rect x={x + 2.2} y={y} width={1.8} height={3.4} />
              <rect x={x} y={y + 3.9} width={1.8} height={3.4} />
              <rect x={x + 2.2} y={y + 3.9} width={1.8} height={3.4} />
            </g>
          )),
        )}
      {kind === 'grid' && cells.flatMap((x) => [-9, -3, 3].map((y) => <rect key={`${x}${y}`} x={x + 0.5} y={y} width={3} height={4.4} fill={glow} />))}
    </svg>
  )
}

/** A small elevation of each lighting treatment, for the option list only. */
function LightingGlyph({ kind }: { kind: string }) {
  const lit = kind === 'cool' ? LIGHTING_COLORS.cool : LIGHTING_COLORS.warm
  return (
    <svg className="design-swatch" viewBox="-10 -12 20 24" width="28" height="28" aria-hidden="true">
      <rect x={-9} y={-11} width={18} height={22} fill="#3b475e" />
      {[-5, 1].flatMap((x) => [-7, -1, 5].map((y) => <rect key={`${x}${y}`} x={x + 0.5} y={y} width={3} height={3.6} fill={lit.window} opacity={0.85} />))}
      {kind !== 'standard' && (
        <>
          <rect x={-9} y={-11} width={18} height={1.4} fill={lit.accent} />
          <path d="M-5.5 11 L-4 11 L-1.5 -2 L-8 -2 Z M4 11 L5.5 11 L8 -2 L1.5 -2 Z" fill={lit.accent} opacity={0.35} />
        </>
      )}
    </svg>
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
