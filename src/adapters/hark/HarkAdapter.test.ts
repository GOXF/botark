import { afterEach, expect, it, vi } from 'vitest'
import type { HarkMainEvent } from '@shared/ipc'
import type { HarkRequest } from './harkRequests'
import { HarkAdapter } from './HarkAdapter'

afterEach(() => vi.unstubAllGlobals())
it('reads, sends and watches the explicitly selected conversation', async () => {
  const rpc = vi.fn(async (req: HarkRequest) => ({
    ok: true, data: req.op === 'conversationSnapshot'
      ? { conversationId: req.conversationId, messages: [{ id: 'old' }] } : {}
  }))
  vi.stubGlobal('window', { electron: { hark: { onEvent: () => () => {}, rpc } } })
  await new HarkAdapter().sendMessage({ accountId: 'account', conversationId: 'bot', sessionId: 'project', text: 'Hi' })
  expect(rpc.mock.calls.map(([r]) => r.op)).toEqual(['conversationSnapshot', 'sendMessage', 'pollReply'])
  for (const [request] of rpc.mock.calls) expect(request).toMatchObject({ conversationId: 'project' })
  expect(rpc.mock.calls[2]?.[0]).toMatchObject({ afterMessageIds: ['old'] })
})

it('creates a draft project untitled on its first message and reports the new id', async () => {
  const rpc = vi.fn(async (req: HarkRequest) => ({
    ok: true, data: req.op === 'createConversation' ? { conversationId: 'new' } : {}
  }))
  vi.stubGlobal('window', { electron: { hark: { onEvent: () => () => {}, rpc } } })
  const onAccepted = vi.fn()
  const receipt = await new HarkAdapter().sendMessage({ accountId: 'account', conversationId: 'bot', sessionId: 'hark:draft', text: 'Hi', onAccepted })
  expect(rpc.mock.calls.map(([r]) => r.op)).toEqual(['createConversation', 'sendMessage', 'pollReply'])
  expect(rpc.mock.calls[0]?.[0]).toMatchObject({ title: '' })
  expect(rpc.mock.calls[1]?.[0]).toMatchObject({ conversationId: 'new' })
  expect(onAccepted).toHaveBeenCalledWith('new')
  expect(receipt.sessionId).toBe('new')
})

it('does not send a stopped turn after the conversation lookup completes', async () => {
  const controller = new AbortController()
  let finish!: () => void
  const snapshot = new Promise<void>((resolve) => { finish = resolve })
  const rpc = vi.fn(async (req: HarkRequest) => {
    if (req.op === 'conversationSnapshot') await snapshot
    return { ok: true, data: { conversationId: 'project', messages: [] } }
  })
  vi.stubGlobal('window', { electron: { hark: { onEvent: () => () => {}, rpc } } })
  const turn = new HarkAdapter().sendMessage({
    accountId: 'account', conversationId: 'room-turn-1', sessionId: 'project', text: 'Hi', signal: controller.signal
  })
  controller.abort()
  finish()
  await expect(turn).rejects.toMatchObject({ name: 'AbortError' })
  expect(rpc.mock.calls.map(([req]) => req.op)).toEqual(['conversationSnapshot'])
})

it('acknowledges a send completed during Stop and does not start polling', async () => {
  const controller = new AbortController()
  const onAccepted = vi.fn()
  const rpc = vi.fn(async (req: HarkRequest) => {
    if (req.op === 'sendMessage') controller.abort()
    return { ok: true, data: { conversationId: 'project', messages: [] } }
  })
  vi.stubGlobal('window', { electron: { hark: { onEvent: () => () => {}, rpc } } })
  await expect(new HarkAdapter().sendMessage({
    accountId: 'account', conversationId: 'room-turn-1', sessionId: 'project', text: 'Hi', signal: controller.signal, onAccepted
  })).rejects.toMatchObject({ code: 'no-reply' })
  expect(onAccepted).toHaveBeenCalledOnce()
  expect(rpc.mock.calls.map(([req]) => req.op)).toEqual(['conversationSnapshot', 'sendMessage'])
})

function setupHarkAdapter(rpc: (request: HarkRequest) => Promise<unknown>) {
  let emit: (event: HarkMainEvent) => void = () => undefined
  vi.stubGlobal('window', { electron: { hark: {
    onEvent: (listener: typeof emit) => { emit = listener; return () => undefined }, rpc
  } } })
  const adapter = new HarkAdapter()
  const onMessage = vi.fn()
  adapter.onMessage(onMessage)
  return { adapter, onMessage, event: (event: HarkMainEvent) => emit(event) }
}

const turn = { accountId: 'account', conversationId: 'room-turn-test', sessionId: 'project', text: 'Hello' }
const completed: HarkMainEvent = {
  type: 'stream', accountId: 'account', conversationId: turn.conversationId, sessionId: 'project',
  messageId: 'hark_answer', text: 'Hello there', done: true
}

it.each([true, false])('publishes the terminal reply once and uses the send acknowledgement (event first: %s)', async (eventFirst) => {
  const fixture = setupHarkAdapter(async (req) => {
    if (req.op === 'conversationSnapshot') return { ok: true, data: { conversationId: 'project', messages: [] } }
    if (req.op === 'sendMessage') return { ok: true, data: { responseMessageId: 'answer', idempotencyKey: 'sent-id' } }
    if (eventFirst) {
      fixture.event(completed)
      fixture.event(completed)
    }
    return { ok: true, data: { outcome: 'completed', reply: { id: 'hark_answer', role: 'assistant', content: 'Hello there' } } }
  })
  await expect(fixture.adapter.sendMessage(turn)).resolves.toMatchObject({ messageId: 'sent-id', sessionId: 'project' })
  fixture.event(completed)
  expect(fixture.onMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'hark_answer', text: 'Hello there' }))
})

it('waits for the tail when the first finished message only ran tools', async () => {
  vi.useFakeTimers()
  const fixture = setupHarkAdapter(async (req) => {
    if (req.op === 'conversationSnapshot') return { ok: true, data: { conversationId: 'project', messages: [] } }
    if (req.op === 'sendMessage') return { ok: true, data: { responseMessageId: 'tools', idempotencyKey: 'sent-id' } }
    return { ok: true, data: { outcome: 'completed', tailing: true, reply: { id: 'hark_tools', role: 'assistant', content: '' } } }
  })
  let settled = false
  const sent = fixture.adapter.sendMessage(turn).then(() => { settled = true })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(settled).toBe(false)
  fixture.event(completed)
  await vi.advanceTimersByTimeAsync(1_500)
  await sent
  expect(fixture.onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello there' }))
  vi.useRealTimers()
})

it('cancels the exact main-process watch when the room aborts', async () => {
  const controller = new AbortController()
  const rpc = vi.fn(async (req: HarkRequest) => {
    if (req.op === 'pollReply') return new Promise(() => undefined)
    return { ok: true, data: { conversationId: 'project', messages: [] } }
  })
  const { adapter } = setupHarkAdapter(rpc)
  const pending = adapter.sendMessage({ ...turn, signal: controller.signal })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'no-reply' })
  await vi.waitFor(() => expect(rpc.mock.calls.at(-1)?.[0].op).toBe('pollReply'))
  const requestId = rpc.mock.calls.at(-1)?.[0].requestId
  controller.abort()
  await rejected
  expect(requestId).toEqual(expect.any(String))
  expect(rpc.mock.calls.at(-1)?.[0]).toEqual({ accountId: 'account', op: 'cancelRequest', requestId })
})

it.each([undefined, '', '   '])('refuses room sends without a valid project ID (%s)', async (sessionId) => {
  const rpc = vi.fn()
  const { adapter } = setupHarkAdapter(rpc)
  await expect(adapter.sendMessage({ ...turn, sessionId })).rejects.toThrow('No Hark project ID')
  expect(rpc).not.toHaveBeenCalled()
})

it.each([
  ['/api/messages/send', 'no-reply'],
  ['/api/files/upload/project/presign', 'network'],
  ['/api/files/project/file/finalize', 'network']
])('classifies a timeout from %s as %s', async (path, code) => {
  const { adapter } = setupHarkAdapter(async (req) => req.op === 'conversationSnapshot'
    ? { ok: true, data: { conversationId: 'project', messages: [] } }
    : { ok: false, status: 0, message: `Hark POST ${path} timed out` })
  await expect(adapter.sendMessage(turn)).rejects.toMatchObject({ code })
})
