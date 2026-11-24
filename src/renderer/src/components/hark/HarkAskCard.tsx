import { useEffect, useState } from 'react'
import { Eye, EyeOff, ExternalLink, ShieldAlert } from 'lucide-react'
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
  const [login, setLogin] = useState<Record<string, Record<string, string>>>({})
  const [showPw, setShowPw] = useState<Record<string, boolean>>({})
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

  /** Same two calls as Hark's web form: save the login to the user's Hark vault, then hand its id to the waiting tool. */
  const submitLogin = async (ask: HarkAskView) => {
    const spec = ask.login
    const vals = login[ask.id] ?? {}
    if (!spec || !ask.requestId || spec.fields.some((f) => !vals[f])) return
    setBusy(ask.id)
    setError((e) => ({ ...e, [ask.id]: '' }))
    try {
      const saved = await hark.rpc({
        accountId, op: 'call', method: 'POST', path: '/secrets',
        body: { type: 'login', scope: spec.scope, label: spec.label, conversationId: sessionId, fields: vals }
      })
      if (!saved.ok) throw new Error(saved.message || '保存登录信息失败')
      const d = (saved.data ?? {}) as Record<string, unknown>
      const inner = (d['secret'] ?? d['data'] ?? {}) as Record<string, unknown>
      const secretId = String(d['id'] ?? d['secretId'] ?? inner['id'] ?? inner['secretId'] ?? '')
      if (!secretId) throw new Error('没拿到登录信息编号')
      const res = await hark.rpc({
        accountId, op: 'call', method: 'POST', path: '/messages/tool-response',
        body: { conversationId: sessionId, requestId: ask.requestId, dispatchId: ask.dispatchId, type: 'user_input',
          value: JSON.stringify({ secretId }) }
      })
      if (!res.ok) throw new Error(res.message || '提交失败')
      setSent((s) => ({ ...s, [ask.id]: true }))
      setLogin((l) => ({ ...l, [ask.id]: {} }))
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
            {ask.login && ask.requestId && (
              <form className="flex w-full max-w-sm flex-col gap-1.5" autoComplete="off"
                onSubmit={(e) => { e.preventDefault(); void submitLogin(ask) }}>
                {ask.login.fields.map((f) => {
                  const pw = /pass|密码/i.test(f)
                  const label = pw ? '密码' : /mail/i.test(f) ? '邮箱' : /user|name|account|phone/i.test(f) ? '账号' : f
                  return (
                    <div key={f} className="relative">
                      <TextInput value={login[ask.id]?.[f] ?? ''} placeholder={label} aria-label={label}
                        type={pw && !showPw[ask.id] ? 'password' : 'text'}
                        autoComplete={pw ? 'new-password' : 'off'} className="h-8 w-full pr-8 text-[13px]"
                        onChange={(e) => setLogin((l) => ({ ...l, [ask.id]: { ...l[ask.id], [f]: e.target.value } }))} />
                      {pw && (
                        <button type="button" aria-label={showPw[ask.id] ? '隐藏密码' : '显示密码'}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted"
                          onClick={() => setShowPw((s) => ({ ...s, [ask.id]: !s[ask.id] }))}>
                          {showPw[ask.id] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </button>
                      )}
                    </div>
                  )
                })}
                <div className="flex items-center gap-1.5">
                  <Button type="submit" size="sm" variant="primary"
                    disabled={busy === ask.id || ask.login.fields.some((f) => !login[ask.id]?.[f])}>
                    {busy === ask.id ? '提交中…' : '登录'}
                  </Button>
                  <span className="text-[11px] text-ink-muted">存进你的 Hark 保险库，BotArk 不保存</span>
                </div>
              </form>
            )}
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
