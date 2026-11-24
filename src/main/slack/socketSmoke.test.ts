import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { registerSlackIpc, stopSlack } from './slackIpc'
import type { SlackRequest, SlackState } from '@shared/slack'

const mock = vi.hoisted(() => ({ path: '', endpoint: '', handle: vi.fn(), vault: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => mock.path }, ipcMain: { handle: mock.handle } }))
vi.mock('../securityVault', () => ({ getVaultSecret: () => null, setVaultSecret: mock.vault, deleteVaultSecret: vi.fn() }))
vi.mock('@slack/web-api', async (original) => {
  const lib = await original<typeof import('@slack/web-api')>()
  return { ...lib, WebClient: class extends lib.WebClient {
    constructor(token: string, opts: import('@slack/web-api').WebClientOptions) {
      super(token, { ...opts, slackApiUrl: mock.endpoint })
    }
  } }
})
vi.mock('@slack/socket-mode', async (original) => {
  const lib = await original<typeof import('@slack/socket-mode')>()
  return { ...lib, SocketModeClient: class extends lib.SocketModeClient {
    constructor(opts: { appToken: string; clientOptions: import('@slack/web-api').WebClientOptions }) {
      super({ ...opts, autoReconnectEnabled: false, clientOptions: { ...opts.clientOptions, slackApiUrl: mock.endpoint } })
    }
  } }
})
it('completes an actual Socket Mode hello, acknowledges an inbound mention and posts to its thread', async () => {
  mock.path = await mkdtemp(join(tmpdir(), 'slack-loopback-'))
  const posts: string[] = []
  let releasePost: (() => void) | undefined
  let releaseAuth: (() => void) | undefined
  let holdAuth = false
  const http = createServer(async (req, res) => {
    const parts = []
    for await (const chunk of req) parts.push(chunk)
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('auth.test')) {
      const reply = () => res.end(JSON.stringify({ ok: true, team_id: 'T1', user_id: 'UBOT' }))
      if (holdAuth) releaseAuth = reply
      else reply()
    }
    else if (req.url?.endsWith('apps.connections.open')) res.end(JSON.stringify({ ok: true, url: mock.endpoint.replace('http:', 'ws:') }))
    else if (req.url?.endsWith('chat.postMessage')) {
      posts.push(Buffer.concat(parts).toString())
      const reply = () => res.end(JSON.stringify({ ok: true, ts: '2.0' }))
      if (posts.length === 2) releasePost = reply
      else reply()
    } else { res.writeHead(404); res.end() }
  })
  const sockets = new WebSocketServer({ server: http })
  let peer!: WebSocket
  const acks: string[] = []
  sockets.on('connection', (ws) => {
    peer = ws
    ws.on('message', (raw) => { acks.push(JSON.parse(raw.toString()).envelope_id) })
    ws.send(JSON.stringify({ type: 'hello' }))
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const addr = http.address()
  if (!addr || typeof addr === 'string') throw new Error('listen failed')
  mock.endpoint = 'http://127.0.0.1:' + addr.port + '/'
  const sender = { mainFrame: {}, send: vi.fn() }
  registerSlackIpc(() => ({ webContents: sender, isDestroyed: () => false }) as unknown as BrowserWindow)
  const request = (r: SlackRequest): Promise<SlackState> => mock.handle.mock.calls[0]![1]({ sender, senderFrame: sender.mainFrame }, r)
  try {
    expect((await request({ op: 'connect', appToken: 'xapp-fixture', botToken: 'xoxb-fixture' })).connected).toBe(true)
    await request({ op: 'bind', roomId: 'room', channel: 'C1' })
    const envelope = { type: 'events_api', envelope_id: 'outer', payload: { team_id: 'T1',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '1.0', text: '<@UBOT> @Muse review' } } }
    peer.send(JSON.stringify(envelope))
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledOnce())
    const msg = sender.send.mock.calls[0]![1]
    expect(msg.text).toBe('@Muse review')
    peer.send(JSON.stringify({ ...envelope, envelope_id: 'retry-before-receipt' }))
    // Wait for the retry to pass the socket listener before acknowledging receipt.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sender.send).toHaveBeenCalledOnce()
    await request({ op: 'received', id: msg.id })
    await vi.waitFor(() => expect(acks).toEqual(['retry-before-receipt']))
    peer.send(JSON.stringify({ ...envelope, envelope_id: 'retry' }))
    await vi.waitFor(() => expect(acks).toEqual(['retry-before-receipt', 'retry']))
    expect(sender.send).toHaveBeenCalledOnce()
    await request({ op: 'post', roomId: 'room', text: '[Muse] Done' })
    expect(posts.join('')).toContain('1.0')
    expect(mock.vault).toHaveBeenCalledOnce()

    const multipart = request({ op: 'post', roomId: 'room', text: 'x'.repeat(12_001) }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(releasePost).toBeTypeOf('function'))
    await request({ op: 'unbind', roomId: 'room' })
    await request({ op: 'bind', roomId: 'room', channel: 'C1' })
    releasePost?.()
    expect(await multipart).toMatchObject({ message: expect.stringContaining('绑定已变更') })
    expect(posts).toHaveLength(2)
    const stale = { op: 'post', roomId: 'room', channel: msg.channel, thread: msg.thread,
      bindingGeneration: msg.bindingGeneration, text: 'old binding' } as const
    await expect(request(stale)).rejects.toThrow('绑定已变更')

    holdAuth = true
    const reconnect = request({ op: 'connect', appToken: 'xapp-fixture', botToken: 'xoxb-next' }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(releaseAuth).toBeTypeOf('function'))
    expect((await request({ op: 'disconnect' })).connected).toBe(false)
    releaseAuth?.()
    expect(await reconnect).toMatchObject({ message: expect.stringContaining('已取消') })
    expect(mock.vault).toHaveBeenCalledOnce()
  } finally {
    await stopSlack()
    for (const client of sockets.clients) client.terminate()
    sockets.close()
    http.closeAllConnections()
    await new Promise<void>((done) => http.close(() => done()))
    await rm(mock.path, { recursive: true, force: true })
  }
}, 20000)
