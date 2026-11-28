import { desktopCopy, useDesktopLocale } from '@/lib/desktopCopy'
import { memo, useEffect, useState } from 'react'
import { ExternalLink, Globe, Monitor, RotateCw } from 'lucide-react'
import {
  computerPreviewRef,
  hasComputerContext,
  loadComputerPreview,
  matchesComputerPreview,
  readComputerContext,
  type ComputerContextSnap
} from '@/components/muse/computerContext'
import { MusePreviewImage } from '@/components/muse/MuseBrowserCard'
import { ArkShieldVaultSvg } from '@/components/ui/ArkGlyphs'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useBotStore } from '@/store/botStore'
import type { ChatRichWidget } from '@/types'

type SessionCardWidget = Extract<ChatRichWidget, { kind: 'session_card' }> & { previewSrc?: string }

export const SessionInteractiveCard = memo(function SessionInteractiveCard({
  widget,
  accountId,
  botId,
  messageId
}: {
  widget: SessionCardWidget
  accountId: string
  botId: string
  messageId: string
}) {
  useDesktopLocale()
  const openWebSessionAt = useBotStore((s) => s.openWebSessionAt)
  const isVault = widget.cardType === 'vault'
  const sessionId = useBotStore((s) => s.bots.find((item) => item.id === botId)?.activeSessionId)
  const activeAccount = useBotStore((s) => s.bots.find((item) => item.id === botId)?.activeAccountId === accountId)
  const recent = useBotStore((s) => {
    if (isVault || !activeAccount || widget.previewSrc || (widget.taskId && widget.previewSha256)) return false
    return s.messages[botId]?.findLast((message) => message.accountId === accountId &&
      (message.role === 'user' || message.richWidgets?.some((card) => card.kind === 'session_card' && card.cardType !== 'vault'))
    )?.id === messageId
  })
  const lookupWhileTyping = useBotStore((s) => recent && s.typing[botId] === true)
  const { taskId, previewSha256, previewSrc } = widget
  const scope = JSON.stringify([accountId, sessionId])
  const previewScope = JSON.stringify([scope, taskId])
  const [preview, setPreview] = useState<{ scope: string; src?: string; context?: ComputerContextSnap }>()
  const [refresh, setRefresh] = useState<{ scope: string; revision: number }>()
  const revision = refresh?.scope === scope ? refresh.revision : 0

  const [loading, setLoading] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)
  useEffect(() => {
    const muse = getBridge()?.muse
    setLoading(false)
    setPreviewFailed(false)
    const ownPreview = Boolean(previewSrc || (taskId && previewSha256))
    if (isVault || !muse || (!recent && !revision && !ownPreview)) return
    let current = true
    setLoading(true)
    void (async () => {
      const ref = { taskId, sha256: previewSha256, inlineSrc: previewSrc }
      let context: ComputerContextSnap | undefined
      if (recent || revision) {
        try {
          const snapshot = await readComputerContext(muse.rpc, accountId, activeAccount ? sessionId : undefined)
          if (matchesComputerPreview(snapshot, ref) && hasComputerContext(snapshot)) {
            context = snapshot
          }
        } catch (error) {
          if (!ownPreview) throw error
        }
      }
      if (!current) return
      if (context) setPreview((previous) => ({ scope: previewScope,
        src: previous?.scope === previewScope ? previous.src : undefined, context }))
      const src = await loadComputerPreview(muse, accountId, computerPreviewRef(context, ref))
      if (current) setPreview((previous) => {
        if (!src && !context && !ownPreview) return previous
        return { scope: previewScope, src, context }
      })
    })().catch(() => {
      if (current) setPreviewFailed(true)
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [accountId, sessionId, activeAccount, previewScope, isVault, taskId, previewSha256, previewSrc, recent, lookupWhileTyping, revision])

  const shownPreview = preview?.scope === previewScope ? preview : undefined
  const image = shownPreview?.src ?? (previewSrc?.startsWith('data:image/') ? previewSrc : undefined)
  const url = shownPreview?.context?.url ?? widget.url
  const interactionUrl = shownPreview?.context?.interactionUrl ?? url
  const status = shownPreview?.context?.status ?? widget.status
  const title = shownPreview?.context?.title ?? widget.title
  const isSaved = status === '已登录'
  const openInApp = () => openWebSessionAt(interactionUrl ?? null)

  const openPopup = () => {
    const targetUrl = interactionUrl || 'https://muse.ai'
    void getBridge()?.webViews?.openInPartition?.({
      accountId,
      url: targetUrl,
      title
    })
  }

  return (
    <li className="max-w-md overflow-hidden rounded-2xl border border-line/80 bg-surface p-3.5 shadow-soft">
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-xl',
              isVault
                ? isSaved
                  ? 'bg-status-online/12 text-status-online-ink'
                  : 'bg-accent-50 text-accent-600'
                : 'bg-accent-50 text-accent-600'
            )}
          >
            {isVault ? (
              <ArkShieldVaultSvg className="size-4" />
            ) : widget.cardType === 'computer' ? (
              <Monitor className="size-4" />
            ) : (
              <Globe className="size-4" />
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13.5px] font-semibold text-ink">{title}</p>
            {(widget.subtitle || url || isVault) && <p className="truncate text-[11.5px] text-ink-muted" title={url}>
              {widget.subtitle || url || status || desktopCopy("安全存储", "Secure Storage")}
            </p>}
          </div>
        </div>
        {status && (
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium',
              isSaved
                ? 'bg-status-online/12 text-status-online-ink'
                : 'bg-hover text-ink-secondary'
            )}
          >
            {status}
          </span>
        )}
      </div>

      {!isVault && (
        image ? <MusePreviewImage key={`${previewScope}:${revision}`} src={image} alt={title} className="mt-2.5" /> : (
          <p role="status" className="mt-2 text-[12px] text-ink-muted">
            {loading ? desktopCopy("正在加载截图…", "Loading screenshots…") : previewFailed ? desktopCopy("截图暂不可用", "Screenshot unavailable") : desktopCopy("暂无截图", "No screenshot available")}
          </p>
        )
      )}
      <div className="mt-3 flex items-center gap-2">
        {!isVault && (
          <button type="button" aria-label={desktopCopy("刷新截图", "Refresh Screenshot")} title={desktopCopy("刷新截图", "Refresh Screenshot")} disabled={loading}
            onClick={() => setRefresh({ scope, revision: revision + 1 })}
            className="press-icon grid size-8 shrink-0 place-items-center rounded-full border border-line text-ink-secondary">
            <RotateCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          </button>
        )}
        <button
          type="button"
          onClick={openInApp}
          className="press flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-main px-3 text-[12.5px] font-medium text-ink ring-1 ring-line-strong hover:bg-hover"
        >
          {widget.actionLabel || (isVault ? desktopCopy("在应用内填写安全卡片", "Complete the secure form in BotArk") : desktopCopy("在隔离视图中操作", "Open in an isolated view"))}
        </button>
        <button
          type="button"
          onClick={openPopup}
          title={desktopCopy("在独立安全分区窗口打开", "Open in a separate secure window")}
          className="press-icon grid size-8 shrink-0 place-items-center rounded-full border border-line text-ink-secondary hover:bg-hover hover:text-ink"
        >
          <ExternalLink className="size-3.5" />
        </button>
      </div>
    </li>
  )
})
