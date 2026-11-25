import { describe, expect, it } from 'vitest'
import { deriveSubtasks } from './harkSubtasks'

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
