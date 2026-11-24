import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
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
import { asksForAccount, useHarkAskCounts } from '@/services/workspaceSync'
import { useBotStore } from '@/store/botStore'

interface Card {
  key: string
  id: string
  column: BoardColumn
  title: string
  step: string
  time: number
  room: boolean
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
  useMinuteTick()
  const { bots, accounts, typing, activity, messages } = useBotStore(
    useShallow((s) => ({ bots: s.bots, accounts: s.accounts, typing: s.typing, activity: s.activity, messages: s.messages }))
  )
  const selectBot = useBotStore((s) => s.selectBot)
  const work = useHarkWork()
  const asks = useHarkAskCounts()
  const { rooms, speakers, errors } = useRooms(useShallow((s) => ({ rooms: s.rooms, speakers: s.speakers, errors: s.errors })))

  const cards: Card[] = []
  for (const bot of bots) {
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
  for (const room of rooms) {
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

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pt-3 pb-4">
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
                      onClick={() => selectBot(card.id)}
                      className={cn(
                        'press flex w-full flex-col gap-1.5 rounded-[12px] border bg-main p-3 text-left shadow-soft transition-colors hover:border-line-strong',
                        card.column === 'wait' ? 'border-status-attention/50' : card.column === 'fail' ? 'border-status-error/40' : 'border-line'
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
  )
}
