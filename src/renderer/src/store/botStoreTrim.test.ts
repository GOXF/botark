import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot, ChatMessage } from '@/types'
import { useBotStore } from './botStore'
import { KEEP_WHEN_TRIMMED, TRIM_IDLE_AFTER_MS } from './messageTrim'

const mkBot = (id: string): Bot => ({
  id,
  name: id,
  emoji: '',
  description: '',
  platformId: 'hermes',
  groupId: 'g-work',
  accountIds: [`acc-${id}`],
  activeAccountId: `acc-${id}`,
  activeSessionId: `s-${id}`,
  memory: [],
  notes: '',
  createdAt: 1,
  unread: 0
})
const list = (botId: string, n = 120): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${botId}-${i}`, botId, accountId: `acc-${botId}`, role: 'bot', text: 't', createdAt: i }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('trimIdleBots', () => {
  it('trims idle bots only, and reloads history when a trimmed bot is reopened', async () => {
    const idle = mkBot('idle')
    const typing = mkBot('typing')
    const open = mkBot('open')
    const rpc = vi.fn().mockResolvedValue({ ok: true, data: [{ id: 'h1', role: 'assistant', text: 'full', createdAt: 1 }] })
    vi.stubGlobal('window', { electron: { hermes: { rpc } } })
    useBotStore.setState({
      bots: [idle, typing, open],
      accounts: Object.fromEntries([idle, typing, open].map((b) => [b.activeAccountId, {
        id: b.activeAccountId, platformId: 'hermes', status: 'online', handle: '', displayName: b.id
      }])),
      messages: { idle: list('idle'), typing: list('typing'), open: list('open') },
      typing: { typing: true },
      activity: {},
      selectedBotId: 'open',
      trimmedBots: {}
    })

    useBotStore.getState().trimIdleBots(Date.now() + TRIM_IDLE_AFTER_MS + 1)
    const s = useBotStore.getState()
    expect(s.messages.idle).toHaveLength(KEEP_WHEN_TRIMMED)
    expect(s.messages.typing).toHaveLength(120)
    expect(s.messages.open).toHaveLength(120)
    expect(s.trimmedBots).toEqual({ idle: true })

    useBotStore.getState().selectBot('idle')
    await vi.waitFor(() => expect(useBotStore.getState().messages.idle?.[0]?.text).toBe('full'))
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ op: 'getSessionMessages', sessionId: 's-idle' }))
    expect(useBotStore.getState().trimmedBots).toEqual({})
  })
})
