import { useMemo } from 'react'
import { MAX_TIER } from '../../config/economy'
import { isFoundingWard, wardName } from '../../game/allocation'
import { heightMeters, tierFor, tierProgress, totalBuilt } from '../../game/economy'
import { MonumentSprite } from '../../ui/city/MonumentSprite'
import { CitySceneContext, sceneDistrict, type SceneDistrict } from '../../ui/city/scene'
import { Avatar, PanelHeader, ProgressBar, SceneDistrictBanner, SceneDistrictChip, SceneDistrictEmblem, SimTag } from '../../ui/common'
import { nftAsset } from '../../world/asset'
import { worldProperty } from '../../world/property'
import { mayAct, previewClaimAccess, type ClaimAccess, type PreviewMember } from '../core/eligibility'
import { districtPlots, type LoadedBrandCity } from '../load'
import type { Placement } from './PreviewApp'

/** One line on who may claim and build, for the viewer the preview simulates. */
function AccessNote({ access, district }: { access: ClaimAccess; district: SceneDistrict }) {
  switch (access.kind) {
    case 'visitor':
      return <p className="access-line visitor">You are exploring as a visitor. Members sign in to claim a plot.</p>
    case 'open':
      return <p className="access-line open">Open district: every member with an eligible NFT may claim and build in {district.name}.</p>
    case 'eligible':
      return <p className="access-line eligible">✓ You meet <b>{access.rule.label}</b>: claiming and building are available (simulated answer).</p>
    case 'restricted':
      return (
        <p className="access-line restricted">
          🔒 Requires <b>{access.rule.label}</b>.{' '}
          {access.reason === 'unknown' ? 'Your role has not been checked yet, so this stays closed until Proofy confirms it.' : 'You do not meet it (simulated answer).'} You can still explore everything here.
        </p>
      )
  }
}

function RuleRequirement({ access }: { access: ClaimAccess }) {
  if (access.kind !== 'eligible' && access.kind !== 'restricted') return null
  const { rule } = access
  return (
    <div className="rule-ref small muted" data-testid="rule-ref" data-rule-id={rule.verificationRuleId} data-rule-source={rule.source}>
      Proofy Verification Rule #{rule.verificationRuleId} · {rule.label}
      {rule.source === 'sample' && <span className="sim-tag">SAMPLE RULE</span>}
    </div>
  )
}

function accessFor(city: LoadedBrandCity, districtId: string, member: PreviewMember | null): ClaimAccess {
  const d = city.config.districts.find((x) => x.key === districtId)
  return previewClaimAccess(d?.gate ?? null, member)
}

/** The district's T5 District Monument, drawn by the city's own monument sprite. */
function MonumentPreview({ city, districtId }: { city: LoadedBrandCity; districtId: string }) {
  const { scene, config, state } = city
  const d = config.districts.find((x) => x.key === districtId)!
  const art = scene.statueFor(districtId)
  const collection = d.monument ? config.collections.find((c) => c.key === d.monument!.collection) : null
  const holder = state.monuments.m5.holder
  return (
    <div className="monument-card" data-testid="district-monument" data-monument-kind={art.kind}>
      <div className="row-between">
        <h3>District Monument</h3>
        <span className="muted small">Tier 5 landmark</span>
      </div>
      <div className="monument-stage">
        {/* Paint ids resolve against the map's own <defs>; the label is off (detail far). */}
        <svg viewBox="-92 -238 184 262" width="100%" height="230" role="img" aria-label={`${d.name} District Monument`}>
          <CitySceneContext.Provider value={scene}>
            <MonumentSprite monumentId="m5" districtId={districtId} phase="standing" detail="far" scale={1} labelScale={1} />
          </CitySceneContext.Provider>
        </svg>
      </div>
      {d.monument ? (
        <dl className="stat-grid nft-ref" data-testid="monument-nft">
          <div>
            <dt>Collection</dt>
            <dd>{collection?.displayName}</dd>
          </div>
          <div>
            <dt>Token</dt>
            <dd>#{d.monument.tokenId}</dd>
          </div>
          <div>
            <dt>Chain</dt>
            <dd>{collection?.chain}</dd>
          </div>
        </dl>
      ) : null}
      <p className="muted small" data-testid="monument-note">
        {art.kind === 'portrait'
          ? `Carries ${art.caption}'s artwork (sample image, served by this page).`
          : d.monument
            ? 'Artwork unavailable: the standard bronze emblem stands in until it can be served safely.'
            : 'No monument NFT configured: the standard bronze emblem.'}{' '}
        {holder === districtId ? 'It stands in this district now: the district has the most Tier 5+ buildings.' : 'It rises here when this district has the most Tier 5+ buildings.'}
      </p>
    </div>
  )
}

export function DistrictPanel({
  city,
  districtId,
  member,
  onDistrict,
  onWarp,
  onChoosePlot,
  onClose,
}: {
  city: LoadedBrandCity
  districtId: string
  member: PreviewMember | null
  onDistrict: (id: string) => void
  onWarp: (buildingId: string) => void
  onChoosePlot: () => void
  onClose: () => void
}) {
  const { scene, state } = city
  const d = sceneDistrict(scene, districtId)
  const access = accessFor(city, districtId, member)
  const buildings = useMemo(() => Object.values(state.buildings).filter((b) => b.districtId === districtId).sort((a, b) => totalBuilt(b) - totalBuilt(a)), [state.buildings, districtId])
  const plots = useMemo(() => districtPlots(city, districtId), [city, districtId])
  const held = scene.monuments.filter((m) => state.monuments[m.id].holder === districtId)
  const allowed = mayAct(access)
  return (
    <section className="panel district-panel" aria-label={`${d.title}`} data-testid="district-panel" data-district={districtId} data-access={access.kind}>
      <PanelHeader kicker="DISTRICT" title={d.title} onClose={onClose} />
      <div className="district-tabs" role="tablist" aria-label="District">
        {scene.districts.map((x) => (
          <button key={x.id} type="button" role="tab" aria-selected={x.id === districtId} className={`dtab${x.id === districtId ? ' on' : ''}`} style={{ ['--dc' as string]: x.color }} onClick={() => onDistrict(x.id)} title={x.title} data-testid={`dtab-${x.id}`}>
            <SceneDistrictEmblem district={x} size={22} />
          </button>
        ))}
      </div>
      <SceneDistrictBanner district={d} kicker={`DISTRICT ${d.sigil}`} testId="district-banner" aside={state.capital.holder === districtId ? <span className="crown-tag">★ CAPITAL</span> : undefined} />
      <dl className="stat-grid">
        <div>
          <dt>Buildings</dt>
          <dd data-testid="district-buildings">{buildings.length}</dd>
        </div>
        <div>
          <dt>Free plots</dt>
          <dd data-testid="district-free-plots">{plots.length}</dd>
        </div>
        <div>
          <dt>Wards open</dt>
          <dd>{state.wards[districtId] ?? 1}</dd>
        </div>
        <div>
          <dt>Monuments</dt>
          <dd>{held.length ? held.map((m) => `T${m.tier}`).join(' ') : '—'}</dd>
        </div>
      </dl>

      <div className={`fund-box access-box ${access.kind}`} data-testid="district-access" data-access={access.kind}>
        <div className="row-between">
          <h3>Who can build here</h3>
          <SimTag>PREVIEW</SimTag>
        </div>
        <AccessNote access={access} district={d} />
        <RuleRequirement access={access} />
        <button type="button" className="btn primary" onClick={onChoosePlot} disabled={!allowed} data-testid="choose-plot">
          {allowed ? 'Choose a plot · preview' : access.kind === 'visitor' ? 'Sign in to claim' : 'Claiming is restricted'}
        </button>
        <p className="muted small">Exploring is open to everyone. On a live city the server re-checks every claim and build with Proofy; nothing shown here can grant access.</p>
      </div>

      <MonumentPreview city={city} districtId={districtId} />

      {buildings.length > 0 && (
        <div className="patron-zone">
          <div className="row-between">
            <h3>Tallest here</h3>
          </div>
          <ul className="patron-list">
            {buildings.slice(0, 3).map((b) => (
              <li key={b.id} className="featured">
                <span className="grow">
                  {scene.buildingLabel(b)}
                  <span className="muted small"> · T{tierFor(totalBuilt(b))} · {heightMeters(totalBuilt(b))} m</span>
                </span>
                <button type="button" className="warp-btn" onClick={() => onWarp(b.id)} data-testid={`warp-${b.id}`}>
                  WARP
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

export function PlotPanel({ city, member, placement, onCancel, onClaim }: { city: LoadedBrandCity; member: PreviewMember | null; placement: Placement; onCancel: () => void; onClaim: () => void }) {
  const d = sceneDistrict(city.scene, placement.districtId)
  const access = accessFor(city, placement.districtId, member)
  const allowed = mayAct(access)
  const sel = placement.selected
  const newWard = placement.candidates[0]?.newWard ?? false
  return (
    <section className="panel plot-panel" aria-label="Choose a plot" data-testid="plot-panel" data-access={access.kind}>
      <PanelHeader kicker={<SceneDistrictChip district={d} small />} title="Choose a plot" onClose={onCancel} onBack={onCancel} />
      <p className="muted small">
        {placement.candidates.length} free plots in {d.title}
        {newWard ? ` (every open ward is full: these open ${wardName(placement.candidates[0].ward)})` : ''}. Tap one on the map.
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
      <div className={`fund-box access-box ${access.kind}`} data-testid="plot-access" data-access={access.kind}>
        <AccessNote access={access} district={d} />
        <RuleRequirement access={access} />
        <button type="button" className="btn primary" onClick={onClaim} disabled={!allowed || !sel} data-testid="claim-plot">
          Claim plot · preview only
        </button>
        <p className="muted small">Nothing is claimed here. A live claim needs a signed-in member, a verified NFT and the server's own rule check.</p>
      </div>
    </section>
  )
}

export function BuildingPreviewPanel({ city, buildingId, member, onDistrict, onClose, onBuild }: { city: LoadedBrandCity; buildingId: string; member: PreviewMember | null; onDistrict: (id: string) => void; onClose: () => void; onBuild: () => void }) {
  const { scene, state, config, world } = city
  const b = state.buildings[buildingId]
  const d = sceneDistrict(scene, b.districtId)
  const total = totalBuilt(b)
  const tier = tierFor(total)
  const nft = state.nfts[b.id]
  const collection = config.collections.find((c) => c.key === nft?.collection)
  const asset = collection && nft ? nftAsset({ chain: collection.chain, contract: collection.contract, tokenId: nft.tokenId }) : null
  const property = asset ? worldProperty(world, asset) : null
  const owner = state.users[b.ownerId]
  const access = accessFor(city, b.districtId, member)
  const allowed = mayAct(access)
  const isCrown = state.crown.holder === b.id
  return (
    <section className="panel building-panel" aria-label={`${scene.buildingLabel(b)} details`} data-testid="building-panel" data-building={b.id}>
      <PanelHeader
        kicker={
          <>
            <button type="button" className="link-btn" onClick={() => onDistrict(d.id)} data-testid="building-district">
              <SceneDistrictChip district={d} small />
            </button>{' '}
            {isCrown && <span className="crown-tag">♔ CITY CROWN</span>}
          </>
        }
        title={scene.buildingLabel(b)}
        onClose={onClose}
      />
      <div className="owner-row">
        <Avatar user={owner} size={30} />
        <div>
          <div className="muted small">Owner (sample member)</div>
          <div className="strong">@{owner?.handle ?? 'unknown'}</div>
        </div>
        <div className="tier-medal" style={{ ['--dc' as string]: d.color }} data-testid="panel-tier">
          <span>TIER</span>
          <b>{tier}</b>
        </div>
      </div>
      <div className="address small muted" data-testid="building-address">
        {d.title} · {wardName(b.ward)}
        {isFoundingWard(b.ward) && <span className="founding-tag"> Founding Ward</span>} · Plot {b.plot + 1} · <code>{`${b.districtId}-w${b.ward}-p${b.plot}`}</code>
      </div>
      <div className="tier-progress">
        <div className="row-between small">
          <span>{tier >= MAX_TIER ? 'Max tier' : `Progress to Tier ${tier + 1}`}</span>
          <span>{heightMeters(total)} m</span>
        </div>
        <ProgressBar value={tierProgress(total)} color={d.color} label="Progress to next tier" />
      </div>
      <dl className="stat-grid">
        <div>
          <dt>Collection</dt>
          <dd>{collection?.displayName ?? '—'}</dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd>#{nft?.tokenId}</dd>
        </div>
        <div>
          <dt>Chain</dt>
          <dd>{collection?.chain}</dd>
        </div>
        <div>
          <dt>Property id</dt>
          <dd className="mono" title="Permanent world-scoped property id (engine V2)" data-testid="property-id">
            {property?.propertyId.slice(0, 8)}…
          </dd>
        </div>
      </dl>
      <div className={`fund-box access-box ${access.kind}`} data-testid="build-access" data-access={access.kind}>
        <div className="row-between">
          <h3>Build here</h3>
          <SimTag>PREVIEW</SimTag>
        </div>
        <AccessNote access={access} district={d} />
        <RuleRequirement access={access} />
        <button type="button" className="btn primary" onClick={onBuild} disabled={!allowed} data-testid="build-action">
          Build · preview only
        </button>
        <p className="muted small">Building will spend the shared Proofy community points. That economy is not connected: nothing is spent and no balance exists here.</p>
      </div>
    </section>
  )
}
