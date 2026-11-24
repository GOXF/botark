import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  ExternalLink,
  Loader2,
  Plus,
  Trash2
} from 'lucide-react'
import {
  HARK_PROJECTS_POLL_MS,
  harkProjects,
  mergePendingHarkProjects,
  prunePendingHarkProjects,
  shouldRefreshHarkProjects,
  type HarkPendingProject,
  type HarkProject
} from '@shared/harkProjects'
import type { HarkRpcRequest } from '@shared/ipc'
import { HARK_DRAFT_SESSION } from '@shared/harkProjects'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useOverlayLock } from '@/lib/overlay'
import { useBotStore } from '@/store/botStore'
import type { HarkProjectWork } from '@/lib/harkWork'
import { noteHarkRun, useHarkWork } from '@/services/harkWork'
import { useConversationTitles } from '@/services/workspaceSync'

async function rpc(request: HarkRpcRequest) {
  const result = await getBridge()?.hark.rpc(request)
  if (!result?.ok) throw new Error(result?.message ?? 'Hark unavailable')
  return result.data
}

const PROJECTS_CHANGED = 'bothub:hark-projects'

/** GOXF: Hark-style state per project: spinner "工作中", amber "完成" until opened. */
function WorkDot({ work, current }: { work?: HarkProjectWork; current: boolean }) {
  if (work?.working) return <Loader2 aria-hidden className="size-3 shrink-0 animate-spin text-status-busy" />
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        work?.doneAt ? 'bg-status-attention' : current ? 'bg-accent-600' : 'bg-ink-faint'
      )}
    />
  )
}

function WorkLabel({ work }: { work?: HarkProjectWork }) {
  if (work?.working) return <span className="shrink-0 text-[10.5px] font-medium text-status-busy-ink">工作中</span>
  if (work?.doneAt) return <span className="shrink-0 text-[10.5px] font-medium text-status-attention-ink">完成</span>
  return null
}

const DEFAULT_TAG = (
  <span className="shrink-0 rounded-full bg-hover px-1.5 text-[10px] leading-4 text-ink-muted">默认</span>
)

/** Same delete control in the active and archived lists; the second click deletes. */
function DeleteProjectButton({ confirming, disabled, onClick }: { confirming: boolean; disabled: boolean; onClick: () => void }) {
  return confirming ? (
    <Button size="sm" variant="danger-confirm" disabled={disabled} title="再点一次删除" onClick={onClick}>
      确认删除
    </Button>
  ) : (
    <IconButton size="sm" label="删除" disabled={disabled} className="hover:text-status-error" onClick={onClick}>
      <Trash2 />
    </IconButton>
  )
}

export function HarkProjects({
  botId,
  compact,
  onLoadingChange
}: {
  botId: string
  compact?: boolean
  /** Lets a parent refresh button spin while the list is being fetched. */
  onLoadingChange?: (loading: boolean) => void
}) {
  const bot = useBotStore((s) => s.bots.find((b) => b.id === botId))!
  const accountId = bot.activeAccountId
  const connected = useBotStore((s) =>
    ['online', 'busy'].includes(s.accounts[accountId]?.status ?? '')
  )
  const [serverProjects, setServerProjects] = useState<HarkProject[]>([])
  const [pending, setPending] = useState<HarkPendingProject[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const [showArchived, setShowArchived] = useState(false)
  const [revision, setRevision] = useState(0)
  const lastFetchAt = useRef(0)
  const onLoadingRef = useRef(onLoadingChange)
  onLoadingRef.current = onLoadingChange
  const work = useHarkWork((s) => s.projects[accountId])

  useOverlayLock(menuOpen)

  const invalidate = useCallback(() => setRevision((n) => n + 1), [])
  const refreshSoon = useCallback(() => {
    if (shouldRefreshHarkProjects(lastFetchAt.current, Date.now())) invalidate()
  }, [invalidate])

  useEffect(() => {
    setPending([])
    lastFetchAt.current = 0
  }, [accountId])

  useEffect(() => {
    const onChanged = (event: Event) => {
      const created = (event as CustomEvent<{ accountId?: string; project?: HarkPendingProject }>).detail
      if (created?.project && created.accountId === accountId) {
        const project = created.project
        setPending((list) => [...list.filter((p) => p.id !== project.id), project])
      }
      invalidate()
    }
    window.addEventListener(PROJECTS_CHANGED, onChanged)
    return () => window.removeEventListener(PROJECTS_CHANGED, onChanged)
  }, [accountId, invalidate])

  // Projects created / renamed / archived in Hark's web app only reach BotArk
  // through a re-fetch: refresh on window focus and poll while visible.
  useEffect(() => {
    if (!connected) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshSoon()
    }
    window.addEventListener('focus', refreshSoon)
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') invalidate()
    }, HARK_PROJECTS_POLL_MS)
    return () => {
      window.removeEventListener('focus', refreshSoon)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(timer)
    }
  }, [connected, invalidate, refreshSoon])

  useEffect(() => {
    if (menuOpen) refreshSoon()
  }, [menuOpen, refreshSoon])

  useEffect(() => {
    let current = true
    if (connected) {
      lastFetchAt.current = Date.now()
      onLoadingRef.current?.(true)
      void rpc({ accountId, op: 'listConversations' })
        .then(harkProjects)
        .then((rows) => {
          if (current) {
            setServerProjects(rows)
            setPending((list) => prunePendingHarkProjects(rows, list, Date.now()))
            setError('')
          }
        })
        .catch((e) => {
          if (current) setError(String(e instanceof Error ? e.message : e))
        })
        .finally(() => {
          if (current) onLoadingRef.current?.(false)
        })
    }
    return () => {
      current = false
    }
  }, [accountId, connected, revision])

  const projects = mergePendingHarkProjects(serverProjects, pending, Date.now())

  // GOXF Issue #7: pane tabs label Hark tabs by project title.
  useEffect(() => {
    if (!serverProjects.length) return
    useConversationTitles.setState(Object.fromEntries(serverProjects.map((p) => [p.id, p.title])))
  }, [serverProjects])

  useEffect(() => {
    const hark = getBridge()?.hark
    const conversationId = bot.activeSessionId
    if (!compact || !connected || !conversationId || !hark) return
    const subscription = crypto.randomUUID()
    let liveBusy = false
    const off = hark.onEvent((e) => {
      if (e.type === 'projectHistory' && e.subscription === subscription) {
        const store = useBotStore.getState()
        store.applyHarkHistory(botId, accountId, conversationId, e.messages)
        // GOXF: a pending ask (code / sign-in / approval) wins over the live line: 「需要你：…」.
        const ask = e.asks?.[0]
        if (ask) {
          liveBusy = true
          store.setActivity(accountId, { code: 'waiting', text: `需要你：${ask.prompt}`.slice(0, 120), emoji: null, busy: true })
        } else if (e.live?.busy) {
          noteHarkRun(accountId, conversationId)
          liveBusy = true
          store.setTyping(botId, true)
          // GOXF: two feeds write this line (the send tail and this project stream); an empty
          // reading must not wipe the live sentence the other one just set.
          const prev = store.activity[accountId]
          const keep = prev && prev.code === 'thinking' ? prev.text : null
          store.setActivity(accountId, { code: 'thinking', text: e.live.text || keep || null, emoji: null, busy: true })
        } else if (e.live && liveBusy) {
          liveBusy = false
          store.setTyping(botId, false)
          store.setActivity(accountId, null)
        }
      }
    })
    void rpc({ op: 'observeProject', accountId, conversationId, subscription }).catch((e) =>
      setError(String(e instanceof Error ? e.message : e))
    )
    return () => {
      off()
      if (liveBusy) {
        useBotStore.getState().setTyping(botId, false)
        useBotStore.getState().setActivity(accountId, null)
      }
      void rpc({ op: 'leaveProject', accountId, subscription }).catch(() => {})
    }
  }, [compact, connected, accountId, botId, bot.activeSessionId])

  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const select = (id: string) =>
    perform(async () => {
      await useBotStore.getState().switchHarkSession(botId, id)
      setMenuOpen(false)
    })

  const changed = (project?: HarkPendingProject) =>
    window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED, { detail: { accountId, project } }))

  // Like Hark's web app: 新建 opens an empty draft; the project is created (untitled, Hark names
  // it) when the first message is sent. Leaving the draft without sending keeps nothing.
  const createProject = () => {
    useBotStore.getState().startHarkDraft(botId)
    setMenuOpen(false)
  }

  // The draft just became a real project: show it now; Hark's list (and its auto title) can trail.
  const prevSession = useRef(bot.activeSessionId)
  useEffect(() => {
    const prev = prevSession.current
    prevSession.current = bot.activeSessionId
    if (prev !== HARK_DRAFT_SESSION || !bot.activeSessionId || bot.activeSessionId === HARK_DRAFT_SESSION) return
    changed({ id: bot.activeSessionId, title: '新项目', createdAt: Date.now() })
    const timers = [3_000, 15_000].map((ms) => window.setTimeout(() => changed(), ms))
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [bot.activeSessionId])

  const openPreview = (projectId: string) =>
    perform(async () => {
      const data = await rpc({
        accountId,
        op: 'call',
        path: `/project/${encodeURIComponent(projectId)}/preview-url`
      })
      const url = (data as { url?: string })?.url
      if (!url || new URL(url).protocol !== 'https:') throw new Error('该项目暂无可用在线预览')
      await getBridge()?.muse.openHttps(url)
    })

  const toggleArchive = (p: HarkProject) =>
    perform(async () => {
      await rpc({
        accountId,
        op: 'call',
        method: 'POST',
        path: `/conversations/${encodeURIComponent(p.id)}/${p.archived ? 'unarchive' : 'archive'}`
      })
      changed()
      const main = projects.find((row) => row.main)
      if (!p.archived && bot.activeSessionId === p.id && main) {
        await useBotStore.getState().switchHarkSession(botId, main.id)
      }
    })

  // GOXF: delete a project for good (DELETE /conversations/:id, as Hark web does); second click confirms.
  const deleteProject = (p: HarkProject) => {
    if (confirmDelete !== p.id) {
      setConfirmDelete(p.id)
      return
    }
    setConfirmDelete(undefined)
    return perform(async () => {
      await rpc({ accountId, op: 'call', method: 'DELETE', path: `/conversations/${encodeURIComponent(p.id)}` })
      const main = projects.find((row) => row.main)
      if (bot.activeSessionId === p.id && main) {
        await useBotStore.getState().switchHarkSession(botId, main.id)
      }
      changed()
    })
  }

  if (!connected) return null

  const visibleProjects = projects.filter((p) => !p.archived || p.id === bot.activeSessionId)
  const archivedProjects = projects.filter((p) => p.archived && p.id !== bot.activeSessionId)

  // GOXF: the header copy only runs the live feed above; the picker lives in the right panel.
  if (compact) return null

  return (
    <div className="flex flex-col gap-2 text-[12px]">
      {/* Quick Add Project Bar */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-ink-muted">
          项目 ({visibleProjects.length})
        </span>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void createProject()}>
          <Plus />
          新建项目
        </Button>
      </div>

      {/* Active Projects List */}
      <ul className="flex flex-col gap-0.5">
        {visibleProjects.map((p) => {
          const isCurrent = bot.activeSessionId === p.id
          return (
            <li
              key={p.id}
              className={cn(
                'group flex items-center gap-2 rounded-xl px-2 py-1.5 transition-colors',
                isCurrent ? 'bg-active text-ink' : 'hover:bg-hover text-ink'
              )}
            >
              <button
                type="button"
                disabled={busy}
                aria-current={isCurrent}
                onClick={() => void select(p.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
              >
                <WorkDot work={work?.[p.id]} current={isCurrent} />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-[12.5px]',
                    isCurrent ? 'font-semibold text-ink' : 'font-medium text-ink'
                  )}
                >
                  {p.title}
                </span>
                <WorkLabel work={work?.[p.id]} />
                {p.main && DEFAULT_TAG}
              </button>

              {!p.main && (
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <IconButton size="sm" label="在线预览" disabled={busy} onClick={() => void openPreview(p.id)}>
                    <ExternalLink />
                  </IconButton>
                  <IconButton size="sm" label="归档" disabled={busy} onClick={() => void toggleArchive(p)}>
                    <Archive />
                  </IconButton>
                  <DeleteProjectButton confirming={confirmDelete === p.id} disabled={busy} onClick={() => void deleteProject(p)} />
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {/* Archived Projects Collapsible */}
      {archivedProjects.length > 0 && (
        <div className="pt-0.5">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="text-[11px] font-medium text-ink-muted hover:text-ink-secondary"
          >
            {showArchived ? '收起已归档项目' : `已归档项目 (${archivedProjects.length})`}
          </button>
          {showArchived && (
            <ul className="mt-1.5 flex flex-col gap-1 animate-veil-in">
              {archivedProjects.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-line/70 bg-sunken/40 px-2.5 py-1.5 text-ink-muted"
                >
                  <span className="truncate text-[12px]">{p.title}</span>
                  <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void toggleArchive(p)}
                    className="press inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-secondary shadow-hairline hover:text-ink"
                  >
                    <ArchiveRestore className="size-3" />
                    恢复
                  </button>
                  <DeleteProjectButton confirming={confirmDelete === p.id} disabled={busy} onClick={() => void deleteProject(p)} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-[11.5px] text-status-error">
          {error}
        </p>
      )}
    </div>
  )
}
