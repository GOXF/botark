/** GOXF v12: which 看板 column a conversation sits in. */
export type BoardColumn = 'wait' | 'run' | 'fail' | 'done' | 'idle'

export const BOARD_COLUMNS: ReadonlyArray<{ id: BoardColumn; label: string }> = [
  { id: 'wait', label: '等你处理' },
  { id: 'run', label: '进行中' },
  { id: 'fail', label: '失败' },
  { id: 'done', label: '刚完成' },
  { id: 'idle', label: '空闲' }
]

export interface BotSignals {
  typing: boolean
  live: boolean
  harkWorking: number
  harkDoneAt: number
  asks: number
  accountStatus?: string
  lastDelivery?: string
  lastRole?: 'user' | 'bot'
  unread: number
}

/** Needs you first, then failures, then work in flight, then fresh results. */
export function classifyBot(s: BotSignals): BoardColumn {
  if (s.asks > 0 || s.accountStatus === 'attention') return 'wait'
  if (s.accountStatus === 'error' || s.lastDelivery === 'failed' || s.lastDelivery === 'no-reply') return 'fail'
  if (s.typing || s.live || s.harkWorking > 0) return 'run'
  if (s.harkDoneAt > 0 || s.unread > 0) return 'done'
  return 'idle'
}

export function classifyRoom(s: { speaking: boolean; error: boolean }): BoardColumn {
  if (s.error) return 'fail'
  if (s.speaking) return 'run'
  return 'idle'
}

/** v21: the columns a user can put a card in by hand (空闲 is never a choice). */
export const MANUAL_COLUMNS: ReadonlyArray<Exclude<BoardColumn, 'idle'>> = ['wait', 'run', 'fail', 'done']
export type ManualColumn = (typeof MANUAL_COLUMNS)[number]

export function isManualColumn(v: unknown): v is ManualColumn {
  return typeof v === 'string' && (MANUAL_COLUMNS as readonly string[]).includes(v)
}

/**
 * v21 (user 2026-11-27): the user decides a card's state. A manual column
 * beats the derived one until they pick 恢复自动 — no expiry, no auto rules.
 */
export function effectiveColumn(derived: BoardColumn, manual: unknown): BoardColumn {
  return isManualColumn(manual) ? manual : derived
}

/** Keep only well-formed overrides from persisted data. */
export function sanitizeOverrides(raw: unknown): Record<string, ManualColumn> {
  const out: Record<string, ManualColumn> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw)) if (k && isManualColumn(v)) out[k] = v
  return out
}
