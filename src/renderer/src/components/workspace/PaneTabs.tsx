import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { PaneLeaf, PaneTab } from '@/lib/paneTree'
import { useConversationTitles } from '@/services/workspaceSync'
import { useBotStore } from '@/store/botStore'
import { usePanes } from '@/store/paneStore'

/** Drag payload of a pane tab: `${leafId}\n${tabId}`. */
export const PANE_TAB_MIME = 'application/x-botark-pane-tab'

export function readTabDrag(data: string): { leafId: string; tabId: string } | null {
  const [leafId, tabId] = data.split('\n')
  return leafId && tabId ? { leafId, tabId } : null
}

function TabLabel({ tab }: { tab: PaneTab }) {
  const bot = useBotStore((s) => s.bots.find((b) => b.id === tab.botId))
  const typing = useBotStore((s) => s.typing[tab.botId] === true)
  const title = useConversationTitles((s) => (tab.conversationId ? s[tab.conversationId] : undefined))
  return (
    <>
      {typing && <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-status-busy" />}
      <span className="truncate">{bot?.name ?? '会话'}</span>
      {title && <span className="truncate font-normal text-ink-muted">· {title}</span>}
    </>
  )
}

/**
 * GOXF Issue #2: tabs at the top of a split pane. Click switches, × closes,
 * drag a tab to another pane's middle (joins it) or edge (splits there).
 */
export function PaneTabs({ leaf, extra }: { leaf: PaneLeaf; extra?: ReactNode }) {
  const selectTab = usePanes((s) => s.selectTab)
  const closeTab = usePanes((s) => s.closeTab)

  return (
    <div role="tablist" aria-label="会话标签" className="no-drag flex h-9 shrink-0 items-center gap-1 border-b border-line px-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {leaf.tabs.map((tab) => {
          const active = tab.id === leaf.active
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData(PANE_TAB_MIME, `${leaf.id}\n${tab.id}`)
              }}
              onClick={() => selectTab(leaf.id, tab.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  selectTab(leaf.id, tab.id)
                }
              }}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(leaf.id, tab.id)
              }}
              className={cn(
                'group press flex h-7 max-w-52 min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-[9px] pr-1 pl-2.5 text-[12px] font-medium select-none',
                active ? 'bg-hover text-ink' : 'text-ink-secondary hover:bg-hover hover:text-ink'
              )}
            >
              <TabLabel tab={tab} />
              <button
                type="button"
                title="关闭标签"
                aria-label="关闭标签"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(leaf.id, tab.id)
                }}
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-active hover:text-ink',
                  !active && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                )}
              >
                <X className="size-3" />
              </button>
            </div>
          )
        })}
      </div>
      {extra}
    </div>
  )
}
