import type { DotMainEvent, DotRpcRequest } from './ipc'

export interface DotTarget {
  dotId?: string
  roomId?: string
}

export type DotTurnRequest = DotRpcRequest & { turnId?: string; disconnect?: true }

export type DotTurnEvent = DotMainEvent & DotTarget & { turnId?: string }

/** Select the stored profile and its room together. A missing room must be resolved for that profile. */
export function resolveDotTarget(
  req: DotTarget,
  acc: { activeDotId?: string; roomId?: string } | undefined | null
): DotTarget {
  if (acc?.activeDotId) return { dotId: acc.activeDotId, roomId: acc.roomId || undefined }
  if (req.dotId) return { dotId: req.dotId, roomId: req.roomId }
  return { dotId: undefined, roomId: acc?.roomId || req.roomId }
}
