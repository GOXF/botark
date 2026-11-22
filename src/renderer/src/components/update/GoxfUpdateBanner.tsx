/**
 * GOXF fork only: two independent update cards, stacked top-right.
 *   - 上游更新（qybaihe）: open the upstream release page, nothing is downloaded.
 *   - 便携版更新（GOXF）: download + self-replace the portable exe, or open the release page.
 */
import { useEffect, useState } from 'react'
import { Download, GitMerge, RefreshCw, X } from 'lucide-react'
import type { GoxfPortablePrompt, GoxfUpdateEvent, GoxfUpstreamPrompt } from '@shared/goxfUpdate'
import { Button } from '@/components/ui/Button'
import { getBridge } from '@/lib/bridge'
import { t } from '@/lib/i18n'

type PortableState =
  | { kind: 'hidden' }
  | { kind: 'available'; prompt: GoxfPortablePrompt }
  | { kind: 'downloading'; percent: number; version?: string }
  | { kind: 'restarting'; version: string }
  | { kind: 'error'; message: string }

const CARD =
  'no-drag pointer-events-auto flex w-[min(360px,92vw)] items-start gap-2.5 rounded-xl border border-line-strong bg-main py-2 pr-1.5 pl-3 text-[13px] shadow-toast animate-toast-in'

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="press-icon grid size-7 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-ink"
      aria-label={t('Dismiss')}
      onClick={onClick}
    >
      <X className="size-3.5" />
    </button>
  )
}

export function GoxfUpdateBanner() {
  const [upstream, setUpstream] = useState<GoxfUpstreamPrompt | null>(null)
  const [dismissedUpstream, setDismissedUpstream] = useState<string | null>(null)
  const [portable, setPortable] = useState<PortableState>({ kind: 'hidden' })
  const [dismissedPortable, setDismissedPortable] = useState<string | null>(null)

  useEffect(() => {
    const bridge = getBridge()?.goxfUpdates
    if (!bridge) return
    // Pick up a result that arrived before this component mounted.
    void bridge
      .state()
      .then((s) => {
        if (s.upstream) setUpstream(s.upstream)
        if (s.portableUpdate) setPortable((p) => (p.kind === 'hidden' ? { kind: 'available', prompt: s.portableUpdate! } : p))
      })
      .catch(() => undefined)
    return bridge.onEvent((event: GoxfUpdateEvent) => {
      switch (event.type) {
        case 'upstream-available':
          setUpstream(event.prompt)
          break
        case 'portable-available':
          setPortable((p) => (p.kind === 'downloading' || p.kind === 'restarting' ? p : { kind: 'available', prompt: event.prompt }))
          break
        case 'portable-downloading':
          setPortable((p) => ({ kind: 'downloading', percent: event.percent, version: p.kind === 'available' || p.kind === 'downloading' ? (p.kind === 'available' ? p.prompt.version : p.version) : undefined }))
          break
        case 'portable-restarting':
          setPortable({ kind: 'restarting', version: event.version })
          break
        case 'portable-error':
          setPortable({ kind: 'error', message: event.message })
          break
      }
    })
  }, [])

  const showUpstream = upstream && dismissedUpstream !== upstream.version
  const showPortable =
    portable.kind !== 'hidden' && !(portable.kind === 'available' && dismissedPortable === portable.prompt.version)
  if (!showUpstream && !showPortable) return null

  return (
    <div className="pointer-events-none absolute top-3 right-3 z-50 flex flex-col items-end gap-2" role="status">
      {showPortable && portable.kind === 'available' && (
        <div className={CARD}>
          <Download className="mt-0.5 size-4 shrink-0 text-accent-600" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink">你的便携版有新版本</p>
            <p className="text-ink-secondary">
              GOXF 自用版 v{portable.prompt.version} 已发布
              {portable.prompt.canSelfUpdate ? '，下载后会自动替换并重启' : '，请到发布页下载'}
            </p>
          </div>
          <Button size="sm" variant="primary" onClick={() => void getBridge()?.goxfUpdates?.installPortable()}>
            {portable.prompt.canSelfUpdate ? '更新并重启' : '打开发布页'}
          </Button>
          <DismissButton onClick={() => setDismissedPortable(portable.prompt.version)} />
        </div>
      )}
      {showPortable && portable.kind === 'downloading' && (
        <div className={CARD}>
          <RefreshCw className="mt-0.5 size-4 shrink-0 animate-spin text-accent-600" aria-hidden />
          <p className="flex-1 text-ink">
            正在下载便携版{portable.version ? ` v${portable.version}` : ''}… {Math.round(portable.percent)}%
          </p>
        </div>
      )}
      {showPortable && portable.kind === 'restarting' && (
        <div className={CARD}>
          <RefreshCw className="mt-0.5 size-4 shrink-0 animate-spin text-accent-600" aria-hidden />
          <p className="flex-1 text-ink">已下载 v{portable.version}，正在退出并替换，稍后自动重新打开…</p>
        </div>
      )}
      {showPortable && portable.kind === 'error' && (
        <div className={CARD}>
          <p className="flex-1 text-ink-secondary">{portable.message}</p>
          <DismissButton onClick={() => setPortable({ kind: 'hidden' })} />
        </div>
      )}
      {showUpstream && upstream && (
        <div className={CARD}>
          <GitMerge className="mt-0.5 size-4 shrink-0 text-accent-600" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink">上游有更新</p>
            <p className="text-ink-secondary">上游 qybaihe 发布了 v{upstream.version}，可以合并到你的 fork</p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void getBridge()?.goxfUpdates?.openUpstream()}>
            查看
          </Button>
          <DismissButton onClick={() => setDismissedUpstream(upstream.version)} />
        </div>
      )}
    </div>
  )
}
