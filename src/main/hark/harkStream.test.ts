import type { Session } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { HarkConversationSyncState, readHarkStream, watchHarkConversationSync } from './harkClient'

const { sessionFetch } = vi.hoisted(() => ({ sessionFetch: vi.fn<typeof fetch>() }))
vi.mock('electron', () => ({ session: { fromPartition: () => ({ fetch: sessionFetch }) } }))
vi.mock('../webContentsViewManager', () => ({ partitionForAccount: (id: string) => id }))
vi.mock('../muse/accountProxy', () => ({ applyProxyToPartition: vi.fn() }))

afterEach(() => sessionFetch.mockReset())

const snapshot = (messages: Array<Record<string, unknown>>) => JSON.stringify({ type: 'snapshot', data: { messages } })
const patch = (id: string, fields: Record<string, unknown>) => JSON.stringify({
  type: 'patches', data: [{ op: 'message_update', id, fields }]
})
const encodeEvent = (frame: string) => new TextEncoder().encode(`data: ${frame}\n\n`)

function openStream(frames: string[] = []) {
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(controller) { stream = controller; for (const frame of frames) stream.enqueue(encodeEvent(frame)) },
    cancel
  })
  return { stream, cancel, response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) }
}

it('decodes split SSE records for the selected conversation and ignores heartbeat events', async () => {
  const chunks = ['event: ping\r\ndata: beat\r\n\r\ndata: {"text":"', 'line"}\ndata: part two\n\n']
  const fetch = vi.fn(async () => new Response(new ReadableStream({
    start(controller) {
      for (const part of chunks) controller.enqueue(new TextEncoder().encode(part))
      controller.close()
    }
  }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const frames: string[] = []
  await readHarkStream({ fetch } as unknown as Session, 'fixture/thread', 'manager', 'initial',
    new AbortController().signal, (frame) => frames.push(frame))
  expect(frames).toEqual(['{"text":"line"}\npart two'])
  const url = new URL((fetch.mock.calls as unknown as [string][])[0]![0])
  expect(url.searchParams.get('conversationId')).toBe('fixture/thread')
})

it('keeps the live status when joining a run whose snapshot carries an object activity', async () => {
  const { HarkConversationSyncState } = await import('./harkClient')
  const state = new HarkConversationSyncState()
  state.applyFrame(JSON.stringify({ type: 'snapshot', data: { messages: [], activeActivity: { label: '正在处理文件。' } } }))
  expect(state.liveStatus()).toEqual({ busy: true, text: '正在处理文件。' })
})

it('keeps the current browser frame in the selected conversation as Hark updates its activity window', async () => {
  const { currentHarkBrowser } = await import('@shared/harkBrowserPreview')
  const state = new HarkConversationSyncState()
  state.applyFrame(JSON.stringify({ type: 'snapshot', data: {
    windows: { w: { panels: [
      { dispatchId: 'browser', kind: 'browser', status: 'active', title: 'Schedule', screenshot: { key: 'frame1' } },
      { dispatchId: 'old', kind: 'browser', status: 'completed', screenshot: { key: 'old-frame' } }
    ] } }
  } }))
  expect(currentHarkBrowser(state.extractPanels())).toMatchObject({ label: 'Schedule', screenshotKey: 'frame1' })
  state.applyFrame(JSON.stringify({ type: 'patches', data: [{
    op: 'panel_update', id: 'w', dispatchId: 'browser', fields: { screenshot: { key: 'frame2' } }
  }] }))
  expect(currentHarkBrowser(state.extractPanels())?.screenshotKey).toBe('frame2')
  state.applyFrame(JSON.stringify({ type: 'snapshot', data: {} }))
  expect(currentHarkBrowser(state.extractPanels())).toBeNull()
})

import { harkRunningToolLine } from './harkClient'
it('running tool gives a live line when Hark sends no narration', () => {
  expect(harkRunningToolLine({ toolCalls: [{ name: 'browser', status: 'running', detail: '查看日志' }] })).toBe('正在用浏览器：查看日志')
  expect(harkRunningToolLine({ toolCalls: [{ name: 'shell', status: 'completed' }] })).toBe('')
})

it('stays busy between turns while a background job keeps running, and reads renamed narration ops', async () => {
  const { HarkConversationSyncState } = await import('./harkClient')
  const state = new HarkConversationSyncState()
  state.applyFrame(JSON.stringify({ type: 'snapshot', data: { messages: [
    { id: 'a1', role: 'assistant', content: '好了', isStreaming: false, toolCalls: [{ dispatchId: 'd1', toolName: 'shell', status: 'running', input: { command: 'poll ci' } }] }
  ] } }))
  expect(state.liveStatus().busy).toBe(true)
  state.applyFrame(JSON.stringify({ type: 'patches', data: [{ op: 'narration_set', value: '正在等待构建完成。' }] }))
  expect(state.liveStatus()).toEqual({ busy: true, text: '正在等待构建完成。' })
})

it('reads Hark narration objects ({ line, working, answered }) like the web app', async () => {
  const { HarkConversationSyncState } = await import('./harkClient')
  const state = new HarkConversationSyncState()
  state.applyFrame(JSON.stringify({ type: 'snapshot', data: { messages: [], narration: { line: '正在查询订单文件。', live: true, visible: true, working: true } } }))
  expect(state.liveStatus()).toEqual({ busy: true, text: '正在查询订单文件。' })
  state.applyFrame(JSON.stringify({ type: 'patches', data: [{ op: 'narration_update', value: { line: '正在查询数据库记录。' } }] }))
  expect(state.liveStatus()).toEqual({ busy: true, text: '正在查询数据库记录。' })
  state.applyFrame(JSON.stringify({ type: 'patches', data: [{ op: 'narration_update', value: { visible: true, answered: true } }] }))
  expect(state.liveStatus()).toEqual({ busy: false, text: '' })
  state.applyFrame(JSON.stringify({ type: 'snapshot', data: { messages: [], narration: JSON.stringify({ live: true, working: true }) } }))
  expect(state.liveStatus().busy).toBe(true)
})

it('uses only SSE while it is live and honours the exact response ID and explicit job status', async () => {
  const sse = openStream([snapshot([
    { id: 'other', role: 'assistant', content: 'other send', jobStatus: 'completed' },
    { id: 'target', role: 'assistant', content: 'partial', isStreaming: false, jobStatus: 'running' }
  ])])
  sessionFetch.mockResolvedValueOnce(sse.response)
  const onUpdate = vi.fn()
  const reply = watchHarkConversationSync('account', 'project', { responseMessageId: 'target', onUpdate })
  await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledOnce())
  expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({ id: 'target', content: 'partial' })
  expect(onUpdate.mock.calls[0]?.[2]).toBe(false)
  expect(sessionFetch).toHaveBeenCalledOnce()
  sse.stream.enqueue(encodeEvent(patch('target', { content: 'final reply', jobStatus: 'completed', isStreaming: true })))
  await expect(reply).resolves.toMatchObject({ outcome: 'completed', reply: { id: 'target', content: 'final reply' } })
  expect(onUpdate.mock.calls.filter((call) => call[2])).toHaveLength(1)
  expect(sse.cancel).toHaveBeenCalledOnce()
  expect(sessionFetch).toHaveBeenCalledOnce()
})

it('cancels idle SSE before polling and keeps a lagging poll snapshot from rolling back live text', async () => {
  const sse = openStream([snapshot([{ id: 'target', content: 'long live reply', jobStatus: 'running' }])])
  sessionFetch.mockResolvedValueOnce(sse.response).mockImplementationOnce(async () => {
    expect(sse.cancel).toHaveBeenCalledOnce()
    return Response.json({ frames: [
      snapshot([{ id: 'target', content: 'long live', jobStatus: 'running' }]),
      patch('target', { content: 'long live reply finished', jobStatus: 'completed' })
    ] })
  })
  const texts: string[] = []
  await expect(watchHarkConversationSync('account', 'project', {
    responseMessageId: 'target', idleTimeoutMs: 25, onUpdate: (message) => texts.push(message.content)
  })).resolves.toMatchObject({ outcome: 'completed' })
  expect(texts).toEqual(['long live reply', 'long live reply', 'long live reply finished'])
  expect(sessionFetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/sync/conversation', '/api/sync/poll'])
})

it('returns timeout without taking another send’s completed reply', async () => {
  const sse = openStream([snapshot([{ id: 'other', content: 'wrong send', jobStatus: 'completed' }])])
  sessionFetch.mockResolvedValueOnce(sse.response)
  const onUpdate = vi.fn()
  await expect(watchHarkConversationSync('account', 'project', {
    responseMessageId: 'missing', timeoutMs: 30, onUpdate
  })).resolves.toEqual({ reply: null, outcome: 'timed-out', tailing: false })
  expect(onUpdate).not.toHaveBeenCalled()
  expect(sessionFetch).toHaveBeenCalledOnce()
})

it.each(['cancelled', 'failed'] as const)('does not publish partial text as done on %s jobs', async (jobStatus) => {
  sessionFetch.mockResolvedValueOnce(openStream([snapshot([{ id: 'target', content: 'partial', jobStatus }])]).response)
  const onUpdate = vi.fn()
  await expect(watchHarkConversationSync('account', 'project', { responseMessageId: 'target', onUpdate }))
    .resolves.toMatchObject({ reply: null, outcome: jobStatus })
  expect(onUpdate).not.toHaveBeenCalled()
})

it('cancels the fallback retry wait when the observer aborts', async () => {
  sessionFetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
  const controller = new AbortController()
  const reply = watchHarkConversationSync('account', 'project', { signal: controller.signal })
  await vi.waitFor(() => expect(sessionFetch).toHaveBeenCalledTimes(2))
  const fallback = sessionFetch.mock.calls[1]?.[1]?.signal
  controller.abort()
  await expect(reply).resolves.toMatchObject({ outcome: 'cancelled', reply: null })
  expect(fallback?.aborted).toBe(true)
  expect(sessionFetch).toHaveBeenCalledTimes(2)
})

it('does not invalidate project history for narration-only frames', () => {
  const state = new HarkConversationSyncState()
  state.applyFrame(snapshot([{ id: 'one', content: 'hello' }]))
  const before = state.historyRevision
  expect(state.applyFrame(patch('one', { narration: 'Thinking' }))).toBe(true)
  expect(state.applyFrame(JSON.stringify({ type: 'patches', data: [{ op: 'active_activity_set', value: 'Working' }] }))).toBe(true)
  expect(state.historyRevision).toBe(before)
  expect(state.activeActivity).toBe('Working')
})

it('stays busy while Hark reports activeWork after the reply, and goes idle when it clears', async () => {
  const { HarkConversationSyncState } = await import('./harkClient')
  const state = new HarkConversationSyncState()
  state.applyFrame(JSON.stringify({ type: 'snapshot', data: { messages: [{ id: 'a1', role: 'assistant', content: '好了', isStreaming: false }], activeWork: {} } }))
  expect(state.liveStatus().busy).toBe(false)
  state.applyFrame(JSON.stringify({ type: 'patches', data: [{ op: 'active_work_set', value: [{ dispatchId: 'tu_1', messageId: 'a1', site: 'ciyundata.com', state: 'working' }] }] }))
  expect(state.liveStatus()).toEqual({ busy: true, text: '正在打开 ciyundata.com' })
  state.applyFrame(JSON.stringify({ type: 'patches', data: [{ op: 'active_work_set', value: null }] }))
  expect(state.liveStatus().busy).toBe(false)
})
