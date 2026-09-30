import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { centeredFraming, FRAME, MAX_ZOOM, MIN_ZOOM, panFraming, zoomFraming, type Framing } from '../billboardCrop'
import { renderBillboard, type BillboardSource } from '../image'

interface Props {
  source: BillboardSource
  onSave: (image: string) => void
  onCancel: () => void
  /** Low-res live preview pushed to the building while editing. */
  onDraft: (image: string) => void
}

/**
 * Minimal framing editor: drag to reposition, zoom to crop, then SAVE or CANCEL.
 * The frame has the billboard's exact 2:1 aspect ratio.
 */
export function BillboardEditor({ source, onSave, onCancel, onDraft }: Props) {
  const [framing, setFraming] = useState<Framing>(() => centeredFraming(source.width, source.height))
  const [frameW, setFrameW] = useState(340)
  const [saving, setSaving] = useState(false)
  const frameRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; start: Framing } | null>(null)
  const k = frameW / FRAME.w

  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setFrameW(e.contentRect.width || 340))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Push a cheap preview to the building after each committed change.
  useEffect(() => {
    let alive = true
    const t = window.setTimeout(() => {
      void renderBillboard(source, framing, 0.5, 0.7).then((img) => alive && onDraft(img))
    }, 120)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [source, framing, onDraft])

  const onDown = (e: RPointerEvent) => {
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, start: framing }
  }
  const onMove = (e: RPointerEvent) => {
    const d = drag.current
    if (!d) return
    setFraming(panFraming(d.start, source.width, source.height, (e.clientX - d.x) / k, (e.clientY - d.y) / k))
  }
  const onUp = () => {
    drag.current = null
  }
  const setZoom = (z: number) => setFraming((f) => zoomFraming(f, source.width, source.height, z))
  const nudge = (dx: number, dy: number) => setFraming((f) => panFraming(f, source.width, source.height, dx, dy))

  const scale = Math.max(FRAME.w / source.width, FRAME.h / source.height) * framing.zoom
  const save = async () => {
    setSaving(true)
    try {
      onSave(await renderBillboard(source, framing))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bb-editor" data-testid="billboard-editor">
      <div className="kicker">EDIT FRAMING · DRAG TO POSITION · ZOOM TO CROP</div>
      <div
        className="bb-frame"
        ref={frameRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        tabIndex={0}
        role="application"
        aria-label="Billboard crop. Drag or use arrow keys to reposition."
        onKeyDown={(e) => {
          const step = e.shiftKey ? 24 : 8
          if (e.key === 'ArrowLeft') nudge(step, 0)
          else if (e.key === 'ArrowRight') nudge(-step, 0)
          else if (e.key === 'ArrowUp') nudge(0, step)
          else if (e.key === 'ArrowDown') nudge(0, -step)
          else if (e.key === '+' || e.key === '=') setZoom(framing.zoom * 1.15)
          else if (e.key === '-') setZoom(framing.zoom / 1.15)
          else return
          e.preventDefault()
        }}
        data-testid="billboard-frame"
        data-framing={`${framing.zoom.toFixed(2)},${framing.x.toFixed(0)},${framing.y.toFixed(0)}`}
      >
        <img
          src={source.src}
          alt=""
          draggable={false}
          style={{
            width: source.width * scale * k,
            height: source.height * scale * k,
            transform: `translate(${framing.x * k}px, ${framing.y * k}px)`,
          }}
        />
        <div className="bb-frame-guides" aria-hidden="true" />
      </div>
      <div className="bb-zoom row gap">
        <button type="button" className="icon-btn" onClick={() => setZoom(framing.zoom / 1.2)} aria-label="Zoom out image">
          −
        </button>
        <input
          type="range"
          min={MIN_ZOOM * 100}
          max={MAX_ZOOM * 100}
          value={Math.round(framing.zoom * 100)}
          onChange={(e) => setZoom(Number(e.target.value) / 100)}
          aria-label="Image zoom"
          data-testid="billboard-zoom"
        />
        <button type="button" className="icon-btn" onClick={() => setZoom(framing.zoom * 1.2)} aria-label="Zoom in image">
          +
        </button>
        <button type="button" className="link-btn" onClick={() => setFraming(centeredFraming(source.width, source.height))}>
          Reset
        </button>
      </div>
      <div className="row gap">
        <button type="button" className="btn primary" onClick={() => void save()} disabled={saving} data-testid="billboard-save">
          {saving ? 'Saving…' : 'Save billboard'}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel} data-testid="billboard-cancel">
          Cancel
        </button>
      </div>
      <p className="muted small">The live preview is shown on your tower. Nothing is saved until you press Save.</p>
    </div>
  )
}
