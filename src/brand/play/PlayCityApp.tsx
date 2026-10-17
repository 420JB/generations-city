import { useEffect, useMemo, useState } from 'react'
import { parsePlayCityConfig } from '../core/playConfig'
import type { PreviewMember } from '../core/eligibility'
import type { ConfigProblem } from '../core/config'
import { standardSimulation } from '../core/simulation'
import { loadParsedBrandCity, type LoadedBrandCity } from '../load'
import { BrandCityPreview } from '../preview/PreviewApp'
import { parsePlaySessionResponse, PLAY_SESSION_ENDPOINT, runTokenFromFragment, type PlayErrorCode, type PlaySessionResponse } from '../../protocol/play'

type Phase =
  | { kind: 'no-token' }
  | { kind: 'opening' }
  | { kind: 'refused'; code: PlayErrorCode | 'unreadable'; problems: ConfigProblem[] }
  | { kind: 'ready'; session: PlaySessionResponse; city: LoadedBrandCity }

const OPEN_TIMEOUT_MS = 20_000

/** What each refusal means to the person looking at the page. Never "here is a sample city instead". */
const REFUSALS: Record<PlayErrorCode | 'unreadable', string> = {
  invalid_request: 'This launch link is malformed. Launch Rare City again from Proofy Play.',
  invalid_json: 'This launch link is malformed. Launch Rare City again from Proofy Play.',
  unsupported_media_type: 'This launch link is malformed. Launch Rare City again from Proofy Play.',
  payload_too_large: 'This launch link is malformed. Launch Rare City again from Proofy Play.',
  origin_mismatch: 'This page is not being served from Rare City’s own address.',
  rate_limited: 'Too many launches from this network just now. Wait a minute and launch again.',
  play_disabled: 'This Rare City deployment is not connected to Proofy Play.',
  run_token_refused: 'Proofy Play did not confirm this launch for Rare City.',
  run_already_used: 'This launch was already opened. Each launch opens the city once: launch Rare City again from Proofy Play.',
  run_expired: 'This launch has expired. Launch Rare City again from Proofy Play.',
  installation_not_active: 'Rare City is not active on this Discord server.',
  config_binding_mismatch: 'The city configuration Proofy Play returned does not belong to this launch, so it was not used.',
  config_schema_unsupported: 'This server’s city configuration uses a version this build of Rare City cannot read.',
  config_invalid: 'This server’s city configuration is not valid, so the city was not opened. A server admin must correct it in Proofy Play.',
  play_unavailable: 'Proofy Play could not be reached. Launch again in a moment.',
  unreadable: 'Rare City answered with something this page cannot read.',
}

/** Read the run token from the fragment once, and take it out of the address bar and history. */
function takeRunToken(): string | null {
  const token = runTokenFromFragment(window.location.hash)
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search)
  return token
}

async function openSession(runToken: string): Promise<Phase> {
  let response: Response
  let body: unknown
  try {
    response = await fetch(PLAY_SESSION_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runToken }),
      credentials: 'same-origin',
      signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
    })
    body = await response.json()
  } catch {
    return { kind: 'refused', code: 'play_unavailable', problems: [] }
  }
  if (!response.ok) {
    const b = body as { error?: unknown; problems?: unknown }
    const code = typeof b?.error === 'string' && Object.hasOwn(REFUSALS, b.error) ? (b.error as PlayErrorCode) : 'unreadable'
    const problems = Array.isArray(b?.problems) ? (b.problems as ConfigProblem[]).filter((p) => typeof p?.path === 'string' && typeof p?.detail === 'string').slice(0, 20) : []
    return { kind: 'refused', code, problems }
  }
  const session = parsePlaySessionResponse(body)
  if (!session) return { kind: 'refused', code: 'unreadable', problems: [] }
  // The server validated this configuration; the page validates it again with the same code before drawing it.
  const parsed = parsePlayCityConfig(session.config, session.world.id)
  if (!parsed.ok) return { kind: 'refused', code: 'config_invalid', problems: parsed.problems }
  const loaded = loadParsedBrandCity(parsed.config, standardSimulation(parsed.config))
  if (!loaded.ok) return { kind: 'refused', code: 'config_invalid', problems: loaded.problems }
  return { kind: 'ready', session, city: loaded.city }
}

/**
 * THE PROOFY PLAY LAUNCH PAGE: Rare City's registered launch URL. Proofy Play sends the
 * player here with a run token in the fragment; the Rare City server redeems it with Play
 * and returns the installation's pinned, hash-checked configuration, which the standard city
 * renderer draws. Anything else (no token, a refused token, an invalid configuration) is
 * said plainly and nothing is drawn.
 */
export function PlayCityApp() {
  const [runToken] = useState(takeRunToken)
  const [phase, setPhase] = useState<Phase>(() => (runToken ? { kind: 'opening' } : { kind: 'no-token' }))

  // A new launch into an open page changes only the fragment, which does not reload the document.
  // Start over from a fresh page, so nothing of the previous city survives into the next one.
  useEffect(() => {
    const relaunch = () => runTokenFromFragment(window.location.hash) && window.location.reload()
    window.addEventListener('hashchange', relaunch)
    return () => window.removeEventListener('hashchange', relaunch)
  }, [])

  useEffect(() => {
    if (!runToken) return
    let live = true
    void openSession(runToken).then((p) => live && setPhase(p))
    return () => {
      live = false
    }
  }, [runToken])

  if (phase.kind === 'ready') return <PlayCity session={phase.session} city={phase.city} />
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

function PlayCity({ session, city }: { session: PlaySessionResponse; city: LoadedBrandCity }) {
  const { play, player } = session
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
    <div className="play-city" data-testid="play-city" data-installation={play.installationId} data-guild={play.discordGuildId} data-config-version={play.configVersion} data-config-hash={play.configHash} data-world={session.world.id}>
      <BrandCityPreview
        city={city}
        members={members}
        bar={
          <div className="preview-bar play-bar" role="region" aria-label="Proofy Play installation" data-testid="preview-bar">
            <span className="preview-flag play-flag">PROOFY PLAY · {play.environment.toUpperCase()}</span>
            <span className="preview-note">
              Brand configuration from this server’s Proofy Play installation. Buildings, progress and the simulated viewers are not real; nothing is claimed, verified or spent.
            </span>
            <span className="play-facts small" data-testid="play-facts">
              server <code data-testid="play-guild">{play.discordGuildId}</code> · config <code data-testid="play-config-version">v{play.configVersion}</code> · <code data-testid="play-config-hash" title={play.configHash}>{play.configHash.slice(0, 12)}</code>
            </span>
          </div>
        }
      />
    </div>
  )
}
