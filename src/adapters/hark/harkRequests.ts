import type { HarkRpcRequest, HarkRpcResponse } from '@shared/ipc'
import type { BotHubBridge } from '@shared/bridge'

// These fields travel over the existing preload RPC channel.
export type HarkRequest = (HarkRpcRequest & { requestId?: string; preview?: boolean })
  | { accountId: string; op: 'cancelRequest'; requestId: string }

export async function harkRpc(
  bridge: Pick<BotHubBridge['hark'], 'rpc'>,
  request: HarkRequest,
  signal?: AbortSignal
): Promise<HarkRpcResponse> {
  signal?.throwIfAborted()
  const rpc = bridge.rpc as (request: HarkRequest) => Promise<HarkRpcResponse>
  const pending = rpc(request)
  if (!signal || !request.requestId) return pending
  const cancel: HarkRequest = { accountId: request.accountId, op: 'cancelRequest', requestId: request.requestId }
  let onAbort: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void rpc(cancel).catch(() => undefined)
      reject(signal.reason)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort!)
  }
}
