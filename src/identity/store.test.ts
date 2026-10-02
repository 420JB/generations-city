import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIdentityStore, hasAccountMismatch, isExpectedChallenge, MESSAGES } from './store'
import { discoverWallets, firstAccount, parseChainId, shortAddress, utf8ToHex, type Eip1193Provider, type WalletOption, type WalletSource } from './wallet'

const HOST = 'rarecity.example'
const A = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const a = A.toLowerCase()
const b = B.toLowerCase()
const USER = '7b0c1c7e-3c53-4d0e-9a52-6a3f5d0f1a11'
const NONCE = 'a'.repeat(32)

const challengeFor = (address: string, host = HOST, chainId = 4663) =>
  [`${host} wants you to sign in with your Ethereum account:`, address, '', 'Sign in to Rare City.', '', `URI: https://${host}`, 'Version: 1', `Chain ID: ${chainId}`, `Nonce: ${NONCE}`, 'Issued At: 2026-10-02T12:00:00.000Z', 'Expiration Time: 2026-10-02T12:05:00.000Z'].join('\n')
const viewerFor = (address: string, userId = USER) => ({ authenticated: true, userId, wallet: { address, chainId: 4663 }, session: { expiresAt: '2026-10-09T12:00:00.000Z' } })
const friendsFor = (address: string, tokens: [string, number, string][] = [['812', 2, 'Family']]) => ({ wallet: { address, chainId: 4663 }, source: 'robinhood-chain', asOfBlock: '100', friends: tokens.map(([tokenId, id, name]) => ({ tokenId, family: { id, name } })) })

/** A wallet: answers the EIP-1193 calls the page makes and records them. */
function fakeWallet(initial: { accounts?: string[]; chainId?: number } = {}) {
  const state = { accounts: initial.accounts ?? [A], chainId: initial.chainId ?? 4663, connected: false }
  const calls: { method: string; params?: unknown[] }[] = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const fail = new Map<string, unknown>()
  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((fn) => fn(payload))
  const provider: Eip1193Provider = {
    async request({ method, params }) {
      calls.push({ method, params })
      if (fail.has(method)) throw fail.get(method)
      switch (method) {
        case 'eth_accounts':
          return state.connected ? state.accounts : []
        case 'eth_requestAccounts':
          state.connected = true
          return state.accounts
        case 'eth_chainId':
          return `0x${state.chainId.toString(16)}`
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          state.chainId = Number((params as [{ chainId: string }])[0].chainId)
          emit('chainChanged', `0x${state.chainId.toString(16)}`)
          return null
        case 'personal_sign':
          return `0x${'5'.repeat(130)}`
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
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    /** The user picks another account in the wallet. */
    selectAccount(address: string | null) {
      state.accounts = address ? [address] : []
      emit('accountsChanged', state.accounts)
    },
    selectChain(chainId: number) {
      state.chainId = chainId
      emit('chainChanged', `0x${chainId.toString(16)}`)
    },
    methods: () => calls.map((c) => c.method),
  }
}

const source = (...options: WalletOption[]): WalletSource => ({ list: () => options, subscribe: () => () => {} })

type Reply = { status: number; json?: unknown } | 'network-error'
/** A Rare City server: one handler per path; every request is recorded. */
function fakeServer(handlers: Record<string, (body: unknown) => Reply | Promise<Reply>>) {
  const requests: { path: string; method: string; body: unknown; init: RequestInit }[] = []
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    requests.push({ path, method: init.method ?? 'GET', body, init })
    const handler = handlers[path]
    if (!handler) throw new Error(`unexpected request ${path}`)
    const reply = await handler(body)
    if (reply === 'network-error') throw new TypeError('Failed to fetch')
    return new Response(reply.json === undefined ? '' : JSON.stringify(reply.json), { status: reply.status })
  }) as typeof globalThis.fetch
  return { fetch, requests, handlers, paths: () => requests.map((r) => `${r.method} ${r.path}`) }
}

/** A server with a working sign-in for whichever address asks. */
function signInServer(extra: Record<string, (body: unknown) => Reply | Promise<Reply>> = {}) {
  let session: string | null = null
  const server = fakeServer({
    '/v1/viewer': () => ({ status: 200, json: session ? viewerFor(session) : { authenticated: false } }),
    '/v1/auth/challenge': (body) => ({ status: 200, json: { nonce: NONCE, message: challengeFor((body as { address: string }).address === a ? A : B), expiresAt: '2026-10-02T12:05:00.000Z' } }),
    '/v1/auth/verify': () => {
      session = wallet.state.accounts[0]
      return { status: 200, json: viewerFor(session) }
    },
    '/v1/auth/logout': () => {
      session = null
      return { status: 200, json: { authenticated: false } }
    },
    '/v1/viewer/friends': () => (session ? { status: 200, json: friendsFor(session) } : { status: 401, json: { error: 'not_authenticated' } }),
    ...extra,
  })
  const wallet = fakeWallet()
  const store = createIdentityStore({ fetch: server.fetch, wallets: source({ id: 'w', name: 'Test Wallet', provider: wallet.provider }), host: HOST, autoStart: false })
  return { server, wallet, store, setSession: (address: string | null) => (session = address) }
}
const settle = () => new Promise((done) => setTimeout(done, 0))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('identity store: the viewer comes from the server', () => {
  it('starts not knowing, then is whoever the server says', async () => {
    const { store, setSession, server } = signInServer()
    expect(store.getSnapshot().viewer).toEqual({ status: 'loading' })
    await store.refresh()
    expect(store.getSnapshot().viewer).toEqual({ status: 'anonymous' })
    setSession(A)
    await store.refresh()
    expect(store.getSnapshot().viewer).toEqual({ status: 'authenticated', userId: USER, address: A, chainId: 4663, expiresAt: '2026-10-09T12:00:00.000Z' })
    for (const request of server.requests) expect(request.init).toMatchObject({ cache: 'no-store', credentials: 'same-origin' })
  })

  it('does not guess when the server cannot answer, and does not sign anyone out because a read failed', async () => {
    const replies: Reply[] = ['network-error', { status: 503, json: { error: 'viewer_unavailable' } }, { status: 200, json: { authenticated: 'yes' } }, { status: 200, json: viewerFor(A) }, 'network-error', { status: 500 }]
    const server = fakeServer({ '/v1/viewer': () => replies.shift()!, '/v1/viewer/friends': () => ({ status: 200, json: friendsFor(A) }) })
    const store = createIdentityStore({ fetch: server.fetch, wallets: source(), host: HOST, autoStart: false })
    for (let i = 0; i < 3; i++) {
      await store.refresh()
      expect(store.getSnapshot().viewer).toEqual({ status: 'unknown' })
    }
    await store.refresh()
    expect(store.getSnapshot().viewer.status).toBe('authenticated')
    for (let i = 0; i < 2; i++) {
      await store.refresh()
      expect(store.getSnapshot().viewer.status).toBe('authenticated')
    }
  })

  it('never reads or writes browser storage', async () => {
    const touched: string[] = []
    const trap = new Proxy({}, { get: (_t, key) => (touched.push(String(key)), () => null) })
    vi.stubGlobal('localStorage', trap)
    vi.stubGlobal('sessionStorage', trap)
    const { store } = signInServer()
    await store.refresh()
    await store.connect()
    await store.signIn()
    await settle()
    await store.signOut()
    expect(touched).toEqual([])
  })
})

describe('identity store: connecting a wallet', () => {
  it('shows what the only wallet already shares, without prompting it', async () => {
    const { wallet, store } = signInServer()
    await settle()
    expect(wallet.methods().sort()).toEqual(['eth_accounts', 'eth_chainId'])
    expect(store.getSnapshot().wallet).toEqual({ options: [{ id: 'w', name: 'Test Wallet' }], selected: 'w', account: null, chainId: 4663 })
  })

  it('connects only when asked, and connecting is not signing in', async () => {
    const { wallet, store, server } = signInServer()
    await store.refresh()
    await store.connect()
    expect(wallet.methods()).toContain('eth_requestAccounts')
    expect(store.getSnapshot().wallet).toMatchObject({ account: a, chainId: 4663 })
    expect(store.getSnapshot().viewer).toEqual({ status: 'anonymous' })
    expect(hasAccountMismatch(store.getSnapshot())).toBe(false)
    expect(server.paths()).toEqual(['GET /v1/viewer'])
  })

  it('makes the visitor choose when there are several wallets', async () => {
    const one = fakeWallet({ accounts: [A] })
    const two = fakeWallet({ accounts: [B] })
    const server = fakeServer({})
    const store = createIdentityStore({ fetch: server.fetch, wallets: source({ id: 'one', name: 'One', provider: one.provider }, { id: 'two', name: 'Two', provider: two.provider }), host: HOST, autoStart: false })
    await settle()
    expect(store.getSnapshot().wallet).toMatchObject({ selected: null, account: null, options: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }] })
    expect(one.calls.length + two.calls.length).toBe(0)
    await store.connect()
    expect(store.getSnapshot().error).toBe(MESSAGES.noWallet)
    await store.connect('two')
    expect(store.getSnapshot().wallet).toMatchObject({ selected: 'two', account: b })
    expect(one.calls).toEqual([])
    // Changing wallet stops listening to the previous one.
    await store.connect('one')
    expect(store.getSnapshot().wallet).toMatchObject({ selected: 'one', account: a })
    expect(two.listenerCount()).toBe(0)
    two.selectAccount(A)
    expect(store.getSnapshot().wallet.account).toBe(a)
  })

  it('explains a refused or failed connection and stays anonymous', async () => {
    const { wallet, store } = signInServer()
    await store.refresh()
    for (const [error, message] of [[{ code: 4001 }, MESSAGES.rejected], [{ code: -32002 }, MESSAGES.pending], [new Error('boom'), MESSAGES.wallet]] as const) {
      wallet.fail.set('eth_requestAccounts', error)
      await store.connect()
      expect(store.getSnapshot()).toMatchObject({ busy: null, error: message, viewer: { status: 'anonymous' }, wallet: { account: null } })
    }
    store.dismissError()
    expect(store.getSnapshot().error).toBeNull()
  })

  it('says so when there is no wallet at all', async () => {
    const store = createIdentityStore({ fetch: fakeServer({}).fetch, wallets: source(), host: HOST, autoStart: false })
    await store.connect()
    expect(store.getSnapshot()).toMatchObject({ error: MESSAGES.noWallet, wallet: { options: [], selected: null } })
    await store.switchChain()
    await store.signIn()
    expect(store.getSnapshot().busy).toBeNull()
  })
})

describe('identity store: Robinhood Chain', () => {
  it('switches network only through an explicit action, to chain 4663', async () => {
    const { wallet, store } = signInServer()
    wallet.state.chainId = 1
    await store.connect()
    expect(store.getSnapshot().wallet.chainId).toBe(1)
    expect(wallet.methods()).not.toContain('wallet_switchEthereumChain')
    await store.switchChain()
    expect(wallet.calls.find((c) => c.method === 'wallet_switchEthereumChain')?.params).toEqual([{ chainId: '0x1237' }])
    expect(store.getSnapshot().wallet.chainId).toBe(4663)
  })

  it('offers the network to a wallet that does not know it', async () => {
    const { wallet, store } = signInServer()
    wallet.state.chainId = 1
    await store.connect()
    wallet.fail.set('wallet_switchEthereumChain', { code: 4902 })
    await store.switchChain()
    expect(wallet.calls.find((c) => c.method === 'wallet_addEthereumChain')?.params).toEqual([
      { chainId: '0x1237', chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls: ['https://robinhoodchain.blockscout.com'] },
    ])
    expect(store.getSnapshot()).toMatchObject({ wallet: { chainId: 4663 }, error: null })
  })

  it('reports a refused switch and will not sign in on another network', async () => {
    const { wallet, store, server } = signInServer()
    wallet.state.chainId = 1
    await store.connect()
    wallet.fail.set('wallet_switchEthereumChain', { code: 4001 })
    await store.switchChain()
    expect(store.getSnapshot()).toMatchObject({ wallet: { chainId: 1 }, error: MESSAGES.rejected })
    await store.signIn()
    expect(store.getSnapshot().error).toBe(MESSAGES.wrongChain)
    expect(server.paths()).toEqual([])
    expect(wallet.methods()).not.toContain('personal_sign')
  })

  it('follows the wallet changing network', async () => {
    const { wallet, store } = signInServer()
    await store.connect()
    wallet.selectChain(8453)
    expect(store.getSnapshot().wallet.chainId).toBe(8453)
  })
})

describe('identity store: signing in', () => {
  it('signs exactly the server challenge with the connected account and sends back only the nonce and signature', async () => {
    const { wallet, store, server } = signInServer()
    await store.refresh()
    await store.connect()
    await store.signIn()
    await settle()

    expect(server.paths()).toEqual(['GET /v1/viewer', 'POST /v1/auth/challenge', 'POST /v1/auth/verify', 'GET /v1/viewer/friends'])
    expect(server.requests[1].body).toEqual({ address: a, chainId: 4663 })
    expect(wallet.calls.find((c) => c.method === 'personal_sign')?.params).toEqual([utf8ToHex(challengeFor(A)), a])
    expect(server.requests[2].body).toEqual({ nonce: NONCE, signature: `0x${'5'.repeat(130)}` })
    for (const request of server.requests.slice(1, 3)) expect(request.init.headers).toMatchObject({ 'content-type': 'application/json' })

    const snap = store.getSnapshot()
    expect(snap).toMatchObject({ busy: null, error: null, viewer: { status: 'authenticated', address: A, userId: USER } })
    expect(snap.friends).toEqual({ status: 'ready', data: friendsFor(A) })
    expect(hasAccountMismatch(snap)).toBe(false)
  })

  it('takes the session from the server answer, not from the account the page used', async () => {
    const { store } = signInServer({ '/v1/auth/verify': () => ({ status: 200, json: viewerFor(B) }), '/v1/viewer/friends': () => ({ status: 200, json: friendsFor(B) }) })
    await store.connect()
    await store.signIn()
    await settle()
    expect(store.getSnapshot().viewer).toMatchObject({ status: 'authenticated', address: B })
    expect(store.getSnapshot().wallet.account).toBe(a)
    expect(hasAccountMismatch(store.getSnapshot())).toBe(true)
  })

  it('refuses to sign a challenge that is not this sign-in', async () => {
    for (const message of [challengeFor(B), challengeFor(A, 'evil.example'), challengeFor(A, HOST, 1), challengeFor(A).replace(NONCE, 'b'.repeat(32)), 'Transfer all RF to 0xdead', '']) {
      const { wallet, store, server } = signInServer({ '/v1/auth/challenge': () => ({ status: 200, json: { nonce: NONCE, message, expiresAt: 'x' } }) })
      await store.connect()
      await store.signIn()
      expect(store.getSnapshot(), message).toMatchObject({ busy: null, error: message ? MESSAGES.challenge : MESSAGES.unavailable })
      expect(wallet.methods()).not.toContain('personal_sign')
      expect(server.paths()).toEqual(['POST /v1/auth/challenge'])
    }
  })

  it('does not sign with a different account if the wallet changes while the challenge is in flight', async () => {
    const ctx = signInServer({
      '/v1/auth/challenge': () => {
        ctx.wallet.selectAccount(B)
        return { status: 200, json: { nonce: NONCE, message: challengeFor(A), expiresAt: 'x' } }
      },
    })
    await ctx.store.connect()
    await ctx.store.signIn()
    expect(ctx.store.getSnapshot()).toMatchObject({ error: MESSAGES.accountChanged, viewer: { status: 'loading' }, wallet: { account: b } })
    expect(ctx.wallet.methods()).not.toContain('personal_sign')
  })

  it('stays anonymous when the signature is declined, refused by the server, or the server is down', async () => {
    const declined = signInServer()
    await declined.store.refresh()
    await declined.store.connect()
    declined.wallet.fail.set('personal_sign', { code: 4001 })
    await declined.store.signIn()
    expect(declined.store.getSnapshot()).toMatchObject({ error: MESSAGES.rejected, viewer: { status: 'anonymous' }, busy: null })
    expect(declined.server.paths()).not.toContain('POST /v1/auth/verify')

    const cases: [Reply, string][] = [[{ status: 401, json: { error: 'signature_invalid' } }, MESSAGES.refused], [{ status: 400, json: { error: 'invalid_request' } }, MESSAGES.refused], [{ status: 503, json: { error: 'auth_unavailable' } }, MESSAGES.unavailable], ['network-error', MESSAGES.unavailable], [{ status: 200, json: { authenticated: false } }, MESSAGES.unavailable], [{ status: 200, json: { ...viewerFor(A), userId: 'demo-player' } }, MESSAGES.unavailable]]
    for (const [reply, message] of cases) {
      const { store } = signInServer({ '/v1/auth/verify': () => reply })
      await store.refresh()
      await store.connect()
      await store.signIn()
      expect(store.getSnapshot(), JSON.stringify(reply)).toMatchObject({ error: message, viewer: { status: 'anonymous' }, busy: null, friends: { status: 'idle' } })
    }

    const noChallenge = signInServer({ '/v1/auth/challenge': () => ({ status: 429, json: { error: 'rate_limited' } }) })
    await noChallenge.store.connect()
    await noChallenge.store.signIn()
    expect(noChallenge.store.getSnapshot().error).toBe(MESSAGES.unavailable)
    expect(noChallenge.wallet.methods()).not.toContain('personal_sign')
  })

  it('ignores a second action while one is in progress', async () => {
    const { wallet, store } = signInServer()
    await store.connect()
    await Promise.all([store.signIn(), store.signIn(), store.signOut(), store.connect()])
    expect(wallet.methods().filter((m) => m === 'personal_sign')).toHaveLength(1)
    expect(store.getSnapshot().viewer.status).toBe('authenticated')
  })
})

describe('identity store: the wallet account is not the session', () => {
  async function signedIn() {
    const ctx = signInServer()
    await ctx.store.refresh()
    await ctx.store.connect()
    await ctx.store.signIn()
    await settle()
    return ctx
  }

  it('keeps the session when the wallet switches account, and says they differ', async () => {
    const { wallet, store, server } = await signedIn()
    const requests = server.requests.length
    wallet.selectAccount(B)
    const snap = store.getSnapshot()
    expect(snap.wallet.account).toBe(b)
    expect(snap.viewer).toMatchObject({ status: 'authenticated', address: A })
    expect(snap.friends).toEqual({ status: 'ready', data: friendsFor(A) })
    expect(hasAccountMismatch(snap)).toBe(true)
    // Nothing was sent anywhere: an account change is not a login.
    expect(server.requests).toHaveLength(requests)
    wallet.selectAccount(A)
    expect(hasAccountMismatch(store.getSnapshot())).toBe(false)
  })

  it('keeps the session when the wallet disconnects from the page', async () => {
    const { wallet, store } = await signedIn()
    wallet.selectAccount(null)
    const snap = store.getSnapshot()
    expect(snap.wallet.account).toBeNull()
    expect(snap.viewer).toMatchObject({ status: 'authenticated', address: A })
    expect(hasAccountMismatch(snap)).toBe(false)
  })

  it('becomes the new account only after that account signs its own challenge', async () => {
    const { wallet, store, server } = await signedIn()
    wallet.selectAccount(B)
    await store.signIn()
    await settle()
    expect(server.requests.filter((r) => r.path === '/v1/auth/challenge').at(-1)?.body).toEqual({ address: b, chainId: 4663 })
    expect(wallet.calls.filter((c) => c.method === 'personal_sign').at(-1)?.params).toEqual([utf8ToHex(challengeFor(B)), b])
    const snap = store.getSnapshot()
    expect(snap.viewer).toMatchObject({ status: 'authenticated', address: B })
    expect(snap.friends).toEqual({ status: 'ready', data: friendsFor(B) })
    expect(hasAccountMismatch(snap)).toBe(false)
  })

  it('signs out through the server and forgets the Friends', async () => {
    const { store, server } = await signedIn()
    await store.signOut()
    expect(server.requests.at(-1)).toMatchObject({ path: '/v1/auth/logout', method: 'POST', body: {} })
    expect(store.getSnapshot()).toMatchObject({ viewer: { status: 'anonymous' }, friends: { status: 'idle' }, busy: null, error: null })
    // The wallet is still connected: that alone is not an identity.
    expect(store.getSnapshot().wallet.account).toBe(a)
  })

  it('stays signed in, and says so, when sign-out does not reach the server', async () => {
    const { store } = await signedIn()
    const failing = signInServer({ '/v1/auth/logout': () => 'network-error' })
    failing.setSession(A)
    await failing.store.refresh()
    await failing.store.signOut()
    expect(failing.store.getSnapshot()).toMatchObject({ viewer: { status: 'authenticated', address: A }, error: MESSAGES.signOut, busy: null })
    expect(store.getSnapshot().viewer.status).toBe('authenticated')
  })

  it('stops listening to the wallet when stopped', async () => {
    const { wallet, store } = await signedIn()
    store.stop()
    expect(wallet.listenerCount()).toBe(0)
  })
})

describe('identity store: owned Friends', () => {
  async function withFriends(reply: () => Reply) {
    const ctx = signInServer({ '/v1/viewer/friends': reply })
    ctx.setSession(A)
    await ctx.store.refresh()
    await settle()
    return ctx
  }

  it('shows what the server found for the session wallet', async () => {
    const { store } = await withFriends(() => ({ status: 200, json: friendsFor(A, [['812', 2, 'Family'], ['4471', 7, 'Sparkling']]) }))
    expect(store.getSnapshot().friends).toEqual({ status: 'ready', data: friendsFor(A, [['812', 2, 'Family'], ['4471', 7, 'Sparkling']]) })
  })

  it('reports "could not read" as unavailable, never as an empty wallet', async () => {
    for (const reply of [{ status: 503, json: { error: 'ownership_unavailable' } }, 'network-error', { status: 500 }, { status: 200, json: { friends: [] } }, { status: 200, json: { ...friendsFor(A), friends: [{ tokenId: '1', family: { id: 12, name: 'Ghost' } }] } }] as Reply[]) {
      const { store } = await withFriends(() => reply)
      expect(store.getSnapshot().friends, JSON.stringify(reply)).toEqual({ status: 'unavailable' })
    }
    const large = await withFriends(() => ({ status: 422, json: { error: 'ownership_too_large' } }))
    expect(large.store.getSnapshot().friends).toEqual({ status: 'too-large' })
    const empty = await withFriends(() => ({ status: 200, json: friendsFor(A, []) }))
    expect(empty.store.getSnapshot().friends).toEqual({ status: 'ready', data: friendsFor(A, []) })
  })

  it('refuses an answer about some other wallet', async () => {
    const { store } = await withFriends(() => ({ status: 200, json: friendsFor(B) }))
    expect(store.getSnapshot().friends).toEqual({ status: 'unavailable' })
  })

  it('learns the session has ended from a 401 and becomes anonymous', async () => {
    const ctx = await withFriends(() => ({ status: 200, json: friendsFor(A) }))
    ctx.setSession(null)
    ctx.server.handlers['/v1/viewer/friends'] = () => ({ status: 401, json: { error: 'not_authenticated' } })
    await ctx.store.loadFriends()
    expect(ctx.store.getSnapshot()).toMatchObject({ viewer: { status: 'anonymous' }, friends: { status: 'idle' } })
  })

  it('drops an answer that arrives after the session it was for has ended', async () => {
    let release: (reply: Reply) => void = () => {}
    const ctx = signInServer({ '/v1/viewer/friends': () => new Promise<Reply>((done) => (release = done)) })
    ctx.setSession(A)
    await ctx.store.refresh()
    expect(ctx.store.getSnapshot().friends).toEqual({ status: 'loading' })
    await ctx.store.signOut()
    release({ status: 200, json: friendsFor(A) })
    await settle()
    expect(ctx.store.getSnapshot()).toMatchObject({ viewer: { status: 'anonymous' }, friends: { status: 'idle' } })
  })

  it('does not load Friends for a visitor', async () => {
    const { store, server } = signInServer()
    await store.refresh()
    await store.loadFriends()
    expect(server.paths()).toEqual(['GET /v1/viewer'])
  })
})

describe('challenge check', () => {
  it('accepts only a sign-in for this site, this account, this chain and this nonce', () => {
    expect(isExpectedChallenge(challengeFor(A), HOST, a, NONCE)).toBe(true)
    expect(isExpectedChallenge(challengeFor(A), HOST, b, NONCE)).toBe(false)
    expect(isExpectedChallenge(challengeFor(A), 'other.example', a, NONCE)).toBe(false)
    expect(isExpectedChallenge(challengeFor(A, HOST, 1), HOST, a, NONCE)).toBe(false)
    expect(isExpectedChallenge(challengeFor(A), HOST, a, 'b'.repeat(32))).toBe(false)
    expect(isExpectedChallenge(`x${challengeFor(A)}`, HOST, a, NONCE)).toBe(false)
  })
})

describe('wallet helpers', () => {
  it('encodes text for personal_sign as UTF-8 hex', () => {
    expect(utf8ToHex('')).toBe('0x')
    expect(utf8ToHex('Rare\nCity')).toBe('0x526172650a43697479')
    expect(utf8ToHex('é✓')).toBe('0xc3a9e29c93')
  })

  it('reads accounts and chain ids defensively', () => {
    expect(firstAccount([A, B])).toBe(a)
    for (const value of [[], null, undefined, 'x', [null], ['0x1234'], [42], { 0: A }]) expect(firstAccount(value)).toBeNull()
    expect(parseChainId('0x1237')).toBe(4663)
    expect(parseChainId(4663)).toBe(4663)
    for (const value of ['', 'abc', '0x', 0, -1, 1.5, null, undefined, {}]) expect(parseChainId(value), String(value)).toBeNull()
    expect(shortAddress(A)).toBe('0xf39F…2266')
  })

  it('discovers EIP-6963 wallets, and falls back to window.ethereum only when none announce', () => {
    const provider = fakeWallet().provider
    const legacy = fakeWallet().provider
    const win = Object.assign(new EventTarget(), { ethereum: legacy }) as unknown as Window
    const requested: string[] = []
    win.addEventListener('eip6963:requestProvider', () => requested.push('asked'))
    const wallets = discoverWallets(win)
    expect(requested).toEqual(['asked'])
    expect(wallets.list()).toEqual([{ id: 'injected', name: 'Browser wallet', provider: legacy }])

    let notified = 0
    const stop = wallets.subscribe(() => notified++)
    const announce = (detail: unknown) => win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
    announce({ info: { uuid: 'u-1', name: 'Rare Wallet' }, provider })
    announce({ info: { uuid: 'u-1', name: 'Rare Wallet' }, provider })
    announce({ info: { uuid: 'u-2', name: 'Same Provider Again' }, provider })
    for (const junk of [null, {}, { info: { uuid: 'u-3' } }, { info: { uuid: '', name: 'x' }, provider }, { info: { uuid: 'u-4', name: 'x' }, provider: {} }]) announce(junk)
    expect(wallets.list()).toEqual([{ id: 'u-1', name: 'Rare Wallet', provider }])
    expect(notified).toBe(1)
    stop()
    announce({ info: { uuid: 'u-5', name: 7 }, provider: legacy })
    expect(notified).toBe(1)
    expect(wallets.list().map((w) => [w.id, w.name])).toEqual([['u-1', 'Rare Wallet'], ['u-5', 'Wallet']])
    expect(discoverWallets(new EventTarget() as unknown as Window).list()).toEqual([])
  })
})
