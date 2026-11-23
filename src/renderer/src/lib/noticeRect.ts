/**
 * GOXF: where the bottom-right update notices sit on screen. A native WebContentsView (Muse etc.)
 * always paints over DOM, so web views shorten themselves to stay clear of this rect.
 */
import { useSyncExternalStore } from 'react'

export interface Rect { x: number; y: number; width: number; height: number }

let current: Rect | null = null
const listeners = new Set<() => void>()

export function setNoticeRect(rect: Rect | null): void {
  const same = rect && current && rect.x === current.x && rect.y === current.y && rect.width === current.width && rect.height === current.height
  if (same || (!rect && !current)) return
  current = rect
  for (const l of listeners) l()
}

export const useNoticeRect = (): Rect | null =>
  useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => current)

/** Cut the bottom of `view` so it ends above `notice` when they overlap (gap 8px). */
export function avoidNotice(view: Rect, notice: Rect | null): Rect {
  if (!notice) return view
  const overlapX = notice.x < view.x + view.width && notice.x + notice.width > view.x
  const overlapY = notice.y < view.y + view.height && notice.y + notice.height > view.y
  if (!overlapX || !overlapY) return view
  return { ...view, height: Math.max(0, notice.y - 8 - view.y) }
}
