import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AntigravityAdapter } from '@adapters/antigravity/AntigravityAdapter'
import { HermesAdapter } from '@adapters/hermes/HermesAdapter'
import { adapterRegistry } from '@adapters/registry'
import type { AdapterListener } from '@adapters/types'
import type { MobileRelayCommand, MobileSendCommand, MobileSendResult, MobileSyncStateView, MobileWorkspaceSnapshotUpdate } from '@shared/mobileSync'
import { useBotStore } from '@/store/botStore'
import { startMobileSyncBridge } from './mobileSyncBridge'

let stop: (() => void) | undefined
let onAdapterEvent: AdapterListener
let onCommand: (command: MobileRelayCommand) => void
let onStateChanged: (status: MobileSyncStateView) => void
let onSendCommand: (command: MobileSendCommand) => MobileSendResult
const accountId = 'snapshot-account'
const approval = { id: 'approval', status: 'pending', title: 'Fixture approval' }
const otherApproval = { id: 'other', status: 'pending', title: 'Other approval' }
const snapshots = vi.fn<(snapshot: MobileWorkspaceSnapshotUpdate) => void>()
const publishEvent = vi.fn()
let adapter: HermesAdapter

const noClient: MobileSyncStateView = {
  running: true, port: 19472, hosts: [], primaryHost: null, hostName: '', fingerprint: '',
  pairUri: null, pairExpiresAtMs: null, includeDirectCredentials: false, devices: []
}
const connected: MobileSyncStateView = {
  ...noClient,
  devices: [{ deviceId: 'phone', deviceName: 'Phone', pairedAtMs: 1, lastSeenAtMs: 1, connected: true }]
}

beforeEach(() => {
  vi.useFakeTimers()
  snapshots.mockClear()
  publishEvent.mockClear()
  useBotStore.setState({
    accounts: { [accountId]: { id: accountId, platformId: 'hermes', status: 'online', handle: '', displayName: 'Fixture' } },
    groups: [{ id: 'group', name: 'Fixture group' }], collapsedGroups: {}
  })
  const unsubscribe = () => undefined
  vi.stubGlobal('window', { electron: { mobileSync: {
    pushSnapshot: snapshots,
    pushEvent: publishEvent,
    getState: async () => connected,
    onStateChanged: (listener: typeof onStateChanged) => { onStateChanged = listener; return unsubscribe },
    onSendCommand: (listener: typeof onSendCommand) => { onSendCommand = listener; return unsubscribe },
    onCommand: (listener: typeof onCommand) => { onCommand = listener; return unsubscribe }
  } } })
  adapter = new HermesAdapter()
  vi.spyOn(adapterRegistry, 'list').mockReturnValue([adapter])
  vi.spyOn(adapterRegistry, 'get').mockReturnValue(adapter)
  vi.spyOn(adapter, 'subscribe').mockImplementation((listener) => { onAdapterEvent = listener; return unsubscribe })
  stop = startMobileSyncBridge()
  onStateChanged(connected)
})

afterEach(() => {
  stop?.()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('mobile snapshots', () => {
  it('skips idle changes and answers explicit snapshot requests with the latest state', async () => {
    onStateChanged({ ...noClient, running: false })
    useBotStore.getState().toggleGroup('group')
    await vi.advanceTimersByTimeAsync(4000)
    onStateChanged(noClient)
    onAdapterEvent({ type: 'approvals', accountId, pending: [approval] })
    await vi.advanceTimersByTimeAsync(4000)
    expect(snapshots).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()

    onStateChanged({ ...noClient, running: false, snapshotRequestId: 'export' })
    expect(snapshots).toHaveBeenCalledOnce()
    expect(snapshots.mock.lastCall?.[0]).toMatchObject({
      snapshotRequestId: 'export', publishSnapshot: false,
      groups: [{ id: 'group', collapsed: true }], approvals: { [accountId]: [approval] }
    })

    onStateChanged(connected)
    onStateChanged({ ...connected, snapshotRequestId: 'join' })
    await vi.advanceTimersByTimeAsync(4000)
    expect(snapshots).toHaveBeenCalledTimes(2)
    expect(snapshots.mock.lastCall?.[0].snapshotRequestId).toBe('join')
    useBotStore.getState().toggleGroup('group')
    onStateChanged(noClient)
    await vi.advanceTimersByTimeAsync(4000)
    expect(snapshots).toHaveBeenCalledTimes(2)
  })

  it('acknowledges a queued send before building one coalesced snapshot', async () => {
    const command = { botId: 'bot', text: 'Hi', clientMessageId: 'mobile-id' }
    const queue = vi.spyOn(useBotStore.getState(), 'queueMobileMessage').mockImplementation(() => {
      useBotStore.getState().toggleGroup('group')
      return { ok: true, messageId: command.clientMessageId }
    })
    expect(onSendCommand(command)).toEqual({ ok: true, messageId: command.clientMessageId })
    expect(queue).toHaveBeenCalledOnce()
    expect(snapshots).not.toHaveBeenCalled()
    for (let i = 0; i < 10; i++) {
      onAdapterEvent({ type: 'status', accountId, status: i % 2 === 0 ? 'busy' : 'online' })
      useBotStore.getState().toggleGroup('group')
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(publishEvent).toHaveBeenCalledTimes(10)
    expect(snapshots).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(750)
    expect(snapshots).toHaveBeenCalledOnce()
  })

  it('publishes collapse-only and approval-only changes, including a cleared approval list', async () => {
    useBotStore.getState().toggleGroup('group')
    await vi.advanceTimersByTimeAsync(750)
    expect(snapshots.mock.lastCall?.[0].groups[0]?.collapsed).toBe(true)

    onAdapterEvent({ type: 'approvals', accountId, pending: [approval] })
    await vi.advanceTimersByTimeAsync(750)
    expect(snapshots.mock.lastCall?.[0].approvals[accountId]).toMatchObject([approval])

    onAdapterEvent({ type: 'approvals', accountId, pending: [] })
    await vi.advanceTimersByTimeAsync(750)
    expect(snapshots.mock.lastCall?.[0].approvals[accountId]).toEqual([])
  })

  it('does not clear other pending approvals when the list refresh fails after a decision', async () => {
    onAdapterEvent({ type: 'approvals', accountId, pending: [approval, otherApproval] })
    vi.spyOn(adapter, 'decideApproval').mockResolvedValue(undefined)
    vi.spyOn(adapter, 'listApprovals').mockRejectedValue(new Error('Fixture unavailable'))
    onCommand({ kind: 'decideApproval', accountId, platformId: 'hermes', approvalId: approval.id, decision: 'deny' })
    await vi.advanceTimersByTimeAsync(750)

    expect(snapshots.mock.lastCall?.[0].approvals[accountId]).toMatchObject([otherApproval])
  })

  it('resolves Muse workspace image paths into inline data URLs for paired mobile clients', async () => {
    stop?.()
    const previewWorkspaceFile = vi.fn().mockResolvedValue({
      path: 'workspace/assistant/dog.png',
      mimeType: 'image/png',
      dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      byteLength: 68
    })
    const unsubscribe = () => undefined
    vi.stubGlobal('window', {
      electron: {
        muse: { previewWorkspaceFile },
        mobileSync: {
          pushSnapshot: snapshots,
          pushEvent: publishEvent,
          getState: async () => connected,
          onStateChanged: (listener: typeof onStateChanged) => { onStateChanged = listener; return unsubscribe },
          onSendCommand: () => unsubscribe,
          onCommand: () => unsubscribe
        }
      }
    })
    useBotStore.setState({
      accounts: {
        acc_m1: { id: 'acc_m1', platformId: 'meta-muse', status: 'online', handle: '', displayName: 'Muse 1' }
      },
      bots: [
        {
          id: 'bot_m1',
          name: 'Muse 1',
          emoji: '🤖',
          description: '',
          platformId: 'meta-muse',
          groupId: 'group',
          accountIds: ['acc_m1'],
          activeAccountId: 'acc_m1',
          memory: [],
          notes: '',
          createdAt: 1,
          unread: 0
        }
      ],
      messages: {
        bot_m1: [
          {
            id: 'msg_1',
            botId: 'bot_m1',
            accountId: 'acc_m1',
            role: 'bot',
            text: '画好啦，一只小狗。',
            createdAt: 2,
            media: [{ kind: 'image', path: 'workspace/assistant/dog.png', name: 'dog.png' }]
          }
        ]
      }
    })
    stop = startMobileSyncBridge()
    onStateChanged({ ...connected, snapshotRequestId: 'join' })
    await vi.advanceTimersByTimeAsync(750)
    expect(previewWorkspaceFile).toHaveBeenCalledWith('acc_m1', 'workspace/assistant/dog.png')
    const latestMedia = snapshots.mock.lastCall?.[0].messages['bot_m1']?.[0]?.media?.[0]
    expect(latestMedia?.kind).toBe('image')
    expect(latestMedia?.path).toMatch(/^data:image\/png;base64,/)
  })

  it('does not call Muse previewWorkspaceFile for Hark or other non-Muse account media', async () => {
    stop?.()
    const previewWorkspaceFile = vi.fn()
    const unsubscribe = () => undefined
    vi.stubGlobal('window', {
      electron: {
        muse: { previewWorkspaceFile },
        mobileSync: {
          pushSnapshot: snapshots,
          pushEvent: publishEvent,
          getState: async () => connected,
          onStateChanged: (listener: typeof onStateChanged) => { onStateChanged = listener; return unsubscribe },
          onSendCommand: () => unsubscribe,
          onCommand: () => unsubscribe
        }
      }
    })
    useBotStore.setState({
      accounts: {
        acc_hark_1: { id: 'acc_hark_1', platformId: 'hark', status: 'online', handle: '', displayName: 'Qoder-2x' }
      },
      bots: [
        {
          id: 'bot_hark_1',
          name: 'Qoder-2x',
          emoji: '🤖',
          description: '',
          platformId: 'hark',
          groupId: 'group',
          accountIds: ['acc_hark_1'],
          activeAccountId: 'acc_hark_1',
          memory: [],
          notes: '',
          createdAt: 1,
          unread: 0
        }
      ],
      messages: {
        bot_hark_1: [
          {
            id: 'msg_h1',
            botId: 'bot_hark_1',
            accountId: 'acc_hark_1',
            role: 'bot',
            text: 'Hark attachment',
            createdAt: 2,
            media: [{ kind: 'image', path: 'workspace/hark/chart.png', name: 'chart.png' }]
          }
        ]
      }
    })
    stop = startMobileSyncBridge()
    onStateChanged({ ...connected, snapshotRequestId: 'join' })
    await vi.advanceTimersByTimeAsync(750)
    expect(previewWorkspaceFile).not.toHaveBeenCalled()
  })

})

describe('Antigravity adapter correlation', () => {
  it('ignores same-conversation events from another send and resumes after approval', async () => {
    type TurnEvent = import('../../../main/antigravity/antigravityProtocol').AntigravityTurnEvent
    let emit!: (event: TurnEvent) => void
    let messageId!: string
    const onAccepted = vi.fn()
    vi.stubGlobal('window', { electron: { antigravity: {
      onEvent: (listener: typeof emit) => { emit = listener; return () => undefined },
      sendMessage: async (request: { clientMessageId: string }) => {
        messageId = request.clientMessageId
        return { ok: true, cascadeId: 'cascade', messageId }
      },
      cancelRun: async () => undefined
    } } })
    const adapter = new AntigravityAdapter()
    const receive = vi.fn()
    adapter.onMessage(receive)
    const send = adapter.sendMessage({ accountId: 'account', conversationId: 'bot', text: 'Test', onAccepted })
    const activity = { type: 'activity' as const, accountId: 'account', activityCode: 'needs_approval', busy: false }
    const stream = { type: 'stream' as const, accountId: 'account', conversationId: 'bot', sessionId: 'cascade' }
    emit({ ...activity, messageId: 'other' })
    emit({ ...stream, messageId: 'other', text: 'Wrong reply', done: true })
    expect(adapter.getStatus('account')).toBe('busy')
    expect(receive).not.toHaveBeenCalled()

    emit({ ...activity, messageId })
    emit({ ...stream, messageId, text: 'Pending confirmation', done: false, waitingForApproval: true })
    expect((await send).sessionId).toBe('cascade')
    expect(onAccepted).toHaveBeenCalledOnce()
    expect(adapter.getStatus('account')).toBe('attention')
    emit({ ...activity, messageId, activityCode: 'thinking', busy: true })
    emit({ ...stream, messageId, text: 'Resumed answer', done: true })
    expect(adapter.getStatus('account')).toBe('online')
    expect(receive.mock.calls.map(([event]) => event.text)).toEqual(['Pending confirmation', 'Resumed answer'])
  })
})
