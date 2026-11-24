import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GrokMainEvent } from '@shared/ipc'
import { ensureGrokAccountWatch, stopGrokAccountWatch } from './grokWatchManager'
import type { GrokConnectClient } from './connectClient'

function b64Json(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')
}

function untilAborted(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) resolve()
    else signal?.addEventListener('abort', () => resolve(), { once: true })
  })
}

const assistant = (id: string, seq: number, text = id, streaming = false) => ({
  entry_id: id, kind: 'send-message', seq: String(seq), content: text, is_streaming: streaming
})

describe('grokWatchManager', () => {
  const accountId = 'acc_watch_test'

  afterEach(() => {
    stopGrokAccountWatch(accountId)
  })

  it('processes WatchGrokBotTranscripts frames: agent_state, rows multi-bubble, presigned media, approvals, and turn_failed', async () => {
    const emitted: GrokMainEvent[] = []
    let seeded = false

    const fakeClient = {
      resolveAttachmentReads: async ({ paths }: { paths: string[] }) => ({
        reads: paths.map((p) => ({
          path: p,
          url: `https://signed.cursor.sh${p}`,
          expiresAtMs: Date.now() + 60_000,
          contentType: 'image/png'
        }))
      }),
      listTranscriptEntries: async () => {
        if (!seeded) {
          seeded = true
          return { generation: 1, entries: [] }
        }
        return {
          generation: 1,
          entries: [
            {
              seq: '10',
              entry_kind: 'send-message',
              entry_id: 'tbs_backfill',
              body: b64Json({
                kind: 'send-message',
                id: 'tbs_backfill',
                message: { type: 'text', content: '补洞恢复的历史消息' }
              })
            }
          ]
        }
      },
      watchTranscripts: async function* (
        _req: unknown,
        signal?: AbortSignal
      ): AsyncGenerator<Record<string, unknown>, void, void> {
        yield {
          agent_state: {
            agent_id: 'agent-1',
            is_running: true,
            is_composing_message: true,
            has_running_subagents: true
          }
        }
        yield {
          rows: {
            agent_id: 'agent-1',
            entries: [
              {
                seq: '1',
                entry_kind: 'send-message',
                entry_id: 'tbs1',
                body: b64Json({
                  kind: 'send-message',
                  id: 'tbs1',
                  message: { type: 'text', content: '第一条确认气泡' }
                })
              },
              {
                seq: '2',
                entry_kind: 'send-message',
                entry_id: 'tbs2',
                body: b64Json({
                  kind: 'send-message',
                  id: 'tbs2',
                  message: {
                    type: 'attachment',
                    path: '/box/chart.png',
                    name: 'chart.png',
                    mimeType: 'image/png'
                  }
                })
              },
              {
                seq: '3',
                entry_kind: 'send-message',
                entry_id: 'tbs3',
                body: b64Json({
                  kind: 'send-message',
                  id: 'tbs3',
                  message: {
                    type: 'auto-review-approval',
                    approval: {
                      requestId: 'ar_1',
                      surface: 'github',
                      title: 'Create PR on repo',
                      status: 'pending'
                    }
                  }
                })
              }
            ]
          }
        }
        yield {
          turn_failed: {
            agent_id: 'agent-1',
            code: 'RATE_LIMITED',
            summary: '429 quota exceeded'
          }
        }
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve()
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    } as unknown as GrokConnectClient

    const handle = ensureGrokAccountWatch({
      accountId,
      agentIds: ['agent-1'],
      createClient: async () => fakeClient,
      emit: (e) => emitted.push(e)
    })

    await new Promise((r) => setTimeout(r, 80))

    // 1. Live activity emitted
    expect(emitted.some((e) => e.type === 'activity' && e.busy === true)).toBe(true)

    // 2. Multi-bubble stream replies emitted with presigned attachment URL
    const streamEvents = emitted.filter(
      (e): e is Extract<GrokMainEvent, { type: 'stream' }> => e.type === 'stream'
    )
    expect(streamEvents.some((s) => s.messageId.includes('tbs1') && s.text === '第一条确认气泡')).toBe(
      true
    )
    const imgMsg = streamEvents.find((s) => s.messageId.includes('tbs2'))
    expect(imgMsg?.media?.[0]?.path).toBe('https://signed.cursor.sh/box/chart.png')

    // 3. Approval tracked and removable
    expect(handle.listApprovals('agent-1')).toHaveLength(1)
    expect(handle.listApprovals('agent-1')[0]!.requestId).toBe('ar_1')
    handle.removeApproval(handle.listApprovals('agent-1')[0]!.id)
    expect(handle.listApprovals('agent-1')).toHaveLength(0)

    // 4. Turn failure surfaced
    expect(emitted.some((e) => e.type === 'turn_failed' && e.code === 'RATE_LIMITED')).toBe(true)
  })

  it('backfills missed assistant messages on cursor_too_old, hydrates body_omitted entries, emits message_deleted, and fans out to multiple conversations', async () => {
    const emitted: GrokMainEvent[] = []
    let watchAttempt = 0
    let listCallCount = 0

    const fakeClient = {
      resolveAttachmentReads: async () => ({ reads: [] }),
      listTranscriptEntries: async (args: { beforeSeq?: string; limit?: number }) => {
        listCallCount++
        // 1st call: initial watermark seed (seq 5)
        if (listCallCount === 1) {
          return {
            generation: 1,
            entries: [
              {
                seq: '5',
                updated_seq: '5',
                entry_kind: 'send-message',
                entry_id: 'tbs_seed_5',
                body: b64Json({
                  kind: 'send-message',
                  id: 'tbs_seed_5',
                  message: { type: 'text', content: 'initial seed' }
                })
              }
            ]
          }
        }
        // Targeted hydration call for body_omitted entry (seq 20 -> beforeSeq '21')
        if (args.beforeSeq === '21') {
          return {
            generation: 1,
            entries: [
              {
                seq: '20',
                updated_seq: '20',
                entry_kind: 'send-message',
                entry_id: 'tbs_omitted_20',
                body: b64Json({
                  kind: 'send-message',
                  id: 'tbs_omitted_20',
                  message: { type: 'text', content: '完整水合后的大体积报告正文' }
                })
              }
            ]
          }
        }
        // Backfill call after cursor_too_old (contains seq 5 old + seq 12 missed gap)
        return {
          generation: 1,
          entries: [
            {
              seq: '5',
              updated_seq: '5',
              entry_kind: 'send-message',
              entry_id: 'tbs_seed_5',
              body: b64Json({
                kind: 'send-message',
                id: 'tbs_seed_5',
                message: { type: 'text', content: 'initial seed' }
              })
            },
            {
              seq: '12',
              updated_seq: '12',
              entry_kind: 'send-message',
              entry_id: 'tbs_gap_12',
              body: b64Json({
                kind: 'send-message',
                id: 'tbs_gap_12',
                message: { type: 'text', content: '断线期间错过的补洞回复' }
              })
            }
          ]
        }
      },
      watchTranscripts: async function* (
        _req: unknown,
        signal?: AbortSignal
      ): AsyncGenerator<Record<string, unknown>, void, void> {
        watchAttempt++
        if (watchAttempt === 1) {
          yield {
            cursor_too_old: {
              agent_id: 'agent-1'
            }
          }
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve()
            signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          return
        }
        // 2nd stream connection after cursor_too_old reconnect:
        // Deliver a body_omitted entry + a delete entry
        yield {
          rows: {
            agent_id: 'agent-1',
            entries: [
              {
                seq: '20',
                updated_seq: '20',
                entry_kind: 'send-message',
                entry_id: 'tbs_omitted_20',
                body_omitted: true
              }
            ],
            deletes: [
              {
                seq: '12',
                updated_seq: '21',
                entry_id: 'tbs_retracted_99'
              }
            ]
          }
        }
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve()
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    } as unknown as GrokConnectClient

    ensureGrokAccountWatch({
      accountId,
      agentIds: ['agent-1'],
      conversationMap: { 'agent-1': ['bot_main', 'bot_pinned'] },
      createClient: async () => fakeClient,
      emit: (e) => emitted.push(e)
    })

    await new Promise((r) => setTimeout(r, 120))

    const streamEvents = emitted.filter(
      (e): e is Extract<GrokMainEvent, { type: 'stream' }> => e.type === 'stream'
    )

    // 1. Seed entry (seq 5) was NOT re-emitted, while missed gap entry (seq 12) WAS backfilled to both bots!
    expect(streamEvents.some((s) => s.messageId === 'grok_tbs_seed_5')).toBe(false)
    const gapEvents = streamEvents.filter((s) => s.messageId === 'grok_tbs_gap_12')
    expect(gapEvents.map((g) => g.conversationId).sort()).toEqual(['bot_main', 'bot_pinned'])
    expect(gapEvents[0]!.text).toBe('断线期间错过的补洞回复')

    // 2. body_omitted entry (seq 20) was hydrated via listTranscriptEntries before emitting!
    const omittedEvents = streamEvents.filter((s) => s.messageId === 'grok_tbs_omitted_20')
    expect(omittedEvents).toHaveLength(2)
    expect(omittedEvents[0]!.text).toBe('完整水合后的大体积报告正文')

    // 3. rows.deletes emitted message_deleted event
    const delEvent = emitted.find(
      (e): e is Extract<GrokMainEvent, { type: 'message_deleted' }> => e.type === 'message_deleted'
    )
    expect(delEvent).toBeDefined()
    expect(delEvent!.messageIds).toEqual(['grok_tbs_retracted_99'])
  })

  it('publishes completed zero-seq replay, applies a newer revision after reconnect, and deduplicates replayed rows', async () => {
    const emitted = vi.fn<(event: GrokMainEvent) => void>()
    let attempts = 0
    const watchTranscripts = vi.fn(async function* (_req: unknown, signal?: AbortSignal) {
      const rows = ++attempts === 1
        ? [assistant('reply', 1, 'partial', true), assistant('complete', 2)]
        : [assistant('reply', 1, 'partial', true), assistant('complete', 2),
          { ...assistant('reply', 1, 'final'), updated_seq: '3' }]
      yield { rows: { agent_id: 'agent', entries: rows, replay: true } }
      await untilAborted(signal)
    })
    const watch = ensureGrokAccountWatch({ accountId, agentIds: ['agent'], emit: emitted,
      createClient: async () => ({ watchTranscripts, listTranscriptEntries: async () => ({ entries: [] }) }) as unknown as GrokConnectClient })
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledTimes(2))
    watch.rebindNetwork()
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledTimes(3))
    expect(emitted.mock.calls.map(([event]) => event.type === 'stream' && [event.messageId, event.text, event.done])).toEqual([
      ['grok_reply', 'partial', false], ['grok_complete', 'complete', true], ['grok_reply', 'final', true]
    ])
  })

  it('paginates an expired cursor back to its prior watermark and emits the full gap in order', async () => {
    const emitted = vi.fn<(event: GrokMainEvent) => void>()
    const listTranscriptEntries = vi.fn(async ({ beforeSeq, limit }: { beforeSeq?: string; limit?: number }) => ({
      generation: 1,
      entries: limit === 20 ? [assistant('baseline', 5)] : beforeSeq === '9'
        ? [assistant('gap-6', 6), assistant('baseline', 5)]
        : [assistant('latest', 10), assistant('gap-9', 9)]
    }))
    let attempt = 0
    const watchTranscripts = vi.fn(async function* (_req: unknown, signal?: AbortSignal) {
      if (++attempt === 1) yield { cursor_too_old: { agent_id: 'agent', session_id: 'session' } }
      await untilAborted(signal)
    })
    ensureGrokAccountWatch({ accountId, targets: [{ agentId: 'agent', sessionId: 'session' }], emit: emitted,
      createClient: async () => ({ watchTranscripts, listTranscriptEntries }) as unknown as GrokConnectClient })
    await vi.waitFor(() => expect(watchTranscripts).toHaveBeenCalledTimes(2))
    expect(listTranscriptEntries.mock.calls.map(([req]) => req.beforeSeq)).toEqual([undefined, undefined, '9'])
    expect(emitted.mock.calls.map(([event]) => event.type === 'stream' && event.messageId)).toEqual([
      'grok_gap-6', 'grok_gap-9', 'grok_latest'
    ])
    expect(watchTranscripts.mock.calls[1]?.[0]).toMatchObject({ cursors: [{ session_id: 'session', after_updated_seq: '10' }] })
  })

  it('keeps each session cursor and presigned attachment URL separate for the same agent', async () => {
    const listTranscriptEntries = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      entries: [assistant('initial', sessionId === 'first' ? 11 : 22)]
    }))
    const resolveAttachmentReads = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ reads: [
      { path: '/box/shared.png', url: `https://fixture.example/${sessionId}`, expiresAtMs: Date.now() + 90_000 }
    ] }))
    const watchTranscripts = vi.fn(async function* (_req: unknown, signal?: AbortSignal) { await untilAborted(signal) })
    const client = { listTranscriptEntries, resolveAttachmentReads, watchTranscripts } as unknown as GrokConnectClient
    const watch = ensureGrokAccountWatch({ accountId, emit: vi.fn(), createClient: async () => client,
      targets: [{ agentId: 'agent', sessionId: 'first' }, { agentId: 'agent', sessionId: 'second' }] })
    const media = [{ path: '/box/shared.png', kind: 'image' as const }]
    expect((await watch.resolveMediaUrls(client, 'agent', 'first', media))?.[0]?.path).toBe('https://fixture.example/first')
    expect((await watch.resolveMediaUrls(client, 'agent', 'second', media))?.[0]?.path).toBe('https://fixture.example/second')
    await watch.resolveMediaUrls(client, 'agent', 'first', media)
    expect(resolveAttachmentReads).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(watchTranscripts).toHaveBeenCalledOnce())
    expect(watchTranscripts.mock.calls[0]?.[0]).toMatchObject({ cursors: [
      { session_id: 'first', after_updated_seq: '11' }, { session_id: 'second', after_updated_seq: '22' }
    ] })
  })

  it('backs off after clean EOF and wakes early when the connection is rebound', async () => {
    const watchTranscripts = vi.fn(async function* () { yield { ping: {} } })
    const watch = ensureGrokAccountWatch({ accountId, emit: vi.fn(),
      createClient: async () => ({ watchTranscripts }) as unknown as GrokConnectClient })
    await vi.waitFor(() => expect(watchTranscripts).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 45))
    expect(watchTranscripts).toHaveBeenCalledOnce()
    watch.rebindNetwork()
    await vi.waitFor(() => expect(watchTranscripts).toHaveBeenCalledTimes(2), { timeout: 300 })
  })
})
