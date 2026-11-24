import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { HARK_CHANNELS } from '@shared/ipc'
import type { HarkRequest } from '../../adapters/hark/harkRequests'

const { handle, send, fetch } = vi.hoisted(() => ({ handle: vi.fn(), send: vi.fn(), fetch: vi.fn<typeof globalThis.fetch>() }))
vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }] },
  ipcMain: { handle },
  session: { fromPartition: () => ({ fetch }) }
}))
vi.mock('../webContentsViewManager', () => ({ partitionForAccount: (id: string) => id }))
vi.mock('../muse/accountProxy', () => ({ applyProxyToPartition: vi.fn(), loadAccountProxyUrl: vi.fn() }))
vi.mock('../webViewIpc', () => ({ reloadAccountWebViews: vi.fn() }))
vi.mock('./harkLogin', () => ({ onHarkLoginEvent: vi.fn() }))

import { registerHarkIpc } from './harkIpc'

const renderer = (id: number) => Object.assign(new EventEmitter(), { id })
registerHarkIpc()
const handler = handle.mock.calls.find(([channel]) => channel === HARK_CHANNELS.rpc)?.[1] as
  (event: { sender: ReturnType<typeof renderer> }, request: HarkRequest) => Promise<unknown>
const accountId = 'account'
const replyWatch = { accountId, op: 'pollReply', botId: 'bot', conversationId: 'project', responseMessageId: 'expected', requestId: 'watch' } as const

it('keeps the reply watch active when stopping a tool and publishes exactly one terminal stream event', async () => {
  fetch.mockReset()
  send.mockClear()
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const cancelled = vi.fn()
  const body = new ReadableStream<Uint8Array>({ start: (controller) => { stream = controller }, cancel: cancelled })
  fetch.mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    .mockResolvedValueOnce(Response.json({ success: true }))
  const event = { sender: renderer(1) }
  const pending = handler(event, replyWatch)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  await handler(event, { accountId, op: 'call', path: '/messages/stop-tool', body: { conversationId: 'project' } })
  expect(cancelled).not.toHaveBeenCalled()
  const frame = { type: 'snapshot', data: { messages: [{ id: 'expected', content: 'Complete', jobStatus: 'completed' }] } }
  stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`))
  await expect(pending).resolves.toMatchObject({ ok: true, data: { outcome: 'completed', reply: { id: 'hark_expected' } } })
  const terminals = send.mock.calls.filter(([, payload]) => payload.type === 'stream' && payload.done)
  expect(terminals).toHaveLength(1)
  expect(terminals[0]?.[1]).toMatchObject({ messageId: 'hark_expected', text: 'Complete' })
})

it('only allows the owning renderer to cancel a watch request', async () => {
  fetch.mockReset()
  send.mockClear()
  const cancel = vi.fn()
  fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/event-stream' } }))
  const owner = { sender: renderer(1) }
  const pending = handler(owner, replyWatch)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  const request = { accountId, op: 'cancelRequest', requestId: 'watch' } as const
  await handler({ sender: renderer(2) }, request)
  expect(cancel).not.toHaveBeenCalled()
  await handler(owner, request)
  await expect(pending).resolves.toMatchObject({ data: { outcome: 'cancelled', reply: null } })
  expect(cancel).toHaveBeenCalledOnce()
  expect(send).not.toHaveBeenCalled()
})

it('rejects a malformed project response even when it contains main-conversation metadata', async () => {
  fetch.mockReset().mockResolvedValueOnce(Response.json({ conversationId: ' ', id: 'request-id', main: { id: 'main' } }))
  await expect(handler({ sender: renderer(1) }, { accountId, op: 'createConversation', title: 'Room' }))
    .resolves.toMatchObject({ ok: false, message: 'Hark returned no project ID' })
  expect(fetch).toHaveBeenCalledOnce()
})
