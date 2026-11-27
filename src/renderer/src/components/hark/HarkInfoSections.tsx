import { desktopCopy, desktopNotice, useDesktopLocale } from '@/lib/desktopCopy'
import { HarkProjects } from './HarkProjects'
import { HarkScreenshot } from './HarkScreenshot'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, FileText, Globe, KeyRound, Monitor, ShieldAlert, Terminal } from 'lucide-react'
import { EmptyLine, Section } from '@/components/info/Section'
import { Button } from '@/components/ui/Button'
import { ConnectorIcon } from '@/components/ui/ConnectorIcon'
import { TextInput } from '@/components/ui/Field'
import { RefreshButton } from '@/components/muse/RefreshButton'
import { getBridge } from '@/lib/bridge'
import { harkRpc } from '@adapters/hark/harkRequests'
import { createId } from '@shared/id'
import { currentHarkBrowser, harkScreenshotReference } from '@shared/harkBrowserPreview'
import { asObj, str } from '@shared/parse'
import { cleanSidebarError } from '@/lib/sidebarCompat'
import { useBotStore } from '@/store/botStore'
import { t } from '@/lib/i18n'

async function callHark(
  accountId: string,
  path: string,
  opts: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
    query?: Record<string, string | undefined>
    body?: unknown
  } = {}
): Promise<unknown> {
  const hark = getBridge()?.hark
  if (!hark?.rpc) throw new Error('Hark IPC unavailable')
  const res = await hark.rpc({
    accountId,
    op: 'call',
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    path,
    query: opts.query,
    body: opts.body
  })
  if (!res.ok) throw new Error(res.message || `HTTP ${res.status}`)
  return res.data
}

function useHarkConnected(accountId: string): boolean {
  return useBotStore((s) => {
    const status = s.accounts[accountId]?.status
    return status === 'online' || status === 'busy'
  })
}

function useHarkInspectorLifetime() {
  const lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => controller.abort()
  }, [])
  return lifetime
}

function useHarkSnapshot(accountId: string, sessionId: string | undefined) {
  const lifetime = useHarkInspectorLifetime()
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  const snapshot = useCallback(async (signal: AbortSignal) => {
    const hark = getBridge()?.hark
    if (!hark?.rpc) return null
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const requestId = createId('hark_snapshot')
    const result = await harkRpc(hark, sessionId
      ? { accountId, op: 'conversationSnapshot', conversationId: sessionId, requestId }
      : { accountId, op: 'mainConversation', requestId }, AbortSignal.any([controller.signal, signal]))
    if (!result.ok) throw new Error(result.message)
    return result.data
  }, [accountId, sessionId])
  return { lifetime, snapshot }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/**
 * 1. Hark Billing & Token Meters (`/billing/summary`, `/profile`)
 */
export function HarkBillingSection({ accountId }: { accountId: string }) {
  useDesktopLocale()
  const connected = useHarkConnected(accountId)
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null)
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const [sumRaw, profRaw] = await Promise.all([
        callHark(accountId, '/billing/summary').catch(() => null),
        callHark(accountId, '/profile').catch(() => null)
      ])
      if (sumRaw && typeof sumRaw === 'object') setSummary(sumRaw as Record<string, unknown>)
      if (profRaw && typeof profRaw === 'object') setProfile(profRaw as Record<string, unknown>)
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    if (connected) void refresh()
  }, [refresh, connected])

  const plan = asObj(summary?.['plan'])
  const planName = str(plan?.['name'] ?? summary?.['tier'] ?? 'Hark Pro')
  const meters = asObj(summary?.['meters'])
  const harkTokens = asObj(meters?.['harkTokens'])
  const dailyUsed = Number(harkTokens?.['dailyUsed'] ?? 0)
  const dailyLimit = Number(harkTokens?.['dailyLimit'] ?? 0)
  const poolUsed = Number(harkTokens?.['poolUsed'] ?? 0)
  const poolLimit = Number(harkTokens?.['poolLimit'] ?? 0)
  const dailyPct = dailyLimit > 0 ? Math.min(100, Math.round((dailyUsed / dailyLimit) * 100)) : 0
  const poolPct = poolLimit > 0 ? Math.min(100, Math.round((poolUsed / poolLimit) * 100)) : 0

  return (
    <Section
      title={desktopCopy("套餐与额度", "Plan and quotas")}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2 text-[12px]">
        {error && <p className="text-status-error">{desktopNotice(error)}</p>}
        {!summary && !profile ? (
          <EmptyLine>{loading ? desktopCopy("正在加载用量…", "Loading Usage…") : desktopCopy("登录后展示套餐与额度", "Sign in to see your plan and quotas.")}</EmptyLine>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-medium text-ink">{planName}</span>
              {profile && (
                <span className="truncate text-[11.5px] text-ink-muted">
                  {str(profile['email'] || profile['name'])}
                </span>
              )}
            </div>

            {dailyLimit > 0 && (
              <div>
                <div className="flex justify-between text-[11.5px]">
                  <span className="text-ink-secondary">{desktopCopy("今日额度", "Today’s quota")}</span>
                  <span className="tabular-nums text-ink">
                    {fmtTokens(dailyUsed)} / {fmtTokens(dailyLimit)} ({dailyPct}%)
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
                  <div className="h-full rounded-full bg-ink/75" style={{ width: `${dailyPct}%` }} />
                </div>
              </div>
            )}

            {poolLimit > 0 && (
              <div>
                <div className="flex justify-between text-[11.5px]">
                  <span className="text-ink-secondary">{desktopCopy("周期额度", "Billing cycle quota")}</span>
                  <span className="tabular-nums text-ink">
                    {fmtTokens(poolUsed)} / {fmtTokens(poolLimit)} ({poolPct}%)
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
                  <div className="h-full rounded-full bg-accent-600" style={{ width: `${poolPct}%` }} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Section>
  )
}

/**
 * 2. Hark Home Cards & Proactive Actions (`/home/cards`, `/act`, `/dismiss`, `/refresh`)
 */
export function HarkHomeCardsSection({ accountId, botId }: { accountId: string; botId: string }) {
  useDesktopLocale()
  const connected = useHarkConnected(accountId)
  const sendMessage = useBotStore((s) => s.sendMessage)
  const [cards, setCards] = useState<
    Array<{
      id: string
      kind: string
      title: string
      subtitle?: string
      taskPrompt?: string
      provider?: string
    }>
  >([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const raw = await callHark(accountId, '/home/cards', {
        query: { widgetRuntimeVersion: '3.1.0' }
      })
      const o = asObj(raw) || {}
      const list = Array.isArray(o['cards']) ? o['cards'] : []
      const parsed: typeof cards = []
      for (const item of list) {
        const c = asObj(item)
        if (!c) continue
        const id = str(c['id'])
        const kind = str(c['kind'])
        const payload = asObj(c['payload']) || {}
        const action = str(payload['action'])
        const sentence = str(payload['sentence'])
        const title =
          action && sentence
            ? `${action} ${sentence}`
            : str(payload['title'] ?? payload['headline'] ?? c['dedupKey'] ?? kind)
        const subtitle = str(payload['reason'] ?? payload['description'] ?? '') || undefined
        const taskPrompt = str(payload['task'] ?? '') || (action && sentence ? `${action} ${sentence}` : undefined)
        const providers = Array.isArray(payload['providers']) ? payload['providers'] : []
        parsed.push({
          id,
          kind,
          title,
          subtitle,
          taskPrompt,
          provider: typeof providers[0] === 'string' ? providers[0] : undefined
        })
      }
      setCards(parsed)
    } catch {
      setCards([])
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    if (connected) void refresh()
  }, [refresh, connected])

  const dismissCard = async (id: string) => {
    setBusyId(id)
    try {
      await callHark(accountId, `/home/cards/${encodeURIComponent(id)}/dismiss`, {
        method: 'POST',
        body: { reason: 'rejected' }
      })
      await refresh()
    } finally {
      setBusyId(undefined)
    }
  }

  if (cards.length === 0 && !loading) return null

  return (
    <Section
      title={desktopCopy("智能建议", "Smart advice")}
      count={cards.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-1.5 text-[12px]">
        {cards.map((c) => (
          <div key={c.id} className="rounded-lg border border-line bg-surface p-2.5">
            <p className="font-medium text-ink">{c.title}</p>
            {c.subtitle && <p className="mt-0.5 text-[11px] text-ink-secondary">{c.subtitle}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {c.taskPrompt && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busyId === c.id}
                  onClick={() => void sendMessage(botId, c.taskPrompt!)}
                >{desktopCopy("执行", "Run")}</Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busyId === c.id}
                onClick={() => void dismissCard(c.id)}
              >{desktopCopy("忽略", "Ignore")}</Button>
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

/**
 * 3. Hark Conversations & Message Search
 * (`/conversations`, `/conversations/clear`, `/search/messages`)
 */
export function HarkConversationsSection({ accountId, botId }: { accountId: string; botId: string }) {
  useDesktopLocale()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Array<{ id: string; text: string }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const activeSessionId = useBotStore((s) => s.bots.find((b) => b.id === botId)?.activeSessionId)

  const runSearch = async () => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      return
    }
    setBusy(true)
    try {
      const raw = await callHark(accountId, '/search/messages', { query: { q } })
      const o = asObj(raw) || {}
      const list =
        (Array.isArray(o['messages']) && o['messages']) ||
        (Array.isArray(o['results']) && o['results']) ||
        (Array.isArray(o['items']) && o['items']) ||
        (Array.isArray(raw) ? raw : [])
      setHits(
        list
          .slice(0, 20)
          .map((m, idx) => {
            const r = asObj(m) || {}
            return {
              id: str(r['id'] ?? r['messageId'] ?? idx),
              text: str(r['content'] ?? r['text'] ?? r['snippet']).slice(0, 180)
            }
          })
          .filter((x) => x.text)
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={desktopCopy("项目", "Projects")}>
      <div className="flex flex-col gap-2 text-[12px]">
        <HarkProjects key={accountId} botId={botId} />
        {error && <p className="text-status-error">{desktopNotice(error)}</p>}

        <div className="flex gap-1.5 pt-1">
          <TextInput
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              if (!e.target.value.trim()) setHits(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch()
            }}
            placeholder={desktopCopy("搜索历史消息…", "Search for historical messages…")}
            aria-label="Search Hark messages"
            className="h-7 flex-1 text-[12px]"
          />
          {activeSessionId && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await callHark(accountId, '/conversations/clear', {
                    method: 'POST',
                    body: { conversationId: activeSessionId }
                  })
                  if (
                    useBotStore.getState().bots.find((b) => b.id === botId)?.activeSessionId ===
                    activeSessionId
                  ) {
                    useBotStore.setState((s) => ({ messages: { ...s.messages, [botId]: [] } }))
                  }
                } catch (e) {
                  setError(cleanSidebarError(e))
                } finally {
                  setBusy(false)
                }
              }}
              className="px-2 text-[11.5px]"
            >{desktopCopy("清空", "Clear")}</Button>
          )}
        </div>

        {hits && (
          <div className="rounded-lg border border-line bg-surface p-2">
            <p className="mb-1 text-[11px] font-medium text-ink-secondary">{desktopCopy("搜索结果 (", "Search results (")}{hits.length})</p>
            {hits.length === 0 ? (
              <p className="text-ink-muted">{desktopCopy("无匹配消息", "No matching messages")}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {hits.map((h) => (
                  <li key={h.id} className="truncate rounded bg-hover px-2 py-1 text-ink">
                    {h.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Section>
  )
}

/**
 * 4. Hark Scheduled Tasks
 * (`/scheduled-tasks`, `/scheduled-tasks/:id/pause`, `/resume`, `DELETE /scheduled-tasks/:id`)
 */
export function HarkScheduledTasksSection({ accountId }: { accountId: string }) {
  useDesktopLocale()
  const connected = useHarkConnected(accountId)
  const [tasks, setTasks] = useState<
    Array<{ id: string; title: string; schedule: string; paused: boolean }>
  >([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const raw = await callHark(accountId, '/scheduled-tasks')
      const o = asObj(raw) || {}
      const list =
        (Array.isArray(o['tasks']) && o['tasks']) ||
        (Array.isArray(o['scheduledTasks']) && o['scheduledTasks']) ||
        (Array.isArray(o['items']) && o['items']) ||
        (Array.isArray(raw) ? raw : [])
      setTasks(
        list
          .map((item) => {
            const r = asObj(item) || {}
            return {
              id: str(r['id'] ?? r['taskId']),
              title: str(r['title'] ?? r['name'] ?? r['prompt'] ?? 'Task'),
              schedule: str(r['schedule'] ?? r['cron'] ?? r['cadence'] ?? ''),
              paused: Boolean(r['paused'] ?? r['isPaused'] ?? r['status'] === 'paused')
            }
          })
          .filter((x) => x.id)
      )
    } catch {
      setTasks([])
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    if (connected) void refresh()
  }, [refresh, connected])

  const togglePause = async (id: string, paused: boolean) => {
    setBusyId(id)
    try {
      await callHark(
        accountId,
        `/scheduled-tasks/${encodeURIComponent(id)}/${paused ? 'resume' : 'pause'}`,
        { method: 'POST', body: {} }
      )
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(undefined)
    }
  }

  const removeTask = async (id: string) => {
    setBusyId(id)
    try {
      await callHark(accountId, `/scheduled-tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(undefined)
    }
  }

  return (
    <Section
      title={desktopCopy("定时任务", "Scheduled tasks")}
      count={tasks.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2 text-[12px]">
        {error && <p className="text-status-error">{desktopNotice(error)}</p>}
        {tasks.length === 0 ? (
          <EmptyLine>{desktopCopy("暂无定时任务", "No scheduled tasks")}</EmptyLine>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {tasks.map((task) => (
              <li key={task.id} className="rounded-lg border border-line bg-surface p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-ink">{task.title}</span>
                  <span className="rounded-full bg-hover px-2 py-0.5 text-[10px] text-ink-secondary">
                    {task.paused ? t('Paused') : t('Active')}
                  </span>
                </div>
                {task.schedule && <p className="mt-0.5 text-[11px] text-ink-muted">{task.schedule}</p>}
                <div className="mt-2 flex gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyId === task.id}
                    onClick={() => void togglePause(task.id, task.paused)}
                  >
                    {task.paused ? desktopCopy("恢复", "Restore") : desktopCopy("暂停", "Pause")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === task.id}
                    onClick={() => void removeTask(task.id)}
                  >
                    {t('Delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

/**
 * 5. Hark Connectors, Channel Bindings & Managed Credentials
 * (`/connectors`, `POST /connectors/link-sessions`, `/channel-bindings/list`, `/managed-credentials`)
 */
export function HarkConnectorsSection({ accountId }: { accountId: string }) {
  useDesktopLocale()
  const connected = useHarkConnected(accountId)
  const [connectors, setConnectors] = useState<
    Array<{
      id: string
      displayName: string
      capabilities: string[]
      configured: boolean
      connected: boolean
      iconUrl?: string
      setupUrl?: string
      accounts: Array<{ id: string; accountId: string; label?: string; email?: string }>
    }>
  >([])
  const [credentials, setCredentials] = useState<Array<{ domain: string; email?: string; label?: string }>>([])
  const [newDomain, setNewDomain] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [showAddCred, setShowAddCred] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string>()
  const [hint, setHint] = useState<string>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const [connRaw, credRaw] = await Promise.all([
        callHark(accountId, '/connectors').catch(() => null),
        callHark(accountId, '/managed-credentials').catch(() => null)
      ])
      const o = asObj(connRaw) || {}
      const list = Array.isArray(o['connectors']) ? o['connectors'] : []
      setConnectors(
        list.map((c, idx) => {
          const r = asObj(c) || {}
          const id = str(r['id'] ?? r['provider'] ?? idx)
          const caps = Array.isArray(r['capabilities']) ? r['capabilities'].map(str).filter(Boolean) : []
          const accsRaw = Array.isArray(r['accounts']) ? r['accounts'] : []
          const accs = accsRaw.map((a) => {
            const ao = asObj(a) || {}
            return {
              id: str(ao['id'] ?? ao['accountId']),
              accountId: str(ao['accountId'] ?? ao['id']),
              label: str(ao['label'] ?? ao['accountEmail']) || undefined,
              email: str(ao['accountEmail'] ?? ao['email']) || undefined
            }
          })
          const setupObj = asObj(r['setup'])
          return {
            id,
            displayName: str(r['displayName'] ?? r['name'] ?? id),
            capabilities: caps,
            configured: r['configured'] !== false,
            connected: Boolean(r['connected']) || accs.length > 0,
            iconUrl: str(r['iconUrl']) || undefined,
            setupUrl: str(setupObj?.['url']) || undefined,
            accounts: accs
          }
        })
      )

      const co = asObj(credRaw) || {}
      const logins = Array.isArray(co['logins']) ? co['logins'] : []
      setCredentials(
        logins
          .map((l) => {
            const lo = asObj(l) || {}
            return {
              domain: str(lo['domain']),
              email: str(lo['email']) || undefined,
              label: str(lo['label']) || undefined
            }
          })
          .filter((x) => x.domain)
      )
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    if (connected) void refresh()
  }, [refresh, connected])

  /**
   * Exact payload from `DB0LnIrM.js` (`Q.handleConnect`) + `AD8nd0FV.js` (`l`):
   * `POST /api/connectors/link-sessions` `{ provider: id, returnUrl: "https://app.hark.com/settings/connected-accounts", origin: "settings" }`
   * → returns `{ sessionId, startUrl }`.
   */
  const connectProvider = async (c: (typeof connectors)[number]) => {
    setBusyId(c.id)
    setError(undefined)
    setHint(undefined)
    try {
      const res = await callHark(accountId, '/connectors/link-sessions', {
        method: 'POST',
        body: {
          provider: c.id,
          returnUrl: 'https://app.hark.com/settings/connected-accounts',
          origin: 'settings'
        }
      })
      const o = asObj(res) || {}
      const startUrl = str(o['startUrl'] ?? o['url'] ?? o['authUrl'] ?? c.setupUrl)
      if (startUrl && /^https?:\/\//i.test(startUrl)) {
        await getBridge()?.muse?.openHttps?.(startUrl)
        setHint(desktopCopy("已在浏览器打开 {0} 授权页，授权完成后点击刷新", "Opened {0} authorization in your browser. Finish there, then refresh.", [(c.displayName)]))
      } else if (c.setupUrl) {
        await getBridge()?.muse?.openHttps?.(c.setupUrl)
        setHint(desktopCopy("已在浏览器打开 {0} 安装页", "Opened the {0} setup page in your browser.", [(c.displayName)]))
      }
      await refresh()
    } catch (err) {
      if (c.setupUrl) {
        await getBridge()?.muse?.openHttps?.(c.setupUrl)
        setHint(desktopCopy("已打开 {0} 安装页", "Opened the {0} setup page.", [(c.displayName)]))
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusyId(undefined)
    }
  }

  const disconnectProvider = async (provider: string, subAccountId?: string) => {
    if (!subAccountId) return
    setBusyId(provider)
    try {
      await callHark(
        accountId,
        `/connectors/${encodeURIComponent(provider)}/accounts/${encodeURIComponent(subAccountId)}`,
        { method: 'DELETE' }
      )
      setHint(desktopCopy("已断开连接器", "Disconnected connector"))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(undefined)
    }
  }

  const connectChannel = async (channel: 'slack' | 'telegram') => {
    setBusyId(`chan_${channel}`)
    setError(undefined)
    setHint(undefined)
    try {
      const path =
        channel === 'slack' ? '/channel-bindings/slack/link' : '/channel-bindings/telegram/start-link'
      const res = await callHark(accountId, path, { method: 'POST', body: {} })
      const o = asObj(res) || {}
      const url = str(o['url'] ?? o['startUrl'] ?? o['linkUrl'] ?? o['deepLink'])
      if (url && /^https?:\/\//i.test(url)) {
        await getBridge()?.muse?.openHttps?.(url)
        setHint(desktopCopy("已打开 {0} 绑定链接", "Opened the {0} link.", [(channel === 'slack' ? 'Slack' : 'Telegram')]))
      } else {
        setHint(JSON.stringify(res).slice(0, 120))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(undefined)
    }
  }

  const saveManagedCredential = async () => {
    if (!newDomain.trim() || !newEmail.trim() || !newPassword) return
    setBusyId('add_cred')
    setError(undefined)
    try {
      await callHark(accountId, '/managed-credentials', {
        method: 'POST',
        body: {
          domain: newDomain.trim(),
          ssoProvider: 'password',
          email: newEmail.trim(),
          password: newPassword
        }
      })
      setNewDomain('')
      setNewEmail('')
      setNewPassword('')
      setShowAddCred(false)
      setHint(desktopCopy("已保存站点托管凭据", "Saved site hosting credentials."))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(undefined)
    }
  }

  const removeManagedCredential = async (domain: string) => {
    setBusyId(`del_${domain}`)
    try {
      await callHark(accountId, '/managed-credential/disconnect', {
        method: 'POST',
        body: { domain }
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(undefined)
    }
  }

  const connectedCount = connectors.filter((c) => c.connected).length

  return (
    <Section
      title={desktopCopy("连接器与频道", "Connector & Channel")}
      count={connectedCount || undefined}
      flush={connectors.length > 0}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      {error && <p className="px-3 pt-2 text-[12px] text-status-error">{desktopNotice(error)}</p>}
      {hint && <p className="px-3 pt-2 text-[12px] text-ink-secondary">{desktopNotice(hint)}</p>}

      {connectors.length === 0 ? (
        <EmptyLine>{desktopCopy("暂无连接器", "No connectors yet")}</EmptyLine>
      ) : (
        <ul className="divide-y divide-line">
          {connectors.map((c) => {
            const firstAcc = c.accounts[0]
            return (
              <li key={c.id} className="flex items-center justify-between gap-2.5 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <ConnectorIcon id={c.id} name={c.displayName} iconUrl={c.iconUrl} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-ink">{c.displayName}</span>
                      {c.connected && (
                        <span className="rounded bg-status-online/12 px-1.5 text-[10px] leading-4 font-medium text-status-online-ink">{desktopCopy("已连接", "Connected")}</span>
                      )}
                    </div>
                    {firstAcc?.email && (
                      <p className="truncate text-[11px] text-ink-muted">{firstAcc.email}</p>
                    )}
                  </div>
                </div>
                {c.connected && firstAcc ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === c.id}
                    onClick={() => void disconnectProvider(c.id, firstAcc.accountId)}
                  >{desktopCopy("断开", "Disconnect")}</Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyId === c.id}
                    onClick={() => void connectProvider(c)}
                  >{desktopCopy("连接", "Connect")}</Button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* Channel Bindings (Slack / Telegram) + Managed Credentials */}
      <div className="border-t border-line bg-sunken/20 px-3 py-2 text-[12px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={busyId === 'chan_slack'}
            onClick={() => void connectChannel('slack')}
            className="inline-flex items-center gap-1.5"
          >
            <ConnectorIcon id="slack" name="Slack" className="size-4 border-0 bg-transparent shadow-none" />
            Slack
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busyId === 'chan_telegram'}
            onClick={() => void connectChannel('telegram')}
            className="inline-flex items-center gap-1.5"
          >
            <ConnectorIcon id="telegram" name="Telegram" className="size-4 border-0 bg-transparent shadow-none" />
            Telegram
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowAddCred((v) => !v)}>
            <KeyRound className="size-3.5" />{desktopCopy(" 站点凭据", " Site credentials")}</Button>
        </div>

        {showAddCred && (
          <div className="mt-2 flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2">
            <TextInput
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              placeholder={desktopCopy("网站域名 (如 github.com)", "Site domain name (e. g. github.com)")}
              aria-label="Website domain"
              className="h-7 text-[12px]"
            />
            <TextInput
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder={desktopCopy("登录邮箱或账号", "Email or username")}
              aria-label="Login email"
              className="h-7 text-[12px]"
            />
            <TextInput
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={desktopCopy("登录密码", "Password")}
              aria-label="Login password"
              className="h-7 text-[12px]"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={busyId === 'add_cred' || !newDomain.trim() || !newEmail.trim() || !newPassword}
              onClick={() => void saveManagedCredential()}
            >{desktopCopy("保存凭据", "Save credentials")}</Button>
          </div>
        )}

        {credentials.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1">
            {credentials.map((cred) => (
              <li
                key={cred.domain}
                className="flex items-center justify-between gap-2 rounded-lg bg-surface px-2.5 py-1.5 text-[11.5px]"
              >
                <span className="flex min-w-0 items-center gap-2 truncate text-ink">
                  <ConnectorIcon domain={cred.domain} name={cred.domain} className="size-5" />
                  <span className="truncate">
                    {cred.domain} {cred.email ? `· ${cred.email}` : ''}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void removeManagedCredential(cred.domain)}
                  className="shrink-0 text-status-error hover:underline"
                >{desktopCopy("移除", "Remove")}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

/**
 * 6. Hark Computer & Live Agent Activity Window (`windows`, `panels`, `asks`, `/images/presign`, `/messages/tool-response`, `/messages/stop-tool`)
 */
export function HarkComputerSection({ accountId, botId }: { accountId: string; botId: string }) {
  const sessionId = useBotStore((s) => s.bots.find((b) => b.id === botId)?.activeSessionId)
  const connected = useHarkConnected(accountId)
  return <HarkComputerInspector key={JSON.stringify([accountId, sessionId, connected])}
    accountId={accountId} sessionId={sessionId} connected={connected} />
}

function HarkComputerInspector({ accountId, sessionId, connected }: { accountId: string; sessionId?: string; connected: boolean }) {
  useDesktopLocale()
  const toggleWebSession = useBotStore((s) => s.toggleWebSession)
  const webSessionOpen = useBotStore((s) => s.webSessionOpen)

  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()
  const [hint, setHint] = useState<string>()
  const [conversationId, setConversationId] = useState<string>('')
  const [panels, setPanels] = useState<
    Array<{
      dispatchId: string
      kind: string
      status: string
      title?: string
      url?: string
      liveViewUrl?: string
      screenshotKey?: string
      screenshotUrl?: string
      command?: string
    }>
  >([])
  const [asks, setAsks] = useState<
    Array<{
      id: string
      dispatchId?: string
      requestId?: string
      displayHint?: string
      prompt?: string
      domain?: string
      status: string
    }>
  >([])
  const [askInput, setAskInput] = useState<Record<string, string>>({})
  const [snapshotGeneration, setSnapshotGeneration] = useState(0)
  const { lifetime, snapshot } = useHarkSnapshot(accountId, sessionId)
  const refreshGeneration = useRef(0)
  const actionGeneration = useRef(0)

  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted) return
    const generation = ++refreshGeneration.current
    const current = () => !signal.aborted && refreshGeneration.current === generation
    setLoading(true)
    setError(undefined)
    try {
      const data = await snapshot(signal)
      if (!current()) return
      const d = data as {
        conversationId?: string
        panels?: typeof panels
        asks?: typeof asks
      }
      setConversationId(d?.conversationId ?? '')
      const pList = Array.isArray(d?.panels) ? d.panels : []
      const nextAsks = Array.isArray(d?.asks) ? d.asks : []
      setPanels(pList)
      setAsks(nextAsks)
      setAskInput((prev) => Object.fromEntries(nextAsks.flatMap(({ id }) => id in prev ? [[id, prev[id]!]] : [])))
      setSnapshotGeneration(generation)
    } catch (err) {
      if (current()) setError(cleanSidebarError(err))
    } finally {
      if (current()) setLoading(false)
    }
  }, [snapshot, lifetime])

  useEffect(() => {
    if (connected) void refresh()
  }, [refresh, connected])

  const runToolAction = async (id: string, path: string, body: Record<string, unknown>, success: string) => {
    const signal = lifetime.current?.signal
    if (!conversationId || !signal || signal.aborted) return
    const generation = ++actionGeneration.current
    const current = () => !signal.aborted && actionGeneration.current === generation
    setBusyId(id)
    setError(undefined)
    try {
      await callHark(accountId, path, { body: { ...body, conversationId } })
      if (!current()) return
      setHint(success)
      await refresh()
    } catch (err) {
      if (current()) setError(cleanSidebarError(err))
    } finally {
      if (current()) setBusyId(undefined)
    }
  }

  const stopTool = (dispatchId: string) =>
    runToolAction(dispatchId, '/messages/stop-tool', { dispatchId }, desktopCopy("已停止该电脑/工具任务", "Stopped the computer/tool task"))

  const submitToolResponse = (ask: (typeof asks)[number], value: string) => {
    if (!ask.requestId) return
    return runToolAction(ask.id, '/messages/tool-response', {
      requestId: ask.requestId, type: 'user_input', dispatchId: ask.dispatchId, value
    }, desktopCopy("已提交工具确认响应", "Submitted your response."))
  }

  const activeBrowserPanel = currentHarkBrowser(panels)
  const screenshotGeneration = JSON.stringify([sessionId, conversationId, snapshotGeneration])

  return (
    <Section
      title={t('Computer')}
      count={panels.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2.5 text-[12px]">
        <div className="relative overflow-hidden rounded-xl border border-line bg-ink/[0.03] p-3">
          {activeBrowserPanel ? (
            <div className="flex flex-col gap-2">
              <HarkScreenshot accountId={accountId} generation={screenshotGeneration}
                screenshotKey={activeBrowserPanel.screenshotKey} screenshotUrl={activeBrowserPanel.screenshotUrl}
                alt="Hark computer screen" className="max-h-52 w-full rounded-lg border border-line bg-black object-contain" />
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[11.5px] text-ink-secondary">
                  {activeBrowserPanel.label}
                </span>
                <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-ink">
                  {activeBrowserPanel.status}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface text-ink-secondary shadow-soft">
                  <Monitor className="size-4" aria-hidden />
                </span>
                <div>
                  <p className="text-[12.5px] font-medium text-ink">{desktopCopy("云端浏览器与终端", "Cloud Browser and Terminal")}</p>
                  <p className="text-[11px] text-status-online-ink">{desktopCopy("就绪", "Ready")}</p>
                </div>
              </div>
              <Button size="sm" variant="secondary" onClick={toggleWebSession}>
                {webSessionOpen ? t('Back to conversation') : t('Show web session')}
              </Button>
            </div>
          )}
        </div>

        {error && <p className="text-status-error">{desktopNotice(error)}</p>}
        {hint && <p className="text-ink-secondary">{desktopNotice(hint)}</p>}

        {asks.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {asks.map((ask) => (
              <div key={ask.id} className="rounded-xl border border-status-attention/30 bg-status-attention/8 p-2.5">
                <div className="flex items-center gap-1.5 font-medium text-ink">
                  <ShieldAlert className="size-4 text-status-attention" />
                  <span>{ask.prompt || ask.displayHint || desktopCopy("Hark 请求你的确认", "Hark is asking for your confirmation")}</span>
                </div>
                {ask.domain && <p className="mt-0.5 font-mono text-[11px] text-ink-muted">{ask.domain}</p>}
                <div className="mt-2 flex gap-1.5">
                  <TextInput
                    value={askInput[ask.id] ?? ''}
                    onChange={(e) => setAskInput((prev) => ({ ...prev, [ask.id]: e.target.value }))}
                    placeholder={desktopCopy("输入回复或直接点击允许…", "Enter a response or click Allow…")}
                    aria-label="Tool response"
                    className="h-7 flex-1 text-[12px]"
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busyId === ask.id}
                    onClick={() => void submitToolResponse(ask, askInput[ask.id]?.trim() || 'approved')}
                  >{desktopCopy("允许", "Allow")}</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === ask.id}
                    onClick={() => void submitToolResponse(ask, 'denied')}
                  >{desktopCopy("拒绝", "Deny")}</Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {panels.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {panels.map((p) => {
              const reference = harkScreenshotReference(p.screenshotKey, p.screenshotUrl)
              return (
                <li key={p.dispatchId} className="rounded-lg border border-line bg-surface p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex min-w-0 items-center gap-1.5 truncate font-medium text-ink">
                      {p.kind.includes('shell') ? (
                        <Terminal className="size-3.5 shrink-0 text-accent-600" />
                      ) : (
                        <Globe className="size-3.5 shrink-0 text-accent-600" />
                      )}
                      <span className="truncate">{p.title || p.url || p.command || p.kind}</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-hover px-2 py-0.5 text-[10px] text-ink-secondary">
                      {p.status}
                    </span>
                  </div>
                  {p.command && (
                    <pre className="mt-1.5 overflow-x-auto rounded bg-sunken px-2 py-1 font-mono text-[11px] text-ink">
                      $ {p.command}
                    </pre>
                  )}
                  {(reference.screenshotKey || reference.screenshotUrl) && (
                    <HarkScreenshot
                      {...reference} accountId={accountId} generation={screenshotGeneration}
                      alt={p.kind}
                      className="mt-2 max-h-36 w-full rounded border border-line object-contain"
                    />
                  )}
                  {p.status === 'running' || p.status === 'active' ? (
                    <div className="mt-2 flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyId === p.dispatchId}
                        onClick={() => void stopTool(p.dispatchId)}
                      >{desktopCopy("停止任务", "Stop the task")}</Button>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Section>
  )
}

/**
 * 7. Hark Library / Artifacts & Files (`artifacts`, `/images/presign`, `/project/artifact`)
 */
export function HarkLibrarySection({ accountId, botId }: { accountId: string; botId: string }) {
  const sessionId = useBotStore((s) => s.bots.find((b) => b.id === botId)?.activeSessionId)
  const connected = useHarkConnected(accountId)
  return <HarkLibraryInspector key={JSON.stringify([accountId, sessionId, connected])}
    accountId={accountId} sessionId={sessionId} connected={connected} />
}

function HarkLibraryInspector({ accountId, sessionId, connected }: { accountId: string; sessionId?: string; connected: boolean }) {
  useDesktopLocale()
  const setActiveDocument = useBotStore((s) => s.setActiveDocument)
  const [artifacts, setArtifacts] = useState<
    Array<{
      name: string
      path: string
      s3Key?: string
      downloadUrl?: string
      mimeType?: string
      sizeBytes?: number
    }>
  >([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const { lifetime, snapshot } = useHarkSnapshot(accountId, sessionId)
  const refreshGeneration = useRef(0)
  const activeDownload = useRef<AbortController | null>(null)
  useEffect(() => () => activeDownload.current?.abort(), [])

  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted) return
    const generation = ++refreshGeneration.current
    const current = () => !signal.aborted && refreshGeneration.current === generation
    setLoading(true)
    setError(undefined)
    try {
      const data = await snapshot(signal)
      if (!current()) return
      const d = data as { artifacts?: typeof artifacts } | null
      setArtifacts(Array.isArray(d?.artifacts) ? d.artifacts : [])
    } catch (err) {
      if (current()) setError(cleanSidebarError(err))
    } finally {
      if (current()) setLoading(false)
    }
  }, [snapshot, lifetime])

  useEffect(() => {
    if (connected) void refresh()
  }, [refresh, connected])

  const previewArtifact = (a: (typeof artifacts)[number]) => {
    setActiveDocument({
      accountId,
      title: a.name || a.path.split('/').pop() || 'Artifact',
      path: a.downloadUrl || (a.s3Key ? `harkatt://${a.s3Key}` : a.path),
      mimeType: a.mimeType,
      platformId: 'hark'
    })
  }

  const openOrDownload = async (a: (typeof artifacts)[number]) => {
    const hark = getBridge()?.hark
    activeDownload.current?.abort()
    const request = new AbortController()
    activeDownload.current = request
    if (hark?.rpc) {
      try {
        const res = await harkRpc(hark, {
          accountId,
          op: 'downloadArtifact',
          requestId: createId('hark_artifact'),
          url: a.downloadUrl && /^https?:\/\//i.test(a.downloadUrl) ? a.downloadUrl : undefined,
          fileId: a.s3Key || (!a.downloadUrl ? a.path : undefined),
          name: a.name
        }, request.signal)
        if (request.signal.aborted) return
        if (res.ok && res.data && typeof res.data === 'object') {
          const d = res.data as { dataBase64: string; mimeType: string; filename?: string }
          if (d.dataBase64) {
            const bin = atob(d.dataBase64)
            const bytes = new Uint8Array(new ArrayBuffer(bin.length))
            for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
            const blob = new Blob([bytes], { type: d.mimeType || a.mimeType || 'application/octet-stream' })
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = d.filename || a.name || 'artifact'
            link.click()
            setTimeout(() => URL.revokeObjectURL(url), 2000)
            return
          }
        }
      } catch (err) {
        if (request.signal.aborted) return
        setError(cleanSidebarError(err))
      }
    }
    if (a.downloadUrl && /^https?:\/\//i.test(a.downloadUrl)) {
      await getBridge()?.muse?.openHttps?.(a.downloadUrl)
    }
  }

  return (
    <Section
      title={t('Documents and Files')}
      count={artifacts.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-1.5 text-[12px]">
        {error && <p className="text-status-error">{desktopNotice(error)}</p>}
        {artifacts.length === 0 ? (
          <EmptyLine>{t('Files the bot creates show up here')}</EmptyLine>
        ) : (
          <ul className="divide-y divide-line">
            {artifacts.map((a) => (
              <li key={a.s3Key || a.path} className="flex items-center justify-between gap-2 py-2">
                <button
                  type="button"
                  onClick={() => previewArtifact(a)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-85"
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-hover text-ink-secondary">
                    <FileText className="size-4" />
                  </span>
                  <p className="truncate font-medium text-ink">{a.name}</p>
                </button>
                {(a.downloadUrl || a.s3Key) && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => previewArtifact(a)}>{desktopCopy("预览", "Preview")}</Button>
                    <Button size="sm" variant="secondary" onClick={() => void openOrDownload(a)}>
                      <Download className="size-3.5" />{desktopCopy(" 下载", " Download")}</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

/**
 * 8. Hark Invite & Device Sessions (`/invite`, `/invite/claim`, `/sessions`)
 */
export function HarkInviteAndSessionsSection({ accountId }: { accountId: string }) {
  useDesktopLocale()
  const connected = useHarkConnected(accountId)
  const [inviteInfo, setInviteInfo] = useState<Record<string, unknown> | null>(null)
  const [claimCode, setClaimCode] = useState('')
  const [sessions, setSessions] = useState<
    Array<{ id: string; label: string; location?: string; isCurrent?: boolean }>
  >([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const [invRaw, sesRaw] = await Promise.all([
        callHark(accountId, '/invite').catch(() => null),
        callHark(accountId, '/sessions').catch(() => null)
      ])
      if (invRaw && typeof invRaw === 'object') setInviteInfo(invRaw as Record<string, unknown>)
      const sObj = asObj(sesRaw) || {}
      const sList =
        (Array.isArray(sObj['sessions']) && sObj['sessions']) ||
        (Array.isArray(sesRaw) ? sesRaw : [])
      setSessions(
        sList.slice(0, 15).map((s, idx) => {
          const r = asObj(s) || {}
          const loc = [str(r['city']), str(r['country']), str(r['ipAddress'])].filter(Boolean).join(' · ')
          return {
            id: str(r['id'] ?? idx),
            label: str(r['deviceLabel'] ?? r['userAgent'] ?? r['device'] ?? r['id'] ?? `Session ${idx + 1}`),
            location: loc || undefined,
            isCurrent: Boolean(r['isCurrent'])
          }
        })
      )
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    if (connected) void refresh()
  }, [refresh, connected])

  const claim = async () => {
    if (!claimCode.trim()) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      await callHark(accountId, '/invite/claim', {
        method: 'POST',
        body: { code: claimCode.trim() }
      })
      setClaimCode('')
      setHint(desktopCopy("邀请码兑换成功", "Invitation code redeemed."))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const revokeSession = async (id: string) => {
    setBusy(true)
    try {
      await callHark(accountId, `/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const code = str(inviteInfo?.['code'] ?? inviteInfo?.['inviteCode'])

  return (
    <Section
      title={desktopCopy("邀请与登录设备", "Invitation and Login Devices")}
      count={sessions.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2 text-[12px]">
        {error && <p className="text-status-error">{desktopNotice(error)}</p>}
        {hint && <p className="text-ink-secondary">{desktopNotice(hint)}</p>}

        {code && (
          <div className="flex items-center justify-between rounded-lg bg-hover/60 px-2.5 py-1.5">
            <span className="font-mono text-ink">{code}</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void navigator.clipboard.writeText(code)}
            >
              {t('Copy')}
            </Button>
          </div>
        )}

        <div className="flex gap-1.5">
          <TextInput
            value={claimCode}
            onChange={(e) => setClaimCode(e.target.value)}
            placeholder={desktopCopy("输入邀请码…", "Enter invitation code…")}
            aria-label="Hark invite code"
            className="h-7 flex-1 text-[12px]"
          />
          <Button size="sm" variant="primary" disabled={busy || !claimCode.trim()} onClick={() => void claim()}>{desktopCopy("兑换", "Redeem")}</Button>
        </div>

        {sessions.length > 0 && (
          <ul className="flex flex-col gap-1 border-t border-line pt-2">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-hover/60"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">
                    {s.label} {s.isCurrent ? desktopCopy("· 当前设备", "· This device") : ''}
                  </p>
                  {s.location && <p className="truncate text-[11px] text-ink-muted">{s.location}</p>}
                </div>
                {!s.isCurrent && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revokeSession(s.id)}>{desktopCopy("移除", "Remove")}</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}
