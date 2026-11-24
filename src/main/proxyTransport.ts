import { createHash } from 'node:crypto'
import type { Agent } from 'node:http'
import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import * as electron from 'electron'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { buildConnector, fetch as undiciFetch, Pool, ProxyAgent, request, Socks5ProxyAgent, type Dispatcher } from 'undici'
import {
  normalizeProxyUrl,
  proxyKind,
  remoteDnsProxyUrl,
  unbracketProxyHost,
  undiciProxyUrl,
  type ProxyKind
} from './proxyUrl'

/**
 * Node-side requests (fetch / ws) through a per-account proxy URL.
 * A configured but unusable proxy throws instead of silently going direct.
 * When no per-account proxy is configured, prefers Electron's Chromium `net.fetch`
 * so OS-level system proxies (e.g. macOS Clash / Surge) are automatically honored.
 */
const MAX_CACHED_DISPATCHERS = 32
const dispatchers = new Map<string, ProxyDispatcher>()
const retiredDispatchers = new Map<ProxyDispatcher, Promise<void>>()

/** Account chose 真直连: plain Node networking, neither a proxy nor the OS system proxy. */
export const DIRECT_PROXY_URL = 'direct://'

export interface ProxyTlsOptions {
  ca?: string | Buffer | Array<string | Buffer>
  rejectUnauthorized?: boolean
}

interface TransportTlsOptions {
  proxyTls?: ProxyTlsOptions
  requestTls?: ProxyTlsOptions
}

interface ProxyDispatcher {
  dispatcher: Dispatcher
  sockets: Set<Socket>
}

type ProxyRequestOptions = Omit<NonNullable<Parameters<typeof request>[1]>, 'dispatcher'>

type ResolvedTlsOptions = ProxyTlsOptions & { rejectUnauthorized: boolean }

export function resolveTlsPolicy(options?: ProxyTlsOptions): { options: ResolvedTlsOptions; key: string } {
  const rejectUnauthorized = options?.rejectUnauthorized ?? (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0')
  const ca = options?.ca
  const certificates = ca === undefined ? undefined : [ca].flat().map((cert) =>
    Buffer.isBuffer(cert) ? Buffer.from(cert) : cert
  )
  const fingerprints = certificates?.map((cert) => createHash('sha256').update(cert).digest('hex')) ?? null
  return { options: { ca: certificates, rejectUnauthorized }, key: JSON.stringify([rejectUnauthorized, fingerprints]) }
}

function requireProxy(raw: string): { url: string; kind: ProxyKind } {
  const url = normalizeProxyUrl(raw)
  const kind = url ? proxyKind(url) : null
  if (!url || !kind) throw new Error('代理地址无效，已拒绝直连发送（请检查账号的代理设置）')
  return { url, kind }
}

function buildDispatcher(url: string, kind: ProxyKind, tlsOptions?: TransportTlsOptions): ProxyDispatcher {
  const sockets = new Set<Socket>()
  const trackConnector = (connect: buildConnector.connector): buildConnector.connector => (options, callback) => {
    const hostname = unbracketProxyHost(options.hostname)
    // The TCP/TLS connector returns its socket synchronously. An async
    // CONNECT connector leaves ownership with the tracked socket to the proxy.
    const socket: unknown = connect({ ...options, hostname }, callback)
    if (socket instanceof Socket) {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    }
  }
  let dispatcher: Dispatcher
  if (kind === 'socks') {
    dispatcher = new Socks5ProxyAgent(undiciProxyUrl(url), {
      requestTls: tlsOptions?.requestTls,
      connect: trackConnector(buildConnector({ timeout: 5_000 }))
    })
  } else {
    // Force HTTP/1.1 ALPN to the HTTPS proxy itself so HTTP CONNECT tunneling
    // never hangs against TLS proxies that also advertise HTTP/2 in ALPN.
    const pool = (origin: URL | string, options: object): Pool => {
      const { connect } = options as { connect: buildConnector.connector }
      return new Pool(origin, { ...options, connect: trackConnector(connect) })
    }
    dispatcher = new ProxyAgent({
      uri: url,
      proxyTls: kind === 'https' ? { ...tlsOptions?.proxyTls, allowH2: false } : undefined,
      requestTls: tlsOptions?.requestTls,
      clientFactory: pool,
      factory: pool
    })
  }
  return { dispatcher, sockets }
}

function dispatcherFor(raw: string, tlsOptions?: TransportTlsOptions): Dispatcher {
  const { url, kind } = requireProxy(raw)
  const proxyTls = kind === 'https' ? resolveTlsPolicy(tlsOptions?.proxyTls) : undefined
  const requestTls = resolveTlsPolicy(tlsOptions?.requestTls)
  const key = JSON.stringify([url, proxyTls?.key, requestTls.key])
  let entry = dispatchers.get(key)
  if (entry) {
    dispatchers.delete(key)
  } else {
    entry = buildDispatcher(url, kind, { proxyTls: proxyTls?.options, requestTls: requestTls.options })
  }
  dispatchers.set(key, entry)

  if (dispatchers.size > MAX_CACHED_DISPATCHERS) {
    const oldest = dispatchers.entries().next().value
    if (oldest) {
      const [retiredKey, retired] = oldest
      dispatchers.delete(retiredKey)
      const done = retired.dispatcher.close().catch(() => retired.dispatcher.destroy()).catch(() => undefined)
        .finally(() => { retiredDispatchers.delete(retired) })
      retiredDispatchers.set(retired, done)
    }
  }
  return entry.dispatcher
}

export async function closeProxyDispatchers(): Promise<void> {
  const entries = [...dispatchers.values(), ...retiredDispatchers.keys()]
  const closing = [...retiredDispatchers.values()]
  dispatchers.clear()
  await Promise.allSettled([
    ...closing,
    ...entries.map(async ({ dispatcher, sockets }) => {
      const destroyed = dispatcher.destroy()
      const socketClosures = [...sockets].map(closeProxySocket)
      await Promise.all([destroyed, ...socketClosures])
    })
  ])
}

export function closeProxySocket(socket: Duplex): Promise<void> {
  return new Promise((resolve) => {
    if (socket.closed) {
      resolve()
      return
    }
    socket.once('close', resolve)
    socket.destroy()
  })
}

function systemAwareFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    if (
      electron?.app &&
      typeof electron.app.isReady === 'function' &&
      electron.app.isReady() &&
      electron.net &&
      typeof electron.net.fetch === 'function'
    ) {
      return electron.net.fetch(input, init as never) as unknown as Promise<Response>
    }
  } catch {
    /* fallback to global fetch in plain Node / unit tests */
  }
  return fetch(input, init)
}

export function proxyFetch(
  proxyUrl: string | undefined,
  input: string,
  init?: RequestInit,
  tlsOpts?: TransportTlsOptions
): Promise<Response> {
  if (!proxyUrl?.trim()) return systemAwareFetch(input, init)
  if (proxyUrl === DIRECT_PROXY_URL) return undiciFetch(input, init as never) as unknown as Promise<Response>
  const dispatcher = dispatcherFor(proxyUrl, tlsOpts)
  return undiciFetch(input, { ...(init as object), dispatcher } as never) as unknown as Promise<Response>
}

/** Forward an HTTP exchange with its original encoding and repeated headers. */
export function proxyRequest(
  proxyUrl: string,
  input: string,
  options: ProxyRequestOptions,
  proxyTls?: ProxyTlsOptions
): ReturnType<typeof request> {
  return request(input, { ...options, dispatcher: dispatcherFor(proxyUrl, { proxyTls }) })
}

export function proxyWsAgent(proxyUrl: string | undefined, tlsOpts?: ProxyTlsOptions): Agent | undefined {
  if (!proxyUrl?.trim() || proxyUrl === DIRECT_PROXY_URL) return undefined
  const { url, kind } = requireProxy(proxyUrl)
  if (kind === 'http' || kind === 'https') {
    return new HttpsProxyAgent(url, tlsOpts) as unknown as Agent
  }
  const agent = new SocksProxyAgent(remoteDnsProxyUrl(url))
  if (agent.proxy.host) agent.proxy.host = unbracketProxyHost(agent.proxy.host)
  return agent as unknown as Agent
}
