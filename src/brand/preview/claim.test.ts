import { describe, expect, it } from 'vitest'
import { CLAIM_ENDING_MS, CLAIM_WINDOW_MS, claimCountdown, claimStep, NEXT_ACTION, problemKind, PROBLEM_TITLES, serverClockOffset, spokenCountdown, type ClaimProgress } from './claim'

const T0 = Date.parse('2026-10-21T12:00:00.000Z')
const end = new Date(T0 + CLAIM_WINDOW_MS).toISOString()

describe('the claim window countdown: the server\'s expiresAt is its only authority', () => {
  it('reads MM:SS from the ticket\'s end, rounding up to the whole second', () => {
    expect(claimCountdown(end, T0)).toMatchObject({ label: '15:00', seconds: 900, state: 'open' })
    expect(claimCountdown(end, T0 + 1)).toMatchObject({ label: '15:00', seconds: 900 })
    expect(claimCountdown(end, T0 + 1_000)).toMatchObject({ label: '14:59', seconds: 899 })
    expect(claimCountdown(end, T0 + 9 * 60_000 + 30_500)).toMatchObject({ label: '05:30', seconds: 330 })
  })

  it('is a function of the end and the clock alone: mounted again, reloaded or in another tab, it reads the same', () => {
    // Nothing is started at mount: two readings at the same instant agree whatever happened between them.
    const later = T0 + 7 * 60_000
    expect(claimCountdown(end, later)).toEqual(claimCountdown(end, later))
    expect(claimCountdown(end, later).label).toBe('08:00')
  })

  it('says when the claim is nearly over, and when it is over', () => {
    expect(claimCountdown(end, T0 + CLAIM_WINDOW_MS - CLAIM_ENDING_MS - 1)).toMatchObject({ label: '02:01', state: 'open' })
    expect(claimCountdown(end, T0 + CLAIM_WINDOW_MS - CLAIM_ENDING_MS)).toMatchObject({ label: '02:00', state: 'ending' })
    expect(claimCountdown(end, T0 + CLAIM_WINDOW_MS - 400)).toMatchObject({ label: '00:01', seconds: 1, state: 'ending' })
    expect(claimCountdown(end, T0 + CLAIM_WINDOW_MS)).toEqual({ label: '00:00', seconds: 0, state: 'ended', nextTickMs: null })
    expect(claimCountdown(end, T0 + CLAIM_WINDOW_MS + 60_000)).toMatchObject({ label: '00:00', state: 'ended' })
  })

  it('never shows more than a whole claim window, whatever a wrong clock says', () => {
    expect(claimCountdown(end, T0 - 10 * 60_000)).toMatchObject({ label: '15:00', seconds: 900 })
  })

  it('treats an unreadable end as over: it never invents time', () => {
    expect(claimCountdown('not a date', T0).state).toBe('ended')
  })

  it('redraws exactly when the shown second changes', () => {
    expect(claimCountdown(end, T0 + 500).nextTickMs).toBe(500)
    expect(claimCountdown(end, T0).nextTickMs).toBe(1_000)
    expect(claimCountdown(end, T0 + CLAIM_WINDOW_MS - 250).nextTickMs).toBe(250)
  })

  it('says the time left in words for screen readers', () => {
    expect(spokenCountdown(900)).toBe('15 minutes')
    expect(spokenCountdown(61)).toBe('1 minute 1 second')
    expect(spokenCountdown(42)).toBe('42 seconds')
    expect(spokenCountdown(0)).toBe('no time left')
  })
})

describe('the server\'s clock, from its Date header', () => {
  const header = (ms: number) => new Date(ms).toUTCString()

  it('ignores differences within the header\'s one-second resolution and the round trip', () => {
    expect(serverClockOffset(header(T0), T0, T0 + 80)).toBe(0)
    expect(serverClockOffset(header(T0 - 1_000), T0, T0 + 200)).toBe(0)
  })

  it('measures a browser clock that is minutes wrong, so the countdown still reads the server\'s time', () => {
    // The browser runs ten minutes fast: the server's header says ten minutes earlier than the browser's clock.
    const offset = serverClockOffset(header(T0 - 600_000), T0, T0 + 100)
    expect(Math.abs(offset + 600_000)).toBeLessThan(1_000)
    // Corrected, a ticket the server issued just now reads its whole window, not "time up".
    const issuedEnd = new Date(T0 - 600_000 + CLAIM_WINDOW_MS).toISOString()
    expect(claimCountdown(issuedEnd, T0 + 100 + offset).seconds).toBeGreaterThanOrEqual(899)
    expect(claimCountdown(issuedEnd, T0 + 100).state).toBe('open')
  })

  it('is 0 without a readable header, or when the request times are impossible', () => {
    expect(serverClockOffset(null, T0, T0 + 50)).toBe(0)
    expect(serverClockOffset('yesterday-ish', T0, T0 + 50)).toBe(0)
    expect(serverClockOffset(header(T0 + 600_000), T0 + 50, T0)).toBe(0)
  })
})

describe('the claim step and the next action', () => {
  const at = (p: Partial<ClaimProgress>) => claimStep({ district: 'held', nft: 'none', plotSelected: false, stage: 'choose', ended: false, ...p })

  it('walks NFT, district, plot, review, activating', () => {
    expect(at({})).toBe('nft')
    expect(at({ nft: 'checking' })).toBe('district')
    expect(at({ nft: 'assigned' })).toBe('plot')
    expect(at({ nft: 'assigned', plotSelected: true })).toBe('review')
    expect(at({ nft: 'assigned', plotSelected: true, stage: 'activating' })).toBe('activating')
  })

  it('in a city whose every district is restricted, asks for the NFT first: nothing is held meanwhile', () => {
    expect(at({ district: 'awaiting-asset' })).toBe('nft')
  })

  it('goes back to the NFT after a refusal for it, and never past a plot that is not chosen', () => {
    expect(at({ nft: 'refused', plotSelected: true })).toBe('nft')
    expect(at({ nft: 'assigned', stage: 'review' })).toBe('plot')
  })

  it('stops at an ended claim window, whatever was chosen', () => {
    expect(at({ nft: 'assigned', plotSelected: true, ended: true })).toBe('ended')
    expect(NEXT_ACTION.ended).toContain('Nothing was placed')
  })

  it('never implies a plot is held: the next action for a plot is to choose one', () => {
    expect(Object.values(NEXT_ACTION).join(' ')).not.toMatch(/reserved|held for you/i)
  })
})

describe('what a refusal asks of the player', () => {
  it('a server that cannot be reached, or a moment\'s conflict, is temporary: try again', () => {
    for (const code of [null, 'sequence_conflict', 'world_unavailable', 'play_session_unavailable', 'installation_unverified', 'rate_limited', 'something_new']) expect(problemKind(code)).toBe('retry')
  })

  it('an ended, replaced or mismatched ticket needs a fresh, validated attempt', () => {
    for (const code of ['ticket_expired', 'ticket_not_live', 'ticket_superseded', 'district_rule_applies', 'ticket_asset_mismatch', 'config_superseded']) expect(problemKind(code)).toBe('renew')
  })

  it('a refusal of this player or NFT is final here: no retry, no override', () => {
    for (const code of ['district_rule_unqualified', 'district_rule_unverified', 'not_eligible', 'rehearsal_asset_not_granted', 'asset_already_placed', 'asset_not_in_world', 'no_default_district', 'mutations_held']) expect(problemKind(code)).toBe('refused')
  })

  it('conflicting district rules are for the city\'s administrator to fix, never guessed away', () => {
    expect(problemKind('district_rule_ambiguous')).toBe('config')
    expect(problemKind('district_rule_ref_too_long')).toBe('config')
    expect(PROBLEM_TITLES.config).toContain('administrator')
  })

  it('a plot someone took first, or one outside the district, is chosen again by the player', () => {
    expect(problemKind('plot_unavailable')).toBe('plot')
    expect(problemKind('plot_outside_assignment')).toBe('plot')
    expect(problemKind('unknown_plot')).toBe('plot')
  })
})
