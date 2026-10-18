import { beforeEach, describe, expect, it } from 'vitest'
import { ACTIVE_CONFIRM_MS, createPlayLaunchService, PlayLaunchError } from '../src/play/launch'
import { WorldRefusal, type WorldRefusalCode } from '../src/world/store'
import { DOC_A, DOC_B, fakePlay, GUILD_A, GUILD_B, INSTALLATION_A, INSTALLATION_B, memoryWorlds } from './fakePlay'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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
  let w: ReturnType<typeof memoryWorlds>
  let service: ReturnType<typeof createPlayLaunchService>
  beforeEach(() => {
    p = fakePlay()
    p.install(INSTALLATION_A, GUILD_A)
    p.install(INSTALLATION_B, GUILD_B)
    p.publish(INSTALLATION_A, DOC_A)
    p.publish(INSTALLATION_B, DOC_B)
    w = memoryWorlds()
    service = createPlayLaunchService({ play: p.play, environment: 'dev', gameKey: 'rare-city', worlds: w.store })
  })

  it('opens each installation with its own configuration, attributed to it', async () => {
    const a = await service.open({ runToken: p.launch(INSTALLATION_A, 'a') })
    const b = await service.open({ runToken: p.launch(INSTALLATION_B, 'b') })
    expect(a.play).toMatchObject({ environment: 'dev', gameKey: 'rare-city', installationId: INSTALLATION_A, discordGuildId: GUILD_A, configVersion: 1, schemaVersion: 1 })
    expect(b.play).toMatchObject({ installationId: INSTALLATION_B, discordGuildId: GUILD_B, configVersion: 1 })
    expect(a.config).toEqual(DOC_A)
    expect(b.config).toEqual(DOC_B)
    expect(a.world).toMatchObject({ provisioned: true, created: true, sequence: 1, state: { version: 1, buildings: {}, openWards: {} } })
    expect(a.world.id).toMatch(UUID_V7)
    expect(b.world.id).not.toBe(a.world.id)
    // The player exactly as Play's redeemed run named them: the identity a play session is opened for.
    expect(a.player).toEqual({ discordUserId: '111111111111111111', coreUserId: 'core-ada', displayName: 'Ada' })
    // The same installation opens the same world again.
    const again = await service.open({ runToken: p.launch(INSTALLATION_A, 'a2') })
    expect([again.world.id, again.world.created]).toEqual([a.world.id, false])
  })

  it('hands the world store exactly what it checked with Play, and nothing from the request', async () => {
    p.publish(INSTALLATION_A, { ...DOC_A, cityName: 'Harborlight Reach' })
    const pinned = p.launch(INSTALLATION_A, 'a')
    await service.open({ runToken: pinned })
    expect(w.opened).toEqual([
      {
        environment: 'dev',
        gameKey: 'rare-city',
        installationId: INSTALLATION_A,
        discordGuildId: GUILD_A,
        active: { version: 2, configHash: expect.stringMatching(/^[0-9a-f]{64}$/),  },
        pinned: { version: 2, schemaVersion: 1, configHash: expect.stringMatching(/^[0-9a-f]{64}$/), config: { ...DOC_A, cityName: 'Harborlight Reach' } },
      },
    ])
    expect(w.opened[0].active.configHash).toBe(w.opened[0].pinned.configHash)
  })

  it('lets the world store ask Play once more, boundedly, whether the pinned version is still active', async () => {
    p.publish(INSTALLATION_A, { ...DOC_A, cityName: 'Two' })
    await service.open({ runToken: p.launch(INSTALLATION_A, 'confirm') })
    const confirm = w.confirms[0]
    const before = p.calls.length
    expect(await confirm()).toEqual({ version: 2, configHash: w.opened[0].pinned.configHash })
    expect(p.calls.slice(before)).toEqual([`getInstallation ${INSTALLATION_A}`])
    // At most once per launch.
    expect(await confirm()).toBeNull()
    expect(p.calls).toHaveLength(before + 1)
    // Re-activated meanwhile: Play's answer, not the launch's earlier one.
    await service.open({ runToken: p.launch(INSTALLATION_A, 'confirm-2') })
    p.activate(INSTALLATION_A, 1)
    expect((await w.confirms[1]())?.version).toBe(1)
    // No longer active, on another server, or Play failing: no confirmation.
    for (const change of [() => p.setStatus(INSTALLATION_A, 'suspended'), () => (p.tamper.installation = { discordGuildId: GUILD_B }), () => (p.tamper.fail = { method: 'getInstallation', status: 503, code: 'unavailable' })]) {
      p.setStatus(INSTALLATION_A, 'active')
      p.tamper.installation = undefined
      p.tamper.fail = undefined
      await service.open({ runToken: p.launch(INSTALLATION_A, `c-${w.confirms.length}`) })
      change()
      expect(await w.confirms.at(-1)!()).toBeNull()
    }
  })

  it('gives up on Play\'s confirmation at its deadline', async () => {
    const slow = memoryWorlds()
    let release: () => void = () => undefined
    const stalled = new Promise<void>((r) => (release = r))
    let stall = false
    const s = createPlayLaunchService({
      play: { ...p.play, getInstallation: async (id) => (stall ? (await stalled, p.play.getInstallation(id)) : p.play.getInstallation(id)) },
      environment: 'dev',
      gameKey: 'rare-city',
      worlds: slow.store,
      activeConfirmMs: 50,
    })
    await s.open({ runToken: p.launch(INSTALLATION_A, 'deadline') })
    stall = true
    const started = Date.now()
    expect(await slow.confirms[0]()).toBeNull()
    expect(Date.now() - started).toBeLessThan(1_000)
    release()
  })

  it('confirms within a deadline shorter than the store\'s lock timeout', () => {
    expect(ACTIVE_CONFIRM_MS).toBeLessThan(5_000)
  })

  it('states each refusal of the world store, and a failing store as world_unavailable, never as Play', async () => {
    const statuses: [WorldRefusalCode, number][] = [
      ['config_invalid', 422],
      ['config_incompatible', 409],
      ['config_superseded', 409],
      ['config_binding_mismatch', 502],
      ['world_binding_conflict', 409],
      ['world_unavailable', 503],
    ]
    for (const [code, status] of statuses) {
      w.store.fail = new WorldRefusal(code, 'refused', code === 'config_incompatible' ? [{ path: 'districts', detail: 'would move' }] : undefined)
      const err = await refusal(service.open({ runToken: p.launch(INSTALLATION_A, code) }))
      expect([err.status, err.code, err.problems]).toEqual([status, code, code === 'config_incompatible' ? [{ path: 'districts', detail: 'would move' }] : undefined])
    }
    w.store.fail = new Error('connection terminated')
    const down = await refusal(service.open({ runToken: p.launch(INSTALLATION_A, 'db-down') }))
    expect([down.status, down.code]).toEqual([503, 'world_unavailable'])
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
    expect(w.opened).toEqual([])
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
        // Nothing Play got wrong ever reaches the world store.
        expect(w.opened).toEqual([])
      })
    }
  })

  it('refuses a suspended installation', async () => {
    p.setStatus(INSTALLATION_A, 'suspended')
    expect((await refusal(service.open({ runToken: p.launch(INSTALLATION_A, 'a') }))).code).toBe('installation_not_active')
    expect(w.opened).toEqual([])
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
