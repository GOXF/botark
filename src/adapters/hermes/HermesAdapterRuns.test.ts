import { afterEach, expect, it, vi } from 'vitest'
import type { HermesRpcRequest, HermesRpcResponse } from '@shared/ipc'
import { HermesAdapter } from './HermesAdapter'
import type { HermesTurnEvent } from './events'

afterEach(() => vi.unstubAllGlobals())

it('does not clear a newer turn when the superseded send settles', async () => {
  let finishFirst!: (res: HermesRpcResponse) => void
  let finishSecond!: (res: HermesRpcResponse) => void
  const rpc = vi.fn()
    .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve }))
    .mockReturnValueOnce(new Promise((resolve) => { finishSecond = resolve }))
  vi.stubGlobal('window', { electron: { hermes: { onEvent: () => () => undefined, rpc } } })
  const adapter = new HermesAdapter()
  const listener = vi.fn()
  adapter.subscribe(listener)
  const message = { accountId: 'fixture', conversationId: 'bot', text: 'Hello' }

  const first = adapter.sendMessage(message)
  const second = adapter.sendMessage({ ...message, text: 'New turn' })
  listener.mockClear()
  finishFirst({ ok: false, status: 500, message: 'Fixture cancelled' })
  await first.catch(() => undefined)

  expect(adapter.getStatus(message.accountId)).toBe('busy')
  expect(listener).not.toHaveBeenCalled()

  finishSecond({ ok: true, data: { text: 'New reply' } })
  await second
  expect(adapter.getStatus(message.accountId)).toBe('online')
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'typing', isTyping: false }))
})

it('ignores late stream, activity and approval events from a superseded request', async () => {
  let emit!: (event: HermesTurnEvent) => void
  const requests: Array<Extract<HermesRpcRequest, { op: 'sendMessage' }>> = []
  const settled: Array<(res: HermesRpcResponse) => void> = []
  const rpc = (request: typeof requests[number]) => new Promise<HermesRpcResponse>((resolve) => {
    requests.push(request)
    settled.push(resolve)
  })
  vi.stubGlobal('window', { electron: { hermes: {
    onEvent: (listener: typeof emit) => { emit = listener; return () => undefined }, rpc
  } } })
  const adapter = new HermesAdapter()
  const listener = vi.fn()
  adapter.subscribe(listener)
  const accountId = 'fixture'
  const first = adapter.sendMessage({ accountId, conversationId: 'bot', sessionId: 'first', text: 'old' })
  const second = adapter.sendMessage({ accountId, conversationId: 'bot', sessionId: 'second', text: 'new' })
  listener.mockClear()
  const old = { accountId, requestId: requests[0]!.requestId, sessionId: 'first' }
  emit({ ...old, type: 'stream', messageId: 'stale', text: 'old', done: true })
  emit({ ...old, type: 'activity', activityCode: 'idle', busy: false })
  emit({ ...old, type: 'approvals', pending: [] })
  expect(listener).not.toHaveBeenCalled()
  emit({ type: 'stream', accountId, requestId: requests[1]!.requestId, sessionId: 'second', messageId: 'reply', text: 'new', done: true })
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({
    type: 'message', message: expect.objectContaining({ id: 'reply', sessionId: 'second' })
  }))
  for (const finish of settled) finish({ ok: true, data: {} })
  await Promise.all([first, second])
})
