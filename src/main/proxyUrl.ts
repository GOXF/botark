/** Pure helpers for user-entered proxy URLs (no Electron/undici imports: testable). */

export type ProxyKind = 'http' | 'https' | 'socks'

/** `host:port` → `http://host:port`; preserves `https://` & explicit default ports; returns null for anything unusable. */
export function normalizeProxyUrl(raw: string | undefined | null): string | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  const withScheme = hasExplicitScheme ? text : `http://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  const kind = proxyKindOf(url.protocol)
  if (!url.hostname || !kind) return null

  const afterScheme = withScheme.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '')
  const hostPort = afterScheme.includes('@') ? afterScheme.slice(afterScheme.lastIndexOf('@') + 1) : afterScheme
  const explicitPortMatch = /:(\d+)$/.exec(hostPort)

  if (!hasExplicitScheme && !explicitPortMatch) return null
  if (kind === 'socks' && !url.port && !explicitPortMatch) return null
  if (kind === 'http' && !url.port && !explicitPortMatch) return null

  const rawPort = url.port || explicitPortMatch?.[1] || (kind === 'https' ? '443' : '')
  const portNum = Number(rawPort)
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null

  const auth =
    url.username && url.password
      ? `${url.username}:${url.password}@`
      : url.username
        ? `${url.username}@`
        : ''
  return `${url.protocol}//${auth}${url.hostname}:${portNum}`
}

function proxyKindOf(protocol: string): ProxyKind | null {
  switch (protocol) {
    case 'http:':
      return 'http'
    case 'https:':
      return 'https'
    case 'socks:':
    case 'socks5:':
    case 'socks5h:':
      return 'socks'
    default:
      return null
  }
}

export function proxyKind(normalizedUrl: string): ProxyKind | null {
  try {
    return proxyKindOf(new URL(normalizedUrl).protocol)
  } catch {
    return null
  }
}

/** undici only knows socks5://; the proxy resolves names either way. */
export function undiciProxyUrl(normalizedUrl: string): string {
  return normalizedUrl.replace(/^socks5h:\/\//i, 'socks5://').replace(/^socks:\/\//i, 'socks5://')
}

/** For saving user input: empty → undefined, invalid → throw (never store junk that later goes direct). */
export function requireValidProxyUrl(raw: string | undefined | null): string | undefined {
  if (!(raw ?? '').trim()) return undefined
  const url = normalizeProxyUrl(raw)
  if (!url) throw new Error('代理地址无效：需要 http://、https:// 或 socks5:// 加 主机:端口')
  return url
}

/** For socks-proxy-agent: socks5h so hostnames resolve on the proxy (no local DNS leak). */
export function remoteDnsProxyUrl(normalizedUrl: string): string {
  return normalizedUrl.replace(/^socks5?:\/\//i, 'socks5h://')
}
