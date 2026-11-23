import { afterEach, expect, it, vi } from 'vitest'
import type { HarkRpcRequest } from '@shared/ipc'
import { HarkAdapter } from './HarkAdapter'

afterEach(() => vi.unstubAllGlobals())
it('reads, sends and watches the explicitly selected conversation', async () => {
  const rpc = vi.fn(async (req: HarkRpcRequest) => ({
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
  const rpc = vi.fn(async (req: HarkRpcRequest) => ({
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
  const rpc = vi.fn(async (req: HarkRpcRequest) => {
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
  const rpc = vi.fn(async (req: HarkRpcRequest) => {
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
