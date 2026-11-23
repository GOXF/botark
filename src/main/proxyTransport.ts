import type { Agent } from 'node:http'
import * as electron from 'electron'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { fetch as undiciFetch, ProxyAgent, Socks5ProxyAgent, type Dispatcher } from 'undici'
import { normalizeProxyUrl, proxyKind, remoteDnsProxyUrl, undiciProxyUrl, type ProxyKind } from './proxyUrl'

/**
 * Node-side requests (fetch / ws) through a per-account proxy URL.
 * A configured but unusable proxy throws instead of silently going direct.
 * When no per-account proxy is configured, prefers Electron's Chromium `net.fetch`
 * so OS-level system proxies (e.g. macOS Clash / Surge) are automatically honored.
 */
const dispatchers = new Map<string, Dispatcher>()

export interface ProxyTlsOptions {
  ca?: string | Buffer | Array<string | Buffer>
  rejectUnauthorized?: boolean
}

function requireProxy(raw: string): { url: string; kind: ProxyKind } {
  const url = normalizeProxyUrl(raw)
  const kind = url ? proxyKind(url) : null
  if (!url || !kind) throw new Error('代理地址无效，已拒绝直连发送（请检查账号的代理设置）')
  return { url, kind }
}

function buildDispatcher(url: string, kind: ProxyKind, tlsOpts?: { proxyTls?: ProxyTlsOptions; requestTls?: ProxyTlsOptions }): Dispatcher {
  if (kind === 'https') {
    // Force HTTP/1.1 ALPN to the HTTPS proxy itself so HTTP CONNECT tunneling
    // never hangs against TLS proxies that also advertise HTTP/2 in ALPN.
    return new ProxyAgent({
      uri: url,
      proxyTls: { allowH2: false, ...(tlsOpts?.proxyTls ?? {}) },
      ...(tlsOpts?.requestTls ? { requestTls: tlsOpts.requestTls } : {})
    })
  }
  if (kind === 'http') {
    return tlsOpts?.requestTls ? new ProxyAgent({ uri: url, requestTls: tlsOpts.requestTls }) : new ProxyAgent(url)
  }
  return new Socks5ProxyAgent(undiciProxyUrl(url), tlsOpts?.requestTls ? { requestTls: tlsOpts.requestTls } : undefined)
}

function dispatcherFor(raw: string): Dispatcher {
  const { url, kind } = requireProxy(raw)
  let d = dispatchers.get(url)
  if (!d) {
    d = buildDispatcher(url, kind)
    dispatchers.set(url, d)
  }
  return d
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
  tlsOpts?: { proxyTls?: ProxyTlsOptions; requestTls?: ProxyTlsOptions }
): Promise<Response> {
  if (!proxyUrl?.trim()) return systemAwareFetch(input, init)
  const dispatcher = tlsOpts
    ? (() => {
        const { url, kind } = requireProxy(proxyUrl)
        return buildDispatcher(url, kind, tlsOpts)
      })()
    : dispatcherFor(proxyUrl)
  return undiciFetch(input, { ...(init as object), dispatcher } as never) as unknown as Promise<Response>
}

export function proxyWsAgent(proxyUrl: string | undefined, tlsOpts?: ProxyTlsOptions): Agent | undefined {
  if (!proxyUrl?.trim()) return undefined
  const { url, kind } = requireProxy(proxyUrl)
  if (kind === 'http' || kind === 'https') {
    return new HttpsProxyAgent(url, tlsOpts) as unknown as Agent
  }
  return new SocksProxyAgent(remoteDnsProxyUrl(url)) as unknown as Agent
}
