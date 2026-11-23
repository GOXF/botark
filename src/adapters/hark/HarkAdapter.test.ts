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
