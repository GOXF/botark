import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { historyAssistantsAfterTurn, MUSE_STREAM_SUPERSEDED, MuseChatChannel, parseHistoryTranscript, parseRichWidgets, streamChat } from './chat'
import type { MuseNativeGateway, SubscriptionHandle } from './gateway'

class FakeGateway extends EventEmitter {
  ready = true
  subscribeCount = 0
  historyCalls = 0
  historyPayload: unknown = { events: [] }
  private activeSubDone?: () => void
  private activeSubEmit?: (e: Record<string, unknown>) => void
  blockReopen = false
  readonly requests: Array<{ method: string; params: unknown }> = []

  isReady(): boolean {
    return this.ready
  }

  async connect(): Promise<void> {
    this.ready = true
  }

  async subscribe(
    method: string,
    _params: Record<string, unknown>,
    onEvent: (e: Record<string, unknown>) => void,
    _signal?: AbortSignal,
    onDispatched?: () => void
  ): Promise<SubscriptionHandle> {
    if (method === 'chat.stream') {
      onDispatched?.()
      return {
        ack: Promise.resolve({ session_id: 'sess_1', message_id: 'usr_1' }),
        done: Promise.resolve(),
        cancel: () => undefined
      }
    }
    if (this.blockReopen && this.subscribeCount > 0) {
      throw new Error('offline')
    }
    this.subscribeCount += 1
    this.activeSubEmit = onEvent
    let resolveDone!: () => void
    const done = new Promise<void>((r) => {
      resolveDone = r
    })
    this.activeSubDone = resolveDone
    return {
      ack: Promise.resolve({ ok: true }),
      done,
      cancel: () => resolveDone()
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params })
    if (method === 'chat.history') {
      this.historyCalls += 1
      return this.historyPayload
    }
    return {}
  }

  endChatSubscribe(): void {
    this.activeSubDone?.()
  }

  pushChatEvent(name: string, payload: Record<string, unknown>, seq = 0): void {
    this.activeSubEmit?.({ type: 'event', event: name, seq, payload })
  }
}

describe('Muse browser cards', () => {
  it('merges top-level tool blocks with nested UI widgets even without preview identifiers', () => {
    const widgets = parseRichWidgets({
      content: [
        { type: 'text', text: 'Google opened.' },
        { type: 'tool_use', id: 'call-1', name: 'mcp__web_browser__open_url', input: { url: 'https://google.com' } },
        { type: 'ui_widget', widget: { kind: 'browser_task', data: { status: 'Completed', title: 'Google' } } },
        { type: 'ui_widget', data: { computer_use: { title: 'Cloud desktop', status: 'running' } } },
        { type: 'tool_use', id: 'call-2', name: 'web_search', input: { url: 'https://example.com' } }
      ]
    })
    expect(widgets).toHaveLength(2)
    expect(widgets[0]).toMatchObject({
      kind: 'session_card', cardType: 'browser', url: 'https://google.com', status: 'Completed', title: 'Google',
      taskId: undefined, previewSha256: undefined
    })
    expect(widgets[1]).toMatchObject({ kind: 'session_card', cardType: 'computer', title: 'Cloud desktop' })
  })

  it('keeps screenshot references separate from the page URL and preserves distinct tasks', () => {
    const widgets = parseRichWidgets({ content: [
      { type: 'ui_widget', widget_id: 'browser-widget', widget: { kind: 'browser_task', data: {
        page_url: 'https://google.com', preview: { url: '/api/computer/previews/task-1/frame-1' }
      } } },
      { kind: 'browser_task', task_id: 'task-2', screenshot: { image_url: 'https://muse.ai/previews/other.png' } }
    ] })
    expect(widgets).toMatchObject([
      { widgetId: 'browser-widget', taskId: 'task-1', previewSha256: 'frame-1', url: 'https://google.com' },
      { taskId: 'task-2', previewSrc: 'https://muse.ai/previews/other.png', url: undefined }
    ])
  })

  it('retains an embedded widget screenshot when it has no screenshot reference', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII='
    const [row] = parseHistoryTranscript({ messages: [{ id: 'reply', role: 'assistant', content: [
      { type: 'ui_widget', widget: { kind: 'browser_task', data: { screenshot: { image_base64: png } } } }
    ] }] })
    expect(row?.richWidgets).toMatchObject([{ cardType: 'browser', previewSrc: `data:image/png;base64,${png}` }])
  })

  it('streams and enriches one card across a tool call, result, and presentation', async () => {
    const fake = new FakeGateway()
    const gateway = fake as unknown as MuseNativeGateway
    const channel = new MuseChatChannel(gateway)
    const accepted = deferred<void>()
    const update = vi.fn()
    const turn = streamChat(gateway, channel, {
      text: 'Open Google', nodeId: 'dev', sessionId: 'sess_1', onAck: () => accepted.resolve()
    }, update, { settleMs: 5, timeoutMs: 2000 })
    try {
      await accepted.promise
      fake.pushChatEvent('tool_use', { session_id: 'sess_1', id: 'call-1', name: 'browser_navigate' })
      fake.pushChatEvent('delta.message_start', { message_id: 'bot_1' })
      expect(update.mock.lastCall?.[0].richWidgets).toMatchObject([{ cardType: 'browser', status: '正在工作' }])

      fake.pushChatEvent('tool_result', {
        tool_use_id: 'call-1',
        content: [{ type: 'text', text: JSON.stringify({
          task: { id: 'web-1', current_url: 'https://google.com' },
          screenshot: { image_hash: 'frame-old' }
        }) }]
      })
      expect(update.mock.lastCall?.[0].richWidgets).toMatchObject([{ taskId: 'web-1', previewSha256: 'frame-old' }])

      fake.pushChatEvent('browser.completed', {
        session_id: 'another-session', message_id: 'bot_1', task_id: 'other-task', preview_sha256: 'wrong-frame'
      })
      fake.pushChatEvent('ui_widget', {
        message_id: 'bot_1', widget: { kind: 'browser_task', data: { taskId: 'web-1', title: 'Google' } }
      })
      fake.pushChatEvent('delta.message_done', { message_id: 'bot_1', status: 'completed', content: [
        { type: 'text', text: 'Google opened.' },
        { type: 'ui_widget', data: { browser: { task_id: 'web-1', preview_sha256: 'frame-final' } } }
      ] })
      const result = await turn
      expect(result.text).toBe('Google opened.')
      expect(result.richWidgetsByMessageId['bot_1']).toMatchObject([{
        kind: 'session_card', cardType: 'browser', title: 'Google', taskId: 'web-1',
        previewSha256: 'frame-final', url: 'https://google.com', status: 'Completed'
      }])
    } finally {
      channel.stop()
    }
  })

  it('keeps browser metadata attached to the referenced reply when hydrating and reconciling history', () => {
    const raw = { result: { events: [
      { event: 'message.user', message_id: 'user-1', content: 'Open Google' },
      { event: 'tool_call.started', message_id: 'reply-1', payload: { tool: { id: 'call-1', name: 'open_url' } } },
      { event: 'message.assistant', message_id: 'reply-1', content: [{ type: 'text', text: 'Google is open.' }] },
      { event: 'message.assistant', message_id: 'reply-2', content: 'Anything else?' },
      { event: 'tool_call.completed', tool_id: 'call-1', result: { task: { id: 'task-1' }, preview_sha256: 'frame-1' } },
      { event: 'message.user', message_id: 'user-2', content: 'What time is it?' },
      { event: 'message.assistant', message_id: 'reply-3', content: 'It is 9 AM.' }
    ] } }
    const expected = [{ kind: 'session_card', cardType: 'browser', taskId: 'task-1', previewSha256: 'frame-1', status: 'Completed' }]
    const history = parseHistoryTranscript(raw)
    expect(history.filter((row) => row.richWidgets?.length)).toMatchObject([{
      id: 'muse_native_reply-1', text: 'Google is open.', richWidgets: expected
    }])
    const recovered = historyAssistantsAfterTurn(raw, { ackUserMessageId: 'user-1', turnStartedAtMs: Date.now() })
    expect(recovered.filter((row) => row.richWidgets?.length)).toMatchObject([{
      id: 'reply-1', text: 'Google is open.', richWidgets: expected
    }])
  })

  it('keeps the newest frame when reconciliation returns older widget metadata', async () => {
    const fake = new FakeGateway()
    const gateway = fake as unknown as MuseNativeGateway
    const channel = new MuseChatChannel(gateway)
    const accepted = deferred<void>()
    const turn = streamChat(gateway, channel, {
      text: 'Open Google', nodeId: 'dev', sessionId: 'sess_1', onAck: () => accepted.resolve()
    }, vi.fn(), { settleMs: 5, timeoutMs: 2000 })
    try {
      await accepted.promise
      fake.historyPayload = { events: [
        { event: 'message.assistant', message_id: 'bot_1', seq: 2, content: 'Google is open.',
          widgets: [{ kind: 'browser_task', task_id: 'task-1', preview_sha256: 'older' }] }
      ] }
      fake.pushChatEvent('browser.completed', {
        session_id: 'sess_1', message_id: 'bot_1', task_id: 'task-1', preview_sha256: 'newest'
      }, 3)
      fake.pushChatEvent('delta.message_done', { message_id: 'bot_1', display_text: 'Google is open.' }, 4)
      const result = await turn
      expect(result.richWidgetsByMessageId['bot_1']).toMatchObject([{ taskId: 'task-1', previewSha256: 'newest' }])
    } finally {
      channel.stop()
    }
  })
})

describe('streamChat subscription recovery', () => {
  it('clears gapTimer when chat.subscribe reopens while silent (e.g. waiting for Sentinel approval)', async () => {
    const gw = new FakeGateway()
    const channel = new MuseChatChannel(gw as unknown as MuseNativeGateway)
    const updates: Array<{ text: string; done: boolean }> = []

    const turnPromise = streamChat(
      gw as unknown as MuseNativeGateway,
      channel,
      { text: 'upload file', nodeId: 'dev_1', sessionId: 'sess_1' },
      (u) => updates.push({ text: u.text, done: u.done }),
      { recoverMs: 80, settleMs: 30, timeoutMs: 3000 }
    )

    // Let chat.stream ack settle.
    await new Promise((r) => setTimeout(r, 20))
    // Server resets chat.subscribe while WS stays open; MuseChatChannel auto-reopens it.
    gw.endChatSubscribe()

    // Wait LONGER than recoverMs (80ms) with ZERO chat events (simulating waiting for user approval).
    await new Promise((r) => setTimeout(r, 160))
    expect(gw.subscribeCount).toBeGreaterThanOrEqual(2)

    // Now user approves and assistant finishes.
    gw.pushChatEvent('delta.message_done', {
      session_id: 'sess_1',
      message_id: 'asst_1',
      status: 'completed',
      display_text: 'Screenshot uploaded to issue #41.'
    })

    const res = await turnPromise
    expect(res.text).toBe('Screenshot uploaded to issue #41.')
    expect(updates.some((u) => u.done && u.text.includes('Screenshot uploaded'))).toBe(true)
    channel.stop()
  })

  it('backfills missed reply from chat.history even when order was empty before disconnect', async () => {
    const gw = new FakeGateway()
    const channel = new MuseChatChannel(gw as unknown as MuseNativeGateway)
    const now = Date.now()
    gw.historyPayload = {
      events: [
        {
          event_name: 'message.assistant',
          message_id: 'asst_missed',
          occurred_at_ms: now + 500,
          display_text: 'Recovered from history after reconnect.',
          payload: { status: 'completed' }
        }
      ]
    }

    const turnPromise = streamChat(
      gw as unknown as MuseNativeGateway,
      channel,
      { text: 'run task', nodeId: 'dev_1', sessionId: 'sess_1' },
      () => undefined,
      { recoverMs: 250, settleMs: 30, timeoutMs: 3000 }
    )

    await new Promise((r) => setTimeout(r, 20))
    // Drop subscription before any assistant bubble started (order is empty []).
    gw.ready = false
    gw.endChatSubscribe()

    await new Promise((r) => setTimeout(r, 40))
    gw.ready = true
    gw.emit('phase', 'ready')

    const res = await turnPromise
    expect(gw.historyCalls).toBeGreaterThanOrEqual(1)
    expect(res.text).toBe('Recovered from history after reconnect.')
    channel.stop()
  })

  it('still fails with recovery error when gateway stays disconnected past recoverMs', async () => {
    const gw = new FakeGateway()
    const channel = new MuseChatChannel(gw as unknown as MuseNativeGateway)

    const turnPromise = streamChat(
      gw as unknown as MuseNativeGateway,
      channel,
      { text: 'hello', nodeId: 'dev_1', sessionId: 'sess_1' },
      () => undefined,
      { recoverMs: 60, settleMs: 30, timeoutMs: 3000 }
    )

    await new Promise((r) => setTimeout(r, 20))
    gw.ready = false
    gw.blockReopen = true
    gw.endChatSubscribe()

    await expect(turnPromise).rejects.toThrow('Muse gateway did not recover mid-reply')
    channel.stop()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Muse turn ownership and deadline', () => {
  it.each(['connect', 'chat.subscribe', 'send ACK', 'send stream end'] as const)('applies the same deadline while waiting for %s', async (stage) => {
    const fake = new FakeGateway()
    const gateway = fake as unknown as MuseNativeGateway
    const channel = new MuseChatChannel(gateway)
    const pending = new Promise<never>(() => undefined)
    const subscribe = fake.subscribe.bind(fake)
    const cancel = vi.fn()
    if (stage === 'connect') vi.spyOn(fake, 'connect').mockReturnValue(pending)
    vi.spyOn(fake, 'subscribe').mockImplementation(async (...args) => {
      if (stage === 'chat.subscribe' && args[0] === 'chat.subscribe') return pending
      const handle = await subscribe(...args)
      if (args[0] !== 'chat.stream') return handle
      return { ack: stage === 'send ACK' ? pending : handle.ack, done: pending, cancel }
    })
    const abort = new AbortController()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    try {
      await expect(streamChat(gateway, channel, { text: 'hello', nodeId: 'dev' }, vi.fn(), {
        timeoutMs: 30, signal: abort.signal
      })).rejects.toMatchObject({ code: 'timeout' })
      expect(channel.listenerCount('event')).toBe(0)
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
      expect(fake.requests).not.toContainEqual(expect.objectContaining({ method: 'chat.cancel' }))
      if (stage === 'send ACK' || stage === 'send stream end') expect(cancel).toHaveBeenCalledOnce()
    } finally {
      channel.stop()
    }
  })

  it('stops upstream once for an explicit Stop while the send ACK is still pending', async () => {
    const fake = new FakeGateway()
    const gateway = fake as unknown as MuseNativeGateway
    const channel = new MuseChatChannel(gateway)
    const ack = deferred<Record<string, unknown>>()
    const dispatched = deferred<void>()
    const ctrl = new AbortController()
    const subscribe = fake.subscribe.bind(fake)
    const cancel = vi.fn()
    vi.spyOn(fake, 'subscribe').mockImplementation(async (...args) => {
      const handle = await subscribe(...args)
      if (args[0] !== 'chat.stream') return handle
      dispatched.resolve()
      return { ...handle, ack: ack.promise, cancel }
    })
    const onAck = vi.fn()
    const turn = streamChat(gateway, channel, { text: 'hello', nodeId: 'dev', sessionId: 'sess_1', onAck }, vi.fn(), { signal: ctrl.signal })
    await dispatched.promise
    ctrl.abort()
    await expect(turn).rejects.toMatchObject({ name: 'AbortError' })
    ack.resolve({ message_id: 'late', session_id: 'sess_1' })
    expect(fake.requests.filter((request) => request.method === 'chat.cancel')).toEqual([
      { method: 'chat.cancel', params: { session_id: 'sess_1' } }
    ])
    expect(onAck).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
    channel.stop()
  })

  it('uses the send ACK to match early user and assistant events', async () => {
    const fake = new FakeGateway()
    const gateway = fake as unknown as MuseNativeGateway
    const channel = new MuseChatChannel(gateway)
    const ack = deferred<Record<string, unknown>>()
    const dispatched = deferred<void>()
    const subscribe = fake.subscribe.bind(fake)
    vi.spyOn(fake, 'subscribe').mockImplementation(async (...args) => {
      const handle = await subscribe(...args)
      if (args[0] !== 'chat.stream') return handle
      dispatched.resolve()
      return { ...handle, ack: ack.promise }
    })
    const update = vi.fn()
    const onAck = vi.fn()
    const turn = streamChat(gateway, channel, { text: 'hello', nodeId: 'dev', onAck }, update, { settleMs: 5, timeoutMs: 1000 })
    await dispatched.promise
    fake.pushChatEvent('message.user', { session_id: 'sess_1', message_id: 'other_user' })
    fake.pushChatEvent('delta.message_done', { session_id: 'sess_1', message_id: 'other_reply', text: 'Wrong' })
    fake.pushChatEvent('message.user', { session_id: 'sess_1', message_id: 'own_user' })
    fake.pushChatEvent('delta.message_done', { session_id: 'sess_1', message_id: 'own_reply', display_text: 'Right' })
    expect(onAck).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    ack.resolve({ session_id: 'sess_1', message_id: 'own_user' })
    await expect(turn).resolves.toMatchObject({ sessionId: 'sess_1', text: 'Right', assistantMessageIds: ['own_reply'] })
    expect(onAck).toHaveBeenCalledExactlyOnceWith('sess_1')
    channel.stop()
  })

  it.each([true, false])('validates ownership again before using a late Stop ACK (owner: %s)', async (ownsTurn) => {
    const fake = new FakeGateway()
    const gateway = fake as unknown as MuseNativeGateway
    const channel = new MuseChatChannel(gateway)
    const ack = deferred<Record<string, unknown>>()
    const dispatched = deferred<void>()
    const ctrl = new AbortController()
    const subscribe = fake.subscribe.bind(fake)
    const cancel = vi.fn()
    vi.spyOn(fake, 'subscribe').mockImplementation(async (...args) => {
      const handle = await subscribe(...args)
      if (args[0] !== 'chat.stream') return handle
      dispatched.resolve()
      return { ...handle, ack: ack.promise, cancel }
    })
    const turn = streamChat(gateway, channel, {
      text: 'hello', nodeId: 'dev', canCancel: () => ownsTurn
    }, vi.fn(), { signal: ctrl.signal })
    await dispatched.promise
    ctrl.abort()
    await expect(turn).rejects.toMatchObject({ name: 'AbortError' })
    expect(fake.requests).toEqual([])
    ack.resolve({ message_id: 'ack', session_id: 'assigned-session' })
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(fake.requests).toEqual(ownsTurn ? [{ method: 'chat.cancel', params: { session_id: 'assigned-session' } }] : [])
    channel.stop()
  })

  it('keeps overlapping reconnect snapshots from duplicating deltas and applies shorter completed text', async () => {
    const fake = new FakeGateway()
    const gateway = fake as unknown as MuseNativeGateway
    const channel = new MuseChatChannel(gateway)
    const accepted = deferred<void>()
    const updates: string[] = []
    const row = (text: string, status: string, seq: number) => ({
      events: [{ event: 'message.assistant', message_id: 'bot_1', occurred_at_ms: Date.now(), seq, display_text: text, payload: { status } }]
    })
    fake.historyPayload = row('Hello world', 'streaming', 3)
    const turn = streamChat(gateway, channel, {
      text: 'hello', nodeId: 'dev', sessionId: 'sess_1', onAck: () => accepted.resolve()
    }, (u) => updates.push(u.text), { settleMs: 5, timeoutMs: 2000 })
    await accepted.promise
    fake.pushChatEvent('delta.text_append', { message_id: 'bot_1', text: 'Hello ' }, 2)
    fake.endChatSubscribe()
    await vi.waitFor(() => expect(fake.subscribeCount).toBe(2))
    // Deltas may reach the new socket before the history request returns.
    fake.pushChatEvent('delta.text_append', { message_id: 'bot_1', text: ' there' }, 4)
    await vi.waitFor(() => expect(updates.at(-1)).toBe('Hello world there'))
    fake.pushChatEvent('delta.text_append', { message_id: 'bot_1', text: 'world' }, 3)
    expect(updates.at(-1)).toBe('Hello world there')
    expect(updates).not.toContain('Hello worldworld')
    fake.historyPayload = row('Hello', 'completed', 6)
    fake.pushChatEvent('delta.message_done', { message_id: 'bot_1', display_text: 'Hello world there', status: 'completed' }, 5)
    await expect(turn).resolves.toMatchObject({ text: 'Hello' })
    expect(updates.at(-1)).toBe('Hello')
    channel.stop()
  })

  it('drops a history response that resolves after the turn was superseded', async () => {
    const fake = new FakeGateway()
    const gateway = fake as unknown as MuseNativeGateway
    const channel = new MuseChatChannel(gateway)
    const ctrl = new AbortController()
    const accepted = deferred<void>()
    const history = deferred<unknown>()
    const historyStarted = deferred<void>()
    const request = vi.spyOn(fake, 'request').mockImplementation(async () => {
      historyStarted.resolve()
      return history.promise
    })
    const update = vi.fn()
    const turn = streamChat(gateway, channel, {
      text: 'hello', nodeId: 'dev', sessionId: 'sess_1', onAck: () => accepted.resolve()
    }, update, { signal: ctrl.signal, settleMs: 5 })
    await accepted.promise
    fake.pushChatEvent('delta.message_done', { message_id: 'bot_1', display_text: 'Original' })
    await historyStarted.promise
    ctrl.abort(MUSE_STREAM_SUPERSEDED)
    await expect(turn).rejects.toThrow('superseded')
    history.resolve({ events: [{ event: 'message.assistant', message_id: 'bot_1', display_text: 'Stale answer' }] })
    await Promise.resolve()
    expect(update).toHaveBeenCalledOnce()
    expect(request.mock.calls.every(([method]) => method !== 'chat.cancel')).toBe(true)
    channel.stop()
  })

  it('clears the opening promise before retrying and drops retries after disposal', async () => {
    vi.useFakeTimers()
    const fake = new FakeGateway()
    const channel = new MuseChatChannel(fake as unknown as MuseNativeGateway)
    const subscribe = vi.spyOn(fake, 'subscribe').mockRejectedValueOnce(new Error('temporary failure'))
    const resumed = vi.fn()
    channel.on('resumed', resumed)
    try {
      const first = channel.ensure()
      await Promise.all([
        expect(first).rejects.toThrow('temporary failure'),
        expect(channel.ensure()).rejects.toThrow('temporary failure')
      ])
      expect(subscribe).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1500)
      expect(subscribe).toHaveBeenCalledTimes(2)
      expect(resumed).toHaveBeenCalledOnce()
      fake.endChatSubscribe()
      channel.stop()
      await vi.advanceTimersByTimeAsync(3000)
      expect(subscribe).toHaveBeenCalledTimes(2)
      expect(fake.listenerCount('phase')).toBe(0)
    } finally {
      channel.stop()
      vi.useRealTimers()
    }
  })
})
