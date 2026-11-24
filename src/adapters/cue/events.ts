import type { CueMainEvent } from '@shared/ipc'

export type CueTurnEvent = (CueMainEvent & { requestId?: string }) |
  { type: 'accepted'; accountId: string; requestId: string; sessionId: string }
