import { afterEach, expect, it, vi } from 'vitest'
import { adapterRegistry } from '@adapters/registry'
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '@adapters/types'
import type { Bot } from '@/types'
import { useBotStore } from '@/store/botStore'
import { turnPrompt, type CollabRoom, type RoomMessage } from './model'
import { handOffFinal, handoffSteps, markHandoffRead } from './handoff'
import { useRooms } from './roomStore'

const member = (name: string) => ({ name, botId: name, platform: 'dot' as const, accountId: name, cursor: 0 })
const brief: RoomMessage = { id: 'b', author: 'User', text: '把群聊改成并发派发', createdAt: 1 }
const final: RoomMessage = { id: 'f', author: 'Dot', authorBotId: 'Dot', text: '[FINAL]\n并发派发 · 定稿', final: true, createdAt: 2 }
const draft: RoomMessage = { id: 'd', author: 'Muse', authorBotId: 'Muse', text: '补了 6 个测试', createdAt: 2 }

function setup() {
  const dev: CollabRoom = { id: 'dev', title: '开发组', brief: '', members: [member('Muse'), member('Dot')], mode: 'auto', limit: 8, messages: [brief, draft, final], finalId: 'f' }
  const review: CollabRoom = { id: 'review', title: '评审组', brief: '', members: [member('Grok'), member('Gemini')], mode: 'auto', limit: 8, messages: [] }
  useRooms.setState({ rooms: [dev, review], speakers: {}, errors: {}, turnProgress: {} })
  useBotStore.setState({ bots: ['Muse', 'Dot', 'Grok', 'Gemini'].map((id) => ({ id, accountIds: [id] } as Bot)) })
}
const room = (id: string) => useRooms.getState().rooms.find((r) => r.id === id)!
afterEach(() => vi.restoreAllMocks())

it('only a [FINAL] message can be handed off, and never to its own group', () => {
  setup()
  expect(handOffFinal('dev', 'd', 'review', { note: '', autoStart: false }).ok).toBe(false)
  expect(handOffFinal('dev', 'f', 'dev', { note: '', autoStart: false }).ok).toBe(false)
  expect(room('review').messages).toHaveLength(0)
})

it('posts a quoted requirement that points back to the source final and links the chain', () => {
  setup()
  expect(handOffFinal('dev', 'f', 'review', { note: '重点看并发竞态', autoStart: false })).toEqual({ ok: true })
  const posted = room('review').messages.at(-1)!
  expect(posted.author).toBe('开发组 交来需求')
  expect(posted.text).toBe('重点看并发竞态')
  expect(posted.handoff).toEqual({ roomId: 'dev', messageId: 'f' })
  expect(posted.references?.[0]?.text).toBe('并发派发 · 定稿')
  expect(posted.references?.[0]?.label).toContain('开发组 Dot 的定稿 [FINAL]')
  expect(room('review').handoffUnread).toBe(true)
  expect(room('dev').handoffChain).toEqual(['dev', 'review'])
  expect(room('review').handoffChain).toEqual(['dev', 'review'])
  markHandoffRead('review')
  expect(room('review').handoffUnread).toBeUndefined()

  const steps = handoffSteps(room('review'), useRooms.getState().rooms, {})!
  expect(steps.map((s) => [s.title, s.status])).toEqual([
    ['需求', 'done'], ['开发组', 'done'], ['评审组', 'active'], ['人工确认', 'pending']
  ])
  expect(steps[0]!.note).toBe('把群聊改成并发派发')
  expect(steps[1]!.who).toBe('Dot 定稿')
})

it('the receiving group sees the quoted final as its brief, and its own final can be handed on', () => {
  setup()
  handOffFinal('dev', 'f', 'review', { note: '重点看并发竞态', autoStart: false })
  const prompt = turnPrompt(room('review'), member('Grok'))
  expect(prompt).toContain('[Reference: 引用 · 开发组 Dot 的定稿 [FINAL]')
  expect(prompt).toContain('并发派发 · 定稿')

  const reviewFinal: RoomMessage = { id: 'rf', author: 'Grok', authorBotId: 'Grok', text: '[FINAL] 评审通过', final: true }
  const docs: CollabRoom = { id: 'docs', title: '文档组', brief: '', members: [member('Muse')], mode: 'auto', limit: 8, messages: [] }
  useRooms.setState((s) => ({ rooms: [...s.rooms.map((r) => r.id === 'review' ? { ...r, messages: [...r.messages, reviewFinal], finalId: 'rf' } : r), docs] }))
  expect(handoffSteps(room('review'), useRooms.getState().rooms, {})!.map((s) => s.status)).toEqual(['done', 'done', 'done', 'active'])
  expect(handOffFinal('review', 'rf', 'docs', { note: '', autoStart: false }).ok).toBe(true)
  expect(room('dev').handoffChain).toEqual(['dev', 'review', 'docs'])
  expect(room('docs').messages[0]!.text).toBe('请查看随附资料。')
})

it('auto-start kicks off the receiving group like a normal requirement', async () => {
  setup()
  let emit!: (msg: IncomingMessage) => void
  const prompts: string[] = []
  vi.spyOn(adapterRegistry, 'get').mockReturnValue({ getStatus: () => 'online',
    onMessage: (listener: typeof emit) => { emit = listener; return () => {} },
    sendMessage: async (m: OutgoingMessage) => {
      prompts.push(m.text)
      emit({ ...m, text: '[FINAL] 收到', createdAt: 1, id: 'x' })
      return { messageId: 'r', acceptedAt: 1 }
    }
  } as unknown as PlatformAdapter)
  handOffFinal('dev', 'f', 'review', { note: '看停止逻辑', autoStart: true })
  await vi.waitFor(() => expect(room('review').finalId).toBeTruthy())
  expect(prompts[0]).toContain('并发派发 · 定稿')
})
