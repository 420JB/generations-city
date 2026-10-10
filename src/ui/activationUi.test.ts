import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ActivationFlow, ActivationSnapshot } from '../activation'
import { COMMIT_REFUSAL_TEXT, MESSAGES } from '../activation/flow'
import { buildingFriendLabel, friendLabel, isAccountOwned } from '../config/identity'
import { activateFriend } from '../game/activation'
import { availablePlots } from '../game/allocation'
import { createGenesisState } from '../game/genesis'
import { createSeedState } from '../game/seed'
import type { IdentitySnapshot, IdentityStore } from '../identity/store'
import type { OwnedFriendDto } from '../protocol/identity'
import { ActivationSurface } from './ActivationSurface'
import { AccountPanel, type FriendActions } from './panels/AccountPanel'
import { BuildingPanel } from './panels/BuildingPanel'

const ALICE = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const USER = '7b0c1c7e-3c53-4d0e-9a52-6a3f5d0f1a11'
/** The Friend activated in the staging rehearsal, as My Friends reports it. */
const REHEARSED: OwnedFriendDto = { tokenId: '345260', family: { id: 0, name: 'Skeleton' }, property: { id: '5f29bf55-6d76-8365-9581-0327fbc0fa22', buildingId: 'b-345260', districtId: 'd8', ward: 0, plot: 0, plotId: 'd8-w0-p0', activatedAt: '2026-10-05T12:00:00.000Z' } }
const FRESH: OwnedFriendDto = { tokenId: '812', family: { id: 2, name: 'Family' }, property: null }
const UNKNOWN: OwnedFriendDto = { tokenId: '4471', family: { id: 7, name: 'Sparkling' } }

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, ' ')
/** The markup of each owned Friend's row, by token id. */
const rows = (html: string) => Object.fromEntries([...html.matchAll(/<li data-testid="owned-friend" data-token="(\d+)".*?<\/li>/g)].map((m) => [m[1], m[0]]))

function accountPanel(friends: OwnedFriendDto[], actions: FriendActions | null, source: 'robinhood-chain' | 'fixture' = 'robinhood-chain') {
  const snapshot: IdentitySnapshot = {
    viewer: { status: 'authenticated', userId: USER, address: ALICE, chainId: 4663, expiresAt: '2026-10-16T12:00:00.000Z' },
    wallet: { options: [{ id: 'w', name: 'Test Wallet' }], selected: 'w', account: ALICE.toLowerCase(), chainId: 4663 },
    friends: { status: 'ready', data: { wallet: { address: ALICE, chainId: 4663 }, source, asOfBlock: '79000000', friends } },
    busy: null,
    error: null,
  }
  return renderToStaticMarkup(createElement(AccountPanel, { identity: { snapshot, store: {} as IdentityStore }, onClose: () => {}, actions }))
}
const actions = (patch: Partial<FriendActions> = {}): FriendActions => ({ available: true, gateClosed: false, onActivate: () => {}, onViewProperty: () => {}, ...patch })

describe('My Friends', () => {
  it('offers Activate on a Friend with no property, and never on one that has its property', () => {
    const html = accountPanel([REHEARSED, FRESH, UNKNOWN], actions())
    const row = rows(html)
    expect(Object.keys(row).sort()).toEqual(['345260', '4471', '812'])

    // Already activated: its property, and the way to it. No second activation.
    expect(row['345260']).not.toContain('friend-activate')
    expect(row['345260']).toContain('data-testid="friend-view-property"')
    expect(row['345260']).toContain('data-property="d8-w0-p0"')
    expect(text(row['345260'])).toContain('Friend #345260 Skeleton Ward 1 · Plot 1')

    // Owned, no property: Activate.
    expect(row['812']).toContain('data-testid="friend-activate"')
    expect(row['812']).toContain('data-property="none"')
    expect(row['812']).not.toContain('friend-view-property')

    // The server could not tell: neither is offered.
    expect(row['4471']).toContain('data-property="unknown"')
    expect(row['4471']).not.toMatch(/friend-activate|friend-view-property/)
  })

  it('names real owned Friends as Friends, with their real family, and never as demo Friends', () => {
    const html = accountPanel([REHEARSED, FRESH], actions())
    expect(text(html)).toContain('Friend #345260')
    expect(text(html)).toContain('Friend #812 Family')
    expect(html).not.toMatch(/Demo Friend/i)
    expect(text(html)).toContain('Read from Robinhood Chain at block 79000000')
    // The human label is one-based; the zero-based protocol id is not what a person reads.
    expect(text(html)).not.toMatch(/Ward 0|Plot 0|d8-w0-p0/)
  })

  it('still says so when the ownership is a test fixture', () => {
    expect(text(accountPanel([FRESH], actions(), 'fixture'))).toContain('TEST FIXTURE · NOT REAL OWNERSHIP')
  })

  it('offers no activation where the city cannot take one', () => {
    const html = accountPanel([REHEARSED, FRESH], actions({ available: false }))
    expect(html).not.toContain('friend-activate')
    expect(text(html)).toContain('properties cannot be activated here')
    expect(text(html)).toContain('SIGNED IN · READ-ONLY')
    // A Friend that has a property still leads to it.
    expect(rows(html)['345260']).toContain('friend-view-property')
    // And with nothing to act with (no activation flow at all), no buttons either.
    expect(accountPanel([REHEARSED, FRESH], null)).not.toMatch(/friend-activate|friend-view-property/)
  })

  it('explains activation where it is possible, and says plainly when it is switched off', () => {
    const open = text(accountPanel([FRESH], actions()))
    expect(open).toContain("one permanent Rare City property in its family's district, on a plot you choose")
    expect(open).toContain('a signature only: no transaction and no gas')
    expect(open).not.toContain('READ-ONLY')
    const closed = accountPanel([FRESH], actions({ gateClosed: true }))
    expect(closed).toContain('data-testid="activation-closed"')
    expect(text(closed)).toContain('Activation is not open in this city yet.')
  })
})

describe('the name of the Friend a building stands for', () => {
  const real = activateFriend(createGenesisState(), { userId: USER, ownerAddress: ALICE, tokenId: 345260, familyId: 0, address: { districtId: 'd8', ward: 0, plot: 0 } })
  if (!real.ok) throw new Error('activation fixture failed')

  it('is "Friend #" for an ownership-backed property and "Demo Friend #" for demo data', () => {
    expect(buildingFriendLabel(real.building)).toBe('Friend #345260')
    expect(isAccountOwned(real.building)).toBe(true)
    const seed = createSeedState()
    // Every building of the demo city is demo data, whoever owns it there.
    expect(Object.values(seed.buildings).filter(isAccountOwned)).toEqual([])
    expect(buildingFriendLabel(seed.buildings['b-812'])).toBe('Demo Friend #812')
    expect(friendLabel(812)).toBe('Demo Friend #812')
    for (const ownerId of ['demo-player', 'npc-07', 'resident-20001', '', 'ALICE', USER.toUpperCase(), `${USER}x`]) expect(isAccountOwned({ ownerId }), ownerId).toBe(false)
  })

  it('shows the rehearsed property as Friend #345260 in its panel, at Ward I · Plot 1', () => {
    const html = renderToStaticMarkup(createElement(BuildingPanel, { game: real.state, viewerId: null, buildingId: 'b-345260', act: () => {}, onClose: () => {}, onArchitect: () => {} }))
    expect(text(html)).toContain('Friend #345260')
    expect(html).not.toMatch(/Demo Friend/)
    expect(html).toContain('aria-label="Friend #345260 details"')
    expect(text(html)).toMatch(/Skeleton District · Ward I\b.*Plot 1/)
  })

  it('leaves a demo building labelled as a demo Friend', () => {
    const html = renderToStaticMarkup(createElement(BuildingPanel, { game: createSeedState(), viewerId: null, buildingId: 'b-812', act: () => {}, onClose: () => {}, onArchitect: () => {} }))
    expect(text(html)).toContain('Demo Friend #812')
  })
})

describe('the activation surface', () => {
  const game = createGenesisState()
  const candidates = availablePlots(game, 'd8')
  const base: ActivationSnapshot = { phase: 'choosing', friend: { tokenId: '1204', family: { id: 0, name: 'Skeleton' } }, districtId: 'd8', selected: null, step: null, notice: null, result: null, gateClosed: false }
  const surface = (patch: Partial<ActivationSnapshot>) => renderToStaticMarkup(createElement(ActivationSurface, { activation: { snapshot: { ...base, ...patch }, flow: {} as ActivationFlow }, candidates }))
  const first = candidates[0]

  it('draws nothing when no Friend is being activated', () => {
    expect(surface({ phase: 'idle', friend: null, districtId: null })).toBe('')
  })

  it('while choosing: the real Friend, its family district, and how many plots are on offer', () => {
    const html = surface({})
    expect(html).toContain('data-testid="activation-bar"')
    expect(html).toContain('data-district="d8"')
    expect(html).toContain(`data-count="${candidates.length}"`)
    const said = text(html)
    expect(said).toContain('CHOOSE A PLOT · SKELETON DISTRICT')
    expect(said).toContain('FRIEND #1204 · SKELETON')
    expect(said).toContain('no score, RF or progress advantage')
    expect(said).not.toMatch(/demo/i)
    // Nothing to review until a plot is picked.
    expect(html).not.toMatch(/activation-review-open|activation-confirm/)
  })

  it('shows the picked plot one-based, and keeps the zero-based id out of what is read', () => {
    const html = surface({ selected: first })
    expect(first).toMatchObject({ ward: 0, plot: 0 })
    expect(text(html)).toContain('Ward 1 · Plot 1')
    expect(text(html)).not.toMatch(/Ward 0|Plot 0|d8-w0-p0/)
    expect(html).toContain('data-plot-id="d8-w0-p0"')
    expect(html).toContain('data-testid="activation-review-open"')
    expect(html).not.toContain('activation-confirm')
  })

  it('the review states the Friend, family, district, Ward and Plot, and what activation is and is not', () => {
    const html = surface({ phase: 'review', selected: first })
    expect(html).toContain('data-testid="activation-dialog"')
    for (const [id, value] of [['review-friend', '#1204'], ['review-family', 'Skeleton'], ['review-district', 'Skeleton District'], ['review-ward', '1'], ['review-plot', '1']]) expect(html, id).toContain(`data-testid="${id}">${value}<`)
    const said = text(html)
    expect(said).toContain('Activate Friend #1204 here?')
    expect(said).toContain("This becomes Friend #1204's permanent Rare City property")
    expect(said).toContain('If the NFT changes owner, the property goes with it')
    expect(said).toContain('a signature only : no transaction, no gas, no NFT transfer, no RF movement, and no token or NFT approval')
    expect(html).toContain('data-testid="activation-confirm"')
    expect(html).toContain('data-testid="activation-cancel"')
    // The protocol id is there, under technical details only.
    const [main, technical] = html.split('<details')
    expect(text(main)).not.toMatch(/d8-w0-p0|Ward 0|Plot 0/)
    expect(technical).toContain('data-testid="review-plot-id">d8-w0-p0<')
  })

  it('says when the chosen plot opens a new Ward', () => {
    const said = text(surface({ phase: 'review', selected: { districtId: 'd8', ward: 1, plot: 0, newWard: true } }))
    expect(said).toContain('Activating here opens Ward 2 for the whole district')
  })

  it('shows why the last try stopped, with the way on that fits', () => {
    const declined = surface({ phase: 'review', selected: first, notice: { kind: 'wallet-declined', text: MESSAGES.declined } })
    expect(declined).toContain('data-kind="wallet-declined"')
    expect(text(declined)).toContain(MESSAGES.declined)
    expect(declined).not.toContain('activation-switch-chain')

    const chain = surface({ phase: 'review', selected: first, notice: { kind: 'wrong-chain', text: MESSAGES.wrongChain } })
    expect(chain).toContain('data-testid="activation-switch-chain"')

    const mode = text(surface({ phase: 'review', selected: first, notice: { kind: 'unsupported-signing-mode', text: MESSAGES.unsupportedSigning, byteLength: 416 } }))
    expect(mode).toContain('This wallet signing mode is not supported yet')
    expect(mode).toContain('returned 416 bytes')
  })

  it('while working: says what is being waited on, and offers Cancel only before the signature is sent', () => {
    const signing = surface({ phase: 'working', step: 'signing', selected: first })
    expect(text(signing)).toContain('It is a signature only: no transaction and no gas')
    expect(signing).toContain('data-testid="activation-cancel"')
    for (const step of ['committing', 'confirming'] as const) {
      const html = surface({ phase: 'working', step, selected: first })
      expect(html, step).toContain(`data-step="${step}"`)
      expect(html, step).not.toMatch(/activation-cancel|activation-confirm/)
    }
  })

  it('an unresolved commit offers the same signature again or a stop, never a new signature', () => {
    const html = surface({ phase: 'unresolved', selected: first, notice: { kind: 'commit-unknown', text: MESSAGES.commitUnknown } })
    expect(html).toContain('data-testid="activation-retry"')
    expect(html).toContain('data-testid="activation-stop"')
    expect(html).not.toContain('activation-confirm')
    expect(text(html)).toContain('Your wallet will not be asked to sign again')
  })

  it('a commit asked to wait by a rate limit shows the wait, the same-signature retry and a way to stop', () => {
    const html = surface({ phase: 'unresolved', selected: first, notice: { kind: 'rate_limited', waitSeconds: 42, text: 'Rare City is limiting how often an activation can be sent. Wait about 42 seconds, then try again.' } })
    expect(html).toContain('data-kind="rate_limited"')
    expect(text(html)).toContain('Wait about 42 seconds, then try again.')
    expect(html).toContain('data-testid="activation-retry"')
    expect(html).toContain('data-testid="activation-stop"')
    expect(html).not.toContain('activation-confirm')
    expect(text(html)).toContain('Your wallet will not be asked to sign again')
  })

  it('a stop after the wallet has signed says what is known, and never that nothing was signed', () => {
    for (const code of ['activation_disabled', 'not_authenticated'] as const) {
      const html = surface({ phase: 'stopped', selected: first, gateClosed: code === 'activation_disabled', notice: { kind: code, text: COMMIT_REFUSAL_TEXT[code] } })
      const said = text(html)
      expect(said, code).toContain(COMMIT_REFUSAL_TEXT[code])
      expect(said, code).toMatch(/check My Friends before trying again/i)
      expect(said, code).not.toMatch(/nothing was signed|nothing changed|nothing was activated/i)
      expect(html, code).toContain('data-testid="activation-close"')
      expect(html, code).not.toMatch(/activation-confirm|activation-retry/)
    }
  })

  it('a stop that cannot be worked around offers only a way out', () => {
    const html = surface({ phase: 'stopped', selected: first, gateClosed: true, notice: { kind: 'activation_disabled', text: 'Activation is not open in this city yet. Nothing was signed and nothing changed.' } })
    expect(text(html)).toContain('Activation is not open in this city yet')
    expect(html).toContain('data-testid="activation-close"')
    expect(html).not.toMatch(/activation-confirm|activation-retry/)
  })
})
