import { session as electronSession, type Cookie, type CookiesSetDetails } from 'electron'
import { createMutex } from '@shared/proxyPool'
import { partitionForAccount } from '../webContentsViewManager'
import { ANTIGRAVITY_AUTH_USER_HOST, probeAntigravitySession } from './antigravityClient'
import {
  ANTIGRAVITY_COOKIE_ORIGINS,
  ANTIGRAVITY_ORIGIN,
  antigravityAuthUserFromUrl,
  isAntigravitySigningCookie,
  parseAntigravityAuthUser,
  type AntigravityUserProfile
} from './antigravityProtocol'

const antigravityHost = new URL(ANTIGRAVITY_ORIGIN).hostname
const cookieHosts = ANTIGRAVITY_COOKIE_ORIGINS.map((origin) => new URL(origin).hostname)
const cookieNamePattern = /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/
const cookieValuePattern = /^[\x20-\x3a\x3c-\x7e]*$/
const invalidInput = '请粘贴 Antigravity 的 Cookie 请求标头、Copy as cURL 命令或 Cookie JSON。'

interface CookieInput {
  name: string
  value: string
  domain?: unknown
  path?: unknown
  secure?: unknown
  httpOnly?: unknown
  hostOnly?: unknown
  sameSite?: unknown
  expirationDate?: unknown
  session?: unknown
}

export class AntigravityCredentialError extends Error {}

function isCookieDomain(host: string): boolean {
  return (host === 'google.com' || host.endsWith('.google.com')) &&
    cookieHosts.some((cookieHost) => cookieHost === host || cookieHost.endsWith('.' + host))
}

function cookieUrl(host: string, path: string): string {
  const url = new URL('https://' + host)
  url.pathname = path
  return url.href
}

function parseCookieHeader(header: string): CookieInput[] {
  return header.replace(/^Cookie:[ \t]*/i, '').split(';').flatMap((pair) => {
    const delimiter = pair.indexOf('=')
    if (delimiter < 1) return []
    return [{ name: pair.slice(0, delimiter).trim(), value: pair.slice(delimiter + 1).trim() }]
  })
}

function splitCurlArguments(source: string): string[] {
  // DevTools wraps Windows arguments in ^" and uses ^ for metacharacters
  // and line continuations. Parse the copied text without invoking a shell.
  const isCmd = /\^["\r\n]/.test(source) || /^curl\.exe[ \t]+"/i.test(source)
  const command = isCmd
    ? source.replace(/\^(?:\r?\n|([^\r\n]))/g, (_match, char?: string) => char ?? '')
    : source.replace(/\\\r?\n/g, '')
  const parts = isCmd
    ? /"((?:[^"]|"")*)"|[^\s"]+/g
    : /\$'((?:[^'\\]|\\.)*)'|'([^']*)'|"((?:[^"\\]|\\.)*)"|(\\.)|[^\s'"\\]+/g

  const args: string[] = []
  let end = -1
  for (const match of command.matchAll(parts)) {
    const [text, escaped, singleQuoted, doubleQuoted, bareEscape] = match
    let value = text
    if (isCmd && escaped !== undefined) {
      value = escaped.replace(/""/g, '"').replace(/\\\\/g, '\\')
    } else if (!isCmd) {
      value = singleQuoted ?? doubleQuoted?.replace(/\\(["\\$])/g, '$1') ?? bareEscape?.slice(1) ?? text
      if (escaped !== undefined) {
        value = escaped.replace(/\\(?:u([0-9a-f]{4})|([\\'nr]))/gi, (_match, hex?: string, char?: string) =>
          hex ? String.fromCharCode(Number.parseInt(hex, 16)) : char === 'n' ? '\n' : char === 'r' ? '\r' : char ?? ''
        )
      }
    }
    if (match.index === end) args[args.length - 1] += value
    else args.push(value)
    end = match.index + text.length
  }
  return args
}

function parseCurl(input: string): { cookies: CookieInput[]; authUser?: string; host: string } {
  const args = splitCurlArguments(input).slice(1)
  const cookies: CookieInput[] = []
  let target = ''
  let authUser: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (/^https?:\/\//i.test(arg)) {
      target ||= arg
      continue
    }
    const equals = arg.indexOf('=')
    const option = equals < 0 ? arg : arg.slice(0, equals)
    const takesValue = /^(?:-H|--header|-b|--cookie|--url|-X|--request|-A|--user-agent|-e|--referer|-d|--data(?:-raw|-binary|-ascii|-urlencode)?)$/
    if (!takesValue.test(option)) continue
    const value = equals < 0 ? args[++i] ?? '' : arg.slice(equals + 1)
    const isHeader = option === '-H' || option === '--header'
    if (option === '--url') target = value
    else if (option === '-b' || option === '--cookie' || (isHeader && /^Cookie:/i.test(value))) {
      cookies.push(...parseCookieHeader(value))
    } else if (isHeader && /^X-Goog-AuthUser:/i.test(value)) {
      authUser = parseAntigravityAuthUser(value.slice(value.indexOf(':') + 1).trim())
    }
  }

  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new AntigravityCredentialError(invalidInput)
  }
  if (!ANTIGRAVITY_COOKIE_ORIGINS.some((origin) => origin === url.origin)) {
    throw new AntigravityCredentialError('请从 Antigravity 或其 Google 请求复制 cURL。')
  }
  return { cookies, authUser: authUser ?? antigravityAuthUserFromUrl(url.href), host: url.hostname }
}

function parseCookieJson(input: string): { cookies: CookieInput[]; hasMetadata: boolean } {
  let raw: unknown
  try {
    raw = JSON.parse(input)
  } catch {
    throw new AntigravityCredentialError('Cookie JSON 格式无效。')
  }
  if (Array.isArray(raw)) {
    const cookies = raw.filter((cookie): cookie is CookieInput =>
      Boolean(cookie && typeof cookie === 'object' && typeof cookie.name === 'string' && typeof cookie.value === 'string')
    )
    return { cookies, hasMetadata: true }
  }
  if (!raw || typeof raw !== 'object') throw new AntigravityCredentialError(invalidInput)
  if ('cookieHeader' in raw && typeof raw.cookieHeader === 'string') {
    return { cookies: parseCookieHeader(raw.cookieHeader), hasMetadata: false }
  }
  const cookies = Object.entries(raw).flatMap(([name, value]) =>
    typeof value === 'string' ? [{ name, value }] : []
  )
  return { cookies, hasMetadata: false }
}

function cookieIdentity(cookie: CookiesSetDetails): string {
  return JSON.stringify([cookie.domain ?? new URL(cookie.url).hostname, cookie.path, cookie.name])
}

export function parseAntigravityCredentials(
  rawInput: string,
  now = Date.now() / 1000
): { cookies: CookiesSetDetails[]; authUser?: string } {
  const input = rawInput.trim()
  if (!input) throw new AntigravityCredentialError(invalidInput)

  const curl = /^curl(?:\.exe)?\s/i.test(input) ? parseCurl(input) : undefined
  const json = input.startsWith('[') || input.startsWith('{') ? parseCookieJson(input) : undefined
  const parsed = curl?.cookies ?? json?.cookies ?? parseCookieHeader(input)
  const cookies = new Map<string, CookiesSetDetails>()

  for (const cookie of parsed) {
    if (!cookieNamePattern.test(cookie.name) || !cookieValuePattern.test(cookie.value)) continue
    if (cookie.domain !== undefined && typeof cookie.domain !== 'string') continue
    const domain = cookie.domain?.trim().toLowerCase()
    const hostPrefix = cookie.name.startsWith('__Host-')
    const host = domain?.replace(/^\./, '') ?? (hostPrefix ? curl?.host ?? antigravityHost : 'google.com')
    if (!isCookieDomain(host)) continue
    const hostOnly = hostPrefix || cookie.hostOnly === true || (domain !== undefined && !domain.startsWith('.') && cookie.hostOnly !== false)
    const path = !hostPrefix && typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/'
    const expirationDate = json?.hasMetadata
      ? (cookie.session !== true && typeof cookie.expirationDate === 'number' ? cookie.expirationDate : undefined)
      : Math.floor(now) + 30 * 86400
    if (expirationDate !== undefined && (!Number.isFinite(expirationDate) || expirationDate <= now)) continue

    const sameSite = cookie.sameSite === 'none' || cookie.sameSite === 'no_restriction' ? 'no_restriction'
      : cookie.sameSite === 'strict' || cookie.sameSite === 'unspecified' ? cookie.sameSite
        : 'lax'
    const normalizedDomain = hostOnly ? undefined : '.' + host
    const details = {
      url: cookieUrl(host, path),
      domain: normalizedDomain,
      name: cookie.name,
      value: cookie.value,
      path,
      secure: hostPrefix || cookie.name.startsWith('__Secure-') || sameSite === 'no_restriction' || cookie.secure !== false,
      httpOnly: cookie.httpOnly !== false,
      sameSite,
      expirationDate
    } satisfies CookiesSetDetails
    const key = cookieIdentity(details)
    if (json?.hasMetadata || !cookies.get(key)?.value) cookies.set(key, details)
  }

  const usable = [...cookies.values()]
  if (!usable.some((cookie) => cookie.name && cookie.value && isAntigravitySigningCookie(cookie.name))) {
    throw new AntigravityCredentialError('缺少有效的 Google 登录 Cookie（SAPISID、__Secure-1PAPISID 或 __Secure-3PAPISID）。请从已登录的 Antigravity 请求重新复制。')
  }
  return { cookies: usable, authUser: curl?.authUser }
}

const credentialLocks = new Map<string, { run: ReturnType<typeof createMutex>; pending: number }>()

export function withAntigravityCredentials<T>(accountId: string, fn: () => Promise<T> | T): Promise<T> {
  let lock = credentialLocks.get(accountId)
  if (!lock) {
    lock = { run: createMutex(), pending: 0 }
    credentialLocks.set(accountId, lock)
  }
  const current = lock
  current.pending++
  return current.run(async () => {
    try {
      return await fn()
    } finally {
      if (--current.pending === 0) credentialLocks.delete(accountId)
    }
  })
}

function toStoredCookieDetails(cookie: Cookie & { domain: string }): CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, '')
  const path = cookie.path || '/'
  return {
    url: cookieUrl(host, path),
    domain: (cookie.hostOnly ?? !cookie.domain.startsWith('.')) ? undefined : cookie.domain,
    path,
    name: cookie.name,
    value: cookie.value,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate
  }
}

/** Runs with the account's credential lock held. */
export async function importAntigravityCredentials(accountId: string, rawInput: string): Promise<AntigravityUserProfile> {
  const imported = parseAntigravityCredentials(rawInput)
  const ses = electronSession.fromPartition(partitionForAccount(accountId))
  const snapshot = async () => (await ses.cookies.get({}))
    .filter((cookie): cookie is Cookie & { domain: string } => {
      const host = cookie.domain?.replace(/^\./, '')
      return Boolean(host && (host === ANTIGRAVITY_AUTH_USER_HOST || isCookieDomain(host)))
    })
    .map(toStoredCookieDetails)
  const before = await snapshot().catch(() => {
    throw new AntigravityCredentialError('无法读取当前的 Google 会话，请重试。')
  })
  try {
    // Expire the exact domain and path. cookies.remove(url, name) can also remove matching siblings.
    for (const cookie of before) await ses.cookies.set({ ...cookie, expirationDate: 1 })
    for (const cookie of imported.cookies) await ses.cookies.set(cookie)
    const probe = await probeAntigravitySession(accountId, imported.authUser)
    if (!probe.signedIn) {
      const failure = probe.reason === 'network' ? probe.message : probe.message + ' 请从已登录的 Antigravity 请求重新复制。'
      throw new AntigravityCredentialError(failure)
    }
    await ses.cookies.flushStore()
    return probe.profile
  } catch (error) {
    let restoreFailed = false
    const restore = (details: CookiesSetDetails) => ses.cookies.set(details).catch(() => { restoreFailed = true })
    try {
      const current = await snapshot()
      const originalKeys = new Set(before.map(cookieIdentity))
      for (const cookie of current) {
        if (!originalKeys.has(cookieIdentity(cookie))) await restore({ ...cookie, expirationDate: 1 })
      }
    } catch {
      restoreFailed = true
    }
    for (const cookie of before) await restore(cookie)
    await ses.cookies.flushStore().catch(() => { restoreFailed = true })
    if (restoreFailed) throw new AntigravityCredentialError('导入失败，且无法完整恢复之前的 Google Cookie。请重新登录 Antigravity。')
    if (error instanceof AntigravityCredentialError) throw error
    throw new AntigravityCredentialError('无法写入 Antigravity 的 Google Cookie，请重新复制后重试。')
  }
}
