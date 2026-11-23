/** GOXF fork only: update channel row in Settings (正式 = v*-goxf.N, 测试 = also dev prereleases). */
import { useEffect, useState } from 'react'
import type { GoxfUpdateChannel } from '@shared/goxfUpdate'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { getBridge } from '@/lib/bridge'

export function GoxfChannelRow() {
  const [channel, setChannel] = useState<GoxfUpdateChannel | null>(null)
  useEffect(() => {
    void getBridge()?.goxfUpdates?.state().then((s) => setChannel(s.channel)).catch(() => undefined)
  }, [])
  if (!channel) return null
  return (
    <div className="flex items-center justify-between px-4 py-3.5">
      <div>
        <p className="text-[14px] font-medium text-ink">更新通道</p>
        <p className="text-[12px] text-ink-muted">测试通道会收到 goxf/portable 每次推送的预发布版</p>
      </div>
      <SegmentedControl<GoxfUpdateChannel>
        size="sm"
        value={channel}
        onValueChange={(id) => {
          setChannel(id)
          void getBridge()?.goxfUpdates?.setChannel(id).catch(() => undefined)
        }}
        options={[
          { value: 'stable', label: '正式' },
          { value: 'test', label: '测试' }
        ]}
      />
    </div>
  )
}
