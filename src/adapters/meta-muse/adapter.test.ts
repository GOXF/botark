import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MuseAdapter } from './adapter'

describe('MuseAdapter approvals', () => {
  const originalWindow = (globalThis as { window?: unknown }).window
  let rpcMock: ReturnType<typeof vi.fn>
  let openHttpsMock: ReturnType<typeof vi.fn>
  let mainEventListener: ((e: unknown) => void) | undefined

  beforeEach(() => {
    rpcMock = vi.fn()
    openHttpsMock = vi.fn().mockResolvedValue(undefined)
    mainEventListener = undefined
    ;(globalThis as { window?: unknown }).window = {
      electron: {
        muse: {
          onEvent: (cb: (e: unknown) => void) => {
            mainEventListener = cb
            return () => {
              mainEventListener = undefined
            }
          },
          ensure: vi.fn().mockResolvedValue({
            accountId: 'acc_1',
            signedIn: true,
            ready: true,
            pendingApprovals: 0
          }),
          rpc: rpcMock,
          openHttps: openHttpsMock
        }
      }
    }
  })

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
  })

  it('fetches pending_approvals even when legacy pending is [] and status was error', async () => {
    const adapter = new MuseAdapter()
    await adapter.ensureSession('acc_1')
    // Force status into 'error' via a failed send or status mutation check via selectOptionWidget error.
    rpcMock.mockResolvedValueOnce({
      pending: [],
      pending_approvals: [
        {
          approval_id: 'appr_browser_upload',
          status: 'pending',
          approval_type: 'outgoing_media',
          message_revision: 2,
          decision_options: [
            { kind: 'allow_once', label: { kind: 'allow_once' }, label_text: '允许一次' },
            {
              kind: 'allow_always',
              label: { kind: 'allow_always_scoped', scope: 'destination_domain' },
              label_text: '始终允许上传到此站点'
            },
            { kind: 'deny', label: { kind: 'deny' }, label_text: '拒绝' }
          ],
          display: {
            display_name: 'Browser',
            action_description: 'Your assistant wants to upload a file to github.com',
            permission_question: { text: '允许Muse使用 Browser 上传这个文件?' }
          },
          payload: {
            type: 'outgoing_media',
            outgoing_media_payload: {
              destination_domain: 'github.com',
              filename: 'error.png'
            }
          }
        }
      ]
    })

    // Simulate status='error' to confirm listApprovals does NOT short-circuit to [].
    ;(adapter as unknown as { statuses: Map<string, string> }).statuses.set('acc_1', 'error')

    const pending = await adapter.listApprovals('acc_1')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.id).toBe('appr_browser_upload')
    expect(pending[0]!.title).toBe('允许Muse使用 Browser 上传这个文件?')
    expect(pending[0]!.hasExplicitTitle).toBe(true)
    expect(pending[0]!.host).toBe('github.com')
    expect(adapter.getStatus('acc_1')).toBe('attention')

    // Decide allow_always with server-provided destination_domain scope.
    rpcMock.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ pending_approvals: [] })
    await adapter.decideApproval('acc_1', 'appr_browser_upload', 'allow_always', {
      scope: 'destination_domain'
    })

    expect(rpcMock).toHaveBeenNthCalledWith(2, {
      accountId: 'acc_1',
      method: 'egress.approval.decide',
      params: {
        approval_id: 'appr_browser_upload',
        decision: 'allow_always',
        always_scope: 'destination_domain',
        allow_always_scope: 'destination_domain',
        reason: null,
        expires_at_ms: null,
        notification_channel: 'ui',
        expected_message_revision: 2
      }
    })
    expect(adapter.getStatus('acc_1')).toBe('online')
  })

  it('fetches egress.approval detail when deciding an uncached card and supports opensUrl', async () => {
    const adapter = new MuseAdapter()
    await adapter.ensureSession('acc_1')

    rpcMock
      .mockResolvedValueOnce({
        approval_id: 'appr_checkout',
        status: 'pending',
        decision_options: [
          { kind: 'open_checkout', label_text: 'Open checkout', opens_url: 'https://checkout.stripe.com/c/123' }
        ]
      })
      .mockResolvedValueOnce({ pending_approvals: [] })

    await adapter.decideApproval('acc_1', 'appr_checkout', 'open_checkout')
    expect(openHttpsMock).toHaveBeenCalledWith('https://checkout.stripe.com/c/123')
    // Non-Sentinel URL-only option opens the URL and refreshes without sending an invalid decide RPC.
    expect(rpcMock).toHaveBeenCalledTimes(2)
    expect(rpcMock).toHaveBeenNthCalledWith(1, {
      accountId: 'acc_1',
      method: 'egress.approval',
      params: { approval_id: 'appr_checkout' }
    })
    expect(rpcMock).toHaveBeenNthCalledWith(2, {
      accountId: 'acc_1',
      method: 'egress.approvals',
      params: {}
    })
    expect(mainEventListener).toBeTypeOf('function')
  })

  it('ignores superseded approval reads and never resurrects terminal approvals for that account', async () => {
    const adapter = new MuseAdapter()
    await adapter.ensureSession('acc_1')
    await adapter.ensureSession('acc_2')
    let resolveRead!: (value: unknown) => void
    rpcMock.mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve }))
    const read = adapter.listApprovals('acc_1')
    const stale = { approval_id: 'same-id', title: 'Approval' }
    mainEventListener?.({ type: 'approvals', accountId: 'acc_1', approvalVersion: 5, pending: [], terminalApprovalIds: ['same-id'] })
    mainEventListener?.({ type: 'approvals', accountId: 'acc_2', approvalVersion: 1, pending: [stale] })
    resolveRead({ approvalVersion: 4, pending: [stale] })
    await expect(read).resolves.toEqual([])
    rpcMock.mockResolvedValueOnce({ approvalVersion: 6, pending: [stale] })
    await expect(adapter.listApprovals('acc_1')).resolves.toEqual([])
    expect(adapter.getStatus('acc_1')).toBe('online')
    expect(adapter.getStatus('acc_2')).toBe('attention')
  })

  it('coalesces approval reads per account and keeps versions independent', async () => {
    const adapter = new MuseAdapter()
    await adapter.ensureSession('acc_1')
    await adapter.ensureSession('acc_2')
    rpcMock.mockResolvedValueOnce({ approvalVersion: 8, pending: [{ id: 'one' }] })
    rpcMock.mockResolvedValueOnce({ approvalVersion: 2, pending: [{ id: 'two' }] })
    const [one, same, two] = await Promise.all([
      adapter.listApprovals('acc_1'), adapter.listApprovals('acc_1'), adapter.listApprovals('acc_2')
    ])
    expect(rpcMock).toHaveBeenCalledTimes(2)
    expect(one).toMatchObject([{ id: 'one' }])
    expect(same).toEqual(one)
    expect(two).toMatchObject([{ id: 'two' }])
  })

  it('correlates acceptance and fallback delivery by send ID within the same conversation', async () => {
    const adapter = new MuseAdapter()
    await adapter.ensureSession('acc_1')
    const received = vi.fn()
    adapter.onMessage(received)
    const sends: Array<{ sendId: string; resolve: (raw: unknown) => void }> = []
    rpcMock.mockImplementation((req: { method: string; sendId: string }) => {
      if (req.method !== 'chat.stream') return Promise.resolve({})
      return new Promise((resolve) => sends.push({ sendId: req.sendId, resolve }))
    })
    const firstAccepted = vi.fn()
    const secondAccepted = vi.fn()
    const common = { accountId: 'acc_1', conversationId: 'bot', sessionId: 'session', text: 'hello' }
    const first = adapter.sendMessage({ ...common, onAccepted: firstAccepted })
    await vi.waitFor(() => expect(sends).toHaveLength(1))
    const second = adapter.sendMessage({ ...common, onAccepted: secondAccepted })
    await vi.waitFor(() => expect(sends).toHaveLength(2))
    const [one, two] = sends as [typeof sends[number], typeof sends[number]]
    mainEventListener?.({ type: 'sent', accountId: 'acc_1', conversationId: 'bot' })
    mainEventListener?.({ type: 'sent', accountId: 'wrong', conversationId: 'bot', sendId: two.sendId })
    expect(firstAccepted).not.toHaveBeenCalled()
    expect(secondAccepted).not.toHaveBeenCalled()
    mainEventListener?.({ type: 'sent', accountId: 'acc_1', conversationId: 'bot', sendId: one.sendId })
    expect(firstAccepted).toHaveBeenCalledOnce()
    expect(secondAccepted).not.toHaveBeenCalled()
    mainEventListener?.({ type: 'stream', accountId: 'acc_1', conversationId: 'bot', sendId: one.sendId,
      messageId: 'stream-one', done: true, text: 'First answer' })
    mainEventListener?.({ type: 'sent', accountId: 'acc_1', conversationId: 'bot', sendId: two.sendId })
    expect(secondAccepted).toHaveBeenCalledOnce()
    two.resolve({ text: 'Second answer' })
    one.resolve({ text: 'First answer' })
    await expect(first).resolves.toMatchObject({ messageId: one.sendId })
    await expect(second).resolves.toMatchObject({ messageId: two.sendId })
    expect(received.mock.calls.map(([message]) => message.text)).toEqual(['First answer', 'Second answer'])
  })

  it('sends Stop for the room turn that owns the abort signal', async () => {
    const adapter = new MuseAdapter()
    await adapter.ensureSession('acc_1')
    const abort = new AbortController()
    let resolveSend!: (value: unknown) => void
    rpcMock.mockImplementation((req: { method: string }) => req.method === 'chat.stream'
      ? new Promise((resolve) => { resolveSend = resolve })
      : Promise.resolve({ ok: true }))
    const send = adapter.sendMessage({ accountId: 'acc_1', conversationId: 'room-turn-1', text: 'hello', signal: abort.signal })
    await vi.waitFor(() => expect(rpcMock).toHaveBeenCalledOnce())
    const sendId = rpcMock.mock.calls[0]?.[0]?.sendId
    abort.abort()
    expect(rpcMock).toHaveBeenNthCalledWith(2, { accountId: 'acc_1', method: 'chat.stop_turn', sendId })
    resolveSend({ text: 'late' })
    await expect(send).rejects.toMatchObject({ name: 'AbortError' })
  })
})
