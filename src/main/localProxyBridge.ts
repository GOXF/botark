import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import * as net from 'node:net'
import * as tls from 'node:tls'
import type { Duplex } from 'node:stream'
import { SocksClient } from 'socks'
import { proxyFetch, type ProxyTlsOptions } from './proxyTransport'

export interface UpstreamProxySpec {
  mode: 'http' | 'https' | 'socks5' | 'socks5h'
  host: string
  port: number
  username?: string
  password?: string
}

interface ActiveBridge {
  server: Server
  sockets: Set<net.Socket>
  localUrl: string
}

const activeBridges = new Map<string, Promise<ActiveBridge>>()

const CONNECT_TIMEOUT_MS = 20_000
const MAX_CONNECT_HEADER_BYTES = 16_384

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

function bridgeKey(cfg: UpstreamProxySpec, tlsOpts?: ProxyTlsOptions): string {
  const customTls = tlsOpts ? ':custom-tls' : ''
  return `${cfg.mode}://${encodeURIComponent(cfg.username ?? '')}:${encodeURIComponent(cfg.password ?? '')}@${cfg.host.toLowerCase()}:${cfg.port}${customTls}`
}

function buildUpstreamUrl(cfg: UpstreamProxySpec): string {
  const auth =
    cfg.username && cfg.password
      ? `${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@`
      : cfg.username
        ? `${encodeURIComponent(cfg.username)}@`
        : ''
  const host = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host
  return `${cfg.mode}://${auth}${host}:${cfg.port}`
}

function parseConnectTarget(rawTarget: string | undefined): { host: string; port: number } | null {
  const raw = (rawTarget ?? '').trim()
  if (!raw) return null
  if (raw.startsWith('[')) {
    const closeIdx = raw.indexOf(']')
    if (closeIdx <= 1) return null
    const host = raw.slice(1, closeIdx)
    const rest = raw.slice(closeIdx + 1)
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : 443
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
    return { host, port }
  }
  const colonIdx = raw.lastIndexOf(':')
  if (colonIdx <= 0) {
    return { host: raw, port: 443 }
  }
  const host = raw.slice(0, colonIdx).trim()
  const port = Number(raw.slice(colonIdx + 1))
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port }
}

function connectViaHttpOrHttpsUpstream(
  cfg: UpstreamProxySpec,
  target: { host: string; port: number },
  tlsOpts?: ProxyTlsOptions
): Promise<{ socket: net.Socket | tls.TLSSocket; extraHead: Buffer }> {
  return new Promise((resolve, reject) => {
    const proxyHost = cfg.host.replace(/^\[|\]$/g, '')
    const socket: net.Socket | tls.TLSSocket =
      cfg.mode === 'https'
        ? tls.connect({
            host: proxyHost,
            port: cfg.port,
            ALPNProtocols: ['http/1.1'],
            ...(net.isIP(proxyHost) ? {} : { servername: proxyHost }),
            ...(tlsOpts ?? {})
          })
        : net.connect({
            host: proxyHost,
            port: cfg.port
          })

    let settled = false
    let headerBuf = Buffer.alloc(0)

    const timer = setTimeout(() => {
      fail(new Error('Upstream proxy CONNECT timed out'))
    }, CONNECT_TIMEOUT_MS)

    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onCloseBeforeTunnel)
    }

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(err)
    }

    const onError = (err: Error): void => fail(err)
    const onCloseBeforeTunnel = (): void => fail(new Error('Upstream proxy closed before CONNECT response'))

    const onData = (chunk: Buffer): void => {
      headerBuf = Buffer.concat([headerBuf, chunk])
      const endIdx = headerBuf.indexOf('\r\n\r\n')
      if (endIdx < 0) {
        if (headerBuf.length > MAX_CONNECT_HEADER_BYTES) {
          fail(new Error('Upstream proxy CONNECT response header too large'))
        }
        return
      }
      const headerText = headerBuf.subarray(0, endIdx).toString('latin1')
      const firstLine = headerText.split('\r\n')[0] ?? ''
      const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})\b/i.exec(firstLine)
      const status = statusMatch ? Number(statusMatch[1]) : 0
      if (status !== 200) {
        fail(new Error(`Upstream proxy rejected CONNECT with HTTP ${status || 'invalid'}`))
        return
      }
      const extraHead = headerBuf.subarray(endIdx + 4)
      settled = true
      cleanup()
      resolve({ socket, extraHead })
    }

    socket.once('error', onError)
    socket.once('close', onCloseBeforeTunnel)

    const sendConnect = (): void => {
      socket.on('data', onData)
      const authority = net.isIPv6(target.host) ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`
      let payload = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: keep-alive\r\n`
      if (cfg.username || cfg.password) {
        const auth = Buffer.from(`${cfg.username ?? ''}:${cfg.password ?? ''}`, 'utf8').toString('base64')
        payload += `Proxy-Authorization: Basic ${auth}\r\n`
      }
      payload += '\r\n'
      socket.write(payload)
    }

    if (cfg.mode === 'https') {
      ;(socket as tls.TLSSocket).once('secureConnect', sendConnect)
    } else {
      socket.once('connect', sendConnect)
    }
  })
}

async function handleConnect(
  cfg: UpstreamProxySpec,
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  tlsOpts?: ProxyTlsOptions
): Promise<void> {
  clientSocket.on('error', () => {
    /* ignore abrupt client resets */
  })
  const target = parseConnectTarget(req.url)
  if (!target) {
    if (clientSocket.writable) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    } else {
      clientSocket.destroy()
    }
    return
  }

  try {
    let upstream: net.Socket | tls.TLSSocket
    let extraHead: Buffer = Buffer.alloc(0)

    if (cfg.mode === 'socks5' || cfg.mode === 'socks5h') {
      const proxyHost = cfg.host.replace(/^\[|\]$/g, '')
      const res = await SocksClient.createConnection({
        proxy: {
          host: proxyHost,
          port: cfg.port,
          type: 5,
          ...(cfg.username ? { userId: cfg.username, password: cfg.password ?? '' } : {})
        },
        command: 'connect',
        destination: { host: target.host, port: target.port },
        timeout: CONNECT_TIMEOUT_MS
      })
      upstream = res.socket
    } else {
      const res = await connectViaHttpOrHttpsUpstream(cfg, target, tlsOpts)
      upstream = res.socket
      extraHead = res.extraHead
    }

    if (clientSocket.destroyed) {
      upstream.destroy()
      return
    }

    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (extraHead.length > 0) clientSocket.write(extraHead)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  } catch {
    if (!clientSocket.destroyed && clientSocket.writable) {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    } else {
      clientSocket.destroy()
    }
  }
}

async function handleHttpForward(
  upstreamUrl: string,
  req: IncomingMessage,
  res: ServerResponse,
  tlsOpts?: ProxyTlsOptions
): Promise<void> {
  const targetUrl = req.url ?? ''
  if (!/^https?:\/\//i.test(targetUrl)) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Bad proxy request')
    return
  }

  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || v == null) continue
    headers[k] = Array.isArray(v) ? v.join(', ') : v
  }

  const method = (req.method ?? 'GET').toUpperCase()
  let body: Buffer | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    if (chunks.length > 0) body = Buffer.concat(chunks)
  }

  try {
    const upstreamRes = await proxyFetch(
      upstreamUrl,
      targetUrl,
      {
        method,
        headers,
        body: body ? new Uint8Array(body) : undefined,
        redirect: 'manual'
      },
      tlsOpts ? { proxyTls: tlsOpts } : undefined
    )

    const outHeaders: Record<string, string> = {}
    upstreamRes.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        outHeaders[key] = value
      }
    })
    res.writeHead(upstreamRes.status, outHeaders)
    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) res.write(Buffer.from(value))
      }
    }
    res.end()
  } catch {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    }
    res.end('Upstream proxy request failed')
  }
}

/**
 * Start (or reuse) a loopback-only `http://127.0.0.1:<port>` proxy server that
 * tunnels Chromium partition traffic through an upstream `https://` TLS proxy
 * or any authenticated (`username`/`password`) `http`/`https`/`socks5`/`socks5h` proxy.
 */
export async function ensureLocalProxyBridge(
  cfg: UpstreamProxySpec,
  tlsOpts?: ProxyTlsOptions
): Promise<string> {
  const key = bridgeKey(cfg, tlsOpts)
  let pending = activeBridges.get(key)
  if (!pending) {
    pending = new Promise<ActiveBridge>((resolve, reject) => {
      const upstreamUrl = buildUpstreamUrl(cfg)
      const sockets = new Set<net.Socket>()
      const server = createServer((req, res) => {
        void handleHttpForward(upstreamUrl, req, res, tlsOpts)
      })
      server.on('connection', (sock) => {
        sockets.add(sock)
        sock.once('close', () => sockets.delete(sock))
      })
      server.on('connect', (req, clientSocket, head) => {
        void handleConnect(cfg, req, clientSocket, head, tlsOpts)
      })
      server.once('error', (err) => {
        activeBridges.delete(key)
        reject(err)
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') {
          server.close()
          activeBridges.delete(key)
          reject(new Error('Failed to bind local proxy bridge'))
          return
        }
        server.unref()
        resolve({ server, sockets, localUrl: `http://127.0.0.1:${addr.port}` })
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
  await Promise.all(
    entries.map(async (p) => {
      try {
        const b = await p
        for (const sock of b.sockets) sock.destroy()
        b.server.closeAllConnections?.()
        await new Promise<void>((resolve) => b.server.close(() => resolve()))
      } catch {
        /* ignore */
      }
    })
  )
}
