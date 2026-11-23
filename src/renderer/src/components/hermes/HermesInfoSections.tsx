import { useCallback, useEffect, useState } from 'react'
import {
  Clock,
  Cpu,
  MessageSquarePlus,
  Pause,
  Play,
  RefreshCw,
  Server,
  Settings,
  Sparkles,
  Trash2,
  Wrench
} from 'lucide-react'
import type {
  HermesAuthStatus,
  HermesCronJob,
  HermesSessionSummary,
  HermesSkillItem,
  HermesToolsetItem
} from '@shared/ipc'
import { EmptyLine, Section } from '@/components/info/Section'
import { RefreshButton } from '@/components/muse/RefreshButton'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { cleanSidebarError } from '@/lib/sidebarCompat'
import { t } from '@/lib/i18n'
import { useBotStore } from '@/store/botStore'

const HERMES_CUSTOM_MODELS_KEY = 'bothub.hermes.customModels.v1'

const HERMES_COMMON_PRESETS: Array<{ id: string; root?: string }> = [
  { id: 'hermes-agent', root: '网关默认配置模型' },
  { id: 'anthropic/claude-sonnet-4', root: 'Anthropic / OpenRouter' },
  { id: 'openai/gpt-4o', root: 'OpenAI / OpenRouter' },
  { id: 'google/gemini-2.5-pro', root: 'Google / OpenRouter' },
  { id: 'deepseek/deepseek-chat', root: 'DeepSeek / OpenRouter' }
]

function loadSavedHermesModels(): string[] {
  try {
    const raw = localStorage.getItem(HERMES_CUSTOM_MODELS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []
  } catch {
    return []
  }
}

function persistSavedHermesModel(modelId: string): string[] {
  const trimmed = modelId.trim()
  if (!trimmed) return loadSavedHermesModels()
  const next = [trimmed, ...loadSavedHermesModels().filter((m) => m !== trimmed)].slice(0, 24)
  try {
    localStorage.setItem(HERMES_CUSTOM_MODELS_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  return next
}

export function HermesServerSection({ accountId }: { accountId: string }) {
  const [status, setStatus] = useState<HermesAuthStatus | null>(null)
  const [models, setModels] = useState<Array<{ id: string; root?: string }>>([])
  const [customModels, setCustomModels] = useState<string[]>(() => loadSavedHermesModels())
  const [customInputOpen, setCustomInputOpen] = useState(false)
  const [customModelDraft, setCustomModelDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [savingModel, setSavingModel] = useState(false)
  const [error, setError] = useState<string>()
  const connectAccount = useBotStore((s) => s.connectAccount)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)

  const refresh = useCallback(async () => {
    const hermes = getBridge()?.hermes
    if (!hermes) return
    setLoading(true)
    setError(undefined)
    try {
      const [st, modelsRes] = await Promise.all([
        hermes.authStatus(accountId),
        hermes.rpc({ accountId, op: 'models' }).catch(() => ({ ok: false as const, status: 0, message: '' }))
      ])
      setStatus(st)
      if (modelsRes.ok && Array.isArray(modelsRes.data)) {
        setModels(modelsRes.data as Array<{ id: string; root?: string }>)
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

  const handleModelChange = async (nextModel: string) => {
    const trimmed = nextModel.trim()
    if (!trimmed) return
    const hermes = getBridge()?.hermes
    if (!hermes?.rpc) return
    setSavingModel(true)
    try {
      const res = await hermes.rpc({ accountId, op: 'setModel', model: trimmed })
      if (res.ok) {
        setStatus((prev) => (prev ? { ...prev, model: trimmed } : prev))
      }
    } finally {
      setSavingModel(false)
    }
  }

  const handleSaveCustomModel = async () => {
    const trimmed = customModelDraft.trim()
    if (!trimmed) return
    setCustomModels(persistSavedHermesModel(trimmed))
    setCustomModelDraft('')
    setCustomInputOpen(false)
    await handleModelChange(trimmed)
  }

  const mergedModelOptions = (() => {
    const map = new Map<string, { id: string; root?: string }>()
    for (const m of models) {
      if (m.id) map.set(m.id, m)
    }
    if (status?.model && !map.has(status.model)) {
      map.set(status.model, { id: status.model, root: '当前选定模型' })
    }
    for (const cm of customModels) {
      if (!map.has(cm)) map.set(cm, { id: cm, root: '自定义模型' })
    }
    for (const preset of HERMES_COMMON_PRESETS) {
      if (!map.has(preset.id)) map.set(preset.id, preset)
    }
    return [...map.values()]
  })()

  return (
    <Section
      title={t('Hermes Gateway')}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      {error && <p className="pb-1 text-[12px] text-status-error">{error}</p>}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-[12px]">
          <span className="flex min-w-0 items-center gap-1.5 text-ink-secondary">
            <Server className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate font-mono text-[11.5px] text-ink">
              {status?.baseUrl || 'http://127.0.0.1:8642'}
            </span>
          </span>
          {status?.version && (
            <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted">
              v{status.version}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-ink-secondary">
            <Cpu className="size-3" aria-hidden />
            {t('Model')}
          </span>
          <Select
            size="xs"
            variant="pill"
            disabled={savingModel}
            value={status?.model || models[0]?.id || 'hermes-agent'}
            onValueChange={(next) => void handleModelChange(next)}
            className="min-w-0 flex-1 font-mono"
            options={mergedModelOptions.map((m) => ({
              value: m.id,
              label: m.id,
              description: m.root && m.root !== m.id ? m.root : undefined
            }))}
          />
          <button
            type="button"
            onClick={() => setCustomInputOpen((v) => !v)}
            className="shrink-0 rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-secondary hover:bg-hover hover:text-ink"
            title="输入任意自定义模型 ID"
          >
            {customInputOpen ? '收起' : '+ 自定义'}
          </button>
        </div>

        {customInputOpen && (
          <div className="flex items-center gap-1.5">
            <input
              value={customModelDraft}
              onChange={(e) => setCustomModelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSaveCustomModel()
              }}
              placeholder="如 anthropic/claude-opus-4 或 qwen3:32b"
              className="h-7 min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2.5 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={savingModel || !customModelDraft.trim()}
              onClick={() => void handleSaveCustomModel()}
            >
              应用
            </Button>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            onClick={() => void connectAccount(accountId).then(() => refresh())}
          >
            <RefreshCw className="size-3" aria-hidden />
            {t('Reconnect')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSettingsOpen(true, 'hermes-accounts')}
          >
            <Settings className="size-3" aria-hidden />
            {t('Configure')}
          </Button>
        </div>
      </div>
    </Section>
  )
}

export function HermesSessionsSection({
  accountId,
  botId
}: {
  accountId: string
  botId: string
}) {
  const [sessions, setSessions] = useState<HermesSessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const activeSessionId = useBotStore((s) => s.bots.find((b) => b.id === botId)?.activeSessionId)
  const switchHermesSession = useBotStore((s) => s.switchHermesSession)
  const startNewHermesSession = useBotStore((s) => s.startNewHermesSession)

  const refresh = useCallback(async () => {
    const hermes = getBridge()?.hermes
    if (!hermes?.rpc) return
    setLoading(true)
    setError(undefined)
    try {
      const res = await hermes.rpc({ accountId, op: 'listSessions', limit: 30 })
      if (!res.ok) {
        if (res.status === 404 || res.status === 405 || res.status === 501) {
          setSessions([])
          return
        }
        throw new Error(res.message)
      }
      setSessions(Array.isArray(res.data) ? (res.data as HermesSessionSummary[]) : [])
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh, activeSessionId])

  const handleDelete = async (sessionId: string) => {
    const hermes = getBridge()?.hermes
    if (!hermes?.rpc) return
    const res = await hermes.rpc({ accountId, op: 'deleteSession', sessionId })
    if (res.ok) {
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
    }
  }

  return (
    <Section
      title={t('Sessions')}
      count={sessions.length || undefined}
      action={
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void startNewHermesSession(botId).then((created) => { if (created) void refresh() })}
          >
            <MessageSquarePlus className="size-3.5" aria-hidden />
          </Button>
          <RefreshButton loading={loading} onClick={() => void refresh()} />
        </div>
      }
    >
      {error && <p className="pb-1 text-[12px] text-status-error">{error}</p>}
      {sessions.length === 0 ? (
        <EmptyLine>{t('No saved sessions yet')}</EmptyLine>
      ) : (
        <ul className="flex flex-col gap-1">
          {sessions.slice(0, 20).map((s) => {
            const active = s.id === activeSessionId
            return (
              <li
                key={s.id}
                className={cn(
                  'group flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 transition-colors',
                  active
                    ? 'border-accent-600/40 bg-accent-50'
                    : 'border-transparent hover:border-line hover:bg-hover'
                )}
              >
                <button
                  type="button"
                  onClick={() => void switchHermesSession(botId, s.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-[12.5px] font-medium text-ink">
                    {s.title || s.preview || s.id}
                  </p>
                  <p className="truncate text-[11px] text-ink-muted">
                    {[
                      s.model,
                      typeof s.messageCount === 'number' ? `${s.messageCount} msgs` : null
                    ]
                      .filter(Boolean)
                      .join(' · ') || s.id}
                  </p>
                </button>
                <button
                  type="button"
                  title={t('Delete')}
                  onClick={() => void handleDelete(s.id)}
                  className="shrink-0 rounded p-1 text-ink-muted opacity-0 transition-opacity hover:text-status-error group-hover:opacity-100"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

export function HermesJobsSection({ accountId }: { accountId: string }) {
  const [jobs, setJobs] = useState<HermesCronJob[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string>()

  const refresh = useCallback(async () => {
    const hermes = getBridge()?.hermes
    if (!hermes?.rpc) return
    setLoading(true)
    try {
      const res = await hermes.rpc({ accountId, op: 'listJobs' })
      if (res.ok && Array.isArray(res.data)) {
        setJobs(res.data as HermesCronJob[])
      }
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runJob = async (jobId: string) => {
    const hermes = getBridge()?.hermes
    if (!hermes?.rpc) return
    setBusyId(jobId)
    try {
      await hermes.rpc({ accountId, op: 'runJob', jobId })
      await refresh()
    } finally {
      setBusyId(undefined)
    }
  }

  const toggleJob = async (job: HermesCronJob) => {
    const hermes = getBridge()?.hermes
    if (!hermes?.rpc) return
    setBusyId(job.id)
    try {
      await hermes.rpc({ accountId, op: 'toggleJob', jobId: job.id, pause: !job.paused })
      await refresh()
    } finally {
      setBusyId(undefined)
    }
  }

  return (
    <Section
      title={t('Scheduled Jobs')}
      count={jobs.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      {jobs.length === 0 ? (
        <EmptyLine>{t('No scheduled jobs')}</EmptyLine>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {jobs.map((job) => (
            <li
              key={job.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-[12.5px] font-medium text-ink">
                  <Clock className="size-3 shrink-0 text-ink-muted" aria-hidden />
                  <span className="truncate">{job.name}</span>
                </p>
                <p className="truncate font-mono text-[11px] text-ink-muted">
                  {job.schedule}
                  {job.paused ? ' · paused' : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId === job.id}
                  onClick={() => void toggleJob(job)}
                  title={job.paused ? t('Resume') : t('Pause')}
                >
                  {job.paused ? <Play className="size-3" /> : <Pause className="size-3" />}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busyId === job.id}
                  onClick={() => void runJob(job.id)}
                >
                  {t('Run')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

export function HermesSkillsSection({ accountId }: { accountId: string }) {
  const [skills, setSkills] = useState<HermesSkillItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    const hermes = getBridge()?.hermes
    if (!hermes?.rpc) return
    setLoading(true)
    setError(undefined)
    try {
      const res = await hermes.rpc({ accountId, op: 'skills' })
      if (!res.ok) throw new Error(res.message)
      setSkills(Array.isArray(res.data) ? (res.data as HermesSkillItem[]) : [])
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <Section
      title={t('Skills')}
      count={skills.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      {error && <p className="pb-1 text-[12px] text-status-error">{error}</p>}
      {skills.length === 0 ? (
        <EmptyLine>{t('No installed skills')}</EmptyLine>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {skills.slice(0, 40).map((skill) => (
            <li key={skill.name} className="rounded-lg border border-line bg-surface px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium text-ink">
                  <Sparkles className="size-3 shrink-0 text-accent-600" aria-hidden />
                  <span className="truncate">{skill.name}</span>
                </span>
                {skill.category && (
                  <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[10px] text-ink-muted">
                    {skill.category}
                  </span>
                )}
              </div>
              {skill.description && (
                <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-[16px] text-ink-secondary">
                  {skill.description}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

export function HermesToolsetsSection({ accountId }: { accountId: string }) {
  const [toolsets, setToolsets] = useState<HermesToolsetItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    const hermes = getBridge()?.hermes
    if (!hermes?.rpc) return
    setLoading(true)
    setError(undefined)
    try {
      const res = await hermes.rpc({ accountId, op: 'toolsets' })
      if (!res.ok) throw new Error(res.message)
      setToolsets(Array.isArray(res.data) ? (res.data as HermesToolsetItem[]) : [])
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <Section
      title={t('Toolsets')}
      count={toolsets.filter((ts) => ts.enabled).length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      {error && <p className="pb-1 text-[12px] text-status-error">{error}</p>}
      {toolsets.length === 0 ? (
        <EmptyLine>{t('No toolsets reported')}</EmptyLine>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {toolsets.map((ts) => (
            <li key={ts.name} className="rounded-lg border border-line bg-surface px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium text-ink">
                  <Wrench className="size-3 shrink-0 text-ink-secondary" aria-hidden />
                  <span className="truncate">{ts.label || ts.name}</span>
                </span>
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                    ts.enabled
                      ? 'bg-status-online/15 text-status-online'
                      : 'bg-hover text-ink-muted'
                  )}
                >
                  {ts.enabled ? t('Enabled') : t('Off')}
                </span>
              </div>
              {ts.tools.length > 0 && (
                <p className="mt-1 truncate font-mono text-[10.5px] text-ink-muted">
                  {ts.tools.slice(0, 6).join(', ')}
                  {ts.tools.length > 6 ? ` +${ts.tools.length - 6}` : ''}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
