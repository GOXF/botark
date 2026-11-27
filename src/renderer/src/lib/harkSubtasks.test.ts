import { describe, expect, it } from 'vitest'
import { deriveSubtasks, deriveTasks } from './harkSubtasks'

describe('deriveSubtasks', () => {
  it('merges tool calls and panels by dispatchId, panel status wins', () => {
    const list = deriveSubtasks({
      messages: [
        { createdAt: 1000, toolCalls: [
          { dispatchId: 'a', name: 'browser', status: 'running', detail: '测速 fast.com' },
          { dispatchId: 'b', name: 'run_subagent', status: 'completed', detail: '汇总结果' }
        ] }
      ],
      panels: [{ dispatchId: 'a', kind: 'browser', status: 'completed', title: 'fast.com' }]
    })
    expect(list.map((t) => [t.id, t.kind, t.status, t.title])).toEqual([
      ['a', 'browser', 'done', 'fast.com'],
      ['b', 'subagent', 'done', '汇总结果']
    ])
  })

  it('an open ask marks its subtask waiting and sorts it first', () => {
    const list = deriveSubtasks({
      messages: [{ toolCalls: [{ dispatchId: 'x', name: 'tool', status: 'running' }, { dispatchId: 'y', name: 'browser', status: 'running' }] }],
      asks: [{ dispatchId: 'y', status: 'pending' }]
    })
    expect(list[0]).toMatchObject({ id: 'y', status: 'waiting' })
  })

  it('handles an empty snapshot', () => {
    expect(deriveSubtasks(null)).toEqual([])
  })
})

describe('deriveTasks', () => {
  it('one task per request; bound follow-ups fold in; replies bring their tools; activeWork keeps them running', async () => {
    const { deriveTasks } = await import('./harkSubtasks')
    const tasks = deriveTasks({
      requests: {
        u1: { state: 'completed', title: '核对数据', doneTitle: '已核对数据' },
        u2: { state: 'open', title: '检查工单回复' },
        u3: { state: 'open', boundTo: 'u2' }
      },
      messages: [
        { id: 'u1', role: 'user', content: '核对', createdAt: 1 },
        { id: 'a1', role: 'assistant', triggeredBy: 'u1', toolCalls: [{ dispatchId: 'd1', name: 'run_subagent', status: 'completed', detail: '核对各站' }] },
        { id: 'u2', role: 'user', content: '找退款渠道', createdAt: 2 },
        { id: 'u3', role: 'user', content: '去看看有没有回复', createdAt: 3 },
        { id: 'a3', role: 'assistant', triggeredBy: 'u3', toolCalls: [{ dispatchId: 'd2', name: 'browser', status: 'completed', detail: '打开 ciyundata.com' }] }
      ],
      activeWork: [{ dispatchId: 'd2', messageId: 'a3', state: 'working' }]
    })
    expect(tasks.map((t) => [t.id, t.title, t.state, t.subtasks.map((s) => [s.id, s.status])])).toEqual([
      ['u2', '检查工单回复', 'working', [['d2', 'running']]],
      ['u1', '已核对数据', 'done', [['d1', 'done']]]
    ])
  })
})

describe('deriveTasks helpers', () => {
  it('a running helpers dispatch shows as one subagent row on its request', async () => {
    const { deriveTasks } = await import('./harkSubtasks')
    const [t] = deriveTasks({
      requests: { u1: { state: 'working', title: '并行跑一次' } },
      messages: [{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant', triggeredBy: 'u1' }],
      activeWork: [{ dispatchId: 'tu_1', messageId: 'a1', domain: 'helpers', state: 'working' }]
    })
    expect(t!.state).toBe('working')
    expect(t!.subtasks).toEqual([{ id: 'tu_1', kind: 'subagent', title: '子任务进行中', status: 'running' }])
  })
})

describe('deriveTasks: what waits on you', () => {
  const now = 10_000_000
  const at = (min: number) => now - min * 60_000
  it('only awaitsPerson is 等你处理; an open request a follow-up continued is done', async () => {
    const { deriveTasks } = await import('./harkSubtasks')
    const tasks = deriveTasks({
      requests: {
        a: { state: 'open', title: '设置控制台', doneTitle: '已建令牌' },
        b: { state: 'completed', title: '下一步', followsUp: 'a', lineage: '["a"]' },
        c: { state: 'open', title: '要你选', awaitsPerson: true },
        d: { state: 'open', title: '刚发的' },
        e: { state: 'open', title: '昨天的' }
      },
      messages: [
        { id: 'a', role: 'user', createdAt: at(60) },
        { id: 'b', role: 'user', createdAt: at(50) },
        { id: 'c', role: 'user', createdAt: at(40) },
        { id: 'd', role: 'user', createdAt: at(2) },
        { id: 'e', role: 'user', createdAt: at(24 * 60) }
      ]
    }, now)
    const by = Object.fromEntries(tasks.map((t) => [t.id, t.state]))
    expect(by).toEqual({ a: 'done', b: 'done', c: 'open', d: 'working', e: 'done' })
  })
})

describe('deriveTasks: day-old requests', () => {
  const now = Date.parse('2026-11-27T19:00:00+08:00')
  const old = '2026-11-10T10:00:00+08:00'
  it('drops a day-old awaiting request with a stale ask out of 等你处理', () => {
    const [t] = deriveTasks(
      {
        requests: { u1: { state: 'awaiting_input', awaitsPerson: true } },
        messages: [
          { id: 'u1', role: 'user', content: '不行，我要的是…', createdAt: old },
          { id: 'a1', role: 'assistant', triggeredBy: 'u1', toolCalls: [{ dispatchId: 'd1' }] }
        ],
        panels: [{ dispatchId: 'd1', kind: 'tool', title: 'request_secret', status: 'running' }],
        asks: [{ dispatchId: 'd1', status: 'pending' }]
      } as never,
      now
    )
    expect(t.state).toBe('done')
    expect(t.subtasks[0].status).toBe('done')
  })
  it('keeps a day-old request whose dispatch is still in activeWork', () => {
    const [t] = deriveTasks(
      {
        requests: { u1: { state: 'working' } },
        messages: [
          { id: 'u1', role: 'user', content: 'x', createdAt: old },
          { id: 'a1', role: 'assistant', triggeredBy: 'u1', toolCalls: [{ dispatchId: 'd1' }] }
        ],
        panels: [{ dispatchId: 'd1', kind: 'browser', title: 'b', status: 'running' }],
        activeWork: [{ dispatchId: 'd1', state: 'running' }]
      } as never,
      now
    )
    expect(t.state).toBe('working')
  })
})
