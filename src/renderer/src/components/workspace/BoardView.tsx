import { useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { BotAvatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
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
import { useBoardDetail } from '@/store/boardDetailStore'
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

export const COLUMN_STYLE: Record<BoardColumn, { dot: string; head: string }> = {
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
 * GOXF 任务 (user 2026-11-25): the sidebar 任务 shows every task of every
 * conversation and group chat; the top 任务 next to a conversation or group
 * shows only that one's (a group: the group and its members). One card per
 * Hark request with its subtasks; a non-Hark bot or a group is one card.
 */
export function BoardView() {
  const scope = usePanes((s) => s.scope)
  const mode = usePipeline((s) => s.mode)
  const clearPicked = useBoardDetail((s) => s.setPicked)
  useEffect(() => () => clearPicked(undefined), [clearPicked])
  const selectedId = useBotStore((s) => s.selectedBotId)
  const botIds = useBotStore(useShallow((s) => s.bots.map((b) => b.id)))
  const roomKeys = useRooms(useShallow((s) => s.rooms.map((r) => `${r.id}|${r.members.map((m) => m.botId).join(',')}`)))
  const rooms = roomKeys.map((k) => ({ id: k.split('|')[0]!, members: k.slice(k.indexOf('|') + 1) }))
  const room = rooms.find((r) => r.id === selectedId)
  let target: { bots: string[]; rooms: string[]; key: string }
  if (scope === 'all') target = { bots: botIds, rooms: rooms.map((r) => r.id), key: 'all' }
  else if (scope === 'collab' && room)
    target = { bots: room.members.split(',').filter((id) => botIds.includes(id)), rooms: [room.id], key: `r:${room.id}` }
  else target = { bots: selectedId && botIds.includes(selectedId) ? [selectedId] : [], rooms: [], key: `b:${selectedId}` }
  const board = <TaskBoard key={target.key} botIds={target.bots} roomIds={target.rooms} single={scope !== 'all'} />
  // 状态/流水线 stays on the boards that hold group chats.
  if (scope === 'sessions' || (scope === 'collab' && !room)) return board
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
      {board}
    </div>
  )
}

/** A non-Hark bot, a Hark bot with no projects yet, or a group chat: one card each. */
function usePlainCards(botIds: string[], roomIds: string[], harkWithProjects: Set<string>): Card[] {
  const { bots, accounts, typing, activity, messages } = useBotStore(
    useShallow((s) => ({ bots: s.bots, accounts: s.accounts, typing: s.typing, activity: s.activity, messages: s.messages }))
  )
  const work = useHarkWork()
  const asks = useHarkAskCounts()
  const { rooms, speakers, errors } = useRooms(useShallow((s) => ({ rooms: s.rooms, speakers: s.speakers, errors: s.errors })))
  const cards: Card[] = []
  for (const bot of bots) {
    if (!botIds.includes(bot.id) || harkWithProjects.has(bot.id)) continue
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
          : previewText(last, typing[bot.id] === true, act) || (acc?.status === 'offline' ? '离线' : '还没有消息')
    cards.push({ key: `b:${bot.id}`, id: bot.id, column, title: bot.name, step, time: Math.max(last?.createdAt ?? 0, w.doneAt || 0), room: false })
  }
  for (const room of rooms) {
    if (!roomIds.includes(room.id)) continue
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
  return cards
}

function PlainCardView({ card }: { card: Card }) {
  const bot = useBotStore((s) => (card.room ? undefined : s.bots.find((b) => b.id === card.id)))
  const room = useRooms((s) => (card.room ? s.rooms.find((r) => r.id === card.id) : undefined))
  const open = () => {
    useBotStore.getState().selectBot(card.id)
    usePanes.getState().setView(card.room ? 'collab' : 'sessions')
  }
  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        'press flex w-full flex-col gap-1.5 rounded-xl border bg-main p-3 text-left shadow-soft transition-colors hover:border-line-strong',
        card.column === 'wait' ? 'border-status-attention/50' : card.column === 'fail' ? 'border-status-error/40' : 'border-line'
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {bot ? (
          <BotAvatar emoji={bot.emoji} seed={bot.id} avatar={bot.avatar} avatarShape={bot.avatarShape} avatarColor={bot.avatarColor} platformId={bot.platformId} size="xs" />
        ) : room ? (
          <RoomAvatarCluster members={room.members.slice(0, 3)} size="xs" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{card.title}</span>
        {card.room && <span className="shrink-0 rounded-full bg-hover px-1.5 text-[11px] text-ink-muted">群聊</span>}
        <span className="shrink-0 text-[11px] text-ink-muted">{formatShortTime(card.time || undefined)}</span>
      </span>
      <span className="flex min-w-0 items-start gap-1.5">
        {card.column === 'run' && <Loader2 aria-hidden className="mt-0.75 size-3 shrink-0 animate-spin text-status-busy" />}
        <span className={cn('line-clamp-2 text-[13px] leading-4.5', card.column === 'wait' ? 'font-medium text-status-attention-ink' : 'text-ink-secondary')}>
          {card.step}
        </span>
      </span>
    </button>
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

type PickedProject = NonNullable<Card['project']> & { title: string; taskId?: string }
export interface TaskCard extends HarkTask { conversationId: string; column: BoardColumn; projectKey: string; botId: string }
const DAY = 24 * 60 * 60 * 1000

/**
 * 任务 columns for a set of conversations: one card per Hark request across
 * every project of each Hark bot (project tag, subtasks inline), plus one card
 * per non-Hark bot or group with something going on. Idle ones sit only in the
 * chip row. `single`: one bot or group, so the chips are its projects and the
 * project you were looking at opens on the right.
 */
function TaskBoard({ botIds, roomIds, single }: { botIds: string[]; roomIds: string[]; single: boolean }) {
  useMinuteTick()
  const titles = useConversationTitles()
  const projectIds = useProjectTitles(true)
  const work = useHarkWork()
  const asks = useHarkAskCounts()
  const botsAll = useBotStore((s) => s.bots)
  const roomsAll = useRooms((s) => s.rooms)
  const hark = botsAll
    .filter((b) => b.platformId === 'hark' && botIds.includes(b.id))
    .map((b) => ({ id: b.id, name: b.name, accountId: b.activeAccountId, session: b.activeSessionId }))
  const [snaps, setSnaps] = useState<Record<string, HarkTask[]>>({})
  const snapsRef = useRef(snaps)
  snapsRef.current = snaps
  const [filter, setFilter] = useState<string>()
  const { picked, setPicked } = useBoardDetail()
  const [olderOpen, setOlderOpen] = useState(false)
  // Every project of every Hark bot here, as `${botId}|${accountId}|${conversationId}`.
  const projects = hark.flatMap((b) =>
    [...new Set([...(projectIds[b.accountId] ?? []), ...Object.keys(work.projects[b.accountId] ?? {})])].map((cid) => ({ bot: b, cid, key: `${b.id}|${b.accountId}|${cid}` }))
  )
  const keys = projects.map((p) => p.key).join(',')
  const busyKey = projects.filter((p) => work.projects[p.bot.accountId]?.[p.cid]?.working || (asks[p.bot.accountId]?.[p.cid] ?? 0) > 0).map((p) => p.key).join(',')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Every project once a minute; the busy ones (and any with live tasks) every 8 s.
  useEffect(() => {
    const load = (key: string) => {
      const [, accountId, cid] = key.split('|')
      void getBridge()?.hark.rpc({ accountId: accountId!, op: 'conversationSnapshot', conversationId: cid! }).then((res) => {
        // A re-run (a project turned busy) must not drop answers still in flight: that left the board empty.
        if (mounted.current && res?.ok) setSnaps((prev) => ({ ...prev, [key]: deriveTasks(res.data as HarkSnapshotLike) }))
      }).catch(() => undefined)
    }
    const all = keys ? keys.split(',') : []
    all.forEach(load)
    const fast = setInterval(() => {
      const prev = snapsRef.current
      new Set([...(busyKey ? busyKey.split(',') : []), ...all.filter((k) => prev[k]?.some((t) => t.state !== 'done'))]).forEach(load)
    }, 8000)
    const slow = setInterval(() => all.forEach(load), 60_000)
    return () => {
      clearInterval(fast)
      clearInterval(slow)
    }
  }, [keys, busyKey])

  const pick = (p: (typeof projects)[number], taskId?: string) =>
    setPicked({ botId: p.bot.id, botName: p.bot.name, accountId: p.bot.accountId, conversationId: p.cid, working: Boolean(work.projects[p.bot.accountId]?.[p.cid]?.working), title: titles[p.cid] || '项目', taskId })

  // Entering one bot's 任务 opens the project you were looking at.
  const current = single && hark.length === 1 ? projects.find((p) => p.cid === hark[0]!.session) : undefined
  useEffect(() => {
    if (current) pick(current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.key])

  const withProjects = new Set(projects.map((p) => p.bot.id))
  const plain = usePlainCards(botIds, roomIds, withProjects)

  const now = Date.now()
  const cards: TaskCard[] = []
  for (const p of projects) {
    for (const t of snaps[p.key] ?? []) {
      const waiting = t.subtasks.some((st) => st.status === 'waiting')
      const column: BoardColumn = waiting || t.state === 'open' ? 'wait' : t.state === 'working' ? 'run' : 'done'
      cards.push({ ...t, conversationId: p.cid, column, projectKey: p.key, botId: p.bot.id })
    }
  }
  const live = (c: TaskCard) => c.column !== 'done' || now - (c.createdAt ?? 0) < DAY
  // Chips: one bot → its projects; several → each bot and group.
  const byProject = single && hark.length === 1 && roomIds.length === 0
  const chipOf = (c: TaskCard) => (byProject ? c.projectKey : c.botId)
  const counts = new Map<string, number>()
  for (const c of cards) if (live(c)) counts.set(chipOf(c), (counts.get(chipOf(c)) ?? 0) + 1)
  for (const c of plain) if (c.column !== 'idle') counts.set(c.id, (counts.get(c.id) ?? 0) + 1)
  const chips: Array<{ id: string; label: string; dot: string }> = byProject
    ? projects.map((p) => {
        const pw = work.projects[p.bot.accountId]?.[p.cid]
        const dot = (asks[p.bot.accountId]?.[p.cid] ?? 0) > 0 ? 'bg-status-attention' : pw?.working ? 'bg-status-busy' : counts.get(p.key) ? 'bg-status-online' : 'bg-ink-faint'
        return { id: p.key, label: titles[p.cid] || '项目', dot }
      })
    : [
        ...roomIds.map((id) => ({ id, label: roomsAll.find((r) => r.id === id)?.title ?? '群聊' })),
        ...botIds.map((id) => ({ id, label: botsAll.find((b) => b.id === id)?.name ?? '会话' }))
      ]
        .map((c) => ({ ...c, dot: counts.get(c.id) ? 'bg-status-busy' : 'bg-ink-faint' }))
        .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))
  const shownTasks = cards.filter((c) => !filter || chipOf(c) === filter)
  const shownPlain = plain.filter((c) => c.column !== 'idle' && (!filter || c.id === filter))
  const chip = (id: string | undefined, label: string, n: number, dot?: string) => (
    <button
      key={id ?? 'all'}
      type="button"
      onClick={() => setFilter(id)}
      className={cn(
        'press inline-flex h-7 max-w-50 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12px]',
        filter === id ? 'border-[0.5px] border-line-strong bg-main font-medium text-ink shadow-float' : 'border-transparent text-ink-muted hover:bg-hover hover:text-ink',
        filter !== id && (n ? 'text-ink' : 'text-ink-muted')
      )}
    >
      {dot && <span className={cn('size-1.5 shrink-0 rounded-full', dot)} />}
      <span className="truncate">{label}</span>
      {n > 0 && <span className="text-ink-muted">{n}</span>}
    </button>
  )
  const tagOf = (t: TaskCard) => {
    const project = titles[t.conversationId] || '项目'
    if (byProject) return project
    const name = botsAll.find((b) => b.id === t.botId)?.name
    return name ? `${name} · ${project}` : project
  }

  return (
    <div className="flex min-h-0 flex-1 pt-3">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {chips.length > 1 && (
          <div className="flex shrink-0 items-center gap-2 overflow-x-auto px-4 pb-3">
            <span className="shrink-0 text-[12px] text-ink-muted">{byProject ? '项目' : '来自'}</span>
            {chip(undefined, '全部', [...counts.values()].reduce((a, b) => a + b, 0))}
            {chips.map((c) => chip(c.id, c.label, counts.get(c.id) ?? 0, c.dot))}
          </div>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto px-4 pb-4">
          {BOARD_COLUMNS.filter((col) => col.id !== 'idle').map((col) => {
            const all = shownTasks.filter((c) => c.column === col.id).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
            const list = col.id === 'done' && !olderOpen ? all.filter((c) => now - (c.createdAt ?? 0) < DAY) : all
            const older = all.length - list.length
            const plainHere = shownPlain.filter((c) => c.column === col.id).sort((a, b) => b.time - a.time)
            return (
              <section key={col.id} aria-label={col.label} className="flex min-w-55 flex-1 flex-col rounded-2xl bg-canvas/60">
                <header className="flex h-10 shrink-0 items-center gap-2 px-3">
                  <span className={cn('size-2 rounded-full', COLUMN_STYLE[col.id].dot)} />
                  <h3 className={cn('text-[13px] font-semibold', COLUMN_STYLE[col.id].head)}>{col.label}</h3>
                  <span className="text-[12px] text-ink-muted">{list.length + plainHere.length}</span>
                </header>
                <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                  {list.map((t) => (
                    <li key={`${t.projectKey}:${t.id}`}>
                      <TaskCardView
                        task={t}
                        title={tagOf(t)}
                        selected={picked?.taskId === t.id && picked?.conversationId === t.conversationId}
                        onClick={() => {
                          const p = projects.find((x) => x.key === t.projectKey)
                          if (p) pick(p, t.id)
                        }}
                      />
                    </li>
                  ))}
                  {plainHere.map((c) => (
                    <li key={c.key}>
                      <PlainCardView card={c} />
                    </li>
                  ))}
                  {list.length + plainHere.length === 0 && <li className="px-2 py-6 text-center text-[12px] text-ink-faint">没有</li>}
                  {older > 0 && (
                    <li>
                      <Button variant="ghost" size="sm" onClick={() => setOlderOpen(true)}>
                        更早的 {older} 条 · 展开
                      </Button>
                    </li>
                  )}
                </ol>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function TaskCardView({ task, title, selected, onClick }: { task: TaskCard; title: string; selected: boolean; onClick: () => void }) {
  const [open, setOpen] = useState(false)
  const subs = open ? task.subtasks : task.subtasks.slice(0, 3)
  const running = task.subtasks.filter((s) => s.status === 'running' || s.status === 'waiting').length
  const done = task.subtasks.filter((s) => s.status === 'done').length
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
      className={cn(
        'press flex w-full cursor-pointer flex-col gap-1.5 rounded-xl border bg-main p-3 text-left shadow-soft transition-colors hover:border-line-strong',
        selected ? 'border-accent-600 ring-1 ring-accent-600' : task.column === 'wait' ? 'border-status-attention/50' : 'border-line'
      )}
    >
      <span className="line-clamp-2 text-[13px] leading-5 text-ink" title={task.title}>{task.title}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="max-w-[70%] truncate rounded-full bg-hover px-2 text-[11px] text-ink-muted">{title}</span>
        <span className="shrink-0 text-[11px] text-ink-muted">{formatShortTime(task.createdAt)}</span>
      </span>
      {task.subtasks.length > 0 && (
        <>
          <span className={cn('text-[11px]', running ? 'text-status-busy-ink' : 'text-ink-muted')}>
            子任务 {done}/{task.subtasks.length} 已完成{running ? ` · ${running} 运行中` : ''}
          </span>
          <ul className="flex flex-col gap-1 border-l border-line pl-2.5">
            {subs.map((st) => (
              <li key={st.id} className="flex items-start gap-2 text-[12px] leading-4">
                <span className={cn('mt-1.25 size-1.5 shrink-0 rounded-full', SUBTASK_DOT[st.status])} />
                <span className="min-w-0 flex-1 truncate text-ink" title={st.title}>
                  <span className="text-ink-muted">{KIND_WORD[st.kind]} · </span>
                  {st.title}
                </span>
                <span className="shrink-0 text-ink-muted">{SUBTASK_WORD[st.status]}</span>
              </li>
            ))}
          </ul>
          {task.subtasks.length > 3 && !open && (
            <Button
              variant="ghost"
              size="sm"
              className="w-fit"
              onClick={(e) => {
                e.stopPropagation()
                setOpen(true)
              }}
            >
              还有 {task.subtasks.length - 3} 个 · 展开
            </Button>
          )}
        </>
      )}
    </div>
  )
}

/** v25: right-side detail for one Hark project: what it runs at once, refreshed while open. */
export function ProjectDetail({ project, highlight, onClose }: { project: PickedProject; highlight?: string; onClose: () => void }) {
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
  // Bring the picked task into view once, not on every 6 s refresh.
  const scrolledTo = useRef<string>(undefined)
  const scrollOnce = (el: HTMLLIElement | null) => {
    if (!el || scrolledTo.current === highlight) return
    scrolledTo.current = highlight
    el.scrollIntoView({ block: 'nearest' })
  }
  return (
    // Rows line up with the middle: title = top bar (52), account + state = project chips (52), 任务 = column heads (40).
    <section aria-label="项目详情" className="flex min-h-0 flex-1 flex-col bg-main">
      <header className="flex h-13 shrink-0 items-center gap-2 pr-2 pl-4">
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{project.title}</h3>
        <IconButton label="关闭" size="sm" onClick={onClose}>
          <X aria-hidden />
        </IconButton>
      </header>
      <div className="flex h-13 shrink-0 items-center gap-2 px-4">
        <span className="max-w-[50%] shrink-0 truncate rounded-full bg-hover px-2 text-[11px] text-ink-muted">{project.botName}</span>
        <span className={cn('min-w-0 truncate text-[12px]', project.working ? 'text-status-busy-ink' : 'text-ink-muted')}>
          {project.working ? '进行中' : '已完成'}
          {status ? ` · ${status}` : ''}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
        <h4 className="flex h-10 shrink-0 items-center px-1 text-[13px] font-medium text-ink">
          任务 <span className="text-ink-muted">{running} 个进行中</span>
        </h4>
        {error && <p className="px-1 text-[12px] text-status-error">{error}</p>}
        {!tasks && !error && <p className="px-1 text-[12px] text-ink-muted">读取中…</p>}
        {tasks?.length === 0 && <p className="px-1 text-[12px] text-ink-muted">还没有任务</p>}
        <ol className="flex flex-col gap-1.5">
          {tasks?.map((t) => (
            <li
              key={t.id}
              ref={t.id === highlight ? scrollOnce : undefined}
              className={cn('flex flex-col gap-1 rounded-lg bg-canvas/60 px-3 py-2', t.id === highlight && 'ring-2 ring-accent-600')}
            >
              <span className="flex items-start gap-2.5">
                <span className={cn('mt-1.75 size-2 shrink-0 rounded-full', TASK_DOT[t.state])} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="line-clamp-2 text-[13px] leading-4.5 font-medium text-ink" title={t.title}>{t.title}</span>
                  <span className="text-[11px] text-ink-muted">
                    {TASK_WORD[t.state]}
                    {t.createdAt ? ` · ${formatShortTime(t.createdAt)}` : ''}
                  </span>
                </span>
              </span>
              {t.subtasks.length > 0 && (
                <ul className="ml-4.5 flex flex-col gap-1 border-l border-line pl-2.5">
                  {t.subtasks.map((st) => (
                    <li key={st.id} className="flex items-start gap-2 text-[12px] leading-4">
                      <span className={cn('mt-1.25 size-1.5 shrink-0 rounded-full', SUBTASK_DOT[st.status])} />
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
        <Button variant="primary" size="md"
          onClick={() => {
            useBotStore.getState().selectBot(project.botId)
            openConversationTab(project.botId, project.conversationId, project.title)
          }}
          className="w-full"
        >
          打开这个项目的对话
        </Button>
      </div>
    </section>
  )
}
