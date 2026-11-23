import { useCallback, useEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  Plus
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
import { ArkProjectStackSvg } from '@/components/ui/ArkGlyphs'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Field'
import { MENU_SURFACE } from '@/components/ui/Menu'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useOverlayLock } from '@/lib/overlay'
import { useBotStore } from '@/store/botStore'

async function rpc(request: HarkRpcRequest) {
  const result = await getBridge()?.hark.rpc(request)
  if (!result?.ok) throw new Error(result?.message ?? 'Hark unavailable')
  return result.data
}

const PROJECTS_CHANGED = 'bothub:hark-projects'

export function HarkProjects({ botId, compact }: { botId: string; compact?: boolean }) {
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
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [revision, setRevision] = useState(0)
  const lastFetchAt = useRef(0)

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
    }
    return () => {
      current = false
    }
  }, [accountId, connected, revision])

  const projects = mergePendingHarkProjects(serverProjects, pending, Date.now())

  useEffect(() => {
    const hark = getBridge()?.hark
    const conversationId = bot.activeSessionId
    if (!compact || !connected || !conversationId || !hark) return
    const subscription = crypto.randomUUID()
    const off = hark.onEvent((e) => {
      if (e.type === 'projectHistory' && e.subscription === subscription) {
        useBotStore.getState().applyHarkHistory(botId, accountId, conversationId, e.messages)
      }
    })
    void rpc({ op: 'observeProject', accountId, conversationId, subscription }).catch((e) =>
      setError(String(e instanceof Error ? e.message : e))
    )
    return () => {
      off()
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

  const createProject = () =>
    perform(async () => {
      const name = title.trim()
      if (!name) return
      const id = await useBotStore.getState().startNewHarkSession(botId, name)
      setAdding(false)
      setMenuOpen(false)
      setTitle('')
      changed(id ? { id, title: name, createdAt: Date.now() } : undefined)
      // Hark's list can trail the create; check again shortly after.
      window.setTimeout(() => changed(), 3_000)
    })

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

  if (!connected) return null

  const activeProject = projects.find((p) => p.id === bot.activeSessionId)
  const visibleProjects = projects.filter((p) => !p.archived || p.id === bot.activeSessionId)
  const archivedProjects = projects.filter((p) => p.archived && p.id !== bot.activeSessionId)

  if (compact) {
    return (
      <div className="no-drag flex min-w-0 items-center gap-1.5">
        <DropdownMenu.Root
          open={menuOpen}
          onOpenChange={(next) => {
            setMenuOpen(next)
            if (!next) setAdding(false)
          }}
        >
          <DropdownMenu.Trigger
            type="button"
            disabled={busy}
            aria-label="切换 Hark 项目"
            className={cn(
              'group press inline-flex h-8 max-w-52 min-w-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-ink outline-none select-none',
              'border-[0.5px] border-line-strong bg-main shadow-soft hover:bg-surface data-[state=open]:bg-surface',
              'disabled:pointer-events-none disabled:opacity-45'
            )}
          >
            {busy ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-accent-600" />
            ) : (
              <ArkProjectStackSvg className="size-3.5 shrink-0 text-accent-600" />
            )}
            <span className="truncate">{activeProject?.title ?? '当前项目'}</span>
            <ChevronDown
              aria-hidden
              className="size-3.5 shrink-0 text-ink-muted transition-transform duration-200 ease-spring-tap group-data-[state=open]:rotate-180"
            />
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={8}
              collisionPadding={12}
              className={cn(
                'no-drag z-50 flex w-72 flex-col overflow-hidden origin-(--radix-dropdown-menu-content-transform-origin)',
                MENU_SURFACE,
                'data-[side=bottom]:animate-pop-drop data-[side=top]:animate-pop-lift data-[state=closed]:animate-pop-out'
              )}
            >
              <div className="flex items-center justify-between px-2.5 pt-1 pb-1.5">
                <span className="text-[11px] font-semibold tracking-tight text-ink-muted">
                  Hark 项目工作空间 ({visibleProjects.length})
                </span>
                <button
                  type="button"
                  onClick={() => setAdding((v) => !v)}
                  className="press inline-flex items-center gap-1 rounded-full bg-accent-50 px-2 py-0.5 text-[11px] font-semibold text-accent-600 hover:bg-accent-100"
                >
                  <Plus className="size-3" />
                  新建项目
                </button>
              </div>

              {adding && (
                <form
                  onKeyDown={(e) => e.stopPropagation()}
                  onSubmit={(e) => {
                    e.preventDefault()
                    void createProject()
                  }}
                  className="mb-1.5 flex items-center gap-1.5 rounded-xl border border-line bg-sunken/50 p-1.5"
                >
                  <TextInput
                    autoFocus
                    aria-label="项目名称"
                    placeholder="输入新项目名称…"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="h-7 flex-1 text-[12px]"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="primary"
                    disabled={busy || !title.trim()}
                    className="h-7 px-2.5 text-[11.5px]"
                  >
                    创建
                  </Button>
                </form>
              )}

              <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto py-0.5">
                {visibleProjects.map((p) => {
                  const isCurrent = p.id === bot.activeSessionId
                  return (
                    <DropdownMenu.Item
                      key={p.id}
                      onSelect={() => void select(p.id)}
                      className={cn(
                        'flex min-h-[32px] cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink outline-none select-none',
                        'transition-colors duration-100 data-[highlighted]:bg-hover',
                        isCurrent && 'bg-accent-50/70 font-medium'
                      )}
                    >
                      <span
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          isCurrent ? 'bg-accent-600' : 'bg-ink-faint'
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                      {p.main && (
                        <span className="rounded-full bg-hover px-1.5 py-0.2 text-[10px] text-ink-muted">
                          默认
                        </span>
                      )}
                      <Check
                        aria-hidden
                        className={cn(
                          'size-3.5 shrink-0 text-accent-600',
                          isCurrent ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </DropdownMenu.Item>
                  )
                })}
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        {error && (
          <span role="alert" className="max-w-44 truncate text-[11.5px] text-status-error">
            {error}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 text-[12px]">
      {/* Quick Add Project Bar */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-ink-muted">
          项目 ({visibleProjects.length})
        </span>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="press inline-flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-ink hover:bg-active"
        >
          <Plus className="size-3 text-accent-600" />
          {adding ? '取消' : '新建'}
        </button>
      </div>

      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void createProject()
          }}
          className="flex items-center gap-1.5 animate-veil-in"
        >
          <TextInput
            autoFocus
            aria-label="项目名称"
            placeholder="输入项目名称…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-8 flex-1 text-[12px]"
          />
          <Button type="submit" size="sm" variant="primary" disabled={busy || !title.trim()}>
            创建
          </Button>
        </form>
      )}

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
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    isCurrent ? 'bg-accent-600' : 'bg-ink-faint'
                  )}
                />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-[12.5px]',
                    isCurrent ? 'font-semibold text-ink' : 'font-medium text-ink'
                  )}
                >
                  {p.title}
                </span>
                {p.main && (
                  <span className="shrink-0 text-[10.5px] text-ink-muted">默认</span>
                )}
              </button>

              {!p.main && (
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <button
                    type="button"
                    disabled={busy}
                    title="在线预览"
                    aria-label={`预览 ${p.title}`}
                    onClick={() => void openPreview(p.id)}
                    className="press-icon grid size-6 place-items-center rounded-full text-ink-secondary hover:bg-active hover:text-accent-600 disabled:opacity-35"
                  >
                    <ExternalLink className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    title="归档"
                    aria-label={`归档 ${p.title}`}
                    onClick={() => void toggleArchive(p)}
                    className="press-icon grid size-6 place-items-center rounded-full text-ink-secondary hover:bg-active hover:text-ink disabled:opacity-35"
                  >
                    <Archive className="size-3.5" />
                  </button>
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
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void toggleArchive(p)}
                    className="press inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-secondary shadow-hairline hover:text-ink"
                  >
                    <ArchiveRestore className="size-3" />
                    恢复
                  </button>
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
