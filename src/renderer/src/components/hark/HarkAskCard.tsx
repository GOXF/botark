import { useEffect, useState } from 'react'
import { ExternalLink, ShieldAlert } from 'lucide-react'
import type { HarkAskView } from '@shared/harkAsks'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Field'
import { getBridge } from '@/lib/bridge'
import { useBotStore } from '@/store/botStore'

/** GOXF: Hark's pending asks in the native chat. A code is typed here; a sign-in, card or key opens the Hark web view. */
export function useHarkAsks(accountId: string, sessionId?: string): HarkAskView[] {
  const [asks, setAsks] = useState<HarkAskView[]>([])
  const hark = getBridge()?.hark
  useEffect(() => hark?.onEvent((event) => {
    if (event.type === 'projectHistory' && event.accountId === accountId && event.conversationId === sessionId
      && event.asks !== undefined) setAsks(event.asks)
  }), [hark, accountId, sessionId])
  return asks
}

export function HarkAskCards({ accountId, sessionId, asks }: { accountId: string; sessionId?: string; asks: HarkAskView[] }) {
  const [code, setCode] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<Record<string, string>>({})
  const [sent, setSent] = useState<Record<string, true>>({})
  const openWeb = useBotStore((s) => s.openWebSessionAt)
  const hark = getBridge()?.hark
  const visible = asks.filter((a) => !sent[a.id])
  if (!hark || !sessionId || visible.length === 0) return null

  const submit = async (ask: HarkAskView, value: string) => {
    if (!ask.requestId) return
    setBusy(ask.id)
    setError((e) => ({ ...e, [ask.id]: '' }))
    try {
      const res = await hark.rpc({
        accountId, op: 'call', method: 'POST', path: '/messages/tool-response',
        body: { conversationId: sessionId, requestId: ask.requestId, dispatchId: ask.dispatchId, type: 'user_input', value }
      })
      if (!res.ok) throw new Error(res.message || '提交失败')
      setSent((s) => ({ ...s, [ask.id]: true }))
    } catch (err) {
      setError((e) => ({ ...e, [ask.id]: `${err instanceof Error ? err.message : String(err)}，请在网页里填` }))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="mx-5 mb-1 flex shrink-0 flex-col gap-1.5">
      {visible.map((ask) => (
        <section key={ask.id} role="alert"
          className="rounded-xl border border-status-attention/40 bg-status-attention/8 px-3 py-2.5 text-[12px]">
          <div className="flex items-center gap-1.5 font-semibold text-status-attention-ink">
            <ShieldAlert className="size-4 shrink-0" aria-hidden />
            <span className="truncate">需要你：{ask.prompt}</span>
          </div>
          {ask.domain && <p className="mt-0.5 truncate text-ink-muted">{ask.domain}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {ask.kind === 'code' && ask.requestId && (<>
              <TextInput value={code[ask.id] ?? ''} inputMode="numeric" autoComplete="one-time-code" placeholder="验证码"
                aria-label="验证码" className="h-8 w-40 text-[13px]"
                onChange={(e) => setCode((c) => ({ ...c, [ask.id]: e.target.value.trim() }))}
                onKeyDown={(e) => { if (e.key === 'Enter' && code[ask.id]) void submit(ask, code[ask.id]!) }} />
              <Button size="sm" variant="primary" disabled={!code[ask.id] || busy === ask.id}
                onClick={() => void submit(ask, code[ask.id]!)}>提交</Button>
            </>)}
            {ask.kind === 'confirm' && ask.requestId && (<>
              <Button size="sm" variant="primary" disabled={busy === ask.id} onClick={() => void submit(ask, 'approved')}>允许</Button>
              <Button size="sm" variant="ghost" disabled={busy === ask.id} onClick={() => void submit(ask, 'denied')}>拒绝</Button>
            </>)}
            <Button size="sm" variant="ghost" className="text-accent-600" onClick={() => openWeb(null)}>
              在网页里填 <ExternalLink aria-hidden />
            </Button>
          </div>
          {error[ask.id] && <p className="mt-1 text-status-error">{error[ask.id]}</p>}
        </section>
      ))}
    </div>
  )
}
