import { useEffect, useMemo, useState } from 'react'
import { parsePlayCityConfig } from '../core/playConfig'
import type { PreviewMember } from '../core/eligibility'
import type { ConfigProblem } from '../core/config'
import { loadPersistedBrandCity, type LoadedBrandCity } from '../load'
import { BrandCityPreview } from '../preview/PreviewApp'
import { AssignedDistrict, RehearsalFlag, type AssignedTicket, type PlacementRehearsal, type RehearsalNft, type RehearsalResult, type TicketResult } from '../preview/rehearsal'
import { sceneDistrict } from '../../ui/city/scene'
import { nftAsset } from '../../world/asset'
import type { WorldBuildingRecord } from '../../world/cityState'
import { worldProperty } from '../../world/property'
import {
  parseRehearsalActivationResponse,
  parseRehearsalAssetsResponse,
  parseRehearsalTicketResponse,
  PLAY_REHEARSAL_ACTIVATIONS_ENDPOINT,
  PLAY_REHEARSAL_ASSETS_ENDPOINT,
  PLAY_REHEARSAL_ASSIGNMENT_ENDPOINT,
  PLAY_REHEARSAL_ENTRY_ENDPOINT,
  PLAY_REHEARSAL_RELEASE_ENDPOINT,
  PLAY_REHEARSAL_TICKET_ENDPOINT,
  type RehearsalActivationRequest,
  type RehearsalActorRequest,
  type RehearsalAsset,
  type RehearsalErrorCode,
  type RehearsalTicket,
} from '../../protocol/playRehearsal'
import {
  parsePlayCityResponse,
  parsePlaySessionResponse,
  PLAY_CITY_ENDPOINT,
  PLAY_LOGOUT_ENDPOINT,
  PLAY_SESSION_ENDPOINT,
  projectWorldDistricts,
  runTokenFromFragment,
  type PlayCityResponse,
  type PlayErrorCode,
  type PlaySessionRequest,
} from '../../protocol/play'

/** Where the city on the page came from: a launch just now, or this browser's play session. */
type Source = 'launch' | 'session'

type Phase =
  | { kind: 'no-token' }
  | { kind: 'opening'; source: Source }
  | { kind: 'signed-out' }
  /** A launch link for another player arrived in a browser signed in as `current`: nothing was opened, they still are. */
  | { kind: 'other-player'; current: string }
  /** Another tab of this browser launched or signed out: this tab's city is not the browser's session any more. */
  | { kind: 'superseded' }
  | { kind: 'refused'; code: PlayErrorCode | 'unreadable'; problems: ConfigProblem[] }
  | { kind: 'ready'; source: Source; city: PlayCityResponse; loaded: LoadedBrandCity; rehearsal: RehearsalAsset[] | null; ticket: TicketState }

/**
 * The player's district ticket in a local rehearsal: the one the server holds for them, or none and why. `awaiting`: none
 * yet because every district is restricted, so the player selects the NFT first.
 */
interface TicketState {
  ticket: RehearsalTicket | null
  note: string | null
  awaiting: boolean
}

const NO_TICKET: TicketState = { ticket: null, note: null, awaiting: false }

const OPEN_TIMEOUT_MS = 20_000

/** What each refusal means to the person looking at the page. Never "here is a sample city instead". */
const REFUSALS: Record<PlayErrorCode | 'unreadable', string> = {
  invalid_request: 'This launch link is malformed. Launch Rare City again from Proofy Play.',
  invalid_json: 'This launch link is malformed. Launch Rare City again from Proofy Play.',
  unsupported_media_type: 'This launch link is malformed. Launch Rare City again from Proofy Play.',
  payload_too_large: 'This launch link is malformed. Launch Rare City again from Proofy Play.',
  origin_mismatch: 'This page is not being served from Rare City’s own address.',
  rate_limited: 'Too many requests from this network just now. Wait a minute and try again.',
  play_disabled: 'This Rare City deployment is not connected to Proofy Play.',
  run_token_refused: 'Proofy Play did not confirm this launch for Rare City.',
  run_already_used: 'This launch was already opened. Each launch opens the city once: launch Rare City again from Proofy Play.',
  run_expired: 'This launch has expired. Launch Rare City again from Proofy Play.',
  installation_not_active: 'Rare City is not active on this Discord server.',
  config_binding_mismatch: 'The city configuration Proofy Play returned does not belong to this launch, so it was not used.',
  config_schema_unsupported: 'This server’s city configuration uses a version this build of Rare City cannot read.',
  config_invalid: 'This server’s city configuration is not valid, so the city was not opened. A server admin must correct it in Proofy Play.',
  config_incompatible:
    'This server’s new city configuration would move the districts its properties stand on, or drop a collection, so it was not applied. The city is unchanged; once a city has its first property its districts are fixed, and its collections always stay, in Proofy Play.',
  config_superseded: 'This server’s city configuration changed after this launch. Launch Rare City again from Proofy Play.',
  world_binding_conflict: 'This Discord server’s city belongs to another Rare City installation, so it was not opened.',
  world_unavailable: 'The city could not be loaded just now. Try again in a moment.',
  play_unavailable: 'Proofy Play could not be reached. Launch again in a moment.',
  play_session_required: 'Your Rare City session has ended. Launch Rare City again from Proofy Play.',
  play_session_unavailable: 'Your Rare City session could not be checked just now. Try again in a moment.',
  play_authorization_refused: 'Proofy Play no longer authorizes Rare City, so your session has ended.',
  installation_unverified: 'Proofy Play has not confirmed Rare City on this server recently, so the city is not shown just now. You are still signed in: try again in a moment.',
  play_session_other_player: 'This launch was for another Proofy player, so it was not opened.',
  play_actor_mismatch: 'This page is out of date: this browser is now signed in to another session. Reload the page.',
  unreadable: 'Rare City answered with something this page cannot read.',
}

/** What a refused rehearsal placement means to the player. Anything else reads as the session refusals above. */
const REHEARSAL_REFUSALS: Record<RehearsalErrorCode | 'invalid_request', string> = {
  rehearsal_asset_not_granted: 'This local server does not list that test NFT for you.',
  invalid_asset: 'That is not a valid NFT id.',
  invalid_request: 'This page sent a request the server could not read. Reload the page.',
  asset_not_in_world: 'That NFT is not from one of this city’s collections.',
  asset_already_placed: 'That NFT already has a property in this city.',
  unknown_plot: 'That is not a plot of this city.',
  plot_unavailable: 'Someone placed a property on that plot first. The city has been updated: choose another plot.',
  district_rule_unverified: 'This NFT belongs in a restricted district, and this local server has no Proofy rule result for you there, so it cannot be placed.',
  district_rule_unqualified: 'This NFT belongs in a restricted district whose Proofy rule this local server says you do not meet, so it cannot be placed.',
  mutations_held: 'This server does not place properties.',
  sequence_conflict: 'The city changed while your property was being placed, and nothing was written. Try again.',
  not_eligible: 'This local server lists no unplaced test NFT of this city for you, so no district was assigned.',
  no_default_district: 'Every district of this city is restricted, and no district rule places this NFT in one, so there is no district to assign.',
  ticket_not_live: 'Your district hold has ended (released, or already used for a property). Get your district again to place another.',
  ticket_expired: 'Your district hold expired before your property was placed, so nothing was placed. Get your district again: it may be a different one.',
  ticket_superseded: 'This city’s districts or district rules changed, so your district was assigned again or withdrawn. Your claim time is unchanged: get your district again if none is shown.',
  plot_outside_assignment: 'That plot is not in your assigned district. Choose a plot in your district.',
  district_rule_applies: 'A district rule assigns this NFT’s district. Select the NFT again so the server can assign it.',
  district_rule_ambiguous: 'District rules for this NFT name different districts, so it cannot be placed until the city’s administrator fixes them.',
  district_rule_ref_too_long: 'Too many district rules apply to this NFT for its district to be recorded, so it cannot be placed. The rules need fixing first.',
  ticket_asset_mismatch: 'Your district was assigned for another NFT. Select this NFT again so the server can assign its district.',
}

/** Session and Play refusals of a placement, said as what happened to the placement rather than to the city view. */
const PLACEMENT_REFUSALS: Partial<Record<PlayErrorCode, string>> = {
  config_superseded: 'Proofy Play has a newer city configuration that this city has not taken up yet, so nothing was placed. Launch Rare City again from Proofy Play, then choose your plot.',
  installation_unverified: 'Proofy Play did not confirm Rare City on this server just now, so nothing was placed. You are still signed in: try again in a moment.',
  play_session_unavailable: 'Your session could not be checked just now, so nothing was placed. Try again in a moment.',
  world_unavailable: 'The city could not be read just now, so nothing was placed. Try again in a moment.',
  rate_limited: 'Too many attempts just now. Wait a minute, then try again.',
}

/**
 * Tabs of one browser share one play session. A tab that launches or signs out says so here, and a tab showing another
 * session stops showing it as if it were still the browser's. (The server is what refuses an action from a stale tab:
 * this only keeps the page honest.)
 */
const SESSION_CHANNEL = 'rare-city-play-session'
/** This tab, so it never takes its own notice for another tab's. */
const TAB = Math.random().toString(36).slice(2)
type SessionNotice = { ref: string | null; tab: string }

function announce(ref: string | null) {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(SESSION_CHANNEL)
  channel.postMessage({ ref, tab: TAB } satisfies SessionNotice)
  channel.close()
}

/** Read the run token from the fragment once, and take it out of the address bar and history. */
function takeRunToken(): string | null {
  const token = runTokenFromFragment(window.location.hash)
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search)
  return token
}

/** A refusal body, as this page states it. */
function refusal(body: unknown): Phase {
  const b = body as { error?: unknown; problems?: unknown }
  const code = typeof b?.error === 'string' && Object.hasOwn(REFUSALS, b.error) ? (b.error as PlayErrorCode) : 'unreadable'
  const problems = Array.isArray(b?.problems) ? (b.problems as ConfigProblem[]).filter((p) => typeof p?.path === 'string' && typeof p?.detail === 'string').slice(0, 20) : []
  return { kind: 'refused', code, problems }
}

/** The page's one way to ask the server anything. Same origin only: the session cookie goes nowhere else. */
async function ask(path: string, init: RequestInit = {}): Promise<{ response: Response; body: unknown } | null> {
  try {
    const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(OPEN_TIMEOUT_MS) })
    return { response, body: await response.json() }
  } catch {
    return null
  }
}

/** The district ticket answer of a rehearsal route: the ticket, or why there is none. */
function ticketFrom(answer: { response: Response; body: unknown } | null): TicketState | { refused: string } {
  if (!answer) return { refused: 'The server could not be reached.' }
  if (answer.response.ok) {
    const parsed = parseRehearsalTicketResponse(answer.body)
    return parsed ? { ticket: parsed.ticket, note: null, awaiting: parsed.awaiting === 'asset' } : { refused: REFUSALS.unreadable }
  }
  const code = (answer.body as { error?: unknown } | null)?.error
  if (typeof code === 'string' && Object.hasOwn(REHEARSAL_REFUSALS, code)) return { refused: REHEARSAL_REFUSALS[code as RehearsalErrorCode] }
  if (typeof code === 'string' && Object.hasOwn(REFUSALS, code)) return { refused: PLACEMENT_REFUSALS[code as PlayErrorCode] ?? REFUSALS[code as PlayErrorCode] }
  return { refused: REFUSALS.unreadable }
}

/** The actor a page names: exactly the session, world and player it drew. */
const actorOf = (city: PlayCityResponse): RehearsalActorRequest => ({ sessionRef: city.viewer.session.ref, worldId: city.world.id, discordUserId: city.viewer.player.discordUserId })

const post = (path: string, body: unknown) => ask(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Draw a city the server answered with, after validating its configuration again with the same code. */
function draw(source: Source, city: PlayCityResponse): Phase {
  // The server validated this configuration for this world; the page validates it again, and draws the city as
  // stored, on the geometry the server says it is drawn on (frozen once it has a property).
  const parsed = parsePlayCityConfig(city.config, city.world.id)
  if (!parsed.ok) return { kind: 'refused', code: 'config_invalid', problems: parsed.problems }
  const loaded = loadPersistedBrandCity(parsed.config, city.world.state, city.world.definition.geometryFingerprint)
  if (!loaded.ok) return { kind: 'refused', code: 'config_invalid', problems: loaded.problems }
  // The server's read-only projection of districts, wards and plot candidates must be exactly what this page's engine computes.
  if (JSON.stringify(projectWorldDistricts(loaded.city.world, city.world.state)) !== JSON.stringify(city.world.districts)) return { kind: 'refused', code: 'unreadable', problems: [{ path: 'world.districts', detail: 'the city’s districts and plots do not match its stored state' }] }
  return { kind: 'ready', source, city, loaded: loaded.city, rehearsal: null, ticket: NO_TICKET }
}

/** The test NFTs this session's player may place, when the server runs a local rehearsal; null when it does not (404) or cannot say. */
async function readRehearsal(): Promise<RehearsalAsset[] | null> {
  const answer = await ask(PLAY_REHEARSAL_ASSETS_ENDPOINT)
  if (!answer?.response.ok) return null
  return parseRehearsalAssetsResponse(answer.body)?.assets ?? null
}

/**
 * A phase, with the rehearsal's test NFTs and the player's district ticket when it is a city and the server runs one.
 * A LAUNCH is the player's city entry: the server assigns their district (or returns the one they hold). A reload or a
 * new tab only reads the ticket they hold: it never asks for one.
 */
async function withRehearsal(p: Phase): Promise<Phase> {
  if (p.kind !== 'ready') return p
  const rehearsal = await readRehearsal()
  if (!rehearsal || rehearsal.length === 0) return { ...p, rehearsal }
  const answer = p.source === 'launch' ? await post(PLAY_REHEARSAL_ENTRY_ENDPOINT, actorOf(p.city)) : await ask(PLAY_REHEARSAL_TICKET_ENDPOINT)
  const got = ticketFrom(answer)
  return { ...p, rehearsal, ticket: 'refused' in got ? { ticket: null, note: got.refused, awaiting: false } : got }
}

/**
 * A launch: the run token, once, for the city and this browser's play session (an HttpOnly cookie this page never sees).
 * A launch link can carry anyone's run token, so one for another player than the browser is signed in as opens nothing.
 */
async function openLaunch(runToken: string): Promise<Phase> {
  const request: PlaySessionRequest = { runToken }
  const answer = await ask(PLAY_SESSION_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
  if (!answer) return { kind: 'refused', code: 'play_unavailable', problems: [] }
  const held = answer.body as { error?: unknown; session?: { displayName?: unknown } }
  if (answer.response.status === 409 && held?.error === 'play_session_other_player' && typeof held.session?.displayName === 'string') {
    return { kind: 'other-player', current: held.session.displayName }
  }
  if (!answer.response.ok) return refusal(answer.body)
  const session = parsePlaySessionResponse(answer.body)
  return session ? draw('launch', session) : { kind: 'refused', code: 'unreadable', problems: [] }
}

/** A reload or a new tab: the city of this browser's play session, if it has one. No session is not an error. */
async function readSession(): Promise<Phase> {
  const answer = await ask(PLAY_CITY_ENDPOINT)
  if (!answer) return { kind: 'refused', code: 'play_session_unavailable', problems: [] }
  if (answer.response.status === 401) return { kind: 'no-token' }
  if (!answer.response.ok) return refusal(answer.body)
  const city = parsePlayCityResponse(answer.body)
  return city ? draw('session', city) : { kind: 'refused', code: 'unreadable', problems: [] }
}

/**
 * THE PROOFY PLAY LAUNCH PAGE: Rare City's registered launch URL. Proofy Play sends the
 * player here with a run token in the fragment; the Rare City server redeems it with Play,
 * opens the installation's persistent city (founding it on the first launch), opens a play
 * session for this browser and returns the city with the pinned, hash-checked configuration.
 * Without a run token (a reload, a new tab) the page reads the city of that session, if there
 * is one. The standard city renderer draws exactly what is stored. Anything else (no session,
 * a refused token, a configuration the city cannot take) is said plainly and nothing is drawn.
 */
export function PlayCityApp() {
  const [runToken] = useState(takeRunToken)
  const [phase, setPhase] = useState<Phase>(() => ({ kind: 'opening', source: runToken ? 'launch' : 'session' }))

  // A new launch into an open page changes only the fragment, which does not reload the document.
  // Start over from a fresh page, so nothing of the previous city survives into the next one.
  useEffect(() => {
    const relaunch = () => runTokenFromFragment(window.location.hash) && window.location.reload()
    window.addEventListener('hashchange', relaunch)
    return () => window.removeEventListener('hashchange', relaunch)
  }, [])

  /** Show a phase; a launch that opened a session tells the other tabs. */
  const show = (p: Phase) => {
    if (p.kind === 'ready' && p.source === 'launch') announce(p.city.viewer.session.ref)
    setPhase(p)
  }

  useEffect(() => {
    let live = true
    void (runToken ? openLaunch(runToken) : readSession()).then(withRehearsal).then((p) => live && show(p))
    return () => {
      live = false
    }
  }, [runToken])

  const shownRef = phase.kind === 'ready' ? phase.city.viewer.session.ref : null
  useEffect(() => {
    if (!shownRef || typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(SESSION_CHANNEL)
    channel.onmessage = (e: MessageEvent<SessionNotice>) => {
      if (e.data?.tab !== TAB && e.data?.ref !== shownRef) setPhase({ kind: 'superseded' })
    }
    return () => channel.close()
  }, [shownRef])

  async function signOut() {
    const answer = await ask(PLAY_LOGOUT_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    if (answer?.response.ok) announce(null)
    setPhase(answer?.response.ok ? { kind: 'signed-out' } : { kind: 'refused', code: 'play_session_unavailable', problems: [] })
  }

  async function keepSession() {
    setPhase({ kind: 'opening', source: 'session' })
    show(await withRehearsal(await readSession()))
  }

  /**
   * LOCAL REHEARSAL: ask the server to place a test NFT on a plot, for exactly the session, world and player this page
   * drew, then read the city again so the page shows it as stored. A refusal that ends the session leaves the city.
   */
  async function placeProperty(drawn: PlayCityResponse, ticket: RehearsalTicket | null, asset: string, plotId: string): Promise<RehearsalResult> {
    if (!ticket) return { ok: false, message: REHEARSAL_REFUSALS.ticket_not_live }
    // The plot was chosen on the districts this page drew, under the district ticket it holds: the server places it only
    // on that same ground, with that live ticket.
    const request: RehearsalActivationRequest = {
      ...actorOf(drawn),
      asset,
      plotId,
      geometryFingerprint: drawn.world.definition.geometryFingerprint,
      ticketId: ticket.id,
    }
    const answer = await ask(PLAY_REHEARSAL_ACTIVATIONS_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
    if (!answer) return { ok: false, message: 'The server could not be reached. Nothing is known to have been placed: reload to see the city as stored.' }
    const placed = answer.response.ok ? parseRehearsalActivationResponse(answer.body) : null
    const refused = (answer.body as { error?: unknown } | null)?.error
    // This page no longer shows the browser's session (another tab launched or signed out): nothing was done.
    if (refused === 'play_actor_mismatch') {
      setPhase({ kind: 'superseded' })
      return { ok: false, message: REFUSALS.play_actor_mismatch }
    }
    // The session is over: nothing more can be done here.
    if ((answer.response.status === 401 || answer.response.status === 403) && typeof refused === 'string' && refused !== 'origin_mismatch' && Object.hasOwn(REFUSALS, refused)) {
      setPhase(refusal(answer.body))
      return { ok: false, message: REFUSALS[refused as PlayErrorCode] }
    }
    // The city as stored now, and the ticket held now, whatever the answer was: a placement (its ticket spent), a plot
    // someone else took first, or a ticket that ended or was reassigned.
    const next = await withRehearsal(await readSession())
    setPhase(next.kind === 'ready' && next.city.viewer.session.ref !== drawn.viewer.session.ref ? { kind: 'superseded' } : next)
    if (placed) return { ok: true, buildingId: placed.property.buildingId, fresh: placed.fresh, sequence: placed.sequence }
    // The districts changed under the page: it now shows the city as it is, and the plot must be chosen again on it.
    if (refused === 'config_superseded' && next.kind === 'ready' && next.city.world.definition.geometryFingerprint !== drawn.world.definition.geometryFingerprint)
      return { ok: false, message: 'This city’s districts changed before your property was placed, so nothing was placed. The map now shows the city as it is: choose your plot again.' }
    if (typeof refused === 'string' && Object.hasOwn(REHEARSAL_REFUSALS, refused)) return { ok: false, message: REHEARSAL_REFUSALS[refused as RehearsalErrorCode] }
    if (typeof refused === 'string' && Object.hasOwn(REFUSALS, refused)) return { ok: false, message: PLACEMENT_REFUSALS[refused as PlayErrorCode] ?? REFUSALS[refused as PlayErrorCode] }
    return { ok: false, message: REFUSALS.unreadable }
  }

  /**
   * LOCAL REHEARSAL district tickets: enter the claim flow, select an NFT (the server may assign its district by rule),
   * or leave. Each names exactly the session, world and player this page drew, and the page then shows the ticket the
   * server holds.
   */
  async function ticketCall(drawn: PlayCityResponse, path: string, body: object): Promise<TicketResult> {
    const answer = await post(path, { ...actorOf(drawn), ...body })
    const refused = (answer?.body as { error?: unknown } | null)?.error
    if (refused === 'play_actor_mismatch') {
      setPhase({ kind: 'superseded' })
      return { ok: false, message: REFUSALS.play_actor_mismatch }
    }
    if (answer && (answer.response.status === 401 || answer.response.status === 403) && typeof refused === 'string' && refused !== 'origin_mismatch' && Object.hasOwn(REFUSALS, refused)) {
      setPhase(refusal(answer.body))
      return { ok: false, message: REFUSALS[refused as PlayErrorCode] }
    }
    const got = ticketFrom(answer)
    if ('refused' in got) {
      // Whatever went wrong, show the ticket the server holds now (an expired or replaced one is gone).
      const held = ticketFrom(await ask(PLAY_REHEARSAL_TICKET_ENDPOINT))
      setPhase((p) => (p.kind === 'ready' && p.city === drawn ? { ...p, ticket: 'refused' in held ? { ticket: null, note: held.refused, awaiting: false } : { ticket: held.ticket, note: got.refused, awaiting: p.ticket.awaiting && !held.ticket } } : p))
      return { ok: false, message: got.refused }
    }
    setPhase((p) => (p.kind === 'ready' && p.city === drawn ? { ...p, ticket: got } : p))
    return { ok: true, ticket: got.ticket }
  }

  if (phase.kind === 'ready') {
    const { city, ticket } = phase
    return (
      <PlayCity
        source={phase.source}
        city={city}
        loaded={phase.loaded}
        rehearsal={phase.rehearsal}
        ticket={ticket}
        onEnter={() => ticketCall(city, PLAY_REHEARSAL_ENTRY_ENDPOINT, {})}
        // Without a ticket only in a city whose every district is restricted: the selected NFT's rule decides (the server checks).
        onAssign={(asset) => (ticket.ticket || ticket.awaiting ? ticketCall(city, PLAY_REHEARSAL_ASSIGNMENT_ENDPOINT, { ticketId: ticket.ticket?.id ?? null, asset }) : Promise.resolve({ ok: false, message: REHEARSAL_REFUSALS.ticket_not_live }))}
        onLeave={() => (ticket.ticket ? ticketCall(city, PLAY_REHEARSAL_RELEASE_ENDPOINT, { ticketId: ticket.ticket.id }) : Promise.resolve({ ok: true, ticket: null }))}
        onPlace={(asset, plotId) => placeProperty(city, ticket.ticket, asset, plotId)}
        onSignOut={signOut}
      />
    )
  }
  return (
    <div className="app play-gate" data-testid="play-gate" data-phase={phase.kind} data-code={phase.kind === 'refused' ? phase.code : ''}>
      <div className="sky" aria-hidden="true">
        <div className="stars" />
        <div className="moon" />
      </div>
      <section className="panel play-gate-panel" role={phase.kind === 'refused' ? 'alert' : 'status'}>
        <div className="kicker">PROOFY PLAY · RARE CITY</div>
        {phase.kind === 'opening' && <h2>Opening your server’s city…</h2>}
        {phase.kind === 'no-token' && (
          <>
            <h2>Launch Rare City from Proofy Play</h2>
            <p className="muted">This page opens the city of the Discord server you launch it from. Open Proofy Play in your server and choose Rare City.</p>
          </>
        )}
        {phase.kind === 'signed-out' && (
          <>
            <h2>You have left the city</h2>
            <p className="muted">This browser is no longer signed in to Rare City. Launch Rare City from Proofy Play to come back.</p>
          </>
        )}
        {phase.kind === 'other-player' && (
          <>
            <h2>This launch was for someone else</h2>
            <p>
              This browser is signed in to Rare City as <b data-testid="play-current-player">{phase.current}</b>, and the launch link it was sent to was made for another Proofy player, so
              nothing was opened. The link cannot be used again.
            </p>
            <p className="muted small">To play as someone else on this browser, sign out first, then launch Rare City from Proofy Play.</p>
            <div className="play-choices">
              <button type="button" className="chip" data-testid="play-keep-session" onClick={() => void keepSession()}>
                Continue as {phase.current}
              </button>
              <button type="button" className="chip" data-testid="play-signout-other" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </>
        )}
        {phase.kind === 'superseded' && (
          <>
            <h2>This tab is out of date</h2>
            <p className="muted">This browser has launched, or left, Rare City in another tab, so this tab no longer shows its session. Reload to see where you are signed in now.</p>
          </>
        )}
        {phase.kind === 'refused' && (
          <>
            <h2>The city was not opened</h2>
            <p data-testid="play-refusal">{REFUSALS[phase.code]}</p>
            {phase.problems.length > 0 && (
              <ul className="play-problems small muted" data-testid="play-problems">
                {phase.problems.map((p, i) => (
                  <li key={i}>
                    <code>{p.path || '(document)'}</code> {p.detail}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  )
}

/** How a viewer fact reads on the page: what is known, and how. Unknown is said as unknown, never as no. */
const fact = (f: { status: 'verified'; basis: 'launch' | 'live' } | { status: 'unknown' }) => (f.status === 'unknown' ? 'unknown' : f.basis === 'live' ? 'verified now' : 'verified at launch')

function PlayCity({
  source,
  city: response,
  loaded: city,
  rehearsal: listed,
  ticket: held,
  onEnter,
  onAssign,
  onLeave,
  onPlace,
  onSignOut,
}: {
  source: Source
  city: PlayCityResponse
  loaded: LoadedBrandCity
  rehearsal: RehearsalAsset[] | null
  ticket: TicketState
  onEnter: () => Promise<TicketResult>
  onAssign: (asset: string) => Promise<TicketResult>
  onLeave: () => Promise<TicketResult>
  onPlace: (asset: string, plotId: string) => Promise<RehearsalResult>
  onSignOut: () => void
}) {
  const { play, viewer, world } = response
  const ticket: AssignedTicket | null = held.ticket
  /** The player's test NFTs of this city's collections: those not placed yet, and how many are. */
  const mine = useMemo<{ nfts: RehearsalNft[]; placed: number } | null>(() => {
    if (!listed) return null
    const nfts: RehearsalNft[] = []
    let placed = 0
    for (const a of listed) {
      const asset = nftAsset(a)
      const property = asset && worldProperty(city.world, asset)
      if (!property) continue
      if (Object.hasOwn(world.state.buildings, property.buildingId)) placed++
      else nfts.push({ asset: a.asset, collectionName: city.config.collections.find((c) => c.key === property.collection.key)?.displayName ?? property.collection.key, tokenId: a.tokenId })
    }
    return { nfts, placed }
  }, [listed, city, world.state.buildings])
  // A player the rehearsal file lists nothing of this city for sees the city exactly as without a rehearsal.
  const rehearsal: PlacementRehearsal | null =
    mine && mine.nfts.length + mine.placed > 0 ? { ...mine, ticket, ticketNote: held.note, awaitingAsset: held.awaiting && !ticket, enter: onEnter, assign: onAssign, leave: onLeave, activate: onPlace } : null
  const stored = (buildingId: string) => {
    const b = (world.state.buildings as Readonly<Record<string, WorldBuildingRecord>>)[buildingId]
    return b
      ? {
          propertyId: b.propertyId,
          asset: b.asset,
          collection: b.collection,
          districtKey: b.districtKey,
          ward: b.ward,
          plot: b.plot,
          sequence: b.sequence,
          activator: viewer.originalActivations.includes(b.propertyId) ? ('viewer' as const) : viewer.unrecordedActivations.includes(b.propertyId) ? ('unrecorded' as const) : ('other' as const),
        }
      : null
  }
  const geometry = world.definition.districtGeometry
  const player = viewer.player
  const buildings = Object.keys(city.state.buildings).length
  const members = useMemo<(PreviewMember | null)[]>(
    () => [
      null,
      { id: 'play-player', kind: 'player', label: `${player.displayName} · Proofy rules not checked`, answers: {} },
      { id: 'sim-pass', label: 'Simulated · meets every rule', answers: Object.fromEntries(city.config.districts.flatMap((d) => (d.gate ? [[d.gate.verificationRuleId, true]] : []))) },
      { id: 'sim-fail', label: 'Simulated · meets no rule', answers: Object.fromEntries(city.config.districts.flatMap((d) => (d.gate ? [[d.gate.verificationRuleId, false]] : []))) },
    ],
    [player.displayName, city.config.districts],
  )
  return (
    <div
      className="play-city"
      data-testid="play-city"
      data-source={source}
      data-installation={play.installationId}
      data-guild={play.discordGuildId}
      data-config-version={play.configVersion}
      data-config-hash={play.configHash}
      data-world={world.id}
      data-world-created={String(world.created)}
      data-world-sequence={world.sequence}
      data-governing-version={world.definition.governingConfigVersion}
      data-geometry-fingerprint={world.definition.geometryFingerprint}
      data-geometry-frozen={String(geometry.frozen)}
      data-original-activations={viewer.originalActivations.length}
      data-buildings={buildings}
      data-candidates={world.districts.reduce((n, d) => n + d.candidates.plotIds.length, 0)}
      data-player={player.discordUserId}
      data-session-ref={viewer.session.ref}
      data-installation-status={viewer.status.installationActive.status}
      data-rehearsal={rehearsal ? 'local' : 'off'}
      data-ticket={ticket?.id ?? ''}
      data-ticket-district={ticket?.districtKey ?? ''}
    >
      <BrandCityPreview
        city={city}
        members={members}
        stored={stored}
        rehearsal={rehearsal}
        bar={
          <div className="preview-bar play-bar" role="region" aria-label="Proofy Play installation" data-testid="preview-bar">
            <span className="preview-flag play-flag">PROOFY PLAY · {play.environment.toUpperCase()}</span>
            {rehearsal && <span className="preview-flag rehearsal-bar-flag" data-testid="play-rehearsal-flag">LOCAL REHEARSAL · TEST NFTS</span>}
            <span className="preview-note" data-testid="play-world-note">
              {world.created ? 'This server’s city was just founded. ' : 'This server’s city. '}
              {buildings === 0 ? 'Nothing has been claimed or built yet.' : `${buildings} ${buildings === 1 ? 'property' : 'properties'}, nothing built yet.`}{' '}
              {rehearsal
                ? `This local server lists ${rehearsal.nfts.length + rehearsal.placed} test NFT${rehearsal.nfts.length + rehearsal.placed === 1 ? '' : 's'} for you (${rehearsal.placed} placed). Not verified ownership. `
                : 'Claims are not open; the simulated viewers only preview district rules.'}
              {rehearsal && (
                <span className="play-ticket" data-testid="play-ticket" data-state={ticket ? 'held' : rehearsal.awaitingAsset ? 'awaiting-asset' : 'none'}>
                  {ticket ? (
                    <>
                      Your district: <AssignedDistrict ticket={ticket} name={sceneDistrict(city.scene, ticket.districtKey).title} />
                    </>
                  ) : rehearsal.awaitingAsset && rehearsal.nfts.length > 0 ? (
                    <span data-testid="play-ticket-note">Every district here is restricted: open a district and select your test NFT; the server assigns its district if a rule and your local rule result allow it. </span>
                  ) : rehearsal.nfts.length > 0 ? (
                    <>
                      {held.note ? <span data-testid="play-ticket-note">{held.note} </span> : 'No district assigned. '}
                      <button type="button" className="chip" data-testid="play-ticket-enter" onClick={() => void onEnter()}>
                        Get your district
                      </button>
                    </>
                  ) : (
                    'Every test NFT of yours for this city is placed.'
                  )}
                </span>
              )}
            </span>
            {rehearsal && <RehearsalFlag />}
            <span className="play-facts small" data-testid="play-facts">
              city <code data-testid="play-world" title={world.id}>{world.id.slice(0, 8)}</code> · server <code data-testid="play-guild">{play.discordGuildId}</code> · config{' '}
              <code data-testid="play-config-version" title={`configuration hash ${play.configHash}`}>
                v{play.configVersion}
              </code>{' '}
              ·{' '}
              <span
                data-testid="play-geometry"
                data-frozen={String(geometry.frozen)}
                title={geometry.frozen ? `Fixed by the city's first property, at sequence ${geometry.atSequence}, under configuration v${geometry.configVersion}.` : 'The districts can still change until the city has its first property.'}
              >
                {geometry.frozen ? 'districts fixed' : 'districts open'}
              </span>
            </span>
            <span className="play-facts play-viewer small" data-testid="play-viewer">
              signed in as <b data-testid="play-player">{player.displayName}</b> · member {fact(viewer.status.guildMember)} · installation{' '}
              <span data-testid="play-installation-status">{fact(viewer.status.installationActive)}</span> · until{' '}
              <time dateTime={viewer.session.expiresAt}>{new Date(viewer.session.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              <button type="button" className="chip play-signout" onClick={onSignOut} data-testid="play-signout">
                Sign out
              </button>
            </span>
          </div>
        }
      />
    </div>
  )
}
