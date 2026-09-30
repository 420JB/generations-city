import type { ReactNode } from 'react'
import { getDistrict, type DistrictId } from '../config/districts'
import { friendLabel } from '../config/identity'
import { formatRF } from '../game/economy'
import type { DemoUser } from '../game/types'

/** Procedural avatar for a demo Friend identity (no real NFT art is implied). */
export function Avatar({ user, size = 28 }: { user: DemoUser | undefined; size?: number }) {
  const hue = user?.hue ?? 210
  const seed = user?.friendId ?? 0
  const eye = 2 + (seed % 3) * 0.5
  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx={16} cy={16} r={16} fill={`hsl(${hue} 60% 22%)`} />
      <circle cx={16} cy={18} r={11} fill={`hsl(${hue} 75% 62%)`} />
      <path d={`M6 ${10 + (seed % 4)} Q16 ${-2 + (seed % 5)} 26 ${10 + (seed % 3)}`} fill={`hsl(${(hue + 40) % 360} 70% 45%)`} />
      <circle cx={12} cy={18} r={eye} fill="#0b0f1c" />
      <circle cx={20} cy={18} r={eye} fill="#0b0f1c" />
      <path d="M12.5 23 Q16 25.5 19.5 23" stroke="#0b0f1c" strokeWidth={1.3} fill="none" strokeLinecap="round" />
    </svg>
  )
}

export function SimTag({ children = 'SIMULATED RF' }: { children?: ReactNode }) {
  return <span className="sim-tag">{children}</span>
}

export function RF({ value, sim = true }: { value: number; sim?: boolean }) {
  return (
    <span className="rf">
      <b>{formatRF(value)}</b> <span className="rf-unit">{sim ? 'SIM RF' : 'RF'}</span>
    </span>
  )
}

export function DistrictChip({ id, small }: { id: DistrictId | null; small?: boolean }) {
  if (!id) return <span className="district-chip muted">Unclaimed</span>
  const d = getDistrict(id)
  return (
    <span className={`district-chip${small ? ' small' : ''}`} style={{ ['--dc' as string]: d.color }} data-district={id}>
      <DistrictEmblem id={id} />
      {d.name}
    </span>
  )
}

export function FriendName({ friendId }: { friendId: number }) {
  return <span className="friend-name">{friendLabel(friendId)}</span>
}

export function ProgressBar({ value, color, label }: { value: number; color?: string; label?: string }) {
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label={label}>
      <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} />
    </div>
  )
}

export function PanelHeader({ title, kicker, onClose, onBack }: { title: ReactNode; kicker?: ReactNode; onClose: () => void; onBack?: () => void }) {
  return (
    <header className="panel-header">
      {onBack && (
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          ←
        </button>
      )}
      <div className="panel-titles">
        {kicker && <div className="kicker">{kicker}</div>}
        <h2>{title}</h2>
      </div>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="Close panel">
        ✕
      </button>
    </header>
  )
}

/**
 * District crest: the family's PRIMARY silhouette on a dark disc ringed in the district
 * colour. Decorative (the family name always sits next to it), so it is hidden from
 * assistive tech. `banner` uses the SECONDARY silhouette for flag/banner contexts.
 */
export function DistrictEmblem({ id, size = 20, banner = false }: { id: DistrictId; size?: number; banner?: boolean }) {
  const d = getDistrict(id)
  return (
    <span className="district-crest" style={{ ['--dc' as string]: d.color, width: size, height: size }} aria-hidden="true" data-family={d.familyKey}>
      <img src={banner ? d.art.secondaryTransparent : d.art.primaryTransparent} alt="" width={size} height={size} decoding="async" draggable={false} />
    </span>
  )
}

/** Large civic header for a district: crest, family title and a subtle numeral reference. */
export function DistrictBanner({ id, kicker, aside, testId }: { id: DistrictId; kicker?: ReactNode; aside?: ReactNode; testId?: string }) {
  const d = getDistrict(id)
  return (
    <div className="district-banner" style={{ ['--dc' as string]: d.color }} data-testid={testId} data-district={id} data-family={d.familyKey}>
      <DistrictEmblem id={id} size={46} />
      <div className="grow">
        <div className="kicker">{kicker ?? `DISTRICT ${d.sigil}`}</div>
        <div className="district-banner-title">{d.title}</div>
      </div>
      {aside}
    </div>
  )
}
