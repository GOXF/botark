import { desktopCopy, desktopNotice, useDesktopLocale } from '@/lib/desktopCopy'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BarChart3,
  Brain,
  Clock,
  Cpu,
  HelpCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Server,
  Settings,
  Star,
  Trash2,
  Users
} from 'lucide-react'
import type {
  DsBotAuthStatus,
  DsBotMemoryView,
  DsBotModelInfo,
  DsBotQuestionView,
  DsBotScheduleItem,
  DsBotTargetInfo,
  DsBotUsageSummary
} from '@shared/ipc'
import { EmptyLine, Section } from '@/components/info/Section'
import { RefreshButton } from '@/components/muse/RefreshButton'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { cleanSidebarError } from '@/lib/sidebarCompat'
import { useBotStore } from '@/store/botStore'

const MODE_LABELS: Record<string, string> = {
  mcp: 'MCP HTTP',
  relay: 'Noise 加密中继',
  channel: 'DSH Web SSE'
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function DsBotServerSection({
  accountId,
  agentId
}: {
  accountId: string
  agentId?: string
}) {
  useDesktopLocale()
  const [status, setStatus] = useState<DsBotAuthStatus | null>(null)
  const [models, setModels] = useState<DsBotModelInfo[]>([])
  const [currentModel, setCurrentModel] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [savingModel, setSavingModel] = useState(false)
  const [error, setError] = useState<string>()
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const isRoom = Boolean(agentId?.startsWith('room:'))

  const refresh = useCallback(async () => {
    const dsBot = getBridge()?.dsBot
    if (!dsBot) return
    setLoading(true)
    setError(undefined)
    try {
      const [st, modelsRes, targetsRes] = await Promise.all([
        dsBot.authStatus(accountId),
        dsBot.rpc({ accountId, op: 'listModels' }).catch(() => ({ ok: false as const, status: 0, message: '' })),
        dsBot.rpc({ accountId, op: 'listTargets' }).catch(() => ({ ok: false as const, status: 0, message: '' }))
      ])
      setStatus(st)
      if (modelsRes.ok && modelsRes.data && typeof modelsRes.data === 'object') {
        const data = modelsRes.data as { models?: DsBotModelInfo[]; defaultModel?: string }
        setModels(Array.isArray(data.models) ? data.models : [])
        if (data.defaultModel && !currentModel) setCurrentModel(data.defaultModel)
      }
      if (targetsRes.ok && Array.isArray(targetsRes.data) && agentId) {
        const target = (targetsRes.data as DsBotTargetInfo[]).find((t) => t.id === agentId)
        if (target?.model) setCurrentModel(target.model)
      }
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }, [accountId, agentId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleSwitchModel = async (nextRef: string) => {
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.rpc || !agentId || isRoom) return
    setSavingModel(true)
    setError(undefined)
    try {
      const res = await dsBot.rpc({ accountId, op: 'setBotModel', agentId, model: nextRef })
      if (!res.ok) throw new Error(res.message)
      setCurrentModel(nextRef)
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setSavingModel(false)
    }
  }

  return (
    <Section
      title={desktopCopy("DS Bot 连接与模型", "DS Bot Connection and Model")}
      action={
        <div className="flex items-center gap-1">
          <RefreshButton loading={loading} onClick={() => void refresh()} />
          <button
            type="button"
            onClick={() => setSettingsOpen(true, 'ds-bot-accounts')}
            className="press rounded-md p-1 text-ink-muted hover:bg-hover hover:text-ink"
            title={desktopCopy("DS Bot 连接设置", "DS Bot Connection Settings")}
          >
            <Settings className="size-3.5" />
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-2 text-[12.5px]">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-ink-secondary">
            <Server className="size-3.5" />{desktopCopy("接入方式", "Connection method")}</span>
          <span className="rounded-full bg-accent-50 px-2 py-0.5 text-[11px] font-medium text-accent-600">
            {status?.mode ? desktopNotice(MODE_LABELS[status.mode] ?? status.mode) : desktopCopy("未连接", "Not Connected")}
          </span>
        </div>

        {(status?.baseUrl || status?.relayServer) && (
          <div className="truncate font-mono text-[11.5px] text-ink-muted" title={status.baseUrl || status.relayServer}>
            {status.baseUrl || status.relayServer}
          </div>
        )}

        {!isRoom && models.length > 0 && agentId && (
          <div className="mt-1 flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
              <Cpu className="size-3.5" />{desktopCopy("当前 Bot 模型", "Current Bot Model")}</span>
            <Select
              size="xs"
              value={currentModel || models[0]!.ref}
              disabled={savingModel}
              onValueChange={(val) => void handleSwitchModel(val)}
              options={models.map((m) => ({
                value: m.ref,
                label: m.providerName ? `${m.name} (${m.providerName})` : m.name
              }))}
            />
          </div>
        )}

        {status?.mode === 'mcp' && (
          <p className="rounded-lg bg-sunken/70 px-2.5 py-1.5 text-[11px] leading-4 text-ink-muted">{desktopCopy("当前为 MCP 模式（支持收发消息、历史与待处理提示）。切换为「加密配对链接」或「DSH Web」可解锁流式、审批操作、记忆与定时任务管理。", "MCP mode supports messages, history, and read-only prompts. Use an encrypted pairing link or DSH Web for streaming, approvals, memory, and scheduled tasks.")}</p>
        )}

        {error && <p className="text-[11.5px] text-status-error">{desktopNotice(error)}</p>}
      </div>
    </Section>
  )
}

export function DsBotQuestionsSection({ accountId }: { accountId: string }) {
  useDesktopLocale()
  const [questions, setQuestions] = useState<DsBotQuestionView[]>([])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.rpc) return
    const res = await dsBot.rpc({ accountId, op: 'listWaiting' }).catch(() => null)
    if (res?.ok && res.data && typeof res.data === 'object') {
      const q = (res.data as { questions?: DsBotQuestionView[] }).questions
      setQuestions(Array.isArray(q) ? q : [])
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.onEvent) return
    return dsBot.onEvent((ev) => {
      if (ev.type === 'approvals' && ev.accountId === accountId && ev.questions) {
        setQuestions(ev.questions)
      }
    })
  }, [accountId, refresh])

  if (questions.length === 0) return null

  const submitAnswer = async (q: DsBotQuestionView, value: string) => {
    const dsBot = getBridge()?.dsBot
    const trimmed = value.trim()
    if (!dsBot?.rpc || !trimmed || !q.answerable) return
    setBusyId(q.id)
    setError(undefined)
    try {
      const res = await dsBot.rpc({
        accountId,
        op: 'answerQuestion',
        sessionId: q.sessionId,
        questionId: q.id,
        answer: trimmed
      })
      if (!res.ok) throw new Error(res.message)
      setAnswers((prev) => {
        const next = { ...prev }
        delete next[q.id]
        return next
      })
      await refresh()
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setBusyId(undefined)
    }
  }

  return (
    <Section title={desktopCopy("等待你回复的问题", "Waiting for your answer")} count={questions.length}>
      <div className="flex flex-col gap-2.5">
        {questions.map((q) => (
          <div key={q.id} className="rounded-xl border border-accent-600/25 bg-accent-50/40 p-2.5 text-[12px]">
            <div className="flex items-start gap-1.5 font-medium text-ink">
              <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-accent-600" />
              <span>{q.botName ? `${q.botName}：` : ''}{q.question}</span>
            </div>
            {q.detail && <p className="mt-1 text-[11.5px] text-ink-secondary">{q.detail}</p>}
            {q.answerable ? (
              <div className="mt-2 flex flex-col gap-1.5">
                {q.options && q.options.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {q.options.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        disabled={busyId === q.id}
                        onClick={() => void submitAnswer(q, opt.label)}
                        className="press rounded-lg border border-line bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink hover:bg-hover"
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex gap-1.5">
                  <input
                    value={answers[q.id] ?? ''}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    placeholder={desktopCopy("输入自定义回复…", "Enter Custom Reply…")}
                    className="h-7 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent-600"
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busyId === q.id || !(answers[q.id] ?? '').trim()}
                    onClick={() => void submitAnswer(q, answers[q.id] ?? '')}
                  >
                    <Send className="size-3" />
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mt-1 text-[11px] text-ink-muted">{desktopCopy("当前为 MCP 只读提示，请在 DS Bot 桌面端回复", "This prompt is read-only in MCP mode. Reply in the DS Bot app.")}</p>
            )}
          </div>
        ))}
        {error && <p className="text-[11.5px] text-status-error">{desktopNotice(error)}</p>}
      </div>
    </Section>
  )
}

export function DsBotUsageSection({ accountId, agentId }: { accountId: string; agentId?: string }) {
  useDesktopLocale()
  const [usage, setUsage] = useState<DsBotUsageSummary | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.rpc || !agentId || agentId.startsWith('room:')) {
      setUsage(null)
      return
    }
    setLoading(true)
    try {
      const res = await dsBot.rpc({ accountId, op: 'getUsage', agentId })
      if (res.ok && res.data && typeof res.data === 'object') {
        setUsage(res.data as DsBotUsageSummary)
      } else {
        setUsage(null)
      }
    } finally {
      setLoading(false)
    }
  }, [accountId, agentId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!usage) return null

  return (
    <Section title={desktopCopy("Token 用量统计", "Token Usage Statistics")} action={<RefreshButton loading={loading} onClick={() => void refresh()} />}>
      <div className="grid grid-cols-3 gap-1.5 text-center">
        {[
          { label: desktopCopy("24 小时", "24 hours"), bucket: usage.day },
          { label: desktopCopy("7 天", "7 days"), bucket: usage.week },
          { label: desktopCopy("30 天", "30 days"), bucket: usage.month }
        ].map(({ label, bucket }) => (
          <div key={label} className="rounded-xl border border-line bg-surface px-2 py-2">
            <div className="flex items-center justify-center gap-1 text-[10.5px] text-ink-muted">
              <BarChart3 className="size-3" />
              {label}
            </div>
            <div className="mt-0.5 font-mono text-[12.5px] font-semibold text-ink">
              {formatTokens((bucket?.input ?? 0) + (bucket?.output ?? 0))}
            </div>
            <div className="text-[10.5px] text-ink-muted">{bucket?.calls ?? 0}{desktopCopy(" 次调用", " calls")}</div>
          </div>
        ))}
      </div>
    </Section>
  )
}

export function DsBotSchedulesSection({ accountId }: { accountId: string }) {
  useDesktopLocale()
  const [tasks, setTasks] = useState<DsBotScheduleItem[]>([])
  const [available, setAvailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.rpc) return
    setLoading(true)
    setError(undefined)
    try {
      const res = await dsBot.rpc({ accountId, op: 'listSchedules' })
      if (res.ok && res.data && typeof res.data === 'object') {
        const data = res.data as { available?: boolean; tasks?: DsBotScheduleItem[] }
        setAvailable(Boolean(data.available))
        setTasks(Array.isArray(data.tasks) ? data.tasks : [])
      }
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!available && tasks.length === 0) return null

  const toggle = async (task: DsBotScheduleItem) => {
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.rpc) return
    setBusyId(task.id)
    try {
      const active = task.state === 'paused' || task.status === 'paused'
      const res = await dsBot.rpc({
        accountId,
        op: 'toggleSchedule',
        scheduleId: task.id,
        sessionId: task.sessionId,
        active
      })
      if (!res.ok) throw new Error(res.message)
      await refresh()
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setBusyId(undefined)
    }
  }

  const remove = async (task: DsBotScheduleItem) => {
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.rpc) return
    setBusyId(task.id)
    try {
      const res = await dsBot.rpc({
        accountId,
        op: 'deleteSchedule',
        scheduleId: task.id,
        sessionId: task.sessionId
      })
      if (!res.ok) throw new Error(res.message)
      await refresh()
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setBusyId(undefined)
    }
  }

  return (
    <Section
      title={desktopCopy("定时自动化任务", "Scheduled automations")}
      count={tasks.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      {tasks.length === 0 ? (
        <EmptyLine>{desktopCopy("暂无定时任务", "No scheduled tasks")}</EmptyLine>
      ) : (
        <div className="flex flex-col gap-2">
          {tasks.map((task) => {
            const paused = task.state === 'paused' || task.status === 'paused'
            return (
              <div key={task.id} className="rounded-xl border border-line bg-surface p-2.5 text-[12px]">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-medium text-ink">
                      <Clock className="size-3.5 shrink-0 text-ink-muted" />
                      <span className="truncate">{task.title}</span>
                    </div>
                    {task.prompt && (
                      <p className="mt-0.5 line-clamp-2 text-[11.5px] text-ink-secondary">{task.prompt}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {task.canPause && (
                      <button
                        type="button"
                        disabled={busyId === task.id}
                        onClick={() => void toggle(task)}
                        title={paused ? desktopCopy("恢复任务", "Resume Task") : desktopCopy("暂停任务", "Pause Tasks")}
                        className="rounded-md p-1 text-ink-secondary hover:bg-hover hover:text-ink"
                      >
                        {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busyId === task.id}
                      onClick={() => void remove(task)}
                      title={desktopCopy("删除任务", "Delete Task")}
                      className="rounded-md p-1 text-ink-muted hover:bg-status-error/10 hover:text-status-error"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {error && <p className="mt-1.5 text-[11.5px] text-status-error">{desktopNotice(error)}</p>}
    </Section>
  )
}

export function DsBotMemorySection({ accountId, agentId }: { accountId: string; agentId?: string }) {
  useDesktopLocale()
  const [view, setView] = useState<DsBotMemoryView | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.rpc || !agentId) return
    setLoading(true)
    setError(undefined)
    try {
      const res = await dsBot.rpc({ accountId, op: 'getMemory', agentId })
      if (res.ok && res.data && typeof res.data === 'object') {
        setView(res.data as DsBotMemoryView)
      } else if (!res.ok) {
        setError(res.message)
      }
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }, [accountId, agentId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault()
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.rpc || !agentId || !draft.trim()) return
    setSaving(true)
    setError(undefined)
    try {
      const res = await dsBot.rpc({ accountId, op: 'addMemory', agentId, text: draft.trim() })
      if (!res.ok) throw new Error(res.message)
      setDraft('')
      if (res.data && typeof res.data === 'object') setView(res.data as DsBotMemoryView)
      else await refresh()
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setSaving(false)
    }
  }

  const handleForget = async (entry: { text: string; scope?: string; topic?: string }) => {
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.rpc || !agentId) return
    setSaving(true)
    setError(undefined)
    try {
      const res = await dsBot.rpc({
        accountId,
        op: 'forgetMemory',
        agentId,
        text: entry.text,
        scope: entry.scope,
        topic: entry.topic
      })
      if (!res.ok) throw new Error(res.message)
      if (res.data && typeof res.data === 'object') setView(res.data as DsBotMemoryView)
      else await refresh()
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section
      title={desktopCopy("DS Bot 长期记忆", "DS Bot Long-Term Memory")}
      count={view?.entries.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      {!agentId ? (
        <EmptyLine>{desktopCopy("请选择具体 DS Bot 成员或群聊", "Please select a specific DS Bot member or group chat")}</EmptyLine>
      ) : view && !view.memoryEnabled ? (
        <EmptyLine>{desktopCopy("MCP 模式暂不支持读写记忆；使用「加密配对链接」或「DSH Web」可完整管理 MEMORY.md", "MCP mode can’t read or write memory. Use an encrypted pairing link or DSH Web to manage MEMORY.md.")}</EmptyLine>
      ) : (
        <div className="flex flex-col gap-2.5">
          {view?.summary && (
            <div className="rounded-xl border border-line bg-sunken/60 p-2.5 text-[12px] leading-5 text-ink-secondary">
              <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-ink">
                <Brain className="size-3.5 text-accent-600" />{desktopCopy("记忆摘要", "Memory Summary")}</div>
              {view.summary}
            </div>
          )}

          <form onSubmit={(e) => void handleAdd(e)} className="flex gap-1.5">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={desktopCopy("新增一条长期记忆…", "Add a long-term memory…")}
              className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-[12px] text-ink outline-none focus:border-accent-600"
            />
            <Button type="submit" size="sm" variant="secondary" disabled={saving || !draft.trim()}>
              <Plus className="size-3.5" />
            </Button>
          </form>

          {view && view.entries.length === 0 ? (
            <EmptyLine>{desktopCopy("还没有保存任何长期记忆条目", "No long-term memory entries have been saved")}</EmptyLine>
          ) : (
            <div className="flex flex-col gap-1.5">
              {(view?.entries ?? []).map((entry, idx) => (
                <div
                  key={`${entry.scope}:${entry.topic ?? ''}:${idx}`}
                  className="group flex items-start justify-between gap-2 rounded-xl border border-line bg-surface px-2.5 py-2 text-[12px]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-ink leading-5">{entry.text}</p>
                    <p className="mt-0.5 text-[10.5px] text-ink-muted">
                      {entry.scope === 'team' ? desktopCopy("团队共享", "Shared with the team") : entry.scope === 'group' ? desktopCopy("群聊记忆", "Group chat memory") : desktopCopy("专属记忆", "Private memory")}
                      {entry.topic ? ` · [[${entry.topic}]]` : ''}
                      {entry.added ? ` · ${entry.added}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleForget(entry)}
                    title={desktopCopy("遗忘此记忆", "Forget this memory.")}
                    className="opacity-0 group-hover:opacity-100 rounded-md p-1 text-ink-muted hover:bg-status-error/10 hover:text-status-error"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {error && <p className="text-[11.5px] text-status-error">{desktopNotice(error)}</p>}
        </div>
      )}
    </Section>
  )
}

export function DsBotTeamRosterSection({ accountId }: { accountId: string }) {
  useDesktopLocale()
  const [targets, setTargets] = useState<DsBotTargetInfo[]>([])
  const [canCreate, setCanCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState('')
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string>()
  const bots = useBotStore((s) => s.bots)
  const selectBot = useBotStore((s) => s.selectBot)
  const syncDsBotAccountBots = useBotStore((s) => s.syncDsBotAccountBots)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.rpc) return
    setLoading(true)
    setError(undefined)
    try {
      const [st, res] = await Promise.all([
        dsBot.authStatus(accountId).catch(() => null),
        dsBot.rpc({ accountId, op: 'listTargets' })
      ])
      if (!mounted.current) return
      setCanCreate(st?.mode === 'channel' || st?.mode === 'relay')
      if (res.ok && Array.isArray(res.data)) {
        setTargets(res.data as DsBotTargetInfo[])
      } else if (!res.ok) {
        setError(res.message)
      }
    } catch (err) {
      if (mounted.current) setError(cleanSidebarError(err))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleSyncAll = async () => {
    setLoading(true)
    setError(undefined)
    try {
      await syncDsBotAccountBots(accountId, { includeDismissed: true })
      await refresh()
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    const dsBot = getBridge()?.dsBot
    if (!dsBot?.rpc || !newName.trim()) return
    setCreating(true)
    setError(undefined)
    try {
      const res = await dsBot.rpc({
        accountId,
        op: 'createBot',
        name: newName.trim(),
        role: newRole.trim() || undefined
      })
      if (!res.ok) throw new Error(res.message)
      setNewName('')
      setNewRole('')
      await syncDsBotAccountBots(accountId, { includeDismissed: true })
      await refresh()
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Section
      title={desktopCopy("DS Bot 团队成员与群聊", "DS Bot team members and group chats")}
      count={targets.length || undefined}
      action={
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => void handleSyncAll()}>
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />{desktopCopy("全部同步", "Sync All")}</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        {targets.length === 0 ? (
          <EmptyLine>{desktopCopy("暂无可访问的 Bot 或群聊", "No accessible bots or group chats")}</EmptyLine>
        ) : (
          targets.map((target) => {
            const matchedBot = bots.find(
              (b) => b.platformId === 'ds-bot' && b.accountIds.includes(accountId) && b.selectedAgentId === target.id
            )
            return (
              <button
                key={target.id}
                type="button"
                onClick={() => {
                  if (matchedBot) selectBot(matchedBot.id)
                  else void handleSyncAll()
                }}
                className="press flex w-full items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-left hover:bg-hover"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                    {target.kind === 'room' ? (
                      <Users className="size-3.5 shrink-0 text-accent-600" />
                    ) : target.main ? (
                      <Star className="size-3.5 shrink-0 text-amber-500" />
                    ) : null}
                    <span className="truncate">{target.name}</span>
                  </div>
                  <p className="truncate text-[11px] text-ink-muted">
                    {target.kind === 'room'
                      ? target.members?.length
                        ? desktopCopy("群聊 · {0}", "Group chat · {0}", [(target.members.join('、'))])
                        : desktopCopy("DS Bot 群聊", "DS Bot group chat")
                      : target.role || target.model || desktopCopy("DS Bot 成员", "DS Bot Member")}
                  </p>
                </div>
                {target.working && (
                  <span className="shrink-0 rounded-full bg-status-online/15 px-2 py-0.5 text-[10.5px] font-medium text-status-online-ink">{desktopCopy("工作中", "Working")}</span>
                )}
              </button>
            )
          })
        )}

        {canCreate && (
          <form
            onSubmit={(e) => void handleCreate(e)}
            className="mt-1 flex flex-col gap-1.5 rounded-xl border border-dashed border-line p-2.5"
          >
            <span className="text-[11.5px] font-medium text-ink-secondary">{desktopCopy("新建 DS Bot 成员", "New DS Bot Member")}</span>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={desktopCopy("Bot 名称（例如 Coder / Researcher）", "Bot name (e.g. Coder or Researcher)")}
              className="h-8 rounded-lg border border-line bg-main px-2.5 text-[12px] text-ink outline-none focus:border-accent-600"
            />
            <div className="flex gap-1.5">
              <input
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                placeholder={desktopCopy("角色定位（可选）", "Role positioning (optional)")}
                className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-main px-2.5 text-[12px] text-ink outline-none focus:border-accent-600"
              />
              <Button type="submit" size="sm" variant="primary" disabled={creating || !newName.trim()}>
                <Plus className="size-3.5" />{desktopCopy("创建", "Create")}</Button>
            </div>
          </form>
        )}

        {error && <p className="text-[11.5px] text-status-error">{desktopNotice(error)}</p>}
      </div>
    </Section>
  )
}
