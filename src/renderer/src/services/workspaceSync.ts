import { create } from 'zustand'
import { getBridge } from '@/lib/bridge'
import { findLeaf } from '@/lib/paneTree'
import { useRooms } from '@/rooms/roomStore'
import { useBotStore } from '@/store/botStore'
import { usePanes, visibleBotIds } from '@/store/paneStore'
import { useHarkWork } from './harkWork'

/**
 * GOXF v12/v13 glue between the pane layout and the rest of the app.
 * - The focused pane's bot is the app's selected bot, so the details panel,
 *   shortcuts and palette keep working unchanged.
 * - Selecting a bot anywhere (sidebar, palette, ⌘1–9) puts it on screen:
 *   its own pane if it has one, otherwise the focused pane.
 * - Hark "需要你" asks are counted per account for the board, and a system
 *   notification goes out when a conversation that is not on screen
 *   finishes or asks for you.
 */

/** accountId → conversationId → pending asks. */
export const useHarkAskCounts = create<Record<string, Record<string, number>>>(() => ({}))

export function asksForAccount(state: Record<string, Record<string, number>>, accountId: string): number {
  return Object.values(state[accountId] ?? {}).reduce((n, c) => n + c, 0)
}

function isRoom(id: string): boolean {
  return id === 'room-create' || useRooms.getState().rooms.some((r) => r.id === id)
}

function onScreen(botId: string): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus() && visibleBotIds().has(botId)
}

function notify(botId: string, title: string, body: string): void {
  if (typeof Notification === 'undefined') return
  try {
    const n = new Notification(title, { body: body.slice(0, 160), tag: `botark-${botId}`, silent: false })
    n.onclick = () => {
      window.focus()
      useBotStore.getState().selectBot(botId)
    }
  } catch {
    /* notifications unavailable */
  }
}

function botName(botId: string): string {
  return useBotStore.getState().bots.find((b) => b.id === botId)?.name ?? '会话'
}

export function startWorkspaceSync(): () => void {
  const stops: Array<() => void> = []
  // Startup reconnects may select bots; keep the chosen start page for the first moments.
  const settleUntil = Date.now() + 2500

  // First launch with an empty layout: show the selected bot.
  {
    const { selectedBotId, bots } = useBotStore.getState()
    const { tree, focusedId } = usePanes.getState()
    if (selectedBotId && bots.some((b) => b.id === selectedBotId) && !findLeaf(tree, focusedId)?.botId) {
      usePanes.getState().place(selectedBotId)
    }
  }

  // Selection → layout / page.
  stops.push(
    useBotStore.subscribe((s, prev) => {
      if (s.selectedBotId === prev.selectedBotId || !s.selectedBotId) return
      const id = s.selectedBotId
      const panes = usePanes.getState()
      const settling = Date.now() < settleUntil
      if (isRoom(id)) {
        if (panes.view !== 'collab' && !settling) panes.setView('collab')
        return
      }
      if (!s.bots.some((b) => b.id === id)) return
      if (panes.view !== 'sessions' && !settling) panes.setView('sessions')
      panes.place(id)
    })
  )

  // Focus → selection.
  stops.push(
    usePanes.subscribe((s, prev) => {
      if (s.focusedId === prev.focusedId && s.tree === prev.tree && s.view === prev.view) return
      if (s.view !== 'sessions') return
      const botId = findLeaf(s.tree, s.focusedId)?.botId
      const store = useBotStore.getState()
      if (botId && store.selectedBotId !== botId && store.bots.some((b) => b.id === botId)) store.selectBot(botId)
    })
  )

  // Deleted bots leave empty panes.
  stops.push(
    useBotStore.subscribe((s, prev) => {
      if (s.bots === prev.bots) return
      const alive = new Set(s.bots.map((b) => b.id))
      usePanes.getState().prune((id) => alive.has(id))
    })
  )

  // Replies finishing off screen.
  stops.push(
    useBotStore.subscribe((s, prev) => {
      if (s.typing === prev.typing) return
      for (const [botId, was] of Object.entries(prev.typing)) {
        if (was && !s.typing[botId] && !onScreen(botId)) {
          const list = s.messages[botId]
          const last = list?.[list.length - 1]
          if (last?.role === 'bot') notify(botId, `${botName(botId)} 回复好了`, last.text || '点开查看')
        }
      }
    })
  )

  // Hark projects finishing off screen.
  stops.push(
    useHarkWork.subscribe((s, prev) => {
      for (const [acc, convs] of Object.entries(s.projects)) {
        for (const [conv, w] of Object.entries(convs)) {
          if (!w.doneAt || prev.projects[acc]?.[conv]?.doneAt === w.doneAt) continue
          const bot = useBotStore.getState().bots.find((b) => b.accountIds.includes(acc))
          if (bot && !onScreen(bot.id)) notify(bot.id, `${bot.name} 任务完成`, '点开查看结果')
        }
      }
    })
  )

  // Hark asks ("需要你").
  const hark = getBridge()?.hark
  if (hark?.onEvent) {
    stops.push(
      hark.onEvent((event) => {
        if (event.type !== 'projectHistory' || event.asks === undefined || !event.conversationId) return
        const count = event.asks.length
        const before = useHarkAskCounts.getState()[event.accountId]?.[event.conversationId] ?? 0
        if (before === count) return
        useHarkAskCounts.setState((s) => ({
          ...s,
          [event.accountId]: { ...s[event.accountId], [event.conversationId]: count }
        }))
        if (count > before) {
          const bot = useBotStore.getState().bots.find((b) => b.accountIds.includes(event.accountId))
          if (bot && !onScreen(bot.id)) notify(bot.id, `${bot.name} 需要你`, event.asks[0]?.prompt || '有一步要你确认')
        }
      })
    )
  }

  return () => stops.forEach((stop) => stop())
}
