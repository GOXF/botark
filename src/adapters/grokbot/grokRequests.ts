import type { BotHubBridge } from '@shared/bridge'
import type { GrokRpcRequest, GrokRpcResponse } from '@shared/ipc'

export type GrokWatchTarget = { agentId: string; sessionId: string; conversationId?: string }

// The preload RPC forwards the request object unchanged.
export type GrokRequest = (GrokRpcRequest & { requestId?: string; targets?: GrokWatchTarget[]; watermarkOnly?: boolean })
  | { accountId: string; op: 'cancelRequest'; requestId: string }

export async function grokRpc(
  bridge: Pick<BotHubBridge['grok'], 'rpc'>, request: GrokRequest, signal?: AbortSignal
): Promise<GrokRpcResponse> {
  signal?.throwIfAborted()
  const rpc = bridge.rpc as (request: GrokRequest) => Promise<GrokRpcResponse>
  const pending = rpc(request)
  if (!signal || !request.requestId) return pending

  let onAbort: () => void
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      void rpc({ accountId: request.accountId, op: 'cancelRequest', requestId: request.requestId! }).catch(() => undefined)
      reject(signal.reason)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([pending, cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort!)
  }
}
