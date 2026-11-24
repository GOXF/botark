import { Columns2, Rows2, Equal } from 'lucide-react'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { cn } from '@/lib/cn'
import { activeTab, leaves, type SplitSide } from '@/lib/paneTree'
import { shortcutLabel } from '@/lib/shortcuts'
import { useBotStore } from '@/store/botStore'
import { usePanes, type WorkspaceView } from '@/store/paneStore'
import { MULTI_CONVERSATION } from '@/services/workspaceSync'
import { canSplitFocused, paneArea } from './PaneGrid'

const VIEWS: ReadonlyArray<{ value: WorkspaceView; label: string }> = [
  { value: 'board', label: '看板' },
  { value: 'sessions', label: '会话' },
  { value: 'collab', label: '协作' }
]

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
      className="no-drag press flex h-[28px] items-center gap-1.5 rounded-[9px] bg-hover px-2.5 text-[12px] font-medium text-ink hover:bg-active"
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
 * GOXF v12 top bar: 看板 · 会话 · 协作 in the middle; on 会话 the split tools
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
    <div className="drag-region relative flex h-[46px] shrink-0 items-center gap-2 border-b border-line px-3">
      <div className="absolute left-1/2 -translate-x-1/2">
        <SegmentedControl
          aria-label="页面"
          size="sm"
          value={settingsOpen ? ('' as WorkspaceView) : view}
          onValueChange={(v) => {
            if (settingsOpen) setSettingsOpen(false)
            setView(v)
          }}
          options={VIEWS}
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
