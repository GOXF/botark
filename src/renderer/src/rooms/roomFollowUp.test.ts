import { afterEach, beforeEach, expect, it } from 'vitest'
import { adapterRegistry } from '@adapters/registry'
import type { AdapterListener, OutgoingMessage, PlatformAdapter } from '@adapters/types'
import { useBotStore } from '@/store/botStore'
import type { Bot } from '@/types'
import { addRoom, submitBrief, useRooms } from './roomStore'

const originalWindow = (globalThis as { window?: unknown }).window
const originalMuse = adapterRegistry.get('meta-muse')

beforeEach(() => {
  useRooms.setState({ rooms: [], speakers: {}, turnProgress: {}, errors: {}, externalAudiences: {} })
})
afterEach(() => {
  if (originalMuse) adapterRegistry.register(originalMuse)
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
  else (globalThis as { window?: unknown }).window = originalWindow
})

it('a message typed while a member answers goes to that member next, without interrupting it', async () => {
  const sent: OutgoingMessage[] = []
  const listeners = new Set<AdapterListener>()
  const reply = (msg: OutgoingMessage, text: string) => {
    for (const l of listeners) {
      l({ type: 'message', message: { id: 'r' + sent.length, conversationId: msg.conversationId, accountId: msg.accountId, text, createdAt: Date.now() } })
    }
  }
  let releaseFirst!: () => void
  const fake: PlatformAdapter = {
    id: 'meta-muse', name: 'Meta Muse',
    listAccounts: async () => [], connect: async () => 'online', disconnect: async () => undefined,
    getStatus: () => 'online',
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) },
    onMessage: (cb) => fake.subscribe((e) => { if (e.type === 'message') cb(e.message) }),
    sendMessage: async (msg) => {
      sent.push(msg)
      if (sent.length === 1) {
        await new Promise<void>((r) => { releaseFirst = r })
        reply(msg, 'first answer')
      } else reply(msg, 'second answer')
      return { messageId: 'o' + sent.length, acceptedAt: Date.now(), sessionId: 's_' + msg.accountId }
    }
  }
  adapterRegistry.register(fake)
  ;(globalThis as { window?: unknown }).window = { electron: { muse: { startSession: async () => ({ sessionId: 's' }) } } }
  useBotStore.setState({
    bots: [
      { id: 'bot_a', name: 'A', platformId: 'meta-muse', accountIds: ['acc_a'], activeAccountId: 'acc_a' } as Bot,
      { id: 'bot_b', name: 'B', platformId: 'meta-muse', accountIds: ['acc_b'], activeAccountId: 'acc_b' } as Bot
    ],
    accounts: {
      acc_a: { id: 'acc_a', platformId: 'meta-muse', displayName: 'A', handle: 'a', status: 'online' },
      acc_b: { id: 'acc_b', platformId: 'meta-muse', displayName: 'B', handle: 'b', status: 'online' }
    }
  })
  const room = addRoom('g', ['bot_a', 'bot_b'], 'auto', 4)

  const round = submitBrief(room.id, 'question')
  await vi_waitFor(() => sent.length === 1)
  await submitBrief(room.id, 'one more thing', { followUp: true })
  releaseFirst()
  await round

  expect(sent.map((m) => m.accountId)).toEqual(['acc_a', 'acc_a'])
  const texts = useRooms.getState().rooms.find((r) => r.id === room.id)!.messages.map((m) => m.text)
  expect(texts).toEqual(['question', 'one more thing', 'first answer', 'second answer'])
})

async function vi_waitFor(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(ok()).toBe(true)
}
