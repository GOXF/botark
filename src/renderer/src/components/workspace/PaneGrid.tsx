import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Maximize2, Minimize2, SquareArrowOutUpRight, X } from 'lucide-react'
import { ChatArea } from '@/components/chat/ChatArea'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import {
  PANE_MIN_H,
  PANE_MIN_W,
  dropZone,
  layoutRects,
  leaves,
  minSize,
  paneHandles,
  ratioBounds,
  splitResult,
  type PaneHandle,
  type Rect,
  type SplitSide
} from '@/lib/paneTree'
import { BOT_DRAG_MIME } from '@/rooms/roomDnd'
import { useBotStore } from '@/store/botStore'
import { usePanes } from '@/store/paneStore'

interface DropHint {
  leafId: string
  zone: SplitSide | 'center'
  ok: boolean
  reason?: string
}

const ZONE_LABEL: Record<SplitSide | 'center', string> = {
  center: '替换这一格',
  left: '放到左边 · 向左分',
  right: '放到右边 · 向右分',
  top: '放到上面 · 向上分',
  bottom: '放到下面 · 向下分'
}

function zoneRect(zone: SplitSide | 'center'): string {
  switch (zone) {
    case 'left': return 'inset-y-0 left-0 w-1/2'
    case 'right': return 'inset-y-0 right-0 w-1/2'
    case 'top': return 'inset-x-0 top-0 h-1/2'
    case 'bottom': return 'inset-x-0 bottom-0 h-1/2'
    default: return 'inset-0'
  }
}

function hasBotDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(BOT_DRAG_MIME)
}

/** Shared by the toolbar and the shortcuts: can the focused pane be split that way? */
export function canSplitFocused(side: SplitSide, box: Rect | null): { ok: boolean; reason?: string } {
  const { tree, focusedId } = usePanes.getState()
  if (!box) return { ok: true }
  const r = splitResult(tree, box, focusedId, side)
  if (r.ok) return { ok: true }
  return { ok: false, reason: `分开后每格约 ${r.size}px，小于 ${r.min}px` }
}

/** Last measured size of the pane area, for the toolbar's split checks. */
export const paneArea: { box: Rect | null } = { box: null }

function Divider({ handle }: { handle: PaneHandle }) {
  const resize = usePanes((s) => s.resize)
  const equalizeAll = usePanes((s) => s.equalizeAll)
  const start = useRef<{ pos: number; ratio: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const row = handle.split.dir === 'row'
  const total = row ? handle.box.w : handle.box.h

  const onMove = (e: ReactPointerEvent) => {
    if (!start.current) return
    const usable = total - 8
    const delta = ((row ? e.clientX : e.clientY) - start.current.pos) / usable
    const [lo, hi] = ratioBounds(handle.split, total)
    resize(handle.split.id, Math.min(hi, Math.max(lo, start.current.ratio + delta)))
  }

  return (
    <div
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label="拖动调整格子大小，双击均分"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { pos: row ? e.clientX : e.clientY, ratio: handle.split.ratio }
        setDragging(true)
      }}
      onPointerMove={onMove}
      onPointerUp={() => {
        start.current = null
        setDragging(false)
      }}
      onDoubleClick={() => equalizeAll()}
      style={{ left: handle.gap.x, top: handle.gap.y, width: handle.gap.w, height: handle.gap.h }}
      className={cn('group absolute z-10 flex items-center justify-center', row ? 'cursor-col-resize' : 'cursor-row-resize')}
    >
      <span
        className={cn(
          'rounded-full transition-colors',
          row ? 'h-7 w-[3px]' : 'h-[3px] w-7',
          dragging ? 'bg-accent-600' : 'bg-line-strong group-hover:bg-accent-600'
        )}
      />
    </div>
  )
}

function Pane({ id, botId, rect, multi, focused, hint, box }: {
  id: string
  botId: string | null
  rect: Rect
  multi: boolean
  focused: boolean
  hint: DropHint | null
  box: Rect
}) {
  const focus = usePanes((s) => s.focus)
  const close = usePanes((s) => s.close)
  const toggleMaximize = usePanes((s) => s.toggleMaximize)
  const maximized = usePanes((s) => s.stash !== null)
  const replace = usePanes((s) => s.replace)
  const split = usePanes((s) => s.split)
  const [localHint, setLocalHint] = useState<DropHint | null>(null)
  const shown = localHint ?? hint

  const popOut = botId && getBridge()?.goxfPopout ? (
    <button
      type="button"
      title="弹出到独立窗口"
      aria-label="弹出到独立窗口"
      onClick={() => void getBridge()?.goxfPopout?.open(botId)}
      className="grid size-7 place-items-center rounded-full text-ink-secondary hover:bg-hover hover:text-ink"
    >
      <SquareArrowOutUpRight className="size-3.5" />
    </button>
  ) : null

  const controls = (
    <span className="no-drag flex items-center gap-0.5 border-l border-line pl-1">
      {popOut}
      <button
        type="button"
        title={maximized ? '还原分屏' : '最大化这一格'}
        aria-label={maximized ? '还原分屏' : '最大化这一格'}
        onClick={() => toggleMaximize(id)}
        className="grid size-7 place-items-center rounded-full text-ink-secondary hover:bg-hover hover:text-ink"
      >
        {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </button>
      {!maximized && (
        <button
          type="button"
          title="关闭这一格"
          aria-label="关闭这一格"
          onClick={() => close(id)}
          className="grid size-7 place-items-center rounded-full text-ink-secondary hover:bg-hover hover:text-ink"
        >
          <X className="size-3.5" />
        </button>
      )}
    </span>
  )

  const evaluate = (e: DragEvent): DropHint => {
    const el = e.currentTarget.getBoundingClientRect()
    const zone = dropZone({ x: el.left, y: el.top, w: el.width, h: el.height }, e.clientX, e.clientY)
    if (zone === 'center') return { leafId: id, zone, ok: true }
    const r = splitResult(usePanes.getState().tree, box, id, zone)
    return r.ok ? { leafId: id, zone, ok: true } : { leafId: id, zone, ok: false, reason: `分开后每格约 ${r.size}px，小于 ${r.min}px` }
  }

  return (
    <section
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerDownCapture={() => !focused && focus(id)}
      onFocusCapture={() => !focused && focus(id)}
      onDragOver={(e) => {
        if (!hasBotDrag(e)) return
        const h = evaluate(e)
        e.preventDefault()
        e.dataTransfer.dropEffect = h.ok ? 'copy' : 'none'
        if (h.zone !== localHint?.zone || h.ok !== localHint?.ok) setLocalHint(h)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLocalHint(null)
      }}
      onDrop={(e) => {
        const dropped = e.dataTransfer.getData(BOT_DRAG_MIME)
        const h = evaluate(e)
        setLocalHint(null)
        if (!dropped || !h.ok) return
        e.preventDefault()
        if (h.zone === 'center') replace(id, dropped)
        else split(id, h.zone, dropped)
        useBotStore.getState().selectBot(dropped)
      }}
      aria-label="会话格"
      className={cn(
        'absolute flex min-h-0 flex-col overflow-hidden bg-main',
        multi && 'rounded-[12px] border',
        multi && (focused ? 'border-accent-600 ring-1 ring-accent-600' : 'border-line')
      )}
    >
      {multi && !botId && <div className="no-drag absolute top-2 right-2 z-20">{controls}</div>}
      {!multi && maximized && (
        <button
          type="button"
          onClick={() => toggleMaximize(id)}
          className="no-drag absolute top-2 right-2 z-20 flex h-7 items-center gap-1 rounded-full bg-hover px-2.5 text-[12px] text-ink-secondary hover:text-ink"
        >
          <Minimize2 className="size-3.5" /> 还原分屏
        </button>
      )}
      <ErrorBoundary surface="会话格" resetKey={botId ?? id}>
        <ChatArea botId={botId} focused={focused} compact={multi} headerExtra={multi ? controls : popOut && !maximized ? <span className="no-drag flex items-center border-l border-line pl-1">{popOut}</span> : undefined} />
      </ErrorBoundary>
      {shown && (
        <div className="pointer-events-none absolute inset-0 z-30">
          <div
            className={cn(
              'absolute flex items-center justify-center rounded-[12px] border-2',
              zoneRect(shown.zone),
              shown.ok ? 'border-accent-600 bg-accent-600/15' : 'border-status-error/60 bg-status-error/10'
            )}
          >
            <span
              className={cn(
                'rounded-full px-3 py-1 text-[13px] font-medium',
                shown.ok ? 'bg-main text-accent-700' : 'bg-ink text-white'
              )}
            >
              {shown.ok ? ZONE_LABEL[shown.zone] : shown.reason}
            </span>
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * GOXF v13: the 会话 page body. Orca-style free split: drag a session to a
 * pane's edge to split, to its middle to replace; dividers drag (double-click
 * equalizes); no pane goes under 360 px wide. A single pane looks exactly
 * like the old one-conversation view.
 */
export function PaneGrid() {
  const tree = usePanes((s) => s.tree)
  const focusedId = usePanes((s) => s.focusedId)
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const all = leaves(tree)
  const multi = all.length > 1
  const pad = multi ? 8 : 0
  const min = minSize(tree)
  const box: Rect | null = size
    ? {
        x: pad,
        y: pad,
        w: Math.max(size.w - pad * 2, multi ? min.w : 0),
        h: Math.max(size.h - pad * 2, multi ? min.h : 0)
      }
    : null

  useEffect(() => {
    paneArea.box = box
  })

  const rects = box ? layoutRects(tree, box) : {}
  const handles = box ? paneHandles(tree, box) : []

  return (
    <div
      ref={ref}
      className={cn('relative min-h-0 min-w-0 flex-1', multi ? 'overflow-auto' : 'overflow-hidden')}
      style={{ minWidth: multi ? undefined : 0 }}
      data-pane-min={`${PANE_MIN_W}x${PANE_MIN_H}`}
    >
      {box && (
        <div className="relative" style={{ width: box.w + pad * 2, height: box.h + pad * 2 }}>
          {all.map((l) =>
            rects[l.id] ? (
              <Pane
                key={l.id}
                id={l.id}
                botId={l.botId}
                rect={rects[l.id]!}
                multi={multi}
                focused={l.id === focusedId}
                hint={null}
                box={box}
              />
            ) : null
          )}
          {handles.map((h) => (
            <Divider key={h.split.id} handle={h} />
          ))}
        </div>
      )}
    </div>
  )
}
