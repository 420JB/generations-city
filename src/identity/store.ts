import { RARE_FRIENDS_CHAIN } from '../config/rareFriends'
import {
  AUTH_CHALLENGE_ENDPOINT,
  AUTH_LOGOUT_ENDPOINT,
  AUTH_VERIFY_ENDPOINT,
  FRIENDS_ENDPOINT,
  parseChallengeResponse,
  parseFriendsResponse,
  parseViewerResponse,
  VIEWER_ENDPOINT,
  type FriendsResponse,
  type ViewerResponse,
} from '../protocol/identity'
import { firstAccount, parseChainId, providerErrorCode, utf8ToHex, type Eip1193Provider, type WalletOption, type WalletSource } from './wallet'

/**
 * Who is looking, as the page knows it.
 *
 * Two things are tracked and never merged:
 * - `viewer`  the SESSION, as the server reports it. This is the identity.
 * - `wallet`  what the browser's wallet currently has selected. This is only a way to sign.
 *
 * The wallet changing account or network never changes the viewer. The only path from a
 * wallet account to an identity is a challenge the server issued, signed by that account
 * and verified by the server.
 */
export type ViewerState =
  /** The first read is still in flight. */
  | { status: 'loading' }
  /** The server could not say. Nothing is assumed. */
  | { status: 'unknown' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; userId: string; address: string; chainId: number; expiresAt: string }

export interface WalletState {
  /** Wallets found in this browser. Empty = none installed. */
  options: { id: string; name: string }[]
  /** The wallet in use, once one has been chosen or is the only one. */
  selected: string | null
  /** The account that wallet has selected for this page, lowercase. null = not connected. */
  account: string | null
  chainId: number | null
}

export type FriendsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: FriendsResponse }
  /** The server could not read ownership. This is not an empty wallet. */
  | { status: 'unavailable' }
  | { status: 'too-large' }

export type Busy = 'connecting' | 'switching' | 'signing' | 'signing-out'

export interface IdentitySnapshot {
  viewer: ViewerState
  wallet: WalletState
  friends: FriendsState
  busy: Busy | null
  /** Why the last action did not complete, in words fit for the page. */
  error: string | null
}

export interface IdentityStore {
  getSnapshot(): IdentitySnapshot
  subscribe(listener: () => void): () => void
  /** Ask the server who this browser is. */
  refresh(): Promise<void>
  /** Ask a wallet for its account. Prompts the wallet. Does not sign in. */
  connect(walletId?: string): Promise<void>
  /** Ask the wallet to switch to Robinhood Chain. Prompts the wallet. */
  switchChain(): Promise<void>
  /** Sign the server's challenge with the connected account and open a session. */
  signIn(): Promise<void>
  signOut(): Promise<void>
  loadFriends(): Promise<void>
  dismissError(): void
  stop(): void
}

export interface IdentityStoreOptions {
  fetch: typeof globalThis.fetch
  wallets: WalletSource
  /** `location.host` of the page: a challenge naming any other site is not signed. */
  host: string
  /** Read the viewer immediately. Tests turn this off and call `refresh` themselves. */
  autoStart?: boolean
  timeoutMs?: number
}

const CHAIN_ID = RARE_FRIENDS_CHAIN.chainId
const FRIENDS_TIMEOUT_MS = 35_000
const CHAIN_HEX = `0x${CHAIN_ID.toString(16)}`

export const MESSAGES = {
  noWallet: 'No wallet was found in this browser.',
  rejected: 'The request was declined in the wallet.',
  pending: 'The wallet already has a request open. Check the wallet.',
  wallet: 'The wallet could not complete that. Try again.',
  wrongChain: `Switch the wallet to ${RARE_FRIENDS_CHAIN.name} first.`,
  accountChanged: 'The wallet account changed while signing in. Try again.',
  challenge: 'Rare City sent a sign-in request this page did not recognise. Nothing was signed.',
  refused: 'Rare City did not accept that signature. Try again.',
  unavailable: 'Sign-in is unavailable right now. Try again shortly.',
  signOut: 'Could not sign out. Check your connection and try again.',
} as const

/** The wallet's own explanation for a failure, reduced to something worth showing. */
function walletMessage(err: unknown): string {
  const code = providerErrorCode(err)
  if (code === 4001) return MESSAGES.rejected
  if (code === -32002) return MESSAGES.pending
  return MESSAGES.wallet
}

/**
 * True when `message` is a Rare City sign-in for `account` on this site and chain. The
 * server is the one that verifies; this only stops the page asking the wallet to sign
 * something that is not the sign-in it asked for.
 */
export function isExpectedChallenge(message: string, host: string, account: string, nonce: string): boolean {
  const lines = message.split('\n')
  return lines[0] === `${host} wants you to sign in with your Ethereum account:` && lines[1]?.toLowerCase() === account && lines.includes(`Chain ID: ${CHAIN_ID}`) && lines.includes(`Nonce: ${nonce}`)
}

export function createIdentityStore(options: IdentityStoreOptions): IdentityStore {
  const { fetch: doFetch, wallets, host, autoStart = true, timeoutMs = 15_000 } = options
  const listeners = new Set<() => void>()
  let snapshot: IdentitySnapshot = {
    viewer: { status: 'loading' },
    wallet: { options: wallets.list().map(({ id, name }) => ({ id, name })), selected: null, account: null, chainId: null },
    friends: { status: 'idle' },
    busy: null,
    error: null,
  }
  /** The provider in use, and how to stop listening to it. */
  let active: { option: WalletOption; detach: () => void } | null = null
  let friendsRun = 0

  const set = (patch: Partial<IdentitySnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of [...listeners]) listener()
  }
  const setWallet = (patch: Partial<WalletState>) => set({ wallet: { ...snapshot.wallet, ...patch } })

  async function call(path: string, init: RequestInit = {}, limitMs = timeoutMs): Promise<{ status: number; body: unknown } | null> {
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), limitMs)
    try {
      const res = await doFetch(path, { ...init, cache: 'no-store', credentials: 'same-origin', signal: abort.signal, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) } })
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        // Not JSON (a proxy error page, for example): the status alone decides.
      }
      return { status: res.status, body }
    } catch {
      return null
    } finally {
      clearTimeout(deadline)
    }
  }
  const post = (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body) })

  function toViewer(response: ViewerResponse): ViewerState {
    if (!response.authenticated) return { status: 'anonymous' }
    return { status: 'authenticated', userId: response.userId, address: response.wallet.address, chainId: response.wallet.chainId, expiresAt: response.session.expiresAt }
  }

  /** Take the server's word for who this is. Friends belong to a session, so they follow it. */
  function applyViewer(viewer: ViewerState) {
    const before = snapshot.viewer
    const same = before.status === 'authenticated' && viewer.status === 'authenticated' && before.userId === viewer.userId && before.address === viewer.address
    if (same) return set({ viewer })
    friendsRun += 1
    set({ viewer, friends: { status: 'idle' } })
    if (viewer.status === 'authenticated') void loadFriends()
  }

  async function refresh() {
    const res = await call(VIEWER_ENDPOINT)
    const parsed = res?.status === 200 ? parseViewerResponse(res.body) : null
    if (parsed) return applyViewer(toViewer(parsed))
    // A failed read is not a sign-out. Keep what the server last said; only a first read has nothing to keep.
    if (snapshot.viewer.status === 'loading') set({ viewer: { status: 'unknown' } })
  }

  async function loadFriends() {
    if (snapshot.viewer.status !== 'authenticated') return
    const run = ++friendsRun
    set({ friends: { status: 'loading' } })
    // Reading ownership from the chain takes the server several round trips; give it room before calling it unavailable.
    const res = await call(FRIENDS_ENDPOINT, {}, Math.max(timeoutMs, FRIENDS_TIMEOUT_MS))
    // The session changed while this was in flight: the answer belongs to someone else.
    if (run !== friendsRun) return
    if (res?.status === 401) {
      set({ friends: { status: 'idle' } })
      return refresh()
    }
    if (res?.status === 422) return set({ friends: { status: 'too-large' } })
    const data = res?.status === 200 ? parseFriendsResponse(res.body) : null
    // Only an answer for the wallet this session is signed in with is shown.
    const viewer = snapshot.viewer
    if (!data || viewer.status !== 'authenticated' || data.wallet.address.toLowerCase() !== viewer.address.toLowerCase()) return set({ friends: { status: 'unavailable' } })
    set({ friends: { status: 'ready', data } })
  }

  /** Start using a wallet: remember it and follow its account and network. Never prompts. */
  function attach(option: WalletOption) {
    if (active?.option.provider === option.provider) return
    active?.detach()
    const { provider } = option
    // What the wallet has selected. It is shown; it is never taken as who the visitor is.
    const onAccounts = (accounts: unknown) => {
      if (active?.option.provider === provider) setWallet({ account: firstAccount(accounts) })
    }
    const onChain = (chainId: unknown) => {
      if (active?.option.provider === provider) setWallet({ chainId: parseChainId(chainId) })
    }
    provider.on?.('accountsChanged', onAccounts as never)
    provider.on?.('chainChanged', onChain as never)
    active = {
      option,
      detach() {
        provider.removeListener?.('accountsChanged', onAccounts as never)
        provider.removeListener?.('chainChanged', onChain as never)
      },
    }
    setWallet({ selected: option.id, account: null, chainId: null })
  }

  /** What the wallet already shares with this page, without asking it for anything. */
  async function peek(provider: Eip1193Provider) {
    try {
      const [accounts, chainId] = await Promise.all([provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })])
      if (active?.option.provider === provider) setWallet({ account: firstAccount(accounts), chainId: parseChainId(chainId) })
    } catch {
      // A wallet that will not answer is simply not connected.
    }
  }

  function syncOptions() {
    const list = wallets.list()
    setWallet({ options: list.map(({ id, name }) => ({ id, name })) })
    // With exactly one wallet there is nothing to choose, so its current state can be shown straight away.
    if (!active && list.length === 1) {
      attach(list[0])
      void peek(list[0].provider)
    }
  }

  async function connect(walletId?: string) {
    if (snapshot.busy) return
    const list = wallets.list()
    const option = list.find((w) => w.id === (walletId ?? snapshot.wallet.selected)) ?? (list.length === 1 ? list[0] : undefined)
    if (!option) return set({ error: MESSAGES.noWallet })
    attach(option)
    set({ busy: 'connecting', error: null })
    try {
      const accounts = await option.provider.request({ method: 'eth_requestAccounts' })
      const chainId = await option.provider.request({ method: 'eth_chainId' })
      setWallet({ account: firstAccount(accounts), chainId: parseChainId(chainId) })
      set({ busy: null })
    } catch (err) {
      set({ busy: null, error: walletMessage(err) })
    }
  }

  async function switchChain() {
    if (snapshot.busy || !active) return
    const { provider } = active.option
    set({ busy: 'switching', error: null })
    try {
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] })
      } catch (err) {
        // 4902: the wallet does not know this network yet. Offer it, with the public parameters.
        if (providerErrorCode(err) !== 4902) throw err
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [{ chainId: CHAIN_HEX, chainName: RARE_FRIENDS_CHAIN.name, nativeCurrency: RARE_FRIENDS_CHAIN.nativeCurrency, rpcUrls: [RARE_FRIENDS_CHAIN.publicRpcUrl], blockExplorerUrls: [RARE_FRIENDS_CHAIN.blockExplorerUrl] }],
        })
      }
      setWallet({ chainId: parseChainId(await provider.request({ method: 'eth_chainId' })) })
      set({ busy: null })
    } catch (err) {
      set({ busy: null, error: walletMessage(err) })
    }
  }

  async function signIn() {
    if (snapshot.busy || !active) return
    const { provider } = active.option
    const account = snapshot.wallet.account
    if (!account) return set({ error: MESSAGES.noWallet })
    if (snapshot.wallet.chainId !== CHAIN_ID) return set({ error: MESSAGES.wrongChain })
    set({ busy: 'signing', error: null })
    const fail = (error: string) => set({ busy: null, error })

    const issued = await post(AUTH_CHALLENGE_ENDPOINT, { address: account, chainId: CHAIN_ID })
    const challenge = issued?.status === 200 ? parseChallengeResponse(issued.body) : null
    if (!challenge) return fail(MESSAGES.unavailable)
    if (!isExpectedChallenge(challenge.message, host, account, challenge.nonce)) return fail(MESSAGES.challenge)
    // The challenge is for `account`. If the wallet moved on meanwhile, it is not signed with another one.
    if (snapshot.wallet.account !== account) return fail(MESSAGES.accountChanged)

    let signature: unknown
    try {
      signature = await provider.request({ method: 'personal_sign', params: [utf8ToHex(challenge.message), account] })
    } catch (err) {
      return fail(walletMessage(err))
    }
    if (typeof signature !== 'string') return fail(MESSAGES.wallet)

    const verified = await post(AUTH_VERIFY_ENDPOINT, { nonce: challenge.nonce, signature })
    if (!verified) return fail(MESSAGES.unavailable)
    if (verified.status === 401 || verified.status === 400) return fail(MESSAGES.refused)
    const viewer = verified.status === 200 ? parseViewerResponse(verified.body) : null
    if (!viewer?.authenticated) return fail(MESSAGES.unavailable)
    set({ busy: null })
    // The session is whatever the server just said it is, not the account the page thinks it used.
    applyViewer(toViewer(viewer))
  }

  async function signOut() {
    if (snapshot.busy) return
    set({ busy: 'signing-out', error: null })
    const res = await post(AUTH_LOGOUT_ENDPOINT, {})
    if (res?.status !== 200) {
      set({ busy: null, error: MESSAGES.signOut })
      return refresh()
    }
    set({ busy: null })
    applyViewer({ status: 'anonymous' })
  }

  const unsubscribeWallets = wallets.subscribe(syncOptions)
  syncOptions()
  if (autoStart) void refresh()

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh,
    connect,
    switchChain,
    signIn,
    signOut,
    loadFriends,
    dismissError: () => set({ error: null }),
    stop() {
      unsubscribeWallets()
      active?.detach()
      active = null
    },
  }
}

/** True when the session belongs to one address and the wallet currently has another selected. */
export function hasAccountMismatch(snapshot: IdentitySnapshot): boolean {
  return snapshot.viewer.status === 'authenticated' && snapshot.wallet.account !== null && snapshot.wallet.account !== snapshot.viewer.address.toLowerCase()
}
