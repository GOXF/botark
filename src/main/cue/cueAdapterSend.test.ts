import { afterEach, expect, it, vi } from 'vitest'
import { CueAdapter } from '../../adapters/cue/CueAdapter'
import type { CueTurnEvent } from '../../adapters/cue/events'
import type { CueRpcRequest, CueRpcResponse } from '@shared/ipc'

afterEach(() => vi.unstubAllGlobals())

it('correlates immediate Cue acceptance and emits authoritative final replies', async () => {
  let emit!: (event: CueTurnEvent) => void
  let finish!: (response: CueRpcResponse) => void
  const rpc = vi.fn((_request: CueRpcRequest & { requestId?: string }) => new Promise<CueRpcResponse>((resolve) => {
    finish = resolve
  }))
  vi.stubGlobal('window', { electron: { cue: {
    onEvent: (listener: typeof emit) => { emit = listener; return () => undefined }, rpc
  } } })
  const adapter = new CueAdapter()
  const accepted = vi.fn()
  const listener = vi.fn()
  adapter.subscribe(listener)
  const accountId = 'fixture'
  const send = adapter.sendMessage({ accountId, conversationId: 'bot', sessionId: 'session', text: 'Hello', onAccepted: accepted })
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce())
  const requestId = rpc.mock.calls[0]![0].requestId!
  const echo = { type: 'accepted', accountId, requestId, sessionId: 'session' } as const
  emit({ ...echo, requestId: 'unrelated' })
  expect(accepted).not.toHaveBeenCalled()
  emit(echo)
  emit(echo)
  expect(accepted).toHaveBeenCalledOnce()
  finish({ ok: true, data: { sessionId: 'session', replies: [{ id: 'reply', text: 'Fixed' }] } })
  await send
  expect(accepted).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({
    type: 'message', message: expect.objectContaining({ id: 'reply', text: 'Fixed', authoritative: true })
  }))
})
