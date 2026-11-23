import { expect, it } from 'vitest'
import { harkTurnBusy } from './harkBusy'
import type { HarkChatMessage } from './harkClient'

const state = (messages: HarkChatMessage[], narration: string | null = null, activeActivity: string | null = null) => ({
  narration,
  activeActivity,
  orderedMessages: () => messages
})
const reply: HarkChatMessage = { id: 'r1', role: 'assistant', content: '好的，我开个子任务。' }

it('is idle once the reply is done and nothing else runs', () => {
  expect(harkTurnBusy(state([reply]), new Set())).toBe(false)
})

it('stays busy while the status line is set', () => {
  expect(harkTurnBusy(state([reply], null, '等待任务完成。'), new Set())).toBe(true)
  expect(harkTurnBusy(state([reply], '  '), new Set())).toBe(false)
})

it('stays busy while a tool of this turn is running', () => {
  const tools = [{ dispatchId: 'd1', name: 'run_subagent', status: 'running' }]
  expect(harkTurnBusy(state([{ ...reply, toolCalls: tools }]), new Set())).toBe(true)
  // A stale "running" tool from an earlier turn does not count.
  expect(harkTurnBusy(state([{ ...reply, toolCalls: tools }]), new Set(['r1']))).toBe(false)
})

it('stays busy while a newer assistant message streams, unless its job ended', () => {
  const next: HarkChatMessage = { id: 'r2', role: 'assistant', content: '', isStreaming: true }
  expect(harkTurnBusy(state([reply, next]), new Set())).toBe(true)
  expect(harkTurnBusy(state([reply, { ...next, jobStatus: 'completed' }]), new Set())).toBe(false)
  expect(harkTurnBusy(state([{ id: 'u', role: 'user', content: 'hi', isStreaming: true }]), new Set())).toBe(false)
})
