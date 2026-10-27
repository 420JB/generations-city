import { useEffect, useRef, useState } from 'react'
import type { ConstructionRole, RehearsalConstruction, RehearsalConstructionView } from '../../protocol/playRehearsal'
import type { ClaimProblem } from './claim'
import type { ConstructionAccess } from './construction'
import { settlementOf, type ConstructionPress } from './constructionPress'

/**
 * One property's LOCAL TEST construction as a page holds it (P1-E6): read once, pressed through the player's press book
 * (`constructionPress.ts`) behind one guard, and shared by the property panel's action bar, its construction card and its
 * construction records (`construction.tsx`, `panels.tsx`). Nothing here changes what a press sends or how its answer is read.
 */

/** An answer that does not say whether the press built: never "nothing was built". */
export const UNCONFIRMED = 'We could not confirm this build. It may already have been built and paid for. Check it with the same press: one press is never built or paid twice.'
export const UNCONFIRMED_ELSEWHERE =
  'We could not confirm your last build, on another of this city’s properties. It may already have been built and paid for. Check it before building anything else: one press is never built or paid twice.'
const CONFLICT: ClaimProblem = { message: 'This press’s id is already recorded for a construction that does not match this request, so nothing more was built or spent for it. That construction may be this build, recorded earlier: check this property’s history before you press again.', kind: 'retry', code: 'action_conflict' }

/**
 * One property's construction as this page holds it (P1-E6: shared by the panel's action bar, its construction card and its
 * construction records, so the property is read once and every press goes through the one press book and guard).
 */
export interface ConstructionState {
  propertyId: string
  view: RehearsalConstructionView | null
  problem: ClaimProblem | null
  busy: boolean
  /** `elsewhere`: the answer was for an earlier press on another property, asked about from this card. */
  done: { construction: RehearsalConstruction; fresh: boolean; elsewhere: boolean } | null
  /** The player's press whose answer is not known (this page's, or one kept from before a reload): asked about before any new press. */
  unresolved: ConstructionPress | null
  build(role: ConstructionRole): Promise<void>
}

/**
 * A property's construction, read once and pressed through the player's press book. Keyed by the caller per property.
 * Without access (a city whose server runs no local rehearsal) nothing is read and nothing can be pressed.
 */
export function useConstruction(access: ConstructionAccess | null, propertyId: string): ConstructionState {
  const [view, setView] = useState<RehearsalConstructionView | null>(null)
  const [problem, setProblem] = useState<ClaimProblem | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<ConstructionState['done']>(null)
  const [unresolved, setUnresolved] = useState<ConstructionPress | null>(() => access?.presses().unresolved() ?? null)
  /** A press is out: a second click before its answer sends nothing (from any of the panel's buttons). */
  const sending = useRef(false)

  useEffect(() => {
    if (!access) return
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
    if (sending.current || !access) return
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

  return { propertyId, view, problem, busy, done, unresolved, build }
}

/**
 * The one construction action the viewer has here now, as the card offers it (`label`) and as the panel's action bar names
 * it (`short`): null where there is none (read only, complete, not open, loading).
 */
export function constructionActionOf(c: ConstructionState): { role: ConstructionRole; label: string; short: string; disabled: boolean } | null {
  const { view, unresolved, busy } = c
  if (unresolved) {
    const label = busy ? 'Checking…' : unresolved.propertyId === c.propertyId ? 'Check this build · same press' : 'Check your earlier build first'
    return { role: unresolved.role, label, short: label, disabled: busy }
  }
  if (!view) return null
  const { standing, credits } = view
  const step = standing.kind === 'complete' ? null : standing
  // Read only for anyone this local file gives no test credits to: no control that cannot do anything.
  const canAct = step !== null && (credits.available > 0 || credits.recorded > 0 || view.viewer.ownerUnits + view.viewer.patronUnits > 0)
  if (!step || !canAct) return null
  return {
    role: step.role,
    label: busy ? 'Building…' : step.role === 'owner' ? `Test construction · ${step.units} TEST credits` : `Test patron contribution · ${step.units} TEST credits`,
    short: busy ? 'Building…' : step.role === 'owner' ? `Build · ${step.units} TEST credits` : `Contribute · ${step.units} TEST credits`,
    disabled: busy || standing.kind !== 'ready',
  }
}

