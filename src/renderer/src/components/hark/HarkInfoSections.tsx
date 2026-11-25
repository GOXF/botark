import { HarkProjects } from './HarkProjects'
import { HarkScreenshot } from './HarkScreenshot'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, FileText, Globe, KeyRound, Monitor, ShieldAlert, Terminal } from 'lucide-react'
import { EmptyLine, Section } from '@/components/info/Section'
import { Button } from '@/components/ui/Button'
import { ConnectorIcon } from '@/components/ui/ConnectorIcon'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { TextInput } from '@/components/ui/Field'
import { RefreshButton } from '@/components/muse/RefreshButton'
import { getBridge } from '@/lib/bridge'
import { harkRpc } from '@adapters/hark/harkRequests'
import { createId } from '@shared/id'
import { currentHarkBrowser, harkScreenshotReference } from '@shared/harkBrowserPreview'
import { cleanSidebarError } from '@/lib/sidebarCompat'
import { useBotStore } from '@/store/botStore'
import { t } from '@/lib/i18n'
import { inviteProgress, parseHarkInvite } from '@/lib/harkInvite'

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

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

type QuotaMode = 'used' | 'left'
const QUOTA_MODE_KEY = 'botark.hark.quotaMode'
const QUOTA_REFRESH_MS = 5 * 60_000

/** First parseable time among `keys` on any of `objs` (ISO string, seconds or ms). Field names are guessed: none → no line. */
function pickTime(objs: Array<Record<string, unknown> | null>, keys: string[]): Date | null {
  for (const o of objs) {
    if (!o) continue
    for (const k of keys) {
      const v = o[k]
      if (v == null || v === '') continue
      const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v))
      if (!Number.isNaN(d.getTime())) return d
    }
  }
  return null
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 「明天 14:06 重置」 / 「12月23日 14:02 重置」 */
function fmtResetAt(d: Date, now: Date): string {
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(d) - day(now)) / 86_400_000)
  const label = diff === 0 ? '今天' : diff === 1 ? '明天' : `${d.getMonth() + 1}月${d.getDate()}日`
  return `${label} ${hm} 重置`
}

/** 「约 22 小时后恢复」 / 「还剩 30 天」 / 「约 15 分钟后恢复」 */
function fmtCountdown(d: Date, now: Date): string {
  const ms = d.getTime() - now.getTime()
  if (ms <= 0) return '即将恢复'
  const h = ms / 3_600_000
  if (h >= 48) return `还剩 ${Math.round(h / 24)} 天`
  if (h >= 1) return `约 ${Math.round(h)} 小时后恢复`
  return `约 ${Math.max(1, Math.round(ms / 60_000))} 分钟后恢复`
}

function leftColor(pct: number): string {
  return pct > 50 ? 'bg-status-online' : pct >= 20 ? 'bg-status-attention' : 'bg-status-error'
}

function QuotaMeter(props: {
  label: string
  used: number
  limit: number
  mode: QuotaMode
  resetAt: Date | null
  now: Date
}) {
  const { used, limit, mode, resetAt, now } = props
  const usedPct = Math.min(100, Math.round((used / limit) * 100))
  const shown = mode === 'used' ? used : Math.max(0, limit - used)
  const pct = mode === 'used' ? usedPct : 100 - usedPct
  return (
    <div>
      <div className="flex justify-between text-[11.5px]">
        <span className="text-ink-secondary">
          {props.label}
          {mode === 'used' ? '已用' : '剩余'}
        </span>
        <span className="tabular-nums text-ink">
          {fmtTokens(shown)} / {fmtTokens(limit)} ({pct}%)
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
        <div
          className={`h-full rounded-full ${leftColor(100 - usedPct)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {resetAt && (
        <div className="mt-1 flex justify-between text-[11px] text-ink-muted tabular-nums">
          <span>{fmtResetAt(resetAt, now)}</span>
          <span>{fmtCountdown(resetAt, now)}</span>
        </div>
      )}
    </div>
  )
}

/**
 * 1. Hark Billing & Token Meters (`/billing/summary`, `/profile`)
 */
export function HarkBillingSection({ accountId }: { accountId: string }) {
  const connected = useHarkConnected(accountId)
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null)
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [mode, setModeState] = useState<QuotaMode>(() =>
    localStorage.getItem(QUOTA_MODE_KEY) === 'left' ? 'left' : 'used'
  )
  const setMode = (m: QuotaMode): void => {
    localStorage.setItem(QUOTA_MODE_KEY, m)
    setModeState(m)
  }
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [now, setNow] = useState(() => new Date())

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const [sumRaw, profRaw] = await Promise.all([
        callHark(accountId, '/billing/summary').catch(() => null),
        callHark(accountId, '/profile').catch(() => null)
      ])
      if (sumRaw && typeof sumRaw === 'object') {
        setSummary(sumRaw as Record<string, unknown>)
        setUpdatedAt(new Date())
      }
      if (profRaw && typeof profRaw === 'object') setProfile(profRaw as Record<string, unknown>)
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
      setNow(new Date())
    }
  }, [accountId])

  useEffect(() => {
    if (!connected) return
    void refresh()
    const timer = setInterval(() => void refresh(), QUOTA_REFRESH_MS)
    // Countdown text only; cheap, no network.
    const tick = setInterval(() => setNow(new Date()), 60_000)
    return () => {
      clearInterval(timer)
      clearInterval(tick)
    }
  }, [refresh, connected])

  const plan = asObj(summary?.['plan'])
  const planName = str(plan?.['name'] ?? summary?.['tier'] ?? 'Hark Pro')
  const meters = asObj(summary?.['meters'])
  const harkTokens = asObj(meters?.['harkTokens'])
  const dailyUsed = Number(harkTokens?.['dailyUsed'] ?? 0)
  const dailyLimit = Number(harkTokens?.['dailyLimit'] ?? 0)
  const poolUsed = Number(harkTokens?.['poolUsed'] ?? 0)
  const poolLimit = Number(harkTokens?.['poolLimit'] ?? 0)
  const tokens = asObj(summary?.['tokens'])
  const exhausted =
    str(summary?.['state']) === 'exhausted' ||
    (poolLimit > 0 && poolUsed >= poolLimit) ||
    (dailyLimit > 0 && dailyUsed >= dailyLimit)
  const planEnds = str(plan?.['source']) === 'gift' ? pickTime([plan], ['endsAt']) : null
  const nextPlan = str(asObj(plan?.['next'])?.['planId'])
  const dailyReset = pickTime(
    [harkTokens, meters, summary, asObj(tokens?.['daily']), asObj(harkTokens?.['daily'])],
    ['dailyResetsAt', 'dailyResetAt', 'daily_resets_at', 'dailyReset', 'dailyWindowEnd', 'resets_at', 'resetsAt']
  )
  const poolReset = pickTime(
    [harkTokens, meters, summary, asObj(tokens?.['pool']), asObj(harkTokens?.['pool']), plan],
    ['poolResetsAt', 'poolResetAt', 'pool_resets_at', 'periodEnd', 'currentPeriodEnd', 'current_period_end', 'renewsAt', 'resets_at', 'resetsAt']
  )

  return (
    <Section
      title="套餐与额度"
      action={
        <>
          <SegmentedControl<QuotaMode>
            size="xs"
            aria-label="额度显示"
            className="mr-1"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: 'used', label: '已用' },
              { value: 'left', label: '剩余' }
            ]}
          />
          <RefreshButton loading={loading} onClick={() => void refresh()} />
        </>
      }
    >
      <div className="flex flex-col gap-2 text-[12px]">
        {error && <p className="text-status-error">{error}</p>}
        {!summary && !profile ? (
          <EmptyLine>{loading ? '正在加载用量…' : '登录后展示套餐与额度'}</EmptyLine>
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

            {(exhausted || planEnds) && (
              <div className="flex flex-col items-start gap-1">
                {exhausted && (
                  <span className="rounded-full bg-status-error/10 px-2 py-0.5 text-[11px] text-status-error-ink">
                    额度已用完
                  </span>
                )}
                {planEnds && (
                  <span className="text-[11px] text-ink-muted tabular-nums">
                    赠送至 {fmtResetAt(planEnds, now).replace(/\s*重置$/, '')}
                    {nextPlan === 'free' ? '，之后转免费版' : nextPlan ? `，之后转 ${nextPlan}` : ''}
                  </span>
                )}
              </div>
            )}

            {dailyLimit > 0 && (
              <QuotaMeter
                label="今日"
                used={dailyUsed}
                limit={dailyLimit}
                mode={mode}
                resetAt={dailyReset}
                now={now}
              />
            )}

            {poolLimit > 0 && (
              <QuotaMeter
                label="周期"
                used={poolUsed}
                limit={poolLimit}
                mode={mode}
                resetAt={poolReset}
                now={now}
              />
            )}

            {updatedAt && (
              <p className="border-t border-line pt-1.5 text-[11px] text-ink-muted">
                {pad2(updatedAt.getHours())}:{pad2(updatedAt.getMinutes())} 更新 · 每 5 分钟自动刷新
              </p>
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
      title="智能建议"
      defaultOpen={false}
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
                >
                  执行
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busyId === c.id}
                onClick={() => void dismissCard(c.id)}
              >
                忽略
              </Button>
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
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Array<{ id: string; text: string }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [projectsLoading, setProjectsLoading] = useState(false)
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
    <Section
      title="项目"
      action={
        <RefreshButton
          loading={projectsLoading}
          onClick={() => window.dispatchEvent(new CustomEvent('bothub:hark-projects', { detail: { accountId } }))}
        />
      }
    >
      <div className="flex flex-col gap-2 text-[12px]">
        <HarkProjects key={accountId} botId={botId} onLoadingChange={setProjectsLoading} />
        {error && <p className="text-status-error">{error}</p>}

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
            placeholder="搜索历史消息…"
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
            >
              清空
            </Button>
          )}
        </div>

        {hits && (
          <div className="rounded-lg border border-line bg-surface p-2">
            <p className="mb-1 text-[11px] font-medium text-ink-secondary">搜索结果 ({hits.length})</p>
            {hits.length === 0 ? (
              <p className="text-ink-muted">无匹配消息</p>
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
      title="定时任务"
      count={tasks.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2 text-[12px]">
        {error && <p className="text-status-error">{error}</p>}
        {tasks.length === 0 ? (
          <EmptyLine>暂无定时任务</EmptyLine>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {tasks.map((task) => (
              <li key={task.id} className="rounded-lg border border-line bg-surface p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium text-ink">{task.title}</span>
                  <span className="shrink-0 whitespace-nowrap rounded-full bg-hover px-2 py-0.5 text-[10px] text-ink-secondary">
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
                    {task.paused ? '恢复' : '暂停'}
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
        setHint(`已在浏览器打开 ${c.displayName} 授权页，授权完成后点击刷新`)
      } else if (c.setupUrl) {
        await getBridge()?.muse?.openHttps?.(c.setupUrl)
        setHint(`已在浏览器打开 ${c.displayName} 安装页`)
      }
      await refresh()
    } catch (err) {
      if (c.setupUrl) {
        await getBridge()?.muse?.openHttps?.(c.setupUrl)
        setHint(`已打开 ${c.displayName} 安装页`)
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
      setHint('已断开连接器')
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
        setHint(`已打开 ${channel === 'slack' ? 'Slack' : 'Telegram'} 绑定链接`)
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
      setHint('已保存站点托管凭据')
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
      title="连接器与频道"
      count={connectedCount || undefined}
      flush={connectors.length > 0}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      {error && <p className="px-3 pt-2 text-[12px] text-status-error">{error}</p>}
      {hint && <p className="px-3 pt-2 text-[12px] text-ink-secondary">{hint}</p>}

      {connectors.length === 0 ? (
        <EmptyLine>暂无连接器</EmptyLine>
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
                        <span className="rounded bg-status-online/12 px-1.5 text-[10px] leading-4 font-medium text-status-online-ink">
                          已连接
                        </span>
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
                  >
                    断开
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyId === c.id}
                    onClick={() => void connectProvider(c)}
                  >
                    连接
                  </Button>
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
            <KeyRound className="size-3.5" /> 站点凭据
          </Button>
        </div>

        {showAddCred && (
          <div className="mt-2 flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2">
            <TextInput
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              placeholder="网站域名 (如 github.com)"
              aria-label="Website domain"
              className="h-7 text-[12px]"
            />
            <TextInput
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="登录邮箱或账号"
              aria-label="Login email"
              className="h-7 text-[12px]"
            />
            <TextInput
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="登录密码"
              aria-label="Login password"
              className="h-7 text-[12px]"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={busyId === 'add_cred' || !newDomain.trim() || !newEmail.trim() || !newPassword}
              onClick={() => void saveManagedCredential()}
            >
              保存凭据
            </Button>
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
                >
                  移除
                </button>
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
    runToolAction(dispatchId, '/messages/stop-tool', { dispatchId }, '已停止该电脑/工具任务')

  const submitToolResponse = (ask: (typeof asks)[number], value: string) => {
    if (!ask.requestId) return
    return runToolAction(ask.id, '/messages/tool-response', {
      requestId: ask.requestId, type: 'user_input', dispatchId: ask.dispatchId, value
    }, '已提交工具确认响应')
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
                  <p className="text-[12.5px] font-medium text-ink">云端浏览器与终端</p>
                  <p className="text-[11px] text-status-online-ink">就绪</p>
                </div>
              </div>
              <Button size="sm" variant="secondary" onClick={toggleWebSession}>
                {webSessionOpen ? t('Back to conversation') : t('Show web session')}
              </Button>
            </div>
          )}
        </div>

        {error && <p className="text-status-error">{error}</p>}
        {hint && <p className="text-ink-secondary">{hint}</p>}

        {asks.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {asks.map((ask) => (
              <div key={ask.id} className="rounded-xl border border-status-attention/30 bg-status-attention/8 p-2.5">
                <div className="flex items-center gap-1.5 font-medium text-ink">
                  <ShieldAlert className="size-4 text-status-attention" />
                  <span>{ask.prompt || ask.displayHint || 'Hark 请求你的确认'}</span>
                </div>
                {ask.domain && <p className="mt-0.5 font-mono text-[11px] text-ink-muted">{ask.domain}</p>}
                <div className="mt-2 flex gap-1.5">
                  <TextInput
                    value={askInput[ask.id] ?? ''}
                    onChange={(e) => setAskInput((prev) => ({ ...prev, [ask.id]: e.target.value }))}
                    placeholder="输入回复或直接点击允许…"
                    aria-label="Tool response"
                    className="h-7 flex-1 text-[12px]"
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busyId === ask.id}
                    onClick={() => void submitToolResponse(ask, askInput[ask.id]?.trim() || 'approved')}
                  >
                    允许
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === ask.id}
                    onClick={() => void submitToolResponse(ask, 'denied')}
                  >
                    拒绝
                  </Button>
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
                      >
                        停止任务
                      </Button>
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
        {error && <p className="text-status-error">{error}</p>}
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
                    <Button size="sm" variant="ghost" onClick={() => previewArtifact(a)}>
                      预览
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void openOrDownload(a)}>
                      <Download className="size-3.5" /> 下载
                    </Button>
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
      setHint('邀请码兑换成功')
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

  const invite = parseHarkInvite(inviteInfo)
  const code = invite?.code ?? ''
  const progress = invite ? inviteProgress(invite) : null
  const endsAt = invite?.rewardEnds ? new Date(invite.rewardEnds) : null
  const rewardEnds = endsAt && !isNaN(endsAt.getTime()) ? endsAt.toLocaleDateString('sv-SE') : ''

  return (
    <Section
      title="邀请与登录设备"
      count={sessions.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2 text-[12px]">
        {error && <p className="text-status-error">{error}</p>}
        {hint && <p className="text-ink-secondary">{hint}</p>}

        {code && (
          <div className="flex flex-col gap-2 rounded-lg bg-hover/60 px-2.5 py-1.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-ink">{code}</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void navigator.clipboard.writeText(code)}
              >
                {t('Copy')}
              </Button>
            </div>
            {progress && (
              <div className="flex flex-col gap-1.5">
                <span className="text-ink-secondary">
                  已计入 {progress.filled} / {progress.total} 位朋友
                </span>
                <div className="flex gap-1">
                  {Array.from({ length: progress.total }, (_, i) => (
                    <span
                      key={i}
                      className={`h-1 flex-1 rounded-full ${i < progress.filled ? 'bg-status-online' : 'bg-line-strong'}`}
                    />
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-ink">{invite!.link.replace(/^https:\/\//, '')}</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void navigator.clipboard.writeText(invite!.link)}
              >
                复制链接
              </Button>
            </div>
            {rewardEnds && <span className="text-[11px] text-ink-muted">奖励有效至 {rewardEnds}</span>}
          </div>
        )}

        <div className="flex gap-1.5">
          <TextInput
            value={claimCode}
            onChange={(e) => setClaimCode(e.target.value)}
            placeholder="输入邀请码…"
            aria-label="Hark invite code"
            className="h-7 flex-1 text-[12px]"
          />
          <Button size="sm" variant="primary" disabled={busy || !claimCode.trim()} onClick={() => void claim()}>
            兑换
          </Button>
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
                    {s.label} {s.isCurrent ? '· 当前设备' : ''}
                  </p>
                  {s.location && <p className="truncate text-[11px] text-ink-muted">{s.location}</p>}
                </div>
                {!s.isCurrent && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revokeSession(s.id)}>
                    移除
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}
