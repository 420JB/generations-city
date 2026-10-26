import { useEffect, useRef, useState } from 'react'
import { isFoundingWard, wardName } from '../../game/allocation'
import { sceneDistrict } from '../../ui/city/scene'
import { PanelHeader } from '../../ui/common'
import { appearanceOf, CURRENT_DESIGN_CATALOG } from '../../world/design'
import type { RehearsalLegacyRevision, RehearsalPropertyLegacy } from '../../protocol/playRehearsal'
import type { LoadedBrandCity } from '../load'
import type { ClaimProblem } from './claim'
import { DesignThumb } from './design'
import { revisionName } from './designNames'
import { ordinal } from './properties'

/**
 * PROPERTY LEGACY (P1-C2-E5A): one stored property's history, told as the server read it for the player Proofy Play signed
 * in (`GET /v1/play/rehearsal/legacy`), from the city's founding, construction and design records and nothing else. Only the
 * Proofy Play page opens it, and only where its server runs the local rehearsal. Nothing here builds, saves, spends or writes.
 *
 * Kept apart, because they are different things:
 *   - FOUNDING: who activated the property first. Permanent, never control: a transfer never moves it.
 *   - CONTROL NOW: whom this local server's TEST file names as the NFT's controller. Test data, never verified ownership.
 *   - RECORDED BUILDING ERAS: each controller the construction records saw, with what they and patrons built in their time.
 *     An era is recorded only when someone builds while a controller is named, so changes of control without building
 *     may not appear: never a full ownership or transfer history. Patron units built while nobody was named belong to no
 *     era, and are told apart from the eras without placing them before, between or after any of them. A later controller
 *     inherits the property, its design and its history, never an earlier controller's own record.
 *   - INVESTMENT: the property's lifetime units by whose they are (the current controller's era, earlier controllers,
 *     patrons): the same split the construction card shows, adding up to the lifetime units.
 *   - YOUR PART: what the viewer built here, a share of the lifetime units, never added to them again.
 *   - DESIGN HISTORY: every saved revision, by relation only (you or not; whether its designer is the controller named
 *     now). Only the controller of the day can save, so each was saved while its designer was test controller; which
 *     control period that was is not recorded, and is never implied. A design is free: it adds no unit, credit, tier or progress.
 *
 * No other player is named, and there is no rank, level, XP, badge or reward to show.
 */

export type LegacyLoad = { ok: true; legacy: RehearsalPropertyLegacy } | { ok: false; problem: ClaimProblem }

/** Revisions shown before "Show all". */
const REVISIONS_SHOWN = 5

const FOUNDING: Record<RehearsalPropertyLegacy['founding'], string> = {
  viewer: 'Founded by you',
  other: 'Founded by another player',
  unrecorded: 'Founder not recorded',
}
const CONTROL: Record<RehearsalPropertyLegacy['control'], string> = {
  viewer: 'This local server’s test file names you as this NFT’s current controller.',
  other: 'This local server’s test file names another player as this NFT’s current controller.',
  unknown: 'No current controller is named for this NFT on this local server.',
}

/**
 * Who saved a revision, by relation only. `savedBy` says whether its designer is the controller named NOW, not in which
 * control period they saved it (a player may control the NFT, lose it and control it again), so the line never says the
 * save was made in today's control: only that it was made while its designer was test controller, as every save is.
 */
function savedByLine(h: RehearsalLegacyRevision): string {
  if (h.by === 'viewer') return 'Saved by you while test controller'
  return h.savedBy === 'current-controller' ? 'Saved by the player named test controller now, while test controller' : 'Saved by another player while test controller'
}

/**
 * The viewer's owner units, as the server splits them. Current-era units are in the latest recorded era, and only while
 * the source still names its controller; every other owner unit is under earlier control, which may be the latest era
 * itself once its controller is no longer named, so never "earlier eras". A part that is zero is left unsaid.
 */
function ownerSplit(y: RehearsalPropertyLegacy['yours']): string {
  return [
    y.currentEraOwnerUnits > 0 ? `${y.currentEraOwnerUnits} in the latest recorded era, whose controller is named now` : null,
    y.earlierEraOwnerUnits > 0 ? `${y.earlierEraOwnerUnits} under earlier control` : null,
  ]
    .filter(Boolean)
    .join('; ')
}

const units = (n: number) => `${n} test ${n === 1 ? 'unit' : 'units'}`
const steps = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`

export function PropertyLegacyPanel({
  city,
  buildingId,
  propertyId,
  load,
  onBack,
  onClose,
}: {
  city: LoadedBrandCity
  buildingId: string
  propertyId: string
  load: (propertyId: string) => Promise<LegacyLoad>
  onBack?: () => void
  onClose: () => void
}) {
  const [answer, setAnswer] = useState<LegacyLoad | null>(null)
  const heading = useRef<HTMLElement>(null)
  useEffect(() => {
    // Opened from a panel or the portfolio: keyboard and screen reader users land here, not behind it.
    heading.current?.focus({ preventScroll: true })
    let live = true
    void load(propertyId).then((r) => live && setAnswer(r))
    return () => {
      live = false
    }
  }, [load, propertyId])

  const { scene, state } = city
  const b = state.buildings[buildingId]
  const d = sceneDistrict(scene, b.districtId)
  const legacy = answer?.ok && answer.legacy.property.propertyId === propertyId ? answer.legacy : null
  return (
    <section
      ref={heading}
      tabIndex={-1}
      className="panel my-properties property-legacy"
      aria-label={`Property legacy of ${scene.buildingLabel(b)}`}
      data-testid="property-legacy"
      data-property-id={propertyId}
      data-state={legacy ? 'ready' : answer ? 'unavailable' : 'loading'}
      style={{ ['--dc' as string]: d.color }}
    >
      <PanelHeader kicker="PROPERTY LEGACY" title={scene.buildingLabel(b)} onBack={onBack} onClose={onClose} />
      <div className="row-between architect-tagline">
        <p className="small home-lede" data-testid="legacy-address">
          {d.title} · {wardName(b.ward)} · Plot {b.plot + 1}
          {isFoundingWard(b.ward) ? ' · Founding Ward' : ''}
        </p>
        <span className="sim-tag" data-testid="legacy-test-tag">
          LOCAL TEST
        </span>
      </div>
      {!legacy ? (
        <p className="small" role="status" data-testid="legacy-status">
          {answer && !answer.ok ? answer.problem.message : 'Reading this property’s history…'}
        </p>
      ) : (
        <LegacyRecord city={city} buildingId={buildingId} legacy={legacy} />
      )}
      <p className="muted small" data-testid="legacy-basis">
        From this city’s founding, construction and design records, read for the player Proofy Play signed in; no other player is named. LOCAL TEST: test units and a test file’s
        controller, not verified NFT ownership. There are no ranks, levels or rewards here.
      </p>
    </section>
  )
}

export function LegacyRecord({ city, buildingId, legacy: l }: { city: LoadedBrandCity; buildingId: string; legacy: RehearsalPropertyLegacy }) {
  const [allRevisions, setAllRevisions] = useState(false)
  const p = l.property
  const i = l.investment
  const y = l.yours
  const latest = l.designs[0] ?? null
  const shown = allRevisions ? l.designs : l.designs.slice(0, REVISIONS_SHOWN)
  const share = (n: number) => (i.total === 0 ? 0 : (n / i.total) * 100)
  return (
    <>
      <div className="legacy-head">
        <DesignThumb
          city={city}
          buildingId={buildingId}
          design={latest ? appearanceOf(latest) : CURRENT_DESIGN_CATALOG.default}
          caption={latest ? `Saved design · revision ${latest.revision}` : 'Standard design'}
          testId="legacy-thumb"
        />
        <dl className="stat-grid legacy-summary" data-testid="legacy-summary" data-tier={p.tier} data-built={p.built} data-eras={l.eraCount} data-revisions={l.designCount}>
          <div>
            <dt>Tier</dt>
            <dd data-testid="legacy-tier">{p.tier}</dd>
          </div>
          <div>
            <dt>Lifetime</dt>
            <dd data-testid="legacy-lifetime">{p.built}</dd>
          </div>
          <div>
            <dt>Recorded building eras</dt>
            <dd data-testid="legacy-era-count">{l.eraCount}</dd>
          </div>
          <div>
            <dt>Design revisions</dt>
            <dd data-testid="legacy-revision-count">{l.designCount}</dd>
          </div>
        </dl>
      </div>

      <div className="fund-box legacy-section" data-testid="legacy-founding" data-founding={l.founding} data-order={p.foundingOrder} data-sequence={p.activatedSequence}>
        <h3>{FOUNDING[l.founding]}</h3>
        <p className="small">
          The {ordinal(p.foundingOrder)} property founded in {city.config.cityName}, at city sequence {p.activatedSequence}.{' '}
          {l.founding === 'viewer'
            ? 'Your founding credit is permanent. It stays yours when the NFT changes hands, and founding is not control of the NFT.'
            : l.founding === 'other'
              ? 'Its founder is recorded permanently and privately. Founding is not control of the NFT.'
              : 'It was placed before founders were recorded, so its founder is unknown to everyone.'}
        </p>
      </div>

      <div className="fund-box legacy-section" data-testid="legacy-control" data-control={l.control} data-open={l.open}>
        <h3>Control now</h3>
        <p className="small">
          {l.open ? CONTROL[l.control] : 'Construction and design are not open in this city on this local server, so nobody is named as this NFT’s controller.'} LOCAL TEST control: test data,
          not verified NFT ownership. A new controller inherits the property, its design and its history, never an earlier controller’s own record.
        </p>
      </div>

      <div
        className="fund-box legacy-section"
        data-testid="legacy-investment"
        data-current-controller={i.currentController}
        data-previous-controllers={i.previousControllers}
        data-community={i.community}
        data-total={i.total}
      >
        <h3>Lifetime investment</h3>
        {i.total === 0 ? (
          <p className="small" data-testid="legacy-investment-none">
            Nothing has been built here yet: a Tier 0 foundation, as every new property starts.
          </p>
        ) : (
          <>
            <div
              className="split-bar legacy-bar"
              role="img"
              aria-label={`${i.total} lifetime test units: ${i.currentController} by the current controller in the latest recorded era, ${i.previousControllers} by earlier controllers, ${i.community} by patrons`}
              data-testid="legacy-bar"
            >
              <div className="split-owner" style={{ width: `${share(i.currentController)}%` }} />
              <div className="split-prev" style={{ width: `${share(i.previousControllers)}%` }} />
              <div className="split-comm" style={{ width: `${share(i.community)}%` }} />
            </div>
            <dl className="stat-grid legacy-split">
              <div>
                <dt>
                  <span className="legacy-key split-owner" aria-hidden="true" />
                  Current controller · latest era
                </dt>
                <dd data-testid="legacy-current-controller">{i.currentController}</dd>
              </div>
              <div>
                <dt>
                  <span className="legacy-key split-prev" aria-hidden="true" />
                  Earlier controllers
                </dt>
                <dd data-testid="legacy-previous-controllers">{i.previousControllers}</dd>
              </div>
              <div>
                <dt>
                  <span className="legacy-key split-comm" aria-hidden="true" />
                  Patrons
                </dt>
                <dd data-testid="legacy-community">{i.community}</dd>
              </div>
              <div>
                <dt>Lifetime</dt>
                <dd data-testid="legacy-total">{i.total}</dd>
              </div>
            </dl>
            <p className="muted small" data-testid="legacy-contributors" data-owners={l.contributors.owners} data-patrons={l.contributors.patrons}>
              Built by {l.contributors.owners} {l.contributors.owners === 1 ? 'controller' : 'controllers'} and {l.contributors.patrons} {l.contributors.patrons === 1 ? 'patron' : 'patrons'}. Tier{' '}
              {p.tier}
              {p.nextTierAt === null ? `, the highest tier this local rehearsal builds.` : `: ${p.nextTierAt - p.built} more lifetime units to Tier ${p.tier + 1}.`}
            </p>
          </>
        )}
      </div>

      <div
        className="fund-box legacy-section"
        data-testid="legacy-yours"
        data-owner-units={y.ownerUnits}
        data-current-era-owner-units={y.currentEraOwnerUnits}
        data-earlier-era-owner-units={y.earlierEraOwnerUnits}
        data-patron-units={y.patronUnits}
      >
        <h3>Your part in it</h3>
        {y.actions === 0 ? (
          <p className="small" data-testid="legacy-yours-none">
            You have not built on this property.
          </p>
        ) : (
          <p className="small" data-testid="legacy-yours-line">
            {units(y.ownerUnits)} as its controller
            {y.ownerUnits > 0 && ` (${ownerSplit(y)})`} · {units(y.patronUnits)} as a patron ·{' '}
            {steps(y.actions)}.
          </p>
        )}
        <p className="muted small">Your own record on this property. It is part of the lifetime total above, never added to it again.</p>
      </div>

      <div className="fund-box legacy-section" data-testid="legacy-eras-box">
        <h3>Recorded building eras</h3>
        <p className="muted small" data-testid="legacy-eras-caveat">
          These eras are recorded when building activity occurs under a named test controller. Changes of control without building activity may not appear, so this is not a full
          ownership or transfer history.
        </p>
        {l.eras.length === 0 ? (
          <p className="small" data-testid="legacy-eras-none">
            No era recorded yet: nobody has built here while a controller was named.
          </p>
        ) : (
          <ol className="patron-list legacy-list" data-testid="legacy-eras" data-count={l.eraCount}>
            {l.eras.map((e) => (
              <li key={e.era} className={e.current ? 'featured' : undefined} data-testid="legacy-era" data-era={e.era} data-current={e.current} data-yours={e.yours} data-owner-units={e.ownerUnits} data-patron-units={e.patronUnits}>
                <span className="grow">
                  <b>Era {e.era}</b> · {e.yours ? 'controlled by you' : 'controlled by another player'}
                  {e.current ? ' · the controller named now' : ''}
                  <span className="muted small legacy-sub">
                    {units(e.ownerUnits)} by its controller · {units(e.patronUnits)} by patrons · {steps(e.actions)}
                  </span>
                </span>
                <span className="muted small">
                  Tier {e.tierBefore}
                  {e.tierAfter > e.tierBefore ? ` → ${e.tierAfter}` : ''}
                </span>
              </li>
            ))}
          </ol>
        )}
        {l.eraCount > l.eras.length && <p className="muted small">and {l.eraCount - l.eras.length} earlier eras.</p>}
        {/* Not an era and not in the eras' order: built while nobody was named, which may have been before, between or after them. */}
        {l.unattributed.actions > 0 && (
          <p className="small legacy-unattributed" data-testid="legacy-era-unattributed" data-patron-units={l.unattributed.patronUnits} data-actions={l.unattributed.actions}>
            <b>While no controller was named</b> · {units(l.unattributed.patronUnits)} by patrons · {steps(l.unattributed.actions)}.{' '}
            <span className="muted">Built at times when the test file named nobody as controller: before, between or after the recorded eras. These units belong to no era.</span>
          </p>
        )}
      </div>

      <div className="fund-box legacy-section" data-testid="legacy-designs-box">
        <h3>Design history</h3>
        {l.designs.length === 0 ? (
          <p className="small" data-testid="legacy-designs-none">
            Never redesigned: drawn with the standard design every new building starts with.
          </p>
        ) : (
          <ol className="patron-list legacy-list" data-testid="legacy-designs" data-count={l.designCount}>
            {shown.map((h) => (
              <li
                key={h.revision}
                className={h === latest ? 'featured' : undefined}
                data-testid="legacy-design"
                data-revision={h.revision}
                data-catalog={h.catalog}
                data-by={h.by}
                data-saved-by={h.savedBy}
                data-facade={h.facade}
                data-roof={h.roof}
              >
                <span className="grow">
                  <b>Revision {h.revision}</b>
                  {h === latest ? ' · saved design' : ''} · {revisionName(h)}
                  <span className="muted small legacy-sub" data-testid="legacy-design-by">
                    {savedByLine(h)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
        {l.designs.length > REVISIONS_SHOWN && (
          <button type="button" className="link-btn" aria-expanded={allRevisions} onClick={() => setAllRevisions((v) => !v)} data-testid="legacy-designs-all">
            {allRevisions ? 'Show fewer revisions' : `Show all ${l.designs.length} revisions`}
          </button>
        )}
        {l.designCount > l.designs.length && <p className="muted small">and {l.designCount - l.designs.length} earlier.</p>}
        <p className="muted small" data-testid="legacy-designs-note">
          A design is free: a revision adds no construction units, test credits, tier or progress. It belongs to the property and stays with it when the NFT changes hands.
        </p>
      </div>
    </>
  )
}
