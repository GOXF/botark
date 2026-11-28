import { BOARD_COLUMNS, classifyBot, type BoardColumn, type BotSignals } from '@/lib/boardStatus'
import { accountWork } from '@/lib/harkWork'
import { lastMessage } from '@/lib/selectors'
import { useHarkWork } from '@/services/harkWork'
import { asksForAccount, useConversationTitles, useHarkAskCounts } from '@/services/workspaceSync'
import { useBotStore } from '@/store/botStore'
import type { RoomMember } from './model'

/**
 * GOXF: what each teammate is doing right now, for the administrator's turn.
 * Without it the administrator only sees member names and replies "no members or tasks".
 */
export interface MemberSnapshot {
  name: string
  column: BoardColumn
  /** Latest line of the member's own conversation, already flattened. */
  last?: string
  lastAt?: number
  /** Titles of the member's Hark projects that are working right now. */
  working?: string[]
}

const label = (c: BoardColumn) => BOARD_COLUMNS.find((x) => x.id === c)?.label ?? c
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function teamStatusBlock(members: MemberSnapshot[], now = Date.now()): string {
  if (!members.length) return ''
  const lines = members.map((m) => {
    const parts = [`@${m.name}: ${label(m.column)}`]
    if (m.working?.length) parts.push(`working on ${m.working.map((t) => `「${clip(t, 40)}」`).join(', ')}`)
    if (m.last) {
      const ago = m.lastAt ? ` (${Math.max(0, Math.round((now - m.lastAt) / 60_000))} min ago)` : ''
      parts.push(`latest: ${clip(m.last, 120)}${ago}`)
    }
    return '- ' + parts.join(' · ')
  })
  return 'Teammates’ current work (from their own conversations, refreshed each turn):\n' + lines.join('\n')
}

/** Reads the live stores; one entry per member other than the administrator. */
export function snapshotMembers(members: RoomMember[], exceptBotId?: string): MemberSnapshot[] {
  const { bots, accounts, typing, messages } = useBotStore.getState()
  const work = useHarkWork.getState()
  const asks = useHarkAskCounts.getState()
  const titles = useConversationTitles.getState()
  return members.filter((m) => m.botId !== exceptBotId).map((m) => {
    const bot = bots.find((b) => b.id === m.botId)
    if (!bot) return { name: m.name, column: 'idle' as const }
    const last = lastMessage(messages[bot.id])
    const w = bot.platformId === 'hark' ? accountWork(work, bot.accountIds) : { working: 0, doneAt: 0 }
    const signals: BotSignals = {
      typing: typing[bot.id] === true, live: false, harkWorking: w.working, harkDoneAt: w.doneAt,
      asks: bot.accountIds.reduce((n, id) => n + asksForAccount(asks, id), 0),
      accountStatus: accounts[bot.activeAccountId]?.status, lastDelivery: last?.delivery,
      lastRole: last?.role, unread: bot.unread
    }
    const working = bot.platformId === 'hark'
      ? bot.accountIds.flatMap((acc) => Object.entries(work.projects[acc] ?? {}).filter(([, p]) => p.working).map(([cid]) => titles[cid] || cid))
      : []
    const text = last?.text.replace(/\s+/g, ' ').trim()
    return {
      name: m.name, column: classifyBot(signals), working,
      ...(text ? { last: (last!.role === 'user' ? 'user: ' : '') + text, lastAt: last!.createdAt } : {})
    }
  })
}
