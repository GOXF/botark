import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Monitor } from 'lucide-react'
import type { HarkBrowserPreview } from '@shared/harkBrowserPreview'
import { RefreshButton } from '@/components/muse/RefreshButton'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'

export function HarkBrowserCard({ accountId, sessionId, attention = false }: { accountId: string; sessionId?: string; attention?: boolean }) {
  const [open, setOpen] = useState(false)
  const [panel, setPanel] = useState<HarkBrowserPreview | null>(null)
  const [image, setImage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const streamRevision = useRef(0)
  const hark = getBridge()?.hark

  useEffect(() => hark?.onEvent((event) => {
    if (event.type === 'projectHistory' && event.accountId === accountId && event.conversationId === sessionId
      && event.browserPreview !== undefined) {
      streamRevision.current++
      setPanel(event.browserPreview)
    }
  }), [hark, accountId, sessionId])

  useEffect(() => {
    if (!open || !hark) return
    let current = true
    const before = streamRevision.current
    setLoading(true)
    setError('')
    void hark.rpc({ accountId, op: 'browserPreview', conversationId: sessionId }).then((res) => {
      if (!current || before !== streamRevision.current) return
      if (!res.ok) throw new Error(res.message)
      setPanel(res.data as HarkBrowserPreview | null)
    }).catch((err) => {
      if (current) setError(String(err instanceof Error ? err.message : err))
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [open, hark, accountId, sessionId, revision])

  // GOXF: when Hark waits on the user, open the strip and keep its screenshot fresh (every 5 s).
  const waiting = attention || /^waiting/i.test(panel?.status ?? '')
  useEffect(() => { if (waiting) setOpen(true) }, [waiting])
  const active = /^(active|running|pending|started|waiting_for_input)$/i.test(panel?.status ?? '')
  useEffect(() => {
    if (!open || !(waiting || active)) return
    const timer = setInterval(() => setRevision((r) => r + 1), 5000)
    return () => clearInterval(timer)
  }, [open, waiting, active])

  const key = panel?.screenshotKey
  const url = panel?.screenshotUrl
  useEffect(() => {
    if (!key && !url) setImage('')
    if (!open || !hark || (!key && !url)) return
    let current = true
    setError('')
    void hark.rpc({ accountId, op: 'downloadArtifact', fileId: key, url: key ? undefined : url }).then((res) => {
      if (!res.ok) throw new Error(res.message)
      const data = res.data as { mimeType: string; dataBase64: string }
      if (!data?.mimeType?.startsWith('image/') || !data.dataBase64) throw new Error('截图不可用')
      if (current) setImage(`data:${data.mimeType};base64,${data.dataBase64}`)
    }).catch((err) => {
      if (current) setError(String(err instanceof Error ? err.message : err))
    })
    return () => { current = false }
  }, [open, hark, accountId, key, url, revision])

  if (!hark) return null
  return (
    <section className={cn('mx-5 mb-1 shrink-0 rounded-xl border bg-surface px-3 text-[12px]', waiting ? 'border-status-attention' : 'border-line')}>
      <div className="flex items-center gap-2">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-ink-secondary">
          <Monitor className="size-4 shrink-0" /><span className="shrink-0">远程浏览器</span>
          <span className="truncate">{panel?.label}</span>
          {waiting && <span className="shrink-0 rounded-full bg-status-attention/15 px-2 py-0.5 text-[11px] font-medium text-status-attention-ink">等你输入</span>}
          <ChevronDown className={open ? 'ml-auto size-4 rotate-180' : 'ml-auto size-4'} />
        </button>
        {open && <RefreshButton loading={loading} onClick={() => setRevision((r) => r + 1)} />}
      </div>
      {open && <div className="pb-2">
        {image && <img src={image} alt="Hark 远程浏览器截图" className="max-h-[24vh] w-full rounded-lg bg-sunken object-contain" />}
        <p className="truncate text-ink-muted" role="status">{error || (loading && !panel ? '正在刷新…' : panel
          ? panel.status + (image ? '' : key || url ? ' · 正在加载截图…' : ' · 暂无截图')
          : '当前对话暂无浏览器任务')}</p>
      </div>}
    </section>
  )
}
