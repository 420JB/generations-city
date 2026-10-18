import { useEffect, useMemo, useState } from 'react'
import { parsePlayCityConfig } from '../core/playConfig'
import type { PreviewMember } from '../core/eligibility'
import type { ConfigProblem } from '../core/config'
import { loadPersistedBrandCity, type LoadedBrandCity } from '../load'
import { BrandCityPreview } from '../preview/PreviewApp'
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
  | { kind: 'ready'; source: Source; city: PlayCityResponse; loaded: LoadedBrandCity }

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
  config_incompatible: 'This server’s new city configuration would move its districts or drop a collection, so it was not applied. The city is unchanged; a server admin must keep its districts and collections in Proofy Play.',
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

/** Draw a city the server answered with, after validating its configuration again with the same code. */
function draw(source: Source, city: PlayCityResponse): Phase {
  // The server validated this configuration for this world; the page validates it again, and draws the city as
  // stored, on the geometry it was founded on.
  const parsed = parsePlayCityConfig(city.config, city.world.id)
  if (!parsed.ok) return { kind: 'refused', code: 'config_invalid', problems: parsed.problems }
  const loaded = loadPersistedBrandCity(parsed.config, city.world.state, city.world.definition.geometryFingerprint)
  if (!loaded.ok) return { kind: 'refused', code: 'config_invalid', problems: loaded.problems }
  // The server's read-only projection of districts, wards and plot candidates must be exactly what this page's engine computes.
  if (JSON.stringify(projectWorldDistricts(loaded.city.world, city.world.state)) !== JSON.stringify(city.world.districts)) return { kind: 'refused', code: 'unreadable', problems: [{ path: 'world.districts', detail: 'the city’s districts and plots do not match its stored state' }] }
  return { kind: 'ready', source, city, loaded: loaded.city }
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
    void (runToken ? openLaunch(runToken) : readSession()).then((p) => live && show(p))
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
    show(await readSession())
  }

  if (phase.kind === 'ready') return <PlayCity source={phase.source} city={phase.city} loaded={phase.loaded} onSignOut={signOut} />
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

function PlayCity({ source, city: response, loaded: city, onSignOut }: { source: Source; city: PlayCityResponse; loaded: LoadedBrandCity; onSignOut: () => void }) {
  const { play, viewer, world } = response
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
      data-buildings={buildings}
      data-candidates={world.districts.reduce((n, d) => n + d.candidates.plotIds.length, 0)}
      data-player={player.discordUserId}
      data-session-ref={viewer.session.ref}
      data-installation-status={viewer.status.installationActive.status}
    >
      <BrandCityPreview
        city={city}
        members={members}
        bar={
          <div className="preview-bar play-bar" role="region" aria-label="Proofy Play installation" data-testid="preview-bar">
            <span className="preview-flag play-flag">PROOFY PLAY · {play.environment.toUpperCase()}</span>
            <span className="preview-note" data-testid="play-world-note">
              {world.created ? 'This server’s city was just founded. ' : 'This server’s city. '}
              {buildings === 0 ? 'Nothing has been claimed or built yet.' : `${buildings} ${buildings === 1 ? 'property' : 'properties'}, nothing built yet.`} Claims are not open; the simulated viewers only preview district rules.
            </span>
            <span className="play-facts small" data-testid="play-facts">
              city <code data-testid="play-world" title={world.id}>{world.id.slice(0, 8)}</code> · server <code data-testid="play-guild">{play.discordGuildId}</code> · config{' '}
              <code data-testid="play-config-version">v{play.configVersion}</code> · <code data-testid="play-config-hash" title={play.configHash}>{play.configHash.slice(0, 12)}</code>
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
