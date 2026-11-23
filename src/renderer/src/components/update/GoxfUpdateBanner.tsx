/**
 * GOXF fork only: two independent update cards, stacked bottom-right.
 *   - 上游更新（qybaihe）: open the upstream release page, nothing is downloaded.
 *   - 便携版更新（GOXF）: download + self-replace the portable exe, or open the release page.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Download, GitMerge, RefreshCw, X } from 'lucide-react'
import type { GoxfPortablePrompt, GoxfUpdateEvent, GoxfUpstreamPrompt } from '@shared/goxfUpdate'
import { Button } from '@/components/ui/Button'
import { getBridge } from '@/lib/bridge'
import { t } from '@/lib/i18n'
import { useBotStore } from '@/store/botStore'

type PortableState =
  | { kind: 'hidden' }
  | { kind: 'available'; prompt: GoxfPortablePrompt }
  | { kind: 'downloading'; percent: number; totalMb?: number; version?: string }
  | { kind: 'extracting'; version: string }
  | { kind: 'restarting'; version: string }
  | { kind: 'error'; message: string }

// GOXF: every notice is the same card (title + description, action, ×), stacked bottom-right.
const CARD =
  'no-drag pointer-events-auto flex w-[340px] max-w-[92vw] items-center gap-3 rounded-3xl border border-line-strong bg-main py-3 pr-2 pl-4 text-[13px] shadow-toast animate-toast-in'

function Notice({ icon, title, desc, action, onDismiss, tip }: {
  icon: ReactNode; title: string; desc: string; action?: ReactNode; onDismiss?: () => void; tip?: string
}) {
  return (
    <div className={CARD} title={tip}>
      <span className="shrink-0 text-accent-600">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-ink">{title}</p>
        <p className="text-ink-secondary">{desc}</p>
      </div>
      {action}
      {onDismiss && <DismissButton onClick={onDismiss} />}
    </div>
  )
}

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
  // Remembered across restarts: one dismiss per upstream version.
  const [dismissedUpstream, setDismissedUpstreamState] = useState<string | null>(() =>
    localStorage.getItem('botark.goxf.dismissedUpstream')
  )
  const setDismissedUpstream = (v: string): void => {
    localStorage.setItem('botark.goxf.dismissedUpstream', v)
    setDismissedUpstreamState(v)
  }
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
        <Notice
          icon={<Download className="size-4" aria-hidden />}
          title={botBusy && portable.prompt.canSelfUpdate ? '新版本 · 回复完再更新' : '新版本可更新'}
          desc={`${shortVersion(portable.prompt.version)}，${portable.prompt.canSelfUpdate ? '点更新自动下载并重启' : '点下载打开发布页'}`}
          tip={`GOXF 自用版 v${portable.prompt.version}`}
          action={
            <Button
              size="sm"
              variant="primary"
              disabled={botBusy && portable.prompt.canSelfUpdate}
              onClick={() => void getBridge()?.goxfUpdates?.installPortable()}
            >
              {portable.prompt.canSelfUpdate ? '更新' : '下载'}
            </Button>
          }
          onDismiss={() => setDismissedPortable(portable.prompt.version)}
        />
      )}
      {showPortable && portable.kind === 'downloading' && (
        <Notice
          icon={<RefreshCw className="size-4 animate-spin" aria-hidden />}
          title={`正在下载 ${Math.round(portable.percent)}%`}
          desc={`${portable.totalMb ? `${portable.totalMb} MB · ` : ''}下载完自动重启`}
          action={
            <Button
              size="sm"
              variant="secondary"
              title="取消下载（之后点更新会直接装最新版）"
              onClick={() => {
                setPortable({ kind: 'hidden' })
                void getBridge()?.goxfUpdates?.cancelPortable()
              }}
            >
              取消
            </Button>
          }
        />
      )}
      {showPortable && portable.kind === 'extracting' && (
        <Notice icon={<RefreshCw className="size-4 animate-spin" aria-hidden />} title="正在解压" desc="请勿关闭，完成后自动重启" />
      )}
      {showPortable && portable.kind === 'restarting' && (
        <Notice icon={<RefreshCw className="size-4 animate-spin" aria-hidden />} title="正在重启" desc="几秒后自动打开" />
      )}
      {showPortable && portable.kind === 'error' && (
        <Notice
          icon={<X className="size-4" aria-hidden />}
          title="更新失败"
          desc={portable.message}
          onDismiss={() => setPortable({ kind: 'hidden' })}
        />
      )}
      {showUpstream && upstream && (
        <Notice
          icon={<GitMerge className="size-4" aria-hidden />}
          title="上游有更新"
          desc={`上游 qybaihe 发布了 v${upstream.version}，可以合并到你的 fork`}
          action={
            <Button size="sm" variant="secondary" onClick={() => void getBridge()?.goxfUpdates?.openUpstream()}>
              查看
            </Button>
          }
          onDismiss={() => setDismissedUpstream(upstream.version)}
        />
      )}
    </div>
  )
}
