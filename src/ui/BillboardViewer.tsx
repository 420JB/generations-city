import { friendLabel } from '../config/identity'
import { getDistrict } from '../config/districts'
import { handleOf } from '../game/narration'
import type { GameState } from '../game/types'
import { DistrictChip } from './common'

/**
 * In-app lightbox for a property billboard. Everything is inert: the image is not a link and
 * the owner message is plain React text (no HTML, no linkification). Escape closes (App).
 */
export function BillboardViewer({ game, buildingId, onClose }: { game: GameState; buildingId: string; onClose: () => void }) {
  const b = game.buildings[buildingId]
  if (!b?.billboard.image) return null
  const message = b.billboard.message?.trim()
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal media-viewer" role="dialog" aria-modal="true" aria-labelledby="media-viewer-title" onClick={(e) => e.stopPropagation()} data-testid="billboard-viewer" data-building={b.friendId}>
        <div className="row-between">
          <div className="kicker">PROPERTY MEDIA</div>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close property media" data-testid="billboard-viewer-close" autoFocus>
            ✕
          </button>
        </div>
        <img className="media-viewer-image" src={b.billboard.image} alt={`Billboard on ${friendLabel(b.friendId)}`} draggable={false} />
        <h2 id="media-viewer-title">{friendLabel(b.friendId)}</h2>
        <div className="media-viewer-meta">
          <span>
            Owner <b data-testid="billboard-viewer-owner">{handleOf(game, b.ownerId)}</b>
          </span>
          <DistrictChip id={b.districtId} small />
          <span className="muted small">{getDistrict(b.districtId).title}</span>
        </div>
        {message && (
          <p className="media-viewer-message" data-testid="billboard-viewer-message">
            {message}
          </p>
        )}
      </div>
    </div>
  )
}
