import { create } from 'zustand'
import type { PopoutPatch } from '@shared/goxfPopout'
import { getBridge } from '@/lib/bridge'
import { useBotStore, type BotHubState } from '@/store/botStore'

/**
 * GOXF: keep popped-out session windows in step with the main window.
 * The main window owns the only live store (adapters, persistence); it pushes
 * patches of what a conversation reads, and runs the actions a popped window
 * forwards. A popped window runs window-local UI actions itself.
 */

/** Bots shown in their own window right now (main window side). */
export const usePopped = create<{ ids: string[] }>(() => ({ ids: [] }))

export function isPopped(botId: string): boolean {
  return usePopped.getState().ids.includes(botId)
}

/** What a conversation reads besides its own messages. */
const SYNCED_KEYS = [
  'bots',
  'groups',
  'accounts',
  'typing',
  'activity',
  'replyingTo',
  'hermesSessionErrors',
  'dismissedGrokAgents',
  'trimmedBots'
] as const satisfies ReadonlyArray<keyof BotHubState>

/** Actions that only change what this window shows. */
const LOCAL_ACTIONS = new Set<string>([
  'setActiveDocument',
  'toggleInfoPanel',
  'toggleWebSession',
  'openWebSessionAt',
  'closeWebSession',
  'openPalette',
  'closePalette'
])

/** Changed keys and popped bots' changed message lists since `prev` (null = everything). */
export function popoutPatch(prev: BotHubState | null, next: BotHubState, popped: readonly string[]): PopoutPatch | null {
  const keys: Record<string, unknown> = {}
  for (const key of SYNCED_KEYS) if (!prev || prev[key] !== next[key]) keys[key] = next[key]
  const messages: Record<string, unknown[]> = {}
  for (const id of popped) {
    if (prev && prev.messages[id] === next.messages[id]) continue
    messages[id] = next.messages[id] ?? []
  }
  const hasMessages = Object.keys(messages).length > 0
  if (Object.keys(keys).length === 0 && !hasMessages) return null
  return hasMessages ? { keys, messages } : { keys }
}

/** Main window: track popped bots, push state to them, run their actions. */
export function startPopoutHost(): () => void {
  const bridge = getBridge()?.goxfPopout
  if (!bridge) return () => {}
  let sent: BotHubState | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    timer = undefined
    const { ids } = usePopped.getState()
    if (ids.length === 0) return
    const state = useBotStore.getState()
    const patch = popoutPatch(sent, state, ids)
    sent = state
    if (patch) bridge.pushState(patch)
  }
  // Streaming replies change the store many times a second; ~10 pushes/s is plenty.
  const schedule = (): void => {
    if (!timer) timer = setTimeout(flush, 100)
  }
  const resync = (): void => {
    sent = null
    schedule()
  }
  const setIds = (ids: string[]): void => {
    const before = usePopped.getState().ids
    usePopped.setState({ ids })
    if (ids.some((id) => !before.includes(id))) resync()
    // A bot deleted while its window was closed leaves nothing to show.
    const bots = useBotStore.getState().bots
    for (const id of ids) if (!bots.some((b) => b.id === id)) void bridge.dock(id)
  }
  void bridge.list().then(setIds).catch(() => undefined)
  const stops = [
    bridge.onChanged(setIds),
    bridge.onResync(resync),
    bridge.onAction((name, args) => {
      const fn = (useBotStore.getState() as unknown as Record<string, unknown>)[name]
      if (typeof fn !== 'function') throw new Error(`unknown action ${name}`)
      return (fn as (...a: unknown[]) => unknown)(...args)
    }),
    useBotStore.subscribe(schedule),
    useBotStore.subscribe((s, prev) => {
      if (s.bots === prev.bots) return
      for (const id of usePopped.getState().ids) if (!s.bots.some((b) => b.id === id)) void bridge.dock(id)
    })
  ]
  return () => {
    clearTimeout(timer)
    stops.forEach((stop) => stop())
  }
}

/** Popped window: mirror the main window's store and forward actions to it. */
export function startPopoutClient(botId: string): () => void {
  const bridge = getBridge()?.goxfPopout
  if (!bridge) return () => {}
  const state = useBotStore.getState() as unknown as Record<string, unknown>
  const proxies: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(state)) {
    if (typeof value !== 'function' || LOCAL_ACTIONS.has(name)) continue
    proxies[name] = async (...args: unknown[]) => {
      const result = await bridge.invoke(name, args)
      if (!result.ok) throw new Error(result.error)
      return result.value
    }
  }
  useBotStore.setState({
    ...proxies,
    selectedBotId: botId,
    webSessionOpen: useBotStore.getState().webSessionByBot[botId] === true
  } as Partial<BotHubState>)
  const stop = bridge.onState((patch) => {
    useBotStore.setState((s) => ({
      ...(patch.keys as Partial<BotHubState>),
      ...(patch.messages ? { messages: { ...s.messages, ...(patch.messages as BotHubState['messages']) } } : {})
    }))
  })
  bridge.ready()
  return stop
}
