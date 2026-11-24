import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { WebViewBounds } from '@shared/ipc'
import { getBridge } from '@/lib/bridge'
import { useOverlayStore } from '@/lib/overlay'
import { avoidNotice, useNoticeRect } from '@/lib/noticeRect'

export type WebSessionState =
  | { status: 'unsupported' }
  | { status: 'loading' }
  | { status: 'ready'; partition: string }
  | { status: 'error'; message: string }

interface Options {
  botId: string
  accountId: string
  url?: string
  label: string
  /** Element whose on-screen rect the native view should cover. */
  containerRef: RefObject<HTMLElement | null>
}

function measure(el: HTMLElement, notice: ReturnType<typeof useNoticeRect>): WebViewBounds {
  const rect = el.getBoundingClientRect()
  // GOXF: the native view paints over all DOM, so stop short of the update notices.
  return avoidNotice({ x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }, notice)
}

// The main window has one attached view. Queue attach/detach across hook instances,
// including when the next instance reuses the same view ID.
let viewOperations: Promise<unknown> = Promise.resolve()
let desiredOwner: symbol | undefined
let attachedOwner: symbol | undefined

function queueViewOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = viewOperations.then(operation)
  viewOperations = result.catch(() => undefined)
  return result
}

/**
 * Shows the main-process WebContentsView for a bot + account over
 * `containerRef`, keeping its bounds in sync. Hidden while DOM overlays are
 * open, and detached (not destroyed) on unmount so the session survives.
 */
export function useWebSessionView({ botId, accountId, url, label, containerRef }: Options): WebSessionState {
  const webViews = getBridge()?.webViews
  const overlayOpen = useOverlayStore((s) => s.count > 0)
  const notice = useNoticeRect()
  const noticeRef = useRef(notice)
  noticeRef.current = notice
  const syncRef = useRef<(() => void) | null>(null)
  const [state, setState] = useState<WebSessionState>(() =>
    webViews ? { status: 'loading' } : { status: 'unsupported' }
  )

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!webViews || !el || overlayOpen) return

    const owner = Symbol()
    desiredOwner = owner
    const ownsView = () => desiredOwner === owner && attachedOwner === owner
    let viewId: string | null = null
    let bounds: WebViewBounds | undefined
    let frame: number | null = null
    const sync = () => {
      if (!ownsView() || frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        if (!viewId || !ownsView()) return
        const next = measure(el, noticeRef.current)
        if (bounds?.x === next.x && bounds.y === next.y && bounds.width === next.width && bounds.height === next.height) return
        bounds = next
        webViews.resize(viewId, next)
      })
    }
    syncRef.current = sync

    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }))
    void queueViewOperation(async () => {
      if (desiredOwner !== owner) return
      const info = await webViews.create({ botId, accountId, url, label })
      if (desiredOwner !== owner) return
      viewId = info.viewId
      bounds = measure(el, noticeRef.current)
      const attached = await webViews.attach(info.viewId, bounds)
      attachedOwner = owner
      if (ownsView()) {
        sync()
        setState({ status: 'ready', partition: attached.partition })
      }
    }).catch((error: unknown) => {
      if (desiredOwner === owner) {
        setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    })

    const observer = new ResizeObserver(sync)
    for (let node: HTMLElement | null = el; node; node = node.parentElement) observer.observe(node)
    const layoutObserver = typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes?.includes('layout-shift')
      ? new PerformanceObserver(sync) : undefined
    layoutObserver?.observe({ type: 'layout-shift' })
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    window.addEventListener('transitionend', sync, true)

    return () => {
      if (desiredOwner === owner) desiredOwner = undefined
      if (frame !== null) cancelAnimationFrame(frame)
      observer.disconnect()
      layoutObserver?.disconnect()
      window.removeEventListener('resize', sync)
      syncRef.current = null
      window.removeEventListener('scroll', sync, true)
      window.removeEventListener('transitionend', sync, true)
      void queueViewOperation(async () => {
        if (!viewId || attachedOwner !== owner) return
        attachedOwner = undefined
        await webViews.detach(viewId)
      }).catch(() => undefined)
    }
  }, [webViews, botId, accountId, url, label, containerRef, overlayOpen])

  useEffect(() => syncRef.current?.(), [notice])

  return state
}
