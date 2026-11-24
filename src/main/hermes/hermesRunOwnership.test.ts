import { expect, it, vi } from 'vitest'
import { cancelAllHermesRuns, decideHermesApproval, listHermesApprovals, sendHermesMessage, stopHermesRun } from './hermesClient'

const { account } = vi.hoisted(() => ({ account: vi.fn(() => ({ baseUrl: 'http://127.0.0.1:8642', apiKey: 'first-key' })) }))
vi.mock('./hermesStore', () => ({ getHermesAccount: account }))

function streamingFixture() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({ start: (value) => { controller = value }, cancel })
  return {
    response: new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
    cancel,
    event(type: string, data: object) {
      controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`))
    },
    approval(runId: string, requestId: string, details: object = {}) {
      this.event('approval.request', { run_id: runId, request_id: requestId, ...details })
    }
  }
}

it('preserves the current run and approvals when a replaced stream is cancelled', async () => {
  const accountId = 'shared-fixture'
  const old = streamingFixture()
  const next = streamingFixture()
  const oldActivity = vi.fn()
  const oldApprovals = vi.fn()
  const task = (stream: typeof old, opts: Partial<Parameters<typeof sendHermesMessage>[0]['callbacks']> = {}) =>
    sendHermesMessage({
      accountId, sessionId: 'session', text: 'Hello',
      callbacks: { onDelta: vi.fn(), ...opts },
      fetchImpl: async () => stream.response
    })
  const first = task(old, { onActivity: oldActivity, onApprovals: oldApprovals })
  let second: ReturnType<typeof task> | undefined

  try {
    old.approval('initial-run', 'initial-approval')
    await vi.waitFor(() => expect(listHermesApprovals(accountId).map((a) => a.id)).toEqual(['initial-approval']))

    const stopped = first.catch((error: unknown) => error)
    second = task(next)
    next.approval('new-run', 'new-approval')
    await vi.waitFor(() => expect(listHermesApprovals(accountId).map((a) => a.id)).toEqual(['new-approval']))

    expect(await stopped).toMatchObject({ name: 'AbortError' })
    expect(old.cancel).toHaveBeenCalledOnce()
    expect(oldApprovals.mock.calls.filter(([pending]) => pending.length === 0)).toHaveLength(1)
    expect(oldActivity).not.toHaveBeenCalledWith({ code: 'idle', busy: false }, 'session')
    await expect(decideHermesApproval(accountId, 'initial-approval', 'deny')).rejects.toMatchObject({ status: 409 })
  } finally {
    cancelAllHermesRuns(accountId)
    await Promise.allSettled(second ? [first, second] : [first])
  }
})

it('pins approval and Stop to the originating gateway and locks repeated approval events', async () => {
  const accountId = 'run-owner'
  const stream = streamingFixture()
  let approve!: (res: Response) => void
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(stream.response)
    .mockImplementationOnce(() => new Promise((resolve) => { approve = resolve }))
    .mockResolvedValueOnce(Response.json({ status: 'running' }))
    .mockResolvedValueOnce(Response.json({ status: 'stopping', run_id: 'run' }))
  const turn = sendHermesMessage({ accountId, sessionId: 'session', text: 'Hello', callbacks: { onDelta: vi.fn() }, fetchImpl })
  const outcome = turn.catch((error: unknown) => error)
  try {
    stream.approval('run', 'approve', { command: 'fixture task' })
    await vi.waitFor(() => expect(listHermesApprovals(accountId)).toHaveLength(1))
    account.mockReturnValue({ baseUrl: 'http://other.example:8642', apiKey: 'other-key' })

    const decision = decideHermesApproval(accountId, 'approve', 'allow_once')
    stream.approval('run', 'approve', { description: 'Details arrived later' })
    await vi.waitFor(() => expect(listHermesApprovals(accountId)[0]).toMatchObject({
      title: 'Allow command: fixture task', detail: 'Details arrived later'
    }))
    await expect(decideHermesApproval(accountId, 'approve', 'deny')).rejects.toMatchObject({ code: 'approval_in_progress' })
    approve(Response.json({ ok: true }))
    await decision
    stream.approval('run', 'approve', { description: 'Duplicate after approval' })
    await expect(stopHermesRun(accountId)).rejects.toMatchObject({ code: 'stop_unconfirmed' })
    expect(listHermesApprovals(accountId)).toEqual([])
    expect(stream.cancel).not.toHaveBeenCalled()

    await stopHermesRun(accountId)
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(fetchImpl.mock.calls.slice(1).map(([url, init]) => [
      String(url), new Headers(init?.headers).get('authorization')
    ])).toEqual([
      ['http://127.0.0.1:8642/v1/runs/run/approval', 'Bearer first-key'],
      ['http://127.0.0.1:8642/v1/runs/run/stop', 'Bearer first-key'],
      ['http://127.0.0.1:8642/v1/runs/run/stop', 'Bearer first-key']
    ])
  } finally {
    cancelAllHermesRuns(accountId)
    await outcome
    account.mockReturnValue({ baseUrl: 'http://127.0.0.1:8642', apiKey: 'first-key' })
  }
})

it('aborts native session creation before dispatching a message', async () => {
  const fetchImpl = vi.fn<typeof fetch>((_, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  }))
  const turn = sendHermesMessage({
    accountId: 'session-creation', text: 'Hello', callbacks: { onDelta: vi.fn() }, fetchImpl
  })
  const outcome = turn.catch((error: unknown) => error)
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
  await stopHermesRun('session-creation')
  expect(await outcome).toMatchObject({ name: 'AbortError' })
  expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(['http://127.0.0.1:8642/api/sessions'])
})
