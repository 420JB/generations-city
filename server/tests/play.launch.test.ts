import { beforeEach, describe, expect, it } from 'vitest'
import { playPreviewWorldId } from '../src/engine'
import { createPlayLaunchService, PlayLaunchError } from '../src/play/launch'
import { DOC_A, DOC_B, fakePlay, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B } from './fakePlay'

async function refusal(work: Promise<unknown>): Promise<PlayLaunchError> {
  const err = await work.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(PlayLaunchError)
  return err as PlayLaunchError
}

describe('opening a city from a Play run', () => {
  let p: ReturnType<typeof fakePlay>
  let service: ReturnType<typeof createPlayLaunchService>
  beforeEach(() => {
    p = fakePlay()
    p.install(INSTALLATION_A, GUILD_A)
    p.install(INSTALLATION_B, GUILD_B)
    p.publish(INSTALLATION_A, DOC_A)
    p.publish(INSTALLATION_B, DOC_B)
    service = createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city' })
  })

  it('opens each installation with its own configuration, attributed to it', async () => {
    const a = await service.open({ runToken: p.launch(INSTALLATION_A, 'a') })
    const b = await service.open({ runToken: p.launch(INSTALLATION_B, 'b') })
    expect(a.play).toMatchObject({ environment: 'dev', gameKey: 'rare-city', installationId: INSTALLATION_A, discordGuildId: GUILD_A, configVersion: 1, schemaVersion: 1 })
    expect(b.play).toMatchObject({ installationId: INSTALLATION_B, discordGuildId: GUILD_B, configVersion: 1 })
    expect(a.config).toEqual(DOC_A)
    expect(b.config).toEqual(DOC_B)
    expect(a.world).toEqual({ id: playPreviewWorldId('dev', INSTALLATION_A), provisioned: false })
    expect(b.world.id).not.toBe(a.world.id)
    expect(a.player).toEqual({ displayName: 'Ada' })
  })

  it('loads the version the run was pinned to, never the active one', async () => {
    const pinned = p.launch(INSTALLATION_A, 'before')
    p.publish(INSTALLATION_A, { ...DOC_A, cityName: 'Harborlight Reach' })
    const opened = await service.open({ runToken: pinned })
    expect(opened.play.configVersion).toBe(1)
    expect((opened.config as { cityName: string }).cityName).toBe('Harborlight')
    expect(p.calls).toContain(`getConfigVersion ${INSTALLATION_A} 1`)
    const fresh = await service.open({ runToken: p.launch(INSTALLATION_A, 'after') })
    expect(fresh.play.configVersion).toBe(2)
    // B is untouched by A's update.
    expect((await service.open({ runToken: p.launch(INSTALLATION_B, 'b') })).play.configVersion).toBe(1)
  })

  it('takes exactly { runToken } and asks Play nothing otherwise', async () => {
    const runToken = p.launch(INSTALLATION_A, 'a')
    for (const body of [{}, { runToken, installationId: INSTALLATION_B }, { runToken, worldId: 'x' }, { runToken: 42 }, { runToken: 'not-a-jwt' }, { runToken: `${runToken}x`.repeat(400) }]) {
      expect((await refusal(service.open(body as Record<string, unknown>))).code).toBe('invalid_request')
    }
    expect(p.calls).toEqual([])
  })

  it('states Play\'s redemption refusals', async () => {
    const used = p.launch(INSTALLATION_A, 'a')
    await service.open({ runToken: used })
    expect((await refusal(service.open({ runToken: used }))).code).toBe('run_already_used')
    expect((await refusal(service.open({ runToken: p.launch(INSTALLATION_A, 'old', { expired: true }) }))).code).toBe('run_expired')
    expect((await refusal(service.open({ runToken: 'eyJhbGciOiJFZERTQSJ9.dW5rbm93bi10b2tlbg.c2lnbmF0dXJlLXNpZ25hdHVyZQ' }))).code).toBe('run_token_refused')
    p.tamper.fail = { method: 'redeemRun', status: 404, code: 'run_not_found' }
    expect((await refusal(service.open({ runToken: p.launch(INSTALLATION_A, 'b') }))).status).toBe(403)
    p.tamper.fail = { method: 'redeemRun', status: 403, code: 'installation_not_active' }
    expect((await refusal(service.open({ runToken: p.launch(INSTALLATION_A, 'c') }))).code).toBe('installation_not_active')
  })

  it('reports Play being unreachable or off-contract as unavailable, never as a refusal of the player', async () => {
    for (const fail of [
      { method: 'redeemRun', status: 503, code: 'transport_error' },
      { method: 'getInstallation', status: 500, code: 'internal_error' },
      { method: 'getConfigVersion', status: 502, code: 'invalid_response' },
    ] as const) {
      p.tamper.fail = fail
      const err = await refusal(service.open({ runToken: p.launch(INSTALLATION_A, fail.method) }))
      expect([err.status, err.code]).toEqual([503, 'play_unavailable'])
    }
  })

  describe('refuses an answer that does not belong to the run', () => {
    const cases: [string, (p: ReturnType<typeof fakePlay>) => void][] = [
      ['a run for another game', (p) => (p.tamper.run = { gameKey: 'other-game' })],
      ['an installation that is not the run\'s', (p) => (p.tamper.installation = { id: INSTALLATION_B })],
      ['an installation of another game', (p) => (p.tamper.installation = { gameKey: 'other-game' })],
      ['an installation on another Discord server', (p) => (p.tamper.installation = { discordGuildId: GUILD_B })],
      ['a configuration of another installation', (p) => (p.tamper.version = { installationId: INSTALLATION_B })],
      ['another version', (p) => (p.tamper.version = { version: 2 })],
      ['another hash', (p) => (p.tamper.version = { configHash: 'f'.repeat(64) })],
      ['a document that does not hash to the pinned hash', (p) => (p.tamper.version = { config: { ...DOC_A, cityName: 'Swapped' } })],
      ['another installation\'s document under this hash', (p) => (p.tamper.version = { config: structuredClone(DOC_B) })],
      ['a missing pinned version', (p) => (p.tamper.fail = { method: 'getConfigVersion', status: 404, code: 'config_version_not_found' })],
      ['an installation Play does not show', (p) => (p.tamper.fail = { method: 'getInstallation', status: 404, code: 'installation_not_found' })],
    ]
    for (const [label, apply] of cases) {
      it(label, async () => {
        apply(p)
        const err = await refusal(service.open({ runToken: p.launch(INSTALLATION_A, label) }))
        expect([err.status, err.code]).toEqual([502, 'config_binding_mismatch'])
      })
    }
  })

  it('refuses a suspended installation', async () => {
    p.setStatus(INSTALLATION_A, 'suspended')
    expect((await refusal(service.open({ runToken: p.launch(INSTALLATION_A, 'a') }))).code).toBe('installation_not_active')
  })

  it('refuses a schema version it cannot read', async () => {
    p.publish(INSTALLATION_A, DOC_A, 2)
    const err = await refusal(service.open({ runToken: p.launch(INSTALLATION_A, 'v2') }))
    expect([err.status, err.code]).toEqual([422, 'config_schema_unsupported'])
  })

  it('refuses an invalid configuration with its problems, and substitutes nothing', async () => {
    p.publish(INSTALLATION_A, { ...DOC_A, camera: { zoom: 3 }, districts: DOC_A.districts.map((d) => ({ ...d, key: 'same' })) })
    const err = await refusal(service.open({ runToken: p.launch(INSTALLATION_A, 'bad') }))
    expect([err.status, err.code]).toEqual([422, 'config_invalid'])
    expect(err.problems).toContainEqual({ path: 'camera', detail: 'is not a configurable field' })
    p.publish(INSTALLATION_A, { ...DOC_A, districts: DOC_A.districts.map((d) => ({ ...d, key: 'same' })) })
    const dup = await refusal(service.open({ runToken: p.launch(INSTALLATION_A, 'dup') }))
    expect(dup.problems?.map((x) => x.detail)).toContain('district same is listed twice')
  })
})
