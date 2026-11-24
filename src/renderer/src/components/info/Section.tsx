import { createContext, useContext, useState, type DragEvent, type ReactNode } from 'react'
import { ChevronRight, GripVertical } from 'lucide-react'
import { create } from 'zustand'
import { cn } from '@/lib/cn'

/* GOXF: the overview's Sections can be dragged by their header to reorder. One order is shared by every bot;
   a Section not in the saved order yet keeps its natural place at the top of the list. */
const ORDER_KEY = 'goxf.info.order.v1'
const SECTION_MIME = 'application/x-goxf-info-section'

function readOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export const useSectionOrder = create<{ order: string[]; setOrder: (order: string[]) => void }>((set) => ({
  order: readOrder(),
  setOrder: (order) => {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(order))
    } catch {
      /* storage unavailable: order stays in memory */
    }
    set({ order })
  }
}))

/** Move `dragged` before/after `target` among the titles visible in `container`; saved titles not shown keep their tail. */
export function reorderTitles(visible: string[], saved: string[], dragged: string, target: string, after: boolean): string[] {
  const list = visible.filter((t) => t !== dragged)
  const at = list.indexOf(target)
  if (at < 0) return saved
  list.splice(after ? at + 1 : at, 0, dragged)
  return [...list, ...saved.filter((t) => !list.includes(t))]
}

const Sortable = createContext(false)

/** Container whose Sections reorder by dragging their header. */
export function SortableSections({ children }: { children: ReactNode }) {
  return (
    <Sortable.Provider value={true}>
      <div data-sortable-sections className="flex flex-col">{children}</div>
    </Sortable.Provider>
  )
}

function visibleTitles(container: Element): string[] {
  return Array.from(container.querySelectorAll(':scope > [data-section-title]'))
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    .map((el) => el.getAttribute('data-section-title') ?? '')
}

/** Default open state for Sections below; rarely used panes wrap themselves in `<SectionsCollapsed>`. */
const DefaultOpen = createContext(true)

export function SectionsCollapsed({ children }: { children: ReactNode }) {
  return <DefaultOpen.Provider value={false}>{children}</DefaultOpen.Provider>
}

const STORE_KEY = 'bothub.info.sections'

function readOpen(title: string, fallback: boolean): boolean {
  try {
    const map = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Record<string, boolean>
    return typeof map[title] === 'boolean' ? map[title]! : fallback
  } catch {
    return fallback
  }
}

function writeOpen(title: string, open: boolean) {
  try {
    const map = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Record<string, boolean>
    map[title] = open
    localStorage.setItem(STORE_KEY, JSON.stringify(map))
  } catch {
    /* storage unavailable: state stays in memory */
  }
}

interface SectionProps {
  title: string
  count?: number
  /** Short status chip beside the title (e.g. the current network mode). */
  tag?: string
  action?: ReactNode
  children: ReactNode
  /** Rows inside run edge to edge (they pad themselves). */
  flush?: boolean
  className?: string
  /** Override the inherited default open state. */
  defaultOpen?: boolean
}

/** Collapsible titled card — the details panel's only building block. Open state persists per title. */
export function Section({ title, count, tag, action, children, flush = false, className, defaultOpen }: SectionProps) {
  const inherited = useContext(DefaultOpen)
  const sortable = useContext(Sortable)
  const index = useSectionOrder((st) => (sortable ? st.order.indexOf(title) : -1))
  const [open, setOpen] = useState(() => readOpen(title, defaultOpen ?? inherited))
  const [dropAt, setDropAt] = useState<'before' | 'after' | null>(null)

  const isSectionDrag = (e: DragEvent) => sortable && e.dataTransfer.types.includes(SECTION_MIME)
  const dragProps = sortable
    ? {
        onDragOver: (e: DragEvent<HTMLElement>) => {
          if (!isSectionDrag(e)) return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          setDropAt(e.clientY > r.top + r.height / 2 ? 'after' : 'before')
        },
        onDragLeave: (e: DragEvent<HTMLElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null)
        },
        onDrop: (e: DragEvent<HTMLElement>) => {
          if (!isSectionDrag(e)) return
          e.preventDefault()
          const dragged = e.dataTransfer.getData(SECTION_MIME)
          const after = dropAt === 'after'
          setDropAt(null)
          const container = e.currentTarget.parentElement
          if (!dragged || dragged === title || !container) return
          const { order, setOrder } = useSectionOrder.getState()
          setOrder(reorderTitles(visibleTitles(container), order, dragged, title, after))
        }
      }
    : {}

  return (
    <section
      data-section-title={sortable ? title : undefined}
      style={sortable && index >= 0 ? { order: index + 1 } : undefined}
      className={cn(
        'relative px-3 pt-2.5',
        dropAt === 'before' && 'before:absolute before:inset-x-3 before:top-0.5 before:h-0.5 before:rounded-full before:bg-accent-500',
        dropAt === 'after' && 'after:absolute after:inset-x-3 after:-bottom-1.5 after:h-0.5 after:rounded-full after:bg-accent-500',
        className
      )}
      {...dragProps}
    >
      <header
        draggable={sortable || undefined}
        onDragStart={
          sortable
            ? (e) => {
                e.dataTransfer.setData(SECTION_MIME, title)
                e.dataTransfer.effectAllowed = 'move'
              }
            : undefined
        }
        className={cn(
          'group relative flex h-7 items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-hover/60',
          sortable && 'cursor-grab active:cursor-grabbing'
        )}
        title={sortable ? '拖动标题可调整顺序' : undefined}
      >
        {sortable && (
          <GripVertical
            aria-hidden
            className="pointer-events-none absolute top-1/2 -left-2.5 size-3 -translate-y-1/2 text-ink-muted opacity-0 transition-opacity group-hover:opacity-70"
          />
        )}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open)
            writeOpen(title, !open)
          }}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-lg pl-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ink/20"
        >
          <ChevronRight
            aria-hidden
            className={cn('size-3.5 shrink-0 text-ink-muted transition-transform duration-150', open && 'rotate-90')}
          />
          <h3 className="truncate text-[12px] font-semibold tracking-tight text-ink-secondary">{title}</h3>
          {count !== undefined && count > 0 && (
            <span className="rounded-full bg-hover px-1.5 text-[10.5px] leading-4 font-medium text-ink-muted tabular-nums">
              {count}
            </span>
          )}
          {tag && (
            <span className="shrink-0 rounded-full bg-hover px-1.5 text-[10.5px] leading-4 font-medium text-ink-muted">{tag}</span>
          )}
        </button>
        {action && open && <div className="flex shrink-0 items-center">{action}</div>}
      </header>
      {open && (
        <div className={cn('mt-1 overflow-hidden rounded-xl border border-line bg-surface', !flush && 'px-3 py-2.5')}>
          <Sortable.Provider value={false}>{children}</Sortable.Provider>
        </div>
      )}
    </section>
  )
}

/** One-line placeholder for an empty card. */
export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="py-0.5 text-[12px] text-ink-muted">{children}</p>
}
