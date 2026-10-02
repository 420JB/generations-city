import { RARE_FRIENDS_CHAIN } from '../../config/rareFriends'
import { hasAccountMismatch, shortAddress } from '../../identity'
import { PanelHeader } from '../common'
import type { Identity } from '../identity'

const BUSY_LABEL = { connecting: 'Check your wallet…', switching: 'Check your wallet…', signing: 'Check your wallet…', 'signing-out': 'Signing out…' } as const

/**
 * Wallet sign-in and "My Friends".
 *
 * Read-only by design: it shows who the server says is signed in and which Rare Friends
 * the server found that wallet to own. It offers nothing that spends, builds or activates.
 */
export function AccountPanel({ identity, onClose }: { identity: Identity; onClose: () => void }) {
  const { snapshot, store } = identity
  const { viewer, wallet, friends, busy, error } = snapshot
  const signedIn = viewer.status === 'authenticated'
  const mismatch = hasAccountMismatch(snapshot)
  const onChain = wallet.chainId === RARE_FRIENDS_CHAIN.chainId

  return (
    <section className="panel" aria-label="Wallet and Friends" data-testid="account-panel" data-viewer={viewer.status}>
      <PanelHeader kicker={signedIn ? 'SIGNED IN · READ-ONLY' : 'WALLET SIGN-IN'} title={signedIn ? shortAddress(viewer.address) : 'Connect Wallet'} onClose={onClose} />

      <div className="fund-box" data-testid="session-box">
        {signedIn ? (
          <>
            <h3>Signed in</h3>
            <p className="small" style={{ wordBreak: 'break-all' }}>
              Wallet <b data-testid="session-address">{viewer.address}</b>
            </p>
            <p className="muted small">
              This session ends {new Date(viewer.expiresAt).toLocaleDateString()}. Rare City ID <span data-testid="session-user">{viewer.userId.slice(0, 8)}</span>.
            </p>
            <button type="button" className="btn sm" onClick={() => void store.signOut()} disabled={!!busy} data-testid="sign-out">
              {busy === 'signing-out' ? BUSY_LABEL[busy] : 'Sign out'}
            </button>
          </>
        ) : viewer.status === 'loading' ? (
          <p className="muted small" style={{ margin: 0 }}>
            Checking your session…
          </p>
        ) : viewer.status === 'unknown' ? (
          <>
            <h3>Session unknown</h3>
            <p className="muted small">Rare City could not check whether you are signed in.</p>
            <button type="button" className="btn sm" onClick={() => void store.refresh()} data-testid="viewer-retry">
              Try again
            </button>
          </>
        ) : (
          <>
            <h3>Browsing as a visitor</h3>
            <p className="muted small" style={{ marginBottom: 0 }}>
              Sign in with a wallet to see the Rare Friends it owns. Signing in is a free signature, not a transaction. The city stays read-only.
            </p>
          </>
        )}
      </div>

      <div className="fund-box" data-testid="wallet-box">
        <h3>Wallet</h3>
        {wallet.options.length === 0 ? (
          <p className="muted small" style={{ marginBottom: 0 }} data-testid="no-wallet">
            No wallet was found in this browser. Install an EVM wallet to sign in.
          </p>
        ) : wallet.account === null ? (
          <>
            <p className="muted small">{signedIn ? 'No wallet account is connected to this page. Your session is unaffected.' : 'Connect the wallet that holds your Rare Friends.'}</p>
            <div className="row gap wrap">
              {wallet.options.length === 1 ? (
                <button type="button" className="btn sm primary" onClick={() => void store.connect()} disabled={!!busy} data-testid="wallet-connect">
                  {busy === 'connecting' ? BUSY_LABEL[busy] : 'Connect Wallet'}
                </button>
              ) : (
                wallet.options.map((option) => (
                  <button key={option.id} type="button" className="btn sm" onClick={() => void store.connect(option.id)} disabled={!!busy} data-testid="wallet-option">
                    {option.name}
                  </button>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            <p className="small">
              Account{' '}
              <b data-testid="wallet-account" data-address={wallet.account}>
                {shortAddress(wallet.account)}
              </b>{' '}
              on <span data-testid="wallet-chain" data-chain={wallet.chainId ?? ''}>{onChain ? RARE_FRIENDS_CHAIN.name : `another network${wallet.chainId ? ` (chain ${wallet.chainId})` : ''}`}</span>
            </p>
            {mismatch && signedIn && (
              <p className="small" role="status" data-testid="account-mismatch">
                Your wallet has switched to <b>{shortAddress(wallet.account)}</b>, but you are still signed in as <b>{shortAddress(viewer.address)}</b>. Changing the wallet account does not change who is signed in. Sign in with the new account to switch, or sign out.
              </p>
            )}
            {!onChain ? (
              <button type="button" className="btn sm primary" onClick={() => void store.switchChain()} disabled={!!busy} data-testid="switch-chain">
                {busy === 'switching' ? BUSY_LABEL[busy] : `Switch to ${RARE_FRIENDS_CHAIN.name}`}
              </button>
            ) : !signedIn || mismatch ? (
              <button type="button" className="btn sm primary" onClick={() => void store.signIn()} disabled={!!busy || viewer.status === 'loading'} data-testid="sign-in">
                {busy === 'signing' ? BUSY_LABEL[busy] : mismatch ? `Sign in as ${shortAddress(wallet.account)}` : 'Sign in'}
              </button>
            ) : null}
          </>
        )}
        {error && (
          <p className="error small" role="alert" style={{ marginBottom: 0 }} data-testid="identity-error">
            {error}
          </p>
        )}
      </div>

      {signedIn && (
        <div data-testid="my-friends" data-status={friends.status}>
          <h3 className="section-title">My Friends</h3>
          {friends.status === 'ready' ? (
            <>
              {friends.data.friends.length === 0 ? (
                <p className="muted small" data-testid="friends-empty">
                  This wallet owns no Rare Friends.
                </p>
              ) : (
                <ul className="season-friends" data-testid="friends-list">
                  {friends.data.friends.map((friend) => (
                    <li key={friend.tokenId} data-testid="owned-friend" data-token={friend.tokenId} data-family={friend.family.id}>
                      <span className="grow strong">Friend #{friend.tokenId}</span>
                      <span className="rep-tag">{friend.family.name}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted small" data-testid="friends-source" data-source={friends.data.source}>
                {friends.data.source === 'fixture' ? <span className="sim-tag">TEST FIXTURE · NOT REAL OWNERSHIP</span> : `Read from ${RARE_FRIENDS_CHAIN.name} at block ${friends.data.asOfBlock}.`}
              </p>
            </>
          ) : friends.status === 'unavailable' ? (
            <>
              <p className="small" role="status" data-testid="friends-unavailable">
                Rare City could not read this wallet's Friends right now. This does not mean the wallet is empty.
              </p>
              <button type="button" className="btn sm" onClick={() => void store.loadFriends()} data-testid="friends-retry">
                Try again
              </button>
            </>
          ) : friends.status === 'too-large' ? (
            <p className="small" role="status" data-testid="friends-too-large">
              This wallet holds more Rare Friends than this view can list yet.
            </p>
          ) : (
            <p className="muted small" data-testid="friends-loading">
              Reading your Friends…
            </p>
          )}
          <p className="muted small" style={{ marginBottom: 0 }}>
            Owning a Friend does not change the city yet: properties cannot be activated here.
          </p>
        </div>
      )}
    </section>
  )
}
