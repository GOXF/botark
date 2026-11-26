import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Eye, EyeOff, ExternalLink, Lock, ShieldAlert, X } from 'lucide-react'
import type { HarkAskView } from '@shared/harkAsks'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Field'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useBotStore } from '@/store/botStore'

const DISMISSED_KEY = 'botark:hark-dismissed-asks'
const DISMISSED_MAX = 300

function readDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * GOXF: asks the user closed stay closed (across restarts and pane switches),
 * so a stale sign-in or key request no longer sits over the composer forever.
 */
export function dismissHarkAsks(ids: string[]) {
  if (!ids.length) return
  const next = [...new Set([...readDismissed(), ...ids])].slice(-DISMISSED_MAX)
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)) } catch { /* storage full: the close still holds this session */ }
  window.dispatchEvent(new Event(DISMISSED_KEY))
}

/** GOXF: Hark's pending asks in the native chat, minus the ones the user closed. A code is typed here; a sign-in, card or key opens the Hark web view. */
export function useHarkAsks(accountId: string, sessionId?: string): HarkAskView[] {
  const [asks, setAsks] = useState<HarkAskView[]>([])
  const [dismissed, setDismissed] = useState<string[]>(readDismissed)
  const hark = getBridge()?.hark
  useEffect(() => hark?.onEvent((event) => {
    if (event.type === 'projectHistory' && event.accountId === accountId && event.conversationId === sessionId
      && event.asks !== undefined) setAsks(event.asks)
  }), [hark, accountId, sessionId])
  useEffect(() => {
    const sync = () => setDismissed(readDismissed())
    window.addEventListener(DISMISSED_KEY, sync)
    return () => window.removeEventListener(DISMISSED_KEY, sync)
  }, [])
  return useMemo(() => {
    const gone = new Set(dismissed)
    return asks.filter((a) => !gone.has(a.id))
  }, [asks, dismissed])
}

export function HarkAskCards({ accountId, sessionId, asks, className = 'mx-5' }: { accountId: string; sessionId?: string; asks: HarkAskView[]; className?: string }) {
  const [code, setCode] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<Record<string, string>>({})
  const [sent, setSent] = useState<Record<string, true>>({})
  const [login, setLogin] = useState<Record<string, Record<string, string>>>({})
  const [showPw, setShowPw] = useState<Record<string, boolean>>({})
  const [key, setKey] = useState<Record<string, string>>({})
  const openWeb = useBotStore((s) => s.openWebSessionAt)
  const hark = getBridge()?.hark
  const [expanded, setExpanded] = useState<string>()
  const visible = asks.filter((a) => !sent[a.id])
  // GOXF: only one ask is open at a time (the newest, or the one picked); the rest are one-line rows.
  const openId = visible.some((a) => a.id === expanded) ? expanded : visible.at(-1)?.id
  const close = (ids: string[]) => {
    setSent((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, true as const])) }))
    dismissHarkAsks(ids)
  }
  // The web form for this very project, not Hark's home page.
  const openHere = () => openWeb(sessionId ? `https://app.hark.com/projects/${encodeURIComponent(sessionId)}` : null)
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

  /**
   * Hark's secure code form: the code goes to POST /one-time-codes (as Hark's web does; /secrets refuses
   * one_time_code), which answers {codeId} (seen in hark-frames.log 2026-11-26 17:22); that id goes to the waiting
   * tool as {codeId} (key inferred, mirrored as secretId like the login form). When that call is refused,
   * the code goes to the tool as the form's fields ({"code": …}), not as bare text, which the browser kept re-asking for.
   */
  const submitCode = async (ask: HarkAskView, value: string) => {
    if (!ask.codeSecret || !ask.requestId) return submit(ask, value)
    setBusy(ask.id)
    setError((e) => ({ ...e, [ask.id]: '' }))
    let codeId = ''
    try {
      const saved = await hark.rpc({
        accountId, op: 'call', method: 'POST', path: '/one-time-codes',
        body: { scope: ask.codeSecret.scope, code: value, conversationId: sessionId, requestId: ask.requestId, dispatchId: ask.dispatchId }
      })
      const d = (saved.ok ? saved.data ?? {} : {}) as Record<string, unknown>
      const inner = (d['oneTimeCode'] ?? d['secret'] ?? d['data'] ?? {}) as Record<string, unknown>
      codeId = String(d['codeId'] ?? d['id'] ?? d['secretId'] ?? inner['codeId'] ?? inner['id'] ?? inner['secretId'] ?? '')
    } catch {
      /* fall back to the form's fields */
    }
    try {
      const res = await hark.rpc({
        accountId, op: 'call', method: 'POST', path: '/messages/tool-response',
        body: {
          conversationId: sessionId, requestId: ask.requestId, dispatchId: ask.dispatchId, type: 'user_input',
          value: JSON.stringify(codeId ? { codeId, secretId: codeId } : { code: value })
        }
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

  /** Like the login: save the key to the Hark vault, then hand its id to the waiting tool. Body shape inferred from the login form, not observed. */
  const submitSecret = async (ask: HarkAskView) => {
    const value = key[ask.id]?.trim()
    if (!ask.secret || !ask.requestId || !value) return
    setBusy(ask.id)
    setError((e) => ({ ...e, [ask.id]: '' }))
    try {
      const saved = await hark.rpc({
        accountId, op: 'call', method: 'POST', path: '/secrets',
        body: { type: 'api_key', scope: ask.secret.scope, label: ask.secret.label, conversationId: sessionId, fields: { apiKey: value } }
      })
      if (!saved.ok) throw new Error(saved.message || '保存失败')
      const d = (saved.data ?? {}) as Record<string, unknown>
      const inner = (d['secret'] ?? d['data'] ?? {}) as Record<string, unknown>
      const secretId = String(d['id'] ?? d['secretId'] ?? inner['id'] ?? inner['secretId'] ?? '')
      if (!secretId) throw new Error('没拿到保存编号')
      const res = await hark.rpc({
        accountId, op: 'call', method: 'POST', path: '/messages/tool-response',
        body: { conversationId: sessionId, requestId: ask.requestId, dispatchId: ask.dispatchId, type: 'user_input', value: JSON.stringify({ secretId }) }
      })
      if (!res.ok) throw new Error(res.message || '提交失败')
      setSent((s) => ({ ...s, [ask.id]: true }))
      setKey((k) => ({ ...k, [ask.id]: '' }))
    } catch (err) {
      setError((e) => ({ ...e, [ask.id]: `${err instanceof Error ? err.message : String(err)}，请在网页里填` }))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className={cn(className, 'mb-1 flex shrink-0 flex-col gap-1.5')}>
      {visible.length > 1 && (
        <div className="flex items-center gap-2 px-1 text-[11.5px] text-ink-muted">
          <span>Hark 有 {visible.length} 个请求等你处理，较早的已折叠</span>
          <button type="button" onClick={() => close(visible.map((a) => a.id))}
            className="press ml-auto rounded-full px-2 py-0.5 hover:bg-hover hover:text-ink">全部收起</button>
        </div>
      )}
      {visible.map((ask) => ask.id !== openId ? (
        <div key={ask.id} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-1.5 text-[12px]">
          {ask.kind === 'credential' ? <Lock className="size-3.5 shrink-0 text-ink-muted" aria-hidden /> : <ShieldAlert className="size-3.5 shrink-0 text-ink-muted" aria-hidden />}
          <button type="button" onClick={() => setExpanded(ask.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <span className="min-w-0 truncate font-medium text-ink">{ask.prompt}</span>
            {ask.domain && <span className="shrink-0 truncate text-ink-muted">{ask.domain}</span>}
            <ChevronDown className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
          </button>
          <button type="button" aria-label="不需要了，收起" title="不需要了，收起" onClick={() => close([ask.id])}
            className="press grid size-6 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-ink">
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : (
        <section key={ask.id} role="alert"
          className="rounded-2xl border border-line bg-surface px-4 py-3.5 text-[12px] shadow-soft">
          <div className="flex items-center gap-2">
            {ask.kind === 'credential' ? <Lock className="size-4 shrink-0 text-ink" aria-hidden /> : <ShieldAlert className="size-4 shrink-0 text-ink" aria-hidden />}
            <span className="min-w-0 truncate text-[14px] font-semibold text-ink">{ask.prompt}</span>
            {ask.domain && <span className="shrink-0 truncate text-ink-muted">{ask.domain}</span>}
            <span className="size-1.5 shrink-0 rounded-full bg-status-attention" aria-label="待处理" />
            <button type="button" aria-label="不需要了，收起" title="不需要了，收起" onClick={() => close([ask.id])}
              className="press ml-auto grid size-7 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-ink">
              <X className="size-4" aria-hidden />
            </button>
          </div>
          {ask.hint && <p className="mt-1 text-[12.5px] leading-[18px] text-ink-secondary">{ask.hint}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {ask.secret && ask.requestId && (
              <form className="flex w-full items-center gap-2" autoComplete="off"
                onSubmit={(e) => { e.preventDefault(); void submitSecret(ask) }}>
                <div className="relative min-w-0 flex-1">
                  <TextInput value={key[ask.id] ?? ''} placeholder="令牌" aria-label="令牌"
                    type={showPw[ask.id] ? 'text' : 'password'} autoComplete="new-password" className="pr-9"
                    onChange={(e) => setKey((k) => ({ ...k, [ask.id]: e.target.value }))} />
                  <button type="button" aria-label={showPw[ask.id] ? '隐藏' : '显示'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
                    onClick={() => setShowPw((s) => ({ ...s, [ask.id]: !s[ask.id] }))}>
                    {showPw[ask.id] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                <Button type="submit" size="md" variant="primary" disabled={busy === ask.id || !key[ask.id]?.trim()}>
                  {busy === ask.id ? '保存中…' : '保存'}
                </Button>
              </form>
            )}
            {ask.kind === 'code' && ask.requestId && (<>
              <TextInput value={code[ask.id] ?? ''} inputMode="numeric" autoComplete="one-time-code" placeholder="验证码"
                aria-label="验证码" className="h-8 w-40 text-[13px]"
                onChange={(e) => setCode((c) => ({ ...c, [ask.id]: e.target.value.trim() }))}
                onKeyDown={(e) => { if (e.key === 'Enter' && code[ask.id]) void submitCode(ask, code[ask.id]!) }} />
              <Button size="sm" variant="primary" disabled={!code[ask.id] || busy === ask.id}
                onClick={() => void submitCode(ask, code[ask.id]!)}>提交</Button>
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

                </div>
              </form>
            )}
            {ask.kind === 'confirm' && ask.requestId && !ask.secret && (<>
              <Button size="sm" variant="primary" disabled={busy === ask.id} onClick={() => void submit(ask, 'approved')}>允许</Button>
              <Button size="sm" variant="ghost" disabled={busy === ask.id} onClick={() => void submit(ask, 'denied')}>拒绝</Button>
            </>)}
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            {(ask.secret || ask.login) && <span className="text-[11.5px] text-ink-muted">存进你的 Hark 保险库，BotArk 不保存</span>}
            <Button size="sm" variant="secondary" className="ml-auto" onClick={openHere}>
              在网页里填 <ExternalLink aria-hidden />
            </Button>
          </div>
          {error[ask.id] && <p className="mt-1 text-status-error">{error[ask.id]}</p>}
        </section>
      ))}
    </div>
  )
}
