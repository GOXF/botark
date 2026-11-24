import { expect, it, vi } from 'vitest'
import type { GrokConnectClient } from './connectClient'
import { watchUntilReply } from './grokRpc'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { isReady: () => false }
}))

const scope = { accountId: 'account', agentId: 'agent', sessionId: 'session', timeoutMs: 1000 }
const wireScope = { agent_id: scope.agentId, session_id: scope.sessionId }
const rows = (entries: Record<string, unknown>[], overrides: Record<string, unknown> = {}) => ({
  rows: { ...wireScope, replay: true, entries, ...overrides }
})
const user = { entry_id: 'echo', seq: '8', client_nonce: 'nonce', request_id: 'turn', kind: 'message', content: 'Question' }
const reply = (id: string, seq: string, fields: Record<string, unknown> = {}) => ({
  entry_id: id, seq, kind: 'send-message', content: id, ...fields
})

it('recovers a completed zero-cursor reply when the replay omits its user anchor', async () => {
  const listTranscriptEntries = vi.fn(async () => ({ entries: [user] }))
  const getSendStatus = vi.fn(async () => ({ echo_entry_id: 'echo' }))
  const watchTranscripts = vi.fn(async function* () {
    yield rows([reply('before', '7'), reply('answer', '9'), reply('another-turn', '10', { request_id: 'other' })])
  })
  const result = await watchUntilReply({ listTranscriptEntries, getSendStatus, watchTranscripts } as unknown as GrokConnectClient, {
    ...scope, afterUpdatedSeq: '0', afterMessageId: 'nonce', timeoutMs: 80
  })
  expect(result.messages.map((entry) => entry.messageId)).toEqual(['grok_answer'])
  expect(getSendStatus).toHaveBeenCalledWith({ agentId: 'agent', sessionId: 'session', messageId: 'nonce' }, expect.any(AbortSignal))
  expect(listTranscriptEntries).toHaveBeenCalledOnce()
})

it('ignores foreign rows, failures and state frames on a per-send watch', async () => {
  const watchTranscripts = vi.fn(async function* (_params: unknown, signal?: AbortSignal) {
    yield { turn_failed: { ...wireScope, session_id: 'foreign', summary: 'foreign session' } }
    yield { turn_failed: { ...wireScope, agent_id: 'foreign', summary: 'foreign agent' } }
    yield { turn_failed: { ...wireScope, message_id: 'another-send', summary: 'foreign send' } }
    yield rows([user, reply('wrong-row', '9')], { session_id: 'foreign' })
    yield rows([user, reply('wrong-entry', '9', { agent_id: 'foreign' }), reply('answer', '10')])
    yield { turn_failed: { ...wireScope, message_id: 'nonce', code: 'REFUSED', summary: 'actual failure' } }
    expect(signal?.aborted).toBe(false)
  })
  const result = await watchUntilReply({ watchTranscripts } as unknown as GrokConnectClient, { ...scope, afterMessageId: 'nonce' })
  expect(result.turnFailed).toEqual({ code: 'REFUSED', summary: 'actual failure' })
  expect(result.messages.map((entry) => entry.messageId)).toEqual(['grok_answer'])
  expect(watchTranscripts.mock.calls[0]?.[0]).toMatchObject({ includeUnlistedAgents: false })
  expect(watchTranscripts.mock.calls[0]?.[1]?.aborted).toBe(true)
})

it('returns a matching turn failure with an empty messages array', async () => {
  const watchTranscripts = async function* () {
    yield { turnFailed: { agentId: 'agent', sessionId: 'session', code: 'LIMIT', summary: 'quota' } }
  }
  await expect(watchUntilReply({ watchTranscripts } as unknown as GrokConnectClient, scope)).resolves.toMatchObject({
    messages: [], turnFailed: { code: 'LIMIT', summary: 'quota' }
  })
})

it('uses row order for zero-sequence replies when the exact anchor and assistant arrive together', async () => {
  const watchTranscripts = async function* () {
    yield rows([
      reply('previous', '0', { timestampMs: 100 }),
      { ...user, seq: '0', timestampMs: 101 },
      reply('answer', '0', { timestampMs: 101 })
    ])
  }
  const result = await watchUntilReply({ watchTranscripts } as unknown as GrokConnectClient, {
    ...scope, afterMessageId: 'nonce', timeoutMs: 60
  })
  expect(result.messages.map((entry) => entry.messageId)).toEqual(['grok_answer'])
})

it('stops the stream and rejects on renderer cancellation', async () => {
  const controller = new AbortController()
  const watchTranscripts = vi.fn(async function* (_params: unknown, signal?: AbortSignal) {
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
    yield rows([user, reply('too-late', '9')])
  })
  const watched = watchUntilReply({ watchTranscripts } as unknown as GrokConnectClient, { ...scope, signal: controller.signal })
  const rejected = expect(watched).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(watchTranscripts).toHaveBeenCalledOnce())
  controller.abort()
  await rejected
  expect(watchTranscripts.mock.calls[0]?.[1]?.aborted).toBe(true)
})
