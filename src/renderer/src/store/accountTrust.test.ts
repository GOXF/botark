import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adapterRegistry } from '@adapters/registry'
import type { AdapterEvent, PlatformAdapter } from '@adapters/types'
import { startAdapterBridge } from '@/services/adapterBridge'
import { flushWorkspacePersistence, useBotStore } from '@/store/botStore'
import { REPLY_BUSY_LIMIT_MS } from '@/store/replyWatchdog'
import type { GrokMainEvent } from '@shared/ipc'
import type { Bot } from '@/types'

describe('Account status sync (Qoder-2x / Hark-*) & per-bot WebSession view pinning', () => {
  beforeEach(() => {
    useBotStore.setState({
      bots: [
        {
          id: 'bot_qoder_2x',
          name: 'Qoder-2x',
          emoji: '🤖',
          description: '',
          platformId: 'hark',
          groupId: 'g1',
          accountIds: ['acc_qoder_2x'],
          activeAccountId: 'acc_qoder_2x',
          activeSessionId: 'conv_qoder_1',
          memory: [],
          notes: '',
          createdAt: 1,
          unread: 0
        } as Bot,
        {
          id: 'bot_hark_sci',
          name: 'Hark-科研助手',
          emoji: '🔬',
          description: '',
          platformId: 'hark',
          groupId: 'g1',
          accountIds: ['acc_hark_sci'],
          activeAccountId: 'acc_hark_sci',
          activeSessionId: 'conv_sci_1',
          memory: [],
          notes: '',
          createdAt: 2,
          unread: 0
        } as Bot
      ],
      accounts: {
        acc_qoder_2x: {
          id: 'acc_qoder_2x',
          platformId: 'hark',
          displayName: 'Qoder-2x',
          handle: 'qoder@hark.com',
          status: 'offline',
          statusDetail: '未登录 Hark'
        },
        acc_hark_sci: {
          id: 'acc_hark_sci',
          platformId: 'hark',
          displayName: 'Hark-科研助手',
          handle: 'sci@hark.com',
          status: 'offline'
        }
      },
      messages: {},
      typing: {},
      activity: {},
      selectedBotId: 'bot_qoder_2x',
      webSessionOpen: false,
      webSessionByBot: {}
    })
  })

  afterEach(() => {
    flushWorkspacePersistence()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('promotes stale offline Qoder-2x / Hark-* accounts to online on receiveMessage, applyHarkHistory, or streaming delta', () => {
    const store = useBotStore.getState()

    // 1. Live reply arrives for Qoder-2x while status is 'offline'
    store.receiveMessage({
      id: 'm_qoder_1',
      conversationId: 'bot_qoder_2x',
      accountId: 'acc_qoder_2x',
      text: '肠造口术后路线加好了，测试全过。',
      createdAt: Date.now()
    })
    expect(useBotStore.getState().accounts.acc_qoder_2x?.status).toBe('online')
    expect(useBotStore.getState().accounts.acc_qoder_2x?.statusDetail).toBeUndefined()

    // 2. Hark projectHistory sync arrives for Hark-科研助手 while status is 'offline'
    store.applyHarkHistory('bot_hark_sci', 'acc_hark_sci', 'conv_sci_1', [
      { id: 'h1', role: 'assistant', content: '外科护理学那篇引的 ESPEN 指南已更新', createdAt: Date.now() }
    ])
    expect(useBotStore.getState().accounts.acc_hark_sci?.status).toBe('online')
  })

  it('ignores another platform status event for a connected Hark account', () => {
    let museEvent: ((event: AdapterEvent) => void) | undefined
    const adapter = {
      id: 'meta-muse',
      subscribe: (listener: (event: AdapterEvent) => void) => {
        museEvent = listener
        return () => {}
      }
    } as PlatformAdapter
    const list = vi.spyOn(adapterRegistry, 'list').mockReturnValue([adapter])
    const stop = startAdapterBridge()
    try {
      useBotStore.getState().setAccountStatus('acc_qoder_2x', 'online')
      museEvent?.({ type: 'status', accountId: 'acc_qoder_2x', status: 'offline', detail: 'Muse preview unauthorized' })
      expect(useBotStore.getState().accounts.acc_qoder_2x?.status).toBe('online')
    } finally {
      stop()
      list.mockRestore()
    }
  })

  it('ignores sessionless messages and typing for a bot whose active account changed', () => {
    let listener: ((event: AdapterEvent) => void) | undefined
    const adapter = { id: 'hark', subscribe: (cb: (event: AdapterEvent) => void) => { listener = cb; return () => {} } }
    vi.spyOn(adapterRegistry, 'list').mockReturnValue([adapter as PlatformAdapter])
    const [target, other] = useBotStore.getState().bots as [Bot, Bot]
    useBotStore.setState({ bots: [{ ...target, accountIds: [target.activeAccountId, other.activeAccountId] }, other] })
    const stop = startAdapterBridge()
    try {
      listener?.({ type: 'typing', conversationId: target.id, accountId: other.activeAccountId, isTyping: true })
      listener?.({ type: 'message', message: {
        id: 'stale', conversationId: target.id, accountId: other.activeAccountId, text: 'Wrong account', createdAt: 1
      } })
      expect(useBotStore.getState().typing[target.id]).toBeUndefined()
      expect(useBotStore.getState().messages).toEqual({})
    } finally {
      stop()
    }
  })

  it('accepts a shorter authoritative Grok final and increments unread once for its stream', () => {
    let listener: ((event: GrokMainEvent) => void) | undefined
    vi.spyOn(adapterRegistry, 'list').mockReturnValue([])
    vi.stubGlobal('window', { electron: { grok: { onEvent: (cb: (event: GrokMainEvent) => void) => {
      listener = cb
      return () => {}
    } } } })
    const [target, selected] = useBotStore.getState().bots as [Bot, Bot]
    const bot = { ...target, platformId: 'grok' as const, selectedAgentId: 'agent' }
    useBotStore.setState((s) => ({
      bots: [bot, selected],
      selectedBotId: selected.id,
      accounts: { ...s.accounts, [bot.activeAccountId]: { ...s.accounts[bot.activeAccountId]!, platformId: 'grok' } }
    }))
    const stop = startAdapterBridge()
    try {
      const stream = {
        type: 'stream' as const, conversationId: bot.id, accountId: bot.activeAccountId,
        agentId: 'agent', sessionId: bot.activeSessionId, messageId: 'streamed', done: false, text: 'A long draft'
      }
      listener?.({ ...stream, accountId: selected.activeAccountId })
      listener?.({ ...stream, sessionId: 'stale-session' })
      expect(useBotStore.getState().messages).toEqual({})
      listener?.(stream)
      listener?.({ ...stream, text: 'A longer draft' })
      expect(useBotStore.getState().bots[0]?.unread).toBe(1)
      listener?.({ ...stream, done: true, text: 'Done' })
      useBotStore.getState().applyMessageDelta('streamed', bot.id, bot.activeAccountId, 'A longer stale draft')
      const state = useBotStore.getState()
      expect(state.messages[bot.id]).toMatchObject([{ id: 'streamed', text: 'Done' }])
      expect(state.bots[0]?.unread).toBe(1)
      expect(state.accounts[bot.activeAccountId]?.unread).toBe(1)
      expect(state.typing[bot.id]).toBeUndefined()
    } finally {
      stop()
    }
  })

  it('clears stale typing and busy status when the watchdog expires', async () => {
    vi.useFakeTimers()
    let listener: ((event: AdapterEvent) => void) | undefined
    const adapter = { id: 'hark', subscribe: (cb: (event: AdapterEvent) => void) => { listener = cb; return () => {} } }
    vi.spyOn(adapterRegistry, 'list').mockReturnValue([adapter as PlatformAdapter])
    const bot = useBotStore.getState().bots[0]!
    const accountId = bot.activeAccountId
    useBotStore.setState({ messages: { [bot.id]: [
      { id: 'accepted', botId: bot.id, accountId, role: 'user', text: 'request', createdAt: 1, delivery: 'accepted' }
    ] } })
    const stop = startAdapterBridge()
    try {
      listener?.({ type: 'typing', conversationId: bot.id, accountId, isTyping: true })
      listener?.({ type: 'activity', accountId, activity: {
        code: 'busy', text: 'Running', busy: true, emoji: null, agentId: null, subagents: 0
      } })
      await vi.advanceTimersByTimeAsync(REPLY_BUSY_LIMIT_MS)
      const state = useBotStore.getState()
      expect(state.typing[bot.id]).toBeUndefined()
      expect(state.activity[accountId]).toBeUndefined()
      expect(state.accounts[accountId]?.status).toBe('online')
      expect(state.messages[bot.id]?.[0]?.delivery).toBe('no-reply')
    } finally {
      stop()
    }
  })

  it('skips transient writes and coalesces message deltas before serializing the workspace', () => {
    vi.useFakeTimers()
    const saved = vi.fn()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: saved, removeItem: () => {} })
    const bot = useBotStore.getState().bots[0]!
    const accountId = bot.activeAccountId
    useBotStore.getState().setAccountStatus(accountId, 'online')
    flushWorkspacePersistence()
    saved.mockClear()

    const markup = { toJSON: vi.fn(() => 'fixture') }
    useBotStore.getState().setTyping(bot.id, true)
    useBotStore.getState().setActivity(accountId, { busy: true, text: 'Transient', code: 'working', emoji: null })
    useBotStore.setState((s) => ({ accounts: { ...s.accounts, [accountId]: { ...s.accounts[accountId]!, pending: true } } }))
    vi.advanceTimersByTime(500)
    expect(saved).not.toHaveBeenCalled()

    const media = [{ kind: 'file' as const, path: 'report.txt', name: markup as unknown as string }]
    useBotStore.getState().applyMessageDelta('streamed', bot.id, accountId, 'Draft', undefined, undefined, media)
    vi.advanceTimersByTime(300)
    useBotStore.getState().applyMessageDelta('streamed', bot.id, accountId, 'Final text')
    vi.advanceTimersByTime(349)
    expect(saved).not.toHaveBeenCalled()
    expect(markup.toJSON).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(saved).toHaveBeenCalledOnce()
    expect(markup.toJSON).toHaveBeenCalledOnce()
    const snapshot = JSON.parse(saved.mock.calls[0]![1]).state
    expect(snapshot.messages[bot.id][0].text).toBe('Final text')
    expect(snapshot.accounts[accountId].pending).toBeUndefined()
  })

  it('uses successfully refreshed Hark history as a live signal even for an empty session', () => {
    useBotStore.getState().applyHarkHistory('bot_hark_sci', 'acc_hark_sci', 'conv_sci_1', [])
    expect(useBotStore.getState().accounts.acc_hark_sci?.status).toBe('online')
    expect(useBotStore.getState().accounts.acc_qoder_2x?.status).toBe('offline')
  })

  it('restores the selected Bot view when rehydrating after a reload', () => {
    const current = useBotStore.getState()
    const restored = useBotStore.persist.getOptions().merge?.({
      selectedBotId: 'bot_qoder_2x',
      webSessionByBot: { bot_qoder_2x: true }
    }, current)
    expect(restored?.webSessionOpen).toBe(true)
  })

  it('pins and restores per-bot WebSession view choice when switching between bots and auto-connects offline accounts', async () => {
    const connectSpy = vi.fn(async () => 'online' as const)
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      id: 'hark',
      name: 'Hark',
      listAccounts: async () => [],
      connect: connectSpy,
      disconnect: async () => undefined,
      getStatus: () => 'online',
      subscribe: () => () => undefined,
      onMessage: () => () => undefined,
      sendMessage: async () => ({ messageId: 'm1', acceptedAt: 1 })
    } as unknown as PlatformAdapter)

    const store = useBotStore.getState()
    expect(useBotStore.getState().webSessionOpen).toBe(false)

    // User switches Qoder-2x to WebSession view (Image 2)
    store.toggleWebSession()
    expect(useBotStore.getState().webSessionOpen).toBe(true)
    expect(useBotStore.getState().webSessionByBot.bot_qoder_2x).toBe(true)

    // User switches to Hark-科研助手 (which defaults to native chat view: false)
    store.selectBot('bot_hark_sci')
    expect(useBotStore.getState().selectedBotId).toBe('bot_hark_sci')
    expect(useBotStore.getState().webSessionOpen).toBe(false)

    // User switches back to Qoder-2x -> MUST preserve WebSession view (true) instead of resetting to false!
    store.selectBot('bot_qoder_2x')
    expect(useBotStore.getState().selectedBotId).toBe('bot_qoder_2x')
    expect(useBotStore.getState().webSessionOpen).toBe(true)
    expect(connectSpy).toHaveBeenCalled()
  })
})
