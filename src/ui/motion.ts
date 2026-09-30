import { useEffect, useRef, useState } from 'react'

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

/** Smoothly tweens a number toward `target` (instant under reduced motion). */
export function useTween(target: number, duration = 1100): number {
  const [value, setValue] = useState(target)
  const fromRef = useRef(target)
  const valueRef = useRef(target)
  useEffect(() => {
    if (prefersReducedMotion() || valueRef.current === target) {
      valueRef.current = target
      setValue(target)
      return
    }
    fromRef.current = valueRef.current
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const v = fromRef.current + (target - fromRef.current) * easeOutCubic(t)
      valueRef.current = v
      setValue(v)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return value
}
