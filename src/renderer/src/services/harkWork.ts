import { create } from 'zustand'
import { evaluate, markRun, setPolled, workingFromStatuses, type HarkWorkState } from '@/lib/harkWork'
import { useBotStore } from '@/store/botStore'

/** GOXF: "工作中 / 完成" per Hark project and account (rules in lib/harkWork). */
export const useHarkWork = create<HarkWorkState>(() => ({ projects: {}, seenAt: {} }))

export function noteHarkRun(accountId: string, conversationId: string | undefined): void {
  if (conversationId) useHarkWork.setState((s) => markRun(s, accountId, conversationId, Date.now()))
}

const TICK_MS = 5_000
const POLL_EVERY_TICKS = 3 // ≈15 s
let loggedSample = false

async function pollStatuses(): Promise<void> {
  const rpc = window.electron?.hark?.rpc
  if (!rpc) return
  const { accounts } = useBotStore.getState()
  for (const acc of Object.values(accounts)) {
    if (acc.platformId !== 'hark' || !['online', 'busy'].includes(acc.status)) continue
    const res = await rpc({ accountId: acc.id, op: 'conversationStatus' }).catch(() => null)
    if (!res?.ok) continue
    if (!loggedSample) {
      loggedSample = true
      // The inner shape is unconfirmed; one sample in DevTools pins it down.
      console.info('[hark] /conversations/status sample', JSON.stringify(res.data).slice(0, 600))
    }
    const ids = workingFromStatuses(res.data)
    if (ids) useHarkWork.setState((s) => setPolled(s, acc.id, ids))
  }
}

function tick(): void {
  const { bots, selectedBotId } = useBotStore.getState()
  const onScreen = typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()
  const bot = onScreen ? bots.find((b) => b.id === selectedBotId && b.platformId === 'hark') : undefined
  useHarkWork.setState((s) =>
    evaluate(
      s,
      Date.now(),
      (acc, conv) => Boolean(bot && bot.activeAccountId === acc && bot.activeSessionId === conv),
      bot?.accountIds ?? []
    )
  )
}

export function startHarkWork(): () => void {
  if (typeof window === 'undefined' || !window.electron?.hark?.rpc) return () => {}
  let n = 0
  const timer = setInterval(() => {
    tick()
    if (n++ % POLL_EVERY_TICKS === 0) void pollStatuses()
  }, TICK_MS)
  return () => clearInterval(timer)
}
