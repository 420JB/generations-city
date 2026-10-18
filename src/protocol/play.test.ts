import { describe, expect, it } from 'vitest'
import { parsePlayCityResponse, parsePlaySessionResponse, parsePlayViewer, runTokenFromFragment } from './play'

const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJyaWQiOiJ4In0xx.c2lnbmF0dXJlLXNpZ25hdHVyZQ'
const BODY = {
  play: { environment: 'dev', gameKey: 'rare-city', installationId: '01a14806-e132-74c6-ae8d-d7ee9453ea64', discordGuildId: '963437023327650786', runId: '01a14806-e163-7b62-8fa1-bdbb2f30bbe5', runExpiresAt: '2026-10-17T06:02:52.899Z', configVersion: 1, configHash: 'f'.repeat(64), schemaVersion: 1 },
  player: { displayName: 'Ada' },
  viewer: {
    authenticated: true,
    player: { discordUserId: '111111111111111111', coreUserId: 'core-ada', displayName: 'Ada' },
    session: { ref: '3f1c2b9a-7d4e-4c8b-9a21-5e6f7a8b9c0d', expiresAt: '2026-10-17T08:00:00.000Z', renewal: 'relaunch' },
    status: {
      guildMember: { status: 'verified', value: true, source: 'proofy-core', basis: 'launch', at: '2026-10-17T06:00:00.000Z' },
      playEntitled: { status: 'verified', value: true, source: 'proofy-core', basis: 'launch', at: '2026-10-17T06:00:00.000Z' },
      installationActive: { status: 'unknown', reason: 'authority-unavailable' },
      brandAdmin: { status: 'unknown', reason: 'not-in-contract' },
      districtRules: { status: 'unknown', reason: 'not-checked' },
    },
    permissions: { viewCity: true, claim: false, build: false },
  },
  world: {
    id: '0199f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b',
    provisioned: true,
    created: false,
    foundedAt: '2026-10-17T06:00:00.000Z',
    sequence: 1,
    definition: { foundingConfigVersion: 1, governingConfigVersion: 2, layoutKey: 'standard-radial-even', geometryFingerprint: 'a'.repeat(64) },
    state: { version: 1, buildings: {}, openWards: {} },
    districts: [{ key: 'north', geometryFingerprint: 'b'.repeat(64), centerDeg: -135, spanDeg: 120, openWards: 1, wards: [{ ward: 0, capacity: 2, occupied: 0 }], candidates: { plotIds: ['north-w0-p0', 'north-w0-p1'], newWard: false } }],
  },
  config: { cityName: 'X' },
}

describe('Play launch fragment', () => {
  it('reads exactly one well-formed run token', () => {
    expect(runTokenFromFragment(`#runToken=${TOKEN}`)).toBe(TOKEN)
    expect(runTokenFromFragment(`runToken=${TOKEN}&x=1`)).toBe(TOKEN)
    expect(runTokenFromFragment('')).toBeNull()
    expect(runTokenFromFragment('#runToken=nope')).toBeNull()
    expect(runTokenFromFragment(`#runToken=${TOKEN}&runToken=${TOKEN}`)).toBeNull()
    expect(runTokenFromFragment(`#token=${TOKEN}`)).toBeNull()
  })
})

describe('Play session response', () => {
  it('accepts the server\'s answer and refuses anything else', () => {
    expect(parsePlaySessionResponse(BODY)).toEqual(BODY)
    // Only a provisioned world, under a UUIDv7: never the old derived preview id (a UUIDv8).
    expect(parsePlaySessionResponse({ ...BODY, world: { ...BODY.world, provisioned: false } })).toBeNull()
    expect(parsePlaySessionResponse({ ...BODY, world: { ...BODY.world, id: '65f52587-14b5-8a6e-aae7-faf8ea5651ec' } })).toBeNull()
    expect(parsePlaySessionResponse({ ...BODY, world: { ...BODY.world, sequence: 0 } })).toBeNull()
    expect(parsePlaySessionResponse({ ...BODY, world: { ...BODY.world, definition: { ...BODY.world.definition, geometryFingerprint: 'x' } } })).toBeNull()
    // A stored state this page cannot read is refused, never drawn in part.
    expect(parsePlaySessionResponse({ ...BODY, world: { ...BODY.world, state: { version: 1, buildings: { 'b-1': {} }, openWards: {} } } })).toBeNull()
    expect(parsePlaySessionResponse({ ...BODY, world: { ...BODY.world, state: { version: 5, buildings: {}, users: {} } } })).toBeNull()
    expect(parsePlaySessionResponse({ ...BODY, play: { ...BODY.play, environment: 'prod' } })).toBeNull()
    expect(parsePlaySessionResponse({ ...BODY, play: { ...BODY.play, configHash: 'x' } })).toBeNull()
    expect(parsePlaySessionResponse({ ...BODY, config: null })).toBeNull()
    expect(parsePlaySessionResponse(null)).toBeNull()
  })
})

describe('Play session viewer and city read', () => {
  const source = Object.fromEntries(Object.entries(BODY.play).filter(([k]) => k !== 'runId' && k !== 'runExpiresAt'))
  const CITY = { play: source, viewer: BODY.viewer, world: BODY.world, config: BODY.config }

  it('accepts the session city read and refuses one without a viewer or with run fields only a launch has', () => {
    expect(parsePlayCityResponse(CITY)).toEqual(CITY)
    expect(parsePlayCityResponse({ ...CITY, viewer: undefined })).toBeNull()
    expect(parsePlaySessionResponse(CITY)).toBeNull()
    expect(parsePlaySessionResponse({ ...BODY, viewer: undefined })).toBeNull()
  })

  it('keeps unknown apart from verified, and never accepts a permission this build does not open', () => {
    const v = BODY.viewer
    expect(parsePlayViewer(v)).toEqual(v)
    // An unknown with a value, or a verified fact without a source, basis or time, is neither.
    expect(parsePlayViewer({ ...v, status: { ...v.status, installationActive: { status: 'unknown', reason: 'authority-unavailable', value: true } } })).toEqual(v)
    expect(parsePlayViewer({ ...v, status: { ...v.status, installationActive: { status: 'unknown', reason: 'maybe' } } })).toBeNull()
    expect(parsePlayViewer({ ...v, status: { ...v.status, guildMember: { status: 'verified', value: true, source: 'browser', basis: 'launch', at: v.status.guildMember.at } } })).toBeNull()
    expect(parsePlayViewer({ ...v, status: { ...v.status, guildMember: { status: 'verified', value: false, source: 'proofy-core', basis: 'launch', at: v.status.guildMember.at } } })).toBeNull()
    expect(parsePlayViewer({ ...v, status: { ...v.status, guildMember: { status: 'verified', value: true, source: 'proofy-core', basis: 'launch' } } })).toBeNull()
    expect(parsePlayViewer({ ...v, permissions: { viewCity: true, claim: true, build: false } })).toBeNull()
    expect(parsePlayViewer({ ...v, session: { ...v.session, renewal: 'sliding' } })).toBeNull()
    // A session the page cannot name is not one it can act for.
    expect(parsePlayViewer({ ...v, session: { expiresAt: v.session.expiresAt, renewal: 'relaunch' } })).toBeNull()
    expect(parsePlayViewer({ ...v, session: { ...v.session, ref: 'not-a-session' } })).toBeNull()
    expect(parsePlayViewer({ ...v, player: { ...v.player, discordUserId: 'ada' } })).toBeNull()
    expect(parsePlayViewer({ ...v, authenticated: false })).toBeNull()
  })
})
