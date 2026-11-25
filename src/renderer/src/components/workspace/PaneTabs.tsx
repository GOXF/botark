import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { PaneLeaf, PaneTab } from '@/lib/paneTree'
import { useConversationTitles } from '@/services/workspaceSync'
import { useBotStore } from '@/store/botStore'
import { usePanes } from '@/store/paneStore'
import { BotAvatar } from '@/components/ui/Avatar'

/** Drag payload of a pane tab: `${leafId}\n${tabId}`. */
export const PANE_TAB_MIME = 'application/x-botark-pane-tab'

export function readTabDrag(data: string): { leafId: string; tabId: string } | null {
  const [leafId, tabId] = data.split('\n')
  return leafId && tabId ? { leafId, tabId } : null
}

/** GOXF v26: the pane's capsule names the bot, so a tab names its project; a tab of another bot gets its avatar. */
function TabLabel({ tab, otherBot }: { tab: PaneTab; otherBot: boolean }) {
  const bot = useBotStore((s) => s.bots.find((b) => b.id === tab.botId))
  const typing = useBotStore((s) => s.typing[tab.botId] === true)
  const title = useConversationTitles((s) => (tab.conversationId ? s[tab.conversationId] : undefined))
  return (
    <>
      {typing && <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-status-busy" />}
      {otherBot && bot && (
        <BotAvatar emoji={bot.emoji} seed={bot.id} avatar={bot.avatar} avatarShape={bot.avatarShape}
          avatarColor={bot.avatarColor} platformId={bot.platformId} size="xs" />
      )}
      <span className="truncate" title={title ? `${bot?.name ?? '会话'} · ${title}` : undefined}>{title ?? bot?.name ?? '会话'}</span>
    </>
  )
}

/**
 * GOXF Issue #2: tabs at the top of a split pane. Click switches, × closes,
 * drag a tab to another pane's middle (joins it) or edge (splits there).
 */
export function PaneTabs({ leaf, extra, inline = false, tall = false }: { leaf: PaneLeaf; extra?: ReactNode; inline?: boolean; tall?: boolean }) {
  const selectTab = usePanes((s) => s.selectTab)
  const closeTab = usePanes((s) => s.closeTab)
  const activeBot = leaf.tabs.find((t) => t.id === leaf.active)?.botId

  return (
    <div
      role="tablist"
      aria-label="会话标签"
      className={cn('no-drag flex min-w-0 items-center gap-1', inline ? 'flex-1' : cn(tall ? 'h-[52px] pr-3 pl-2' : 'h-9 px-1.5', 'shrink-0 border-b border-line'))}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
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
              <TabLabel tab={tab} otherBot={tab.botId !== activeBot} />
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
