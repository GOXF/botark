/**
 * GOXF fork: a session pane popped out into its own window (second monitor).
 * The popped window is a mirror: the main window keeps the only live store,
 * adapters and persistence, sends it state patches, and runs the actions the
 * popped window forwards. Main process only relays.
 */
export const GOXF_POPOUT_CHANNELS = {
  open: 'goxf:popout:open',
  dock: 'goxf:popout:dock',
  focus: 'goxf:popout:focus',
  list: 'goxf:popout:list',
  /** main → main window renderer: popped bot ids changed. */
  changed: 'goxf:popout:changed',
  /** main window renderer → popped windows: store patch. */
  state: 'goxf:popout:state',
  /** popped window → main window renderer (via main): send me everything. */
  ready: 'goxf:popout:ready',
  resync: 'goxf:popout:resync',
  /** popped window invokes a store action; main forwards it to the main window renderer. */
  action: 'goxf:popout:action',
  actionResult: 'goxf:popout:action-result'
} as const

export interface PopoutPatch {
  /** Top-level store keys whose value changed. */
  keys: Record<string, unknown>
  /** botId → full message list, only for popped bots whose list changed. */
  messages?: Record<string, unknown[]>
}

export type PopoutActionResult = { ok: true; value?: unknown } | { ok: false; error: string }

export interface GoxfPopoutBridge {
  open(botId: string): Promise<void>
  dock(botId: string): Promise<void>
  focus(botId: string): Promise<void>
  list(): Promise<string[]>
  onChanged(listener: (botIds: string[]) => void): () => void
  // main window side
  pushState(patch: PopoutPatch): void
  onResync(listener: () => void): () => void
  onAction(handler: (name: string, args: unknown[]) => unknown): () => void
  // popped window side
  ready(): void
  onState(listener: (patch: PopoutPatch) => void): () => void
  invoke(name: string, args: unknown[]): Promise<PopoutActionResult>
}
