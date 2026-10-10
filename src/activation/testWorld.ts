import { districtForFamily } from '../config/familyDistricts'
import { familyById } from '../config/rareFriends'
import { activateFriend } from '../game/activation'
import { createGenesisState } from '../game/genesis'
import { STATE_VERSION } from '../game/stateSchema'
import type { GameState } from '../game/types'
import { createIdentityStore } from '../identity/store'
import type { Eip1193Provider, WalletOption, WalletSource } from '../identity/wallet'
import {
  ACTIVATION_DOMAIN_NAME,
  ACTIVATION_DOMAIN_VERSION,
  ACTIVATION_PRIMARY_TYPE,
  ACTIVATION_STATEMENT,
  ACTIVATION_TYPES,
  parsePlotId,
  type ActivationCommitResponse,
  type ActivationTypedData,
  type FriendPropertyDto,
} from '../protocol/activation'
import { createServerTransport } from '../transport/server'
import { createActivationFlow, type ActivationSnapshot } from './flow'
import { createInjectedSigner } from './signer'

/**
 * TEST SUPPORT (not shipped: nothing in the app imports it). A whole pretend Rare City for
 * the activation tests: a server that keeps a real city with the real engine and answers the
 * real routes, a wallet that records everything asked of it, and the app's own identity
 * store, city transport and signer wired to them. No network, no chain, no real key.
 */
export const ALICE = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
export const BOB = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
export const USER = '7b0c1c7e-3c53-4d0e-9a52-6a3f5d0f1a11'
export const ORIGIN = 'https://rarecity.example'
export const COLLECTION = '0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D'
/** 65 bytes of nothing in particular. The pretend server does not verify it; the real one would. */
export const SIGNATURE = `0x${'ab'.repeat(65)}`

/** An answer. No `json` = a page that is not JSON; `text` = that exact body instead. */
export type Reply = { status: number; json?: unknown; text?: string; headers?: Record<string, string> } | 'network-error'
/**
 * How the server treats one activation request, taken in order from a script:
 * - a `Reply`           answer with it and do nothing else;
 * - `'lost'`            do the real work, then lose the answer on the way back;
 * - `'lost-as-503'`     do the real work, then answer `503 activation_unavailable`;
 * - `{ workThen }`      do the real work, then answer with something else (a gateway's page, say);
 * - `'ok'` or nothing   do the real work and answer truthfully.
 *
 * "The real work" is refused with `401 not_authenticated` when nobody was signed in as the
 * request arrived, as the real routes refuse it: a session is looked up before anything else.
 */
export type Step = Reply | 'lost' | 'lost-as-503' | { workThen: Reply } | 'ok'
/** A step, or something to run when the request arrives (to change the world mid-request) that then says which step. */
export type Scripted = Step | (() => Promise<Step> | Step)

const error = (status: number, code: string): Reply => ({ status, json: { error: code } })
export const refusal = error

export function fakeWallet(initial: { accounts?: string[]; chainId?: number; signature?: unknown } = {}) {
  const state = { accounts: initial.accounts ?? [ALICE.toLowerCase()], chainId: initial.chainId ?? 4663, signature: 'signature' in initial ? initial.signature : (SIGNATURE as unknown) }
  const calls: { method: string; params?: unknown[] }[] = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const fail = new Map<string, unknown>()
  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((fn) => fn(payload))
  /** Called just before the wallet answers a signing request: lets a test change things "while the wallet is open". */
  const hooks: { beforeSign?: () => void | Promise<void> } = {}
  const provider: Eip1193Provider = {
    async request({ method, params }) {
      calls.push({ method, params })
      if (fail.has(method)) throw fail.get(method)
      switch (method) {
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return state.accounts
        case 'eth_chainId':
          return `0x${state.chainId.toString(16)}`
        case 'wallet_switchEthereumChain':
          state.chainId = Number((params as [{ chainId: string }])[0].chainId)
          emit('chainChanged', `0x${state.chainId.toString(16)}`)
          return null
        case 'eth_signTypedData_v4':
          await hooks.beforeSign?.()
          return state.signature
      }
      throw Object.assign(new Error('unsupported'), { code: 4200 })
    },
    on: (event, listener) => void (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener as (payload: unknown) => void),
    removeListener: (event, listener) => void listeners.get(event)?.delete(listener as (payload: unknown) => void),
  }
  return {
    provider,
    calls,
    state,
    fail,
    hooks,
    selectAccount(address: string | null) {
      state.accounts = address ? [address.toLowerCase()] : []
      emit('accountsChanged', state.accounts)
    },
    selectChain(chainId: number) {
      state.chainId = chainId
      emit('chainChanged', `0x${chainId.toString(16)}`)
    },
    methods: () => calls.map((c) => c.method),
    signRequests: () => calls.filter((c) => c.method === 'eth_signTypedData_v4'),
  }
}

export interface WorldOptions {
  /** [tokenId, familyId] pairs the signed-in wallet owns. */
  owned?: [string, number][]
  /** The city the server starts with. Default: the empty genesis city. */
  game?: GameState
  wallet?: Parameters<typeof fakeWallet>[0]
  /** false = nobody is signed in. */
  signedIn?: boolean
  /** Friends whose property annotation the server leaves out ("could not tell"). */
  unknownProperty?: string[]
  retryDelaysMs?: number[]
}

export async function createWorld(options: WorldOptions = {}) {
  const owned = options.owned ?? [
    ['812', 2],
    ['1204', 0],
  ]
  const server = {
    game: options.game ?? createGenesisState(),
    sequence: 1,
    /** How many times the city was actually changed. */
    mutations: 0,
    session: options.signedIn === false ? null : (ALICE as string | null),
    properties: new Map<string, FriendPropertyDto>(),
    intents: new Map<string, { tokenId: string; plotId: string; typedData: ActivationTypedData; committed: ActivationCommitResponse | null }>(),
    script: { intents: [] as Scripted[], commits: [] as Scripted[] },
    /** Change what the next issued intent's typed data says, to play a server that sends something unexpected. */
    tamper: null as ((typedData: ActivationTypedData) => unknown) | null,
    issued: 0,
    /** My Friends answers `503 ownership_unavailable`: the chain cannot be read. */
    friendsUnavailable: false,
  }
  /** Reads the flow makes that fail outright, as a rejected promise, while set. */
  const faults = { loadFriends: false, cityRefresh: false }
  /** The clock a rate limit's wait is measured on. Tests move it. */
  const clock = { now: Date.parse('2026-10-09T12:00:00.000Z') }
  const requests: { method: string; path: string; body: unknown; raw: string | null }[] = []

  function issueIntent(body: unknown): Reply {
    const { tokenId, plotId } = body as { tokenId: string; plotId: string }
    const family = familyById(owned.find(([id]) => id === tokenId)?.[1])
    const plot = parsePlotId(plotId)
    if (!family || !plot) return error(403, 'friend_not_owned')
    if (server.properties.has(tokenId)) return error(409, 'friend_already_activated')
    if (plot.districtId !== districtForFamily(family.id)) return error(422, 'plot_invalid')
    const intentId = (++server.issued).toString(16).padStart(64, '0')
    const issuedAt = Date.parse('2026-10-09T12:00:00.000Z') + server.issued
    const expiresAt = issuedAt + 600_000
    const typedData: ActivationTypedData = {
      domain: { name: ACTIVATION_DOMAIN_NAME, version: ACTIVATION_DOMAIN_VERSION, chainId: 4663 },
      types: ACTIVATION_TYPES,
      primaryType: ACTIVATION_PRIMARY_TYPE,
      message: {
        intentId: `0x${intentId}`,
        site: ORIGIN,
        statement: ACTIVATION_STATEMENT,
        wallet: ALICE,
        collection: COLLECTION,
        tokenId,
        familyId: family.id,
        familyName: family.name,
        cityId: 'main',
        cityInstance: 'inst-1',
        districtId: plot.districtId,
        ward: plot.ward,
        plot: plot.plot,
        plotId: plot.plotId,
        issuedAt: String(issuedAt),
        expiresAt: String(expiresAt),
      },
    }
    server.intents.set(intentId, { tokenId, plotId, typedData, committed: null })
    return { status: 200, json: { intentId, expiresAt: new Date(expiresAt).toISOString(), typedData: server.tamper ? server.tamper(typedData) : typedData, digest: `0x${'d'.repeat(64)}` } }
  }

  /** The real commit, with the real engine. A committed intent answers again with the same property and changes nothing. */
  function commit(body: unknown): Reply {
    const { intentId } = body as { intentId: string }
    const intent = server.intents.get(intentId)
    if (!intent) return error(404, 'intent_not_found')
    if (intent.committed) return { status: 200, json: intent.committed }
    const plot = parsePlotId(intent.plotId)!
    const familyId = owned.find(([id]) => id === intent.tokenId)![1]
    const outcome = activateFriend(server.game, { userId: USER, ownerAddress: ALICE, tokenId: Number(intent.tokenId), familyId, address: plot })
    if (!outcome.ok) return error(409, outcome.reason === 'friend-active' ? 'friend_already_activated' : 'plot_unavailable')
    server.game = outcome.state
    server.sequence += 1
    server.mutations += 1
    const property: FriendPropertyDto = { id: `prop-${intent.tokenId}`, buildingId: outcome.building.id, districtId: plot.districtId, ward: plot.ward, plot: plot.plot, plotId: plot.plotId, activatedAt: '2026-10-09T12:01:00.000Z' }
    server.properties.set(intent.tokenId, property)
    intent.committed = { status: 'committed', property: { ...property, tokenId: intent.tokenId, sequence: server.sequence }, city: { id: 'main', instance: 'inst-1' } }
    return { status: 200, json: intent.committed }
  }

  async function scripted(next: Scripted | undefined, work: () => Reply): Promise<Reply> {
    // As the real routes do: who is asking is settled when the request arrives, before any work.
    const signedIn = server.session !== null
    const real = () => (signedIn ? work() : error(401, 'not_authenticated'))
    const step = typeof next === 'function' ? await next() : next
    if (step === undefined || step === 'ok') return real()
    if (step === 'lost') {
      real()
      return 'network-error'
    }
    if (step === 'lost-as-503') {
      real()
      return error(503, 'activation_unavailable')
    }
    if (typeof step === 'object' && 'workThen' in step) {
      real()
      return step.workThen
    }
    return step
  }

  const routes: Record<string, (body: unknown) => Reply | Promise<Reply>> = {
    'GET /v1/viewer': () => ({ status: 200, json: server.session ? { authenticated: true, userId: USER, wallet: { address: server.session, chainId: 4663 }, session: { expiresAt: '2026-10-16T12:00:00.000Z' } } : { authenticated: false } }),
    'GET /v1/viewer/friends': () => {
      if (!server.session) return error(401, 'not_authenticated')
      if (server.friendsUnavailable) return error(503, 'ownership_unavailable')
      return {
        status: 200,
        json: {
          wallet: { address: server.session, chainId: 4663 },
          source: 'robinhood-chain',
          asOfBlock: '100',
          friends: owned.map(([tokenId, id]) => ({ tokenId, family: familyById(id), ...(options.unknownProperty?.includes(tokenId) ? {} : { property: server.properties.get(tokenId) ?? null }) })),
        },
      }
    },
    'GET /v1/city': () => ({
      status: 200,
      json: { city: { id: 'main', instance: 'inst-1', sequence: server.sequence, stateVersion: STATE_VERSION, canonical: false, origin: 'demo-fixture', updatedAt: '2026-10-09T12:00:00.000Z' }, server: { mode: 'staging' }, state: server.game },
    }),
    'POST /v1/activation/intents': (body) => scripted(server.script.intents.shift(), () => issueIntent(body)),
    'POST /v1/activations': (body) => scripted(server.script.commits.shift(), () => commit(body)),
  }

  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    const method = init.method ?? 'GET'
    const raw = typeof init.body === 'string' ? init.body : null
    const body = raw === null ? undefined : JSON.parse(raw)
    requests.push({ method, path, body, raw })
    const route = routes[`${method} ${path}`]
    if (!route) throw new Error(`unexpected request ${method} ${path}`)
    const reply = await route(body)
    if (reply === 'network-error') throw new TypeError('Failed to fetch')
    return new Response(reply.text ?? (reply.json === undefined ? '<html>bad gateway</html>' : JSON.stringify(reply.json)), { status: reply.status, headers: reply.headers })
  }) as typeof globalThis.fetch

  const wallet = fakeWallet(options.wallet)
  const option: WalletOption = { id: 'w', name: 'Test Wallet', provider: wallet.provider }
  const wallets: WalletSource = { list: () => [option], subscribe: () => () => {} }
  const identity = createIdentityStore({ fetch, wallets, host: new URL(ORIGIN).host, autoStart: false })
  const transport = createServerTransport({ fetch, autoStart: false })
  await identity.refresh()
  await identity.loadFriends()
  await transport.refresh()

  const waits: number[] = []
  const flow = createActivationFlow({
    fetch,
    signer: createInjectedSigner(() => identity.provider()),
    identity: {
      getSnapshot: identity.getSnapshot,
      subscribe: identity.subscribe,
      refresh: identity.refresh,
      switchChain: identity.switchChain,
      loadFriends: () => (faults.loadFriends ? Promise.reject(new Error('My Friends could not be read')) : identity.loadFriends()),
    },
    city: {
      game: () => transport.getSnapshot().game,
      subscribe: transport.subscribe,
      refresh: () => (faults.cityRefresh ? Promise.reject(new Error('the city could not be read')) : transport.refresh()),
    },
    origin: ORIGIN,
    retryDelaysMs: options.retryDelaysMs ?? [10, 20],
    wait: async (ms) => {
      waits.push(ms)
    },
    now: () => clock.now,
  })
  /** Every state the flow ever published, as the page would have seen it. */
  const published: ActivationSnapshot[] = []
  flow.subscribe(() => published.push(flow.getSnapshot()))

  const sent = (method: string, path: string) => requests.filter((r) => r.method === method && r.path === path)
  return {
    server,
    wallet,
    identity,
    transport,
    flow,
    requests,
    waits,
    faults,
    clock,
    published,
    intentPosts: () => sent('POST', '/v1/activation/intents'),
    commitPosts: () => sent('POST', '/v1/activations'),
    friendReads: () => sent('GET', '/v1/viewer/friends').length,
    cityReads: () => sent('GET', '/v1/city').length,
    /** Everything sent that could change something. */
    posts: () => requests.filter((r) => r.method !== 'GET'),
    game: () => transport.getSnapshot().game!,
    friend: (tokenId: string) => {
      const friends = identity.getSnapshot().friends
      return friends.status === 'ready' ? friends.data.friends.find((f) => f.tokenId === tokenId) : undefined
    },
    /** Start, pick and open the review for a Friend, the way a person would. */
    reviewPlot(tokenId: string, ward = 0, plot = 0) {
      const districtId = districtForFamily(owned.find(([id]) => id === tokenId)![1])!
      const steps = [flow.start(tokenId), flow.select({ districtId, ward, plot }), flow.review()]
      if (steps.includes(false)) throw new Error(`could not reach the review: ${steps.join(', ')}`)
    },
  }
}

export type World = Awaited<ReturnType<typeof createWorld>>
