import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { PassThrough, type Duplex } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { SocksClient } from 'socks'
import { closeProxyDispatchers, closeProxySocket, proxyRequest, resolveTlsPolicy, type ProxyTlsOptions } from './proxyTransport'
import { normalizeProxyUrl, unbracketProxyHost } from './proxyUrl'

export interface UpstreamProxySpec {
  mode: 'http' | 'https' | 'socks5' | 'socks5h'
  host: string
  port: number
  username?: string
  password?: string
}

interface ActiveBridge {
  server: Server
  sockets: Set<Duplex>
  requests: Set<Promise<void>>
  localUrl: string
}

interface ConnectTarget {
  host: string
  port: number
}

const activeBridges = new Map<string, Promise<ActiveBridge>>()

const CONNECT_TIMEOUT_MS = 20_000
const MAX_CONNECT_HEADER_BYTES = 16_384

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authentication-info',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

function buildUpstreamUrl(cfg: UpstreamProxySpec): string {
  if (cfg.password && !cfg.username) throw new Error('Proxy password requires a username')
  const auth = cfg.username
    ? `${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password ?? '')}@`
    : ''
  const host = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host
  const url = normalizeProxyUrl(`${cfg.mode}://${auth}${host}:${cfg.port}`)
  if (!url) throw new Error('Invalid upstream proxy configuration')
  return url
}

function parseConnectTarget(rawTarget: string | undefined): ConnectTarget | null {
  const raw = (rawTarget ?? '').trim()
  const match = /^(\[[^\]]+\]|[^:\s/?#@]+)(?::([0-9]+))?$/.exec(raw)
  if (!match) return null
  const host = unbracketProxyHost(match[1]!)
  if (match[1]!.startsWith('[') && !net.isIPv6(host)) return null
  const port = Number(match[2] ?? 443)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

function trackSocket(sockets: Set<Duplex>, socket: Duplex): void {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
  // Socket errors can arrive between handshake and tunnel handlers.
  socket.on('error', () => socket.destroy())
}

function trackRequest(requests: Set<Promise<void>>, request: Promise<void>): void {
  requests.add(request)
  void request.then(
    () => { requests.delete(request) },
    (error: unknown) => {
      requests.delete(request)
      console.warn('[proxy] local bridge request failed', error instanceof Error ? error.name : 'UnknownError')
    }
  )
}

function waitForConnect(
  socket: net.Socket,
  event: 'connect' | 'secureConnect',
  negotiate: () => Promise<Buffer>
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => socket.destroy(new Error('Upstream proxy CONNECT timed out')), CONNECT_TIMEOUT_MS)
    timeout.unref()

    const cleanup = (): void => {
      clearTimeout(timeout)
      socket.off(event, start)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onClose = (): void => onError(new Error('Upstream proxy closed before CONNECT response'))
    const start = (): void => {
      void negotiate().then((head) => {
        cleanup()
        resolve(head)
      }, onError)
    }
    socket.once(event, start)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

function negotiateHttpConnect(
  socket: net.Socket,
  cfg: UpstreamProxySpec,
  target: ConnectTarget
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let header = Buffer.alloc(0)
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('close', onClose)
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('Upstream proxy closed before CONNECT response'))
    }
    const onData = (chunk: Buffer): void => {
      header = Buffer.concat([header, chunk])
      const end = header.indexOf('\r\n\r\n')
      if ((end < 0 ? header.length : end + 4) > MAX_CONNECT_HEADER_BYTES) {
        cleanup()
        reject(new Error('Upstream proxy CONNECT response header too large'))
        return
      }
      if (end < 0) return

      socket.pause()
      cleanup()
      const status = /^HTTP\/1\.[01]\s+(\d{3})\b/.exec(header.toString('latin1', 0, end))
      if (status?.[1] !== '200') {
        reject(new Error(`Upstream proxy rejected CONNECT with HTTP ${status?.[1] ?? 'invalid'}`))
        return
      }
      resolve(header.subarray(end + 4))
    }

    const authority = net.isIPv6(target.host) ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`
    const auth = cfg.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${cfg.username}:${cfg.password ?? ''}`).toString('base64')}\r\n`
      : ''
    socket.on('data', onData)
    socket.once('close', onClose)
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`)
  })
}

async function handleConnect(
  cfg: UpstreamProxySpec,
  sockets: Set<Duplex>,
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
  tlsOpts?: ProxyTlsOptions
): Promise<void> {
  const target = parseConnectTarget(req.url)
  if (!target) {
    client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    return
  }

  let upstream: net.Socket | undefined
  try {
    const host = unbracketProxyHost(cfg.host)
    const secure = cfg.mode === 'https'
    const socket = secure
      ? tls.connect({
          ...tlsOpts,
          host,
          port: cfg.port,
          ALPNProtocols: ['http/1.1'],
          ...(net.isIP(host) ? {} : { servername: host })
        })
      : net.connect({ host, port: cfg.port })
    upstream = socket
    trackSocket(sockets, socket)
    const closeUpstream = (): void => { client.destroy(); socket.destroy() }
    client.once('close', closeUpstream)
    client.once('error', closeUpstream)
    client.once('end', closeUpstream)

    const extraHead = await waitForConnect(socket, secure ? 'secureConnect' : 'connect', () =>
      cfg.mode === 'socks5' || cfg.mode === 'socks5h'
        ? SocksClient.createConnection({
            proxy: { host, port: cfg.port, type: 5, userId: cfg.username, password: cfg.password },
            command: 'connect',
            destination: target,
            existing_socket: socket,
            timeout: CONNECT_TIMEOUT_MS
          }).then(() => Buffer.alloc(0))
        : negotiateHttpConnect(socket, cfg, target)
    )
    if (client.destroyed || socket.destroyed) {
      closeUpstream()
      return
    }

    socket.once('close', () => {
      if (!socket.readableEnded) client.destroy()
    })
    socket.once('error', closeUpstream)
    // Flush the last tunneled bytes when the upstream sends FIN.
    socket.once('end', () => client.end(() => client.destroy()))

    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (extraHead.length) client.write(extraHead)
    if (head.length) socket.write(head)
    socket.pipe(client, { end: false })
    client.pipe(socket, { end: false })
  } catch {
    upstream?.destroy()
    if (!client.destroyed && client.writable) {
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    } else {
      client.destroy()
    }
  }
}

function endToEndHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string | string[]> {
  const connection = headers['connection'] ?? []
  const tokens = (Array.isArray(connection) ? connection.join(',') : connection)
    .toLowerCase().split(',').map((token) => token.trim())
  const forwarded: Record<string, string | string[]> = Object.create(null)
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(key) && !tokens.includes(key)) {
      forwarded[key] = value
    }
  }
  return forwarded
}

async function handleHttpForward(
  upstreamUrl: string,
  req: IncomingMessage,
  res: ServerResponse,
  tlsOpts?: ProxyTlsOptions
): Promise<void> {
  const targetUrl = req.url ?? ''
  if (!/^https?:\/\//i.test(targetUrl)) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
    res.end('Bad proxy request')
    return
  }

  const controller = new AbortController()
  let upload: PassThrough | undefined
  let download: Awaited<ReturnType<typeof proxyRequest>>['body'] | undefined
  const abort = (): void => {
    controller.abort()
    upload?.destroy()
  }
  const onRequestClose = (): void => {
    if (!req.complete) abort()
  }
  const onClose = (): void => {
    if (!res.writableFinished) abort()
  }
  req.once('error', abort)
  req.once('close', onRequestClose)
  res.once('close', onClose)

  try {
    if (req.destroyed || res.destroyed) return
    const headers = endToEndHeaders(req.headers)
    // Node answers Expect: 100-continue itself. Undici does not accept it.
    delete headers['expect']
    for (const [name, values] of Object.entries(req.headersDistinct)) {
      if (Object.hasOwn(headers, name) && values && values.length > 1 && name !== 'cookie') {
        headers[name] = values
      }
    }

    const hasBody = Boolean(req.headers['transfer-encoding'] || Number(req.headers['content-length']))
    // A separate readable lets Undici cancel an incomplete upload without
    // destroying the client socket before we can send the final response.
    if (hasBody) upload = req.pipe(new PassThrough())
    const response = await proxyRequest(upstreamUrl, targetUrl, {
      method: req.method ?? 'GET',
      headers,
      body: upload,
      signal: controller.signal
    }, tlsOpts)

    download = response.body
    const responseHeaders = endToEndHeaders(response.headers)
    if (hasBody && !req.readableEnded) responseHeaders['connection'] = 'close'
    // The request API preserves Content-Encoding, Content-Length and header
    // arrays because it streams the original upstream bytes.
    res.writeHead(response.statusCode, responseHeaders)
    await pipeline(download, res, { signal: controller.signal })
  } catch {
    if (res.destroyed || controller.signal.aborted) return
    if (res.headersSent) {
      res.destroy()
    } else {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
      res.end('Upstream proxy request failed')
    }
  } finally {
    if (upload) {
      req.unpipe(upload)
      upload.destroy()
    }
    download?.destroy()
    controller.abort()
    req.off('error', abort)
    req.off('close', onRequestClose)
    res.off('close', onClose)
  }
}

/**
 * Start (or reuse) a loopback-only HTTP proxy for a Chromium partition that
 * requires an HTTPS or authenticated upstream proxy.
 */
export async function ensureLocalProxyBridge(
  cfg: UpstreamProxySpec,
  tlsOpts?: ProxyTlsOptions
): Promise<string> {
  const settings = { ...cfg }
  const upstreamUrl = buildUpstreamUrl(settings)
  settings.host = new URL(upstreamUrl).hostname
  const tlsPolicy = resolveTlsPolicy(tlsOpts)
  const key = JSON.stringify([upstreamUrl, tlsPolicy.key])
  let pending = activeBridges.get(key)
  if (!pending) {
    pending = new Promise<ActiveBridge>((resolve, reject) => {
      const sockets = new Set<Duplex>()
      const requests = new Set<Promise<void>>()
      const server = createServer((req, res) => {
        trackRequest(requests, handleHttpForward(upstreamUrl, req, res, tlsPolicy.options))
      })
      server.on('connection', (socket) => trackSocket(sockets, socket))
      server.on('connect', (req, client, head) => {
        trackRequest(requests, handleConnect(settings, sockets, req, client, head, tlsPolicy.options))
      })
      server.on('error', (error) => {
        if (activeBridges.get(key) === pending) activeBridges.delete(key)
        for (const socket of sockets) socket.destroy()
        if (server.listening) server.close()
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') {
          server.close()
          if (activeBridges.get(key) === pending) activeBridges.delete(key)
          reject(new Error('Failed to bind local proxy bridge'))
          return
        }
        server.unref()
        resolve({ server, sockets, requests, localUrl: `http://127.0.0.1:${addr.port}` })
      })
    })
    activeBridges.set(key, pending)
  }
  const bridge = await pending
  return bridge.localUrl
}

export async function closeAllLocalProxyBridges(): Promise<void> {
  const entries = [...activeBridges.values()]
  activeBridges.clear()
  const closing = entries.map(async (entry) => {
    const { server, sockets, requests } = await entry
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    const socketClosures = [...sockets].map(closeProxySocket)
    await Promise.allSettled([closed, ...socketClosures, ...requests])
  })
  // Let already-listening bridges stop accepting before retiring their transport.
  await Promise.resolve()
  await Promise.allSettled([...closing, closeProxyDispatchers()])
}
