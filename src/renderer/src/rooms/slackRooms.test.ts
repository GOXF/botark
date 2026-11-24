import { afterEach, expect, it, vi } from 'vitest'
import { adapterRegistry } from '@adapters/registry'
import type { IncomingMessage, OutgoingMessage, PlatformAdapter } from '@adapters/types'
import { useBotStore } from '@/store/botStore'
import type { Bot } from '@/types'
import { receiveSlackMessage, applySlackConnection } from './slackRooms'
import { stopRoom, useRooms } from './roomStore'
import type { CollabRoom, RoomMember } from './model'
import type { SlackBridge, SlackInbound } from '@shared/slack'

const members: RoomMember[] = [
  { name: 'Grok', botId: 'grok', platform: 'grok', accountId: 'grok-account', sessionId: 'parent-grok-session', cursor: 7 },
  { name: 'Dot', botId: 'dot', platform: 'dot', accountId: 'dot-account', sessionId: 'parent-dot-session', cursor: 9 },
  { name: 'Hermes', botId: 'hermes', platform: 'hermes', accountId: 'hermes-account', hermesSessionKey: 'parent-hermes-key', cursor: 5 }
]
const parent: CollabRoom = { id: 'room', title: 'Review', members, limit: 8, mode: 'manual', brief: '', messages: [] }
const event: SlackInbound = {
  id: 'slack-C1-1.0', channel: 'C1', roomId: 'room', fork: true, thread: '1.0', text: 'Review thread one', user: 'U1'
}

const request = vi.fn<SlackBridge['request']>().mockResolvedValue({ connected: true, saved: true, bindings: [] })
let receive: (event: SlackInbound & { bindingGeneration?: number }) => void
const bridge: SlackBridge = { request, onMessage: (callback) => { receive = callback; return () => {} } }

function connect(channel = 'C1', thread?: string, bindingGeneration?: number) {
  vi.stubGlobal('sessionStorage', { setItem: vi.fn(), removeItem: vi.fn() })
  applySlackConnection(bridge, { connected: true, saved: true, bindings: [{ roomId: parent.id, channel, thread, bindingGeneration }] })
}

function mockReplies(respond: (msg: OutgoingMessage) => string | Promise<string>) {
  useBotStore.setState({ bots: members.map((m) => ({
    id: m.botId, name: m.name, platformId: m.platform, accountIds: [m.accountId], activeAccountId: m.accountId
  } as Bot)) })
  const listeners = new Set<(message: IncomingMessage) => void>()
  const send = vi.fn(async (msg: OutgoingMessage) => {
    const text = await respond(msg)
    for (const emit of listeners) emit({ ...msg, text, id: 'reply', createdAt: 1 })
    return { messageId: 'reply', acceptedAt: 1 }
  })
  vi.spyOn(adapterRegistry, 'get').mockReturnValue({
    getStatus: () => 'online',
    onMessage: (listener: (msg: IncomingMessage) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sendMessage: send
  } as unknown as PlatformAdapter)
  return send
}

afterEach(() => {
  for (const room of useRooms.getState().rooms) stopRoom(room.id)
  applySlackConnection(bridge, { connected: false, saved: false, bindings: [] })
  request.mockClear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('persists an inbound post once, keeps threads separate and forwards only new local posts', () => {
  const room = { ...parent, members: [] }
  useRooms.setState({ rooms: [room] })
  connect()
  receiveSlackMessage(event)
  receiveSlackMessage(event)
  receiveSlackMessage({ ...event, id: 'slack-C1-2.0', thread: '2.0', text: 'Review thread two' })
  const [original, one, two] = useRooms.getState().rooms
  expect(original?.messages).toEqual([])
  expect(one?.messages.map((m) => m.text)).toEqual(['Review thread one'])
  expect(two?.messages.map((m) => m.text)).toEqual(['Review thread two'])
  const nativeRoom = { ...room, id: 'native-room', messages: [] }
  useRooms.setState((s) => ({ rooms: [...s.rooms, nativeRoom] }))
  useRooms.setState((s) => ({ rooms: s.rooms.map((r) => r.id === nativeRoom.id ? {
    ...r, messages: [{ id: 'private', author: 'User', text: 'Only inside BotArk' }]
  } : r) }))
  expect(request).not.toHaveBeenCalled()
  useRooms.setState((s) => ({ rooms: s.rooms.map((r) => r.id === one!.id ? {
    ...r, messages: [...r.messages, { id: 'local', author: 'Muse', text: 'Reviewed.' }]
  } : r) }))
  expect(request).toHaveBeenCalledExactlyOnceWith({ op: 'post', roomId: 'room', channel: 'C1', thread: '1.0', text: '[Muse] Reviewed.' })
})

it('starts Slack forks without the parent’s Grok, Dot, or Hermes session state', async () => {
  const send = mockReplies(() => 'Reviewed')
  useRooms.setState({ rooms: [parent] })
  connect()
  receive({ ...event, text: '@Grok @Dot @Hermes Review thread one' })
  await vi.waitFor(() => expect(useRooms.getState().rooms[1]?.messages).toHaveLength(4))
  expect(send.mock.calls.map(([msg]) => msg.sessionId)).toEqual([undefined, undefined, undefined])
  const fork = useRooms.getState().rooms[1]!
  expect(fork.members.slice(0, 2).map((m) => m.cursor)).toEqual([0, 0])
  expect(fork.members[2]?.hermesSessionKey).toBeTruthy()
  expect(fork.members[2]?.hermesSessionKey).not.toBe(parent.members[2]?.hermesSessionKey)
  expect(send.mock.calls[2]?.[0].hermesSessionKey).toBe(fork.members[2]?.hermesSessionKey)
  expect(useRooms.getState().rooms[0]?.members).toEqual(parent.members)
})

it('queues and deduplicates rapid Slack messages while pinning each run to its incoming thread', async () => {
  let finishFirst!: (reply: string) => void
  const first = new Promise<string>((resolve) => { finishFirst = resolve })
  const send = mockReplies((msg) => {
    if (msg.accountId === 'dot-account') return '[FINAL]\nFirst thread finished'
    return msg.text.includes('Human brief: @Grok first') ? first : '[FINAL]\nSecond thread finished'
  })
  useRooms.setState({ rooms: [{ ...parent, mode: 'auto' }] })
  connect('C1', '1.0', 1)
  const second = { ...event, fork: false, thread: '2.0', channel: 'C2', bindingGeneration: 2, id: 'slack-C2-2.0', text: '@Grok second' }
  receive({ ...event, fork: false, bindingGeneration: 1, text: '@Grok first' })
  connect('C2', '2.0', 2)
  receive(second)
  receive(second)
  expect(send).toHaveBeenCalledOnce()
  expect(send.mock.calls[0]?.[0].signal?.aborted).toBe(false)
  expect(request).not.toHaveBeenCalledWith({ op: 'received', id: second.id })
  finishFirst('@Dot verify first')

  await vi.waitFor(() => expect(useRooms.getState().rooms[0]?.messages).toHaveLength(5))
  expect(send.mock.calls.map(([msg]) => msg.accountId)).toEqual(['grok-account', 'dot-account', 'grok-account'])
  expect(request.mock.calls.map(([req]) => req)).toEqual([
    { op: 'received', id: event.id },
    { op: 'post', roomId: parent.id, channel: 'C1', thread: '1.0', bindingGeneration: 1, text: '[Grok] @Dot verify first' },
    { op: 'post', roomId: parent.id, channel: 'C1', thread: '1.0', bindingGeneration: 1, text: '[Dot] [FINAL]\nFirst thread finished' },
    { op: 'received', id: second.id },
    { op: 'post', roomId: parent.id, channel: 'C2', thread: '2.0', bindingGeneration: 2, text: '[Grok] [FINAL]\nSecond thread finished' }
  ])
})

it('keeps a declined tool request and the failure local while continuing the Slack conversation', async () => {
  const secret = 'Private query @Dot [FINAL]'
  let deny!: (reason: Error) => void
  const run = vi.fn(() => new Promise<string>((_resolve, reject) => { deny = reject }))
  vi.stubGlobal('window', { electron: { workspace: { run, manage: async () => ({ tools: [] }) } } })
  const send = mockReplies((msg) => {
    if (msg.text.includes('工具请求失败')) {
      expect(msg.text).not.toContain(secret)
      return '[FINAL]\nReviewed with existing evidence'
    }
    return `[TOOL] ${JSON.stringify({ name: 'search', args: { query: secret } })}`
  })
  useRooms.setState({ rooms: [{ ...parent, mode: 'auto' }] })
  connect()
  receive({ ...event, fork: false, text: '@Grok review' })
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledExactlyOnceWith({ op: 'received', id: event.id })
  deny(new Error(`用户已取消本次操作: ${secret}`))

  await vi.waitFor(() => expect(useRooms.getState().rooms[0]?.finalId).toBeTruthy())
  expect(send.mock.calls.map(([msg]) => msg.accountId)).toEqual(['grok-account', 'grok-account'])
  expect(run).toHaveBeenCalledWith(parent.id, 'search', { query: secret }, expect.stringContaining('Slack C1'))
  expect(request.mock.calls.map(([req]) => req)).toEqual([
    { op: 'received', id: event.id },
    { op: 'post', roomId: parent.id, channel: 'C1', thread: '1.0', text: '[Grok] [FINAL]\nReviewed with existing evidence' }
  ])
})
