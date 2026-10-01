import type { WorldPoint } from '../../game/world'

/**
 * City rotation (orbit) math. Rotation is PRESENTATION ONLY: it turns the projected city about
 * City Hall (the world origin) and never touches world coordinates, plot ids or game state.
 * One canonical angle in degrees: 0° is the default Rare City orientation and a positive angle
 * turns the city clockwise on screen.
 */

/** Degrees turned per press of a rotate control (24 presses = one full orbit). */
export const ROTATION_STEP_DEG = 15

/** Capital Plaza / City Hall: the pivot of every city rotation. */
export const WORLD_CENTER: WorldPoint = { x: 0, y: 0 }

/** Wrap any angle into [0, 360). */
export function normalizeAngle(deg: number): number {
  const a = ((deg % 360) + 360) % 360
  // Guards -0 and the float round-up of tiny negatives to exactly 360.
  return a === 360 || a === 0 ? 0 : a
}

/** Signed shortest turn from one angle to another, in (-180, 180]. */
export function shortestAngleDelta(from: number, to: number): number {
  const d = normalizeAngle(to - from)
  return d > 180 ? d - 360 : d
}

/** A world point turned `deg` about `center` on the ground plane (0° returns the point as-is). */
export function rotatePointAroundCenter(p: WorldPoint, deg: number, center: WorldPoint = WORLD_CENTER): WorldPoint {
  if (!deg) return { x: p.x, y: p.y }
  const a = (deg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const dx = p.x - center.x
  const dy = p.y - center.y
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos }
}
