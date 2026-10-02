import { hasAccountMismatch, shortAddress } from '../identity'
import type { Identity } from './identity'

/**
 * The HUD's identity chip for a server-backed city: a visitor, or the wallet this browser
 * is signed in with. What it shows is the SESSION the server reported, never the account a
 * wallet happens to have selected.
 */
export function WalletChip({ identity, note, onOpen }: { identity: Identity; note: string; onOpen: () => void }) {
  const { viewer } = identity.snapshot
  if (viewer.status === 'authenticated') {
    const mismatch = hasAccountMismatch(identity.snapshot)
    return (
      <div className="player-chip" title={`Signed in as ${viewer.address}`} data-testid="viewer-authenticated" data-address={viewer.address} data-mismatch={mismatch ? 'true' : 'false'}>
        <div>
          {/* Not `.player-name`: that line is hidden on phones, and the signed-in address must stay visible. */}
          <div className="strong small" data-testid="viewer-wallet">
            {shortAddress(viewer.address)}
          </div>
          <div className="wallet">
            <span className="sim-tag">{mismatch ? 'WALLET ACCOUNT CHANGED' : note}</span>
          </div>
        </div>
        <button type="button" className="btn sm" onClick={onOpen} data-testid="open-account">
          My Friends
        </button>
      </div>
    )
  }
  return (
    <div className="player-chip" title="You are browsing Rare City as a visitor" data-testid="viewer-anonymous">
      <div>
        <div className="player-name">Visitor</div>
        <div className="wallet">
          <span className="sim-tag">{note}</span>
        </div>
      </div>
      <button type="button" className="btn sm primary" onClick={onOpen} data-testid="connect-wallet">
        Connect Wallet
      </button>
    </div>
  )
}
