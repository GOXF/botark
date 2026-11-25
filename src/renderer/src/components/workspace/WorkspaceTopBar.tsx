import { Columns2, Rows2, Equal } from 'lucide-react'
import { cn } from '@/lib/cn'
import { activeTab, leaves, type SplitSide } from '@/lib/paneTree'
import { shortcutLabel } from '@/lib/shortcuts'
import { useBotStore } from '@/store/botStore'
import { usePanes } from '@/store/paneStore'
import { useRooms } from '@/rooms/roomStore'
import { RoomAvatarCluster } from '@/rooms/RoomAvatarCluster'
import { BotAvatar } from '@/components/ui/Avatar'
import { MULTI_CONVERSATION } from '@/services/workspaceSync'
import { canSplitFocused, paneArea } from './PaneGrid'
import { VIEW_TRACK, ViewTab } from './ViewTab'

/** GOXF v25: the chat tab names what it opens — the selected bot (会话) or group (协作). */
function ChatTab({ selected, onClick }: { selected: boolean; onClick: () => void }) {
  const bot = useBotStore((s) => s.bots.find((b) => b.id === s.selectedBotId))
  const room = useRooms((r) => r.rooms.find((x) => x.id === useBotStore.getState().selectedBotId))
  // 会话/协作 follow the sidebar; 任务 (all) names whatever is selected.
  const scope = usePanes((s) => (s.scope === 'all' ? (room ? 'collab' : 'sessions') : s.scope))
  const fallback = scope === 'collab' ? '协作' : '会话'
  const name = scope === 'collab' ? room?.title : bot?.name
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      title={name ?? fallback}
      className={cn(
        'no-drag press flex h-10 max-w-[260px] min-w-0 shrink items-center gap-2 rounded-full pr-3.5 pl-2 font-medium',
        selected ? 'border-[0.5px] border-line-strong bg-main text-[14px] text-ink shadow-float' : 'text-[13px] text-ink-muted hover:text-ink',
        !name && 'px-3.5'
      )}
    >
      {scope === 'sessions' && bot && (
        <BotAvatar
          emoji={bot.emoji}
          seed={bot.id}
          avatar={bot.avatar}
          avatarShape={bot.avatarShape}
          avatarColor={bot.avatarColor}
          platformId={bot.platformId}
          size="xs"
          ringClassName="ring-main"
        />
      )}
      {scope === 'collab' && room && <RoomAvatarCluster members={room.members} size="xs" />}
      <span className="min-w-0 truncate">{name ?? fallback}</span>
    </button>
  )
}

/** Split the focused pane; returns why not when it would go under the minimum. */
export function splitFocused(side: SplitSide): string | undefined {
  const check = canSplitFocused(side, paneArea.box)
  if (!check.ok) {
    usePanes.getState().say(check.reason)
    return check.reason
  }
  const panes = usePanes.getState()
  if (panes.stash) panes.toggleMaximize(panes.focusedId)
  panes.split(usePanes.getState().focusedId, side, null)
  return undefined
}

function ToolButton({ icon, label, keys, fold, onClick }: { icon: React.ReactNode; label: string; keys?: string; fold?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={keys ? `${label} (${keys})` : label}
      className="no-drag press flex h-[28px] items-center gap-1.5 rounded-full bg-hover px-2.5 text-[12px] font-medium text-ink hover:bg-active"
    >
      {icon}
      {/* Folded (merged header): keys go first, then labels, as the left side narrows. */}
      <span className={cn(fold && 'hidden @min-[360px]:inline')}>{label}</span>
      {keys && <span className={cn('text-[10.5px] font-normal text-ink-muted', fold && 'hidden @min-[560px]:inline')}>{keys}</span>}
    </button>
  )
}

/**
 * GOXF v22: one plain pane on 会话 has no top bar; its chat header carries the
 * split tools and the 看板 · bot · 协作 switch. Mirrors Pane's own conditions.
 */
export function useMergedHeader(): boolean {
  const tab = usePanes((p) => {
    if (p.view !== 'sessions' || p.stash) return null
    const all = leaves(p.tree)
    return all.length === 1 && all[0]!.tabs.length <= 1 ? (activeTab(all[0]!) ?? null) : null
  })
  return useBotStore((b) => {
    if (b.settingsOpen || !tab) return false
    const bot = b.bots.find((x) => x.id === tab.botId)
    if (!bot) return false
    return !(MULTI_CONVERSATION.has(bot.platformId) && tab.conversationId && tab.conversationId !== bot.activeSessionId)
  })
}

/** 向右分 · 向下分 · 均分, plus the split notice bubble. */
export function SplitTools({ fold = false }: { fold?: boolean }) {
  const many = usePanes((s) => leaves(s.tree).length > 1)
  const equalizeAll = usePanes((s) => s.equalizeAll)
  const notice = usePanes((s) => s.notice)
  const split = (side: SplitSide) => void splitFocused(side)
  return (
    <div className="no-drag relative flex shrink-0 items-center gap-1.5">
      {notice && (
        <span
          role="status"
          className={cn(
            'absolute top-full z-40 mt-2 rounded-full bg-ink px-3 py-1.5 text-[12px] whitespace-nowrap text-white shadow-soft',
            fold ? 'left-0' : 'right-0'
          )}
        >
          {notice}
        </span>
      )}
      <ToolButton icon={<Columns2 className="size-3.5" />} label="向右分" fold={fold} keys={shortcutLabel('\\')} onClick={() => split('right')} />
      <ToolButton icon={<Rows2 className="size-3.5" />} label="向下分" fold={fold} keys={shortcutLabel('Shift+\\')} onClick={() => split('bottom')} />
      <span className={cn(!many && 'pointer-events-none opacity-40')}>
        <ToolButton icon={<Equal className="size-3.5" />} label="均分" fold={fold} onClick={equalizeAll} />
      </span>
    </div>
  )
}

/**
 * GOXF v12 top bar (v25: chat tab · 看板; 会话/协作 moved to the sidebar); on 会话 the split tools
 * (向右分 Ctrl+\ · 向下分 Ctrl+Shift+\ · 均分). Hidden when the header is merged (v22).
 */
export function WorkspaceTopBar() {
  const view = usePanes((s) => s.view)
  const setView = usePanes((s) => s.setView)
  const settingsOpen = useBotStore((s) => s.settingsOpen)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const merged = useMergedHeader()
  if (merged) return null

  return (
    <div className="drag-region relative flex h-[52px] shrink-0 items-center gap-2 border-b border-line px-3">
      <div role="tablist" aria-label="页面" className={cn(VIEW_TRACK, 'absolute left-1/2 -translate-x-1/2')}>
        <ChatTab
          selected={!settingsOpen && view !== 'board'}
          onClick={() => {
            if (settingsOpen) setSettingsOpen(false)
            const scope = usePanes.getState().scope
            const roomOn = useRooms.getState().rooms.some((r) => r.id === useBotStore.getState().selectedBotId)
            setView(scope === 'all' ? (roomOn ? 'collab' : 'sessions') : scope)
          }}
        />
        <ViewTab
          label="任务"
          selected={!settingsOpen && view === 'board'}
          onClick={() => {
            if (settingsOpen) setSettingsOpen(false)
            setView('board')
          }}
        />
      </div>
      {view === 'sessions' && !settingsOpen && (
        <div className="ml-auto">
          <SplitTools />
        </div>
      )}
    </div>
  )
}
