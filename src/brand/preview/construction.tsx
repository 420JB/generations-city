import { useEffect, useRef, useState } from 'react'
import { ProgressBar } from '../../ui/common'
import type { ConstructionRole, RehearsalConstruction, RehearsalConstructionView } from '../../protocol/playRehearsal'
import type { ArchitectLoad } from './architect'
import type { ClaimProblem } from './claim'
import { settlementOf, type ConstructionPress, type PressBook } from './constructionPress'
import { ConstructionNote } from './home'
import type { LegacyLoad } from './legacy'

/**
 * LOCAL TEST CONSTRUCTION on a stored property's panel (P1-C2-E3A; Tier 2 and the next goal in P1-C2-E3B). Only the Proofy Play page passes access to it, and only
 * when its server runs the local rehearsal. Everything shown is what the server answered: the tier and progress the city
 * stores, the viewer's local test credits, who invested (the current owner, earlier owners, patrons) and the history. The
 * one action asks the server to build one fixed step of the provisional local recipe; the page names only the property,
 * the role the server says this viewer has, and a fresh id per press. No amount, price or tier is ever sent, and nothing
 * here is RF, Proofy Points or verified NFT ownership.
 *
 * A press whose answer is not known is asked about again with the same id before anything new is spent
 * (`constructionPress.ts`): the card says it could not confirm the build, never that nothing was built.
 *
 * The next goal is the server's recipe as it answered it: the tier the property reaches next, the lifetime units that
 * reach it and how many steps are left, all PROVISIONAL LOCAL TEST tuning. Each history entry names the recipe that
 * computed it, so a step built by an earlier recipe reads as what it was.
 */

export type ConstructionLoad = { ok: true; view: RehearsalConstructionView } | { ok: false; problem: ClaimProblem }
/** `view`: null when the server built but could not read the property again; the card reads it itself. */
export type ConstructionOutcome = { ok: true; fresh: boolean; construction: RehearsalConstruction; view: RehearsalConstructionView | null } | { ok: false; problem: ClaimProblem }

export interface ConstructionAccess {
  /** The property's construction as the server answers it for this viewer. */
  load(propertyId: string): Promise<ConstructionLoad>
  /** One press, exactly as the press book keeps it: a new press's fresh id, or an unresolved press's own id again. */
  build(propertyId: string, role: ConstructionRole, actionId: string): Promise<ConstructionOutcome>
  /** The presses of the player and world this page acts for. */
  presses(): PressBook
  /** The signed-in player's own construction record in this city (Architect activity). */
  activity(): Promise<ArchitectLoad>
  /** A property's legacy as the server answers it for this viewer (P1-C2-E5A). Read only. */
  legacy(propertyId: string): Promise<LegacyLoad>
}

const ROLE: Record<ConstructionRole, string> = { owner: 'Owner', patron: 'Patron' }

/** An answer that does not say whether the press built: never "nothing was built". */
const UNCONFIRMED = 'We could not confirm this build. It may already have been built and paid for. Check it with the same press: one press is never built or paid twice.'
const UNCONFIRMED_ELSEWHERE =
  'We could not confirm your last build, on another of this city’s properties. It may already have been built and paid for. Check it before building anything else: one press is never built or paid twice.'
const CONFLICT: ClaimProblem = { message: 'This press’s id is already recorded for a construction that does not match this request, so nothing more was built or spent for it. That construction may be this build, recorded earlier: check this property’s history before you press again.', kind: 'retry', code: 'action_conflict' }

/** `tier`: the tier the page draws, for a city where construction is not open (the standing note says so, as before). */
export function ConstructionCard({ propertyId, tier, access, color, onArchitect }: { propertyId: string; tier: number; access: ConstructionAccess; color: string; onArchitect?: () => void }) {
  const [view, setView] = useState<RehearsalConstructionView | null>(null)
  const [problem, setProblem] = useState<ClaimProblem | null>(null)
  const [busy, setBusy] = useState(false)
  /** `elsewhere`: the answer was for an earlier press on another property, asked about from this card. */
  const [done, setDone] = useState<{ construction: RehearsalConstruction; fresh: boolean; elsewhere: boolean } | null>(null)
  /** The player's press whose answer is not known (this page's, or one kept from before a reload): asked about before any new press. */
  const [unresolved, setUnresolved] = useState<ConstructionPress | null>(() => access.presses().unresolved())
  /** A press is out: a second click before its answer sends nothing. */
  const sending = useRef(false)

  useEffect(() => {
    let live = true
    void access.load(propertyId).then((r) => {
      if (!live) return
      if (r.ok) setView(r.view)
      else setProblem(r.problem)
    })
    return () => {
      live = false
    }
  }, [access, propertyId])

  async function build(role: ConstructionRole) {
    if (sending.current) return
    sending.current = true
    const book = access.presses()
    // An unresolved press is sent again exactly as it was first sent (its property, role and id), whatever was pressed.
    const sent = book.next(propertyId, role, view ? { recipe: view.recipe.key, tier: view.property.tier } : null)
    const elsewhere = sent.propertyId !== propertyId
    setBusy(true)
    setProblem(null)
    setDone(null)
    const r = await access.build(sent.propertyId, sent.role, sent.actionId)
    const settled = settlementOf(r)
    if (settled !== 'unknown') book.settle(sent)
    setUnresolved(book.unresolved())
    if (r.ok) setDone({ construction: r.construction, fresh: r.fresh, elsewhere })
    else if (settled === 'conflict') setProblem(CONFLICT)
    else if (settled === 'settled') setProblem(elsewhere ? { ...r.problem, message: `Your earlier build, on another property, was not made: ${r.problem.message}` } : r.problem)
    else setProblem({ ...r.problem, message: elsewhere ? UNCONFIRMED_ELSEWHERE : UNCONFIRMED, kind: 'retry' })
    // This property as stored now: from the answer when it carries this property's view, else read again.
    if (r.ok && r.view && !elsewhere) setView(r.view)
    else {
      const again = await access.load(propertyId)
      if (again.ok) setView(again.view)
    }
    setBusy(false)
    sending.current = false
  }

  const pendingHere = unresolved !== null && unresolved.propertyId === propertyId
  /** While a press is unresolved, the one action is asking about it again: available whatever the property's standing. */
  const check = unresolved && (
    <>
      <button type="button" className="btn primary" disabled={busy} onClick={() => void build(unresolved.role)} data-testid="construction-action" data-role={unresolved.role} data-pending={pendingHere ? 'here' : 'elsewhere'}>
        {busy ? 'Checking…' : pendingHere ? 'Check this build · same press' : 'Check your earlier build first'}
      </button>
      {!busy && !problem && (
        <p className="small construction-feedback" data-testid="construction-unresolved" data-pending={pendingHere ? 'here' : 'elsewhere'}>
          {pendingHere ? UNCONFIRMED : UNCONFIRMED_ELSEWHERE}
        </p>
      )}
    </>
  )
  const outcome = done ? (done.fresh ? 'built' : 'repeat') : problem ? (unresolved ? 'unconfirmed' : problem.code === 'action_conflict' ? 'conflict' : problem.kind) : unresolved ? 'unconfirmed' : ''
  const said = done
    ? done.elsewhere
      ? `Your earlier build is confirmed: ${done.fresh ? 'built' : 'it had built'} ${done.construction.units} test units on another property, recorded at city sequence ${done.construction.sequence}. Nothing more was spent. You can build here now.`
      : done.fresh
        ? `Built ${done.construction.units} test units as ${done.construction.role === 'owner' ? 'owner' : 'a patron'}${done.construction.tierAfter > done.construction.tierBefore ? `: Tier ${done.construction.tierAfter} reached` : ''}. Recorded at city sequence ${done.construction.sequence}.`
        : `Already built by this press, at city sequence ${done.construction.sequence}${done.construction.tierAfter > done.construction.tierBefore ? `, when it reached Tier ${done.construction.tierAfter}` : ''}. Nothing more was spent.`
    : problem
      ? problem.message
      : ''

  // Not open in this city: exactly what a property's panel says where nothing can be built.
  if (!view && problem?.code === 'construction_not_open') return <ConstructionNote tier={tier} />
  if (!view)
    return (
      <div className="fund-box construction-card" data-testid="construction-card" data-state={problem ? 'unavailable' : 'loading'}>
        <ConstructionHeading />
        <p className="small" role="status" data-testid="construction-status" data-outcome={outcome}>
          {done || (problem && unresolved) ? said : problem ? problem.message : 'Reading this property’s construction…'}
        </p>
        {check}
      </div>
    )

  const { property: p, standing, credits, investment, control, contributors } = view
  const top = p.nextTierAt === null
  const floor = p.tier === 0 ? 0 : view.recipe.tierThresholds[p.tier - 1]
  const progress = top ? 1 : (p.built - floor) / (p.nextTierAt! - floor)
  const step = standing.kind === 'complete' ? null : standing
  /** Steps of the recipe's size left to the next tier (the last one may be smaller). */
  const stepsLeft = top ? 0 : Math.ceil((p.nextTierAt! - p.built) / view.recipe.unitsPerAction)
  // Read only for anyone this local file gives no test credits to: no control that cannot do anything.
  const canAct = step !== null && (credits.available > 0 || credits.recorded > 0 || view.viewer.ownerUnits + view.viewer.patronUnits > 0)
  return (
    <div
      className="fund-box construction-card"
      data-testid="construction-card"
      data-state="ready"
      data-tier={p.tier}
      data-built={p.built}
      data-next-tier-at={p.nextTierAt ?? ''}
      data-max-tier={p.maxTier}
      data-recipe={view.recipe.key}
      data-control={control}
      data-standing={standing.kind}
    >
      <ConstructionHeading />
      <p className="small" data-testid="construction-tier" data-tier={p.tier}>
        <b>Tier {p.tier}</b> · {p.built} test units built
        {top ? ` · Tier ${p.tier} is the highest tier this local rehearsal builds.` : ` · ${p.nextTierAt! - p.built} more to reach Tier ${p.tier + 1}.`}
      </p>
      <ProgressBar value={progress} color={color} label={top ? `Tier ${p.tier} complete` : `Test construction progress to Tier ${p.tier + 1}`} />
      <p className="muted small" data-testid="construction-goal" data-goal-tier={top ? '' : p.tier + 1} data-steps-left={stepsLeft}>
        {top
          ? `Complete: Tier ${p.tier} is the last tier of the local test recipe (${view.recipe.tierThresholds.join(' · ')} units). Nothing more can be built here in this rehearsal.`
          : `Next goal: Tier ${p.tier + 1} at ${p.nextTierAt} lifetime units, ${stepsLeft} more ${stepsLeft === 1 ? 'step' : 'steps'} by anyone. Provisional LOCAL TEST goal, not a final tier rule.`}
      </p>
      <p className="muted small" data-testid="construction-control" data-control={control}>
        {control === 'viewer'
          ? 'This local server’s test file names you as this NFT’s current controller, so you build here as its owner. Test data, not verified ownership.'
          : control === 'other'
            ? `This local server’s test file names another player as this NFT’s current controller.${step ? ' You can contribute as a patron.' : ''}`
            : `No current controller is named for this NFT on this local server, so nobody can build as its owner.${step ? ' You can contribute as a patron.' : ''}`}
      </p>
      <dl className="stat-grid construction-stats">
        <div>
          <dt>Your test credits</dt>
          <dd data-testid="construction-credits" data-available={credits.available}>
            {credits.available}
          </dd>
        </div>
        <div>
          <dt>One step</dt>
          <dd data-testid="construction-cost" data-units={view.recipe.unitsPerAction}>
            {step ? step.units : view.recipe.unitsPerAction} test credits
          </dd>
        </div>
      </dl>
      <p className="muted small" id="construction-cost-note" data-testid="construction-cost-note">
        LOCAL TEST credits only: valueless, granted by this local server’s test file, never RF or Proofy Points. One step builds {view.recipe.unitsPerAction} test units and costs the
        same; that number is provisional local tuning, not a price.
        {credits.pending > 0 && ` ${credits.pending} of your credits are granted by the file and recorded when you first build.`}
      </p>
      {check}
      {!unresolved && step && canAct && (
        <button
          type="button"
          className="btn primary"
          disabled={busy || standing.kind !== 'ready'}
          onClick={() => void build(step.role)}
          data-testid="construction-action"
          data-role={step.role}
          aria-describedby="construction-cost-note"
        >
          {busy ? 'Building…' : step.role === 'owner' ? `Test construction · ${step.units} TEST credits` : `Test patron contribution · ${step.units} TEST credits`}
        </button>
      )}
      {!unresolved && step && canAct && standing.kind === 'insufficient' && (
        <p className="small" data-testid="construction-insufficient">
          You have {credits.available} test credits here; one step costs {step.units}.
        </p>
      )}
      {!unresolved && step && !canAct && (
        <p className="muted small" data-testid="construction-read-only">
          This local server’s test file grants you no test credits here, so you can look but not build.
        </p>
      )}
      <p className="small construction-feedback" role="status" aria-live="polite" data-testid="construction-status" data-outcome={outcome}>
        {said}
      </p>
      <dl className="stat-grid construction-investment" data-testid="construction-investment">
        <div>
          <dt>Current owner</dt>
          <dd data-testid="investment-current-owner">{investment.currentOwner}</dd>
        </div>
        <div>
          <dt>Previous owners</dt>
          <dd data-testid="investment-previous-owners">{investment.previousOwners}</dd>
        </div>
        <div>
          <dt>Patrons</dt>
          <dd data-testid="investment-community">{investment.community}</dd>
        </div>
        <div>
          <dt>Lifetime</dt>
          <dd data-testid="investment-total">{investment.total}</dd>
        </div>
      </dl>
      <p className="muted small" data-testid="construction-contributors" data-owners={contributors.owners} data-patrons={contributors.patrons}>
        {investment.total === 0
          ? 'Nobody has built here yet.'
          : `Built by ${contributors.owners} ${contributors.owners === 1 ? 'owner' : 'owners'} and ${contributors.patrons} ${contributors.patrons === 1 ? 'patron' : 'patrons'} over its lifetime.`}
      </p>
      <p className="muted small" data-testid="construction-viewer-progress" data-owner-units={view.viewer.ownerUnits} data-patron-units={view.viewer.patronUnits}>
        You in this city: {view.viewer.ownerUnits} units as an owner (your own builder progression) · {view.viewer.patronUnits} as a patron (develops others’ properties, not your own
        progression).
        {onArchitect && (
          <>
            {' '}
            <button type="button" className="link-btn" onClick={onArchitect} data-testid="construction-architect">
              Your Architect activity
            </button>
          </>
        )}
      </p>
      {view.history.length > 0 ? (
        <>
          <p className="muted small home-sub">Construction history, newest first</p>
          <ul className="patron-list" data-testid="construction-history" data-count={view.historyCount}>
            {view.history.map((h) => (
              <li key={h.sequence} data-testid="construction-history-entry" data-role={h.role} data-by={h.by} data-sequence={h.sequence} data-recipe={h.recipe}>
                <span className="grow">
                  {ROLE[h.role]} · {h.by === 'viewer' ? 'You' : 'Another player'} · +{h.units} test units{h.era !== null ? ` · control era ${h.era}` : ''}
                  {h.recipe !== view.recipe.key && <span className="muted small"> · earlier test recipe</span>}
                </span>
                <span className="muted small">
                  Tier {h.tierAfter} · #{h.sequence}
                </span>
              </li>
            ))}
          </ul>
          {view.historyCount > view.history.length && <p className="muted small">and {view.historyCount - view.history.length} earlier.</p>}
        </>
      ) : (
        <p className="muted small" data-testid="construction-history-none">
          Nothing has been built here yet: a Tier 0 foundation, as every new property starts.
        </p>
      )}
    </div>
  )
}

function ConstructionHeading() {
  return (
    <div className="row-between">
      <h3>Construction</h3>
      <span className="sim-tag" data-testid="construction-test-tag">
        LOCAL TEST
      </span>
    </div>
  )
}
