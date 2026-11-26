/** GOXF fork only: what the close button does (Windows/Linux). macOS always hides, so the row is not shown there. */
import { useEffect, useState } from 'react'
import type { GoxfCloseBehavior } from '@shared/goxfTray'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { getBridge, runtimePlatform } from '@/lib/bridge'

export function GoxfTrayRow() {
  const [behavior, setBehavior] = useState<GoxfCloseBehavior | null>(null)
  useEffect(() => {
    void getBridge()?.goxfTray?.get().then(setBehavior).catch(() => undefined)
  }, [])
  if (!getBridge()?.goxfTray || runtimePlatform === 'darwin') return null
  const loading = behavior === null
  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      <div>
        <p className="text-[14px] font-medium text-ink">
          点关闭按钮时
          <span className="ml-2 inline-flex h-5 items-center rounded-full bg-accent-50 px-2 align-[1px] text-[11px] font-medium text-accent-700 dark:text-accent-400">
            新
          </span>
        </p>
        <p className="text-[12px] text-ink-muted">Windows/Linux 生效；托盘右键「退出 BotArk」才真正退出</p>
      </div>
      <SegmentedControl<GoxfCloseBehavior>
        size="sm"
        value={behavior ?? 'tray'}
        onValueChange={(id) => {
          setBehavior(id)
          void getBridge()?.goxfTray?.set(id).catch(() => undefined)
        }}
        options={[
          { value: 'tray', label: '最小化到托盘', disabled: loading },
          { value: 'quit', label: '直接退出', disabled: loading }
        ]}
      />
    </div>
  )
}
