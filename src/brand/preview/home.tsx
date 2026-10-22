import { useEffect, useRef } from 'react'
import { isFoundingWard } from '../../game/allocation'
import { tierFor, totalBuilt } from '../../game/economy'
import { sceneDistrict } from '../../ui/city/scene'
import { PanelHeader, SceneDistrictChip, SceneDistrictEmblem } from '../../ui/common'
import type { LoadedBrandCity } from '../load'
import { ordinal, plotAddress, type FoundedProperty, type PropertyContext } from './properties'

/**
 * THE PLAYER'S PROPERTY HOME, as the standard city page presents it (P1-C2-E2). Only the Proofy Play page
 * passes one: the properties the server's permanent record says the session's player FOUNDED in this
 * city. Everything here reads the city as stored; nothing here claims, builds, spends or writes.
 */

/** What the page knows of the signed-in player's properties in this city. */
export interface PropertyHome {
  /** The properties the player founded, most recent first (`foundedProperties`). */
  founded: readonly FoundedProperty[]
  /** How many of the city's properties were placed before founders were recorded: nobody's list shows them. */
  unrecorded: number
}

/** The one thing a player can do next from their home: continue the claim they hold, or start one. */
export interface HomeClaim {
  label: string
  run: () => void
}

const collectionName = (city: LoadedBrandCity, key: string) => city.config.collections.find((c) => c.key === key)?.displayName ?? key

/**
 * MY PROPERTIES: the properties the player founded here, each with its NFT, district and exact plot, one tap from
 * its panel and the camera. A founding is permanent; it is not a claim about who holds the NFT today.
 */
export function MyPropertiesPanel({
  city,
  home,
  claim,
  onView,
  onClose,
}: {
  city: LoadedBrandCity
  home: PropertyHome
  /** Absent when there is nothing the player can claim from here. */
  claim: HomeClaim | null
  onView: (buildingId: string) => void
  onClose: () => void
}) {
  const { scene, config } = city
  const { founded } = home
  const heading = useRef<HTMLElement>(null)
  // Opened from the HUD: keyboard and screen reader users land on the panel, not behind it.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])
  return (
    <section ref={heading} tabIndex={-1} className="panel my-properties" aria-label="My properties" data-testid="my-properties" data-count={founded.length}>
      <PanelHeader kicker="MY PROPERTIES" title={founded.length === 0 ? 'No properties yet' : `Founded by you · ${founded.length}`} onClose={onClose} />
      <p className="small home-lede" data-testid={founded.length === 0 ? 'my-properties-empty' : 'my-properties-lede'}>
        {founded.length === 0
          ? `You have not founded a property in ${config.cityName} yet. When you activate an NFT on a plot, it is recorded here for good.`
          : `Properties you activated first in ${config.cityName}. A founding is permanent; it does not say who holds the NFT today.`}
      </p>
      {founded.length > 0 && (
        <ul className="home-list" aria-label={`Properties you founded in ${config.cityName}`} data-testid="my-properties-list">
          {founded.map((p) => {
            const d = sceneDistrict(scene, p.districtKey)
            const name = `${collectionName(city, p.collection)} #${p.tokenId}`
            const built = city.state.buildings[p.buildingId]
            return (
              <li key={p.buildingId} className="home-item" style={{ ['--dc' as string]: d.color }} data-testid="my-property" data-building={p.buildingId} data-property-id={p.propertyId} data-asset={p.asset} data-plot-id={p.plotId} data-sequence={p.sequence}>
                <SceneDistrictEmblem district={d} size={34} />
                <div className="grow home-item-text">
                  <div className="strong home-item-name" data-testid="my-property-name">
                    {name}
                  </div>
                  <div className="small" data-testid="my-property-address">
                    {d.title} · {plotAddress(p.ward, p.plot)}
                    {isFoundingWard(p.ward) ? ' · Founding Ward' : ''}
                  </div>
                  <div className="muted small">
                    Tier {built ? tierFor(totalBuilt(built)) : 0} · {ordinal(p.order)} property of the city · <code>{p.plotId}</code>
                  </div>
                </div>
                <button type="button" className="warp-btn sm" onClick={() => onView(p.buildingId)} aria-label={`Warp to ${name}, ${d.title}, ${plotAddress(p.ward, p.plot)}`} data-testid="my-property-view">
                  WARP
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {claim && (
        <button type="button" className="btn primary home-claim" onClick={claim.run} data-testid="my-properties-claim">
          {claim.label}
        </button>
      )}
      <p className="muted small" data-testid="my-properties-basis">
        From the city’s permanent record of original activators, matched to the player Proofy Play signed in. Current NFT holders are not checked here.
        {home.unrecorded > 0 && ` ${home.unrecorded} ${home.unrecorded === 1 ? 'property here was' : 'properties here were'} placed before founders were recorded, so no one’s list shows ${home.unrecorded === 1 ? 'it' : 'them'}.`}
      </p>
    </section>
  )
}

/** The city and district around a stored property: real counts from the stored city, its neighbours, and where else to look. */
export function PropertyContextCard({ city, context, onWarp, onDistrict }: { city: LoadedBrandCity; context: PropertyContext; onWarp: (buildingId: string) => void; onDistrict: (districtId: string) => void }) {
  const { scene } = city
  const d = sceneDistrict(scene, context.district.key)
  const others = context.others
  return (
    <div className="fund-box property-context" data-testid="property-context" data-district={d.id} data-district-properties={context.district.properties} data-city-properties={context.cityProperties}>
      <div className="row-between">
        <h3>Around this property</h3>
      </div>
      <dl className="stat-grid">
        <div>
          <dt>In {d.name}</dt>
          <dd data-testid="context-district-properties">{context.district.properties}</dd>
        </div>
        <div>
          <dt>In the city</dt>
          <dd data-testid="context-city-properties">{context.cityProperties}</dd>
        </div>
        <div>
          <dt>Wards open</dt>
          <dd>{context.district.wardsOpen}</dd>
        </div>
        <div>
          <dt>Free plots</dt>
          <dd>{context.district.freePlots}</dd>
        </div>
      </dl>
      {context.neighbours.length > 0 ? (
        <>
          <p className="muted small home-sub">Nearby in {d.name}, closest plots first</p>
          <ul className="patron-list" data-testid="property-neighbours">
            {context.neighbours.map((n) => {
              const name = `${collectionName(city, n.collection)} #${n.tokenId}`
              return (
                <li key={n.buildingId} data-testid="property-neighbour" data-building={n.buildingId}>
                  <span className="grow">
                    {name}
                    <span className="muted small"> · {plotAddress(n.ward, n.plot)}</span>
                  </span>
                  <button type="button" className="warp-btn sm" style={{ ['--dc' as string]: d.color }} onClick={() => onWarp(n.buildingId)} aria-label={`Warp to ${name}, ${plotAddress(n.ward, n.plot)}`} data-testid="neighbour-warp">
                    WARP
                  </button>
                </li>
              )
            })}
          </ul>
          {context.moreNeighbours > 0 && <p className="muted small">and {context.moreNeighbours} more in {d.name}.</p>}
        </>
      ) : (
        <p className="muted small" data-testid="property-neighbours-none">
          The only property in {d.name} so far.
        </p>
      )}
      {others.length > 0 && (
        <>
          <p className="muted small home-sub">Explore other districts</p>
          <div className="chip-row home-districts">
            {others.map((o) => {
              const x = sceneDistrict(scene, o.key)
              return (
                <button key={o.key} type="button" className="link-btn" onClick={() => onDistrict(o.key)} aria-label={`${x.title}: ${o.properties} ${o.properties === 1 ? 'property' : 'properties'}`} data-testid={`explore-${o.key}`} data-properties={o.properties}>
                  <SceneDistrictChip district={x} small /> <span className="muted small">{o.properties}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/** Where building goes, said once and plainly: nothing here builds, spends or unlocks anything. */
export function ConstructionNote({ tier }: { tier: number }) {
  return (
    <div className="fund-box construction-note" data-testid="construction-note">
      <div className="row-between">
        <h3>Construction</h3>
        <span className="sim-tag">COMING LATER</span>
      </div>
      <p className="small" data-testid="construction-tier" data-tier={tier}>
        {tier === 0 ? 'This property is a Tier 0 foundation, as every new property starts.' : `This property stands at Tier ${tier}.`} Building upward is not open in this city yet: there is nothing to
        spend, earn or unlock here.
      </p>
    </div>
  )
}
