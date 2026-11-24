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
