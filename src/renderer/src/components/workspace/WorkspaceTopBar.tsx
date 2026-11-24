import { useState } from 'react'
import { Columns2, Rows2, Equal } from 'lucide-react'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { cn } from '@/lib/cn'
import { leaves, type SplitSide } from '@/lib/paneTree'
import { shortcutLabel } from '@/lib/shortcuts'
import { useBotStore } from '@/store/botStore'
import { usePanes, type WorkspaceView } from '@/store/paneStore'
import { canSplitFocused, paneArea } from './PaneGrid'

const VIEWS: ReadonlyArray<{ value: WorkspaceView; label: string }> = [
  { value: 'board', label: '看板' },
  { value: 'sessions', label: '会话' },
  { value: 'collab', label: '协作' }
]

/** Split the focused pane; returns why not when it would go under the minimum. */
export function splitFocused(side: SplitSide): string | undefined {
  const check = canSplitFocused(side, paneArea.box)
  if (!check.ok) return check.reason
  const panes = usePanes.getState()
  if (panes.stash) panes.toggleMaximize(panes.focusedId)
  panes.split(usePanes.getState().focusedId, side, null)
  return undefined
}

function ToolButton({ icon, label, keys, onClick }: { icon: React.ReactNode; label: string; keys?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={keys ? `${label} (${keys})` : label}
      className="no-drag press flex h-[28px] items-center gap-1.5 rounded-[9px] bg-hover px-2.5 text-[12px] font-medium text-ink hover:bg-active"
    >
      {icon}
      {label}
      {keys && <span className="text-[10.5px] font-normal text-ink-muted">{keys}</span>}
    </button>
  )
}

/**
 * GOXF v12 top bar: 看板 · 会话 · 协作 in the middle; on 会话 the split tools
 * (向右分 Ctrl+\ · 向下分 Ctrl+Shift+\ · 均分).
 */
export function WorkspaceTopBar() {
  const view = usePanes((s) => s.view)
  const setView = usePanes((s) => s.setView)
  const many = usePanes((s) => leaves(s.tree).length > 1)
  const equalizeAll = usePanes((s) => s.equalizeAll)
  const settingsOpen = useBotStore((s) => s.settingsOpen)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const [notice, setNotice] = useState<string>()

  const split = (side: SplitSide) => {
    const why = splitFocused(side)
    setNotice(why)
    if (why) setTimeout(() => setNotice(undefined), 2600)
  }

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
        <div className="ml-auto flex items-center gap-1.5">
          {notice && (
            <span role="status" className="rounded-full bg-ink px-2.5 py-1 text-[12px] text-white">
              {notice}
            </span>
          )}
          <ToolButton icon={<Columns2 className="size-3.5" />} label="向右分" keys={shortcutLabel('\\')} onClick={() => split('right')} />
          <ToolButton icon={<Rows2 className="size-3.5" />} label="向下分" keys={shortcutLabel('Shift+\\')} onClick={() => split('bottom')} />
          <span className={cn(!many && 'pointer-events-none opacity-40')}>
            <ToolButton icon={<Equal className="size-3.5" />} label="均分" onClick={equalizeAll} />
          </span>
        </div>
      )}
    </div>
  )
}
