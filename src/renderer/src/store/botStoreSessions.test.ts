import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HermesAdapter } from '@adapters/hermes/HermesAdapter'
import { adapterRegistry } from '@adapters/registry'
import type { PlatformAdapter, PlatformId, SendReceipt } from '@adapters/types'
import type { Bot, BotAccount, ChatMessage } from '@/types'
import { flushWorkspacePersistence, useBotStore } from './botStore'
import { SEND_HARD_TIMEOUT_MS, SEND_STILL_PENDING_TEXT, SEND_TIMEOUT_TEXT } from './delivery'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const bot: Bot = {
  id: 'bot',
  name: 'Test Bot',
  emoji: '',
  description: '',
  platformId: 'hermes',
  groupId: 'g-work',
  accountIds: ['account-a', 'account-b'],
  activeAccountId: 'account-a',
  activeSessionId: 'initial',
  memory: [],
  notes: '',
  createdAt: 1,
  unread: 0
}

const row = (id: string) => ({ id, role: 'user', text: id, createdAt: 1 })
const hermesHistory = (id: string) => ({ ok: true, data: [row(id)] })
const grokHistory = (id: string) => ({ ok: true, data: { hydrated: [row(id)] } })
const store = useBotStore.getState

function mockHermesSend(sendMessage: PlatformAdapter['sendMessage']) {
  const adapter = new HermesAdapter()
  const send = vi.spyOn(adapter, 'sendMessage').mockImplementation(sendMessage)
  vi.spyOn(adapterRegistry, 'get').mockReturnValue(adapter)
  return send
}

const chatMessage = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  ...row(id), role: 'user', botId: bot.id, accountId: bot.activeAccountId, ...patch
})
const connected = (platformId: PlatformId, id = bot.activeAccountId): BotAccount => ({
  id, platformId, displayName: id, handle: '', status: 'online'
})

describe('session navigation', () => {
  beforeEach(() => {
    useBotStore.setState({
      bots: [bot], messages: {}, accounts: {}, replyingTo: {}, typing: {}, activity: {},
      chatActionErrors: {}, hermesSessionErrors: {}, selectedBotId: bot.id
    })
  })

  afterEach(() => {
    flushWorkspacePersistence()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('counts a streamed reply as unread once when its final message lands on an unselected bot', () => {
    useBotStore.setState({ bots: [{ ...bot, platformId: 'hark' }], selectedBotId: 'other' })
    store().applyMessageDelta('hark_r1', bot.id, bot.activeAccountId, 'partial')
    const final = { id: 'hark_r1', conversationId: bot.id, accountId: bot.activeAccountId, text: 'partial done', createdAt: 2 }
    store().receiveMessage(final)
    store().receiveMessage(final)
    expect(store().bots[0]?.unread).toBe(1)
  })

  it('drops observer snapshots from the previous Hark session or account', () => {
    useBotStore.setState({ bots: [{ ...bot, platformId: 'hark' }] })
    const history = [{ id: 'visible', role: 'assistant', content: 'fixture' }]
    store().applyHarkHistory(bot.id, bot.activeAccountId, 'old', history)
    store().applyHarkHistory(bot.id, 'other', 'initial', history)
    expect(store().messages[bot.id]).toBeUndefined()
    store().applyHarkHistory(bot.id, bot.activeAccountId, 'initial', history)
    expect(store().messages[bot.id]?.map((m) => m.id)).toEqual(['hark_visible'])
  })

  it('keeps the selected Hark project when an earlier snapshot arrives late', async () => {
    useBotStore.setState({ bots: [{ ...bot, platformId: 'hark' }] })
    const pending = deferred<unknown>()
    const rpc = vi.fn().mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: true, data: { conversationId: 'new', messages: [] } })
    vi.stubGlobal('window', { electron: { hark: { rpc } } })
    const first = store().switchHarkSession(bot.id, 'previous')
    await store().switchHarkSession(bot.id, 'new')
    pending.resolve({ ok: true, data: { conversationId: 'previous', messages: [row('stale')] } })
    await first
    expect(store().bots[0]?.activeSessionId).toBe('new')
    expect(store().messages[bot.id]).toEqual([])
  })

  it('keeps the most recently selected Hermes history when requests finish out of order', async () => {
    const first = deferred<ReturnType<typeof hermesHistory>>()
    const second = deferred<ReturnType<typeof hermesHistory>>()
    const rpc = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.stubGlobal('window', { electron: { hermes: { rpc } } })

    const firstLoad = store().switchHermesSession(bot.id, 'session-a')
    const secondLoad = store().switchHermesSession(bot.id, 'session-b')
    second.resolve(hermesHistory('message-b'))
    await secondLoad
    first.resolve(hermesHistory('message-a'))
    await firstLoad

    expect(store().bots[0]?.activeSessionId).toBe('session-b')
    expect(store().messages[bot.id]?.map((m) => m.id)).toEqual(['message-b'])
  })

  it('keeps the latest request when the same Muse session is selected twice', async () => {
    useBotStore.setState({ bots: [{ ...bot, platformId: 'meta-muse' }] })
    const first = deferred<ReturnType<typeof row>[]>()
    const second = deferred<ReturnType<typeof row>[]>()
    const loadSessionHistory = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.stubGlobal('window', { electron: { muse: { loadSessionHistory } } })

    const firstLoad = store().switchMuseSession(bot.id, 'session-a')
    const secondLoad = store().switchMuseSession(bot.id, 'session-a')
    second.resolve([row('fresh')])
    await secondLoad
    first.resolve([row('stale')])
    await firstLoad

    expect(store().messages[bot.id]?.map((m) => m.id)).toEqual(['fresh'])
  })

  it.each([
    () => Promise.reject(new Error('Muse request failed')),
    () => Promise.resolve({ sessionId: null }),
    () => Promise.resolve({ sessionId: '   ' })
  ])('keeps the current Muse transcript on a rejected or invalid session creation', async (startSession) => {
    const previous = [chatMessage('kept')]
    useBotStore.setState({ bots: [{ ...bot, platformId: 'meta-muse' }], messages: { [bot.id]: previous } })
    vi.stubGlobal('window', { electron: { muse: { startSession } } })
    await store().startNewMuseSession(bot.id)
    expect(store().bots[0]?.activeSessionId).toBe('initial')
    expect(store().messages[bot.id]).toBe(previous)
    expect(store().chatActionErrors[bot.id]).toMatch(/Muse (request failed|returned no session ID)/)
  })

  it('clears a pending quote, active typing and busy activity when switching sessions within one bot', async () => {
    const account = { ...connected('meta-muse'), status: 'busy' as const }
    useBotStore.setState({
      bots: [{ ...bot, platformId: 'meta-muse' }], accounts: { [account.id]: account },
      messages: { [bot.id]: [chatMessage('kept')] },
      typing: { [bot.id]: true },
      activity: { [account.id]: { code: 'work', text: 'Working', busy: true, emoji: null } }
    })
    store().setReplyTarget(bot.id, { messageId: 'kept', entryId: 'kept', quote: 'old quote', role: 'user' })
    vi.stubGlobal('window', { electron: { muse: { startSession: async () => ({ sessionId: 'new' }) } } })
    await store().startNewMuseSession(bot.id)

    expect(store().bots[0]?.activeSessionId).toBe('new')
    expect(store().messages[bot.id]).toEqual([])
    expect(store().replyingTo[bot.id]).toBeUndefined()
    expect(store().typing[bot.id]).toBeUndefined()
    expect(store().activity[account.id]).toBeUndefined()
    expect(store().accounts[account.id]?.status).toBe('online')
  })

  it.each(['meta-muse', 'hermes', 'antigravity'] as const)(
    'merges %s history with messages sent and streamed during a history load',
    async (platformId) => {
      const history = deferred<unknown>()
      const account = connected(platformId)
      useBotStore.setState({
        bots: [{ ...bot, platformId }], accounts: { [account.id]: account },
        messages: { [bot.id]: [chatMessage('old transcript')] }
      })
      vi.spyOn(adapterRegistry, 'get').mockReturnValue({
        sendMessage: async () => ({ acceptedAt: 10, messageId: 'sent', sessionId: 'selected' })
      } as unknown as PlatformAdapter)
      vi.stubGlobal('window', { electron: {
        muse: { loadSessionHistory: () => history.promise },
        hermes: { rpc: () => history.promise },
        antigravity: { rpc: () => history.promise }
      } })
      const load = platformId === 'meta-muse' ? store().switchMuseSession
        : platformId === 'hermes' ? store().switchHermesSession : store().switchAntigravitySession
      const loading = load(bot.id, 'selected')
      const now = Date.now()
      await store().sendMessage(bot.id, 'repeat')
      await store().sendMessage(bot.id, 'repeat')
      store().applyMessageDelta('streaming', bot.id, account.id, 'current streaming text')
      store().applyMessageDelta('local-answer', bot.id, account.id, 'final snapshot with a different ID')
      const rows = [
        { ...row('history'), createdAt: now - 1000 },
        { ...row('stored-user'), text: 'repeat', createdAt: now },
        { ...row('streaming'), role: platformId === 'meta-muse' ? 'bot' : 'assistant', text: 'stale', createdAt: now },
        { ...row('remote-answer'), role: platformId === 'meta-muse' ? 'bot' : 'assistant', text: 'final snapshot with a different ID', createdAt: now },
        { ...row('later-history'), createdAt: now + 20_000 }
      ]
      history.resolve(platformId === 'meta-muse' ? rows
        : { ok: true, data: platformId === 'hermes' ? rows : { messages: rows } })
      await loading
      const messages = store().messages[bot.id] ?? []
      expect(messages.map((message) => message.text)).toEqual([
        'history', 'repeat', 'repeat', 'current streaming text', 'final snapshot with a different ID', 'later-history'
      ])
      expect(messages.filter((message) => message.id === 'streaming')).toHaveLength(1)
      expect(messages.filter((message) => message.id === 'local-answer')).toHaveLength(1)
      expect(messages.filter((message) => message.text === 'repeat').map((message) => message.delivery)).toEqual(['sent', 'sent'])
    }
  )

  it('does not let a Cue history request block or replace history for a different agent', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const latest = deferred<unknown>()
    const rpc = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(latest.promise)
    const account = connected('cue')
    useBotStore.setState({ bots: [{ ...bot, platformId: 'cue', selectedAgentId: 'a', activeSessionId: undefined }], accounts: { [account.id]: account } })
    vi.stubGlobal('window', { electron: { cue: { rpc } } })
    const pending = store().hydrateCueBotHistory(bot.id)
    store().setSelectedAgent(bot.id, 'b')
    store().setSelectedAgent(bot.id, 'a')
    const response = (sessionId: string) => ({ ok: true, data: {
      sessionId, messages: [{ id: sessionId, text: sessionId, role: 'bot', createdAtMs: 1 }]
    } })
    latest.resolve(response('new-a'))
    await latest.promise
    second.resolve(response('old-b'))
    first.resolve(response('old-a'))
    await pending
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(store().bots[0]?.activeSessionId).toBe('new-a')
    expect(store().messages[bot.id]?.map((message) => message.id)).toEqual(['new-a'])
  })

  it('rejects a Hark snapshot that identifies a different session', async () => {
    const rpc = vi.fn().mockResolvedValue({ ok: true, data: { conversationId: 'unrequested', messages: [] } })
    const messages = [chatMessage('kept')]
    useBotStore.setState({ bots: [{ ...bot, platformId: 'hark' }], messages: { [bot.id]: messages } })
    vi.stubGlobal('window', { electron: { hark: { rpc } } })
    await expect(store().switchHarkSession(bot.id, 'asked')).rejects.toThrow('Hark returned a different conversation')
    expect(store().bots[0]?.activeSessionId).toBe('initial')
    expect(store().messages[bot.id]).toBe(messages)
  })

  it('keeps a Hark project selection in flight when the account reconnects', async () => {
    const account = connected('hark')
    const project = deferred<unknown>()
    const rpc = vi.fn().mockReturnValueOnce(project.promise)
      .mockResolvedValue({ ok: true, data: { conversationId: 'incorrect-refresh', messages: [] } })
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      connect: async () => 'online'
    } as unknown as PlatformAdapter)
    vi.stubGlobal('window', { electron: { hark: { rpc } } })
    useBotStore.setState({
      bots: [{ ...bot, platformId: 'hark', activeSessionId: undefined }], accounts: { [account.id]: account }
    })
    const switching = store().switchHarkSession(bot.id, 'project')
    await store().connectAccount(account.id)
    project.resolve({ ok: true, data: { conversationId: 'project', messages: [] } })
    await switching
    expect(rpc).toHaveBeenCalledOnce()
    expect(store().bots[0]?.activeSessionId).toBe('project')
  })

  it('does not repopulate a fresh Antigravity chat with history from the previous session', async () => {
    useBotStore.setState({ bots: [{ ...bot, platformId: 'antigravity' }] })
    const pending = deferred<{ ok: boolean; data: { messages: ReturnType<typeof row>[] } }>()
    vi.stubGlobal('window', { electron: { antigravity: { rpc: () => pending.promise } } })

    const loading = store().switchAntigravitySession(bot.id, 'previous')
    store().startNewAntigravitySession(bot.id)
    pending.resolve({ ok: true, data: { messages: [row('previous-message')] } })
    await loading

    expect(store().bots[0]?.activeSessionId).toBeUndefined()
    expect(store().messages[bot.id]).toEqual([])
  })

  it('does not let a pending Hermes creation undo a subsequent history selection', async () => {
    const pending = deferred<{ ok: boolean; data: { id: string } }>()
    const rpc = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(hermesHistory('kept'))
    vi.stubGlobal('window', { electron: { hermes: { rpc } } })

    const creating = store().startNewHermesSession(bot.id)
    await store().switchHermesSession(bot.id, 'existing')
    pending.resolve({ ok: true, data: { id: 'new' } })
    await creating

    expect(store().bots[0]?.activeSessionId).toBe('existing')
    expect(store().messages[bot.id]?.map((m) => m.id)).toEqual(['kept'])
  })

  it('ignores history from before an account switch, even after switching back', async () => {
    const pending = deferred<ReturnType<typeof hermesHistory>>()
    vi.stubGlobal('window', { electron: { hermes: { rpc: () => pending.promise } } })

    const loading = store().switchHermesSession(bot.id, 'session-a')
    store().setActiveAccount(bot.id, 'account-b')
    store().setActiveAccount(bot.id, 'account-a')
    pending.resolve(hermesHistory('stale'))
    await loading

    expect(store().messages[bot.id]).toBeUndefined()
  })

  it('ignores a Grok transcript from the first visit after returning to the same agent', async () => {
    useBotStore.setState({ bots: [{ ...bot, platformId: 'grok', selectedAgentId: 'initial-agent' }] })
    const first = deferred<ReturnType<typeof grokHistory>>()
    const latest = deferred<ReturnType<typeof grokHistory>>()
    const rpc = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ok: false })
      .mockReturnValueOnce(latest.promise)
    vi.stubGlobal('window', { electron: { grok: { rpc } } })

    store().setSelectedAgent(bot.id, 'agent-a')
    store().setSelectedAgent(bot.id, 'agent-b')
    store().setSelectedAgent(bot.id, 'agent-a')
    latest.resolve(grokHistory('new-transcript'))
    await latest.promise
    first.resolve(grokHistory('stale-transcript'))
    await first.promise

    expect(store().messages[bot.id]?.map((m) => m.id)).toEqual(['new-transcript'])
  })

  it('records a late send receipt without changing the session selected after that send', async () => {
    const receipt = deferred<SendReceipt>()
    mockHermesSend(() => receipt.promise)

    const sending = store().sendMessage(bot.id, 'Hi')
    await store().switchHermesSession(bot.id, 'selected')
    receipt.resolve({ messageId: 'remote', acceptedAt: 1, sessionId: 'old-send-session' })
    await sending

    expect(store().bots[0]?.activeSessionId).toBe('selected')
    expect(store().messages[bot.id]?.[0]?.delivery).toBe('sent')
  })

  it('adopts a session assigned by the current send', async () => {
    mockHermesSend(async () => ({ messageId: 'remote', acceptedAt: 1, sessionId: 'assigned-by-platform' }))

    await store().sendMessage(bot.id, 'Hi')

    expect(store().bots[0]?.activeSessionId).toBe('assigned-by-platform')
    expect(store().messages[bot.id]?.[0]?.delivery).toBe('sent')
  })

  it.each(['receipt', 'error'] as const)('holds delivery through timeout until a late %s settles', async (outcome) => {
    vi.useFakeTimers()
    const first = deferred<SendReceipt>()
    const retry = deferred<SendReceipt>()
    let oldAcceptance: (() => void) | undefined
    const sent = mockHermesSend((message) => {
      if (!oldAcceptance) {
        oldAcceptance = message.onAccepted
        return first.promise
      }
      return retry.promise
    })
    const sending = store().sendMessage(bot.id, 'Keep one transport open')
    const id = store().messages[bot.id]![0]!.id
    await vi.advanceTimersByTimeAsync(SEND_HARD_TIMEOUT_MS)
    await sending
    expect(store().messages[bot.id]?.[0]).toMatchObject({ delivery: 'no-reply', error: SEND_STILL_PENDING_TEXT })

    await store().retryMessage(bot.id, id)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(store().messages[bot.id]?.[0]).toMatchObject({ delivery: 'no-reply', error: SEND_STILL_PENDING_TEXT })
    if (outcome === 'receipt') {
      first.resolve({ messageId: 'first', acceptedAt: 2, sessionId: 'initial' })
      await first.promise
      expect(store().messages[bot.id]?.[0]?.delivery).toBe('sent')
      await store().retryMessage(bot.id, id)
      expect(sent).toHaveBeenCalledTimes(1)
    } else {
      first.reject(new Error('transport went away'))
      await first.promise.catch(() => undefined)
      expect(store().messages[bot.id]?.[0]).toMatchObject({ delivery: 'no-reply', error: SEND_TIMEOUT_TEXT })
      const retrying = store().retryMessage(bot.id, id)
      oldAcceptance?.()
      expect(store().messages[bot.id]?.[0]?.delivery).toBe('sending')
      expect(sent).toHaveBeenCalledTimes(2)
      retry.resolve({ messageId: 'retry', acceptedAt: 3 })
      await retrying
      expect(store().messages[bot.id]?.[0]?.delivery).toBe('sent')
    }
  })

  it('finishes removing a Cue account after its connect settles and discards the refresh already in flight', async () => {
    const connection = deferred<'online'>()
    const roster = deferred<unknown>()
    const account = connected('cue')
    const rpc = vi.fn().mockReturnValue(roster.promise)
    const disconnect = vi.fn().mockResolvedValue(undefined)
    const clearAuth = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(adapterRegistry, 'get').mockReturnValue({
      connect: () => connection.promise, disconnect
    } as unknown as PlatformAdapter)
    vi.stubGlobal('window', { electron: { cue: { rpc, clearAuth } } })
    useBotStore.setState({ bots: [{ ...bot, platformId: 'cue', accountIds: [account.id] }], accounts: { [account.id]: account } })
    const refresh = store().syncCueAccountBots(account.id)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith({ op: 'listAgents', accountId: account.id }))
    const connecting = store().connectAccount(account.id)
    const removing = store().removeBot(bot.id)
    roster.resolve({ ok: true, data: [{ id: 'agent', name: 'Agent' }] })
    expect(await refresh).toBe(0)
    expect(store().bots).toEqual([])
    expect(store().accounts[account.id]).toBeUndefined()
    connection.resolve('online')
    await Promise.all([connecting, removing])
    expect(disconnect).toHaveBeenCalledExactlyOnceWith(account.id)
    expect(clearAuth).toHaveBeenCalledExactlyOnceWith(account.id)
    expect(store().bots).toEqual([])
  })

  it('does not recreate a deleted Cue bot from a shared account roster already loading', async () => {
    const account = connected('cue')
    const roster = deferred<unknown>()
    const first = { ...bot, platformId: 'cue' as const, accountIds: [account.id], selectedAgentId: 'gone' }
    useBotStore.setState({
      bots: [first, { ...first, id: 'kept', selectedAgentId: 'kept' }], accounts: { [account.id]: account }
    })
    const rpc = vi.fn().mockReturnValue(roster.promise)
    vi.stubGlobal('window', { electron: { cue: { rpc } } })
    const refresh = store().syncCueAccountBots(account.id)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalled())
    await store().removeBot(first.id)
    roster.resolve({ ok: true, data: [{ id: 'gone' }, { id: 'kept' }] })
    expect(await refresh).toBe(0)
    expect(store().bots.map((item) => item.id)).toEqual(['kept'])
    expect(store().accounts[account.id]).toBeDefined()
  })

  it.each([
    { ok: false, status: 503, message: 'Gateway temporarily unavailable' },
    { ok: true, data: {} }
  ])('keeps the Hermes session and history when creation fails with %j', async (response) => {
    vi.stubGlobal('window', { electron: { hermes: { rpc: async () => response } } })
    const previous = { ...row('existing-message'), role: 'user' as const, botId: bot.id, accountId: bot.activeAccountId }
    useBotStore.setState({ messages: { [bot.id]: [previous] } })

    expect(await store().startNewHermesSession(bot.id)).toBe(false)
    expect(store().bots[0]?.activeSessionId).toBe('initial')
    expect(store().messages[bot.id]).toEqual([previous])
    expect(store().hermesSessionErrors[bot.id]).toBeTruthy()
  })

  it('gives each new legacy Hermes chat its own key without reusing a cached native session', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { sessionId: 'old-native-session', text: 'old reply' } })
      .mockResolvedValueOnce({ ok: false, status: 404, message: 'Not supported' })
      .mockResolvedValueOnce({ ok: true, data: { text: 'new reply' } })
      .mockResolvedValueOnce({ ok: false, status: 405, message: 'Not supported' })
      .mockResolvedValueOnce({ ok: true, data: { text: 'another reply' } })
    vi.stubGlobal('window', { electron: { hermes: { rpc, onEvent: () => () => undefined } } })
    vi.spyOn(adapterRegistry, 'get').mockReturnValue(new HermesAdapter())

    await store().sendMessage(bot.id, 'Old conversation')
    expect(store().bots[0]?.activeSessionId).toBe('old-native-session')
    expect(await store().startNewHermesSession(bot.id)).toBe(true)
    const firstKey = store().bots[0]?.hermesSessionKey
    expect(firstKey).toBeTruthy()
    expect(store().messages[bot.id]).toEqual([])
    await store().sendMessage(bot.id, 'First legacy chat')
    expect(rpc).toHaveBeenNthCalledWith(3, expect.objectContaining({
      sessionId: undefined, sessionKey: firstKey
    }))

    expect(await store().startNewHermesSession(bot.id)).toBe(true)
    const secondKey = store().bots[0]?.hermesSessionKey
    expect(secondKey).toBeTruthy()
    expect(secondKey).not.toBe(firstKey)
    await store().sendMessage(bot.id, 'Second legacy chat')
    expect(rpc).toHaveBeenNthCalledWith(5, expect.objectContaining({
      sessionId: undefined, sessionKey: secondKey
    }))
  })
})
