import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { cn } from '@/lib/cn'
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, useBotStore } from '@/store/botStore'
import { t } from '@/lib/i18n'

interface AppShellProps {
  sidebar: ReactNode
  main: ReactNode
  aside: ReactNode
  asideOpen: boolean
}

function dragWidth(start: { x: number; width: number }, clientX: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, start.width + clientX - start.x)))
}

/**
 * Right-edge grip of the sidebar: drag to resize, double-click to reset,
 * ←/→ when focused.
 */
function SidebarGrip({ sidebarRef }: { sidebarRef: RefObject<HTMLElement | null> }) {
  const width = useBotStore((s) => s.sidebarWidth)
  const setWidth = useBotStore((s) => s.setSidebarWidth)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ pointerId: number; x: number; width: number; next: number } | null>(null)
  const frame = useRef<number | null>(null)
  const grip = useRef<HTMLDivElement>(null)

  const endDrag = (commit: boolean) => {
    const current = drag.current
    if (!current) return
    drag.current = null
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    if (commit) setWidth(current.next)
    const savedWidth = useBotStore.getState().sidebarWidth
    if (sidebarRef.current) {
      sidebarRef.current.style.width = `${savedWidth}px`
      sidebarRef.current.style.removeProperty('transition-property')
    }
    grip.current?.setAttribute('aria-valuenow', String(savedWidth))
    setDragging(false)
  }

  useLayoutEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    if (drag.current) sidebarRef.current?.style.removeProperty('transition-property')
  }, [sidebarRef])

  return (
    <div
      ref={grip}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Resize sidebar')}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { pointerId: event.pointerId, x: event.clientX, width, next: width }
        sidebarRef.current?.style.setProperty('transition-property', 'none')
        setDragging(true)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current || event.pointerId !== current.pointerId) return
        current.next = dragWidth(current, event.clientX)
        if (frame.current !== null) return
        frame.current = requestAnimationFrame(() => {
          frame.current = null
          if (sidebarRef.current) sidebarRef.current.style.width = `${current.next}px`
          grip.current?.setAttribute('aria-valuenow', String(current.next))
        })
      }}
      onPointerUp={(event) => {
        const current = drag.current
        if (!current || event.pointerId !== current.pointerId) return
        current.next = dragWidth(current, event.clientX)
        endDrag(true)
      }}
      onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) endDrag(false) }}
      onPointerCancel={(event) => { if (drag.current?.pointerId === event.pointerId) endDrag(false) }}
      onDoubleClick={() => setWidth(SIDEBAR_DEFAULT)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          setWidth(width + (event.key === 'ArrowRight' ? 16 : -16))
        }
      }}
      className={cn(
        'no-drag group absolute inset-y-0 -right-[3px] z-10 w-1.5 touch-none cursor-col-resize outline-none',
        dragging && 'cursor-col-resize'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-[2px] w-[2px] rounded-full bg-transparent transition-colors duration-150',
          'group-hover:bg-line-strong group-focus-visible:bg-accent-600',
          dragging && 'bg-accent-600 group-hover:bg-accent-600'
        )}
      />
    </div>
  )
}

/**
 * Three columns: the sidebar on the canvas, then the conversation and the
 * details panel on one white surface.
 */
export function AppShell({ sidebar, main, aside, asideOpen }: AppShellProps) {
  const sidebarRef = useRef<HTMLElement>(null)
  const sidebarWidth = useBotStore((s) => s.sidebarWidth)
  const sidebarCollapsed = useBotStore((s) => s.sidebarCollapsed)
  return (
    <div className="flex h-full w-full overflow-hidden bg-canvas text-ink">
      <nav
        ref={sidebarRef}
        aria-label={t('Bots')}
        style={{ width: sidebarCollapsed ? 68 : sidebarWidth }}
        className="relative flex shrink-0 flex-col border-r border-ink/[0.12] bg-canvas transition-[width] duration-[300ms] ease-spring-shape"
      >
        {sidebar}
        {!sidebarCollapsed && <SidebarGrip sidebarRef={sidebarRef} />}
      </nav>

      <div className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 overflow-hidden bg-main">
          <main className="flex min-w-0 flex-1 flex-col">{main}</main>
          {/* Only the panel's edge moves (shape spring); its content keeps
              the final width so nothing inside reflows mid-animation. */}
          <aside
            aria-label={t('Bot details')}
            aria-hidden={!asideOpen}
            inert={!asideOpen}
            className={cn(
              'flex shrink-0 flex-col overflow-hidden border-line bg-main transition-[width] duration-[420ms] ease-spring-shape motion-reduce:transition-none',
              asideOpen ? 'w-[300px] border-l' : 'w-0'
            )}
          >
            <div
              className={cn(
                'flex h-full w-[300px] flex-col transition-opacity duration-200',
                asideOpen ? 'opacity-100' : 'opacity-0'
              )}
            >
              {aside}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
