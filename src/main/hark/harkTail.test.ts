import { expect, it, vi } from 'vitest'

const sse = { push: (_frame: unknown) => {} }
vi.mock('electron', () => ({
  session: {
    fromPartition: () => ({
      fetch: async (url: string, init: { signal: AbortSignal }) => {
        if (!url.includes('/sync/conversation')) return new Response('{"frames":[]}')
        return new Response(new ReadableStream({
          start(controller) {
            sse.push = (frame) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`))
            init.signal.addEventListener('abort', () => controller.error(new Error('aborted')))
          }
        }), { headers: { 'Content-Type': 'text/event-stream' } })
      }
    })
  }
}))
vi.mock('../muse/accountProxy', () => ({ applyProxyToPartition: async () => {} }))
vi.mock('../webContentsViewManager', () => ({ partitionForAccount: (id: string) => `persist:${id}` }))
vi.mock('./harkBusy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./harkBusy')>()),
  HARK_TAIL_IDLE_MS: 50
}))

import { watchHarkConversationSync } from './harkClient'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

it('returns at the reply but keeps streaming until the subagent of the turn finishes', async () => {
  const tail: Array<{ ended: boolean; tool?: string }> = []
  let ended!: () => void
  const end = new Promise<void>((r) => (ended = r))
  const watching = watchHarkConversationSync('acc', 'conv', {
    responseMessageId: 'r1',
    onTail: (state, isEnd) => {
      tail.push({ ended: isEnd, tool: state.messages.get('r1')?.toolCalls?.[0]?.status })
      if (isEnd) ended()
    }
  })
  await sleep(20)
  sse.push({ type: 'snapshot', data: { messages: [{ id: 'r1', role: 'assistant', content: '开了子任务',
    toolCalls: [{ dispatchId: 'd1', toolName: 'run_subagent', status: 'running' }] }] } })
  const result = await watching
  expect(result.tailing).toBe(true)
  expect(result.reply?.id).toBe('r1')

  sse.push({ type: 'patches', data: [{ op: 'tool_update', id: 'r1', dispatchId: 'd1', fields: { status: 'completed' } }] })
  await sleep(80)
  sse.push({ type: 'patches', data: [{ op: 'narration_update', value: null }] })
  await end
  expect(tail.at(-2)).toEqual({ ended: false, tool: 'completed' })
  expect(tail.at(-1)).toEqual({ ended: true, tool: 'completed' })
})
