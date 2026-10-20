import { useState } from 'react'
import { isFoundingWard, wardName } from '../../game/allocation'
import { sceneDistrict } from '../../ui/city/scene'
import { PanelHeader, SceneDistrictChip } from '../../ui/common'
import type { LoadedBrandCity } from '../load'
import type { Placement } from './PreviewApp'

/**
 * LOCAL PROPERTY REHEARSAL, as the standard city page presents it (P1-C2-B2B). Only the Proofy
 * Play page passes one, and only when the Rare City server runs a local rehearsal: the test NFTs
 * come from a local file on that server, never from a verified wallet or Proofy. Everything shown
 * here is decided again by the server, under the city's lock; nothing here authorizes anything.
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

export interface PlacementRehearsal {
  /** This city's unplaced test NFTs for the player. */
  nfts: readonly RehearsalNft[]
  /** How many of the player's test NFTs for this city already stand in it. */
  placed: number
  /** Ask the server to place one. Resolves once the page shows the city as stored again. */
  activate(asset: string, plotId: string): Promise<RehearsalResult>
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

/** Choose a test NFT and a highlighted plot, review what is permanent, then ask the server. */
export function RehearsalPlotPanel({ city, placement, rehearsal, onCancel, onActivated }: { city: LoadedBrandCity; placement: Placement; rehearsal: PlacementRehearsal; onCancel: () => void; onActivated: (result: Extract<RehearsalResult, { ok: true }>, nft: RehearsalNft) => void }) {
  const d = sceneDistrict(city.scene, placement.districtId)
  const [asset, setAsset] = useState<string | null>(rehearsal.nfts.length === 1 ? rehearsal.nfts[0].asset : null)
  const [stage, setStage] = useState<Stage>('choose')
  const [error, setError] = useState<string | null>(null)
  const nft = rehearsal.nfts.find((n) => n.asset === asset) ?? null
  const sel = placement.selected
  const newWard = placement.candidates[0]?.newWard ?? false

  async function activate() {
    if (!nft || !sel) return
    setStage('activating')
    setError(null)
    const result = await rehearsal.activate(nft.asset, sel.plotId)
    if (result.ok) return onActivated(result, nft)
    setError(result.message)
    setStage('choose')
  }

  return (
    <section className="panel plot-panel rehearsal-panel" aria-label="Place a property" data-testid="rehearsal-panel" data-stage={stage}>
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
                  <input type="radio" name="rehearsal-nft" value={n.asset} checked={n.asset === asset} disabled={stage !== 'choose'} onChange={() => setAsset(n.asset)} data-testid="rehearsal-nft" data-asset={n.asset} />
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
        <p className="small" data-testid="rehearsal-district" data-district={d.id}>
          <b>{d.title}</b>, chosen by you. <b>Rehearsal only:</b> choosing a district is test behavior. A live city assigns your default district when you enter it, and you choose only the exact plot.
        </p>
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
        <button type="button" className="btn primary" disabled={!nft || !sel} onClick={() => setStage('review')} data-testid="rehearsal-review">
          Review placement
        </button>
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
