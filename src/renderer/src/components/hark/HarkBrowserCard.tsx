import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronUp, Download, ExternalLink, ListChecks, Loader2, Maximize2, Minimize2, Minus, X } from 'lucide-react'
import { harkRpc } from '@adapters/hark/harkRequests'
import { harkBrowserLive, type HarkBrowserPreview } from '@shared/harkBrowserPreview'
import { createId } from '@shared/id'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useBotStore } from '@/store/botStore'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'

/** One line of what Hark said it was doing while the browser ran (narration log; Hark's own plan steps are not in the stream). */
interface Step { text: string; at: number }
interface Shot { src: string; at: number; step?: string }

const FAILED = /fail|error|cancel|abort|timeout/i

function endedLabel(status: string): string {
  return FAILED.test(status) ? '浏览器任务失败' : /complete|done|success|finish/i.test(status) ? '浏览器任务已完成' : `已结束（${status}）`
}
const MAX_SHOTS = 24

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * GOXF v10: Hark's remote browser as a card at the end of the conversation (like hark.com),
 * with the current step, a 计划 list, minimize, close, and a full-window view with step list,
 * screenshot history, save and "open in web".
 */
export function HarkBrowserCard({ accountId, sessionId, attention = false }: { accountId: string; sessionId?: string; attention?: boolean }) {
  const [panel, setPanel] = useState<HarkBrowserPreview | null>(null)
  const [image, setImage] = useState('')
  const [shotAt, setShotAt] = useState(0)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [mini, setMini] = useState(false)
  const [closed, setClosed] = useState('')
  const [plan, setPlan] = useState(false)
  const [full, setFull] = useState(false)
  const [steps, setSteps] = useState<Step[]>([])
  const [shots, setShots] = useState<Shot[]>([])
  const [viewing, setViewing] = useState<Shot | null>(null)
  const streamRevision = useRef(0)
  const imageRef = useRef('')
  const snapshotRequest = useRef<AbortController | null>(null)
  const hark = getBridge()?.hark
  const openWeb = useBotStore((s) => s.openWebSessionAt)

  useEffect(() => hark?.onEvent((event) => {
    if (event.type !== 'projectHistory' || event.accountId !== accountId || event.conversationId !== sessionId) return
    if (event.browserPreview !== undefined) {
      streamRevision.current++
      snapshotRequest.current?.abort()
      setError('')
      setPanel(event.browserPreview)
    }
    const text = event.live?.busy ? event.live.text.trim() : ''
    if (text) setSteps((s) => (s.at(-1)?.text === text ? s : [...s, { text, at: Date.now() }].slice(-40)))
  }), [hark, accountId, sessionId])

  useEffect(() => {
    if (!hark) return
    const request = new AbortController()
    snapshotRequest.current = request
    const before = streamRevision.current
    void harkRpc(hark, { accountId, op: 'browserPreview', conversationId: sessionId, requestId: createId('hark_preview') }, request.signal).then((res) => {
      if (!request.signal.aborted && before === streamRevision.current && res.ok) setPanel(res.data as HarkBrowserPreview | null)
    }).catch(() => undefined)
    return () => {
      request.abort()
      if (snapshotRequest.current === request) snapshotRequest.current = null
    }
  }, [hark, accountId, sessionId, revision])

  const waiting = attention || /^waiting/i.test(panel?.status ?? '')
  const active = !!panel && harkBrowserLive(panel.status)
  const hidden = !panel || (closed !== '' && closed === panel.label && !waiting)
  const ended = !!panel && !active && !waiting
  useEffect(() => { if (waiting) setMini(false) }, [waiting])
  useEffect(() => { if (ended) setMini(true) }, [ended])

  // Keep the screenshot fresh while the browser works or waits (5 s) or the full view is open;
  // otherwise still look every 15 s, so a new browser run shows up even when the stream misses it.
  useEffect(() => {
    const live = !hidden && (waiting || active || full)
    const timer = setInterval(() => setRevision((r) => r + 1), live ? 5000 : 15_000)
    return () => clearInterval(timer)
  }, [hidden, waiting, active, full])

  const key = panel?.screenshotKey
  const url = panel?.screenshotUrl
  useEffect(() => {
    if (!key && !url) { imageRef.current = ''; setImage('') }
    if (!hark || hidden || (mini && !full) || (!key && !url)) return
    let current = true
    void hark.rpc({ accountId, op: 'downloadArtifact', fileId: key, url: key ? undefined : url }).then((res) => {
      if (!res.ok) throw new Error(res.message)
      const data = res.data as { mimeType: string; dataBase64: string }
      if (!data?.mimeType?.startsWith('image/') || !data.dataBase64) throw new Error('截图不可用')
      if (!current) return
      const src = `data:${data.mimeType};base64,${data.dataBase64}`
      const at = Date.now()
      setError('')
      if (imageRef.current !== src) {
        imageRef.current = src
        setImage(src)
        setShotAt(at)
        setShots((s) => (s.at(-1)?.src === src ? s : [...s, { src, at }].slice(-MAX_SHOTS)))
      }
    }).catch((err) => { if (current) setError(String(err instanceof Error ? err.message : err)) })
    return () => { current = false }
  }, [hark, accountId, key, url, revision, hidden, mini, full])

  // Tag each new screenshot with the step Hark was on.
  const step = steps.at(-1)?.text ?? ''
  useEffect(() => {
    setShots((s) => (s.length && !s.at(-1)!.step && step ? [...s.slice(0, -1), { ...s.at(-1)!, step }] : s))
  }, [shots.length, step])

  const closeFull = useCallback(() => { setFull(false); setViewing(null) }, [])
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeFull() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full, closeFull])

  // An ended browser with nothing to show is noise.
  if (!hark || hidden || !panel || (ended && !image && !key && !url)) return null

  const done = ended
  const failed = done && FAILED.test(panel.status)
  const stepText = done ? endedLabel(panel.status) : step || (waiting ? '等你处理' : '正在用浏览器')
  const shown = viewing ?? (image ? { src: image, at: shotAt } : null)
  const save = () => {
    if (!shown) return
    const a = document.createElement('a')
    a.href = shown.src
    a.download = `hark-browser-${new Date(shown.at).toISOString().replace(/[:.]/g, '-')}.png`
    a.click()
  }

  const StepPill = ({ dark = false }: { dark?: boolean }) => (
    <div className={cn('flex min-w-0 items-center gap-2 rounded-full px-3 py-1.5 text-[12px]',
      dark ? 'bg-white text-ink' : 'bg-sunken text-ink')}>
      {failed ? <X className="size-3.5 shrink-0 text-status-error" /> : done ? <Check className="size-3.5 shrink-0 text-status-online" /> : <Loader2 className="size-3.5 shrink-0 animate-spin text-accent-600" />}
      <span className="truncate">{stepText}</span>
    </div>
  )
  const IconBtn = ({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) => (
    <IconButton label={label} size="sm" onClick={onClick}>{children}</IconButton>
  )
  const StepList = ({ dark = false }: { dark?: boolean }) => (
    <ol className="flex flex-col gap-2">
      {steps.length === 0 && <li className={dark ? 'text-white/55' : 'text-ink-muted'}>还没有步骤记录</li>}
      {steps.map((s, i) => {
        const last = i === steps.length - 1
        return (
          <li key={`${s.at}-${i}`} className="flex items-start gap-2">
            {last && !done ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-accent-500" />
              : <Check className="mt-0.5 size-3.5 shrink-0 text-status-online" />}
            <span className={cn('min-w-0 flex-1', dark ? (last ? 'font-medium text-white' : 'text-white/75') : (last ? 'font-medium text-ink' : 'text-ink-secondary'))}>{s.text}</span>
            <span className={cn('shrink-0 text-[10px]', dark ? 'text-white/55' : 'text-ink-muted')}>{clock(s.at)}</span>
          </li>
        )
      })}
    </ol>
  )

  return (
    <>
      {/* Same column as MessageList (max-w 860, px-8) and indented past the bot avatar (w-7 + gap-2.5). */}
      <div className="mx-auto mb-2 w-full max-w-[860px] shrink-0 px-8">
      <section className={cn('ml-[38px] max-w-[600px] rounded-2xl border bg-surface text-[12px] shadow-soft')}>
        {mini ? (
          <button type="button" onClick={() => setMini(false)} className="flex w-full items-center gap-2 px-3 py-2 text-ink-secondary">
            <span className={cn('size-2 shrink-0 rounded-full', active || waiting ? 'bg-status-online' : failed ? 'bg-status-error' : 'bg-ink-muted')} />
            <span className="shrink-0">远程浏览器</span>
            <span className="truncate text-ink">{stepText}</span>
            <ChevronUp className="ml-auto size-4 shrink-0" />
          </button>
        ) : (<>
          <div className="flex items-center gap-2 px-3 pt-2.5">
            <span className={cn('flex shrink-0 items-center gap-1 font-medium', active || waiting ? 'text-status-online' : 'text-ink-muted')}>
              <span className={cn('size-2 rounded-full', active || waiting ? 'bg-status-online' : 'bg-ink-muted')} />{active || waiting ? '实时' : '已结束'}
            </span>
            <span className="truncate text-ink-muted">{panel.label}</span>
            {shotAt > 0 && <span className="ml-auto shrink-0 text-[11px] text-ink-muted">{clock(shotAt)}</span>}
          </div>
          <button type="button" className="mx-3 mt-2 block w-[calc(100%-1.5rem)] overflow-hidden rounded-xl bg-sunken" onClick={() => setFull(true)}
            aria-label="全屏查看">
            {image ? <img src={image} alt="Hark 远程浏览器截图" className="max-h-[38vh] w-full object-contain" />
              : <div className="grid h-40 place-items-center text-ink-muted">{error || (key || url ? '正在加载截图…' : '暂无截图')}</div>}
          </button>
          {plan && <div className="mx-3 mt-2 max-h-48 overflow-y-auto rounded-xl bg-sunken p-3"><StepList /></div>}
          <div className="flex items-center gap-1.5 p-3">
            <div className="min-w-0 flex-1"><StepPill /></div>
            <button type="button" onClick={() => setPlan(!plan)} aria-expanded={plan}
              className={cn('press flex h-7 shrink-0 items-center gap-1 rounded-full px-3 font-medium', plan ? 'border-[0.5px] border-line-strong bg-main text-ink shadow-float' : 'text-ink-secondary hover:bg-hover hover:text-ink')}>
              <ListChecks className="size-3.5" />计划
            </button>
            <IconBtn label="全屏" onClick={() => setFull(true)}><Maximize2 className="size-3.5" /></IconBtn>
            <IconBtn label="收起" onClick={() => setMini(true)}><Minus className="size-3.5" /></IconBtn>
            <IconBtn label="关闭" onClick={() => setClosed(panel.label)}><X className="size-3.5" /></IconBtn>
          </div>
          {waiting && (
            <div className="mx-3 mb-3 flex items-center gap-2 text-ink-secondary">
              <span className="size-1.5 shrink-0 rounded-full bg-status-attention" aria-hidden />需要你处理 · 见下方卡片
            </div>
          )}
        </>)}
      </section>
      </div>

      {full && createPortal(
        <div role="dialog" aria-modal="true" aria-label="远程浏览器全屏" className="fixed inset-0 z-[100] flex flex-col bg-black/82 text-[12px] text-white/85 backdrop-blur-sm">
          <header className="flex shrink-0 items-center gap-3 px-4 py-3">
            <button type="button" aria-label="关闭全屏 (Esc)" onClick={closeFull}
              className="press-icon grid size-8 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"><X className="size-4" /></button>
            <span className="shrink-0 text-[13px] font-semibold text-white">远程浏览器</span>
            <span className="truncate text-white/55">{panel.label}</span>
            <span className="ml-auto shrink-0 text-white/55 tabular-nums">
              {viewing ? `回看 ${clock(viewing.at)}` : `${active || waiting ? '实时' : '已结束'}${shotAt ? ` · ${clock(shotAt)}` : ''}`}
            </span>
            {viewing && <Button size="sm" variant="primary" onClick={() => setViewing(null)}>回到实时</Button>}
            <button type="button" onClick={save} disabled={!shown}
              className="press inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-3 font-medium text-white hover:bg-white/25 disabled:opacity-40"><Download className="size-3.5" />保存截图</button>
            <button type="button" onClick={() => { closeFull(); openWeb(null) }}
              className="press inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-3 font-medium text-white hover:bg-white/25">在网页里接管<ExternalLink className="size-3.5" /></button>
          </header>
          <div className="flex min-h-0 flex-1 gap-4 px-4">
            <div className="relative grid min-w-0 flex-1 place-items-center overflow-hidden rounded-xl bg-white/[0.06]">
              {shown ? <img src={shown.src} alt="Hark 远程浏览器截图" className="max-h-full max-w-full object-contain" />
                : <span className="text-white/55">{error || '暂无截图'}</span>}
            </div>
            <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto rounded-xl bg-white/[0.08] p-4">
              <div>
                <div className="mb-3 flex items-center justify-between"><span className="text-[13px] font-semibold text-white">计划</span>
                  <span className="text-white/55">{steps.length} 步</span></div>
                <StepList dark />
              </div>
              <div>
                <div className="mb-2 text-[12px] font-semibold text-white/55">截图记录</div>
                {shots.length === 0 ? <p className="text-white/55">还没有截图</p> : (
                  <div className="grid grid-cols-3 gap-2">
                    {shots.map((s) => (
                      <button key={s.at} type="button" title={`${clock(s.at)}${s.step ? ` · ${s.step}` : ''}`}
                        onClick={() => setViewing(s.src === image ? null : s)}
                        className={cn('overflow-hidden rounded-md border', (viewing ? viewing.at === s.at : s.src === image) ? 'border-accent-500' : 'border-white/15')}>
                        <img src={s.src} alt={clock(s.at)} className="aspect-video w-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-[11px] text-white/55">点缩略图回看那一步的画面</p>
              </div>
            </aside>
          </div>
          <footer className="flex shrink-0 items-center gap-2 px-4 py-3">
            <div className="min-w-0 max-w-xl"><StepPill dark /></div>
            <button type="button" aria-label="缩小回卡片" title="缩小回卡片" onClick={closeFull}
              className="press-icon grid size-8 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"><Minimize2 className="size-4" /></button>
            <span className="text-white/55">Esc 退出全屏</span>
          </footer>
        </div>, document.body)}
    </>
  )
}
