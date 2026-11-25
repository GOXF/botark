import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { BotAvatar } from '@/components/ui/Avatar'
import { activityPhrase, formatShortTime, previewText } from '@/components/sidebar/BotListItem'
import { BOARD_COLUMNS, classifyBot, classifyRoom, type BoardColumn } from '@/lib/boardStatus'
import { cn } from '@/lib/cn'
import { accountWork } from '@/lib/harkWork'
import { lastMessage } from '@/lib/selectors'
import { RoomAvatarCluster } from '@/rooms/RoomAvatarCluster'
import { useRooms } from '@/rooms/roomStore'
import { useHarkWork } from '@/services/harkWork'
import { asksForAccount, useConversationTitles, useHarkAskCounts } from '@/services/workspaceSync'
import { usePanes } from '@/store/paneStore'
import { getBridge } from '@/lib/bridge'
import { harkProjects } from '@shared/harkProjects'
import { deriveTasks, type HarkSnapshotLike, type HarkSubtask, type HarkTask } from '@/lib/harkSubtasks'
import { openConversationTab } from './conversationDnd'
import { useBotStore } from '@/store/botStore'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { PipelineView } from '@/pipeline/PipelineView'
import { usePipeline, type BoardMode } from '@/pipeline/pipelineStore'

interface Card {
  key: string
  id: string
  column: BoardColumn
  title: string
  step: string
  time: number
  room: boolean
  /** v25: a Hark project card — its account, conversation, and the bot it belongs to. */
  project?: { botId: string; botName: string; accountId: string; conversationId: string; working: boolean }
}

const COLUMN_STYLE: Record<BoardColumn, { dot: string; head: string }> = {
  wait: { dot: 'bg-status-attention', head: 'text-status-attention-ink' },
  run: { dot: 'bg-status-busy', head: 'text-status-busy-ink' },
  fail: { dot: 'bg-status-error', head: 'text-status-error' },
  done: { dot: 'bg-status-online', head: 'text-ink' },
  idle: { dot: 'bg-ink-faint', head: 'text-ink-muted' }
}

/** Re-render every 30 s so "3m ago" stays true. */
function useMinuteTick(): void {
  const [, set] = useState(0)
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])
}

/**
 * GOXF v12 看板: every conversation and group chat, sorted into five columns
 * by what it needs. A card says who, what it is doing now, and when; a click
 * opens it (a bot on the 会话 page, a group on 协作).
 */
export function BoardView() {
  const scope = usePanes((s) => s.scope)
  const mode = usePipeline((s) => s.mode)
  if (scope === 'sessions') return <StatusBoard scope="sessions" />
  const toggle = (
    <SegmentedControl<BoardMode>
      aria-label="任务视图"
      size="xs"
      value={mode}
      onValueChange={(v) => usePipeline.setState({ mode: v })}
      options={[{ value: 'status', label: '状态' }, { value: 'pipeline', label: '流水线' }]}
    />
  )
  if (mode === 'pipeline') return <PipelineView toggle={toggle} />
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center px-4">{toggle}</div>
      <StatusBoard scope={scope} />
    </div>
  )
}

/** v25: 任务 in the sidebar (all) shows everything; the top 任务 tab shows the selected bot's or group's. */
function StatusBoard({ scope }: { scope: 'sessions' | 'collab' | 'all' }) {
  useMinuteTick()
  const titles = useConversationTitles()
  const [picked, setPicked] = useState<Card['project'] & { title: string }>()
  const projectIds = useProjectTitles(scope !== 'collab')
  const { bots, accounts, typing, activity, messages } = useBotStore(
    useShallow((s) => ({ bots: s.bots, accounts: s.accounts, typing: s.typing, activity: s.activity, messages: s.messages }))
  )
  const selectBot = useBotStore((s) => s.selectBot)
  const work = useHarkWork()
  const asks = useHarkAskCounts()
  const { rooms, speakers, errors } = useRooms(useShallow((s) => ({ rooms: s.rooms, speakers: s.speakers, errors: s.errors })))

  const cards: Card[] = []
  const selectedId = useBotStore((s) => s.selectedBotId)
  for (const bot of scope === 'collab' ? [] : scope === 'sessions' ? bots.filter((b) => b.id === selectedId) : bots) {
    // v25: a Hark bot shows one card per project with something going on; the bot card only when none.
    if (bot.platformId === 'hark') {
      let shown = 0
      for (const accountId of bot.accountIds) {
        // v26: every project of the account, so idle ones sit in 空闲 instead of vanishing.
        const ids = new Set([...(projectIds[accountId] ?? []), ...Object.keys(work.projects[accountId] ?? {})])
        for (const conversationId of ids) {
          const pw = work.projects[accountId]?.[conversationId] ?? { working: false, since: 0, doneAt: 0 }
          const projectAsks = asks[accountId]?.[conversationId] ?? 0
          const fresh = pw.doneAt > (work.seenAt[accountId] ?? 0)
          shown++
          const column = classifyBot({ typing: false, live: false, harkWorking: pw.working ? 1 : 0, harkDoneAt: fresh ? pw.doneAt : 0, asks: projectAsks, unread: 0 })
          cards.push({
            key: `p:${accountId}:${conversationId}`,
            id: bot.id,
            column,
            title: titles[conversationId] || '项目',
            step: column === 'wait' ? '有一步要你确认' : pw.working ? '工作中' : column === 'done' ? '已完成' : '空闲',
            time: Math.max(pw.since || 0, pw.doneAt || 0),
            room: false,
            project: { botId: bot.id, botName: bot.name, accountId, conversationId, working: pw.working }
          })
        }
      }
      if (shown > 0) continue
    }
    const acc = accounts[bot.activeAccountId]
    const act = activity[bot.activeAccountId]
    const last = lastMessage(messages[bot.id])
    const w = bot.platformId === 'hark' ? accountWork(work, bot.accountIds) : { working: 0, doneAt: 0 }
    const ask = bot.accountIds.reduce((n, id) => n + asksForAccount(asks, id), 0)
    const column = classifyBot({
      typing: typing[bot.id] === true,
      live: Boolean(activityPhrase(act)),
      harkWorking: w.working,
      harkDoneAt: w.doneAt,
      asks: ask,
      accountStatus: acc?.status,
      lastDelivery: last?.delivery,
      lastRole: last?.role,
      unread: bot.unread
    })
    const step =
      column === 'wait' && ask > 0
        ? '有一步要你确认'
        : column === 'fail' && acc?.status === 'error'
          ? acc.statusDetail || '连接出错'
          : w.working > 0 && !typing[bot.id]
            ? `${w.working} 个项目工作中`
            : previewText(last, typing[bot.id] === true, act) || (acc?.status === 'offline' ? '离线' : '还没有消息')
    cards.push({
      key: `b:${bot.id}`,
      id: bot.id,
      column,
      title: bot.name,
      step,
      time: Math.max(last?.createdAt ?? 0, w.doneAt || 0),
      room: false
    })
  }
  for (const room of scope === 'sessions' ? [] : scope === 'collab' ? rooms.filter((r) => r.id === selectedId) : rooms) {
    const last = room.messages[room.messages.length - 1]
    const speaking = speakers[room.id]
    cards.push({
      key: `r:${room.id}`,
      id: room.id,
      column: classifyRoom({ speaking: Boolean(speaking), error: Boolean(errors[room.id]) }),
      title: room.title,
      step: errors[room.id] || (speaking ? `${speaking} 正在发言` : last ? `${last.author}：${last.text.replace(/\s+/g, ' ')}` : '还没有消息'),
      time: last?.createdAt ?? 0,
      room: true
    })
  }

  // v26: entering a bot's 任务 opens the project you are looking at in the right panel.
  const current = scope === 'sessions' ? cards.find((c) => c.project && c.project.botId === selectedId && c.project.conversationId === bots.find((b) => b.id === selectedId)?.activeSessionId) : undefined
  const currentKey = current?.key
  useEffect(() => {
    if (current?.project) setPicked({ ...current.project, title: current.title })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey])

  return (
    <div className={cn('flex min-h-0 flex-1', scope === 'sessions' && 'pt-3')}>
    <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto px-4 pb-4">
      {BOARD_COLUMNS.map((col) => {
        const list = cards.filter((c) => c.column === col.id).sort((a, b) => b.time - a.time)
        return (
          <section key={col.id} aria-label={col.label} className="flex min-w-[220px] flex-1 flex-col rounded-[14px] bg-canvas/60">
            <header className="flex h-10 shrink-0 items-center gap-2 px-3">
              <span className={cn('size-2 rounded-full', COLUMN_STYLE[col.id].dot)} />
              <h3 className={cn('text-[13px] font-semibold', COLUMN_STYLE[col.id].head)}>{col.label}</h3>
              <span className="text-[12px] text-ink-muted">{list.length}</span>
            </header>
            <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {list.map((card) => {
                const bot = card.room ? undefined : bots.find((b) => b.id === card.id)
                const room = card.room ? rooms.find((r) => r.id === card.id) : undefined
                return (
                  <li key={card.key}>
                    <button
                      type="button"
                      onClick={() => (card.project ? setPicked({ ...card.project, title: card.title }) : selectBot(card.id))}
                      className={cn(
                        'press flex w-full flex-col gap-1.5 rounded-[12px] border bg-main p-3 text-left shadow-soft transition-colors hover:border-line-strong',
                        card.project && picked?.conversationId === card.project.conversationId
                          ? 'border-accent-600 ring-1 ring-accent-600'
                          : card.column === 'wait' ? 'border-status-attention/50' : card.column === 'fail' ? 'border-status-error/40' : 'border-line'
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {bot ? (
                          <BotAvatar
                            emoji={bot.emoji}
                            seed={bot.id}
                            avatar={bot.avatar}
                            avatarShape={bot.avatarShape}
                            avatarColor={bot.avatarColor}
                            platformId={bot.platformId}
                            size="xs"
                          />
                        ) : room ? (
                          <RoomAvatarCluster members={room.members.slice(0, 3)} size="xs" />
                        ) : null}
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{card.title}</span>
                        {card.project && <span className="max-w-[45%] shrink-0 truncate rounded-full bg-hover px-1.5 text-[10.5px] text-ink-muted">{card.project.botName}</span>}
                        {card.room && <span className="shrink-0 rounded-full bg-hover px-1.5 text-[10.5px] text-ink-muted">群聊</span>}
                        <span className="shrink-0 text-[11px] text-ink-muted">{formatShortTime(card.time || undefined)}</span>
                      </span>
                      <span className="flex min-w-0 items-start gap-1.5">
                        {card.column === 'run' && <Loader2 aria-hidden className="mt-[3px] size-3 shrink-0 animate-spin text-status-busy" />}
                        <span
                          className={cn(
                            'line-clamp-2 text-[12.5px] leading-[18px]',
                            card.column === 'wait' ? 'font-medium text-status-attention-ink' : 'text-ink-secondary'
                          )}
                        >
                          {card.step}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
              {list.length === 0 && <li className="px-2 py-6 text-center text-[12px] text-ink-faint">没有</li>}
            </ol>
          </section>
        )
      })}
    </div>
    {picked && <ProjectDetail key={picked.conversationId} project={picked} onClose={() => setPicked(undefined)} />}
    </div>
  )
}

/** v25: fill missing project titles once per Hark account (the project menu fills them only when opened). */
function useProjectTitles(on: boolean): Record<string, string[]> {
  const [ids, setIds] = useState<Record<string, string[]>>({})
  const accountIds = useBotStore(useShallow((s) => s.bots.filter((b) => b.platformId === 'hark').flatMap((b) => b.accountIds)))
  const key = accountIds.join(',')
  useEffect(() => {
    if (!on) return
    let live = true
    for (const accountId of key ? key.split(',') : []) {
      void getBridge()?.hark.rpc({ accountId, op: 'listConversations' }).then((res) => {
        if (!live || !res?.ok) return
        const rows = harkProjects(res.data)
        useConversationTitles.setState(Object.fromEntries(rows.map((p) => [p.id, p.title])))
        setIds((prev) => ({ ...prev, [accountId]: rows.filter((p) => !p.archived).map((p) => p.id) }))
      }).catch(() => undefined)
    }
    return () => {
      live = false
    }
  }, [on, key])
  return ids
}

const SUBTASK_DOT: Record<HarkSubtask['status'], string> = {
  waiting: 'bg-status-attention',
  running: 'bg-status-busy',
  failed: 'bg-status-error',
  done: 'bg-status-online'
}
const SUBTASK_WORD: Record<HarkSubtask['status'], string> = { waiting: '等你确认', running: '运行中', failed: '失败', done: '已完成' }
const TASK_DOT: Record<HarkTask['state'], string> = { working: 'bg-status-busy', open: 'bg-status-attention', done: 'bg-status-online' }
const TASK_WORD: Record<HarkTask['state'], string> = { working: '进行中', open: '待处理', done: '已完成' }
const KIND_WORD: Record<HarkSubtask['kind'], string> = { browser: '浏览器', subagent: '子代理', other: '工具' }

/** v25: right-side detail for one Hark project: what it runs at once, refreshed while open. */
function ProjectDetail({ project, onClose }: { project: NonNullable<Card['project']> & { title: string }; onClose: () => void }) {
  useMinuteTick()
  const [tasks, setTasks] = useState<HarkTask[]>()
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    const load = async () => {
      const res = await getBridge()?.hark.rpc({ accountId: project.accountId, op: 'conversationSnapshot', conversationId: project.conversationId })
      if (!live) return
      if (!res?.ok) {
        setError(res?.message || '读取失败')
        return
      }
      const data = res.data as HarkSnapshotLike & { activeActivity?: { text?: string } | string | null; narration?: string }
      setError('')
      setTasks(deriveTasks(data))
      const act = typeof data.activeActivity === 'string' ? data.activeActivity : data.activeActivity?.text
      setStatus(act || data.narration || '')
    }
    void load()
    const id = setInterval(() => void load(), 6000)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [project.accountId, project.conversationId])
  const running = tasks?.filter((t) => t.state === 'working').length ?? 0
  return (
    <aside aria-label="项目详情" className="flex w-[340px] shrink-0 flex-col border-l border-line bg-main">
      <header className="flex items-start gap-2 px-4 pt-3 pb-2">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="truncate text-[15px] font-semibold text-ink">{project.title}</h3>
          <span className="w-fit max-w-full truncate rounded-full bg-hover px-2 text-[11px] text-ink-muted">{project.botName}</span>
        </span>
        <button type="button" aria-label="关闭" onClick={onClose} className="press grid size-7 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-ink">
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <p className={cn('px-4 text-[12px]', project.working ? 'text-status-busy-ink' : 'text-ink-muted')}>
        {project.working ? '进行中' : '已完成'}
        {status ? ` · ${status}` : ''}
      </p>
      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
        <h4 className="px-1 pb-1.5 text-[12.5px] font-medium text-ink">
          任务 <span className="text-ink-muted">{running} 个进行中</span>
        </h4>
        {error && <p className="px-1 text-[12px] text-status-error">{error}</p>}
        {!tasks && !error && <p className="px-1 text-[12px] text-ink-muted">读取中…</p>}
        {tasks?.length === 0 && <p className="px-1 text-[12px] text-ink-muted">还没有任务</p>}
        <ol className="flex flex-col gap-1.5">
          {tasks?.map((t) => (
            <li key={t.id} className="flex flex-col gap-1 rounded-[10px] bg-canvas/60 px-3 py-2">
              <span className="flex items-start gap-2.5">
                <span className={cn('mt-[7px] size-2 shrink-0 rounded-full', TASK_DOT[t.state])} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="line-clamp-2 text-[12.5px] leading-[18px] font-medium text-ink" title={t.title}>{t.title}</span>
                  <span className="text-[11px] text-ink-muted">
                    {TASK_WORD[t.state]}
                    {t.createdAt ? ` · ${formatShortTime(t.createdAt)}` : ''}
                  </span>
                </span>
              </span>
              {t.subtasks.length > 0 && (
                <ul className="ml-[18px] flex flex-col gap-1 border-l border-line pl-2.5">
                  {t.subtasks.map((st) => (
                    <li key={st.id} className="flex items-start gap-2 text-[11.5px] leading-[16px]">
                      <span className={cn('mt-[5px] size-1.5 shrink-0 rounded-full', SUBTASK_DOT[st.status])} />
                      <span className="min-w-0 flex-1 truncate text-ink" title={st.title}>
                        <span className="text-ink-muted">{KIND_WORD[st.kind]} · </span>
                        {st.title}
                      </span>
                      <span className="shrink-0 text-ink-muted">{SUBTASK_WORD[st.status]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </div>
      <div className="border-t border-line p-3">
        <button
          type="button"
          onClick={() => {
            useBotStore.getState().selectBot(project.botId)
            openConversationTab(project.botId, project.conversationId, project.title)
          }}
          className="press h-9 w-full rounded-full bg-ink text-[13px] font-medium text-main hover:opacity-90"
        >
          打开这个项目的对话
        </button>
      </div>
    </aside>
  )
}
