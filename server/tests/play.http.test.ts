import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { createLogger } from '../src/log'
import { createPlayLaunchService, type PlayLaunchService } from '../src/play/launch'
import { DOC_A, fakePlay, GUILD_A, INSTALLATION_A, memoryWorlds } from './fakePlay'
import { TEST_ORIGIN, testConfig } from './testConfig'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

async function start(playLaunch: PlayLaunchService | null, rateLimits = false) {
  const log = createLogger(() => undefined)
  const server = createServer(createApp({ config: testConfig({ rateLimits }), db: null, migrationsDir: '/nonexistent', log, playLaunch }))
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const post = (base: string, body: unknown, origin = TEST_ORIGIN) => fetch(`${base}/v1/play/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })

describe('POST /v1/play/session', () => {
  it('answers play_disabled when the deployment is not connected to Play', async () => {
    const base = await start(null)
    const res = await post(base, { runToken: 'a.b.c' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'play_disabled' })
  })

  it('opens the city of the run, privately, from this origin only', async () => {
    const p = fakePlay()
    p.install(INSTALLATION_A, GUILD_A)
    p.publish(INSTALLATION_A, DOC_A)
    const base = await start(createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city', worlds: memoryWorlds().store }))

    const foreign = await post(base, { runToken: p.launch(INSTALLATION_A, 'x') }, 'https://evil.example')
    expect([foreign.status, await foreign.json()]).toEqual([403, { error: 'origin_mismatch' }])
    expect(p.calls).toEqual([])

    const res = await post(base, { runToken: p.launch(INSTALLATION_A, 'a') })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { play: { installationId: string }; world: { provisioned: boolean; created: boolean }; config: unknown }
    expect(body.play.installationId).toBe(INSTALLATION_A)
    expect(body.world).toMatchObject({ provisioned: true, created: true })
    expect(body.config).toEqual(DOC_A)

    const get = await fetch(`${base}/v1/play/session`)
    expect([get.status, get.headers.get('allow')]).toEqual([405, 'POST'])
  })

  it('sends refusals as { error } and configuration problems as { error, problems }', async () => {
    const p = fakePlay()
    p.install(INSTALLATION_A, GUILD_A)
    p.publish(INSTALLATION_A, { ...DOC_A, roads: 'gold' })
    const base = await start(createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city', worlds: memoryWorlds().store }))
    const named = await post(base, { runToken: 'a.b.c', installationId: INSTALLATION_A })
    expect([named.status, await named.json()]).toEqual([422, { error: 'invalid_request' }])
    const invalid = await post(base, { runToken: p.launch(INSTALLATION_A, 'bad') })
    expect(invalid.status).toBe(422)
    expect(await invalid.json()).toEqual({ error: 'config_invalid', problems: [{ path: 'roads', detail: 'is not a configurable field' }] })
    p.tamper.fail = { method: 'redeemRun', status: 503, code: 'transport_error' }
    const down = await post(base, { runToken: p.launch(INSTALLATION_A, 'down') })
    expect([down.status, down.headers.get('retry-after'), await down.json()]).toEqual([503, '10', { error: 'play_unavailable' }])
  })

  it('is limited per client network before Play is asked', async () => {
    const p = fakePlay()
    p.install(INSTALLATION_A, GUILD_A)
    p.publish(INSTALLATION_A, DOC_A)
    const base = await start(createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city', worlds: memoryWorlds().store }), true)
    for (let i = 0; i < 20; i++) expect((await post(base, { runToken: 'eyJhbGciOiJFZERTQSJ9.dW5rbm93bi10b2tlbg.c2lnbmF0dXJlLXNpZ25hdHVyZQ' })).status).toBe(403)
    const calls = p.calls.length
    const limited = await post(base, { runToken: p.launch(INSTALLATION_A, 'late') })
    expect([limited.status, await limited.json()]).toEqual([429, { error: 'rate_limited' }])
    expect(p.calls.length).toBe(calls)
  })
})
