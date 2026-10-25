import { useEffect, useRef, useState } from 'react'
import { isFoundingWard } from '../../game/allocation'
import { sceneDistrict } from '../../ui/city/scene'
import { PanelHeader, ProgressBar, SceneDistrictEmblem } from '../../ui/common'
import type { RehearsalArchitectProperty, RehearsalArchitectView } from '../../protocol/playRehearsal'
import type { LoadedBrandCity } from '../load'
import type { ClaimProblem } from './claim'
import { plotAddress } from './properties'

/**
 * ARCHITECT ACTIVITY (P1-C2-E3B): the signed-in player's own LOCAL TEST construction record in this city, exactly as the
 * server read it from its construction records for the player Proofy Play signed in (`GET /v1/play/rehearsal/architect`).
 * Nothing the page sends names the player, and nothing here builds, spends or writes: each property is one tap from its
 * panel, where its construction card acts.
 *
 * What it says, and what it does not:
 *   - owner units are what the player built while this local server's TEST file named them the NFT's controller: their
 *     own builder progression, split into control they hold now and control that has since ended (still theirs);
 *   - patron units develop other players' properties and are never counted as the player's own progression;
 *   - founding a property is a permanent record of who activated it first, never ownership, and the TEST file's
 *     controller is never verified NFT control;
 *   - descriptive statistics only: no rank, level, XP, badge or reward exists, so none is shown.
 *
 * A property the TEST file names the player the controller of also offers its ARCHITECT DESIGN view (P1-C2-E4A, `design.tsx`).
 */

export type ArchitectLoad = { ok: true; view: RehearsalArchitectView } | { ok: false; problem: ClaimProblem }

const collectionName = (city: LoadedBrandCity, key: string) => city.config.collections.find((c) => c.key === key)?.displayName ?? key
const tokenOf = (asset: string) => asset.slice(asset.lastIndexOf('/') + 1)
const CONTROL: Record<RehearsalArchitectProperty['control'], string> = { viewer: 'Test controller: you', other: 'Test controller: another player', unknown: 'No test controller named' }

export function ArchitectPanel({
  city,
  load,
  onView,
  onDesign,
  onBack,
  onClose,
}: {
  city: LoadedBrandCity
  load: () => Promise<ArchitectLoad>
  onView: (buildingId: string) => void
  /** Opens a property's Architect design view (where the server runs it): offered for properties the player is named the controller of. */
  onDesign?: (buildingId: string) => void
  onBack?: () => void
  onClose: () => void
}) {
  const [answer, setAnswer] = useState<ArchitectLoad | null>(null)
  const heading = useRef<HTMLElement>(null)
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
    let live = true
    void load().then((r) => live && setAnswer(r))
    return () => {
      live = false
    }
  }, [load])

  const view = answer?.ok ? answer.view : null
  return (
    <section ref={heading} tabIndex={-1} className="panel my-properties architect-activity" aria-label="Architect activity" data-testid="architect-activity" data-state={view ? 'ready' : answer ? 'unavailable' : 'loading'}>
      <PanelHeader kicker="ARCHITECT ACTIVITY" title="Your construction record" onBack={onBack} onClose={onClose} />
      <div className="row-between architect-tagline">
        <p className="small home-lede">What you have built in {city.config.cityName}, from the city’s construction records.</p>
        <span className="sim-tag" data-testid="architect-test-tag">
          LOCAL TEST
        </span>
      </div>
      {!view ? (
        <p className="small" role="status" data-testid="architect-status">
          {answer && !answer.ok ? answer.problem.message : 'Reading your construction record…'}
        </p>
      ) : (
        <ArchitectRecord city={city} view={view} onView={onView} onDesign={onDesign} />
      )}
      <p className="muted small" data-testid="architect-basis">
        Owner units count only while this local server’s TEST file named you the NFT’s controller: test data, not verified NFT control. Founding a property is not owning it. Patron
        units develop other players’ properties and never count as your own progress. There are no ranks, levels or rewards here.
      </p>
    </section>
  )
}

function ArchitectRecord({ city, view, onView, onDesign }: { city: LoadedBrandCity; view: RehearsalArchitectView; onView: (buildingId: string) => void; onDesign?: (buildingId: string) => void }) {
  const { totals: t, credits } = view
  return (
    <>
      <dl
        className="stat-grid architect-totals"
        data-testid="architect-totals"
        data-owner-units={t.ownerUnits}
        data-current-era-owner-units={t.currentEraOwnerUnits}
        data-earlier-era-owner-units={t.earlierEraOwnerUnits}
        data-patron-units={t.patronUnits}
        data-tiers-completed={t.tiersCompleted}
        data-properties-developed={t.propertiesDeveloped}
      >
        <div>
          <dt>As owner</dt>
          <dd data-testid="architect-owner-units">{t.ownerUnits} units</dd>
        </div>
        <div>
          <dt>As patron</dt>
          <dd data-testid="architect-patron-units">{t.patronUnits} units</dd>
        </div>
        <div>
          <dt>Under control you hold now</dt>
          <dd data-testid="architect-current-era">{t.currentEraOwnerUnits}</dd>
        </div>
        <div>
          <dt>Under earlier control</dt>
          <dd data-testid="architect-earlier-eras">{t.earlierEraOwnerUnits}</dd>
        </div>
        <div>
          <dt>Tier changes you completed</dt>
          <dd data-testid="architect-tiers-completed">{t.tiersCompleted}</dd>
        </div>
        <div>
          <dt>Properties you built on</dt>
          <dd data-testid="architect-properties-developed">
            {t.propertiesDeveloped}
            {t.propertiesDevelopedAsOwner > 0 && <span className="muted small"> · {t.propertiesDevelopedAsOwner} as owner</span>}
          </dd>
        </div>
      </dl>
      <p className="muted small" data-testid="architect-actions">
        {t.ownerActions} {t.ownerActions === 1 ? 'step' : 'steps'} as owner · {t.patronActions} as patron · {credits.available} test credits to spend here.
      </p>
      {view.properties.length === 0 ? (
        <p className="small" data-testid="architect-empty">
          Nothing to show yet: you have not founded, been named the test controller of, or built on a property in this city.
        </p>
      ) : (
        <ul className="home-list" aria-label={`Your construction activity in ${city.config.cityName}`} data-testid="architect-properties" data-count={view.propertyCount}>
          {view.properties.map((a) => (
            <ArchitectItem key={a.buildingId} city={city} a={a} thresholds={view.recipe.tierThresholds} onView={onView} onDesign={a.control === 'viewer' ? onDesign : undefined} />
          ))}
        </ul>
      )}
      {view.propertyCount > view.properties.length && <p className="muted small">and {view.propertyCount - view.properties.length} more.</p>}
    </>
  )
}

function ArchitectItem({ city, a, thresholds, onView, onDesign }: { city: LoadedBrandCity; a: RehearsalArchitectProperty; thresholds: readonly number[]; onView: (buildingId: string) => void; onDesign?: (buildingId: string) => void }) {
  const d = sceneDistrict(city.scene, a.districtKey)
  const name = `${collectionName(city, a.collection)} #${tokenOf(a.asset)}`
  const floor = a.tier === 0 ? 0 : thresholds[a.tier - 1]
  const progress = a.nextTierAt === null ? 1 : (a.built - floor) / (a.nextTierAt - floor)
  const s = a.standing
  const next =
    s.kind === 'complete'
      ? `Tier ${a.tier} complete: the highest tier this local rehearsal builds.`
      : `Next: ${s.role === 'owner' ? 'an owner step' : 'a patron step'} of ${s.units} TEST credits toward Tier ${a.tier + 1}${s.kind === 'insufficient' ? ' (not enough test credits yet)' : ''}.`
  const y = a.yours
  return (
    <li
      className="home-item architect-item"
      style={{ ['--dc' as string]: d.color }}
      data-testid="architect-property"
      data-building={a.buildingId}
      data-property-id={a.propertyId}
      data-tier={a.tier}
      data-built={a.built}
      data-founded={a.founded}
      data-control={a.control}
      data-standing={s.kind}
      data-owner-units={y.ownerUnits}
      data-current-era-owner-units={y.currentEraOwnerUnits}
      data-earlier-era-owner-units={y.earlierEraOwnerUnits}
      data-patron-units={y.patronUnits}
    >
      <SceneDistrictEmblem district={d} size={34} />
      <div className="grow home-item-text">
        <div className="strong home-item-name">{name}</div>
        <div className="small">
          {d.title} · {plotAddress(a.ward, a.plot)}
          {isFoundingWard(a.ward) ? ' · Founding Ward' : ''}
        </div>
        <div className="small" data-testid="architect-property-tier">
          <b>Tier {a.tier}</b> · {a.built} test units{a.nextTierAt !== null ? ` · ${a.nextTierAt - a.built} more to Tier ${a.tier + 1}` : ''}
        </div>
        <ProgressBar value={progress} color={d.color} label={a.nextTierAt === null ? `Tier ${a.tier} complete` : `Test construction progress to Tier ${a.tier + 1}`} />
        <div className="muted small" data-testid="architect-property-yours">
          You: {y.ownerUnits} as owner{y.earlierEraOwnerUnits > 0 ? ` (${y.earlierEraOwnerUnits} under earlier control)` : ''} · {y.patronUnits} as patron
        </div>
        <div className="muted small" data-testid="architect-property-basis">
          {[a.founded ? 'Founded by you' : null, CONTROL[a.control]].filter(Boolean).join(' · ')}
        </div>
        <div className="small" data-testid="architect-property-next">
          {next}
        </div>
      </div>
      <div className="architect-item-actions">
        <button type="button" className="warp-btn sm" onClick={() => onView(a.buildingId)} aria-label={`Open ${name}, ${d.title}, ${plotAddress(a.ward, a.plot)}`} data-testid="architect-property-view">
          OPEN
        </button>
        {onDesign && (
          <button type="button" className="warp-btn sm" onClick={() => onDesign(a.buildingId)} aria-label={`Architect design of ${name}`} data-testid="architect-property-design">
            DESIGN
          </button>
        )}
      </div>
    </li>
  )
}
