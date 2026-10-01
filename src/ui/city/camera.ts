import { rotateScreen, type Pt } from './geometry'

/**
 * Camera math (pure). The camera lives in rotated screen space: the same space the city is
 * drawn in at the camera's own angle, so the viewBox, the culling view and every pivot below
 * describe one coordinate system.
 */

/** Framing: centre in screen-space world pixels, zoom = screen px per world px. */
export interface Framing {
  x: number
  y: number
  zoom: number
}

/**
 * Camera = framing + city rotation in degrees (0 = the default orientation, positive turns the
 * city clockwise about City Hall). UI state only: never stored in GameState or persisted.
 */
export interface Camera extends Framing {
  angle: number
}

/**
 * Whether a property standing on ground point `base` and rising `height` world pixels shows in
 * the camera view. Its whole standing extent counts, not just the plot: up close on a tall
 * tower the plot is below the viewport while the tower itself fills the screen.
 */
export function standsInView(base: Pt, height: number, cam: Framing, size: { w: number; h: number }): boolean {
  const halfW = size.w / 2 / cam.zoom
  const halfH = size.h / 2 / cam.zoom
  return Math.abs(base.x - cam.x) < halfW && base.y - height < cam.y + halfH && base.y > cam.y - halfH
}

/**
 * A turn of the city about `pivot` (a ground point, in `from`'s space): the camera pose for any
 * angle of that turn. The pivot keeps its place on screen, so the camera rides the turn around
 * it. Every pose derives from the start pose and the absolute angle, so nothing accumulates.
 */
export function turnAbout(from: Camera, pivot: Pt): (angle: number) => Camera {
  const p0 = rotateScreen(pivot, -from.angle)
  return (angle) => {
    const p = rotateScreen(p0, angle)
    return { x: from.x + p.x - pivot.x, y: from.y + p.y - pivot.y, zoom: from.zoom, angle }
  }
}
