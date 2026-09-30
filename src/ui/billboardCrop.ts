import { BILLBOARD_OUTPUT } from '../config/economy'

/**
 * Billboard framing math. The billboard surface is a fixed 2:1 frame (480x240 canonical
 * pixels). The owner positions and zooms the image inside it; SAVE bakes that crop.
 */
export const FRAME = { w: BILLBOARD_OUTPUT.width, h: BILLBOARD_OUTPUT.height } as const
export const MIN_ZOOM = 1
export const MAX_ZOOM = 4

export interface Framing {
  /** 1 = image just covers the frame. */
  zoom: number
  /** Image top-left relative to the frame, in canonical frame pixels (<= 0). */
  x: number
  y: number
}

export function coverScale(nw: number, nh: number): number {
  return Math.max(FRAME.w / nw, FRAME.h / nh)
}

export function displaySize(nw: number, nh: number, zoom: number) {
  const s = coverScale(nw, nh) * zoom
  return { w: nw * s, h: nh * s, scale: s }
}

/** Keep zoom in range and the image covering the whole frame (no empty edges). */
export function clampFraming(f: Framing, nw: number, nh: number): Framing {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, f.zoom))
  const d = displaySize(nw, nh, zoom)
  return {
    zoom,
    x: Math.min(0, Math.max(FRAME.w - d.w, f.x)),
    y: Math.min(0, Math.max(FRAME.h - d.h, f.y)),
  }
}

export function centeredFraming(nw: number, nh: number, zoom = 1): Framing {
  const d = displaySize(nw, nh, zoom)
  return clampFraming({ zoom, x: (FRAME.w - d.w) / 2, y: (FRAME.h - d.h) / 2 }, nw, nh)
}

/** Change zoom while keeping the frame centre anchored on the same image point. */
export function zoomFraming(f: Framing, nw: number, nh: number, zoom: number): Framing {
  const before = displaySize(nw, nh, f.zoom)
  const after = displaySize(nw, nh, Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)))
  const cx = FRAME.w / 2
  const cy = FRAME.h / 2
  const u = (cx - f.x) / before.w
  const v = (cy - f.y) / before.h
  return clampFraming({ zoom, x: cx - u * after.w, y: cy - v * after.h }, nw, nh)
}

export function panFraming(f: Framing, nw: number, nh: number, dx: number, dy: number): Framing {
  return clampFraming({ ...f, x: f.x + dx, y: f.y + dy }, nw, nh)
}

/** Source rectangle (in natural image pixels) that the frame shows. */
export function sourceRect(f: Framing, nw: number, nh: number) {
  const { scale } = displaySize(nw, nh, f.zoom)
  return { sx: -f.x / scale, sy: -f.y / scale, sw: FRAME.w / scale, sh: FRAME.h / scale }
}
