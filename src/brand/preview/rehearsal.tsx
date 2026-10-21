import { useEffect, useState } from 'react'
import { isFoundingWard, wardName } from '../../game/allocation'
import { sceneDistrict } from '../../ui/city/scene'
import { PanelHeader, SceneDistrictChip } from '../../ui/common'
import type { LoadedBrandCity } from '../load'
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

export type RehearsalResult = { ok: true; buildingId: string; fresh: boolean; sequence: number } | { ok: false; message: string }

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

export type TicketResult = { ok: true; ticket: AssignedTicket | null } | { ok: false; message: string }

export interface PlacementRehearsal {
  /** This city's unplaced test NFTs for the player. */
  nfts: readonly RehearsalNft[]
  /** How many of the player's test NFTs for this city already stand in it. */
  placed: number
  /** The district the server assigned the player now, or null: none held (enter to be assigned one). */
  ticket: AssignedTicket | null
  /** Why the player holds no ticket, when the server said. */
  ticketNote: string | null
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
export function AssignedDistrict({ ticket, name }: { ticket: AssignedTicket; name: string }) {
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
      <b>{name}</b> · {ticket.kind === 'rule' ? (ticket.authorization ? 'restricted, by rule' : 'by rule') : `slot ${(ticket.slot?.ordinal ?? 0) + 1}`} · until{' '}
      <time dateTime={ticket.expiresAt}>{new Date(ticket.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
    </span>
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
 * assigned, review what is permanent, then ask the server. The player never chooses the district.
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
  const [error, setError] = useState<string | null>(null)
  /** The NFT the server has answered for (its district is the ticket's). Another NFT is being asked about until it matches. */
  const [assignedFor, setAssignedFor] = useState<string | null>(null)
  const nft = rehearsal.nfts.find((n) => n.asset === asset) ?? null
  const sel = placement.selected
  const newWard = placement.candidates[0]?.newWard ?? false
  const ticket = rehearsal.ticket

  // The server decides the selected NFT's district (an explicit rule may assign one) before any plot is chosen.
  useEffect(() => {
    if (!asset) return
    let live = true
    void rehearsal.assign(asset).then((result) => {
      if (!live) return
      if (!result.ok) return setError(result.message)
      setAssignedFor(asset)
      onAssigned(result.ticket)
    })
    return () => {
      live = false
    }
    // Asked again only when the player selects another NFT.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset])

  async function activate() {
    if (!nft || !sel) return
    setStage('activating')
    setError(null)
    const result = await rehearsal.activate(nft.asset, sel.plotId)
    if (result.ok) return onActivated(result, nft)
    setError(result.message)
    setStage('choose')
  }

  const [leaving, setLeaving] = useState(false)
  async function leave() {
    setLeaving(true)
    const result = await rehearsal.leave()
    setLeaving(false)
    if (result.ok) return onLeave()
    setError(result.message)
  }

  const ready = !!nft && assignedFor === nft.asset && !!ticket && ticket.districtKey === placement.districtId

  return (
    <section className="panel plot-panel rehearsal-panel" aria-label="Place a property" data-testid="rehearsal-panel" data-stage={stage} data-assigned={ready ? 'yes' : 'no'}>
      <PanelHeader kicker={<SceneDistrictChip district={d} small />} title="Place a property" onClose={onCancel} onBack={onCancel} />
      <RehearsalFlag />

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
                    disabled={stage !== 'choose'}
                    onChange={() => {
                      setError(null)
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
        <p className="small" data-testid="rehearsal-district" data-district={d.id} data-kind={ticket?.kind ?? ''} data-ordinal={ticket?.slot?.ordinal ?? ''}>
          {ticket || !rehearsal.awaitingAsset ? (
            <>
              <b>{d.title}</b>, assigned to you by the server{ticket ? ` (${assignmentBasis(ticket)})` : ''}. You do not choose your district; you choose the exact plot in it. Held for you until{' '}
              {ticket ? new Date(ticket.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'} (fifteen minutes from when it was first assigned, never extended); nothing is permanent until you activate.
            </>
          ) : (
            <>Every district of this city is restricted. Select your test NFT: the server assigns its district if a district rule names one for it and that district&rsquo;s Proofy rule result allows you. You do not choose your district.</>
          )}
        </p>
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
      </div>

      {error && (
        <p className="access-line restricted" role="alert" data-testid="rehearsal-error">
          {error}
        </p>
      )}

      {stage === 'choose' ? (
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
            <p className="small muted">The server checks everything again: your session, the NFT, the plot and the district. This is a local rehearsal with a test NFT, not a verified claim.</p>
            <div className="play-choices">
              <button type="button" className="btn primary" disabled={stage === 'activating'} onClick={() => void activate()} data-testid="rehearsal-activate">
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
        <h3>Stored property</h3>
        <span className="muted small">city sequence {stored.sequence}</span>
      </div>
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
            <b>Originally activated by you.</b> This record is permanent and stays yours whoever holds the NFT later.
          </>
        ) : stored.activator === 'other' ? (
          'Its original activator is recorded permanently and privately.'
        ) : (
          'Its original activator is unknown: it was placed before original activators were recorded, and none was recorded for it.'
        )}
      </p>
      <p className="muted small">Tier 0, nothing built. Permanent in {cityName}: its identity and plot never change. Who holds the NFT now is not tracked here.</p>
    </div>
  )
}
