import { describe, expect, it } from 'vitest'
import { parsePlaySessionResponse, runTokenFromFragment } from './play'

const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJyaWQiOiJ4In0xx.c2lnbmF0dXJlLXNpZ25hdHVyZQ'
const BODY = {
  play: { environment: 'dev', gameKey: 'rare-city', installationId: '01a14806-e132-74c6-ae8d-d7ee9453ea64', discordGuildId: '963437023327650786', runId: '01a14806-e163-7b62-8fa1-bdbb2f30bbe5', runExpiresAt: '2026-10-17T06:02:52.899Z', configVersion: 1, configHash: 'f'.repeat(64), schemaVersion: 1 },
  player: { displayName: 'Ada' },
  world: { id: '65f52587-14b5-8a6e-aae7-faf8ea5651ec', provisioned: false },
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
    expect(parsePlaySessionResponse({ ...BODY, world: { ...BODY.world, provisioned: true } })).toBeNull()
    expect(parsePlaySessionResponse({ ...BODY, play: { ...BODY.play, environment: 'prod' } })).toBeNull()
    expect(parsePlaySessionResponse({ ...BODY, play: { ...BODY.play, configHash: 'x' } })).toBeNull()
    expect(parsePlaySessionResponse({ ...BODY, config: null })).toBeNull()
    expect(parsePlaySessionResponse(null)).toBeNull()
  })
})
