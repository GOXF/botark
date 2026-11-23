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
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { useBotStore } from '@/store/botStore'

type PortableState =
  | { kind: 'hidden' }
  | { kind: 'available'; prompt: GoxfPortablePrompt }
  | { kind: 'downloading'; percent: number; totalMb?: number; version?: string }
  | { kind: 'extracting'; version: string }
  | { kind: 'restarting'; version: string }
  | { kind: 'error'; message: string }

// GOXF: a small pill in the bottom-right corner so it never covers the header or content.
const CARD =
  'no-drag pointer-events-auto flex max-w-[min(320px,92vw)] items-center gap-2 rounded-full border border-line-strong bg-main py-1 pr-1 pl-3 text-[12px] shadow-toast animate-toast-in'

/** "0.13.1-goxf.dev.413dc40" → "测试版 413dc40"; stable versions unchanged. */
const shortVersion = (v?: string): string => {
  if (!v) return ''
  const dev = /\.dev\.([0-9a-f]{7,})$/i.exec(v)
  return dev ? `测试版 ${dev[1]}` : `v${v}`
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="press-icon grid size-6 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-ink"
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
  // Swapping files quits the app; never cut off a bot that is still replying.
  const botBusy = useBotStore((s) => Object.values(s.typing).some(Boolean))

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
          setPortable((p) => (p.kind === 'downloading' || p.kind === 'extracting' || p.kind === 'restarting' ? p : { kind: 'available', prompt: event.prompt }))
          break
        case 'portable-downloading':
          setPortable((p) => ({ kind: 'downloading', percent: event.percent, totalMb: event.totalMb, version: p.kind === 'available' || p.kind === 'downloading' ? (p.kind === 'available' ? p.prompt.version : p.version) : undefined }))
          break
        case 'portable-extracting':
          setPortable({ kind: 'extracting', version: event.version })
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
    <div className="pointer-events-none absolute right-3 bottom-3 z-50 flex flex-col items-end gap-2" role="status">
      {showPortable && portable.kind === 'available' && (
        <div className={CARD} title={`GOXF 自用版 v${portable.prompt.version}`}>
          <Download className="size-3.5 shrink-0 text-accent-600" aria-hidden />
          <span className="min-w-0 truncate text-ink">
            {botBusy && portable.prompt.canSelfUpdate ? '回复完再更新 · ' : '新版本 · '}
            {shortVersion(portable.prompt.version)}
          </span>
          <Button
            size="sm"
            variant="primary"
            className="h-6 rounded-full px-2.5 text-[12px]"
            disabled={botBusy && portable.prompt.canSelfUpdate}
            onClick={() => void getBridge()?.goxfUpdates?.installPortable()}
          >
            {portable.prompt.canSelfUpdate ? '更新' : '下载'}
          </Button>
          <DismissButton onClick={() => setDismissedPortable(portable.prompt.version)} />
        </div>
      )}
      {showPortable && portable.kind === 'downloading' && (
        <div className={CARD}>
          <RefreshCw className="size-3.5 shrink-0 animate-spin text-accent-600" aria-hidden />
          <span className="truncate text-ink tabular-nums">
            下载中 {Math.round(portable.percent)}%{portable.totalMb ? ` · ${portable.totalMb} MB` : ''}
          </span>
          <button
            type="button"
            title="取消下载（之后点更新会直接装最新版）"
            className="press shrink-0 rounded-full px-2 py-0.5 text-[12px] text-ink-secondary hover:bg-hover hover:text-ink"
            onClick={() => {
              setPortable({ kind: 'hidden' })
              void getBridge()?.goxfUpdates?.cancelPortable()
            }}
          >
            取消
          </button>
        </div>
      )}
      {showPortable && portable.kind === 'extracting' && (
        <div className={cn(CARD, 'pr-3')}>
          <RefreshCw className="size-3.5 shrink-0 animate-spin text-accent-600" aria-hidden />
          <span className="truncate text-ink">解压中，请勿关闭…</span>
        </div>
      )}
      {showPortable && portable.kind === 'restarting' && (
        <div className={cn(CARD, 'pr-3')}>
          <RefreshCw className="size-3.5 shrink-0 animate-spin text-accent-600" aria-hidden />
          <span className="truncate text-ink">正在重启，几秒后自动打开…</span>
        </div>
      )}
      {showPortable && portable.kind === 'error' && (
        <div className={CARD} title={portable.message}>
          <span className="min-w-0 truncate text-ink-secondary">{portable.message}</span>
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
