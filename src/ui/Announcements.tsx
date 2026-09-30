import type { Announcement, BadgeToast } from './announce'

export function Announcements({ banners, badges, onDismiss }: { banners: Announcement[]; badges: BadgeToast[]; onDismiss: () => void }) {
  if (banners.length === 0 && badges.length === 0) return null
  // One headline banner (most important first), everything else as compact sub-lines.
  const order = { capital: 0, monument: 1, crown: 2, tier: 3, growth: 4 } as const
  const sorted = [...banners].sort((a, b) => order[a.kind] - order[b.kind])
  const [primary, ...rest] = sorted
  return (
    <>
      {primary && (
        <div className="announce-stack" role="status" aria-live="polite" data-testid="announcements">
          <div key={primary.key} className={`announce announce-${primary.kind}`} style={{ ['--dc' as string]: primary.color }}>
            <div className="announce-title">{primary.title}</div>
            <div className="announce-body">{primary.body}</div>
            {rest.length > 0 && (
              <div className="announce-subs">
                {rest.map((a) => (
                  <div key={a.key} className="announce-sub" style={{ ['--dc' as string]: a.color }}>
                    <b>{a.title}</b> {a.body}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="badge-toasts" role="status" aria-live="polite">
        {badges.map((b, i) => (
          <div key={b.key} className="badge-toast" style={{ animationDelay: `${1.6 + i * 0.2}s` }} data-testid="badge-toast">
            <span className="badge-glyph">{b.glyph}</span>
            <div>
              <div className="kicker">BADGE EARNED · PERMANENT</div>
              <b>{b.label}</b>
            </div>
          </div>
        ))}
        <button type="button" className="link-btn dismiss" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </>
  )
}
