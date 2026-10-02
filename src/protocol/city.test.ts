import { describe, expect, it } from 'vitest'
import { createSeedState } from '../game/seed'
import { STATE_VERSION } from '../game/stateSchema'
import { ANONYMOUS_VIEWER, parseCityResponse, type CityResponse } from './city'

const response = (): CityResponse => ({
  city: { id: 'main', instance: 'inst-1', sequence: 3, stateVersion: STATE_VERSION, canonical: false, origin: 'demo-fixture', updatedAt: '2026-10-02T00:00:00.000Z' },
  viewer: ANONYMOUS_VIEWER,
  server: { mode: 'staging' },
  state: createSeedState(),
})
const withCity = (patch: Record<string, unknown>) => ({ ...response(), city: { ...response().city, ...patch } })

describe('parseCityResponse', () => {
  it('accepts a well-formed response, as sent over the wire', () => {
    const parsed = parseCityResponse(JSON.parse(JSON.stringify(response())))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.response.city.sequence).toBe(3)
  })

  it('accepts an empty city: canonical genesis has no residents', () => {
    const empty = { ...response(), city: { ...response().city, canonical: true, origin: 'genesis' }, state: { ...createSeedState(), buildings: {}, users: {} } }
    expect(parseCityResponse(empty).ok).toBe(true)
  })

  it('accepts a session viewer and nothing that would invent an identity', () => {
    expect(parseCityResponse({ ...response(), viewer: { userId: 'u-1', source: 'session' } }).ok).toBe(true)
    for (const viewer of [
      { userId: 'demo-player', source: 'demo' },
      { userId: 'u-1', source: 'anonymous' },
      { userId: null, source: 'session' },
      { userId: '', source: 'session' },
      { userId: null },
      null,
      undefined,
    ])
      expect(parseCityResponse({ ...response(), viewer }), JSON.stringify(viewer)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects anything that is not the contract', () => {
    for (const value of [null, undefined, 'city', 42, [], {}, { city: null }]) expect(parseCityResponse(value)).toEqual({ ok: false, reason: 'malformed' })
    for (const patch of [{ sequence: 0 }, { sequence: 1.5 }, { sequence: '3' }, { sequence: Number.MAX_SAFE_INTEGER + 2 }, { instance: '' }, { canonical: 'no' }, { origin: 'made-up' }, { id: 7 }, { updatedAt: null }, { stateVersion: '5' }])
      expect(parseCityResponse(withCity(patch)), JSON.stringify(patch)).toEqual({ ok: false, reason: 'malformed' })
    expect(parseCityResponse({ ...response(), server: { mode: 'prod' } })).toEqual({ ok: false, reason: 'malformed' })
    expect(parseCityResponse({ ...response(), server: undefined })).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects a state the renderer could not draw', () => {
    for (const state of [null, {}, { version: STATE_VERSION }, { ...createSeedState(), radio: 'loud' }, { ...createSeedState(), buildings: { 'b-1': {} } }])
      expect(parseCityResponse({ ...response(), state })).toEqual({ ok: false, reason: 'malformed' })
  })

  it('distinguishes a newer state version from garbage', () => {
    expect(parseCityResponse(withCity({ stateVersion: STATE_VERSION + 1 }))).toEqual({ ok: false, reason: 'unsupported-version' })
  })
})
