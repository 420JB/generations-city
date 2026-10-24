import { useEffect, useRef, useState, type ReactNode } from 'react'
import { isFoundingWard, wardName } from '../../game/allocation'
import { sceneDistrict } from '../../ui/city/scene'
import { PanelHeader, SceneDistrictChip } from '../../ui/common'
import type { LoadedBrandCity } from '../load'
import { ordinal } from './properties'
import { CLAIM_WINDOW_MS, claimCountdown, claimStep, NEXT_ACTION, PROBLEM_TITLES, RULE_REFUSALS, spokenCountdown, type ClaimProblem, type ClaimStep, type Countdown } from './claim'
import type { Placement } from './PreviewApp'

/**
 * LOCAL PROPERTY REHEARSAL, as the standard city page presents it (P1-C2-B2B; district tickets
 * P1-C2-D1). Only the Proofy Play page passes one, and only when the Rare City server runs a local
 * rehearsal: the test NFTs and their district rules come from a local file on that server, never
 * from a verified wallet or Proofy. The player does not choose a district: the server assigns one
 * (a ticket from the city's rotation, or an explicit rule's district for the NFT they select), and
 * the player chooses the exact plot in it. Everything shown here is decided again by the server,
 * under the city's lock; nothing here authorizes anything.
 */

/** A test NFT the server lists for the player, of one of this city's collections and not placed yet. */
export interface RehearsalNft {
  /** CAIP-19 id. */
  asset: string
  collectionName: string
  /** Canonical decimal, exact. */
  tokenId: string
}

export type RehearsalResult = { ok: true; buildingId: string; fresh: boolean; sequence: number } | ({ ok: false } & ClaimProblem)

/** The district ticket the server issued the player, as the page shows it. */
export interface AssignedTicket {
  id: string
  districtKey: string
  /** `fallback`: the city's citywide rotation. `rule`: an explicit rule for one NFT. */
  kind: 'fallback' | 'rule'
  slot: { ordinal: number; generation: number; epoch: number } | null
  rule: { ref: string; asset: string } | null
  /** A restricted district: its Proofy rule, and that the positive answer was local test data (never verified). */
  authorization: { verificationRuleId: number; source: 'local-fixture' } | null
  expiresAt: string
}

export type TicketResult = { ok: true; ticket: AssignedTicket | null } | ({ ok: false } & ClaimProblem)

export interface PlacementRehearsal {
  /** This city's unplaced test NFTs for the player. */
  nfts: readonly RehearsalNft[]
  /** How many of the player's test NFTs for this city already stand in it. */
  placed: number
  /** The district the server assigned the player now, or null: none held (enter to be assigned one). */
  ticket: AssignedTicket | null
  /** Why the player holds no ticket (or why the last ticket call was refused), when the server said. */
  ticketNote: ClaimProblem | null
  /** The server's clock minus this browser's, from the answer that carried the ticket: corrects the countdown only. */
  clockOffset: number
  /**
   * No ticket, because every district of this city is restricted: the district depends on the NFT, so the player selects
   * one first (`assign` without a ticket) and the server assigns its district if a rule and their rule result allow it.
   */
  awaitingAsset: boolean
  /** Enter the claim flow: the server assigns a district (or returns the one held). */
  enter(): Promise<TicketResult>
  /** The NFT the player selected: an explicit rule for it may assign another district. */
  assign(asset: string): Promise<TicketResult>
  /** Leave the claim flow: the district is released for the next entrant. */
  leave(): Promise<TicketResult>
  /** Ask the server to place one, with the ticket held. Resolves once the page shows the city as stored again. */
  activate(asset: string, plotId: string): Promise<RehearsalResult>
}

/** How the server assigned a ticket's district, in words. */
function assignmentBasis(ticket: AssignedTicket): string {
  if (ticket.kind !== 'rule') return `the city's rotation, slot ${(ticket.slot?.ordinal ?? 0) + 1}`
  const restricted = ticket.authorization ? `, in a restricted district: Proofy rule ${ticket.authorization.verificationRuleId} answered yes in this server's local test file (not verified by Proofy)` : ''
  return `explicit district rule ${ticket.rule?.ref ?? ''} for this NFT${restricted}`
}

/** The ticket's district as the page shows it everywhere: what the server assigned, on what basis, until when. */
export function AssignedDistrict({ ticket, name, color }: { ticket: AssignedTicket; name: string; color?: string }) {
  return (
    <span
      className="assigned-district"
      data-testid="assigned-district"
      data-district={ticket.districtKey}
      data-kind={ticket.kind}
      data-ticket={ticket.id}
      data-ordinal={ticket.slot?.ordinal ?? ''}
      data-generation={ticket.slot?.generation ?? ''}
      data-rule={ticket.rule?.ref ?? ''}
      data-restricted={ticket.authorization ? String(ticket.authorization.verificationRuleId) : ''}
      title={`Assigned by the server from ${assignmentBasis(ticket)}. Held until ${new Date(ticket.expiresAt).toLocaleTimeString()}.`}
    >
      {color && <i className="assigned-swatch" style={{ ['--dc' as string]: color }} aria-hidden="true" />}
      <b>{name}</b> · {ticket.kind === 'rule' ? (ticket.authorization ? 'restricted, by rule' : 'by rule') : `slot ${(ticket.slot?.ordinal ?? 0) + 1}`} · until{' '}
      <time dateTime={ticket.expiresAt}>{new Date(ticket.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
    </span>
  )
}

/**
 * The claim window's time left, redrawn exactly when the shown second changes, from the ticket's `expiresAt` (the
 * server's) and the server's clock offset only. Nothing is stored and nothing is asked of the server here: mounting it
 * again (a reload, a reopened panel, another tab) reads the same instant. It stops at zero and on unmount, and catches
 * up at once when a hidden tab is shown again (browsers slow the timers of hidden tabs).
 */
function useCountdown(expiresAt: string | null, clockOffset: number): Countdown | null {
  const [now, setNow] = useState(() => Date.now())
  const countdown = expiresAt ? claimCountdown(expiresAt, now + clockOffset) : null
  const wait = countdown?.nextTickMs ?? null
  useEffect(() => {
    if (wait === null) return
    const timer = setTimeout(() => setNow(Date.now()), wait + 5)
    return () => clearTimeout(timer)
  }, [wait, now])
  useEffect(() => {
    const wake = () => document.visibilityState === 'visible' && setNow(Date.now())
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
    }
  }, [])
  return countdown
}

/** MM:SS left in the claim window, with a ring for the share of the fifteen minutes left. Read as a timer, never announced. */
export function ClaimCountdown({ expiresAt, clockOffset }: { expiresAt: string; clockOffset: number }) {
  const c = useCountdown(expiresAt, clockOffset)
  if (!c) return null
  const share = Math.max(0, Math.min(1, (c.seconds * 1000) / CLAIM_WINDOW_MS))
  return (
    <span
      className={`claim-countdown ${c.state}`}
      data-testid="claim-countdown"
      data-state={c.state}
      data-seconds={c.seconds}
      data-expires-at={expiresAt}
      role="timer"
      aria-label={c.state === 'ended' ? 'Claim time is up' : `Claim time left: ${spokenCountdown(c.seconds)}`}
      title="Time left in your claim window. It started with your first district and is never extended."
    >
      <svg className="claim-ring" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        <circle cx="10" cy="10" r="8" pathLength={100} />
        <circle cx="10" cy="10" r="8" pathLength={100} strokeDasharray={`${share * 100} 100`} transform="rotate(-90 10 10)" />
      </svg>
      <span className="claim-countdown-time" aria-hidden="true">
        {c.label}
      </span>
      <span className="claim-countdown-unit" aria-hidden="true">
        {c.state === 'ended' ? 'time up' : 'left'}
      </span>
    </span>
  )
}

/** Says once, politely, when a claim is nearly over and when it is over. The visible countdowns are never announced. */
export function ClaimAnnouncer({ expiresAt, clockOffset }: { expiresAt: string | null; clockOffset: number }) {
  const c = useCountdown(expiresAt, clockOffset)
  const text = c?.state === 'ending' ? 'Under two minutes left in your claim window.' : c?.state === 'ended' ? 'Your claim time is up. Nothing was placed.' : ''
  return (
    <p className="sr-only" role="status" aria-live="polite" data-testid="claim-announcer">
      {text}
    </p>
  )
}

/** A refusal, under the heading of what it asks of the player. `testId` is the message's own, unchanged. */
function ProblemLine({ problem, testId, children }: { problem: ClaimProblem; testId: string; children?: ReactNode }) {
  // A long panel may be scrolled anywhere: a new refusal is brought into view where it is.
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: 'nearest' })
  }, [problem])
  return (
    <div ref={box} className={`claim-problem ${problem.kind}`} role="alert" data-testid={`${testId}-box`} data-kind={problem.kind} data-code={problem.code ?? ''}>
      <b className="claim-problem-title">{PROBLEM_TITLES[problem.kind]}</b>
      <p className="access-line restricted" data-testid={testId}>
        {problem.message}
      </p>
      {children}
    </div>
  )
}

const STEPS: { key: string; label: string; at: ClaimStep[] }[] = [
  { key: 'nft', label: 'Test NFT', at: ['nft'] },
  { key: 'district', label: 'District', at: ['district'] },
  { key: 'plot', label: 'Plot', at: ['plot'] },
  { key: 'confirm', label: 'Activate', at: ['review', 'activating'] },
]

/** Where the player is in the claim, as four steps. */
function ClaimSteps({ step }: { step: ClaimStep }) {
  const current = STEPS.findIndex((s) => s.at.includes(step))
  return (
    <ol className="claim-steps" aria-label="Claim progress" data-testid="claim-steps" data-step={step}>
      {STEPS.map((s, i) => {
        const state = step === 'ended' ? 'todo' : i < current ? 'done' : i === current ? 'current' : 'todo'
        return (
          <li key={s.key} className={`claim-step ${state}`} data-step={s.key} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="claim-step-n" aria-hidden="true">
              {state === 'done' ? '✓' : i + 1}
            </span>
            {s.label}
            {state === 'done' && <span className="sr-only"> (done)</span>}
          </li>
        )
      })}
    </ol>
  )
}

/** A building's record exactly as the city stores it. */
export interface StoredProperty {
  propertyId: string
  asset: string
  collection: string
  districtKey: string
  ward: number
  plot: number
  sequence: number
  /**
   * Its original activator, as the server's permanent record says: the viewer (matched on their Proofy identity), someone
   * else (never named), or never recorded (placed before activators were kept, so unknown to everyone).
   */
  activator: 'viewer' | 'other' | 'unrecorded'
  /** Its place in the city's founding order (1 for the first), when the page knows it. */
  order?: number
}

/** Says, wherever rehearsal data shows, what it is not. */
export function RehearsalFlag() {
  return (
    <p className="rehearsal-flag small" data-testid="rehearsal-flag">
      <b>LOCAL REHEARSAL</b> · test NFTs listed by this local server, not verified NFT holdings. Properties placed here are permanent in this local city only.
    </p>
  )
}

type Stage = 'choose' | 'review' | 'activating'

/**
 * Choose a test NFT (the server may assign its district by rule) and a highlighted plot in the district the server
 * assigned, review what is permanent, then ask the server. The player never chooses the district. The countdown is the
 * server's claim window; at zero nothing more can be confirmed here, and the server is asked whether it has ended.
 */
export function RehearsalPlotPanel({
  city,
  placement,
  rehearsal,
  onCancel,
  onLeave,
  onAssigned,
  onActivated,
}: {
  city: LoadedBrandCity
  placement: Placement
  rehearsal: PlacementRehearsal
  onCancel: () => void
  /** The server answered for the selected NFT: the ticket that may place it (its district may have changed). */
  onAssigned: (ticket: AssignedTicket | null) => void
  /** The player left the claim flow: their district was released. */
  onLeave: () => void
  onActivated: (result: Extract<RehearsalResult, { ok: true }>, nft: RehearsalNft) => void
}) {
  const d = sceneDistrict(city.scene, placement.districtId)
  const [asset, setAsset] = useState<string | null>(rehearsal.nfts.length === 1 ? rehearsal.nfts[0].asset : null)
  const [stage, setStage] = useState<Stage>('choose')
  const [problem, setProblem] = useState<ClaimProblem | null>(null)
  /** A plot an activation was refused for (taken first, or no longer offered): named, and never replaced by another. */
  const [lostPlot, setLostPlot] = useState<{ plotId: string; ward: number; plot: number } | null>(null)
  /**
   * What the server answered for an NFT, under which ticket. The selected NFT is asked about again under any other
   * ticket (the server reissued or replaced it), so a placement is never confirmed on a ticket that was not checked for it.
   */
  const [answered, setAnswered] = useState<{ asset: string; ticketId: string | null; ok: boolean } | null>(null)
  const asking = useRef(false)
  const nft = rehearsal.nfts.find((n) => n.asset === asset) ?? null
  const sel = placement.selected
  const newWard = placement.candidates[0]?.newWard ?? false
  const ticket = rehearsal.ticket
  const ticketId = ticket?.id ?? null
  const countdown = useCountdown(ticket?.expiresAt ?? null, rehearsal.clockOffset)
  const ended = countdown?.state === 'ended'
  const current = !!asset && answered?.asset === asset && answered.ticketId === ticketId
  const checking = !!asset && !current

  // The server decides the selected NFT's district (an explicit rule may assign one) before any plot is chosen: asked
  // when the player selects an NFT, and again only when the ticket held changes under it. One question at a time.
  useEffect(() => {
    if (!asset || current || asking.current) return
    asking.current = true
    const askedUnder = ticketId
    void rehearsal.assign(asset).then((result) => {
      asking.current = false
      if (!result.ok) {
        setAnswered({ asset, ticketId: askedUnder, ok: false })
        return setProblem(result)
      }
      setAnswered({ asset, ticketId: result.ticket?.id ?? null, ok: true })
      onAssigned(result.ticket)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, ticketId, current])

  const assigned = current && !!answered?.ok && !!ticket && ticket.districtKey === placement.districtId
  const ready = !!nft && assigned && !ended
  const confirming = stage === 'activating' || (stage === 'review' && ready && !!sel)
  const step = claimStep({
    district: ticket ? 'held' : rehearsal.awaitingAsset ? 'awaiting-asset' : 'none',
    nft: !nft ? 'none' : checking ? 'checking' : answered?.ok ? 'assigned' : 'refused',
    plotSelected: !!sel,
    stage: confirming ? stage : 'choose',
    ended,
  })

  async function activate() {
    if (!nft || !sel || !ready) return
    setStage('activating')
    setProblem(null)
    setLostPlot(null)
    const result = await rehearsal.activate(nft.asset, sel.plotId)
    if (result.ok) return onActivated(result, nft)
    setProblem(result)
    // The plot is not silently swapped for another: it is named, and the player chooses again.
    if (result.kind === 'plot') setLostPlot({ plotId: sel.plotId, ward: sel.ward, plot: sel.plot })
    // A temporary failure keeps the same confirmation to try again (the same ticket, NFT and plot: never a second property).
    setStage(result.kind === 'retry' ? 'review' : 'choose')
  }

  const [leaving, setLeaving] = useState(false)
  async function leave() {
    setLeaving(true)
    const result = await rehearsal.leave()
    setLeaving(false)
    if (result.ok) return onLeave()
    setProblem(result)
  }

  /** A restricted district's rule result keeps this NFT out, while the district held (the rotation's) stays for others. */
  const refusedNow = current && answered?.ok === false
  const keptOut = refusedNow && !!problem && problem.code !== null && RULE_REFUSALS.has(problem.code) && ticket?.kind === 'fallback'
  const others = rehearsal.nfts.length > 1

  return (
    <section className="panel plot-panel rehearsal-panel" aria-label="Place a property" data-testid="rehearsal-panel" data-stage={stage} data-assigned={ready ? 'yes' : 'no'} data-step={step}>
      <PanelHeader kicker={<SceneDistrictChip district={d} small />} title="Place a property" onClose={onCancel} onBack={onCancel} />
      <RehearsalFlag />

      <div className="claim-status" data-testid="claim-status">
        <ClaimSteps step={step} />
        <div className="claim-next">
          {ticket && <ClaimCountdown expiresAt={ticket.expiresAt} clockOffset={rehearsal.clockOffset} />}
          <span className="small" data-testid="claim-next" role="status">
            {ended ? 'Your claim time is up. Checking with the server…' : NEXT_ACTION[step]}
          </span>
        </div>
      </div>

      <div className="rehearsal-step">
        <h3>1 · Test NFT</h3>
        {rehearsal.nfts.length === 0 ? (
          <p className="small muted" data-testid="rehearsal-no-nfts">
            No unplaced test NFT for this city{rehearsal.placed > 0 ? ` (${rehearsal.placed} already placed)` : ''}.
          </p>
        ) : (
          <ul className="rehearsal-nfts" role="radiogroup" aria-label="Test NFT">
            {rehearsal.nfts.map((n) => (
              <li key={n.asset}>
                <label className={`rehearsal-nft${n.asset === asset ? ' on' : ''}`}>
                  <input
                    type="radio"
                    name="rehearsal-nft"
                    value={n.asset}
                    checked={n.asset === asset}
                    disabled={stage !== 'choose' || checking}
                    onChange={() => {
                      setProblem(null)
                      setLostPlot(null)
                      setAsset(n.asset)
                    }}
                    data-testid="rehearsal-nft"
                    data-asset={n.asset}
                  />
                  <span className="grow">
                    {n.collectionName} <span className="mono">#{n.tokenId}</span>
                  </span>
                  <span className="sim-tag">TEST NFT</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rehearsal-step">
        <h3>2 · District</h3>
        <p className="small" data-testid="rehearsal-district" data-district={d.id} data-kind={ticket?.kind ?? ''} data-ordinal={ticket?.slot?.ordinal ?? ''} data-checking={String(checking)}>
          {ticket || !rehearsal.awaitingAsset ? (
            <>
              <b>{d.title}</b>, assigned to you by the server{ticket ? ` (${assignmentBasis(ticket)})` : ''}. You do not choose your district; you choose the exact plot in it.
            </>
          ) : (
            <>Every district of this city is restricted. Select your test NFT: the server assigns its district if a district rule names one for it and that district&rsquo;s Proofy rule result allows you. You do not choose your district.</>
          )}
        </p>
        {ticket && (
          <p className="claim-basis small" data-testid="claim-basis" data-kind={ticket.kind} data-restricted={String(!!ticket.authorization)}>
            <span className={`claim-tag ${ticket.kind}`}>{ticket.kind === 'rule' ? 'DISTRICT RULE' : 'DEFAULT ASSIGNMENT'}</span>
            {ticket.authorization && <span className="claim-tag restricted">RESTRICTED · LOCAL TEST RESULT</span>}
            {ticket.kind === 'rule' ? (ticket.authorization ? ' Placed here by a district rule for this NFT; your local test rule result admits you. Not verified by Proofy.' : ' Placed here by a district rule for this NFT.') : ' The next district in the city’s rotation.'}
          </p>
        )}
        {checking && (
          <p className="small muted" data-testid="rehearsal-checking" role="status">
            Checking this NFT&rsquo;s district with the server…
          </p>
        )}
        {ticket && (
          <p className="muted small" data-testid="claim-hold">
            Your district is held for you until <time dateTime={ticket.expiresAt}>{new Date(ticket.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>, fifteen minutes from your first district, never extended. No plot is held: until you activate, another player may take any free plot.
          </p>
        )}
        <p className="muted small">Local rehearsal: which NFTs you may place, and any district rule for them, come from a local test file on this server, not from Proofy.</p>
      </div>

      <div className="rehearsal-step">
        <h3>3 · Plot</h3>
        <p className="muted small" data-testid="rehearsal-candidates" data-count={placement.candidates.length}>
          {placement.candidates.length} free plots in {d.title}
          {newWard ? ` (every open ward is full: these open ${wardName(placement.candidates[0].ward)})` : ''}, highlighted on the map. Tap one.
        </p>
        {sel ? (
          <div className="impact-callout" data-testid="selected-plot" data-plot-id={sel.plotId}>
            <div className="kicker">SELECTED PLOT</div>
            <div>
              {wardName(sel.ward)}
              {isFoundingWard(sel.ward) ? ' · Founding Ward' : ''} · Plot {sel.plot + 1}
            </div>
            <code className="small">{sel.plotId}</code>
          </div>
        ) : (
          <p className="small" data-testid="no-plot-selected">
            No plot selected yet.
          </p>
        )}
        {lostPlot && !sel && (
          <p className="small muted" data-testid="rehearsal-lost-plot" data-plot-id={lostPlot.plotId}>
            Your plot, {wardName(lostPlot.ward)} · Plot {lostPlot.plot + 1} (<code>{lostPlot.plotId}</code>), is no longer free. No other plot was chosen for you.
          </p>
        )}
      </div>

      {problem && (
        <ProblemLine problem={problem} testId="rehearsal-error">
          {keptOut && (
            <p className="small" data-testid="rehearsal-kept-out">
              Your district, <b>{d.title}</b>, is still held for you, but it cannot take this NFT.{' '}
              {others ? 'Select another test NFT, or leave to release the district.' : 'You have no other test NFT for it: leave to release the district.'}
            </p>
          )}
          {problem.kind === 'retry' && stage === 'choose' && refusedNow && (
            <button type="button" className="chip" data-testid="rehearsal-retry" onClick={() => setAnswered(null)}>
              Try again
            </button>
          )}
        </ProblemLine>
      )}

      {!confirming ? (
        <>
          <button type="button" className="btn primary" disabled={!ready || !sel} onClick={() => setStage('review')} data-testid="rehearsal-review">
            Review placement
          </button>
          <button type="button" className="chip rehearsal-leave" disabled={leaving} onClick={() => void leave()} data-testid="rehearsal-leave">
            Leave · release my district
          </button>
        </>
      ) : (
        nft &&
        sel && (
          <div className="fund-box access-box rehearsal-confirm" data-testid="rehearsal-confirm" data-asset={nft.asset} data-plot-id={sel.plotId}>
            <h3>This is permanent</h3>
            <p className="small">
              <b>
                {nft.collectionName} #{nft.tokenId}
              </b>{' '}
              becomes a Tier 0 property on <code>{sel.plotId}</code> in {d.title} ({wardName(sel.ward)}, plot {sel.plot + 1}). It can never be moved, replaced or removed, and this NFT can never be placed again in this city.
            </p>
            <dl className="stat-grid claim-summary" data-testid="claim-summary">
              <div>
                <dt>District</dt>
                <dd>
                  <SceneDistrictChip district={d} small />
                </dd>
              </div>
              <div>
                <dt>Plot</dt>
                <dd>
                  {wardName(sel.ward)} · Plot {sel.plot + 1}
                </dd>
              </div>
            </dl>
            <p className="small muted">You are recorded as its original activator, for good. The server checks everything again: your session, the NFT, the plot and the district. This is a local rehearsal with a test NFT, not a verified claim.</p>
            <div className="play-choices">
              <button type="button" className="btn primary" disabled={stage === 'activating' || !ready} onClick={() => void activate()} data-testid="rehearsal-activate">
                {stage === 'activating' ? 'Activating…' : 'Activate Tier 0 property'}
              </button>
              <button type="button" className="chip" disabled={stage === 'activating'} onClick={() => setStage('choose')} data-testid="rehearsal-back">
                Back
              </button>
            </div>
          </div>
        )
      )}
    </section>
  )
}

/** The building panel's account of a building's stored record: what the city holds, and nothing it does not. */
export function StoredPropertyCard({ stored, cityName }: { stored: StoredProperty; cityName: string }) {
  return (
    <div className="fund-box stored-property" data-testid="stored-property" data-property-id={stored.propertyId} data-asset={stored.asset} data-sequence={stored.sequence} data-plot-id={`${stored.districtKey}-w${stored.ward}-p${stored.plot}`}>
      <div className="row-between">
        <h3>Founding record</h3>
        <span className="muted small">city sequence {stored.sequence}</span>
      </div>
      {stored.order !== undefined && (
        <p className="small" data-testid="stored-property-order" data-order={stored.order}>
          The {ordinal(stored.order)} property founded in {cityName}.
        </p>
      )}
      <dl className="stat-grid">
        <div>
          <dt>Property id</dt>
          <dd className="mono small" data-testid="stored-property-id">
            {stored.propertyId}
          </dd>
        </div>
        <div>
          <dt>Plot</dt>
          <dd className="mono small">{`${stored.districtKey}-w${stored.ward}-p${stored.plot}`}</dd>
        </div>
      </dl>
      <p className="small mono rehearsal-asset" data-testid="stored-property-asset">
        {stored.asset}
      </p>
      <p className="small" data-testid="stored-property-activator" data-activator={stored.activator} data-activated-by-viewer={String(stored.activator === 'viewer')}>
        {stored.activator === 'viewer' ? (
          <>
            <b>Originally activated by you.</b> Your founding credit is permanent. The property and its history stay with the NFT, and founding it does not prove who holds the NFT now.
          </>
        ) : stored.activator === 'other' ? (
          'Its original activator is recorded permanently and privately.'
        ) : (
          'Its original activator is unknown: it was placed before original activators were recorded, and none was recorded for it.'
        )}
      </p>
      <p className="muted small">Founded as a Tier 0 foundation. Permanent in {cityName}: its identity and plot never change, whatever is built on it. Who holds the NFT now is not tracked here.</p>
    </div>
  )
}
