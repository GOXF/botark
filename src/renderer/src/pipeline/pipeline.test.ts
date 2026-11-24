import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { adapterRegistry } from '@adapters/registry'
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '@adapters/types'
import type { Bot } from '@/types'
import { useRooms } from '@/rooms/roomStore'
import { useBotStore } from '@/store/botStore'
import { needsMe, newTask, parseSuggestion, pass, reject, release, submitDev, toAssign, assign, type Executor } from './model'
import { confirmAssign, createTask, finishDev, passGate, rejectGate, releaseTask, skipSuggest, usePipeline } from './pipelineStore'

const dev: Executor = { kind: 'room', id: 'r1', name: '开发组' }
const codex: Executor = { kind: 'bot', id: 'codex', name: 'Codex' }

beforeEach(() => {
  usePipeline.setState({ tasks: [], nextNum: 1, busy: {}, releaseHook: '' })
  useRooms.setState({ rooms: [], speakers: {}, errors: {} })
})
afterEach(() => vi.restoreAllMocks())

it('walks a task through every stage, and gates only move from their own stage', () => {
  let t = newTask('t', 1, ' 标签页 ', '', 0)
  expect(t.stage).toBe('need')
  expect(pass(t, 1)).toBe(t)
  expect(assign(t, codex, 1)).toBe(t)
  t = toAssign(t, { executor: codex, plan: [] }, 1)
  expect(t.stage).toBe('assign')
  t = assign(t, codex, 2)
  expect([t.stage, t.executor?.name]).toEqual(['dev', 'Codex'])
  expect(release(t, 3)).toBe(t)
  t = submitDev(t, 'done', 3)
  expect(t.stage).toBe('review')
  t = pass(t, 4)
  expect(t.stage).toBe('confirm')
  t = pass(t, 5)
  expect([t.stage, t.releasedAt]).toEqual(['live', undefined])
  expect(needsMe(t)).toBe(true)
  t = release(t, 6)
  expect([t.releasedAt, needsMe(t)]).toEqual([6, false])
})

it('打回 needs a reason, returns to 开发 as the next round, and only from a gate', () => {
  const review = submitDev(assign(toAssign(newTask('t', 1, 'x', '', 0), undefined, 0), dev, 0), undefined, 0)
  expect(reject(review, '  ', 1)).toBe(review)
  const back = reject(review, '缺 Windows 截图', 1)
  expect([back.stage, back.round, back.rejects]).toEqual(['dev', 2, [{ stage: 'review', reason: '缺 Windows 截图', at: 1 }]])
  expect(reject(back, 'again', 2)).toBe(back)
  const confirm = pass(submitDev(back, 'v2', 2), 3)
  expect(reject(confirm, '装上试一下有问题', 4).rejects[1]?.stage).toBe('confirm')
})

it('reads the administrator’s executor and numbered steps', () => {
  const text = '[FINAL]\n执行者：开发组\n拆分：\n1. 模型\n2、视图\n- 测试'
  expect(parseSuggestion(text, [codex, dev])).toEqual({ executor: dev, plan: ['模型', '视图', '测试'] })
  expect(parseSuggestion('交给 Codex 吧', [codex, dev]).executor).toBe(codex)
  expect(parseSuggestion('不知道', [codex, dev]).executor).toBeUndefined()
})

it('store: assign a bot, finish, 打回 resends the reason, pass both gates, then 上线', async () => {
  const sent: string[] = []
  useBotStore.setState({
    bots: [{ id: 'codex', name: 'Codex', accountIds: ['a'] } as Bot],
    messages: { codex: [{ id: 'm', role: 'bot', text: '改好了', createdAt: 1 }] } as never,
    sendMessage: async (_id: string, text: string) => { sent.push(text) }
  } as never)
  const open = vi.fn()
  vi.stubGlobal('window', { open })
  usePipeline.setState({ releaseHook: 'https://ci.example/run' })
  const id = createTask('弹出独立窗口', '格子可弹出')!
  expect(usePipeline.getState().tasks[0]).toMatchObject({ num: 1, stage: 'need' })
  skipSuggest(id)
  confirmAssign(id, codex)
  expect(sent[0]).toContain('任务 #1：弹出独立窗口')
  finishDev(id)
  expect(usePipeline.getState().tasks[0]).toMatchObject({ stage: 'review', output: '改好了' })
  rejectGate(id, '缺截图')
  expect(usePipeline.getState().tasks[0]).toMatchObject({ stage: 'dev', round: 2 })
  expect(sent[1]).toContain('第 2 轮（Review打回）：缺截图')
  finishDev(id, 'v2')
  passGate(id)
  passGate(id)
  releaseTask(id)
  expect(usePipeline.getState().tasks[0]?.releasedAt).toBeTypeOf('number')
  expect(open).toHaveBeenCalledWith('https://ci.example/run', '_blank', 'noopener,noreferrer')
  vi.unstubAllGlobals()
})

it('store: 管理员调度 suggests the executor, a group’s [FINAL] moves 开发 to Review', async () => {
  const admin = { botId: 'boss', name: 'Boss', platform: 'dot' as const, accountId: 'boss', cursor: 0 }
  const worker = { botId: 'w', name: 'W', platform: 'dot' as const, accountId: 'w', cursor: 0 }
  useRooms.setState({
    rooms: [
      { id: 'admin', title: 'Boss · 管理员调度', coordinatorId: 'boss', members: [admin], messages: [], brief: '', mode: 'auto', limit: 8 },
      { id: 'r1', title: '开发组', members: [worker], messages: [], brief: '', mode: 'auto', limit: 8 }
    ]
  })
  useBotStore.setState({ bots: [{ id: 'boss', name: 'Boss', accountIds: ['boss'], platformId: 'dot', activeAccountId: 'boss' } as Bot, { id: 'w', name: 'W', accountIds: ['w'], platformId: 'dot', activeAccountId: 'w' } as Bot] })
  const listeners: Array<(m: IncomingMessage) => void> = []
  vi.spyOn(adapterRegistry, 'get').mockReturnValue({
    getStatus: () => 'online',
    onMessage: (l: (m: IncomingMessage) => void) => { listeners.push(l); return () => listeners.splice(listeners.indexOf(l), 1) },
    sendMessage: async (m: OutgoingMessage) => {
      const text = m.accountId === 'boss' ? '[FINAL]\n执行者：开发组\n拆分：\n1. 做\n2. 测' : '[FINAL]\n交付了'
      for (const l of [...listeners]) l({ ...m, id: 'x' + Math.random(), text, createdAt: 1 } as IncomingMessage)
      return { messageId: 'r', acceptedAt: 1 }
    }
  } as unknown as PlatformAdapter)
  const id = createTask('需求', '')!
  await vi.waitFor(() => expect(usePipeline.getState().tasks[0]?.stage).toBe('assign'))
  const task = usePipeline.getState().tasks[0]!
  expect(task.suggestion).toEqual({ executor: { kind: 'room', id: 'r1', name: '开发组' }, plan: ['做', '测'] })
  confirmAssign(id, task.suggestion!.executor!)
  await vi.waitFor(() => expect(usePipeline.getState().tasks[0]).toMatchObject({ stage: 'review', output: '交付了' }))
})

it('persistence drops broken tasks and keeps numbering ahead', async () => {
  const merge = usePipeline.persist.getOptions().merge!
  const out = merge({ tasks: [{ id: 'a', title: 'x', stage: 'dev', num: 7 }, { id: 'b', stage: 'nope', title: 'y' }, null], nextNum: 2, mode: 'pipeline' }, usePipeline.getState()) as ReturnType<typeof usePipeline.getState>
  expect(out.tasks.map((t) => [t.id, t.round, t.rejects])).toEqual([['a', 1, []]])
  expect([out.nextNum, out.mode, out.mineOnly]).toEqual([8, 'pipeline', false])
})
