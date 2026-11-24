import { useEffect, useState } from 'react'
import { ChevronDown, ExternalLink, Monitor, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useBotStore } from '@/store/botStore'
import { hasComputerContext, isComputerTaskRunning, loadComputerPreview, readComputerContext, type ComputerContextSnap } from './computerContext'

const ACTIVE_POLL_MS = 3500
const PROBE_DEBOUNCE_MS = 150

type MuseBrowserCardProps = {
  accountId: string
  sessionId?: string
  activeHint: boolean
  replyId?: string
  typing: boolean
}

export function MuseBrowserCard(props: MuseBrowserCardProps) {
  return <ConversationBrowserCard key={JSON.stringify([props.accountId, props.sessionId])} {...props} />
}

function ConversationBrowserCard({ accountId, sessionId, activeHint, replyId, typing }: MuseBrowserCardProps) {
  const muse = getBridge()?.muse
  const openWebSessionAt = useBotStore((state) => state.openWebSessionAt)
  const [open, setOpen] = useState(true)
  const [revision, setRevision] = useState(0)
  const [context, setContext] = useState<{ snapshot: ComputerContextSnap; revision: number }>()
  const [checking, setChecking] = useState(false)
  const [contextFailed, setContextFailed] = useState(false)

  useEffect(() => {
    if (!muse) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const probe = async () => {
      try {
        const snapshot = await readComputerContext(muse.rpc, accountId, sessionId)
        if (cancelled) return
        setContext({ snapshot, revision })
        setContextFailed(false)
        if (hasComputerContext(snapshot) && isComputerTaskRunning(snapshot.status)) {
          timer = setTimeout(() => void probe(), ACTIVE_POLL_MS)
        }
      } catch {
        if (!cancelled) setContextFailed(true)
      } finally {
        if (!cancelled) setChecking(false)
      }
    }
    setChecking(true)
    // Coalesce reply arrival and typing changes from the same stream update.
    timer = setTimeout(() => void probe(), PROBE_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [muse, accountId, sessionId, replyId, typing, activeHint, revision])

  const snapshot = context?.snapshot
  const { taskId, sha256, inlineSrc } = snapshot ?? {}
  const previewRevision = context?.revision
  const [frame, setFrame] = useState<{ key: string; taskId?: string; src?: string; loading?: boolean; failed?: boolean }>()
  const inlineImage = inlineSrc?.startsWith('data:image/') ? inlineSrc : undefined
  const previewKey = JSON.stringify([taskId, sha256, inlineImage ? undefined : inlineSrc, previewRevision])

  useEffect(() => {
    if (!open || !muse || inlineImage || (!inlineSrc && (!taskId || !sha256))) return
    let cancelled = false
    setFrame((current) => ({ key: previewKey, taskId, src: taskId && current?.taskId === taskId ? current.src : undefined, loading: true }))
    void loadComputerPreview(muse, accountId, { taskId, sha256, inlineSrc }).then((src) => {
      if (!cancelled) setFrame({ key: previewKey, taskId, src, failed: !src })
    }).catch(() => {
      if (!cancelled) setFrame((current) => ({ key: previewKey, taskId, src: current?.src, failed: true }))
    })
    return () => { cancelled = true }
  }, [muse, accountId, open, taskId, sha256, inlineSrc, inlineImage, previewKey])

  if (!snapshot || !hasComputerContext(snapshot)) return null
  const currentFrame = frame?.key === previewKey ? frame : undefined
  const image = inlineImage ?? currentFrame?.src ?? (taskId && frame?.taskId === taskId ? frame.src : undefined)
  const awaitingFrame = Boolean(inlineSrc || (taskId && sha256)) && !inlineImage && !currentFrame
  const loading = checking || (open && (awaitingFrame || Boolean(currentFrame?.loading)))
  return (
    <section className="mx-5 mb-1 shrink-0 rounded-xl border border-line bg-surface px-3 text-[12px]" aria-label="远程浏览器">
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-ink-secondary">
          <Monitor className="size-4 shrink-0" aria-hidden />
          <span className="shrink-0 font-medium text-ink">远程浏览器</span>
          <span className="min-w-0 truncate" title={snapshot.url || snapshot.title}>{snapshot.url || snapshot.title}</span>
          {snapshot.status && <span className="shrink-0 rounded-full bg-hover px-2 py-0.5 text-[11px]">{snapshot.status}</span>}
          <ChevronDown className={cn('ml-auto size-4 shrink-0', open && 'rotate-180')} aria-hidden />
        </button>
        <IconButton size="sm" label="刷新截图" disabled={loading} onClick={() => setRevision((value) => value + 1)}>
          <RotateCw className={loading ? 'animate-spin' : undefined} aria-hidden />
        </IconButton>
        <Button size="sm" variant="secondary" className="h-7 shrink-0" onClick={() => openWebSessionAt(snapshot.interactionUrl ?? snapshot.url ?? null)}>
          <ExternalLink className="size-3.5" aria-hidden /> 打开交互视图
        </Button>
      </div>
      {open && <div className="pb-2">
        {image && !currentFrame?.failed ? <MusePreviewImage key={revision} src={image} alt={snapshot.title || 'Muse 远程浏览器截图'} /> : (
          <p role="status" className="py-1 text-ink-muted">
            {loading ? '正在加载截图…' : contextFailed || currentFrame?.failed ? '截图暂不可用' : '暂无截图'}
          </p>
        )}
      </div>}
    </section>
  )
}

export function MusePreviewImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [zoomed, setZoomed] = useState(false)
  const [failedSrc, setFailedSrc] = useState<string>()
  if (failedSrc === src) return <p role="status" className="py-1 text-[12px] text-ink-muted">截图暂不可用</p>
  return (
    <button type="button" aria-expanded={zoomed} aria-label={zoomed ? '缩小截图' : '放大截图'}
      onClick={() => setZoomed((value) => !value)}
      className={cn('block w-full overflow-hidden rounded-lg border border-line bg-sunken',
        zoomed ? 'cursor-zoom-out' : 'cursor-zoom-in', className)}>
      <img src={src} alt={alt} onError={() => setFailedSrc(src)}
        className={cn('w-full object-contain', zoomed ? 'max-h-[52vh]' : 'max-h-[24vh]')} />
    </button>
  )
}
