import { expect, type Page, type Route } from '@playwright/test'
import { districtForFamily } from '../src/config/familyDistricts.ts'
import { familyById } from '../src/config/rareFriends.ts'
import { activateFriend } from '../src/game/activation.ts'
import { createGenesisState } from '../src/game/genesis.ts'
import { STATE_VERSION } from '../src/game/stateSchema.ts'
import type { GameState } from '../src/game/types.ts'
import { ACTIVATION_DOMAIN_NAME, ACTIVATION_DOMAIN_VERSION, ACTIVATION_PRIMARY_TYPE, ACTIVATION_STATEMENT, ACTIVATION_TYPES, parsePlotId, type ActivationCommitResponse, type ActivationTypedData, type FriendPropertyDto } from '../src/protocol/activation.ts'

/**
 * A PRETEND RARE CITY for the activation browser tests.
 *
 * The page is the real server-mode bundle. Its API is answered here, in the test process,
 * by a small server that keeps a real city with the real engine: an activation rehearsal
 * city that already holds one activated Friend, as staging does. The wallet is a mock
 * injected provider that records everything asked of it. Nothing here is a real server, a
 * real chain, a real wallet or a real key.
 */
export const ALICE = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
export const USER = '7b0c1c7e-3c53-4d0e-9a52-6a3f5d0f1a11'
export const COLLECTION = '0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D'
/** 65 bytes. The pretend server does not verify signatures; the real one does, and has its own tests. */
export const SIGNATURE = `0x${'ab'.repeat(65)}`
/** The Friend the staging rehearsal activated, and where. */
export const REHEARSED = { tokenId: '345260', familyId: 0, plotId: 'd8-w0-p0' } as const

type Reply = { status: number; json: unknown; headers?: Record<string, string> }
/**
 * What to do with one activation request: answer truthfully, answer with this, do the work
 * and lose the answer, or do the work and answer with something else (`workThen`).
 */
type Step = 'ok' | 'lost' | Reply | { workThen: Reply }
export type Scripted = Step | (() => Step)
export const refusal = (status: number, code: string): Reply => ({ status, json: { error: code } })

export interface World {
  server: {
    game: GameState
    sequence: number
    mutations: number
    properties: Map<string, FriendPropertyDto>
    intents: Map<string, { tokenId: string; plotId: string; typedData: ActivationTypedData; committed: ActivationCommitResponse | null }>
    script: { intents: Scripted[]; commits: Scripted[] }
  }
  /** Every request the page made to an activation route, with its exact body text. */
  activationRequests: { path: string; body: string }[]
  posts(path: string): { path: string; body: string }[]
  /** Everything the page asked of the wallet. */
  walletCalls(): Promise<{ method: string; params?: unknown[] }[]>
  setWallet(patch: { signature?: unknown; chainId?: number; account?: string; declineNext?: string }): Promise<void>
}

const OWNED: [string, number][] = [
  ['345260', 0],
  ['1204', 0],
  ['812', 2],
]

export async function openWorld(page: Page): Promise<World> {
  const origin = 'http://localhost:4325'
  const server: World['server'] = { game: createGenesisState(), sequence: 1, mutations: 0, properties: new Map(), intents: new Map(), script: { intents: [], commits: [] } }
  const activationRequests: World['activationRequests'] = []
  let issued = 0

  /** One real activation, by the real engine. */
  function activate(tokenId: string, plotId: string): FriendPropertyDto | string {
    const plot = parsePlotId(plotId)!
    const familyId = OWNED.find(([id]) => id === tokenId)![1]
    const outcome = activateFriend(server.game, { userId: USER, ownerAddress: ALICE, tokenId: Number(tokenId), familyId, address: plot })
    if (!outcome.ok) return outcome.reason === 'friend-active' ? 'friend_already_activated' : 'plot_unavailable'
    server.game = outcome.state
    server.sequence += 1
    server.mutations += 1
    const property = { id: `prop-${tokenId}`, buildingId: outcome.building.id, districtId: plot.districtId, ward: plot.ward, plot: plot.plot, plotId: plot.plotId, activatedAt: '2026-10-05T12:00:00.000Z' }
    server.properties.set(tokenId, property)
    return property
  }
  // The city as staging has it: one Friend already activated, at sequence 2.
  activate(REHEARSED.tokenId, REHEARSED.plotId)
  server.mutations = 0

  function issueIntent(body: { tokenId: string; plotId: string }): Reply {
    const family = familyById(OWNED.find(([id]) => id === body.tokenId)?.[1])
    const plot = parsePlotId(body.plotId)
    if (!family || !plot) return refusal(400, 'invalid_request')
    if (server.properties.has(body.tokenId)) return refusal(409, 'friend_already_activated')
    if (plot.districtId !== districtForFamily(family.id)) return refusal(422, 'plot_invalid')
    const intentId = (++issued).toString(16).padStart(64, '0')
    const issuedAt = Date.parse('2026-10-09T12:00:00.000Z') + issued
    const typedData: ActivationTypedData = {
      domain: { name: ACTIVATION_DOMAIN_NAME, version: ACTIVATION_DOMAIN_VERSION, chainId: 4663 },
      types: ACTIVATION_TYPES,
      primaryType: ACTIVATION_PRIMARY_TYPE,
      message: { intentId: `0x${intentId}`, site: origin, statement: ACTIVATION_STATEMENT, wallet: ALICE, collection: COLLECTION, tokenId: body.tokenId, familyId: family.id, familyName: family.name, cityId: 'main', cityInstance: 'inst-1', districtId: plot.districtId, ward: plot.ward, plot: plot.plot, plotId: plot.plotId, issuedAt: String(issuedAt), expiresAt: String(issuedAt + 600_000) },
    }
    server.intents.set(intentId, { ...body, typedData, committed: null })
    return { status: 200, json: { intentId, expiresAt: new Date(issuedAt + 600_000).toISOString(), typedData, digest: `0x${'d'.repeat(64)}` } }
  }

  function commit(body: { intentId: string }): Reply {
    const intent = server.intents.get(body.intentId)
    if (!intent) return refusal(404, 'intent_not_found')
    // A committed intent answers again with the same property and changes nothing.
    if (intent.committed) return { status: 200, json: intent.committed }
    const property = activate(intent.tokenId, intent.plotId)
    if (typeof property === 'string') return refusal(409, property)
    intent.committed = { status: 'committed', property: { ...property, tokenId: intent.tokenId, sequence: server.sequence }, city: { id: 'main', instance: 'inst-1' } }
    return { status: 200, json: intent.committed }
  }

  async function scripted(route: Route, next: Scripted | undefined, work: () => Reply) {
    const step = typeof next === 'function' ? next() : (next ?? 'ok')
    if (step === 'lost') {
      work()
      return route.abort('connectionreset')
    }
    let reply: Reply
    if (step === 'ok') reply = work()
    else if ('workThen' in step) {
      work()
      reply = step.workThen
    } else reply = step
    return route.fulfill({ status: reply.status, json: reply.json, headers: { 'cache-control': 'no-store', ...reply.headers } })
  }

  await page.route('**/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const key = `${request.method()} ${path}`
    if (path.startsWith('/v1/activation')) activationRequests.push({ path, body: request.postData() ?? '' })
    switch (key) {
      case 'GET /v1/city':
        return route.fulfill({ json: { city: { id: 'main', instance: 'inst-1', sequence: server.sequence, stateVersion: STATE_VERSION, canonical: false, origin: 'demo-fixture', updatedAt: '2026-10-09T12:00:00.000Z' }, server: { mode: 'staging' }, state: server.game } })
      case 'GET /v1/viewer':
        return route.fulfill({ json: { authenticated: true, userId: USER, wallet: { address: ALICE, chainId: 4663 }, session: { expiresAt: '2026-10-16T12:00:00.000Z' } } })
      case 'GET /v1/viewer/friends':
        return route.fulfill({ json: { wallet: { address: ALICE, chainId: 4663 }, source: 'robinhood-chain', asOfBlock: '79000000', friends: OWNED.map(([tokenId, id]) => ({ tokenId, family: familyById(id), property: server.properties.get(tokenId) ?? null })) } })
      case 'POST /v1/activation/intents':
        return scripted(route, server.script.intents.shift(), () => issueIntent(request.postDataJSON()))
      case 'POST /v1/activations':
        return scripted(route, server.script.commits.shift(), () => commit(request.postDataJSON()))
    }
    return route.fulfill({ status: 404, json: { error: 'not_found' } })
  })

  await page.addInitScript(
    ({ account, signature }) => {
      const state = { account, chainId: 4663, signature: signature as unknown, decline: new Set<string>() }
      const calls: { method: string; params?: unknown[] }[] = []
      const listeners = new Map<string, Set<(payload: unknown) => void>>()
      const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((fn) => fn(payload))
      const provider = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          calls.push({ method, params })
          if (state.decline.delete(method)) throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
          switch (method) {
            case 'eth_accounts':
            case 'eth_requestAccounts':
              return [state.account]
            case 'eth_chainId':
              return `0x${state.chainId.toString(16)}`
            case 'wallet_switchEthereumChain':
              state.chainId = Number((params as [{ chainId: string }])[0].chainId)
              emit('chainChanged', `0x${state.chainId.toString(16)}`)
              return null
            case 'eth_signTypedData_v4':
              return state.signature
          }
          throw Object.assign(new Error(`unsupported method ${method}`), { code: 4200 })
        },
        on(event: string, fn: (payload: unknown) => void) {
          if (!listeners.has(event)) listeners.set(event, new Set())
          listeners.get(event)!.add(fn)
        },
        removeListener(event: string, fn: (payload: unknown) => void) {
          listeners.get(event)?.delete(fn)
        },
      }
      Object.assign(window, {
        __wallet: {
          calls,
          set(patch: { signature?: unknown; chainId?: number; account?: string; declineNext?: string }) {
            if ('signature' in patch) state.signature = patch.signature
            if (patch.declineNext) state.decline.add(patch.declineNext)
            if (patch.account) {
              state.account = patch.account
              emit('accountsChanged', [state.account])
            }
            if (patch.chainId) {
              state.chainId = patch.chainId
              emit('chainChanged', `0x${state.chainId.toString(16)}`)
            }
          },
        },
      })
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'rc-test-wallet', name: 'Test Wallet', icon: 'data:,', rdns: 'world.rarecity.test' }, provider }) }))
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    },
    { account: ALICE.toLowerCase(), signature: SIGNATURE },
  )

  await page.goto('/')
  await expect(page.getByTestId('city')).toBeVisible()
  await expect(page.getByTestId('viewer-authenticated')).toHaveAttribute('data-address', ALICE)
  await expect(page.getByTestId(`building-${REHEARSED.tokenId}`)).toBeAttached()

  type Injected = { __wallet: { calls: { method: string; params?: unknown[] }[]; set(patch: unknown): void } }
  return {
    server,
    activationRequests,
    posts: (path) => activationRequests.filter((r) => r.path === path),
    walletCalls: () => page.evaluate(() => (window as unknown as Injected).__wallet.calls.map((c) => ({ ...c }))),
    setWallet: (patch) => page.evaluate((p) => (window as unknown as Injected).__wallet.set(p), patch),
  }
}

/** Collect page errors and console output. `texts` is everything the page wrote to its console, of any kind. */
export function watchPage(page: Page) {
  const problems: string[] = []
  const texts: string[] = []
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    texts.push(m.text())
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`)
  })
  return { problems, texts }
}

export async function openFriends(page: Page) {
  await page.getByTestId('open-account').click()
  await expect(page.getByTestId('my-friends')).toHaveAttribute('data-status', 'ready')
}
export const friendRow = (page: Page, tokenId: string) => page.locator(`[data-testid="owned-friend"][data-token="${tokenId}"]`)

/** My Friends → Activate → pick the plot → open the review. Sends nothing. */
export async function reviewPlot(page: Page, tokenId: string, district: string, ward: number, plot: number) {
  await openFriends(page)
  await friendRow(page, tokenId).getByTestId('friend-activate').click()
  await expect(page.getByTestId('activation-bar')).toHaveAttribute('data-district', district)
  await page.getByTestId(`candidate-plot-${district}-${ward}-${plot}`).click()
  await expect(page.getByTestId('activation-selected')).toHaveAttribute('data-plot-id', `${district}-w${ward}-p${plot}`)
  await page.getByTestId('activation-review-open').click()
  await expect(page.getByTestId('activation-dialog')).toHaveAttribute('data-phase', 'review')
}

export async function candidatePlots(page: Page): Promise<string[]> {
  return page.locator('[data-testid^="candidate-plot-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('candidate-plot-', '')))
}
