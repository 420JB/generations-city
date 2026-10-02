import { describe, expect, it } from 'vitest'
import { createSeedState } from '../game/seed'
import { STATE_VERSION } from '../game/stateSchema'
import { parseCityResponse, type CityResponse } from './city'

const response = (): CityResponse => ({
  city: { id: 'main', instance: 'inst-1', sequence: 3, stateVersion: STATE_VERSION, canonical: false, origin: 'demo-fixture', updatedAt: '2026-10-02T00:00:00.000Z' },
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

  it('carries no viewer: the city is one document for everyone', () => {
    const parsed = parseCityResponse(JSON.parse(JSON.stringify(response())))
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(Object.keys(parsed.response)).toEqual(['city', 'server', 'state'])
  })

  it('still reads a body from a server that sent a viewer, and never takes an identity from it', () => {
    // Servers before identity moved to /v1/viewer put a viewer in the city body.
    for (const viewer of [{ userId: null, source: 'anonymous' }, { userId: 'u-1', source: 'session' }, { userId: 'demo-player', source: 'demo' }, { userId: 'u-1', source: 'anonymous' }, 'nonsense', null]) {
      const parsed = parseCityResponse({ ...response(), viewer })
      if (!parsed.ok) throw new Error(`${parsed.reason} for ${JSON.stringify(viewer)}`)
      expect(parsed.response).not.toHaveProperty('viewer')
      expect(Object.keys(parsed.response)).toEqual(['city', 'server', 'state'])
      expect(parsed.response.city.sequence).toBe(3)
    }
  })

  it('returns only the contract: unknown keys do not ride along to the renderer', () => {
    const parsed = parseCityResponse({ ...response(), city: { ...response().city, extra: 1 }, server: { mode: 'staging', extra: 1 }, session: { userId: 'u-1' } })
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(parsed.response.city).toEqual(response().city)
    expect(parsed.response.server).toEqual({ mode: 'staging' })
    expect(parsed.response).not.toHaveProperty('session')
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
