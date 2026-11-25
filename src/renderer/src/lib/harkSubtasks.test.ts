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
