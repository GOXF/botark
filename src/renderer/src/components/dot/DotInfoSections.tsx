import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Download, Eye, FileText, KeyRound, Lock, LogIn, Pause, Play, Plus, Sparkles, Target, Trash2 } from 'lucide-react'
import { asObj, str } from '@shared/parse'
import { EmptyLine, Section } from '@/components/info/Section'
import { Button } from '@/components/ui/Button'
import { SwitchPill } from '@/components/ui/Controls'
import { TextInput } from '@/components/ui/Field'
import { Select } from '@/components/ui/Select'
import { RefreshButton } from '@/components/muse/RefreshButton'
import { NativeDocumentDialog, type NativeDocumentTarget } from '@/components/chat/NativeDocumentDialog'
import { getBridge } from '@/lib/bridge'
import { cleanSidebarError } from '@/lib/sidebarCompat'
import { loadDotMemoryDraft, saveDotMemoryDraft } from '@/lib/vaultClient'
import { useBotStore } from '@/store/botStore'
import { t } from '@/lib/i18n'
import type { ChatMessage } from '@/types'

function useDotConnected(accountId: string): boolean {
  return useBotStore((s) => {
    const status = s.accounts[accountId]?.status
    return status === 'online' || status === 'busy' || status === 'attention'
  })
}

/**
 * 1. Dot Credentials (ChatGPT browser login or AT / RT / JSON import) & Rate Limits (`account/rateLimits/read`)
 */
export function DotCredentialsAndQuotaSection({
  accountId,
  botId
}: {
  accountId: string
  botId: string
}) {
  const connected = useDotConnected(accountId)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const renameAccount = useBotStore((s) => s.renameAccount)
  const openDotLogin = useBotStore((s) => s.openDotLogin)

  const [authInfo, setAuthInfo] = useState<{
    signedIn: boolean
    handle?: string
    displayName?: string
    planType?: string
    chatgptAccountId?: string
    mode?: 'dot' | 'native'
    model?: string
    effort?: string
  } | null>(null)

  const [rateLimits, setRateLimits] = useState<{
    planType?: string
    primaryUsedPct?: number
    primaryResetsAt?: number
    secondaryUsedPct?: number
    secondaryResetsAt?: number
  } | null>(null)

  const [showTokenBox, setShowTokenBox] = useState(false)
  const [rawTokenInput, setRawTokenInput] = useState('')
  const [refreshTokenInput, setRefreshTokenInput] = useState('')
  const [autoMigrateMemory, setAutoMigrateMemory] = useState(true)

  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string>()
  const [error, setError] = useState<string>()
  const credentialsRefresh = useRef(0)
  useLayoutEffect(() => () => { credentialsRefresh.current++ }, [accountId, connected])

  const refresh = useCallback(async () => {
    const dot = getBridge()?.dot
    if (!dot) return
    const request = ++credentialsRefresh.current
    setLoading(true)
    setError(undefined)
    try {
      const st = await dot.authStatus(accountId)
      if (request !== credentialsRefresh.current) return
      setAuthInfo(st)
      if (!st.signedIn) setRateLimits(null)
      if (st.signedIn) {
        const rlRes = await dot.rpc({ accountId, op: 'rateLimits' }).catch(() => null)
        if (request !== credentialsRefresh.current) return
        if (rlRes && rlRes.ok && rlRes.data && typeof rlRes.data === 'object') {
          const root = asObj(rlRes.data) || {}
          const rl = asObj(root['rateLimits']) || root
          const primary = asObj(rl['primary'])
          const secondary = asObj(rl['secondary'])
          setRateLimits({
            planType: str(rl['planType'] || st.planType || 'pro'),
            primaryUsedPct:
              typeof primary?.['usedPercent'] === 'number' ? primary['usedPercent'] : undefined,
            primaryResetsAt:
              typeof primary?.['resetsAt'] === 'number' ? primary['resetsAt'] : undefined,
            secondaryUsedPct:
              typeof secondary?.['usedPercent'] === 'number' ? secondary['usedPercent'] : undefined,
            secondaryResetsAt:
              typeof secondary?.['resetsAt'] === 'number' ? secondary['resetsAt'] : undefined
          })
        }
      }
    } catch (err) {
      if (request === credentialsRefresh.current) setError(cleanSidebarError(err))
    } finally {
      if (request === credentialsRefresh.current) setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh, connected])

  const handleImportRaw = async () => {
    const dot = getBridge()?.dot
    if (!dot?.importCredentials || (!rawTokenInput.trim() && !refreshTokenInput.trim())) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      let priorSnapshot = ''
      let priorGoal: string | undefined
      if (autoMigrateMemory && authInfo?.signedIn && dot.rpc) {
        const expRes = await dot.rpc({ accountId, op: 'exportMemory', mode: 'fast' }).catch(() => null)
        if (expRes && expRes.ok && expRes.data && typeof expRes.data === 'object') {
          const d = expRes.data as { markdown?: string; goal?: string }
          if (d.markdown) {
            priorSnapshot = d.markdown
            priorGoal = d.goal
            await saveDotMemoryDraft(d.markdown)
          }
        }
      }

      const st = await dot.importCredentials({
        accountId,
        rawInput: rawTokenInput.trim(),
        refreshToken: refreshTokenInput.trim() || undefined
      })
      if (st.displayName || st.handle) {
        renameAccount(accountId, st.displayName || st.handle || 'Dot')
      }
      setRawTokenInput('')
      setRefreshTokenInput('')
      setShowTokenBox(false)
      await connectAccount(accountId)
      if (priorSnapshot && dot.rpc) {
        setHint(`已导入凭据 ${st.handle ?? ''}，正在自动迁移原 Dot 记忆…`)
        await dot
          .rpc({
            accountId,
            op: 'importMemory',
            markdown: priorSnapshot,
            goal: priorGoal,
            botId
          })
          .catch(() => null)
        setHint(`已导入 Dot 凭据 ${st.handle ?? ''} 并完成记忆迁移`)
      } else {
        setHint(`已导入 Dot 凭据：${st.handle ?? accountId}`)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="账号与配额"
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2.5 text-[12px]">
        {error && <p className="text-status-error">{error}</p>}
        {hint && <p className="text-status-online-ink">{hint}</p>}

        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-medium text-ink">
            {authInfo?.signedIn
              ? `${authInfo.handle || authInfo.displayName || 'Dot'}`
              : '未登录'}
          </span>
          {authInfo?.planType && (
            <span className="rounded-full bg-accent-600/12 px-2 py-0.5 text-[10.5px] font-medium uppercase text-accent-600">
              {authInfo.planType}
            </span>
          )}
        </div>

        {rateLimits && (
          <div className="flex flex-col gap-2">
            {typeof rateLimits.primaryUsedPct === 'number' && (
              <div>
                <div className="flex justify-between text-[11.5px]">
                  <span className="text-ink-secondary">5 小时额度</span>
                  <span className="tabular-nums text-ink">{rateLimits.primaryUsedPct}%</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
                  <div
                    className="h-full rounded-full bg-ink/75"
                    style={{ width: `${Math.min(100, rateLimits.primaryUsedPct)}%` }}
                  />
                </div>
              </div>
            )}
            {typeof rateLimits.secondaryUsedPct === 'number' && (
              <div>
                <div className="flex justify-between text-[11.5px]">
                  <span className="text-ink-secondary">周度额度</span>
                  <span className="tabular-nums text-ink">{rateLimits.secondaryUsedPct}%</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
                  <div
                    className="h-full rounded-full bg-accent-600"
                    style={{ width: `${Math.min(100, rateLimits.secondaryUsedPct)}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => void openDotLogin(accountId)}
          >
            <LogIn className="size-3.5" /> 网页登录
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => setShowTokenBox((v) => !v)}
          >
            <KeyRound className="size-3.5" /> 导入凭据
          </Button>
        </div>

        {showTokenBox && (
          <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
            <textarea
              value={rawTokenInput}
              onChange={(e) => setRawTokenInput(e.target.value)}
              placeholder="粘贴 access_token、refresh_token 或 auth.json…"
              rows={3}
              className="w-full rounded-lg border border-line bg-transparent p-2 font-mono text-[11px] text-ink outline-none"
            />
            <TextInput
              value={refreshTokenInput}
              onChange={(e) => setRefreshTokenInput(e.target.value)}
              placeholder="可选：refresh_token (rt_...)"
              aria-label="Refresh Token"
              className="h-7 font-mono text-[11px]"
            />
            {authInfo?.signedIn && (
              <div className="flex items-center justify-between gap-2 py-0.5 text-[11.5px] text-ink-secondary">
                <span>自动迁移当前记忆</span>
                <SwitchPill checked={autoMigrateMemory} onCheckedChange={setAutoMigrateMemory} />
              </div>
            )}
            <Button
              size="sm"
              variant="primary"
              disabled={busy || (!rawTokenInput.trim() && !refreshTokenInput.trim())}
              onClick={() => void handleImportRaw()}
            >
              {busy ? '连接中…' : '保存并连接'}
            </Button>
          </div>
        )}
      </div>
    </Section>
  )
}

/**
 * 2. Dot Orbit Profiles (`/backend-api/tbo`), Engine Mode (`dot` Room vs `native` `gpt-6-astra`), & Runtime Pause
 */
export function DotOrbitProfilesSection({
  accountId,
  botId
}: {
  accountId: string
  botId: string
}) {
  const connected = useDotConnected(accountId)
  const [dots, setDots] = useState<
    Array<{
      id: string
      displayName: string
      messagingRoomId: string
      activeRootThreadId: string
      status: string
      isPaused?: boolean
      isPrimary?: boolean
    }>
  >([])
  const [activeDotId, setActiveDotId] = useState<string>('')
  const [newDotName, setNewDotName] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string>()
  const [error, setError] = useState<string>()
  const requestGeneration = useRef(0)
  const selecting = useRef<number | null>(null)
  useLayoutEffect(() => () => {
    requestGeneration.current++
    selecting.current = null
  }, [accountId, botId, connected])

  const refresh = useCallback(async () => {
    const dotBridge = getBridge()?.dot
    if (!dotBridge?.rpc || selecting.current !== null) return
    const generation = ++requestGeneration.current
    setLoading(true)
    setError(undefined)
    try {
      const st = await dotBridge.authStatus(accountId)
      if (!st.signedIn || generation !== requestGeneration.current) return

      const res = await dotBridge.rpc({ accountId, op: 'listDots', ensureDefault: false })
      if (generation !== requestGeneration.current) return
      if (res.ok && res.data && typeof res.data === 'object') {
        const d = res.data as {
          items?: typeof dots
          activeDot?: (typeof dots)[number]
        }
        if (Array.isArray(d.items)) setDots(d.items)
        setActiveDotId(d.activeDot?.id ?? '')
      }
    } catch (err) {
      if (generation === requestGeneration.current) setError(cleanSidebarError(err))
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    if (connected) void refresh()
    else {
      setDots([])
      setActiveDotId('')
      setLoading(false)
    }
    setBusy(false)
  }, [refresh, connected, botId])

  const selectDotProfile = async (dotId: string) => {
    const dotBridge = getBridge()?.dot
    if (!dotBridge?.rpc) return
    const generation = ++requestGeneration.current
    selecting.current = generation
    setBusy(true)
    setLoading(false)
    setError(undefined)
    try {
      const res = await dotBridge.rpc({ accountId, op: 'selectDot', dotId, botId })
      if (generation !== requestGeneration.current) return
      if (!res.ok) {
        setError(res.message)
        return
      }
      if (res.data && typeof res.data === 'object') {
        const d = res.data as {
          dot?: { id: string; displayName: string; messagingRoomId: string }
          roomId?: string
          messages?: Array<{
            id: string
            role: 'user' | 'bot'
            text: string
            createdAtMs: number
            media?: ChatMessage['media']
          }>
        }
        if (d.dot?.id !== dotId || !d.roomId || d.roomId !== d.dot.messagingRoomId) return
        setActiveDotId(dotId)
        if (Array.isArray(d.messages)) {
          const hydrated: ChatMessage[] = d.messages
            .filter((m) => (m.text && m.text.trim()) || (m.media && m.media.length > 0))
            .map((m) => {
              const cleanId = m.id.replace(/^(dot_u_|dot_)+/, '')
              return {
                id: m.role === 'user' ? `dot_u_${cleanId}` : `dot_${cleanId}`,
                botId,
                accountId,
                role: m.role,
                text: m.text || '',
                createdAt: m.createdAtMs || Date.now(),
                delivery: m.role === 'user' ? 'sent' : undefined,
                ...(m.media && m.media.length > 0 ? { media: m.media } : {})
              }
            })
          useBotStore.setState((s) => {
            const bot = s.bots.find((b) => b.id === botId)
            if (bot?.activeAccountId !== accountId) return s
            const byId = new Map(hydrated.map((m) => [m.id, m]))
            if (bot.activeSessionId === d.roomId) {
              for (const m of s.messages[botId] ?? []) byId.set(m.id, m)
            }
            return {
              bots: s.bots.map((b) => b === bot ? { ...b, activeSessionId: d.roomId } : b),
              messages: { ...s.messages, [botId]: [...byId.values()].sort((a, b) => a.createdAt - b.createdAt) }
            }
          })
        }
        setHint(`已切换到 ${d.dot?.displayName || dotId}`)
      }
    } catch (err) {
      if (generation === requestGeneration.current) setError(cleanSidebarError(err))
    } finally {
      if (selecting.current === generation) {
        selecting.current = null
        setBusy(false)
      }
    }
  }

  const handleCreateDot = async () => {
    const dotBridge = getBridge()?.dot
    if (!dotBridge?.rpc) return
    setBusy(true)
    setError(undefined)
    try {
      const res = await dotBridge.rpc({
        accountId,
        op: 'createDot',
        displayName: newDotName.trim() || 'Dot'
      })
      if (res.ok) {
        setNewDotName('')
        const created = res.data as { id?: string }
        if (created?.id) await selectDotProfile(created.id)
        await refresh()
      } else {
        setError(res.message)
      }
    } finally {
      setBusy(false)
    }
  }

  const handlePauseResume = async (dotId: string, isPaused?: boolean) => {
    const dotBridge = getBridge()?.dot
    if (!dotBridge?.rpc) return
    setBusy(true)
    try {
      await dotBridge.rpc({
        accountId,
        op: isPaused ? 'resumeRuntime' : 'pauseRuntime',
        dotId
      })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteDot = async (dotId: string) => {
    const dotBridge = getBridge()?.dot
    if (!dotBridge?.rpc) return
    setBusy(true)
    try {
      const result = await dotBridge.rpc({ accountId, op: 'deleteDot', dotId })
      if (!result.ok) { setError(result.message); return }
      if (dotId === activeDotId) {
        const profiles = await dotBridge.rpc({ accountId, op: 'listDots', ensureDefault: false })
        const next = profiles.ok ? (profiles.data as { activeDot?: { id: string } }).activeDot : undefined
        if (next) await selectDotProfile(next.id)
        else {
          useBotStore.setState((s) => {
            const bot = s.bots.find((b) => b.id === botId && b.activeAccountId === accountId)
            if (!bot) return s
            return {
              bots: s.bots.map((b) => b === bot ? { ...b, activeSessionId: undefined } : b),
              messages: { ...s.messages, [botId]: [] }
            }
          })
        }
      }
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="Dot 实例"
      count={dots.length > 1 ? dots.length : undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2 text-[12px]">
        {error && <p className="text-status-error">{error}</p>}
        {hint && <p className="text-ink-secondary">{hint}</p>}

        {dots.length === 0 ? (
          <EmptyLine>暂无实例，发送消息自动初始化</EmptyLine>
        ) : (
          <ul className="flex flex-col gap-1">
            {dots.map((d) => {
              const isSelected = d.id === activeDotId
              return (
                <li
                  key={d.id}
                  className={
                    isSelected
                      ? 'flex items-center justify-between gap-2 rounded-lg bg-accent-600/8 px-2.5 py-1.5'
                      : 'flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 hover:bg-hover'
                  }
                >
                  <button
                    type="button"
                    onClick={() => void selectDotProfile(d.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <span
                      className={
                        isSelected
                          ? 'size-1.5 shrink-0 rounded-full bg-accent-600'
                          : 'size-1.5 shrink-0 rounded-full bg-ink-muted/40'
                      }
                    />
                    <span className="truncate font-medium text-ink">{d.displayName}</span>
                    {d.isPaused && (
                      <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-ink-muted">
                        已暂停
                      </span>
                    )}
                  </button>
                  <div className="flex items-center gap-0.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void handlePauseResume(d.id, d.isPaused)}
                      title={d.isPaused ? '恢复运行' : '暂停'}
                    >
                      {d.isPaused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                    </Button>
                    {dots.length > 1 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void handleDeleteDot(d.id)}
                        title={t('Delete')}
                      >
                        <Trash2 className="size-3.5 text-status-error" />
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        <div className="flex gap-1.5 pt-0.5">
          <TextInput
            value={newDotName}
            onChange={(e) => setNewDotName(e.target.value)}
            placeholder="新实例名称…"
            aria-label="New Dot name"
            className="h-7 flex-1 text-[12px]"
          />
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void handleCreateDot()}>
            <Plus className="size-3.5" /> 新建
          </Button>
        </div>
      </div>
    </Section>
  )
}

/**
 * 3. Dot Thread Goal (`thread/goal/get`, `thread/goal/set`, `thread/goal/clear`),
 *    Cross-Account Memory Snapshot & Migration (`exportMemory` / `importMemory`), & Threads (`/backend-api/tbo/{id}/threads`)
 */
export function DotGoalAndThreadsSection({ accountId }: { accountId: string }) {
  const connected = useDotConnected(accountId)
  const roomId = useBotStore((s) => s.bots.find((b) => b.activeAccountId === accountId)?.activeSessionId)
  const bots = useBotStore((s) => s.bots)
  const [savedGoal, setSavedGoal] = useState('')
  const [goalDraft, setGoalDraft] = useState<string>()
  const goal = goalDraft ?? savedGoal
  const [threads, setThreads] = useState<Array<{ id: string; title: string; updatedAt?: string }>>([])
  const [memorySnapshot, setMemorySnapshot] = useState('')
  const [vaultSealed, setVaultSealed] = useState(false)
  const [targetBotId, setTargetBotId] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string>()
  const [error, setError] = useState<string>()
  const goalRequest = useRef(0)
  const goalTarget = useRef<symbol | undefined>(undefined)
  useLayoutEffect(() => {
    goalTarget.current = Symbol()
    setSavedGoal('')
    setGoalDraft(undefined)
    setThreads([])
    setBusy(false)
    return () => {
      goalTarget.current = undefined
      goalRequest.current++
    }
  }, [accountId, roomId, connected])

  const otherDotBots = bots.filter(
    (b) => b.platformId === 'dot' && b.activeAccountId && b.activeAccountId !== accountId
  )

  useEffect(() => {
    let alive = true
    void loadDotMemoryDraft().then((draft) => {
      if (!alive) return
      if (draft) {
        setMemorySnapshot(draft)
        setVaultSealed(Boolean(getBridge()?.vault))
      }
    })
    return () => {
      alive = false
    }
  }, [])

  const updateSnapshotText = (val: string) => {
    setMemorySnapshot(val)
    void saveDotMemoryDraft(val).then((encrypted) => {
      setVaultSealed(encrypted)
    })
  }

  const refresh = useCallback(async () => {
    const dotBridge = getBridge()?.dot
    if (!dotBridge?.rpc) return
    const request = ++goalRequest.current
    setLoading(true)
    try {
      const [gRes, tRes] = await Promise.all([
        dotBridge.rpc({ accountId, op: 'getGoal' }).catch(() => null),
        dotBridge.rpc({ accountId, op: 'listThreads' }).catch(() => null)
      ])
      if (request !== goalRequest.current) return
      if (gRes && gRes.ok && gRes.data && typeof gRes.data === 'object') {
        const go = asObj(gRes.data)
        setSavedGoal(str(go?.['goal'] ?? ''))
      }
      if (tRes && tRes.ok && tRes.data && typeof tRes.data === 'object') {
        const to = asObj(tRes.data)
        const items = Array.isArray(to?.['items']) ? to['items'] : []
        setThreads(
          items.map((item, idx) => {
            const r = asObj(item) || {}
            return {
              id: str(r['thread_id'] ?? r['id'] ?? idx),
              title: str(r['title'] ?? r['summary'] ?? r['thread_id'] ?? `Thread ${idx + 1}`),
              updatedAt: str(r['updated_at'] ?? '')
            }
          })
        )
      }
    } finally {
      if (request === goalRequest.current) setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    if (connected) void refresh()
    else setLoading(false)
  }, [refresh, connected, roomId])

  const saveGoal = async () => {
    const dotBridge = getBridge()?.dot
    if (!dotBridge?.rpc) return
    const target = goalTarget.current
    const value = goal.trim()
    setBusy(true)
    setError(undefined)
    try {
      const result = value
        ? await dotBridge.rpc({ accountId, op: 'setGoal', goal: value })
        : await dotBridge.rpc({ accountId, op: 'clearGoal' })
      if (target !== goalTarget.current) return
      if (!result.ok) { setError(result.message); return }
      goalRequest.current++
      setLoading(false)
      setSavedGoal(value)
      setGoalDraft((draft) => draft === goalDraft ? undefined : draft)
      setHint(value ? '已保存长期目标' : '已清除目标')
    } catch (err) {
      if (target === goalTarget.current) setError(cleanSidebarError(err))
    } finally {
      if (target === goalTarget.current) setBusy(false)
    }
  }

  const handleExportMemory = async (mode: 'fast' | 'deep') => {
    const dotBridge = getBridge()?.dot
    if (!dotBridge?.rpc) return
    setBusy(true)
    setError(undefined)
    setHint(mode === 'deep' ? '正在深度整理记忆快照…' : '正在提取记忆快照…')
    try {
      const res = await dotBridge.rpc({ accountId, op: 'exportMemory', mode })
      if (res.ok && res.data && typeof res.data === 'object') {
        const d = res.data as {
          markdown?: string
          sourceHandle?: string
          roomMessagesCount?: number
          globalMemoriesCount?: number
        }
        if (d.markdown) {
          updateSnapshotText(d.markdown)
          setHint(`已提取记忆快照（${d.globalMemoriesCount ?? 0} 条记忆）`)
        }
      } else if (!res.ok) {
        setError(res.message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleImportMemoryTo = async (destAccountId: string, destBotId?: string) => {
    const dotBridge = getBridge()?.dot
    if (!dotBridge?.rpc || !memorySnapshot.trim()) return
    setBusy(true)
    setError(undefined)
    setHint('正在注入记忆快照…')
    try {
      const res = await dotBridge.rpc({
        accountId: destAccountId,
        op: 'importMemory',
        markdown: memorySnapshot.trim(),
        goal: goal.trim() || undefined,
        botId: destBotId
      })
      if (res.ok) {
        setHint('记忆迁移完成')
      } else {
        setError(res.message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const currentBot = bots.find((b) => b.activeAccountId === accountId)

  return (
    <Section
      title="长期目标与记忆"
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2.5 text-[12px]">
        {error && <p className="text-status-error">{error}</p>}
        {hint && <p className="text-status-online-ink">{hint}</p>}

        <div className="flex gap-1.5">
          <TextInput
            value={goal}
            onChange={(e) => setGoalDraft(e.target.value)}
            placeholder="设置长期目标…"
            aria-label="Dot goal"
            className="h-7 flex-1 text-[12px]"
          />
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void saveGoal()}>
            <Target className="size-3.5" /> 保存
          </Button>
        </div>

        <div className="flex flex-col gap-1.5 border-t border-line pt-2">
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void handleExportMemory('fast')}
            >
              提取记忆
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void handleExportMemory('deep')}
            >
              <Sparkles className="size-3.5" /> 深度整理
            </Button>
            {memorySnapshot.trim() && (
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => void handleImportMemoryTo(accountId, currentBot?.id)}
              >
                注入当前账号
              </Button>
            )}
          </div>

          <textarea
            value={memorySnapshot}
            onChange={(e) => updateSnapshotText(e.target.value)}
            placeholder="提取后可在此编辑记忆快照，或一键迁移至新账号…"
            rows={memorySnapshot.trim() ? 5 : 2}
            className="w-full rounded-lg border border-line bg-transparent p-2 font-mono text-[11px] leading-[15px] text-ink outline-none"
          />
          {vaultSealed && memorySnapshot.trim() && (
            <p className="flex items-center gap-1 text-[10.5px] text-status-online-ink">
              <Lock className="size-3 shrink-0" aria-hidden />
              <span>记忆草稿已由系统钥匙串加密保存（0600 保险箱，无明文缓存）</span>
            </p>
          )}

          {otherDotBots.length > 0 && memorySnapshot.trim() && (
            <div className="flex items-center gap-1.5">
              <Select
                size="xs"
                value={targetBotId || otherDotBots[0]?.id || ''}
                onValueChange={(next) => setTargetBotId(next)}
                className="flex-1"
                options={otherDotBots.map((b) => ({
                  value: b.id,
                  label: `迁移至：${b.name}`
                }))}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  const dest =
                    otherDotBots.find((b) => b.id === targetBotId) ?? otherDotBots[0]
                  if (dest?.activeAccountId) {
                    void handleImportMemoryTo(dest.activeAccountId, dest.id)
                  }
                }}
              >
                迁移
              </Button>
            </div>
          )}
        </div>

        {threads.length > 0 && (
          <ul className="flex flex-col gap-1 border-t border-line pt-2">
            {threads.slice(0, 6).map((th) => (
              <li
                key={th.id}
                className="truncate rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-hover"
              >
                {th.title}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

/**
 * 4. Dot Library & Dynamic Pages (`/backend-api/files/library/nodes` & `/backend-api/pages`)
 */
export function DotLibrarySection({ accountId }: { accountId: string }) {
  const connected = useDotConnected(accountId)
  const setActiveDocument = useBotStore((s) => s.setActiveDocument)
  const [nodes, setNodes] = useState<
    Array<{
      id: string
      title: string
      kind: string
      updatedAt?: string
    }>
  >([])
  const [newPageTitle, setNewPageTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [docTarget, setDocTarget] = useState<NativeDocumentTarget | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  const handleDownloadNode = async (n: { id: string; title: string }) => {
    const dotBridge = getBridge()?.dot
    if (!dotBridge?.rpc) return
    setDownloadingId(n.id)
    setError(undefined)
    try {
      const res = await dotBridge.rpc({
        accountId,
        op: 'downloadFile',
        fileId: n.id,
        name: n.title
      })
      if (!res.ok) {
        setError(res.message || `下载失败 (${res.status})`)
        return
      }
      const d = res.data as { dataBase64: string; mimeType: string; filename: string }
      const bin = atob(d.dataBase64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const blob = new Blob([bytes], { type: d.mimeType || 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = d.filename || n.title || 'download'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDownloadingId(null)
    }
  }

  const refresh = useCallback(async () => {
    const dotBridge = getBridge()?.dot
    if (!dotBridge?.rpc) return
    setLoading(true)
    setError(undefined)
    try {
      const res = await dotBridge.rpc({ accountId, op: 'listLibrary', limit: 25 })
      if (res.ok && res.data && typeof res.data === 'object') {
        const o = asObj(res.data) || {}
        const list =
          (Array.isArray(o['items']) && o['items']) ||
          (Array.isArray(o['nodes']) && o['nodes']) ||
          []
        setNodes(
          list.map((item, idx) => {
            const r = asObj(item) || {}
            return {
              id: str(r['id'] ?? r['page_id'] ?? r['node_id'] ?? idx),
              title: str(r['title'] ?? r['name'] ?? 'Untitled Page'),
              kind: str(r['node_type'] ?? r['type'] ?? r['layout'] ?? 'page'),
              updatedAt: str(r['updated_at'] ?? '')
            }
          })
        )
      }
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    if (connected) void refresh()
  }, [refresh, connected])

  const handleCreatePage = async () => {
    const dotBridge = getBridge()?.dot
    if (!dotBridge?.rpc || !newPageTitle.trim()) return
    setBusy(true)
    try {
      await dotBridge.rpc({
        accountId,
        op: 'createPage',
        title: newPageTitle.trim(),
        layout: 'document'
      })
      setNewPageTitle('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="页面与文件"
      count={nodes.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2 text-[12px]">
        {error && <p className="text-status-error">{error}</p>}

        <div className="flex gap-1.5">
          <TextInput
            value={newPageTitle}
            onChange={(e) => setNewPageTitle(e.target.value)}
            placeholder="新建页面标题…"
            aria-label="New Dynamic Page title"
            className="h-7 flex-1 text-[12px]"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !newPageTitle.trim()}
            onClick={() => void handleCreatePage()}
          >
            <Plus className="size-3.5" /> 新建
          </Button>
        </div>

        {nodes.length === 0 ? (
          <EmptyLine>{t('Files the bot creates show up here')}</EmptyLine>
        ) : (
          <ul className="divide-y divide-line">
            {nodes.map((n) => (
              <li key={n.id} className="flex items-center justify-between gap-2 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-hover text-ink-secondary">
                    <FileText className="size-4" />
                  </span>
                  <p className="truncate font-medium text-ink">{n.title}</p>
                </div>
                {(n.id.startsWith('file_') ||
                  n.id.startsWith('libfile_') ||
                  n.kind === 'file') && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setActiveDocument({
                          accountId,
                          title: n.title,
                          path: n.id,
                          platformId: 'dot'
                        })
                      }
                      title="预览文件"
                    >
                      <Eye className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={downloadingId === n.id}
                      onClick={() => void handleDownloadNode(n)}
                      title="下载文件"
                    >
                      <Download className="size-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <NativeDocumentDialog target={docTarget} onClose={() => setDocTarget(null)} />
    </Section>
  )
}
