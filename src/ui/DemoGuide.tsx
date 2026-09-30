import type { ReactNode } from 'react'
import { SCENARIO } from '../game/seed'
import { districtTitle } from '../game/narration'
import type { DemoProgress } from '../game/demo'

interface Props {
  progress: DemoProgress
  boardOpened: boolean
  warpedKing: boolean
  onOpenBoard: () => void
  onWarpKing: () => void
  onWarpCapital: () => void
  onWarpMine: () => void
  onHide: () => void
}

function Step({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <li className={done ? 'done' : ''}>
      <span className="step-mark" aria-hidden="true">
        {done ? '✓' : ''}
      </span>
      <span>{children}</span>
      {done && <span className="sr-only"> (done)</span>}
    </li>
  )
}

/** The guided 30-second path. Always recoverable from the HUD "?" button. */
export function DemoGuide({ progress: p, boardOpened, warpedKing, onOpenBoard, onWarpKing, onWarpCapital, onWarpMine, onHide }: Props) {
  const s1 = boardOpened || p.tierUp
  const home = districtTitle(p.kingmakerDistrict)
  const s2 = warpedKing || p.tierUp
  const cta = !p.primaryComplete
    ? !s1
      ? { label: 'Open Build Board', run: onOpenBoard, id: 'intro-open-board' }
      : { label: `WARP to #${SCENARIO.kingmakerFriend}`, run: onWarpKing, id: 'guide-warp' }
    : !p.capital
      ? { label: `Next: WARP to #${SCENARIO.capitalFriend}`, run: onWarpCapital, id: 'guide-capital' }
      : !p.customized
        ? { label: 'Open your tower', run: onWarpMine, id: 'guide-mine' }
        : null
  return (
    <aside className="intro-card" aria-label="Demo guide" data-testid="demo-guide" data-complete={p.primaryComplete ? 'true' : 'false'}>
      <div className="row-between">
        <div className="kicker">{p.primaryComplete ? '✓ CORE LOOP COMPLETE' : '30-SECOND DEMO'} · ALL RF IS SIMULATED</div>
        <button type="button" className="icon-btn sm" onClick={onHide} aria-label="Hide demo guide" data-testid="guide-hide">
          ✕
        </button>
      </div>
      <ol className="guide-steps">
        <Step done={s1}>
          Open the <b>Build Board</b>.
        </Step>
        <Step done={s2}>
          <b>WARP</b> to Demo Friend #{SCENARIO.kingmakerFriend}
          {!p.tierUp && p.kingmakerNeed !== null ? ` — ${p.kingmakerNeed} RF from Tier 4` : ''}.
        </Step>
        <Step done={p.tierUp}>
          Contribute <b>SIMULATED RF</b> to push it to Tier 4.
        </Step>
        <Step done={p.captured}>
          Watch <b>The Grand Fountain</b> move to the {home}.
        </Step>
      </ol>
      <div className="guide-bonus small">
        <span className={p.capital ? 'done' : ''}>{p.capital ? '✓' : '★'} Bonus: make the {home} the Capital</span>
        <span className={p.customized ? 'done' : ''}>{p.customized ? '✓' : '★'} Bonus: build or redesign your own tower</span>
      </div>
      <div className="row gap">
        {cta && (
          <button type="button" className="btn primary sm" onClick={cta.run} data-testid={cta.id}>
            {cta.label}
          </button>
        )}
        <button type="button" className="btn ghost sm" onClick={onHide}>
          Explore freely
        </button>
      </div>
      <div className="muted small guide-foot">Reopen any time with the ? button.</div>
    </aside>
  )
}
