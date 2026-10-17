import { describe, expect, it } from 'vitest'
import { parsePlaySessionResponse, runTokenFromFragment } from './play'

const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJyaWQiOiJ4In0xx.c2lnbmF0dXJlLXNpZ25hdHVyZQ'
const BODY = {
  play: { environment: 'dev', gameKey: 'rare-city', installationId: '01a14806-e132-74c6-ae8d-d7ee9453ea64', discordGuildId: '963437023327650786', runId: '01a14806-e163-7b62-8fa1-bdbb2f30bbe5', runExpiresAt: '2026-10-17T06:02:52.899Z', configVersion: 1, configHash: 'f'.repeat(64), schemaVersion: 1 },
  player: { displayName: 'Ada' },
  world: {
    id: '0199f1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b',
    provisioned: true,
    created: false,
    foundedAt: '2026-10-17T06:00:00.000Z',
    sequence: 1,
    definition: { foundingConfigVersion: 1, governingConfigVersion: 2, layoutKey: 'standard-radial-even', geometryFingerprint: 'a'.repeat(64) },
    state: { version: 1, buildings: {}, openWards: {} },
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
