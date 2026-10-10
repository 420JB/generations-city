import type { DistrictId } from '../config/districts'
import { districtForFamily } from '../config/familyDistricts'
import { RARE_FRIENDS_CHAIN, type Family } from '../config/rareFriends'
import { availablePlots, type PlotCandidate } from '../game/allocation'
import type { GameState } from '../game/types'
import { plotId } from '../game/world'
import type { IdentityStore } from '../identity/store'
import {
  ACTIVATION_DOMAIN_NAME,
  ACTIVATION_DOMAIN_VERSION,
  ACTIVATION_INTENTS_ENDPOINT,
  ACTIVATION_STATEMENT,
  ACTIVATION_TYPES,
  ACTIVATIONS_ENDPOINT,
  parseActivationCommitResponse,
  parseActivationIntentResponse,
  parseCanonicalTokenId,
  parsePlotId,
  type ActivationCommitRequest,
  type ActivationCommitResponse,
  type ActivationIntentRequest,
  type ActivationIntentResponse,
  type FriendPropertyDto,
} from '../protocol/activation'
import { cityAcceptsActivation } from './eligibility'
import type { ActivationProof, ActivationSigner, SignerRefusal } from './signer'

/**
 * PERMANENT FRIEND ACTIVATION, as the page sees it.
 *
 * One Friend the signed-in wallet owns becomes one permanent property on the exact plot its
 * owner picks. The steps, and where each one first touches anything:
 *
 *   choosing   the owner looks at the free plots of the Friend's district and picks one.
 *   review     the owner reads what activation means and says yes or no.
 *   working    only now: the server is asked for the message to sign, the wallet signs it,
 *              and the signature is sent back.
 *
 * Starting, looking, picking, going back, cancelling and Escape are page state only: they
 * send nothing and change nothing anywhere. The first request is made by `confirm`.
 *
 * THE SERVER DECIDES. This picks candidates from the city on screen so the owner has
 * something to choose from; whether the Friend is owned, which district it belongs to and
 * whether the plot is free are the server's answers, at the intent and again at the commit.
 *
 * THE SIGNATURE lives in one local variable of this module while a commit is unresolved and
 * nowhere else: not in the snapshot, not in storage, not in a log. It is dropped as soon as
 * the attempt ends, however it ends.
 *
 * ONCE THE SIGNATURE HAS BEEN SENT, only an answer that is recognisably Rare City's own
 * refusal is taken as "this was not activated". Everything else (no answer, a page from
 * something in between, a code this page does not know, a success it cannot match to what
 * was signed) leaves the outcome UNKNOWN: the same intent and the same signature are kept,
 * My Friends is read, and the same commit may be sent again. The wallet is never asked to
 * sign again because an answer was lost, and the page never says nothing was activated
 * unless a refusal proves it.
 */

export interface ActivationFriend {
  /** Canonical decimal token id, exactly as the server listed it. */
  tokenId: string
  family: Family
}

export type ActivationPhase =
  | 'idle'
  /** Picking a plot on the map. */
  | 'choosing'
  /** Reading the permanence review. Nothing has been requested yet. */
  | 'review'
  /** A request or the wallet is in flight. See `step`. */
  | 'working'
  /** It cannot go on from here. The only way forward is to close. */
  | 'stopped'
  /** The signature was sent and the outcome is not known. It can be tried again without signing again. */
  | 'unresolved'

export type ActivationStep =
  /** Asking the server for the message to sign. */
  | 'intent'
  /** The wallet is showing the message. */
  | 'signing'
  /** The signature is on its way to the server. */
  | 'committing'
  /** Reading My Friends and the city back to see what happened. */
  | 'confirming'

/**
 * Why the flow is where it is, in words fit for the page. `kind` is stable and is what the
 * page and the tests tell cases apart by: a server error code as sent (`plot_unavailable`),
 * or one of the page's own (`wallet-declined`, `account-changed`, `wrong-chain`,
 * `unsupported-signing-mode`, `wallet-busy`, `wallet-error`, `no-wallet`, `plot-taken`,
 * `unrecognised-intent`, `network`, `commit-unknown`, `not-signed-in`, `unknown`).
 * `commit-unknown` is the one that says the outcome is not known; with the phase `unresolved`
 * a `rate_limited` notice is a commit that was asked to wait (see `waitSeconds`).
 */
export interface ActivationNotice {
  kind: string
  text: string
  /** `unsupported-signing-mode` only: how long the wallet's answer was, in bytes. Never the answer itself. */
  byteLength?: number | null
  /** `rate_limited` at the commit only: how many seconds the page will wait before it sends again. */
  waitSeconds?: number
}

export interface ActivationResult {
  /** Increases with every result, so the page can tell a new one from the last. */
  seq: number
  tokenId: string
  buildingId: string
  districtId: DistrictId
  ward: number
  plot: number
  plotId: string
  /** True when the Friend turned out to have a property already and nothing was activated now. */
  existing: boolean
  /** True when My Friends or the city could not be read back afterwards. The property stands; the page may not show it yet. */
  pending: boolean
}

export interface ActivationSnapshot {
  phase: ActivationPhase
  friend: ActivationFriend | null
  /** The district of the Friend's family. Fixed for the whole flow. */
  districtId: DistrictId | null
  selected: PlotCandidate | null
  step: ActivationStep | null
  notice: ActivationNotice | null
  /** The last activation that finished. Kept after the flow returns to idle. */
  result: ActivationResult | null
  /** The server has said activation is switched off. */
  gateClosed: boolean
}

export interface ActivationFlow {
  getSnapshot(): ActivationSnapshot
  subscribe(listener: () => void): () => void
  /** Begin choosing a plot for an owned Friend that has no property. Sends nothing. */
  start(tokenId: string): boolean
  /** Pick one of the plots currently on offer in the Friend's district. Sends nothing. */
  select(candidate: { districtId: DistrictId; ward: number; plot: number }): boolean
  clearSelection(): void
  /** Open the permanence review for the picked plot. Sends nothing. */
  review(): boolean
  /** From the review back to the map. Sends nothing. */
  back(): void
  /** THE ONE STEP THAT STARTS AN ACTIVATION: ask for the intent, sign it, commit it. */
  confirm(): Promise<void>
  /** Send the same intent and the same signature again. Never asks the wallet to sign, and sends nothing while a rate limit asks it to wait. */
  retryCommit(): Promise<void>
  /** Ask the wallet to switch to Robinhood Chain, then return to the review. */
  switchChain(): Promise<void>
  /** Leave the flow. Refused (false) only while a signature is on its way to the server. */
  cancel(): boolean
  /** Whether a signature is being held in memory right now. Only ever the fact, never the signature. */
  holdsSignature(): boolean
  stop(): void
}

export interface ActivationFlowOptions {
  fetch: typeof globalThis.fetch
  signer: ActivationSigner
  identity: Pick<IdentityStore, 'getSnapshot' | 'subscribe' | 'refresh' | 'loadFriends' | 'switchChain'>
  /** The city on screen, and a way to read it again from the server. */
  city: { game(): GameState | null; subscribe(listener: () => void): () => void; refresh(): Promise<void> }
  /** `location.origin` of the page: an intent written for any other site is not signed. */
  origin: string
  timeoutMs?: number
  /** Pauses before each automatic re-send of a commit whose answer was lost. Its length bounds the re-sends. */
  retryDelaysMs?: readonly number[]
  wait?: (ms: number) => Promise<void>
  /** The clock a rate limit's wait is measured on, in milliseconds. */
  now?: () => number
}

/**
 * A commit is sent at most this many times for one signature, automatic and asked-for
 * together. A send a rate limit turned away is not one of them: see `MAX_COMMIT_DEFERRALS`.
 */
export const MAX_COMMIT_SENDS = 9
/**
 * A commit is turned away by a rate limit (HTTP 429) at most this many times for one
 * signature. Counted apart from the sends, so being told to wait never uses up the tries
 * that can still learn what happened; capped, so waiting never goes on for ever.
 */
export const MAX_COMMIT_DEFERRALS = 6
/** How long to wait after a rate limit that does not say: the server's limits are per minute. */
export const DEFAULT_DEFERRAL_MS = 60_000
/** The longest the page refuses to send for, whatever a rate limit asks. Past it the server is simply asked again. */
export const MAX_DEFERRAL_MS = 120_000

const FRESH = 'Confirm again to start a fresh one.'
const NOTHING = 'Nothing changed.'

export const MESSAGES = {
  plotTaken: `That plot was just taken. ${NOTHING} Choose another plot.`,
  notSignedIn: 'Sign in with the wallet that owns this Friend to activate it.',
  noWallet: 'No wallet account is connected to this page. Connect the wallet you signed in with from My Friends, then try again.',
  accountChanged: 'Your wallet has a different account selected than the one you are signed in with. Switch back to the signed-in account in your wallet, then try again.',
  wrongChain: `Your wallet is on another network. Switch it to ${RARE_FRIENDS_CHAIN.name}, then try again.`,
  declined: `You declined the signature in your wallet. ${NOTHING}`,
  walletBusy: 'Your wallet already has a request open. Finish or dismiss it in the wallet, then try again.',
  walletError: `Your wallet could not sign that. ${NOTHING} Try again.`,
  unsupportedSigning: `This wallet signing mode is not supported yet. Your wallet returned a kind of signature Rare City cannot verify, so it was not sent and ${NOTHING.toLowerCase()} Switch the wallet to a standard account signature, or use a different wallet, then try again.`,
  unrecognisedIntent: 'Rare City sent an activation request this page did not recognise. Nothing was signed.',
  network: `Could not reach Rare City. ${NOTHING} Check your connection and try again.`,
  unknown: `Something went wrong and nothing was activated. Try again.`,
  commitUnknown: 'Rare City did not confirm whether your activation went through. You can try again without signing again, or stop and check My Friends in a moment.',
  commitExhausted: 'Rare City still has not confirmed this activation. Check My Friends in a few minutes: if the Friend shows its property, it went through. If not, you can activate it again.',
  alreadyActivated: 'This Friend already has its permanent Rare City property.',
} as const

type Landing = Exclude<ActivationPhase, 'idle' | 'working'>
interface Refusal {
  /** The status the server sends this code with. The same code under another status is not this answer. */
  status: number
  /** Where the flow goes when the intent is refused: nothing has been signed for this try. */
  land: Landing
  text: string
  /**
   * Where it goes, and what is said, once the signature has been sent. ABSENT when the
   * commit route never gives this answer: such an answer to a commit settles nothing.
   * These words never say nothing was signed, and say the Friend was not activated only
   * where the answer itself proves it.
   */
  commit?: { land: Landing; text: string }
  /** What to read again from the server because this answer says it is out of date. */
  reread?: 'city' | 'friends' | 'viewer'
}

const CHAIN = RARE_FRIENDS_CHAIN.name
const CHECK = 'Check My Friends before trying again.'

/**
 * What each server refusal means for the person, and what they can do about it. Codes are
 * the server's; the words are the page's and say nothing about how the server works.
 *
 * AT THE COMMIT the server answers a retry of a committed intent with its property before
 * it checks the signature, ownership, expiry or the plot, so those refusals prove this
 * intent was not committed, and their words say so. It checks the gate, the session and the
 * shape of the request BEFORE it looks the intent up, so those refusals only say this send
 * was turned away: they stop the flow, point at My Friends, and claim nothing more.
 */
const REFUSALS: Record<string, Refusal> = {
  activation_disabled: {
    status: 403,
    land: 'stopped',
    text: `Activation is not open in this city yet. Nothing was signed and ${NOTHING.toLowerCase()}`,
    commit: { land: 'stopped', text: `Activation is currently disabled, so Rare City could not complete this activation. ${CHECK}` },
  },
  not_authenticated: {
    status: 401,
    land: 'stopped',
    text: 'Your sign-in has ended. Sign in again from My Friends, then activate.',
    commit: { land: 'stopped', text: 'Your session ended before Rare City could confirm the activation. Sign in again, then check My Friends before trying again.' },
    reread: 'viewer',
  },
  unsupported_chain: {
    status: 400,
    land: 'stopped',
    text: `This sign-in is not on ${CHAIN}. Sign in again on ${CHAIN} to activate.`,
    commit: { land: 'stopped', text: `Rare City could not complete this activation because this sign-in is not on ${CHAIN}. Sign in again on ${CHAIN}, then check My Friends before trying again.` },
  },
  invalid_request: {
    status: 400,
    land: 'review',
    text: `Rare City could not read that request. ${NOTHING} Try again.`,
    commit: { land: 'stopped', text: `Rare City could not read the activation it was sent, so it could not complete it. ${CHECK}` },
  },
  friend_not_owned: {
    status: 403,
    land: 'stopped',
    text: `The signed-in wallet does not own this Friend right now, so it cannot activate it. ${NOTHING}`,
    commit: { land: 'stopped', text: 'The signed-in wallet does not own this Friend right now, so Rare City did not activate it.' },
    reread: 'friends',
  },
  friend_already_activated: { status: 409, land: 'stopped', text: MESSAGES.alreadyActivated, commit: { land: 'stopped', text: MESSAGES.alreadyActivated } },
  plot_invalid: { status: 422, land: 'choosing', text: `That plot cannot be chosen. ${NOTHING} Pick one of the highlighted plots.`, reread: 'city' },
  plot_unavailable: {
    status: 409,
    land: 'choosing',
    text: `Somebody else took that plot first. ${NOTHING} Choose another plot.`,
    commit: { land: 'choosing', text: 'Somebody else took that plot first, so this Friend was not activated. Choose another plot.' },
    reread: 'city',
  },
  intent_not_found: {
    status: 404,
    land: 'review',
    text: `Rare City no longer has that activation request. ${NOTHING} ${FRESH}`,
    commit: { land: 'stopped', text: `Rare City no longer has the activation request you signed, so it could not complete it. ${CHECK}` },
  },
  intent_expired: {
    status: 410,
    land: 'review',
    text: `That activation request expired before it was finished. ${NOTHING} ${FRESH}`,
    commit: { land: 'review', text: `The activation request expired before Rare City received your signature, so the Friend was not activated. ${FRESH}` },
  },
  intent_superseded: {
    status: 409,
    land: 'review',
    text: `A newer activation request replaced that one, perhaps from another tab. ${NOTHING} Confirm again to continue here.`,
    commit: { land: 'review', text: 'A newer activation request replaced the one you signed, perhaps from another tab, so that one was not completed. Confirm again to continue here.' },
  },
  intent_session_mismatch: {
    status: 403,
    land: 'review',
    text: `You have signed in again since that request was made. ${NOTHING} Confirm again to continue with this sign-in.`,
    commit: { land: 'review', text: 'You have signed in again since that request was made, so Rare City did not complete it. Confirm again to continue with this sign-in.' },
  },
  signature_invalid: {
    status: 403,
    land: 'review',
    text: `Rare City could not match that signature to the signed-in wallet. ${NOTHING} Check the wallet account, then try again.`,
    commit: { land: 'review', text: 'Rare City could not match your signature to the signed-in wallet, so the Friend was not activated. Check the wallet account, then try again.' },
  },
  ownership_unavailable: {
    status: 503,
    land: 'review',
    text: 'Rare City cannot check who owns this Friend right now, so nothing was activated. This is temporary. Try again shortly.',
    commit: { land: 'unresolved', text: 'Rare City cannot check who owns this Friend right now, so it has not completed this activation. This is temporary. Try again shortly.' },
  },
  ownership_inconsistent: {
    status: 503,
    land: 'review',
    text: "Rare City could not confirm this Friend's family just now, so nothing was activated. Try again shortly.",
    commit: { land: 'unresolved', text: "Rare City could not confirm this Friend's family just now, so it has not completed this activation. Try again shortly." },
  },
  family_mismatch: {
    status: 409,
    land: 'stopped',
    text: `This Friend's family no longer matches the district that was chosen. ${NOTHING}`,
    commit: { land: 'stopped', text: "This Friend's family no longer matches the district that was chosen, so Rare City did not activate it." },
    reread: 'friends',
  },
  activation_conflict: {
    status: 409,
    land: 'review',
    text: 'Rare City was busy with another change, so nothing was activated. Try again.',
    commit: { land: 'unresolved', text: 'Rare City was busy with another change and has not completed this activation. Try again.' },
  },
  city_not_activatable: {
    status: 409,
    land: 'stopped',
    text: `Friends cannot be activated in this city. ${NOTHING}`,
    commit: { land: 'stopped', text: 'Friends cannot be activated in this city, so Rare City did not complete this activation.' },
  },
  city_inconsistent: {
    status: 503,
    land: 'stopped',
    text: `Rare City has paused activation while it checks the city. ${NOTHING} Try again later.`,
    commit: { land: 'stopped', text: `Rare City has paused activation while it checks the city, so it did not complete this one. ${CHECK}` },
  },
  // No `commit`: at the commit this is the server saying it could not tell what happened either.
  activation_unavailable: { status: 503, land: 'review', text: `Activation is unavailable right now. ${NOTHING} Try again shortly.` },
  // No `commit`: a commit a rate limit turned away is deferred, not refused. See `commit`.
  rate_limited: { status: 429, land: 'review', text: 'Too many attempts in a short time. Wait a minute, then try again.' },
}

/** The words of every refusal a commit can be answered with, by code. For the copy tests. */
export const COMMIT_REFUSAL_TEXT: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(REFUSALS).flatMap(([code, r]) => (r.commit ? [[code, r.commit.text]] : [])))

/**
 * How long a `Retry-After` header asks for, in milliseconds: a number of seconds, or a
 * date. null when there is none or it cannot be read.
 */
export function parseRetryAfter(header: string | null, at: number): number | null {
  const text = header?.trim()
  if (!text) return null
  if (/^[0-9]{1,9}$/.test(text)) return Number(text) * 1000
  // An HTTP date begins with the day of the week. `Date.parse` alone would read "-5" as a year.
  const date = /^[A-Za-z]{3}/.test(text) ? Date.parse(text) : Number.NaN
  return Number.isNaN(date) ? null : Math.max(0, date - at)
}

/** The notice for a commit a rate limit turned away, with `waitMs` still to go. */
function deferralNotice(waitMs: number): ActivationNotice {
  const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000))
  return { kind: 'rate_limited', waitSeconds, text: `Rare City is limiting how often an activation can be sent. Wait ${waitSeconds === 1 ? 'a second' : `about ${waitSeconds} seconds`}, then try again.` }
}

const WALLET_NOTICES: Record<SignerRefusal['reason'], { kind: string; text: string }> = {
  'no-wallet': { kind: 'no-wallet', text: MESSAGES.noWallet },
  'account-changed': { kind: 'account-changed', text: MESSAGES.accountChanged },
  'wrong-chain': { kind: 'wrong-chain', text: MESSAGES.wrongChain },
  declined: { kind: 'wallet-declined', text: MESSAGES.declined },
  busy: { kind: 'wallet-busy', text: MESSAGES.walletBusy },
  'wallet-error': { kind: 'wallet-error', text: MESSAGES.walletError },
  'unsupported-signature': { kind: 'unsupported-signing-mode', text: MESSAGES.unsupportedSigning },
}

function walletNotice(refusal: SignerRefusal): ActivationNotice {
  const notice: ActivationNotice = { ...WALLET_NOTICES[refusal.reason] }
  if (refusal.reason === 'unsupported-signature') notice.byteLength = refusal.byteLength
  return notice
}

/** Equal as JSON values. Order matters in lists (an EIP-712 type is an ordered list of fields) and not in objects. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/**
 * True when `intent` is the activation that was reviewed: this Friend, this plot, this
 * wallet, this site, and the one message shape Rare City signs. The server is the one that
 * verifies; this only stops the page asking the wallet to sign something other than what
 * its owner just agreed to. It compares and never repairs: the message is signed as sent.
 */
export function isExpectedIntent(intent: ActivationIntentResponse, expected: { tokenId: string; plotId: string; family: Family; wallet: string; origin: string }): boolean {
  const { domain, types, message } = intent.typedData
  const plot = parsePlotId(expected.plotId)
  if (!plot) return false
  if (!sameJson(domain, { name: ACTIVATION_DOMAIN_NAME, version: ACTIVATION_DOMAIN_VERSION, chainId: RARE_FRIENDS_CHAIN.chainId }) || !sameJson(types, ACTIVATION_TYPES)) return false
  if (Object.keys(message).length !== ACTIVATION_TYPES.PropertyActivation.length || !ACTIVATION_TYPES.PropertyActivation.every((field) => Object.hasOwn(message, field.name))) return false
  return (
    message.intentId === `0x${intent.intentId}` &&
    message.site === expected.origin &&
    message.statement === ACTIVATION_STATEMENT &&
    message.wallet.toLowerCase() === expected.wallet.toLowerCase() &&
    message.collection.toLowerCase() === RARE_FRIENDS_CHAIN.generations.toLowerCase() &&
    message.tokenId === expected.tokenId &&
    message.familyId === expected.family.id &&
    message.familyName === expected.family.name &&
    message.plotId === plot.plotId &&
    message.districtId === plot.districtId &&
    message.ward === plot.ward &&
    message.plot === plot.plot &&
    message.expiresAt === String(Date.parse(intent.expiresAt))
  )
}

/** One try at activating: the intent the server issued and, once the wallet has signed, the proof. Never published. */
interface Attempt {
  friend: ActivationFriend
  intent: ActivationIntentResponse | null
  proof: ActivationProof | null
  /** How many times the commit has been sent and not turned away by a rate limit. Capped by `MAX_COMMIT_SENDS`. */
  sends: number
  /** How many times a rate limit turned the commit away. Capped by `MAX_COMMIT_DEFERRALS`. */
  deferrals: number
  /** Nothing more is sent before this time on the `now` clock: the wait the last rate limit asked for. */
  notBefore: number
  /**
   * A send of this signature got an answer that does not settle what it did. From then on a
   * refusal of a later send is not the whole story, and My Friends is read before it is believed.
   */
  uncertain: boolean
}

/** What a commit was answered with, as far as the answer can be trusted to mean anything. */
type CommitAnswer =
  | { kind: 'committed'; property: ActivationCommitResponse['property'] }
  /** Rare City's own refusal: a code the commit route gives, under the status it gives it with. */
  | { kind: 'refused'; code: string }
  /** A rate limit turned the send away. `ours` = by Rare City's own limit, which is applied before the activation is looked at. */
  | { kind: 'deferred'; waitMs: number; ours: boolean }
  /** Anything else. It may have been committed and it may not. */
  | { kind: 'unknown' }

const IDLE: Omit<ActivationSnapshot, 'result' | 'gateClosed'> = { phase: 'idle', friend: null, districtId: null, selected: null, step: null, notice: null }

export function createActivationFlow(options: ActivationFlowOptions): ActivationFlow {
  const { fetch: doFetch, signer, identity, city, origin, timeoutMs = 30_000, retryDelaysMs = [1_500, 4_000] } = options
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const now = options.now ?? Date.now
  const listeners = new Set<() => void>()
  let snapshot: ActivationSnapshot = { ...IDLE, result: null, gateClosed: false }
  /** The try in progress. The signature is here and only here. */
  let attempt: Attempt | null = null
  let results = 0

  const set = (patch: Partial<ActivationSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of [...listeners]) listener()
  }

  /** Forget the try in progress, and with it the signature. */
  function drop() {
    if (attempt) {
      attempt.proof = null
      attempt.intent = null
    }
    attempt = null
  }

  /** Leave the working state for `phase`, saying why. The signature survives only into `unresolved`. */
  function settle(phase: Landing, notice: ActivationNotice) {
    if (phase !== 'unresolved') drop()
    set({ phase, step: null, notice, selected: phase === 'choosing' ? null : snapshot.selected })
    reconcile()
  }

  const candidates = (districtId: DistrictId): PlotCandidate[] => {
    const game = city.game()
    return game ? availablePlots(game, districtId) : []
  }
  const sameSite = (a: { ward: number; plot: number }, b: { ward: number; plot: number }) => a.ward === b.ward && a.plot === b.plot

  function ownedFriend(tokenId: string) {
    const { viewer, friends } = identity.getSnapshot()
    if (viewer.status !== 'authenticated' || friends.status !== 'ready') return null
    return friends.data.friends.find((f) => f.tokenId === tokenId) ?? null
  }

  /**
   * Keep the flow true to what is on screen. A picked plot that is no longer on offer is
   * unpicked, and a session that has ended ends the flow. Never interrupts a request in flight.
   */
  function reconcile() {
    if (snapshot.phase !== 'choosing' && snapshot.phase !== 'review') return
    if (identity.getSnapshot().viewer.status === 'anonymous') {
      drop()
      return set({ ...IDLE })
    }
    const { selected, districtId } = snapshot
    if (!selected || !districtId || !city.game()) return
    if (!candidates(districtId).some((c) => sameSite(c, selected))) set({ phase: 'choosing', selected: null, notice: { kind: 'plot-taken', text: MESSAGES.plotTaken } })
  }

  async function post(path: string, body: ActivationIntentRequest | ActivationCommitRequest): Promise<{ status: number; body: unknown; retryAfter: string | null } | null> {
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), timeoutMs)
    try {
      const res = await doFetch(path, { method: 'POST', body: JSON.stringify(body), cache: 'no-store', credentials: 'same-origin', signal: abort.signal, headers: { accept: 'application/json', 'content-type': 'application/json' } })
      let parsed: unknown = null
      try {
        parsed = await res.json()
      } catch {
        // Not JSON (a proxy error page, for example): the status alone decides.
      }
      return { status: res.status, body: parsed, retryAfter: res.headers.get('retry-after') }
    } catch {
      return null
    } finally {
      clearTimeout(deadline)
    }
  }

  const errorCode = (body: unknown): string | null => {
    const code = (body as { error?: unknown } | null)?.error
    return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : null
  }

  /** Start a read nobody waits for. If it fails, nothing here changes: the store it belongs to shows that itself. */
  const quietly = (read: () => Promise<unknown>) => {
    try {
      void read().catch(() => {})
    } catch {
      // The same.
    }
  }

  /** Read My Friends again and say whether the Friend has a property now. null = it has none, or nobody could tell. */
  async function findProperty(tokenId: string): Promise<FriendPropertyDto | null> {
    try {
      await identity.loadFriends()
    } catch {
      return null
    }
    return ownedFriend(tokenId)?.property ?? null
  }

  /** Read the city until the building is in it, a few times at most. A read already in flight may predate the activation. */
  async function showBuilding(buildingId: string) {
    for (let read = 0; read < 3; read++) {
      await city.refresh()
      const game = city.game()
      if (game && Object.hasOwn(game.buildings, buildingId)) return
    }
  }

  /**
   * The Friend has its property. Bring My Friends and the city up to date, then leave the flow
   * pointing at it.
   *
   * ALWAYS LEAVES. The outcome is already known here, so reading it back is only for show:
   * if a read fails or never shows the property, the flow still ends, with the property the
   * server reported and `pending` saying the page could not show it yet. It never turns into
   * a failure and never stays waiting.
   */
  async function finish(friend: ActivationFriend, property: Pick<FriendPropertyDto, 'buildingId' | 'districtId' | 'ward' | 'plot' | 'plotId'>, existing: boolean) {
    // The signature has done its work. It goes first, before anything else can fail.
    drop()
    set({ phase: 'working', step: 'confirming', notice: null })
    let shown = false
    try {
      await Promise.all([identity.loadFriends(), showBuilding(property.buildingId)])
      const game = city.game()
      shown = !!game && Object.hasOwn(game.buildings, property.buildingId) && !!ownedFriend(friend.tokenId)?.property
    } catch {
      // Not shown. The property stands all the same.
    }
    const plot = parsePlotId(property.plotId)
    set({
      ...IDLE,
      result: plot ? { seq: ++results, tokenId: friend.tokenId, buildingId: property.buildingId, districtId: plot.districtId, ward: plot.ward, plot: plot.plot, plotId: plot.plotId, existing, pending: !shown } : snapshot.result,
    })
  }

  /** The server has just shown that activation is switched on: an issued intent, or a commit. Only the server's word moves this. */
  function gateOpen() {
    if (snapshot.gateClosed) set({ gateClosed: false })
  }

  /**
   * The server answered, and the answer was no. `committing` = the signature had been sent,
   * and then `code` is always one the commit route gives (see `readCommit`).
   */
  async function refused(code: string | null, run: Attempt, committing: boolean) {
    const live = () => attempt === run
    if (code === 'activation_disabled') set({ gateClosed: true })
    const refusal = code ? REFUSALS[code] : undefined
    // A refusal answers the send it came back for. When an earlier send of the same signature is
    // unaccounted for, or the refusal is that the Friend has a property, My Friends is read before
    // anything is said. It is seen through: leaving half way would lose the answer.
    if (code === 'friend_already_activated' || (committing && run.uncertain)) {
      set({ step: 'confirming' })
      const property = await findProperty(run.friend.tokenId)
      if (!live()) return
      // Whoever activated it, the Friend has a property: show that one rather than an error.
      if (property) return finish(run.friend, property, code === 'friend_already_activated' || property.plotId !== run.intent?.typedData.message.plotId)
    }
    const outcome = committing ? refusal?.commit : refusal
    if (!refusal || !outcome) {
      // Not reached at the commit. If it ever were, the outcome is unknown, never a failure.
      if (committing) return settle('unresolved', { kind: 'commit-unknown', text: MESSAGES.commitUnknown })
      return settle('review', { kind: code ?? 'unknown', text: MESSAGES.unknown })
    }
    if (refusal.reread === 'city') {
      set({ step: 'confirming' })
      await city.refresh().catch(() => {})
    }
    if (!live()) return
    if (refusal.reread === 'friends') quietly(() => identity.loadFriends())
    if (refusal.reread === 'viewer') quietly(() => identity.refresh())
    settle(outcome.land, { kind: code!, text: outcome.text })
  }

  /**
   * Sort a commit's answer. ONLY TWO THINGS ARE BELIEVED: a success for the Friend and the
   * plot that were signed for, and a refusal that is recognisably Rare City's own (a code
   * the commit route gives, under the status it gives it with). No answer, an unreadable
   * one, a page from something in between, an unknown code, a known code under the wrong
   * status, and a success for anything else all mean the same: unknown.
   */
  function readCommit(res: Awaited<ReturnType<typeof post>>, run: Attempt): CommitAnswer {
    if (!res) return { kind: 'unknown' }
    if (res.status === 200) {
      const committed = parseActivationCommitResponse(res.body)
      const matches = committed !== null && committed.property.tokenId === run.friend.tokenId && committed.property.plotId === run.intent?.typedData.message.plotId
      return matches ? { kind: 'committed', property: committed.property } : { kind: 'unknown' }
    }
    const code = errorCode(res.body)
    if (res.status === 429) {
      const asked = parseRetryAfter(res.retryAfter, now()) ?? DEFAULT_DEFERRAL_MS
      return { kind: 'deferred', waitMs: Math.min(Math.max(asked, 1_000), MAX_DEFERRAL_MS), ours: code === 'rate_limited' }
    }
    const refusal = code ? REFUSALS[code] : undefined
    return refusal?.commit && refusal.status === res.status ? { kind: 'refused', code: code! } : { kind: 'unknown' }
  }

  /**
   * Send the signature, and find out what happened.
   *
   * UNKNOWN IS NOT FAILURE. A commit whose answer does not settle what it did (see
   * `readCommit`) may still have gone through, so it is never taken for a failure and never
   * answered with a new intent or a new signature. My Friends is read first: a Friend that
   * has its property is a finished activation. Otherwise the SAME intent and the SAME
   * signature are sent again, which the server answers with the same property if it had
   * committed. The re-sends are counted and stop.
   *
   * A RATE LIMIT IS A WAIT, NOT A TRY. A commit turned away with 429 is counted apart from
   * the sends and is never re-sent automatically: the flow waits for the person, and
   * `retryCommit` sends nothing before the time the limit asked for. Rare City's own limit
   * is applied before the activation is looked at; anybody else's proves nothing either way.
   */
  async function commit(run: Attempt) {
    const live = () => attempt === run && run.intent !== null && run.proof !== null
    for (let round = 0; live(); round++) {
      if (run.sends >= MAX_COMMIT_SENDS) return settle('stopped', { kind: 'commit-unknown', text: MESSAGES.commitExhausted })
      set({ phase: 'working', step: 'committing', notice: null })
      const res = await post(ACTIVATIONS_ENDPOINT, { intentId: run.intent!.intentId, signature: run.proof!.signature })
      if (!live()) return
      const answer = readCommit(res, run)
      const signedPlot = run.intent!.typedData.message.plotId

      if (answer.kind === 'deferred') {
        run.deferrals += 1
        run.notBefore = now() + answer.waitMs
        // Somebody else's limit proves nothing about this send either.
        if (!answer.ours) run.uncertain = true
        // Being turned away says nothing about an earlier send. If one is unaccounted for, My Friends may know.
        if (run.uncertain) {
          set({ step: 'confirming' })
          const property = await findProperty(run.friend.tokenId)
          if (!live()) return
          if (property) return finish(run.friend, property, property.plotId !== signedPlot)
        }
        if (run.deferrals >= MAX_COMMIT_DEFERRALS) return settle('stopped', { kind: 'commit-unknown', text: MESSAGES.commitExhausted })
        return settle('unresolved', deferralNotice(answer.waitMs))
      }

      run.sends += 1
      if (answer.kind === 'committed') {
        gateOpen()
        return finish(run.friend, answer.property, false)
      }
      if (answer.kind === 'refused') return refused(answer.code, run, true)

      run.uncertain = true
      set({ step: 'confirming' })
      const property = await findProperty(run.friend.tokenId)
      if (!live()) return
      if (property) return finish(run.friend, property, property.plotId !== signedPlot)
      if (round >= retryDelaysMs.length) break
      await wait(retryDelaysMs[round])
    }
    if (live()) settle('unresolved', { kind: 'commit-unknown', text: MESSAGES.commitUnknown })
  }

  /** Run one piece of the flow so that nothing it throws can leave the page waiting forever. */
  async function guarded(run: Attempt, work: () => Promise<void>) {
    try {
      await work()
    } catch {
      if (attempt !== run) return
      // With a signature already sent the outcome is unknown; without one, nothing happened.
      if (run.proof) settle('unresolved', { kind: 'commit-unknown', text: MESSAGES.commitUnknown })
      else settle('review', { kind: 'unknown', text: MESSAGES.unknown })
    }
  }

  async function confirm() {
    const { friend, selected } = snapshot
    if (snapshot.phase !== 'review' || !friend || !selected) return
    const viewer = identity.getSnapshot().viewer
    if (viewer.status !== 'authenticated') return settle('stopped', { kind: 'not-signed-in', text: MESSAGES.notSignedIn })
    const request: ActivationIntentRequest = { tokenId: friend.tokenId, plotId: plotId(selected.districtId, selected.ward, selected.plot) }
    const run: Attempt = { friend, intent: null, proof: null, sends: 0, deferrals: 0, notBefore: 0, uncertain: false }
    attempt = run
    const live = () => attempt === run
    set({ phase: 'working', step: 'intent', notice: null })

    await guarded(run, async () => {
      // Before anything is asked of the server: the wallet must be the signed-in one, on the right network.
      const ready = await signer.check(viewer.address)
      if (!live()) return
      if (!ready.ok) return settle('review', walletNotice(ready))

      const issued = await post(ACTIVATION_INTENTS_ENDPOINT, request)
      if (!live()) return
      if (!issued) return settle('review', { kind: 'network', text: MESSAGES.network })
      if (issued.status !== 200) return refused(errorCode(issued.body), run, false)
      const intent = parseActivationIntentResponse(issued.body)
      if (!intent || !isExpectedIntent(intent, { ...request, family: friend.family, wallet: viewer.address, origin })) return settle('review', { kind: 'unrecognised-intent', text: MESSAGES.unrecognisedIntent })
      run.intent = intent
      gateOpen()

      set({ step: 'signing' })
      const signed = await signer.sign(viewer.address, intent.typedData)
      // Cancelled while the wallet was open: whatever it returned is dropped here, unread.
      if (!live()) return
      if (!signed.ok) return settle('review', walletNotice(signed))
      run.proof = signed.proof
      await commit(run)
    })
  }

  async function retryCommit() {
    const run = attempt
    if (snapshot.phase !== 'unresolved' || !run?.intent || !run.proof) return
    // A rate limit asked for a wait, and it is not over: nothing is sent, however often this is asked.
    const waitMs = run.notBefore - now()
    if (waitMs > 0) return set({ notice: deferralNotice(waitMs) })
    await guarded(run, () => commit(run))
  }

  async function switchChain() {
    if (snapshot.phase !== 'review') return
    await identity.switchChain()
    if (snapshot.phase === 'review' && snapshot.notice?.kind === 'wrong-chain' && identity.getSnapshot().wallet.chainId === RARE_FRIENDS_CHAIN.chainId) set({ notice: null })
  }

  function start(tokenId: string): boolean {
    if (snapshot.phase !== 'idle') return false
    const friend = ownedFriend(tokenId)
    // Only a Friend the server says has NO property. "Could not tell" (no annotation) is not "none".
    if (!friend || friend.property !== null || parseCanonicalTokenId(friend.tokenId) === null) return false
    const districtId = districtForFamily(friend.family.id)
    const game = city.game()
    if (!districtId || !game || !cityAcceptsActivation(game)) return false
    set({ ...IDLE, phase: 'choosing', friend: { tokenId: friend.tokenId, family: friend.family }, districtId })
    return true
  }

  function select(candidate: { districtId: DistrictId; ward: number; plot: number }): boolean {
    const { districtId } = snapshot
    if (snapshot.phase !== 'choosing' || !districtId || candidate.districtId !== districtId) return false
    // The plot is taken from the list on offer, so only a plot that is really a candidate can be picked.
    const pick = candidates(districtId).find((c) => sameSite(c, candidate))
    if (!pick) return false
    set({ selected: pick, notice: null })
    return true
  }

  function cancel(): boolean {
    if (snapshot.phase === 'idle') return true
    // A signature on its way to the server cannot be called back: the flow sees it through.
    if (snapshot.phase === 'working' && (snapshot.step === 'committing' || snapshot.step === 'confirming')) return false
    const uncertain = snapshot.phase === 'unresolved'
    drop()
    set({ ...IDLE })
    // Leaving with the outcome unknown: My Friends will say what happened.
    if (uncertain) quietly(() => identity.loadFriends())
    return true
  }

  const unsubscribe = [city.subscribe(reconcile), identity.subscribe(reconcile)]

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start,
    select,
    clearSelection() {
      if (snapshot.phase === 'choosing' && snapshot.selected) set({ selected: null })
    },
    review() {
      if (snapshot.phase !== 'choosing' || !snapshot.selected) return false
      set({ phase: 'review', notice: null })
      return true
    },
    back() {
      if (snapshot.phase === 'review') set({ phase: 'choosing', notice: null })
    },
    confirm,
    retryCommit,
    switchChain,
    cancel,
    holdsSignature: () => !!attempt?.proof,
    stop() {
      for (const off of unsubscribe) off()
      drop()
    },
  }
}
