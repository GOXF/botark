import type { HermesMainEvent } from '@shared/ipc'

export type HermesTurnEvent = HermesMainEvent & { requestId?: string; sessionId?: string }
