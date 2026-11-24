import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDotTarget } from './dotTarget'

const transport = vi.hoisted(() => vi.fn<(_proxy: string | undefined, _url: string, _opts?: RequestInit) => Promise<Response>>())
const accountProxy = vi.hoisted(() => vi.fn<() => Promise<string | undefined>>())
vi.mock('../main/proxyTransport', () => ({ DIRECT_PROXY_URL: 'direct://', proxyFetch: transport, proxyWsAgent: () => undefined }))
vi.mock('../main/muse/accountProxy', () => ({
  loadAccountProxyUrl: accountProxy,
  loadAccountTransportProxyUrl: accountProxy,
  applyProxyToPartition: async () => undefined,
  ProxyConfigUnreadableError: Error
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync: () => false,
  mkdirSync: () => undefined,
  writeFileSync: () => undefined,
  chmodSync: () => undefined,
  renameSync: () => undefined
}))

const acc = { activeDotId: 'dot-new', roomId: 'room-new' }

describe('resolveDotTarget', () => {
  it('ignores a stale profile from the renderer after a switch', () => {
    expect(resolveDotTarget({ dotId: 'dot-old', roomId: 'room-old' }, acc)).toEqual({ dotId: 'dot-new', roomId: 'room-new' })
  })
  it('ignores a bare old room id (chat sessionId)', () => {
    expect(resolveDotTarget({ roomId: 'room-old' }, acc)).toEqual({ dotId: 'dot-new', roomId: 'room-new' })
  })
  it('uses the stored account when the request names nothing', () => {
    expect(resolveDotTarget({}, acc)).toEqual({ dotId: 'dot-new', roomId: 'room-new' })
  })
  it('keeps the active profile and its stored room together', () => {
    expect(resolveDotTarget({ dotId: 'dot-new', roomId: 'room-x' }, acc)).toEqual({ dotId: 'dot-new', roomId: 'room-new' })
  })
  it('leaves an active profile with an unknown room for the caller to resolve', () => {
    expect(resolveDotTarget({ dotId: 'dot-old', roomId: 'room-old' }, { activeDotId: 'dot-new' }))
      .toEqual({ dotId: 'dot-new', roomId: undefined })
  })
  it('does not combine an explicit profile with an unrelated stored room', () => {
    expect(resolveDotTarget({ dotId: 'dot-new' }, { roomId: 'unscoped-room' }))
      .toEqual({ dotId: 'dot-new', roomId: undefined })
  })
  it('passes through when nothing is stored yet', () => {
    expect(resolveDotTarget({ dotId: 'd', roomId: 'r' }, undefined)).toEqual({ dotId: 'd', roomId: 'r' })
  })
})

describe('Dot target ownership and credentials', () => {
  let dot: typeof import('../main/dot/dotClient')
  const id = 'test-account'

  beforeEach(async () => {
    transport.mockReset()
    accountProxy.mockReset()
    accountProxy.mockResolvedValue(undefined)
    dot = await import('../main/dot/dotClient')
    dot.upsertDotCredentials(id, {
      accessToken: 'fixture-access', refreshToken: 'fixture-refresh', chatgptAccountId: 'test-chatgpt',
      proxyUrl: 'http://old-proxy.invalid:8080', mode: 'native'
    })
    dot.patchStoredDotAccount(id, { activeDotId: 'dot-1', roomId: 'room-1' })
  })

  afterEach(() => dot.clearAllStoredDotAccounts())

  it('strips credentials from cross-origin file redirects and prefers the current proxy', async () => {
    accountProxy.mockResolvedValue('http://current-proxy.invalid:8080')
    transport.mockResolvedValueOnce(new Response(null, {
      status: 302, headers: { location: 'https://files.example.test/signed' }
    }))
    transport.mockResolvedValueOnce(new Response('file contents'))
    await expect(dot.downloadDotFile(id, { url: 'https://chatgpt.com/download/fixture' })).resolves.toMatchObject({
      dataBase64: Buffer.from('file contents').toString('base64')
    })
    const [first, redirected] = transport.mock.calls
    expect(first?.[0]).toBe('http://current-proxy.invalid:8080')
    expect(new Headers(first?.[2]?.headers).get('Authorization')).toBe('Bearer fixture-access')
    expect(new Headers(redirected?.[2]?.headers).get('chatgpt-account-id')).toBeNull()
    expect(new Headers(redirected?.[2]?.headers).get('Authorization')).toBeNull()
  })

  it('shares one token refresh and rejects stale credential commits after sign-out', async () => {
    let finish!: (response: Response) => void
    transport.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const first = dot.refreshDotAccessToken(id)
    const second = dot.refreshDotAccessToken(id)
    const outcomes = Promise.allSettled([first, second])
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce())
    dot.clearStoredDotAccount(id)
    finish(Response.json({ access_token: 'late', refresh_token: 'late-refresh' }))
    expect((await outcomes).map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
    expect(await dot.getDotAuthStatus(id)).toEqual({ accountId: id, signedIn: false })
    expect(transport).toHaveBeenCalledOnce()
  })

  it('rejects history for a switched profile and skips malformed entries in the current room', async () => {
    let finish!: (response: Response) => void
    transport.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const old = dot.listRoomMessages(id, { dotId: 'dot-1', roomId: 'room-1' })
    const stale = expect(old).rejects.toThrow('profile changed')
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce())
    dot.patchStoredDotAccount(id, { activeDotId: 'dot-2', roomId: 'room-2' })
    finish(Response.json({ items: [{ id: 'old', room_id: 'room-1', text: 'Earlier room' }] }))
    await stale

    transport.mockResolvedValueOnce(Response.json({ items: [
      null, [], { text: 'missing ID' }, { id: 'old', room_id: 'room-1' },
      { id: 'new', room_id: 'room-2', text: 'Current room' }
    ] }))
    expect(await dot.listRoomMessages(id, { dotId: 'dot-2', roomId: 'room-1' })).toMatchObject({
      dotId: 'dot-2', roomId: 'room-2', messages: [{ id: 'new', text: 'Current room' }]
    })
  })

  it('commits only the latest profile selection when an earlier history request completes late', async () => {
    let finishOldHistory!: (response: Response) => void
    transport.mockImplementation(async (_proxy, url) => {
      const path = new URL(url).pathname
      if (path.endsWith('/tbo/dot-2')) return Response.json({ id: 'dot-2', messaging_room_id: 'room-2' })
      if (path.endsWith('/tbo/dot-3')) return Response.json({ id: 'dot-3', messaging_room_id: 'room-3' })
      if (path.endsWith('/room-2/messages')) return new Promise((resolve) => { finishOldHistory = resolve })
      if (path.endsWith('/room-3/messages')) return Response.json({ items: [{ id: 'latest', text: 'Latest' }] })
      return new Response('')
    })
    const first = dot.selectDotProfile(id, 'dot-2')
    const stale = expect(first).rejects.toThrow()
    await vi.waitFor(() => expect(finishOldHistory).toBeTypeOf('function'))
    const next = await dot.selectDotProfile(id, 'dot-3')
    finishOldHistory(Response.json({ items: [{ id: 'late', text: 'Late' }] }))
    await stale
    expect(dot.getStoredDotAccount(id)).toMatchObject({ activeDotId: 'dot-3', roomId: 'room-3', mode: 'native' })
    expect(next).toMatchObject({ dotId: 'dot-3', roomId: 'room-3', messages: [{ id: 'latest' }] })
  })

  it('leaves the active profile and mode unchanged when listing', async () => {
    transport.mockResolvedValueOnce(Response.json({ items: [{ id: 'other-dot', messaging_room_id: 'other-room' }] }))
    expect((await dot.listDots(id)).items).toHaveLength(1)
    expect(dot.getStoredDotAccount(id)).toMatchObject({ activeDotId: 'dot-1', roomId: 'room-1', mode: 'native' })
  })

  it('cancels a registered turn before the first room request', async () => {
    const send = dot.sendAndWatchDotRoomReply(id, { text: 'Test', turnId: 'turn' })
    const aborted = expect(send).rejects.toThrow('cancelled')
    await dot.cancelDotTurn(id, undefined, 'turn')
    await aborted
    expect(transport).not.toHaveBeenCalled()
  })
})
