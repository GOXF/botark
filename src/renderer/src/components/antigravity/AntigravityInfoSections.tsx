import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  Cloud,
  Loader2,
  MessageSquare,
  RefreshCw,
  Trash2
} from 'lucide-react'
import type {
  AntigravityAgentInfo,
  AntigravityConversationSummary,
  AntigravityEnvironmentInfo,
  AntigravityModelInfo,
  AntigravityUserProfile,
  AntigravityWorkspaceInfo
} from '../../../../main/antigravity/antigravityProtocol'
import { getPlatform } from '@adapters/platforms'
import { EmptyLine, Section } from '@/components/info/Section'
import {
  ArkComposeNewSvg,
  ArkPromptSparkSvg,
  ArkWorkspaceVaultSvg
} from '@/components/ui/ArkGlyphs'
import { PlatformGlyph } from '@/components/ui/PlatformGlyph'
import { cn } from '@/lib/cn'
import { cleanSidebarError } from '@/lib/sidebarCompat'
import { t } from '@/lib/i18n'
import { useBotStore } from '@/store/botStore'
import { conversationRowProps } from '@/components/workspace/conversationDnd'

function agyBridge() {
  return typeof window !== 'undefined' ? window.electron?.antigravity : undefined
}

function relativeTime(ms?: number): string {
  if (!ms) return ''
  const diff = Math.max(0, Date.now() - ms)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export function AntigravityAccountAndModelSection({ accountId }: { accountId: string }) {
  const [profile, setProfile] = useState<AntigravityUserProfile | null>(null)
  const [models, setModels] = useState<AntigravityModelInfo[]>([])
  const [selectedModelEnum, setSelectedModelEnum] = useState<number | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const b = agyBridge()
    if (!b?.rpc) return
    setLoading(true)
    setError(null)
    try {
      const [profRes, modRes] = await Promise.all([
        b.rpc({ accountId, action: 'profile' }),
        b.rpc({ accountId, action: 'models' })
      ])
      if (profRes.ok) {
        setProfile((profRes.data as AntigravityUserProfile | null) ?? null)
      }
      if (modRes.ok && modRes.data && typeof modRes.data === 'object') {
        const d = modRes.data as { models?: AntigravityModelInfo[]; selectedModelEnum?: number }
        setModels(Array.isArray(d.models) ? d.models : [])
        setSelectedModelEnum(d.selectedModelEnum)
      } else if (!profRes.ok) {
        setError(cleanSidebarError(profRes.message) ?? null)
      }
    } catch (e) {
      setError(cleanSidebarError(e) ?? null)
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const selectModel = async (m: AntigravityModelInfo) => {
    const b = agyBridge()
    if (!b?.rpc) return
    setSelectedModelEnum(m.modelEnum)
    await b.rpc({
      accountId,
      action: 'setPrefs',
      modelEnum: m.modelEnum,
      modelDisplayName: m.displayName
    })
  }

  return (
    <Section
      title="Antigravity 模型与配额"
      action={
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="press-icon inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-hover hover:text-ink"
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          {t('Refresh')}
        </button>
      }
    >
      {profile && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2.5 py-2">
          <div className="min-w-0">
            <div className="truncate text-[12px] font-medium text-ink">{profile.email}</div>
            <div className="text-[11px] text-ink-muted">antigravity.google.com · Cloud Agent</div>
          </div>
          {profile.planDisplayName && (
            <span className="shrink-0 rounded-full bg-accent-50 px-2 py-0.5 text-[10.5px] font-medium text-accent-600">
              {profile.planDisplayName}
            </span>
          )}
        </div>
      )}

      {error && <p className="mb-2 text-[11.5px] text-status-error">{error}</p>}

      {models.length === 0 ? (
        <EmptyLine>{loading ? '加载可用模型…' : '登录后自动同步模型'}</EmptyLine>
      ) : (
        <div className="space-y-0.5">
          {models.map((m) => {
            const active =
              selectedModelEnum !== undefined ? selectedModelEnum === m.modelEnum : m.isDefault
            const pct =
              typeof m.remainingFraction === 'number'
                ? Math.max(0, Math.min(100, Math.round(m.remainingFraction * 100)))
                : undefined
            return (
              <button
                key={`${m.modelEnum}:${m.modelId}`}
                type="button"
                onClick={() => void selectModel(m)}
                className={cn(
                  'press flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors',
                  active
                    ? 'bg-surface text-ink shadow-xs ring-1 ring-line/70'
                    : 'text-ink-secondary hover:bg-hover/70 hover:text-ink'
                )}
              >
                <ArkPromptSparkSvg className={cn('size-3.5 shrink-0', active ? 'text-ink' : 'text-ink-muted')} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium">{m.displayName}</span>
                    {m.isDefault && (
                      <span className="rounded bg-surface-muted px-1 py-0.5 text-[9.5px] text-ink-muted">
                        默认
                      </span>
                    )}
                  </div>
                  {pct !== undefined && (
                    <div className="mt-1 flex items-center gap-1.5">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-muted">
                        <div
                          className="h-full rounded-full bg-accent-600"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-[10px] tabular-nums text-ink-muted">{pct}%</span>
                    </div>
                  )}
                </div>
                {active && <Check className="size-3.5 shrink-0 text-accent-600" />}
              </button>
            )
          })}
        </div>
      )}
    </Section>
  )
}

export function AntigravityConversationsSection({
  botId,
  accountId,
  activeSessionId
}: {
  botId: string
  accountId: string
  activeSessionId?: string
}) {
  const switchAntigravitySession = useBotStore((s) => s.switchAntigravitySession)
  const startNewAntigravitySession = useBotStore((s) => s.startNewAntigravitySession)
  const [items, setItems] = useState<AntigravityConversationSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const b = agyBridge()
    if (!b?.rpc) return
    setLoading(true)
    try {
      const res = await b.rpc({ accountId, action: 'listConversations', pageSize: 25 })
      if (res.ok && Array.isArray(res.data)) {
        setItems(res.data as AntigravityConversationSummary[])
      }
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh, activeSessionId])

  const remove = async (conversationId: string) => {
    const b = agyBridge()
    if (!b?.rpc) return
    setDeletingId(conversationId)
    try {
      const res = await b.rpc({ accountId, action: 'deleteConversation', conversationId })
      if (res.ok) {
        setItems((prev) => prev.filter((c) => c.conversationId !== conversationId))
        if (activeSessionId === conversationId) {
          startNewAntigravitySession(botId)
        }
      }
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <Section
      title="云端会话"
      count={items.length}
      action={
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => startNewAntigravitySession(botId)}
            className="press-icon inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-hover hover:text-ink"
          >
            <ArkComposeNewSvg className="size-3" />
            新建
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="press-icon inline-flex items-center rounded-full p-1 text-ink-muted hover:bg-hover hover:text-ink"
            aria-label={t('Refresh')}
          >
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          </button>
        </div>
      }
    >
      {items.length === 0 ? (
        <EmptyLine>{loading ? '正在拉取云端会话…' : '暂无云端会话'}</EmptyLine>
      ) : (
        <div className="max-h-64 space-y-0.5 overflow-y-auto pr-0.5">
          {items.map((conv) => {
            const active = conv.conversationId === activeSessionId
            return (
              <div
                key={conv.conversationId}
                className={cn(
                  'group flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 transition-colors',
                  active
                    ? 'bg-surface text-ink shadow-xs ring-1 ring-line/70'
                    : 'text-ink-secondary hover:bg-hover/70 hover:text-ink'
                )}
              >
                <button
                  type="button"
                  {...conversationRowProps(botId, conv.conversationId, conv.title)}
                  onClick={() => void switchAntigravitySession(botId, conv.conversationId)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <MessageSquare
                    className={cn('size-3.5 shrink-0', active ? 'text-accent-600' : 'text-ink-muted')}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium">{conv.title}</div>
                    <div className="flex items-center gap-1.5 text-[10.5px] text-ink-muted">
                      <span>{conv.stepCount} 步</span>
                      {conv.statusLabel === 'running' && (
                        <span className="text-accent-600">· 运行中</span>
                      )}
                      {conv.updatedAtMs > 0 && <span>· {relativeTime(conv.updatedAtMs)}</span>}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => void remove(conv.conversationId)}
                  disabled={deletingId === conv.conversationId}
                  aria-label="删除会话"
                  className="press-icon rounded-full p-1 text-ink-muted opacity-0 transition-opacity hover:bg-status-error/10 hover:text-status-error group-hover:opacity-100"
                >
                  {deletingId === conv.conversationId ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Trash2 className="size-3" />
                  )}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}

export function AntigravityEnvironmentsSection({ accountId }: { accountId: string }) {
  const [envs, setEnvs] = useState<AntigravityEnvironmentInfo[]>([])
  const [workspaces, setWorkspaces] = useState<AntigravityWorkspaceInfo[]>([])
  const [selectedCapsuleId, setSelectedCapsuleId] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    const b = agyBridge()
    if (!b?.rpc) return
    setLoading(true)
    try {
      const [envRes, wsRes] = await Promise.all([
        b.rpc({ accountId, action: 'environments' }),
        b.rpc({ accountId, action: 'workspaces' })
      ])
      if (envRes.ok && envRes.data && typeof envRes.data === 'object') {
        const d = envRes.data as {
          environments?: AntigravityEnvironmentInfo[]
          selectedCapsuleId?: string
        }
        setEnvs(Array.isArray(d.environments) ? d.environments : [])
        setSelectedCapsuleId(d.selectedCapsuleId)
      }
      if (wsRes.ok && Array.isArray(wsRes.data)) {
        setWorkspaces((wsRes.data as AntigravityWorkspaceInfo[]).filter((w) => !w.archived))
      }
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const pickCapsule = async (capsuleId?: string) => {
    const b = agyBridge()
    if (!b?.rpc) return
    setSelectedCapsuleId(capsuleId)
    await b.rpc({ accountId, action: 'setPrefs', capsuleId: capsuleId ?? '' })
  }

  return (
    <>
      <Section
        title="云端沙盒环境 (Capsules)"
        count={envs.length}
        action={
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="press-icon inline-flex items-center rounded-full p-1 text-ink-muted hover:bg-hover hover:text-ink"
          >
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          </button>
        }
      >
        {envs.length === 0 ? (
          <EmptyLine>{loading ? '正在加载云端沙盒…' : '使用默认 Google 托管云端环境'}</EmptyLine>
        ) : (
          <div className="space-y-1">
            {envs.map((env, idx) => {
              const id = env.capsuleId || `env-${idx}`
              const active = selectedCapsuleId ? selectedCapsuleId === env.capsuleId : env.isDefault
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => void pickCapsule(env.capsuleId)}
                  className={cn(
                    'press flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left',
                    active
                      ? 'border-accent bg-accent-50/70 text-ink'
                      : 'border-line bg-surface text-ink hover:bg-hover'
                  )}
                >
                  <Cloud className="size-3.5 shrink-0 text-accent-600" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium">
                      {env.capsuleId || 'Default Cloud Sandbox'}
                    </div>
                    {env.tags.length > 0 && (
                      <div className="truncate text-[10.5px] text-ink-muted">{env.tags.join(' · ')}</div>
                    )}
                  </div>
                  {active && <Check className="size-3.5 shrink-0 text-accent-600" />}
                </button>
              )
            })}
          </div>
        )}
      </Section>

      <Section title="工作区" count={workspaces.length}>
        {workspaces.length === 0 ? (
          <EmptyLine>暂无已同步工作区</EmptyLine>
        ) : (
          <div className="space-y-0.5">
            {workspaces.slice(0, 12).map((ws) => (
              <div
                key={ws.workspaceUri}
                className="flex items-center gap-2 rounded-xl px-2.5 py-1.5 hover:bg-hover/60"
              >
                <ArkWorkspaceVaultSvg className="size-3.5 shrink-0 text-ink-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-ink">{ws.displayName}</div>
                  <div className="truncate font-mono text-[10px] text-ink-muted">{ws.workspaceUri}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  )
}

export function AntigravityAgentsSection({ accountId }: { accountId: string }) {
  const [agents, setAgents] = useState<AntigravityAgentInfo[]>([])
  const [selectedAgentPath, setSelectedAgentPath] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    const b = agyBridge()
    if (!b?.rpc) return
    setLoading(true)
    try {
      const res = await b.rpc({ accountId, action: 'agents' })
      if (res.ok && res.data && typeof res.data === 'object') {
        const d = res.data as { agents?: AntigravityAgentInfo[]; selectedAgentPath?: string }
        setAgents(Array.isArray(d.agents) ? d.agents : [])
        setSelectedAgentPath(d.selectedAgentPath)
      }
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const pickAgent = async (agentId?: string) => {
    const b = agyBridge()
    if (!b?.rpc) return
    const next = selectedAgentPath === agentId ? undefined : agentId
    setSelectedAgentPath(next)
    await b.rpc({ accountId, action: 'setPrefs', agentPath: next ?? '' })
  }

  return (
    <Section
      title="云端 Agents"
      count={agents.length}
      action={
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="press-icon inline-flex items-center rounded-full p-1 text-ink-muted hover:bg-hover hover:text-ink"
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
        </button>
      }
    >
      {agents.length === 0 ? (
        <EmptyLine>{loading ? '加载云端 Agents…' : '默认通用 Antigravity Agent'}</EmptyLine>
      ) : (
        <div className="space-y-0.5">
          {agents.map((ag) => {
            const active = selectedAgentPath === ag.agentId
            return (
              <button
                key={ag.agentId}
                type="button"
                onClick={() => void pickAgent(ag.agentId)}
                className={cn(
                  'press flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors',
                  active
                    ? 'bg-surface text-ink shadow-xs ring-1 ring-line/70'
                    : 'text-ink-secondary hover:bg-hover/70 hover:text-ink'
                )}
              >
                <PlatformGlyph platform={getPlatform('antigravity')} size="sm" className="size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium">{ag.displayName}</div>
                  <div className="truncate font-mono text-[10px] text-ink-muted">{ag.agentId}</div>
                </div>
                {active && <Check className="size-3.5 shrink-0 text-accent-600" />}
              </button>
            )
          })}
        </div>
      )}
    </Section>
  )
}
