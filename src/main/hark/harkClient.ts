/**
 * Hark Go REST + Real-time Sync (`/api/sync/conversation` SSE + `/api/sync/poll` fallback)
 * bound to an Electron session partition.
 *
 * Reverse-engineered from Hark.app (0.1.21) & frontend chunks `DD3Rh-3z.js`,
 * `j8yWSo31.js`, and `worker-Ce4znvdx.js`.
 * Never logs cookie values or tokens.
 */

import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { session as electronSession, type Cookie, type Session } from 'electron'
import { HARK_PREVIEW_MAX_BYTES, HARK_PREVIEW_TIMEOUT_MS, harkScreenshotReference } from '@shared/harkBrowserPreview'
import { harkProjectId } from '@shared/harkProjects'
import { createMutex } from '@shared/proxyPool'
import { applyProxyToPartition } from '../muse/accountProxy'
import { guessMediaMimeFromName, inferMediaMime } from '../mediaMime'
import { partitionForAccount } from '../webContentsViewManager'
import { HARK_TAIL_CAP_MS, HARK_TAIL_IDLE_MS, harkTurnBusy } from './harkBusy'
import { HarkWatchRegistry } from './watchRegistry'

export const HARK_ORIGIN = 'https://app.hark.com'
export const HARK_API_BASE = `${HARK_ORIGIN}/api`
export const HARK_LOGIN_URL = `${HARK_ORIGIN}/login`
export const HARK_CLIENT_VERSION = '0.1.21'
const DEFAULT_HARK_CHROME_VERSION = '147.0.0.0'
const DEFAULT_HARK_ELECTRON_VERSION = '45.2.1'

export function buildHarkPlatformStrings(platform: NodeJS.Platform = process.platform): {
  osToken: string
  secChUaPlatform: '"Windows"' | '"macOS"' | '"Linux"'
} {
  if (platform === 'win32') {
    return { osToken: 'Windows NT 10.0; Win64; x64', secChUaPlatform: '"Windows"' }
  }
  if (platform === 'darwin') {
    return { osToken: 'Macintosh; Intel Mac OS X 10_15_7', secChUaPlatform: '"macOS"' }
  }
  return { osToken: 'X11; Linux x86_64', secChUaPlatform: '"Linux"' }
}

export function buildHarkUserAgent(
  opts: { platform?: NodeJS.Platform; chromeVersion?: string; electronVersion?: string } = {}
): string {
  const { osToken } = buildHarkPlatformStrings(opts.platform)
  const rawChrome = opts.chromeVersion ?? process.versions?.chrome
  const chromeVer =
    rawChrome && /^\d+(\.\d+)*$/.test(rawChrome) ? rawChrome : DEFAULT_HARK_CHROME_VERSION
  const rawElectron = opts.electronVersion ?? process.versions?.electron
  const electronVer =
    rawElectron && /^\d+(\.\d+)*$/.test(rawElectron) ? rawElectron : DEFAULT_HARK_ELECTRON_VERSION
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Hark/${HARK_CLIENT_VERSION} Chrome/${chromeVer} Electron/${electronVer} Safari/537.36`
}

export function buildHarkSecChUa(chromeVersion = process.versions?.chrome): string {
  const full =
    chromeVersion && /^\d+(\.\d+)*$/.test(chromeVersion)
      ? chromeVersion
      : DEFAULT_HARK_CHROME_VERSION
  const major = full.split('.')[0] || '147'
  return `"Chromium";v="${major}", "Not:A-Brand";v="24"`
}

export const HARK_USER_AGENT = buildHarkUserAgent()

export class HarkApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, bodyText: string) {
    let parsed: unknown = bodyText
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      /* keep text */
    }
    const message =
      typeof parsed === 'object' &&
      parsed &&
      typeof (parsed as { message?: unknown }).message === 'string'
        ? (parsed as { message: string }).message
        : typeof parsed === 'object' &&
            parsed &&
            typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : `Hark API error ${status}`
    super(message)
    this.name = 'HarkApiError'
    this.status = status
    this.body = parsed
  }
}

export type HarkSessionUser = {
  id?: string
  email?: string | null
  name?: string | null
  image?: string | null
}

export type HarkAuthSession = {
  user?: HarkSessionUser | null
  session?: { id?: string; token?: string; expiresAt?: string } | null
} | null

function localeHeader(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en'
  } catch {
    return 'en'
  }
}

export function timezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function sessionForAccount(accountId: string): Session {
  return electronSession.fromPartition(partitionForAccount(accountId))
}

/**
 * Resolve the account's Electron session ONLY after enforcing per-account proxy
 * rules (fails closed with `ProxyConfigUnreadableError` + blackhole proxy if
 * `safeStorage` cannot decrypt a configured proxy).
 */
export async function preparedSessionForAccount(accountId: string): Promise<Session> {
  await applyProxyToPartition(accountId)
  return sessionForAccount(accountId)
}

export function buildHarkClientHeaders(
  extra?: Record<string, string>,
  opts: {
    platform?: NodeJS.Platform
    chromeVersion?: string
    electronVersion?: string
    locale?: string
    timezone?: string
  } = {}
): Record<string, string> {
  const { secChUaPlatform } = buildHarkPlatformStrings(opts.platform)
  return {
    Accept: 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    Origin: HARK_ORIGIN,
    Referer: `${HARK_ORIGIN}/`,
    'User-Agent': buildHarkUserAgent({
      platform: opts.platform,
      chromeVersion: opts.chromeVersion,
      electronVersion: opts.electronVersion
    }),
    'X-Hark-Locale': opts.locale ?? localeHeader(),
    'X-Hark-Timezone': opts.timezone ?? timezoneName(),
    'X-Hark-Client-Version': HARK_CLIENT_VERSION,
    'Sec-Ch-Ua': buildHarkSecChUa(opts.chromeVersion),
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': secChUaPlatform,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    ...(extra ?? {})
  }
}

function harkClientHeaders(extra?: Record<string, string>): Record<string, string> {
  return buildHarkClientHeaders(extra)
}

const HARK_REQUEST_TIMEOUT_MS = 30_000

export class HarkRequestTimeout extends Error {
  constructor(readonly method: string, readonly pathname: string) {
    super(`Hark ${method} ${pathname} timed out`)
  }
}

/** A 401 outside /auth: renew the session once (as Hark's web app does) and try again. */
async function harkFetch(ses: Session, path: string, init: Parameters<typeof harkFetchOnce>[2] = {}): Promise<unknown> {
  try {
    return await harkFetchOnce(ses, path, init)
  } catch (err) {
    if (!(err instanceof HarkApiError && err.status === 401) || path.startsWith('/auth/')) throw err
    const renewed = await readAndRenewSession(ses).catch(() => null) as Record<string, unknown> | null
    if (!renewed || !(renewed['session'] || renewed['user'])) throw err
    return harkFetchOnce(ses, path, init)
  }
}

async function harkFetchOnce(
  ses: Session,
  path: string,
  init: {
    method?: string
    query?: Record<string, string | undefined>
    body?: unknown
    signal?: AbortSignal
    interactive?: boolean
  } = {}
): Promise<unknown> {
  const url = new URL(path.startsWith('http') ? path : `${HARK_API_BASE}${path}`)
  if (init.query) {
    for (const [key, value] of Object.entries(init.query)) {
      if (value != null && value !== '') url.searchParams.set(key, value)
    }
  }

  const headers = harkClientHeaders(
    init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined
  )
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET')
  const maxAttempts = method === 'GET' ? (init.interactive ? 2 : 3) : 1
  let lastErr: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await delay(350 * attempt, undefined, { signal: init.signal })
    }
    init.signal?.throwIfAborted()
    // Every attempt gets its own deadline; a stalled request used to leave
    // the bubble on "Sending" and the account `pending` until restart.
    const deadline = AbortSignal.timeout(init.interactive ? 12_000 : HARK_REQUEST_TIMEOUT_MS)
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline
    try {
      const response = await ses.fetch(url.toString(), {
        method,
        credentials: 'include',
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        // API JSON must always be fresh: never let Chromium's HTTP cache
        // answer a re-fetch (e.g. `GET /conversations` for the project list).
        cache: 'no-store',
        signal
      })

      const text = await response.text()
      if (!response.ok) {
        const err = new HarkApiError(response.status, text || response.statusText)
        if (
          (response.status === 429 ||
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504) &&
          attempt + 1 < maxAttempts
        ) {
          lastErr = err
          continue
        }
        throw err
      }
      if (!text) return null
      try {
        return JSON.parse(text) as unknown
      } catch {
        return text
      }
    } catch (err) {
      lastErr = err
      if (init.signal?.aborted || err instanceof HarkApiError) throw err
      // A write that timed out may already have landed: don't send it twice.
      if (deadline.aborted && method !== 'GET') throw new HarkRequestTimeout(method, url.pathname)
      if (attempt + 1 >= maxAttempts) throw err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Hark request failed')
}

export async function callHarkApi(
  accountId: string,
  opts: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
    path: string
    query?: Record<string, string | undefined>
    body?: unknown
  }
): Promise<unknown> {
  const cleanPath = opts.path.startsWith('/') ? opts.path : `/${opts.path}`
  const ses = await preparedSessionForAccount(accountId)
  return harkFetch(ses, cleanPath, {
    method: opts.method,
    query: opts.query,
    body: opts.body
  })
}

/** GET get-session reads the session and lets the server renew it (Hark answers POST with 404). */
async function readAndRenewSession(ses: Session): Promise<unknown> {
  return harkFetch(ses, '/auth/get-session', { interactive: true })
}

export async function getAuthSession(accountId: string): Promise<HarkAuthSession> {
  const ses = await preparedSessionForAccount(accountId)
  const data = await readAndRenewSession(ses)
  if (data == null) return null
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Hark returned an invalid session response')
  }
  const rec = data as Record<string, unknown>
  if (rec['user'] || rec['session']) {
    return data as HarkAuthSession
  }
  if (rec['data'] && typeof rec['data'] === 'object') {
    const inner = rec['data'] as Record<string, unknown>
    if (inner['user'] || inner['session']) {
      return inner as unknown as HarkAuthSession
    }
  }
  return data as HarkAuthSession
}

export function extractHandle(session: HarkAuthSession): {
  handle?: string
  displayName?: string
  userId?: string
} {
  const user = session && typeof session === 'object' ? session.user : null
  if (!user || typeof user !== 'object') return {}
  const email = typeof user.email === 'string' ? user.email : undefined
  const name = typeof user.name === 'string' ? user.name : undefined
  const userId = typeof user.id === 'string' ? user.id : undefined
  return { handle: email ?? name, displayName: name ?? email, userId }
}

/** Cookie names that indicate a signed-in Hark better-auth session. */
export function looksLikeSessionCookie(name: string): boolean {
  if (name === '__Secure-hark.state' || name === '__Secure-hark.region_flow') return false
  if (name.startsWith('__Secure-hark.')) return true
  if (/^(?:(?:__Secure|__Host)-)?better-auth\.session/i.test(name)) return true
  if (/hark.*session/i.test(name) && !/state|region/i.test(name)) return true
  return false
}

const LEGACY_SESSION_NAMES = new Set(['__Secure-hark.session_token', '__Secure-better-auth.session_token'])

/**
 * Old session cookies scoped to app.hark.com that shadow the current ones on .hark.com.
 * Same-name cookies are all sent and the older, narrower one goes first, so Hark reads the
 * stale token, answers get-session with null and the web view bounces back to /login.
 * Only reported when a .hark.com session token exists to take over.
 */
export function shadowedHarkSessionCookies(cookies: Cookie[]): Cookie[] {
  const hasCurrent = cookies.some((c) => c.name === '__Secure-hark.session_token' && c.domain === '.hark.com')
  if (!hasCurrent) return []
  return cookies.filter((c) => LEGACY_SESSION_NAMES.has(c.name) && c.domain?.replace(/^\./, '') === 'app.hark.com')
}

/** Expire the shadowing app.hark.com session cookies. Returns how many were dropped. */
export async function dropShadowedHarkSessionCookies(accountId: string): Promise<number> {
  const ses = sessionForAccount(accountId)
  const stale = shadowedHarkSessionCookies(await ses.cookies.get({}))
  for (const cookie of stale) await setHarkCookie(ses, cookie, 1)
  if (stale.length) await ses.cookies.flushStore().catch(() => undefined)
  return stale.length
}

export async function listSessionCookieNames(accountId: string): Promise<string[]> {
  const ses = sessionForAccount(accountId)
  const cookies = await ses.cookies.get({})
  const names = new Set<string>()
  for (const c of cookies) {
    if (looksLikeSessionCookie(c.name)) names.add(c.name)
  }
  return [...names]
}

/**
 * Import Hark session cookies from a standard Cookie header string,
 * JSON cookie array, or raw `__Secure-hark.session_token` value.
 */
export async function importHarkCredentials(
  accountId: string, rawInput: string, verify: () => Promise<HarkAuthSession>
): Promise<HarkAuthSession> {
  const trimmed = rawInput.trim().replace(/^Cookie:\s*/i, '')
  if (!trimmed) return null
  const ses = await preparedSessionForAccount(accountId)
  const exp = Math.floor(Date.now() / 1000) + 86400 * 30
  const pairs: Array<{ name: string; value: string; domain?: string; path?: string }> = []

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const list = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Record<string, unknown>
        if (typeof rec.name === 'string' && typeof rec.value === 'string') {
          pairs.push({
            name: rec.name,
            value: rec.value,
            domain: typeof rec.domain === 'string' ? rec.domain : '.hark.com',
            path: typeof rec.path === 'string' ? rec.path : '/'
          })
        } else if (typeof rec.token === 'string' && rec.token.trim()) {
          pairs.push({ name: '__Secure-hark.session_token', value: rec.token.trim() })
          pairs.push({ name: '__Secure-better-auth.session_token', value: rec.token.trim() })
        }
      }
    } catch {
      /* fall through to key=value parsing */
    }
  }

  if (pairs.length === 0) {
    if (trimmed.includes('=')) {
      for (const segment of trimmed.split(/[;\n]+/)) {
        const idx = segment.indexOf('=')
        if (idx <= 0) continue
        const name = segment.slice(0, idx).trim()
        const value = segment.slice(idx + 1).trim()
        if (name && value) pairs.push({ name, value })
      }
    } else {
      pairs.push({ name: '__Secure-hark.session_token', value: trimmed })
      pairs.push({ name: '__Secure-better-auth.session_token', value: trimmed })
    }
  }

  if (pairs.length === 0) return null
  const harkCookies = async () => (await ses.cookies.get({})).filter((c) => isHarkCookieDomain(c.domain))
  const before = await harkCookies()
  let verified: HarkAuthSession = null
  try {
    // Verify the staged credentials independently of any previously signed-in session.
    for (const cookie of before) {
      if (looksLikeSessionCookie(cookie.name)) await setHarkCookie(ses, cookie, 1)
    }
    let staged = false
    for (const c of pairs) {
      // Hark sets its auth cookies with Domain=hark.com.
      const domain = c.domain || '.hark.com'
      if (!isHarkCookieDomain(domain)) continue
      try {
        await setHarkCookie(ses, {
          ...c, domain, hostOnly: c.name.startsWith('__Host-'),
          path: c.path?.startsWith('/') ? c.path : '/',
          secure: true, httpOnly: true, sameSite: 'lax', expirationDate: exp
        })
        staged = true
      } catch {
        /* Other entries in a browser export may still be usable. */
      }
    }
    if (staged) verified = await verify()
    return verified
  } finally {
    if (!verified) {
      const after = await harkCookies()
      const original = new Map(before.map((cookie) => [harkCookieKey(cookie), cookie]))
      const current = new Map(after.map((cookie) => [harkCookieKey(cookie), cookie]))
      for (const [key, cookie] of current) {
        if (!original.has(key)) await setHarkCookie(ses, cookie, 1)
      }
      for (const [key, cookie] of original) {
        if (JSON.stringify(cookie) !== JSON.stringify(current.get(key))) await setHarkCookie(ses, cookie)
      }
    }
    await ses.cookies.flushStore().catch(() => undefined)
  }
}

function isHarkCookieDomain(domain?: string): boolean {
  return /^(?:[\w-]+\.)*hark\.com$/i.test(domain?.replace(/^\./, '') ?? '')
}

function harkCookieKey(cookie: Cookie): string {
  return JSON.stringify([cookie.domain, cookie.path, cookie.name])
}

function setHarkCookie(ses: Session, cookie: Cookie, expirationDate = cookie.expirationDate): Promise<void> {
  const host = cookie.domain?.replace(/^\./, '') || 'app.hark.com'
  const path = cookie.path || '/'
  const url = new URL(`https://${host}`)
  url.pathname = path
  return ses.cookies.set({
    url: url.href, path, name: cookie.name, value: cookie.value,
    domain: cookie.hostOnly ? undefined : cookie.domain,
    secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, expirationDate
  })
}

const credentialLocks = new Map<string, { run: ReturnType<typeof createMutex>; pending: number }>()

export function withHarkCredentials<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  let lock = credentialLocks.get(accountId)
  if (!lock) credentialLocks.set(accountId, (lock = { run: createMutex(), pending: 0 }))
  lock.pending++
  return lock.run(async () => {
    try { return await fn() }
    finally { if (--lock.pending === 0) credentialLocks.delete(accountId) }
  })
}

export async function clearHarkAccount(accountId: string): Promise<void> {
  cancelHarkWatch(accountId)
  const ses = sessionForAccount(accountId)
  await ses
    .clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage']
    })
    .catch(() => undefined)
  await ses.cookies.flushStore().catch(() => undefined)
}

/**
 * Fetch the full conversation transcript via `/api/sync/poll?first=1`
 * (since `/conversations/main` only returns `{ conversationId }` metadata).
 */
export async function pollHarkConversation(
  ses: Session,
  conversationId: string,
  manager: string,
  options: { first: boolean; cursor?: string; floor?: string; signal?: AbortSignal }
): Promise<{ frames?: string[]; cursor?: string; floor?: string } | null> {
  return await harkFetch(ses, '/sync/poll', {
    method: 'GET',
    query: {
      conversationId, manager, v: '2', mode: 'in_tab', dial: 'initial',
      first: options.first ? '1' : undefined,
      cursor: options.cursor, floor: options.floor
    },
    signal: options.signal
  }) as { frames?: string[]; cursor?: string; floor?: string } | null
}

export async function fetchConversationSnapshotSummary(
  accountId: string,
  conversationId: string,
  signal?: AbortSignal
): Promise<HarkConversationSnapshotSummary> {
  const ses = await preparedSessionForAccount(accountId)
  const managerId = randomUUID()
  const syncState = new HarkConversationSyncState()
  const pollRes = await pollHarkConversation(ses, conversationId, managerId, { first: true, signal })
  if (pollRes && Array.isArray(pollRes.frames)) {
    for (const frame of pollRes.frames) {
      syncState.applyFrame(frame)
    }
  }
  return {
    conversationId,
    messages: syncState.orderedMessages(),
    panels: syncState.extractPanels(),
    asks: syncState.extractAsks(),
    artifacts: syncState.extractArtifacts(),
    activeActivity: syncState.activeActivity,
    narration: syncState.narration,
    requests: Object.fromEntries(syncState.requests),
    activeWork: Array.isArray(syncState.activeWork) ? syncState.activeWork : []
  }
}

export async function fetchConversationSnapshotMessages(
  accountId: string,
  conversationId: string
): Promise<HarkChatMessage[]> {
  const snap = await fetchConversationSnapshotSummary(accountId, conversationId)
  return snap.messages
}

export async function getProfile(accountId: string, interactive = false): Promise<unknown> {
  return harkFetch(await preparedSessionForAccount(accountId), '/profile', { interactive })
}

export async function listConversations(accountId: string): Promise<unknown> {
  return harkFetch(await preparedSessionForAccount(accountId), '/conversations')
}

export async function getMainConversation(
  accountId: string,
  timezone = timezoneName(),
  signal?: AbortSignal
): Promise<unknown> {
  return harkFetch(await preparedSessionForAccount(accountId), '/conversations/main', {
    query: { timezone },
    signal
  })
}

export async function getConversationStatuses(accountId: string): Promise<unknown> {
  return harkFetch(await preparedSessionForAccount(accountId), '/conversations/status')
}

export interface HarkUploadedAttachment {
  attachment_id: string
  name: string
  media_type: string
  size: number
  path: string
  s3_key: string
  kind: 'file'
  text?: string
}

/**
 * 3-step file upload from `DD3Rh-3z.js`:
 * 1. `POST /api/files/upload/${conversationId}/presign` `{ filename, content_type, size }`
 * 2. `PUT <upload_url>` raw bytes
 * 3. `POST /api/files/${conversationId}/${attachment_id}/finalize` `{ s3_key, path }`
 */
export async function uploadHarkAttachment(
  accountId: string,
  conversationId: string,
  file: { name: string; mimeType: string; dataBase64: string }
): Promise<HarkUploadedAttachment> {
  const ses = await preparedSessionForAccount(accountId)
  const bytes = Buffer.from(file.dataBase64, 'base64')
  const contentType = file.mimeType || 'application/octet-stream'

  const presign = (await harkFetch(ses, `/files/upload/${encodeURIComponent(conversationId)}/presign`, {
    method: 'POST',
    body: {
      filename: file.name,
      content_type: contentType,
      size: bytes.byteLength
    }
  })) as Record<string, unknown>

  const uploadUrl = String(presign?.['upload_url'] ?? '')
  const attachmentId = String(presign?.['attachment_id'] ?? '')
  const s3Key = String(presign?.['s3_key'] ?? '')
  const path = String(presign?.['path'] ?? file.name)
  if (!uploadUrl || !attachmentId || !s3Key) {
    throw new Error('Hark presign returned incomplete metadata')
  }

  const putRes = await ses.fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': String(presign?.['content_type'] ?? contentType) },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(HARK_REQUEST_TIMEOUT_MS)
  })
  if (!putRes.ok) {
    throw new Error(`Hark S3 upload failed (${putRes.status})`)
  }

  const finalized = (await harkFetch(
    ses,
    `/files/${encodeURIComponent(conversationId)}/${encodeURIComponent(attachmentId)}/finalize`,
    {
      method: 'POST',
      body: { s3_key: s3Key, path }
    }
  )) as Record<string, unknown>

  const finalPath = String(finalized?.['path'] ?? path)
  return {
    attachment_id: String(finalized?.['attachment_id'] ?? attachmentId),
    name: String(finalized?.['name'] ?? file.name),
    media_type: String(finalized?.['media_type'] ?? contentType),
    size: Number(finalized?.['size'] ?? bytes.byteLength),
    path: finalPath,
    s3_key: String(finalized?.['s3_key'] ?? s3Key),
    kind: 'file',
    text: `Path: ${finalPath}`
  }
}

function extractPresignedUrl(presigned: unknown, key: string): string {
  if (!presigned || typeof presigned !== 'object') return ''
  const rec = presigned as Record<string, unknown>
  for (const direct of ['url', 'download_url', 'downloadUrl', 'signedUrl', 'signed_url']) {
    if (typeof rec[direct] === 'string' && /^https?:\/\//i.test(rec[direct] as string)) {
      return rec[direct] as string
    }
  }
  const container = (rec['urls'] ?? rec['data'] ?? rec) as unknown
  if (Array.isArray(container)) {
    const first = container.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
    if (typeof first === 'string') return first
  } else if (container && typeof container === 'object') {
    const map = container as Record<string, unknown>
    if (typeof map[key] === 'string' && /^https?:\/\//i.test(map[key] as string)) {
      return map[key] as string
    }
    const firstVal = Object.values(map).find((v) => typeof v === 'string' && /^https?:\/\//i.test(v))
    if (typeof firstVal === 'string') return firstVal
  }
  return ''
}

export async function downloadHarkArtifact(
  accountId: string,
  opts: { url?: string; fileId?: string; name?: string; signal?: AbortSignal; preview?: boolean }
): Promise<{
  dataBase64: string
  mimeType: string
  filename: string
  text?: string
}> {
  const timeout = opts.preview ? AbortSignal.timeout(HARK_PREVIEW_TIMEOUT_MS) : undefined
  const signal = timeout && opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout ?? opts.signal
  const ses = await preparedSessionForAccount(accountId)
  signal?.throwIfAborted()
  const preview = opts.preview ? harkScreenshotReference(opts.fileId, opts.url) : undefined
  const fileId = preview ? preview.screenshotKey : opts.fileId
  const reference = (preview ? preview.screenshotUrl : opts.url)?.trim() || fileId?.replace(/^(harkatt|harkfile):\/\//i, '').trim() || ''
  let targetUrl = reference.startsWith('/') ? new URL(reference, HARK_ORIGIN).toString() : reference
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = ''

  if (!targetUrl && fileId) {
    const key = fileId.replace(/^(harkatt|harkfile):\/\//i, '').trim()
    if (!/^https?:\/\//i.test(key)) {
      for (const endpoint of ['/images/presign', '/files/presign']) {
        if (targetUrl) break
        try {
          const presigned = await harkFetch(ses, endpoint, {
            method: 'POST',
            body: { keys: [key] },
            signal
          })
          const resolved = extractPresignedUrl(presigned, key)
          if (resolved) targetUrl = resolved
        } catch {
          signal?.throwIfAborted()
        }
      }
      if (!targetUrl) {
        try {
          const presigned = await harkFetch(ses, '/files/download', {
            method: 'GET',
            query: { key },
            signal
          })
          const resolved = extractPresignedUrl(presigned, key)
          if (resolved) targetUrl = resolved
        } catch {
          signal?.throwIfAborted()
        }
      }
    }
  }

  if (!targetUrl) {
    throw new Error('Hark artifact URL or S3 key could not be resolved')
  }

  const res = signal ? await ses.fetch(targetUrl, { signal }) : await ses.fetch(targetUrl)
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error(`Hark artifact download failed (${res.status})`)
  }
  const buf = opts.preview ? await readHarkPreview(res, signal!) : Buffer.from(await res.arrayBuffer())
  const filename = opts.name || targetUrl.split('?')[0]?.split('/').pop() || 'artifact'
  const contentType = inferMediaMime({
    headerMime: res.headers.get('content-type') ?? undefined,
    nameOrPath: filename,
    bytes: buf
  })
  const isText = /^(text\/|application\/(json|javascript|xml|x-yaml|csv|sql))/i.test(contentType) ||
    /\.(md|markdown|txt|json|csv|html|htm|py|ts|tsx|js|sh|yaml|yml|sql)$/i.test(filename)
  if (opts.preview && (!buf.length || !contentType.startsWith('image/'))) throw new Error('Hark screenshot unavailable')

  return {
    dataBase64: buf.toString('base64'),
    mimeType: contentType,
    filename,
    ...(isText ? { text: buf.toString('utf8') } : {})
  }
}

async function readHarkPreview(response: Response, signal: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    if (Number(response.headers.get('content-length')) > HARK_PREVIEW_MAX_BYTES) {
      throw new Error('Hark screenshot exceeds 8 MiB')
    }
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) return Buffer.concat(chunks, size)
      size += value.byteLength
      if (size > HARK_PREVIEW_MAX_BYTES) throw new Error('Hark screenshot exceeds 8 MiB')
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/**
 * Exact `wl.messages.sendMessage.mutate` payload from `DD3Rh-3z.js` (@97725):
 * `POST /api/messages/send?cid=<conversationId>`
 * `{ timezone, conversationId, message, idempotencyKey, responseMessageId, attachments? }`
 */
export async function sendMessage(
  accountId: string,
  conversationId: string,
  text: string,
  timezone = timezoneName(),
  attachments?: HarkUploadedAttachment[]
): Promise<{
  result: unknown
  idempotencyKey: string
  responseMessageId: string
}> {
  const ses = await preparedSessionForAccount(accountId)
  const idempotencyKey = randomUUID()
  const responseMessageId = randomUUID()
  const body: Record<string, unknown> = {
    timezone,
    conversationId,
    message: text,
    idempotencyKey,
    responseMessageId,
    ...(attachments && attachments.length > 0 ? { attachments } : {})
  }
  const result = await harkFetch(ses, '/messages/send', {
    method: 'POST',
    query: { cid: conversationId },
    body
  })
  return { result, idempotencyKey, responseMessageId }
}

export type HarkChatMessage = {
  id: string
  role: string
  content: string
  isStreaming?: boolean
  jobStatus?: string
  error?: string
  thought?: string
  narration?: string
  createdAt?: string | number | null
  /** The message this reply answers: its id, and/or a quoted copy Hark embedded. */
  replyTo?: { id?: string; text?: string }
  /** GOXF: the user message (= Hark request id) this reply was made for. */
  triggeredBy?: string
  toolCalls?: Array<{
    dispatchId: string
    name: string
    status: string
    url?: string
    screenshotKey?: string
    screenshotUrl?: string
    command?: string
    result?: string
    /** GOXF: what this call is doing (subagent task, browser task, search query), so parallel calls tell apart. */
    detail?: string
  }>
  actions?: Array<{
    kind: string
    connector?: string
    label: string
    scopes?: string
  }>
  artifacts?: Array<{
    name?: string
    path: string
    s3Key?: string
    downloadUrl?: string
    mimeType?: string
    sizeBytes?: number
  }>
  /** A `links` presentation block: pages to open, shown as link cards (not files). */
  links?: Array<{ url: string; name?: string; label?: string; imageUrl?: string }>
}

export interface HarkActivityPanel {
  dispatchId: string
  kind: string
  status: string
  title?: string
  url?: string
  liveViewUrl?: string
  screenshotKey?: string
  screenshotUrl?: string
  command?: string
  fromToolCall?: boolean
}

export interface HarkPendingAsk {
  id: string
  dispatchId?: string
  requestId?: string
  displayHint?: string
  prompt?: string
  domain?: string
  status: string
  raw: Record<string, unknown>
}

export interface HarkConversationSnapshotSummary {
  conversationId: string
  messages: HarkChatMessage[]
  panels: HarkActivityPanel[]
  asks: HarkPendingAsk[]
  artifacts: Array<{
    name: string
    path: string
    s3Key?: string
    downloadUrl?: string
    mimeType?: string
    sizeBytes?: number
  }>
  activeActivity?: string | null
  narration?: string | null
  requests?: Record<string, Record<string, unknown>>
  activeWork?: unknown[]
}

/**
 * Real-time conversation state reducer (`worker-Ce4znvdx.js`).
 * Consumes `snapshot` and `patches` (`entry_add` / `message_add`, `message_update`,
 * `tool_add`, `tool_update`, `narration_update`, `active_activity_set`).
 */
export class HarkConversationSyncState {
  readonly messages = new Map<string, HarkChatMessage>()
  readonly asks = new Map<string, Record<string, unknown>>()
  readonly order: string[] = []
  private readonly panelsByWindow = new Map<string, Map<string | symbol, Record<string, unknown>>>()
  historyRevision = 0
  activeActivity: string | null = null
  /** GOXF: Hark's `activeWork` (background work after the reply, e.g. 「Running network path checks」). */
  activeWork: unknown = null
  /** GOXF: Hark's own task list: one entry per user message it took up (`requests`, `request_update`). */
  readonly requests = new Map<string, Record<string, unknown>>()
  narration: string | null = null
  /** GOXF: Hark's narration says `working: true` while a turn runs, even before it has a line. */
  narrationWorking = false

  private setWindowPanels(id: string, raw: unknown): void {
    const panels = new Map<string | symbol, Record<string, unknown>>()
    for (const panel of Array.isArray(raw) ? raw : []) {
      if (!panel || typeof panel !== 'object') continue
      panels.set(panel.dispatchId ? String(panel.dispatchId) : Symbol(), panel)
    }
    this.panelsByWindow.set(id, panels)
  }

  applyFrame(rawFrame: string): boolean {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(rawFrame) as Record<string, unknown>
    } catch {
      return false
    }
    if (!parsed || typeof parsed !== 'object') return false
    const type = parsed['type']
    if (type !== 'snapshot' && type !== 'patches') return false

    if (type === 'snapshot') {
      const data = (parsed['data'] ?? {}) as Record<string, unknown>
      this.messages.clear()
      this.panelsByWindow.clear()
      this.asks.clear()
      this.order.length = 0
      // Joining mid-run: the snapshot carries the same shapes the patches do (string or {label/type}).
      this.activeActivity = harkActivityLabel(data['activeActivity'])
      this.activeWork = data['activeWork'] ?? null
      this.requests.clear()
      if (data['requests'] && typeof data['requests'] === 'object') {
        for (const [rid, rval] of Object.entries(data['requests'] as Record<string, unknown>)) {
          if (rval && typeof rval === 'object') this.requests.set(rid, rval as Record<string, unknown>)
        }
      }
      this.narration = harkActivityLabel(data['narration'])
      this.narrationWorking = harkNarrationWorking(data['narration'], false)

      if (data['windows'] && typeof data['windows'] === 'object') {
        for (const [wid, wval] of Object.entries(data['windows'] as Record<string, unknown>)) {
          if (wval && typeof wval === 'object') {
            this.setWindowPanels(wid, (wval as Record<string, unknown>)['panels'])
          }
        }
      }
      if (data['asks'] && typeof data['asks'] === 'object') {
        for (const [aid, aval] of Object.entries(data['asks'] as Record<string, unknown>)) {
          if (aval && typeof aval === 'object') {
            this.asks.set(aid, aval as Record<string, unknown>)
          }
        }
      }

      if (parsed['shape'] === 'records' && data['messages'] && typeof data['messages'] === 'object' && !Array.isArray(data['messages'])) {
        const msgMap = data['messages'] as Record<string, Record<string, unknown>>
        const log = Array.isArray(data['log']) ? (data['log'] as Array<Record<string, unknown>>) : []
        for (const entry of log) {
          const id = String(entry['id'] ?? '')
          if (!id) continue
          const m = msgMap[id]
          if (m) {
            this.messages.set(id, normalizeSyncMessage(id, m))
            this.order.push(id)
          }
        }
        for (const [id, m] of Object.entries(msgMap)) {
          if (!this.messages.has(id)) {
            this.messages.set(id, normalizeSyncMessage(id, m))
            this.order.push(id)
          }
        }
      } else {
        const list = extractMessages(data)
        for (const m of list) {
          this.messages.set(m.id, m)
          this.order.push(m.id)
        }
      }
      this.historyRevision++
      return true
    }

    // type === 'patches'
    const patches = Array.isArray(parsed['data']) ? (parsed['data'] as Array<Record<string, unknown>>) : []
    let changed = false
    let activityChanged = false
    for (const p of patches) {
      const op = String(p['op'] ?? '')
      if (op === 'entry_add' || op === 'message_add') {
        const entryKind = String(p['entry'] ?? 'message')
        const id = String(p['id'] ?? p['messageId'] ?? '')
        const val = (p['value'] ?? {}) as Record<string, unknown>
        if (!id) continue
        if (entryKind === 'window') {
          this.setWindowPanels(id, val['panels'])
          changed = true
          continue
        }
        if (entryKind === 'ask') {
          this.asks.set(id, val)
          changed = true
          continue
        }
        this.messages.set(id, normalizeSyncMessage(id, val))
        if (!this.order.includes(id)) this.order.push(id)
        changed = true
      } else if (op === 'window_update') {
        const id = String(p['id'] ?? '')
        const fields = (p['fields'] ?? {}) as Record<string, unknown>
        if (id && ('panels' in fields || !this.panelsByWindow.has(id))) {
          this.setWindowPanels(id, fields['panels'])
          changed = true
        }
      } else if (op === 'ask_update') {
        const id = String(p['id'] ?? '')
        const fields = (p['fields'] ?? {}) as Record<string, unknown>
        const prev = this.asks.get(id) ?? {}
        if (id) {
          this.asks.set(id, { ...prev, ...fields })
          changed = true
        }
      } else if (op === 'panel_add' || op === 'panel_update') {
        const id = String(p['id'] ?? p['messageId'] ?? '')
        const panels = this.panelsByWindow.get(id)
        if (panels) {
          if (op === 'panel_add' && p['value'] && typeof p['value'] === 'object') {
            const panel = p['value'] as Record<string, unknown>
            panels.set(panel['dispatchId'] ? String(panel['dispatchId']) : Symbol(), panel)
            changed = true
          } else if (op === 'panel_update') {
            const did = String(p['dispatchId'] ?? '')
            const fields = (p['fields'] ?? {}) as Record<string, unknown>
            const panel = panels.get(did)
            if (panel) {
              panels.set(did, { ...panel, ...fields })
              changed = true
            }
          }
        }
      } else if (op === 'message_update') {
        const id = String(p['id'] ?? p['messageId'] ?? '')
        const fields = (p['fields'] ?? {}) as Record<string, unknown>
        const existing = this.messages.get(id)
        if (existing) {
          const patched = normalizeSyncMessage(id, fields)
          const links = patched.links ?? existing.links
          let nextContent =
            (typeof fields['content'] === 'string' && fields['content']) ||
            (typeof fields['text'] === 'string' && fields['text']) ||
            (fields['presentation'] ? patched.content : undefined)
          // A links block shows as cards; its bare-URL text never becomes a bubble.
          const dropUrlText = Boolean(links?.length && onlyUrls(nextContent ?? existing.content, links))
          if (dropUrlText) nextContent = undefined
          const terminalJob = harkJobOutcome(fields['jobStatus'])
          const nextStreaming =
            typeof fields['isStreaming'] === 'boolean'
              ? fields['isStreaming']
              : terminalJob
                ? false
                : existing.isStreaming
          const updated: HarkChatMessage = {
            ...existing,
            ...(dropUrlText
              ? { content: '' }
              : nextContent !== undefined && (nextContent || !existing.content)
                ? { content: nextContent }
                : {}),
            ...(links?.length ? { links } : {}),
            ...(nextStreaming !== undefined ? { isStreaming: nextStreaming } : {}),
            ...(typeof fields['jobStatus'] === 'string' ? { jobStatus: fields['jobStatus'] } : {}),
            ...(typeof fields['error'] === 'string' ? { error: fields['error'] } : {}),
            ...(typeof fields['thought'] === 'string' ? { thought: fields['thought'] } : {}),
            ...(fields['narration'] !== undefined ? { narration: harkActivityLabel(fields['narration']) ?? undefined } : {}),
            ...(patched.actions?.length ? { actions: patched.actions } : {}),
            ...(patched.artifacts?.length
              ? {
                  artifacts: [
                    ...(existing.artifacts ?? []),
                    ...patched.artifacts.filter(
                      (a) => !(existing.artifacts ?? []).some((e) => (e.s3Key || e.path) === (a.s3Key || a.path))
                    )
                  ]
                }
              : {}),
            ...(patched.toolCalls?.length ? { toolCalls: patched.toolCalls } : {})
          }
          if (nextStreaming === false) {
            delete updated.thought
            delete updated.narration
          }
          this.messages.set(id, updated)
          if (Object.keys(fields).some((key) => key !== 'narration' && key !== 'thought')) changed = true
          else activityChanged = true
        } else if (id) {
          this.messages.set(id, normalizeSyncMessage(id, fields))
          if (!this.order.includes(id)) this.order.push(id)
          changed = true
        }
      } else if (op === 'tool_add') {
        const id = String(p['id'] ?? p['messageId'] ?? '')
        const val = (p['value'] ?? {}) as Record<string, unknown>
        const existing = this.messages.get(id)
        if (existing) {
          const dispatchId = String(val['dispatchId'] ?? val['dispatch_id'] ?? '')
          const name = String(val['toolName'] ?? val['tool_name'] ?? val['type'] ?? 'tool')
          const status = String(val['status'] ?? 'running')
          const input = (val['input'] ?? {}) as Record<string, unknown>
          const progressMeta = ((val['progress'] as Record<string, unknown> | undefined)?.['metadata'] ?? {}) as Record<string, unknown>
          const prevTools = existing.toolCalls ?? []
          const extraArts = extractHarkArtifactsFromRaw(val)
          const nextArts = mergeHarkArtifacts(existing.artifacts, extraArts)
          // GOXF: Hark's web app never shows the model's private "Thinking" step; skip it here too.
          if (dispatchId && !/^thinking$/i.test(name) && !prevTools.some((t) => t.dispatchId === dispatchId)) {
            this.messages.set(id, {
              ...existing,
              ...(nextArts ? { artifacts: nextArts } : {}),
              toolCalls: [
                ...prevTools,
                {
                  dispatchId,
                  name,
                  status,
                  url: String(input['url'] ?? progressMeta['url'] ?? '') || undefined,
                  screenshotKey: String(val['screenshotKey'] ?? progressMeta['screenshot_key'] ?? '') || undefined,
                  screenshotUrl: String(val['screenshotUrl'] ?? progressMeta['screenshot_url'] ?? '') || undefined,
                  command: String(input['command'] ?? progressMeta['command'] ?? '') || undefined,
                  detail: harkToolDetail(input, progressMeta, val['progress'] as Record<string, unknown> | undefined)
                }
              ]
            })
            changed = true
          } else if (nextArts && nextArts !== existing.artifacts) {
            this.messages.set(id, { ...existing, artifacts: nextArts })
            changed = true
          }
        }
      } else if (op === 'tool_update') {
        const id = String(p['id'] ?? p['messageId'] ?? '')
        const dispatchId = String(p['dispatchId'] ?? '')
        const fields = (p['fields'] ?? {}) as Record<string, unknown>
        const existing = this.messages.get(id)
        if (existing) {
          const extraArts = extractHarkArtifactsFromRaw(fields)
          const nextArts = mergeHarkArtifacts(existing.artifacts, extraArts)
          const hasToolMatch = Boolean(existing.toolCalls?.some((tc) => tc.dispatchId === dispatchId))
          if (hasToolMatch || (nextArts && nextArts !== existing.artifacts)) {
            this.messages.set(id, {
              ...existing,
              ...(nextArts ? { artifacts: nextArts } : {}),
              ...(existing.toolCalls
                ? {
                    toolCalls: existing.toolCalls.map((tc) =>
                      tc.dispatchId === dispatchId
                        ? {
                            ...tc,
                            status: String(fields['status'] ?? tc.status),
                            screenshotKey: String(fields['screenshotKey'] ?? tc.screenshotKey ?? '') || undefined,
                            screenshotUrl: String(fields['screenshotUrl'] ?? tc.screenshotUrl ?? '') || undefined,
                            detail:
                              tc.detail ??
                              harkToolDetail(
                                fields['input'] as Record<string, unknown> | undefined,
                                ((fields['progress'] as Record<string, unknown> | undefined)?.['metadata'] ?? undefined) as
                                  | Record<string, unknown>
                                  | undefined,
                                fields['progress'] as Record<string, unknown> | undefined
                              )
                          }
                        : tc
                    )
                  }
                : {})
            })
            changed = true
          }
        }
      } else if (op === 'narration_update') {
        this.narration = harkActivityLabel(p['value'])
        this.narrationWorking = harkNarrationWorking(p['value'], Boolean(this.narration) || this.narrationWorking)
        activityChanged = true
      } else if (op === 'active_activity_set') {
        this.activeActivity = harkActivityLabel(p['value'])
        activityChanged = true
      } else if (op === 'request_update' || op === 'request_add') {
        const id = String(p['id'] ?? '')
        const val = (p['value'] ?? p['fields'] ?? {}) as Record<string, unknown>
        if (id) this.requests.set(id, { ...(this.requests.get(id) ?? {}), ...val })
        activityChanged = true
      } else if (/active_?work/i.test(op)) {
        this.activeWork = /clear|remove|delete/i.test(op) ? null : (p['value'] ?? p['fields'] ?? null)
        activityChanged = true
      } else if (/narration/i.test(op)) {
        // GOXF: tolerate renamed ops (narration_set / narration_clear …).
        this.narration = /clear|remove|delete/i.test(op) ? null : harkActivityLabel(p['value'] ?? p['text'])
        activityChanged = true
      } else if (/activ(e_)?ity/i.test(op)) {
        this.activeActivity = /clear|remove|delete/i.test(op) ? null : harkActivityLabel(p['value'] ?? p['text'])
        activityChanged = true
      }
    }
    if (changed) this.historyRevision++
    return changed || activityChanged
  }

  /** GOXF: what Hark's web app shows under the chat while it works ("正在使用我的电脑"). */
  liveStatus(): { busy: boolean; text: string } {
    const streaming = [...this.order]
      .reverse()
      .map((id) => this.messages.get(id))
      .find((m) => m && m.isStreaming && !/^user$/i.test(m.role))
    // GOXF: between turns Hark can still be waiting on a background job (「正在等待构建完成」):
    // the last reply keeps a running tool call, or a browser/task panel stays active.
    const lastReply = [...this.order]
      .reverse()
      .map((id) => this.messages.get(id))
      .find((m) => m && !/^user$/i.test(m.role))
    const backgroundLine = streaming ? '' : harkRunningToolLine(lastReply) || this.activePanelLine()
    const text = (
      this.narration ||
      this.activeActivity ||
      streaming?.narration ||
      harkRunningToolLine(streaming) ||
      backgroundLine ||
      ''
    ).trim()
    const work = harkHasWork(this.activeWork)
    const line = text || (work ? harkWorkLine(this.activeWork) : '')
    return { busy: Boolean(line || streaming || this.narrationWorking), text: line.slice(0, 120) }
  }

  private activePanelLine(): string {
    const p = this.extractPanels().find((x) => /^(active|running|pending|started|in_progress|waiting)$/i.test(x.status))
    if (!p) return ''
    const verb = /browser/i.test(p.kind) ? '正在用浏览器' : /shell|terminal|command/i.test(p.kind) ? '正在运行命令' : '正在执行'
    return p.title ? `${verb}：${p.title}` : `${verb}…`
  }

  orderedMessages(): HarkChatMessage[] {
    return this.order.map((id) => this.messages.get(id)!).filter(Boolean)
  }

  extractPanels(): HarkActivityPanel[] {
    const out = new Map<string, HarkActivityPanel>()
    const pushPanel = (raw: Record<string, unknown>) => {
      const dispatchId = String(raw['dispatchId'] ?? raw['id'] ?? `panel_${out.size}`)
      if (out.has(dispatchId)) return
      const screenshot = (raw['screenshot'] ?? {}) as Record<string, unknown>
      out.set(dispatchId, {
        dispatchId,
        kind: String(raw['kind'] ?? raw['type'] ?? 'browser'),
        status: String(raw['status'] ?? 'active'),
        title: String(raw['title'] ?? raw['label'] ?? raw['objective'] ?? '') || undefined,
        url: String(raw['url'] ?? '') || undefined,
        liveViewUrl: String(raw['liveViewUrl'] ?? '') || undefined,
        screenshotKey: String(screenshot['key'] ?? raw['screenshotKey'] ?? '') || undefined,
        screenshotUrl: String(screenshot['downloadUrl'] ?? raw['screenshotUrl'] ?? raw['previewUrl'] ?? '') || undefined,
        command: String(raw['command'] ?? '') || undefined
      })
    }
    for (const panels of this.panelsByWindow.values()) {
      for (const panel of panels.values()) pushPanel(panel)
    }
    for (const m of this.messages.values()) {
      for (const tc of m.toolCalls ?? []) {
        if (tc.screenshotKey || tc.screenshotUrl || tc.url || tc.command || /browser|computer|shell|coding/i.test(tc.name)) {
          const panel = out.get(tc.dispatchId)
          if (panel) {
            if (!panel.screenshotKey && !panel.screenshotUrl) {
              panel.screenshotKey = tc.screenshotKey
              panel.screenshotUrl = tc.screenshotUrl
            }
            continue
          }
          out.set(tc.dispatchId, {
            dispatchId: tc.dispatchId,
            kind: tc.name,
            status: tc.status,
            url: tc.url,
            screenshotKey: tc.screenshotKey,
            screenshotUrl: tc.screenshotUrl,
            command: tc.command,
            fromToolCall: true
          })
        }
      }
    }
    return [...out.values()]
  }

  extractAsks(): HarkPendingAsk[] {
    const out: HarkPendingAsk[] = []
    for (const [id, raw] of this.asks.entries()) {
      const req = (raw['request'] ?? raw['userInputRequest'] ?? raw) as Record<string, unknown>
      const status = String(raw['status'] ?? 'pending')
      out.push({
        id,
        dispatchId: String(raw['dispatchId'] ?? '') || undefined,
        requestId: String(req['requestId'] ?? id) || undefined,
        displayHint: String(req['displayHint'] ?? '') || undefined,
        prompt: String(req['prompt'] ?? req['title'] ?? req['message'] ?? '') || undefined,
        domain: String(req['domain'] ?? '') || undefined,
        status,
        raw
      })
    }
    return out
  }

  extractArtifacts(): HarkConversationSnapshotSummary['artifacts'] {
    const out: HarkConversationSnapshotSummary['artifacts'] = []
    const seen = new Set<string>()
    for (const m of this.messages.values()) {
      for (const a of m.artifacts ?? []) {
        const key = a.s3Key || a.path
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push({
          name: a.name || a.path.split('/').pop() || a.path,
          path: a.path,
          s3Key: a.s3Key,
          downloadUrl: a.downloadUrl,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes
        })
      }
    }
    return out
  }
}

/** Link cards from a `links` presentation block (`{ kind: 'links', links: [{ url, name, label, image_url }] }`). */
export function harkPresentationLinks(presRaw: unknown): NonNullable<HarkChatMessage['links']> {
  if (!presRaw || typeof presRaw !== 'object') return []
  const pres = presRaw as Record<string, unknown>
  if (String(pres['kind'] ?? '').toLowerCase() !== 'links') return []
  const block = pres['links']
  const items = Array.isArray(block)
    ? block
    : block && typeof block === 'object' && Array.isArray((block as Record<string, unknown>)['items'])
      ? ((block as Record<string, unknown>)['items'] as unknown[])
      : []
  const str = (o: Record<string, unknown>, ...keys: string[]) => {
    for (const k of keys) if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim()
    return undefined
  }
  const out: NonNullable<HarkChatMessage['links']> = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const url = str(o, 'url', 'href')
    if (!url || !/^https?:\/\//i.test(url)) continue
    out.push({
      url,
      name: str(o, 'name', 'title'),
      label: str(o, 'label', 'role'),
      imageUrl: str(o, 'image_url', 'imageUrl', 'image')
    })
  }
  return out
}

/** True when `text` is nothing but these URLs (Hark's plain-text fallback for a links block). */
function onlyUrls(text: string, links: Array<{ url: string }>): boolean {
  let rest = text
  for (const l of links) rest = rest.split(l.url).join(' ')
  return rest.replace(/[\s\-*•·,，、]+/g, '') === ''
}

function formatPresentationMarkdown(presRaw: unknown): string {
  if (!presRaw || typeof presRaw !== 'object') return ''
  const pres = presRaw as Record<string, unknown>
  const kind = String(pres['kind'] ?? '')

  if (kind === 'summary' && pres['summary'] && typeof pres['summary'] === 'object') {
    const s = pres['summary'] as Record<string, unknown>
    const title = typeof s['title'] === 'string' && s['title'].trim() ? `### ${s['title'].trim()}\n\n` : ''
    const md = typeof s['markdown'] === 'string' ? s['markdown'].trim() : ''
    return md ? `${title}${md}` : ''
  }

  if (
    (kind === 'document' || kind === 'markdown' || kind === 'article' || kind === 'report') &&
    (pres[kind] || pres['document'] || pres['markdown'])
  ) {
    const d = (pres[kind] ?? pres['document'] ?? pres) as Record<string, unknown>
    const title = typeof d['title'] === 'string' && d['title'].trim() ? `# ${d['title'].trim()}\n\n` : ''
    const md =
      typeof d['markdown'] === 'string'
        ? d['markdown'].trim()
        : typeof d['content'] === 'string'
          ? d['content'].trim()
          : typeof d['body'] === 'string'
            ? d['body'].trim()
            : ''
    return md ? `${title}${md}` : ''
  }

  if (kind === 'code' && pres['code'] && typeof pres['code'] === 'object') {
    const c = pres['code'] as Record<string, unknown>
    const lang = typeof c['language'] === 'string' ? c['language'].trim() : ''
    const src = typeof c['source'] === 'string' ? c['source'] : ''
    return src ? `\`\`\`${lang}\n${src}\n\`\`\`` : ''
  }

  if (kind === 'text_template' && pres['text_template'] && typeof pres['text_template'] === 'object') {
    const t = pres['text_template'] as Record<string, unknown>
    const title = typeof t['title'] === 'string' && t['title'].trim() ? `**${t['title'].trim()}**\n\n` : ''
    const body = typeof t['body'] === 'string' ? t['body'].trim() : ''
    return body ? `${title}${body}` : ''
  }

  if (kind === 'links' && Array.isArray(pres['links'])) {
    const lines: string[] = []
    for (const item of pres['links'] as Array<Record<string, unknown>>) {
      if (!item || typeof item !== 'object') continue
      const url = typeof item['url'] === 'string' ? item['url'].trim() : ''
      if (!url) continue
      const label =
        (typeof item['title'] === 'string' && item['title'].trim()) ||
        (typeof item['label'] === 'string' && item['label'].trim()) ||
        url
      lines.push(`- [${label}](${url})`)
    }
    return lines.join('\n')
  }

  if (kind === 'table' && pres['table'] && typeof pres['table'] === 'object') {
    const tbl = pres['table'] as Record<string, unknown>
    const cols = Array.isArray(tbl['columns']) ? (tbl['columns'] as unknown[]).map((c) => String(c ?? '')) : []
    const rows = Array.isArray(tbl['rows']) ? (tbl['rows'] as unknown[][]) : []
    if (cols.length > 0) {
      const title = typeof tbl['title'] === 'string' && tbl['title'].trim() ? `### ${tbl['title'].trim()}\n\n` : ''
      const header = `| ${cols.join(' | ')} |`
      const sep = `| ${cols.map(() => '---').join(' | ')} |`
      const body = rows
        .map((r) => `| ${(Array.isArray(r) ? r : []).map((cell) => String(cell ?? '').replace(/\|/g, '\\|')).join(' | ')} |`)
        .join('\n')
      return `${title}${header}\n${sep}${body ? `\n${body}` : ''}`
    }
  }

  return ''
}

type HarkArtifactItem = NonNullable<HarkChatMessage['artifacts']>[number]

function mergeHarkArtifacts(
  existing: HarkArtifactItem[] | undefined,
  incoming: HarkArtifactItem[]
): HarkArtifactItem[] | undefined {
  if (incoming.length === 0) return existing
  const out = [...(existing ?? [])]
  const seen = new Set(out.map((a) => a.s3Key || a.downloadUrl || a.path))
  let changed = false
  for (const item of incoming) {
    const key = item.s3Key || item.downloadUrl || item.path
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
    changed = true
  }
  return changed ? out : existing
}

function extractHarkArtifactsFromRaw(raw: Record<string, unknown>): HarkArtifactItem[] {
  const out: HarkArtifactItem[] = []
  const seen = new Set<string>()
  const push = (item: HarkArtifactItem) => {
    const key = item.s3Key || item.downloadUrl || item.path
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(item)
  }

  const pushEntry = (entry: unknown, defaultKindMime?: string) => {
    if (!entry) return
    if (typeof entry === 'string') {
      const s = entry.trim()
      if (!s) return
      const isHttp = /^https?:\/\//i.test(s)
      const name = s.split(/[?#]/, 1)[0]?.split('/').pop() || s
      push({
        name,
        path: s,
        s3Key: isHttp ? undefined : s,
        downloadUrl: isHttp ? s : undefined,
        mimeType: guessMediaMimeFromName(name) || defaultKindMime
      })
      return
    }
    if (typeof entry !== 'object' || Array.isArray(entry)) return
    const o = entry as Record<string, unknown>
    const s3Key =
      (typeof o['s3Key'] === 'string' && o['s3Key']) ||
      (typeof o['s3_key'] === 'string' && o['s3_key']) ||
      (typeof o['key'] === 'string' && o['key']) ||
      (typeof o['imageKey'] === 'string' && o['imageKey']) ||
      (typeof o['videoKey'] === 'string' && o['videoKey']) ||
      undefined
    const downloadUrl =
      (typeof o['downloadUrl'] === 'string' && o['downloadUrl']) ||
      (typeof o['download_url'] === 'string' && o['download_url']) ||
      (typeof o['previewUrl'] === 'string' && o['previewUrl']) ||
      (typeof o['preview_url'] === 'string' && o['preview_url']) ||
      (typeof o['imageUrl'] === 'string' && o['imageUrl']) ||
      (typeof o['image_url'] === 'string' && o['image_url']) ||
      (typeof o['videoUrl'] === 'string' && o['videoUrl']) ||
      (typeof o['video_url'] === 'string' && o['video_url']) ||
      (typeof o['mediaUrl'] === 'string' && o['mediaUrl']) ||
      (typeof o['media_url'] === 'string' && o['media_url']) ||
      (typeof o['url'] === 'string' && /^https?:\/\//i.test(o['url']) ? o['url'] : undefined) ||
      undefined
    const rawPath =
      (typeof o['path'] === 'string' && o['path']) ||
      (typeof o['filePath'] === 'string' && o['filePath']) ||
      (typeof o['file_path'] === 'string' && o['file_path']) ||
      (typeof o['name'] === 'string' && o['name']) ||
      downloadUrl ||
      s3Key ||
      ''
    if (!rawPath && !s3Key && !downloadUrl) return
    const name =
      (typeof o['name'] === 'string' && o['name']) ||
      (typeof o['filename'] === 'string' && o['filename']) ||
      (typeof o['title'] === 'string' && o['title']) ||
      rawPath.split(/[?#]/, 1)[0]?.split('/').pop() ||
      'artifact'
    const rawMime =
      (typeof o['mediaType'] === 'string' && o['mediaType']) ||
      (typeof o['media_type'] === 'string' && o['media_type']) ||
      (typeof o['mimeType'] === 'string' && o['mimeType']) ||
      (typeof o['mime_type'] === 'string' && o['mime_type']) ||
      (typeof o['contentType'] === 'string' && o['contentType']) ||
      (typeof o['content_type'] === 'string' && o['content_type']) ||
      undefined
    const mimeType = rawMime || guessMediaMimeFromName(name || rawPath) || defaultKindMime
    const sizeBytes =
      typeof o['size'] === 'number'
        ? o['size']
        : typeof o['sizeBytes'] === 'number'
          ? o['sizeBytes']
          : typeof o['size_bytes'] === 'number'
            ? o['size_bytes']
            : undefined
    push({
      name,
      path: rawPath || s3Key || downloadUrl!,
      s3Key,
      downloadUrl,
      mimeType,
      sizeBytes
    })
  }

  const listKeys: Array<[string, string | undefined]> = [
    ['artifactKeys', undefined],
    ['artifact_keys', undefined],
    ['artifacts', undefined],
    ['attachments', undefined],
    ['files', undefined],
    ['media', undefined],
    ['imageStack', 'image/png'],
    ['image_stack', 'image/png'],
    ['images', 'image/png'],
    ['videos', 'video/mp4']
  ]
  for (const [k, defMime] of listKeys) {
    const val = raw[k]
    if (Array.isArray(val)) {
      for (const item of val) pushEntry(item, defMime)
    } else if (val && typeof val === 'object') {
      const objVal = val as Record<string, unknown>
      if (Array.isArray(objVal['items'])) {
        for (const item of objVal['items']) pushEntry(item, defMime)
      } else if (Array.isArray(objVal['images'])) {
        for (const item of objVal['images']) pushEntry(item, 'image/png')
      } else {
        pushEntry(objVal, defMime)
      }
    }
  }

  // Presentation media payloads (image / gallery / image_stack / video / audio / file / artifact)
  const pres = raw['presentation']
  if (pres && typeof pres === 'object' && !Array.isArray(pres)) {
    const p = pres as Record<string, unknown>
    const kind = String(p['kind'] ?? '').toLowerCase()
    const isMediaKind = /^(image|images|image_stack|gallery|video|audio|media|file|artifact)$/i.test(kind)
    const nested = isMediaKind ? (p[kind] ?? p) : undefined
    if (nested && typeof nested === 'object') {
      const defMime =
        kind.includes('image') || kind === 'gallery'
          ? 'image/png'
          : kind === 'video'
            ? 'video/mp4'
            : kind === 'audio'
              ? 'audio/mpeg'
              : undefined
      if (Array.isArray(nested)) {
        for (const item of nested) pushEntry(item, defMime)
      } else {
        const no = nested as Record<string, unknown>
        for (const sub of ['items', 'images', 'videos', 'files', 'media', 'artifacts']) {
          if (Array.isArray(no[sub])) {
            for (const item of no[sub] as unknown[]) {
              pushEntry(item, sub === 'videos' ? 'video/mp4' : sub === 'images' ? 'image/png' : defMime)
            }
          }
        }
        pushEntry(no, defMime)
      }
    }
  }

  return out
}

// The real key name is unverified; accept every spelling seen across chat APIs.
const REPLY_KEYS = ['replyTo', 'reply_to', 'replyToId', 'reply_to_id', 'inReplyTo', 'in_reply_to', 'replyToMessageId', 'parentMessageId']

export function harkReplyRef(raw: Record<string, unknown>): HarkChatMessage['replyTo'] {
  for (const key of REPLY_KEYS) {
    const v = raw[key]
    if (typeof v === 'string' && v) return { id: v }
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const id = [o['id'], o['messageId'], o['_id']].find((x) => typeof x === 'string' && x) as string | undefined
    const text = [o['text'], o['content']].find((x) => typeof x === 'string' && x.trim()) as string | undefined
    if (id || text) return { ...(id ? { id } : {}), ...(text ? { text } : {}) }
  }
  return undefined
}

/** One-line quote of a reply target: its text, else what it carried. */
export function harkReplySnippet(text: string, media?: Array<{ kind: string; name?: string }>): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat) return flat
  const part = media?.[0]
  if (!part) return ''
  return part.kind === 'image' ? '[图片]' : `[文件] ${part.name ?? ''}`.trim()
}

let loggedMessageKeys = false

export function normalizeSyncMessage(id: string, raw: Record<string, unknown>): HarkChatMessage {
  const role = String(raw['role'] ?? raw['author'] ?? 'assistant')
  // Patches carry no role, so this logs the first full assistant message (lets the user confirm the reply key).
  if (!loggedMessageKeys && (raw['role'] ?? raw['author']) && !/^user$/i.test(role)) {
    loggedMessageKeys = true
    console.log('[hark] message keys:', Object.keys(raw).sort().join(','))
  }
  const replyTo = harkReplyRef(raw)
  const triggeredBy = typeof raw['triggeredByMessageId'] === 'string' ? raw['triggeredByMessageId'] : undefined
  const rawContent =
    (typeof raw['content'] === 'string' && raw['content']) ||
    (typeof raw['text'] === 'string' && raw['text']) ||
    (typeof raw['message'] === 'string' && raw['message']) ||
    ''
  const presLinks = harkPresentationLinks(raw['presentation'])
  const presMarkdown = presLinks.length ? '' : formatPresentationMarkdown(raw['presentation'])
  // A links block's text is just its URLs: the cards show them, so drop the bare-URL bubble.
  const content = presLinks.length && onlyUrls(rawContent, presLinks)
    ? ''
    : rawContent.trim() ? rawContent : presMarkdown || rawContent

  const actionsRaw = Array.isArray(raw['actions']) ? (raw['actions'] as Record<string, unknown>[]) : []
  const actions = actionsRaw
    .map((a) => ({
      kind: String(a['kind'] ?? ''),
      connector: typeof a['connector'] === 'string' ? a['connector'] : undefined,
      label: String(a['label'] ?? a['connector'] ?? 'Connect'),
      scopes: typeof a['scopes'] === 'string' ? a['scopes'] : undefined
    }))
    .filter((a) => a.kind)

  const toolCallsRaw = Array.isArray(raw['toolCalls']) ? (raw['toolCalls'] as Record<string, unknown>[]) : []
  const toolCalls: NonNullable<HarkChatMessage['toolCalls']> = []
  let artifacts: HarkArtifactItem[] = []

  for (const tc of toolCallsRaw) {
    if (!tc || typeof tc !== 'object') continue
    const dispatchId = String(tc['dispatchId'] ?? tc['dispatch_id'] ?? '')
    const name = String(tc['toolName'] ?? tc['tool_name'] ?? tc['type'] ?? 'tool')
    if (/^thinking$/i.test(name)) continue
    const status = String(tc['status'] ?? 'completed')
    const input = (tc['input'] ?? {}) as Record<string, unknown>
    const progressMeta = ((tc['progress'] as Record<string, unknown> | undefined)?.['metadata'] ?? {}) as Record<
      string,
      unknown
    >
    toolCalls.push({
      dispatchId: dispatchId || `tc_${toolCalls.length}`,
      name,
      status,
      url: String(input['url'] ?? progressMeta['url'] ?? '') || undefined,
      screenshotKey: String(tc['screenshotKey'] ?? progressMeta['screenshot_key'] ?? '') || undefined,
      screenshotUrl: String(tc['screenshotUrl'] ?? progressMeta['screenshot_url'] ?? '') || undefined,
      command: String(input['command'] ?? progressMeta['command'] ?? '') || undefined,
      result: typeof tc['result'] === 'string' ? tc['result'].slice(0, 500) : undefined,
      detail: harkToolDetail(input, progressMeta, tc['progress'] as Record<string, unknown> | undefined)
    })

    artifacts = mergeHarkArtifacts(artifacts, extractHarkArtifactsFromRaw(tc)) ?? artifacts
  }

  // Message-level attachments, imageStack, images, videos, files, artifacts, presentation media
  artifacts = mergeHarkArtifacts(artifacts, extractHarkArtifactsFromRaw(raw)) ?? artifacts

  const aawRaw = Array.isArray(raw['agentActivityWindow']) ? (raw['agentActivityWindow'] as Record<string, unknown>[]) : []
  for (const p of aawRaw) {
    if (!p || typeof p !== 'object') continue
    const screenshot = (p['screenshot'] ?? {}) as Record<string, unknown>
    toolCalls.push({
      dispatchId: String(p['dispatchId'] ?? `aaw_${toolCalls.length}`),
      name: String(p['kind'] ?? 'browser'),
      status: String(p['status'] ?? 'completed'),
      url: typeof p['url'] === 'string' ? p['url'] : typeof p['liveViewUrl'] === 'string' ? p['liveViewUrl'] : undefined,
      screenshotKey: typeof screenshot['key'] === 'string' ? screenshot['key'] : undefined,
      screenshotUrl: typeof screenshot['downloadUrl'] === 'string' ? screenshot['downloadUrl'] : undefined,
      command: typeof p['command'] === 'string' ? p['command'] : undefined,
      detail: harkToolDetail(p)
    })
  }

  const jobStatus = typeof raw['jobStatus'] === 'string' ? raw['jobStatus'] : undefined
  const errorText = typeof raw['error'] === 'string' ? raw['error'] : undefined

  return {
    id,
    role,
    content: content || (errorText ? `⚠️ ${errorText}` : ''),
    isStreaming: typeof raw['isStreaming'] === 'boolean' ? raw['isStreaming'] : undefined,
    ...(jobStatus ? { jobStatus } : {}),
    ...(errorText ? { error: errorText } : {}),
    thought: typeof raw['thought'] === 'string' ? raw['thought'] : undefined,
    narration: harkActivityLabel(raw['narration']) ?? undefined,
    createdAt: (raw['timestamp'] ?? raw['createdAt'] ?? raw['created_at'] ?? raw['createdAtMs'] ?? null) as
      | string
      | number
      | null,
    ...(replyTo ? { replyTo } : {}),
    ...(triggeredBy ? { triggeredBy } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(actions.length ? { actions } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(presLinks.length ? { links: presLinks } : {})
  }
}

type HarkReplyOutcome = 'completed' | 'cancelled' | 'failed' | 'timed-out'

function harkJobOutcome(status: unknown): Exclude<HarkReplyOutcome, 'timed-out'> | undefined {
  if (typeof status !== 'string') return undefined
  if (/^(completed|succeeded)$/i.test(status)) return 'completed'
  if (/^(cancelled|canceled|interrupted)$/i.test(status)) return 'cancelled'
  if (/^(failed|error|errored|cost_capped)$/i.test(status)) return 'failed'
  return undefined
}

function harkReplyOutcome(msg: HarkChatMessage): ReturnType<typeof harkJobOutcome> {
  if (msg.jobStatus) return harkJobOutcome(msg.jobStatus)
  if (msg.isStreaming === true) return undefined
  if (msg.error) return 'failed'
  if (
    Boolean(msg.content.trim()) ||
    Boolean(msg.actions?.length) ||
    Boolean(msg.artifacts?.length) ||
    Boolean(
      msg.toolCalls?.length &&
      msg.toolCalls.every((tc) => !/^(running|pending|active|started|waiting_for_input|awaiting_input)$/i.test(tc.status))
    )
  ) return 'completed'
  return undefined
}

/** GOXF: whether Hark's narration object says a turn is still working (string forms keep `fallback`). */
export function harkNarrationWorking(v: unknown, fallback: boolean): boolean {
  if (v === null || v === undefined || v === '') return false
  let o: unknown = v
  if (typeof v === 'string' && v.startsWith('{')) {
    try {
      o = JSON.parse(v)
    } catch {
      return fallback
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return fallback
  const r = o as Record<string, unknown>
  if (r['answered'] === true || r['working'] === false) return false
  if (r['working'] === true || r['live'] === true) return true
  return fallback
}

/** Hark sends activity / narration as a plain string or as `{ line | label | text | type }`. */
/** GOXF: activeWork is [{ dispatchId, messageId, site?, state: 'working', expiresAt }]. */
export function harkWorkLine(v: unknown): string {
  const list = (Array.isArray(v) ? v : [v]).filter(harkHasWork) as Array<Record<string, unknown>>
  const site = list.map((w) => w?.['site']).find((x) => typeof x === 'string' && x)
  if (list.length > 1) return `后台 ${list.length} 个任务进行中${site ? `（含 ${site}）` : ''}`
  return site ? `正在打开 ${site}` : '后台任务进行中…'
}

/** GOXF: Hark's activeWork counts only when it holds something (null / {} / [] = idle). */
export function harkHasWork(v: unknown): boolean {
  if (v == null || v === false || v === '') return false
  if (Array.isArray(v)) return v.some(harkHasWork)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o['status'] === 'string' && /complete|done|finish|fail|cancel|idle/i.test(o['status'])) return false
    if (o['working'] === false || o['active'] === false) return false
    return Object.values(o).some(harkHasWork)
  }
  return true
}

export function harkActivityLabel(v: unknown): string | null {
  if (typeof v === 'string') {
    if (/^\s*[[{]/.test(v)) {
      try {
        return harkActivityLabel(JSON.parse(v))
      } catch {
        // a plain sentence that happens to start with a bracket
      }
    }
    return v || null
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      const label = harkActivityLabel(item)
      if (label) return label
    }
    return null
  }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  // Hark's narration is { line, lineKey, live, visible, working, answered, since, messageId }.
  if (o['answered'] === true || o['working'] === false) return null
  const s = o['line'] ?? o['label'] ?? o['text'] ?? o['value'] ?? o['type']
  return typeof s === 'string' && s ? s : null
}

const HARK_STREAM_IDLE_MS = 15_000

export async function readHarkStream(
  ses: Session, conversationId: string, manager: string, dial: string, signal: AbortSignal,
  onFrame: (data: string) => void,
  idleMs = HARK_STREAM_IDLE_MS,
  keepAliveOnHeartbeat = false
): Promise<void> {
  const idle = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const resetIdle = () => {
    clearTimeout(timer)
    timer = setTimeout(() => idle.abort(), idleMs)
  }
  const streamSignal = AbortSignal.any([signal, idle.signal])
  const url = new URL(HARK_API_BASE + '/sync/conversation')
  url.search = new URLSearchParams({ conversationId, manager, dial, v: '2', mode: 'in_tab', ids: '1', beat: '5' }).toString()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancel = () => { void reader?.cancel().catch(() => undefined) }
  streamSignal.addEventListener('abort', cancel, { once: true })
  resetIdle()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventType = 'message'
  let lines: string[] = []
  try {
    streamSignal.throwIfAborted()
    const response = await ses.fetch(url.toString(), { credentials: 'include', signal: streamSignal, headers: harkClientHeaders({
      Accept: 'text/event-stream', 'Cache-Control': 'no-cache'
    }) })
    reader = response.body?.getReader()
    if (!response.ok || !reader || !response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('Hark project stream unavailable')
    }
    while (!streamSignal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      if (keepAliveOnHeartbeat) resetIdle()
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while (!streamSignal.aborted && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (!line) {
          if (eventType === 'message' && lines.length) {
            resetIdle()
            onFrame(lines.join('\n'))
          }
          eventType = 'message'
          lines = []
        } else if (line.startsWith('event:')) eventType = line.slice(6).trim()
        else if (line.startsWith('data:')) lines.push(line.slice(5).trimStart())
      }
    }
    streamSignal.throwIfAborted()
  } finally {
    clearTimeout(timer)
    streamSignal.removeEventListener('abort', cancel)
    await reader?.cancel().catch(() => undefined)
    reader?.releaseLock()
  }
}

const activeHarkWatches = new HarkWatchRegistry()

export function registerHarkViewStop(accountId: string, stop: () => void): () => void {
  const token = activeHarkWatches.add(accountId, stop)
  return () => activeHarkWatches.remove(accountId, token)
}

/** Stop reply watches on pause or sign-out. */
export function cancelHarkWatch(accountId: string, conversationId?: string): void {
  if (conversationId) activeHarkWatches.cancelConversation(accountId, conversationId)
  else activeHarkWatches.cancelAll(accountId)
}

/**
 * Stream `/api/sync/conversation` SSE (or fallback `/api/sync/poll`) until the
 * assistant reply for `responseMessageId` (or any new assistant message) completes!
 */
export async function watchHarkConversationSync(
  accountId: string,
  conversationId: string,
  opts: {
    responseMessageId?: string
    afterMessageIds?: Set<string>
    timeoutMs?: number
    idleTimeoutMs?: number
    signal?: AbortSignal
    onUpdate?: (msg: HarkChatMessage, state: HarkConversationSyncState, done: boolean) => void
    /**
     * GOXF: when set, return as soon as the reply is done but keep the stream
     * open while Hark's turn stays busy; called on every change and once with
     * `ended` when the watch stops (idle, cap, or cancelled).
     */
    onTail?: (state: HarkConversationSyncState, ended: boolean) => void
  } = {}
): Promise<{ outcome: HarkReplyOutcome; reply: HarkChatMessage | null; error?: string; tailing: boolean }> {
  const managerId = randomUUID()
  const timeout = new AbortController()
  let timer = setTimeout(() => timeout.abort(), opts.timeoutMs ?? 90_000)
  const ac = new AbortController()
  const signal = AbortSignal.any([ac.signal, timeout.signal, ...(opts.signal ? [opts.signal] : [])])
  const syncState = new HarkConversationSyncState()
  const afterIds = opts.afterMessageIds ?? new Set<string>()
  let targetId = opts.responseMessageId
  let lastText = ''
  let usingPoll = false
  const result: { outcome?: HarkReplyOutcome; reply: HarkChatMessage | null; error?: string } = { reply: null }
  let tailing = false
  let lastBusyAt = 0
  let tick: ReturnType<typeof setInterval> | undefined
  let replyDone: () => void = () => {}
  const replyDonePromise = new Promise<void>((resolve) => (replyDone = resolve))
  const tailCheck = (): void => {
    if (harkTurnBusy(syncState, afterIds)) lastBusyAt = Date.now()
    if (Date.now() - lastBusyAt > HARK_TAIL_IDLE_MS) ac.abort()
    else opts.onTail?.(syncState, false)
  }

  const watchToken = activeHarkWatches.add(accountId, () => ac.abort(), targetId, conversationId)

  // GOXF: the timeout is for silence, not for a long turn. While Hark is visibly
  // working (a status line, a tool running) the wait restarts, up to the tail cap.
  const waitCap = Date.now() + HARK_TAIL_CAP_MS
  const keepAlive = setInterval(() => {
    if (tailing || signal.aborted || Date.now() > waitCap || !harkTurnBusy(syncState, afterIds)) return
    clearTimeout(timer)
    timer = setTimeout(() => timeout.abort(), opts.timeoutMs ?? 90_000)
  }, 5_000)

  const hasPayloadOrActivity = (m?: HarkChatMessage): m is HarkChatMessage =>
    Boolean(
      m &&
        (m.jobStatus ||
          m.content.trim() ||
          m.isStreaming ||
          m.thought ||
          m.narration ||
          m.toolCalls?.length ||
          m.actions?.length ||
          m.artifacts?.length ||
          m.error)
    )

  const onFrame = (frame: string): void => {
    if (signal.aborted || !syncState.applyFrame(frame)) return
    if (tailing) return tailCheck()
    if (targetId === undefined) {
      const claimed = activeHarkWatches.claimedByOthers(accountId, watchToken)
      const id = syncState.order.findLast((id) => {
        const message = syncState.messages.get(id)
        return !afterIds.has(id) && !claimed.has(id) && hasPayloadOrActivity(message) &&
          /^(assistant|bot|hark)$/i.test(message.role)
      })
      if (id) {
        targetId = id
        activeHarkWatches.claim(accountId, watchToken, id)
      }
    }
    const candidate = targetId === undefined ? undefined : syncState.messages.get(targetId)
    if (hasPayloadOrActivity(candidate) && /^(assistant|bot|hark)$/i.test(candidate.role)) {
      const outcome = harkReplyOutcome(candidate)
      if (outcome) {
        result.outcome = outcome
        if (outcome === 'completed') {
          result.reply = candidate
          opts.onUpdate?.(candidate, syncState, true)
          if (opts.onTail) {
            // GOXF: the reply is done; keep watching while Hark's turn stays busy.
            tailing = true
            lastBusyAt = Date.now()
            clearTimeout(timer)
            timer = setTimeout(() => timeout.abort(), HARK_TAIL_CAP_MS)
            tick = setInterval(tailCheck, 5_000)
            activeHarkWatches.markTaken(accountId, candidate.id)
            replyDone()
            return
          }
        } else {
          result.error = candidate.error ?? candidate.jobStatus
        }
        ac.abort()
        return
      }
      // A first poll snapshot can lag behind the last SSE patch.
      if (usingPoll && candidate.content.length < lastText.length && lastText.startsWith(candidate.content)) {
        opts.onUpdate?.({ ...candidate, content: lastText }, syncState, false)
        return
      }
      lastText = candidate.content
      opts.onUpdate?.(candidate, syncState, false)
    } else if (syncState.narration || syncState.activeActivity) {
      opts.onUpdate?.(
        { id: targetId ?? 'hark_thinking', role: 'assistant', content: '', isStreaming: true },
        syncState,
        false
      )
    }
  }

  const runPollLoop = async (ses: Session): Promise<void> => {
    let cursor: string | undefined
    let floor: string | undefined
    let first = true
    const pollMgr = randomUUID()
    while (!signal.aborted) {
      try {
        const pollRes = await pollHarkConversation(ses, conversationId, pollMgr, { first, cursor, floor, signal })
        if (pollRes && Array.isArray(pollRes.frames)) {
          first = false
          if (pollRes.cursor) cursor = pollRes.cursor
          if (pollRes.floor) floor = pollRes.floor
          for (const frame of pollRes.frames) {
            onFrame(frame)
            if (signal.aborted) return
          }
        }
      } catch {
        /* ignore transient poll error */
      }
      // While tailing, the poll is only a slow fallback.
      if (!signal.aborted) await delay(tailing ? 5000 : 1200, undefined, { signal })
    }
  }

  const loops = (async () => {
    try {
      signal.throwIfAborted()
      const ses = await preparedSessionForAccount(accountId)
      try {
        await readHarkStream(ses, conversationId, managerId, 'initial', signal, onFrame, opts.idleTimeoutMs)
      } catch {
        // The SSE reader is closed before the poller can take over the reducer.
      }
      if (!signal.aborted) {
        usingPoll = true
        await runPollLoop(ses)
      }
    } catch (error) {
      if (!signal.aborted) throw error
    } finally {
      clearTimeout(timer)
      clearInterval(tick)
      clearInterval(keepAlive)
      ac.abort()
      if (result.reply) activeHarkWatches.markTaken(accountId, result.reply.id)
      activeHarkWatches.remove(accountId, watchToken)
      if (tailing) opts.onTail?.(syncState, true)
    }
  })()
  loops.catch(() => undefined) // a failure after the reply was returned has nobody to report to
  await Promise.race([loops, replyDonePromise])

  return {
    ...result,
    outcome: result.outcome ?? (timeout.signal.aborted ? 'timed-out' : 'cancelled'),
    // `tailing`: the reply is done but Hark's turn is still busy; the watch goes on in the background.
    tailing: tailing && !signal.aborted && harkTurnBusy(syncState, afterIds)
  }
}

export function conversationIdFromPayload(payload: unknown, allowMain = true): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const root = payload as Record<string, unknown>
  const conv = root['conversation']
  if (!allowMain && (Object.hasOwn(root, 'conversationId') || Object.hasOwn(root, 'conversation_id') || Object.hasOwn(root, 'conversation'))) {
    return harkProjectId(root['conversationId'] ?? root['conversation_id'] ?? (conv as { id?: unknown } | undefined)?.id)
  }
  const projectId = harkProjectId(root['conversationId']) ?? harkProjectId(root['conversation_id']) ??
    harkProjectId((conv as { id?: unknown } | undefined)?.id) ?? harkProjectId(root['id'])
  if (projectId) return projectId
  const main = root['main']
  if (allowMain && main && typeof main === 'object') {
    return harkProjectId((main as { id?: unknown }).id)
  }
  return undefined
}

export function extractMessages(payload: unknown): HarkChatMessage[] {
  if (!payload || typeof payload !== 'object') return []
  const root = payload as Record<string, unknown>
  let list: unknown[] = []
  if (Array.isArray(root['messages'])) list = root['messages'] as unknown[]
  else if (Array.isArray(root['items'])) list = root['items'] as unknown[]
  else if (root['conversation'] && typeof root['conversation'] === 'object') {
    const msgs = (root['conversation'] as { messages?: unknown }).messages
    if (Array.isArray(msgs)) list = msgs
  }
  const out: HarkChatMessage[] = []
  for (const item of list) {
    const raw = (item ?? {}) as Record<string, unknown>
    const id = String(raw['id'] ?? raw['messageId'] ?? raw['message_id'] ?? `${out.length}`)
    out.push(normalizeSyncMessage(id, raw))
  }
  return out
}

/** GOXF: when Hark gives no narration, say what its running tool does (「正在用浏览器：…」). */
export function harkRunningToolLine(msg: { toolCalls?: Array<{ name: string; status: string; detail?: string; url?: string; command?: string }> } | undefined): string {
  const tc = [...(msg?.toolCalls ?? [])].reverse().find((t) => /^(running|pending|active|started|in_progress|waiting_for_input|awaiting_input)$/i.test(t.status))
  if (!tc) return ''
  const n = tc.name.toLowerCase()
  const verb = /browser/.test(n) ? '正在用浏览器' : /shell|command|exec/.test(n) ? '正在运行命令' : /search/.test(n) ? '正在搜索' : /fetch/.test(n) ? '正在读取网页' : /subagent|agent/.test(n) ? '正在派子任务' : /file|write|edit|read/.test(n) ? '正在处理文件' : '正在执行'
  const what = tc.detail || tc.url || tc.command || ''
  return what ? `${verb}：${what}` : `${verb}…`
}

/** GOXF: a one-line "what is it doing" for a tool call, read from its input or progress. */
export function harkToolDetail(...sources: Array<Record<string, unknown> | undefined>): string | undefined {
  const keys = ['task', 'description', 'objective', 'query', 'prompt', 'title', 'message', 'step', 'handle', 'path', 'file_path']
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue
    for (const k of keys) {
      const v = src[k]
      if (typeof v === 'string' && v.trim()) return v.trim().replace(/\s+/g, ' ').slice(0, 160)
    }
  }
  return undefined
}
