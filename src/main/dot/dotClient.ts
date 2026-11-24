import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delayDotRequest } from 'node:timers/promises'
import WebSocket from 'ws'
import { DIRECT_PROXY_URL, proxyFetch, proxyWsAgent } from '../proxyTransport'
import { guessMediaMimeFromName, inferMediaMime } from '../mediaMime'
import { readJsonFile } from '../jsonFile'
import { requireValidProxyUrl } from '../proxyUrl'
import { applyProxyToPartition, loadAccountProxyUrl, loadAccountTransportProxyUrl, ProxyConfigUnreadableError } from '../muse/accountProxy'
import { resolveDotTarget, type DotTarget } from '@shared/dotTarget'
import type {
  DotAuthStatus,
  MuseMediaPartView,
  MuseRichWidgetView,
  MuseToolCallView
} from '@shared/ipc'

export const DOT_ORIGIN = 'https://chatgpt.com'
export const DOT_API_BASE = 'https://chatgpt.com/backend-api'
export const DOT_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const DOT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const DOT_APP_SERVER_WS_URL = 'wss://codex-cloud-backend.chatgpt.com/'

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

export class DotApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'DotApiError'
    this.status = status
    this.body = body
  }
}

export interface DotStoredAccount {
  accountId: string
  accessToken: string
  refreshToken?: string
  clientId?: string
  deviceId?: string
  chatgptAccountId: string
  chatgptUserId?: string
  email?: string
  displayName?: string
  planType?: string
  expiresAtMs?: number
  proxyUrl?: string
  activeDotId?: string
  roomId?: string
  threadId?: string
  botId?: string
  mode?: 'dot' | 'native'
  model?: string
  effort?: string
  updatedAtMs: number
}

export interface DotProfile {
  id: string
  displayName: string
  avatarType?: string | null
  avatarUrl?: string | null
  color?: string | null
  aeonKind?: string
  isPrimary?: boolean
  scope?: string
  messagingRoomId: string
  activeRootThreadId: string
  status: string
  isPaused?: boolean
  lastCheckInAt?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface DotRoomAttachment {
  attachmentId: string
  type: string
  fileId?: string
  name?: string
  mimeType?: string
  downloadUrl?: string
}

export interface DotRoomMessage {
  id: string
  roomId: string
  role: 'user' | 'bot'
  accountUserId: string
  text: string
  createdAtMs: number
  turnTrigger?: string
  threadTurnId?: string
  attachments?: DotRoomAttachment[]
}

export type DotRealtimeCallback = (
  event:
    | {
        type: 'message'
        accountId: string
        botId?: string
        target: DotRoomTarget
        turnId?: string
        message: DotRoomMessage
        done: boolean
      }
    | {
        type: 'activity'
        accountId: string
        botId?: string
        target: DotRoomTarget
        turnId?: string
        code: string
        text?: string
        busy: boolean
      }
) => void

const realtimeListeners = new Set<DotRealtimeCallback>()

export function onDotRealtimeEvent(cb: DotRealtimeCallback): () => void {
  realtimeListeners.add(cb)
  return () => realtimeListeners.delete(cb)
}

function emitRealtime(event: Parameters<DotRealtimeCallback>[0]): void {
  for (const cb of realtimeListeners) {
    try {
      cb(event)
    } catch (err) {
      console.error('[dot] realtime listener failed', err)
    }
  }
}

function resolveStorePath(): string {
  try {
    // Allow running in both Electron main process and standalone Node tests
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron')
    if (electron?.app?.getPath) {
      return join(electron.app.getPath('userData'), 'dot-accounts.json')
    }
  } catch {
    /* standalone node */
  }
  if (process.platform === 'darwin') {
    const legacy = join(homedir(), 'Library', 'Application Support', 'bothub', 'dot-accounts.json')
    const next = join(homedir(), 'Library', 'Application Support', 'botark', 'dot-accounts.json')
    return !existsSync(next) && existsSync(legacy) ? legacy : next
  }
  const legacyDot = join(homedir(), '.bothub', 'dot-accounts.json')
  const nextDot = join(homedir(), '.botark', 'dot-accounts.json')
  return !existsSync(nextDot) && existsSync(legacyDot) ? legacyDot : nextDot
}

const accountStore = new Map<string, DotStoredAccount>()
const credentialRevisions = new Map<string, number>()
const targetGenerations = new Map<string, number>()
const profileSelections = new Map<string, AbortController>()
const signedOutAccounts = new Set<string>()
const tokenRefreshes = new Map<string, { revision: number; promise: Promise<DotStoredAccount> }>()
/**
 * Entries whose tokens could not be decrypted right now (Keychain denied,
 * safeStorage not ready). They are written back untouched; dropping them
 * made the next save delete those accounts for good.
 */
const unreadableEntries = new Map<string, PersistedDotAccount>()
let storeLoaded = false
/** Last load threw (file locked): saving now would drop every account. */
let storeLoadFailed = false

interface PersistedDotAccount extends Omit<DotStoredAccount, 'accessToken' | 'refreshToken'> {
  accessToken?: string
  refreshToken?: string
  encTokens?: string
}

function getSafeStorage(): {
  ss: typeof import('electron').safeStorage | null
  inElectron: boolean
} {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron')
    const inElectron = Boolean(electron?.app?.getPath)
    if (electron?.safeStorage?.isEncryptionAvailable?.()) {
      return { ss: electron.safeStorage, inElectron }
    }
    return { ss: null, inElectron }
  } catch {
    /* standalone node */
  }
  return { ss: null, inElectron: false }
}

async function resolveDotProxyUrl(accountId: string): Promise<string | undefined> {
  const globalProxy = await loadAccountTransportProxyUrl(accountId)
  if (globalProxy && globalProxy !== DIRECT_PROXY_URL) return globalProxy
  return getStoredDotAccount(accountId)?.proxyUrl ?? globalProxy
}

export function getDotCredentialRevision(accountId: string): number {
  return credentialRevisions.get(accountId) ?? 0
}

function advanceCredentialRevision(accountId: string): number {
  const revision = getDotCredentialRevision(accountId) + 1
  credentialRevisions.set(accountId, revision)
  return revision
}

function requireCredentialRevision(accountId: string, revision: number): void {
  if (getDotCredentialRevision(accountId) !== revision) {
    throw new DotApiError(409, 'Dot credentials changed during the request')
  }
}

export function getDotTargetGeneration(accountId: string): number {
  return targetGenerations.get(accountId) ?? 0
}

function requireTargetGeneration(accountId: string, generation: number): void {
  if (getDotTargetGeneration(accountId) !== generation) {
    throw new DotApiError(409, 'The active Dot profile changed during the request')
  }
}

export function isEphemeralRoomTurnBotId(botId?: string): boolean {
  return Boolean(botId && botId.startsWith('room-turn-'))
}

function ensureStoreLoaded(): void {
  if (storeLoaded && (accountStore.size > 0 || unreadableEntries.size === 0)) return
  storeLoaded = true
  storeLoadFailed = false
  try {
    const file = resolveStorePath()
    if (!existsSync(file)) return
    // Corrupt → moved aside (not silently replaced by the next save).
    const parsed = readJsonFile<Record<string, unknown> | null>(file, null, (r) => Boolean(r) && typeof r === 'object')
    if (!parsed) return
    const raw = (
      parsed &&
      typeof parsed === 'object' &&
      parsed['accounts'] &&
      typeof parsed['accounts'] === 'object' &&
      !('accessToken' in (parsed['accounts'] as Record<string, unknown>)) &&
      !('encTokens' in (parsed['accounts'] as Record<string, unknown>))
        ? (parsed['accounts'] as Record<string, PersistedDotAccount>)
        : (parsed as unknown as Record<string, PersistedDotAccount>)
    )
    if (raw && typeof raw === 'object') {
      const { ss } = getSafeStorage()
      let migratedPlaintext = false
      for (const [k, v] of Object.entries(raw)) {
        if (!v || typeof v !== 'object' || signedOutAccounts.has(k)) continue
        let accessToken = typeof v.accessToken === 'string' ? v.accessToken : ''
        let refreshToken = typeof v.refreshToken === 'string' ? v.refreshToken : undefined
        if (typeof v.encTokens === 'string' && v.encTokens) {
          if (!ss) {
            unreadableEntries.set(k, v)
            continue
          }
          try {
            const dec = JSON.parse(
              ss.decryptString(Buffer.from(v.encTokens, 'base64'))
            ) as { accessToken?: string; refreshToken?: string }
            if (typeof dec.accessToken === 'string') accessToken = dec.accessToken
            if (typeof dec.refreshToken === 'string') refreshToken = dec.refreshToken
          } catch {
            unreadableEntries.set(k, v)
            continue
          }
        } else if (accessToken && ss) {
          migratedPlaintext = true
        }
        if (accessToken) {
          unreadableEntries.delete(k)
          const { encTokens: _enc, ...rest } = v
          const cleanBotId = isEphemeralRoomTurnBotId(rest.botId) ? undefined : rest.botId
          if (cleanBotId !== rest.botId) migratedPlaintext = true
          accountStore.set(k, {
            ...rest,
            botId: cleanBotId,
            accessToken,
            ...(refreshToken ? { refreshToken } : {})
          })
        }
      }
      if (migratedPlaintext) {
        saveStore()
      }
    }
  } catch (err) {
    storeLoadFailed = true
    storeLoaded = false
    console.warn('[dot] failed to read dot-accounts.json', err)
  }
}

function saveStore(): void {
  if (storeLoadFailed) ensureStoreLoaded()
  if (storeLoadFailed) {
    console.warn('[dot] not saving dot-accounts.json: it could not be read, saving would drop accounts')
    return
  }
  try {
    const file = resolveStorePath()
    mkdirSync(dirname(file), { recursive: true })
    const { ss, inElectron } = getSafeStorage()
    if (inElectron && !ss) {
      console.warn('[dot] safeStorage encryption unavailable; refusing to persist Dot tokens in plaintext')
      return
    }
    const out: Record<string, PersistedDotAccount> = {}
    for (const [k, v] of unreadableEntries.entries()) {
      if (!accountStore.has(k)) out[k] = v
    }
    for (const [k, v] of accountStore.entries()) {
      const { accessToken, refreshToken, ...metadata } = v
      if (ss) {
        const encTokens = ss
          .encryptString(JSON.stringify({ accessToken, refreshToken }))
          .toString('base64')
        out[k] = {
          ...metadata,
          encTokens
        }
      } else {
        out[k] = {
          ...metadata,
          accessToken,
          ...(refreshToken ? { refreshToken } : {})
        }
      }
    }
    // Temp file + rename: a crash mid-write must not truncate every account.
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(out, null, 2), { encoding: 'utf8', mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  } catch (err) {
    console.warn('[dot] failed to write dot-accounts.json', err)
  }
}

export interface DecodedChatGptJwt {
  chatgptAccountId?: string
  chatgptUserId?: string
  planType?: string
  email?: string
  displayName?: string
  clientId?: string
  expiresAtMs?: number
}

export function decodeChatGptJwt(token: string): DecodedChatGptJwt {
  try {
    const parts = token.trim().split('.')
    if (parts.length < 2 || !parts[1]) return {}
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    const authClaim =
      payload['https://api.openai.com/auth'] &&
      typeof payload['https://api.openai.com/auth'] === 'object'
        ? (payload['https://api.openai.com/auth'] as Record<string, unknown>)
        : {}
    const profileClaim =
      payload['https://api.openai.com/profile'] &&
      typeof payload['https://api.openai.com/profile'] === 'object'
        ? (payload['https://api.openai.com/profile'] as Record<string, unknown>)
        : {}
    const exp = typeof payload['exp'] === 'number' ? payload['exp'] * 1000 : undefined
    return {
      chatgptAccountId:
        typeof authClaim['chatgpt_account_id'] === 'string'
          ? authClaim['chatgpt_account_id']
          : undefined,
      chatgptUserId:
        typeof authClaim['chatgpt_user_id'] === 'string'
          ? authClaim['chatgpt_user_id']
          : typeof authClaim['user_id'] === 'string'
            ? authClaim['user_id']
            : undefined,
      planType:
        typeof authClaim['chatgpt_plan_type'] === 'string'
          ? authClaim['chatgpt_plan_type']
          : undefined,
      email: typeof profileClaim['email'] === 'string' ? profileClaim['email'] : undefined,
      displayName:
        typeof profileClaim['name'] === 'string'
          ? profileClaim['name']
          : typeof profileClaim['email'] === 'string'
            ? profileClaim['email'].split('@')[0]
            : undefined,
      clientId: typeof payload['client_id'] === 'string' ? payload['client_id'] : undefined,
      expiresAtMs: exp
    }
  } catch {
    return {}
  }
}

export function getStoredDotAccount(accountId: string): DotStoredAccount | undefined {
  ensureStoreLoaded()
  return accountStore.get(accountId)
}

export function patchStoredDotAccount(
  accountId: string,
  patch: Partial<DotStoredAccount>
): DotStoredAccount | undefined {
  ensureStoreLoaded()
  const prev = accountStore.get(accountId)
  if (!prev) return undefined
  const sanitizedPatch = { ...patch }
  if ('botId' in sanitizedPatch && isEphemeralRoomTurnBotId(sanitizedPatch.botId)) {
    delete sanitizedPatch.botId
  }
  if (Object.entries(sanitizedPatch).every(([key, value]) => prev[key as keyof DotStoredAccount] === value)) {
    return prev
  }
  const next: DotStoredAccount = {
    ...prev,
    ...sanitizedPatch,
    accountId,
    updatedAtMs: Date.now()
  }
  accountStore.set(accountId, next)
  if (next.activeDotId !== prev.activeDotId || next.roomId !== prev.roomId || next.threadId !== prev.threadId) {
    targetGenerations.set(accountId, getDotTargetGeneration(accountId) + 1)
    if (activeDotTurns.get(accountId)?.target) abortDotTurn(accountId)
    closeCelsiusWatcher(accountId)
  }
  saveStore()
  return next
}

export function clearStoredDotAccount(accountId: string): void {
  ensureStoreLoaded()
  advanceCredentialRevision(accountId)
  signedOutAccounts.add(accountId)
  disconnectDotAccount(accountId)
  accountStore.delete(accountId)
  unreadableEntries.delete(accountId)
  saveStore()
}

export function clearAllStoredDotAccounts(): void {
  ensureStoreLoaded()
  for (const id of new Set([...accountStore.keys(), ...unreadableEntries.keys(), ...credentialRevisions.keys()])) {
    advanceCredentialRevision(id)
    signedOutAccounts.add(id)
    disconnectDotAccount(id)
  }
  accountStore.clear()
  unreadableEntries.clear()
  saveStore()
}

export function listStoredDotAccounts(): DotStoredAccount[] {
  ensureStoreLoaded()
  return [...accountStore.values()].filter((a) => Boolean(a?.accessToken))
}

export function upsertDotCredentials(
  accountId: string,
  input: {
    accessToken: string
    refreshToken?: string
    clientId?: string
    chatgptAccountId?: string
    email?: string
    displayName?: string
    planType?: string
    proxyUrl?: string
    botId?: string
    mode?: 'dot' | 'native'
  },
  revision?: number,
  refreshing = false
): DotStoredAccount {
  ensureStoreLoaded()
  if (revision !== undefined) requireCredentialRevision(accountId, revision)
  const prev = accountStore.get(accountId)
  const decoded = decodeChatGptJwt(input.accessToken)
  const chatgptAccountId =
    input.chatgptAccountId?.trim() ||
    decoded.chatgptAccountId ||
    prev?.chatgptAccountId ||
    ''
  const email = input.email?.trim() || decoded.email || prev?.email
  const displayName =
    input.displayName?.trim() ||
    decoded.displayName ||
    (email ? email.split('@')[0] : undefined) ||
    prev?.displayName ||
    'Dot'
  const planType = input.planType?.trim() || decoded.planType || prev?.planType
  const changedIdentity = Boolean(prev?.chatgptAccountId && chatgptAccountId !== prev.chatgptAccountId)
  const next: DotStoredAccount = {
    accountId,
    accessToken: input.accessToken.trim(),
    refreshToken: input.refreshToken?.trim() || (changedIdentity ? undefined : prev?.refreshToken),
    clientId: input.clientId?.trim() || decoded.clientId || prev?.clientId || DOT_CODEX_CLIENT_ID,
    deviceId: prev?.deviceId || randomUUID(),
    chatgptAccountId,
    chatgptUserId: decoded.chatgptUserId || prev?.chatgptUserId,
    email,
    displayName,
    planType,
    expiresAtMs: decoded.expiresAtMs ?? (prev?.accessToken === input.accessToken.trim() ? prev?.expiresAtMs : undefined),
    proxyUrl: requireValidProxyUrl(input.proxyUrl) ?? prev?.proxyUrl,
    activeDotId: changedIdentity ? undefined : prev?.activeDotId,
    roomId: changedIdentity ? undefined : prev?.roomId,
    threadId: changedIdentity ? undefined : prev?.threadId,
    botId:
      input.botId && !isEphemeralRoomTurnBotId(input.botId)
        ? input.botId
        : prev?.botId,
    mode: input.mode ?? prev?.mode ?? 'dot',
    model: prev?.model ?? 'gpt-6-astra',
    effort: prev?.effort ?? 'medium',
    updatedAtMs: Date.now()
  }
  if (!refreshing) {
    advanceCredentialRevision(accountId)
    if (prev) disconnectDotAccount(accountId)
  }
  signedOutAccounts.delete(accountId)
  unreadableEntries.delete(accountId)
  accountStore.set(accountId, next)
  saveStore()
  return next
}

async function exchangeDotRefreshToken(
  refreshToken: string,
  clientId?: string,
  proxyUrl?: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await proxyFetch(proxyUrl, DOT_OAUTH_TOKEN_URL, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(25_000),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': CHROME_UA
    },
    body: JSON.stringify({
      client_id: clientId || DOT_CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'openid profile email'
    })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new DotApiError(
      res.status,
      `OAuth refresh_token exchange failed (${res.status}): ${text.slice(0, 180)}`
    )
  }

  const tokenData = (await res.json()) as {
    access_token?: string
    refresh_token?: string
  }
  if (!tokenData.access_token) {
    throw new DotApiError(500, 'OAuth refresh response missing access_token')
  }

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || refreshToken
  }
}

/**
 * Parse user credential input:
 * - Raw ChatGPT/Codex JWT `access_token` (`eyJ...` or `Bearer eyJ...`)
 * - Raw OAuth `refresh_token` (`rt_...` or non-JWT token string) — automatically exchanged for `access_token`
 * - JSON credential object (`auth.json`, `{ access_token, refresh_token }`, `{ refresh_token }`, or `/api/auth/session`)
 */
export async function importDotCredentialsFromRaw(
  accountId: string,
  rawInput: string,
  extra?: { refreshToken?: string; chatgptAccountId?: string; proxyUrl?: string }
): Promise<DotStoredAccount> {
  const trimmed = (rawInput ?? '').trim()
  const extraRt = extra?.refreshToken?.trim()

  if (!trimmed && !extraRt) {
    throw new DotApiError(400, 'Empty credential input (provide access_token, refresh_token, or JSON)')
  }
  const explicitProxy = requireValidProxyUrl(extra?.proxyUrl)
  const revision = advanceCredentialRevision(accountId)
  const accountProxy = explicitProxy ?? (await loadAccountProxyUrl(accountId))
  requireCredentialRevision(accountId, revision)
  const authProxyUrl = accountProxy ?? getStoredDotAccount(accountId)?.proxyUrl
  const commit = (input: Parameters<typeof upsertDotCredentials>[1]) =>
    upsertDotCredentials(accountId, input, revision)

  // Case 0: Only refreshToken was provided in extra (or rawInput is empty)
  if (!trimmed && extraRt) {
    const exchanged = await exchangeDotRefreshToken(extraRt, undefined, authProxyUrl)
    return commit({
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      chatgptAccountId: extra?.chatgptAccountId,
      proxyUrl: extra?.proxyUrl
    })
  }

  // Case 1: Raw JWT access_token
  if (trimmed.startsWith('eyJ') && !trimmed.includes('{')) {
    let at = trimmed
    let rt = extraRt
    const decoded = decodeChatGptJwt(at)
    if (rt && decoded.expiresAtMs && decoded.expiresAtMs < Date.now() + 60_000) {
      try {
        const exchanged = await exchangeDotRefreshToken(rt, decoded.clientId, authProxyUrl)
        at = exchanged.accessToken
        rt = exchanged.refreshToken
      } catch {
        /* use provided access_token if refresh fails */
      }
    }
    return commit({
      accessToken: at,
      refreshToken: rt,
      chatgptAccountId: extra?.chatgptAccountId,
      proxyUrl: extra?.proxyUrl
    })
  }

  // Case 2: JSON object or array, OR raw refresh_token / Bearer token
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Check if it contains a Bearer JWT access_token
    const m = trimmed.match(/(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/)
    if (m?.[1]) {
      return commit({
        accessToken: m[1],
        refreshToken: extraRt,
        chatgptAccountId: extra?.chatgptAccountId,
        proxyUrl: extra?.proxyUrl
      })
    }
    // Otherwise treat single-line non-JSON string as an OAuth refresh_token (e.g. rt_...)
    const rtCandidate = trimmed.replace(/^Bearer\s+/i, '').trim()
    if (rtCandidate.length >= 16 && !/\s/.test(rtCandidate)) {
      const exchanged = await exchangeDotRefreshToken(rtCandidate, undefined, authProxyUrl)
      return commit({
        accessToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken,
        chatgptAccountId: extra?.chatgptAccountId,
        proxyUrl: extra?.proxyUrl
      })
    }
    throw new DotApiError(400, 'Invalid credential format: paste access_token (eyJ...), refresh_token (rt_...), or JSON')
  }

  const pickRecord = (item: unknown): Record<string, unknown> | null => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const obj = item as Record<string, unknown>
    if (obj['tokens'] && typeof obj['tokens'] === 'object') {
      return obj['tokens'] as Record<string, unknown>
    }
    if (
      typeof obj['access_token'] === 'string' ||
      typeof obj['accessToken'] === 'string' ||
      typeof obj['refresh_token'] === 'string' ||
      typeof obj['refreshToken'] === 'string'
    ) {
      return obj
    }
    return null
  }

  let rec: Record<string, unknown> | null = null
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const r = pickRecord(item)
      if (r) {
        rec = r
        break
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    const root = parsed as Record<string, unknown>
    if (Array.isArray(root['accounts'])) {
      for (const item of root['accounts']) {
        const r = pickRecord(item)
        if (r) {
          rec = r
          break
        }
      }
    } else {
      rec = pickRecord(root)
    }
  }

  if (!rec) {
    throw new DotApiError(400, 'No access_token or refresh_token found in JSON')
  }

  let accessToken = String(rec['access_token'] ?? rec['accessToken'] ?? '').trim()
  const importedProxy = requireValidProxyUrl(typeof rec['proxy_url'] === 'string' ? rec['proxy_url'] : undefined)
  let refreshToken =
    extraRt ||
    (typeof rec['refresh_token'] === 'string' ? rec['refresh_token'].trim() : undefined) ||
    (typeof rec['refreshToken'] === 'string' ? rec['refreshToken'].trim() : undefined)
  const clientId = typeof rec['client_id'] === 'string' ? rec['client_id'] : undefined

  const decoded = accessToken ? decodeChatGptJwt(accessToken) : {}
  const isExpired = Boolean(decoded.expiresAtMs && decoded.expiresAtMs < Date.now() + 60_000)

  if ((!accessToken || isExpired) && refreshToken) {
    const exchanged = await exchangeDotRefreshToken(
      refreshToken,
      clientId || decoded.clientId,
      accountProxy ?? importedProxy ?? authProxyUrl
    )
    accessToken = exchanged.accessToken
    refreshToken = exchanged.refreshToken
  }

  if (!accessToken) {
    throw new DotApiError(400, 'No valid access_token or refresh_token found')
  }

  const userObj =
    rec['user'] && typeof rec['user'] === 'object' ? (rec['user'] as Record<string, unknown>) : {}
  const accObj =
    rec['account'] && typeof rec['account'] === 'object'
      ? (rec['account'] as Record<string, unknown>)
      : {}

  const chatgptAccountId =
    extra?.chatgptAccountId ||
    (typeof rec['account_id'] === 'string' ? rec['account_id'] : undefined) ||
    (typeof rec['chatgpt_account_id'] === 'string' ? rec['chatgpt_account_id'] : undefined) ||
    (typeof accObj['id'] === 'string' ? accObj['id'] : undefined)
  const email =
    (typeof rec['email'] === 'string' ? rec['email'] : undefined) ||
    (typeof userObj['email'] === 'string' ? userObj['email'] : undefined)
  const displayName =
    (typeof rec['displayName'] === 'string' ? rec['displayName'] : undefined) ||
    (typeof userObj['name'] === 'string' ? userObj['name'] : undefined)
  const planType =
    (typeof rec['plan_type'] === 'string' ? rec['plan_type'] : undefined) ||
    (typeof accObj['planType'] === 'string' ? accObj['planType'] : undefined)
  const proxyUrl = explicitProxy ?? importedProxy
  const botId =
    typeof rec['botId'] === 'string' && !isEphemeralRoomTurnBotId(rec['botId'])
      ? rec['botId']
      : undefined
  const mode = rec['mode'] === 'native' || rec['mode'] === 'dot' ? rec['mode'] : undefined

  return commit({
    accessToken,
    refreshToken,
    clientId,
    chatgptAccountId,
    email,
    displayName,
    planType,
    proxyUrl,
    botId,
    mode
  })
}

/**
 * Refresh access_token using refresh_token via `POST https://auth.openai.com/oauth/token`.
 */
export async function refreshDotAccessToken(accountId: string): Promise<DotStoredAccount> {
  ensureStoreLoaded()
  const acc = accountStore.get(accountId)
  const refreshToken = acc?.refreshToken
  if (!acc || !refreshToken) {
    throw new DotApiError(401, 'No refresh_token available for Dot account')
  }
  const revision = getDotCredentialRevision(accountId)
  const inFlight = tokenRefreshes.get(accountId)
  if (inFlight?.revision === revision) return inFlight.promise

  const promise = (async () => {
    const proxyUrl = await resolveDotProxyUrl(accountId)
    requireCredentialRevision(accountId, revision)
    const exchanged = await exchangeDotRefreshToken(refreshToken, acc.clientId, proxyUrl)
    return upsertDotCredentials(accountId, {
      ...exchanged,
      clientId: acc.clientId,
      chatgptAccountId: acc.chatgptAccountId,
      email: acc.email,
      displayName: acc.displayName,
      planType: acc.planType
    }, revision, true)
  })()
  tokenRefreshes.set(accountId, { revision, promise })
  try {
    return await promise
  } finally {
    if (tokenRefreshes.get(accountId)?.promise === promise) tokenRefreshes.delete(accountId)
  }
}

/**
 * Try to extract a ChatGPT web session from the Electron partition `persist:bothub-account-${accountId}`
 * if the user signed in via the interactive login window.
 */
export async function trySyncFromElectronPartition(
  accountId: string,
  ownsLoginAttempt: () => boolean,
  signal?: AbortSignal
): Promise<DotStoredAccount | undefined> {
  const revision = getDotCredentialRevision(accountId)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron')
    if (!electron?.session?.fromPartition) return undefined
    await applyProxyToPartition(accountId)
    if (!ownsLoginAttempt() || revision !== getDotCredentialRevision(accountId)) return undefined
    const ses = electron.session.fromPartition(`persist:bothub-account-${accountId}`)
    const res = await ses.fetch('https://chatgpt.com/api/auth/session', {
      headers: {
        Accept: 'application/json',
        'User-Agent': CHROME_UA
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)
    })
    if (!res.ok) return undefined
    const data = (await res.json()) as Record<string, unknown>
    const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
    if (!accessToken || !ownsLoginAttempt() || revision !== getDotCredentialRevision(accountId)) return undefined
    const userObj =
      data['user'] && typeof data['user'] === 'object'
        ? (data['user'] as Record<string, unknown>)
        : {}
    const accObj =
      data['account'] && typeof data['account'] === 'object'
        ? (data['account'] as Record<string, unknown>)
        : {}
    return upsertDotCredentials(accountId, {
      accessToken,
      chatgptAccountId: typeof accObj['id'] === 'string' ? accObj['id'] : undefined,
      email: typeof userObj['email'] === 'string' ? userObj['email'] : undefined,
      displayName: typeof userObj['name'] === 'string' ? userObj['name'] : undefined,
      planType: typeof accObj['planType'] === 'string' ? accObj['planType'] : undefined
    }, revision)
  } catch (err) {
    if (err instanceof ProxyConfigUnreadableError) throw err
    return undefined
  }
}

export async function ensureValidDotAccount(accountId: string, signal?: AbortSignal): Promise<DotStoredAccount> {
  signal?.throwIfAborted()
  ensureStoreLoaded()
  const acc = accountStore.get(accountId)
  if (!acc || !acc.accessToken) {
    throw new DotApiError(401, 'Not signed in to Dot (import token or sign in first)')
  }
  // Refresh proactively if expiring within 5 minutes
  if (acc.expiresAtMs && acc.expiresAtMs < Date.now() + 5 * 60_000 && acc.refreshToken) {
    const revision = getDotCredentialRevision(accountId)
    try {
      return await waitForDotRequest(refreshDotAccessToken(accountId), signal)
    } catch (err) {
      signal?.throwIfAborted()
      requireCredentialRevision(accountId, revision)
      console.warn('[dot] proactive token refresh failed, continuing with current token', err)
    }
  }
  return acc
}

export async function getDotAuthStatus(accountId: string): Promise<DotAuthStatus> {
  let acc = getStoredDotAccount(accountId)
  if (!acc || !acc.accessToken) {
    return { accountId, signedIn: false }
  }
  const accountProxy = await loadAccountProxyUrl(accountId).catch(() => true)
  acc = getStoredDotAccount(accountId)
  if (!acc?.accessToken) return { accountId, signedIn: false }
  return {
    accountId,
    signedIn: true,
    handle: acc.email || acc.chatgptAccountId || accountId,
    displayName: acc.displayName || acc.email?.split('@')[0] || 'Dot',
    planType: acc.planType,
    chatgptAccountId: acc.chatgptAccountId,
    activeDotId: acc.activeDotId,
    roomId: acc.roomId,
    threadId: acc.threadId,
    mode: acc.mode ?? 'dot',
    model: acc.model ?? 'gpt-6-astra',
    effort: acc.effort ?? 'medium',
    hasRefreshToken: Boolean(acc.refreshToken),
    expiresAtMs: acc.expiresAtMs,
    updatedAt: acc.updatedAtMs,
    hasProxy: Boolean(accountProxy || acc.proxyUrl)
  }
}

export interface DotApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  path: string
  query?: Record<string, string | undefined>
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

async function waitForDotRequest<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request
  let abort!: () => void
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

function dotClientHeaders(
  cred: DotStoredAccount,
  extra?: Record<string, string>
): Record<string, string> {
  return {
    Authorization: `Bearer ${cred.accessToken}`,
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
    Origin: DOT_ORIGIN,
    Referer: `${DOT_ORIGIN}/dots`,
    'User-Agent': CHROME_UA,
    'OAI-Device-Id': cred.deviceId || '00000000-0000-4000-8000-000000000001',
    'OAI-Language': 'en-US',
    'OAI-Client-Version': 'prod-a8f4c92d1e4b8c3a9f0e2d1b',
    'Sec-Ch-Ua': '"Chromium";v="147", "Google Chrome";v="147", "Not.A/Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    ...(cred.chatgptAccountId ? { 'chatgpt-account-id': cred.chatgptAccountId } : {}),
    ...(extra ?? {})
  }
}

export async function callDotApi<T = unknown>(
  accountId: string,
  opts: DotApiRequestOptions
): Promise<T> {
  const { signal } = opts
  const revision = getDotCredentialRevision(accountId)
  let acc = await ensureValidDotAccount(accountId, signal)
  signal?.throwIfAborted()
  requireCredentialRevision(accountId, revision)
  if (!acc.deviceId) {
    acc = patchStoredDotAccount(accountId, { deviceId: randomUUID() }) ?? acc
  }
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')
  const relPath = opts.path.startsWith('/') ? opts.path : `/${opts.path}`
  const url = new URL(`${DOT_API_BASE}${relPath}`)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v)
    }
  }

  const doFetch = async (cred: DotStoredAccount): Promise<Response> => {
    const headers = dotClientHeaders(cred, opts.headers)
    let bodyPayload: string | undefined
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      bodyPayload = JSON.stringify(opts.body)
    }
    const effectiveProxy = await waitForDotRequest(resolveDotProxyUrl(accountId), signal)
    signal?.throwIfAborted()
    requireCredentialRevision(accountId, revision)
    const deadline = AbortSignal.timeout(30_000)
    return proxyFetch(effectiveProxy, url.toString(), {
      method,
      headers,
      body: bodyPayload,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline
    })
  }

  const maxAttempts = method === 'GET' ? 3 : 2
  let res: Response | undefined
  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await delayDotRequest(400 * attempt, undefined, { signal })
    }
    try {
      res = await doFetch(acc)
      if (res.status === 401 && acc.refreshToken) {
        void res.body?.cancel().catch(() => undefined)
        signal?.throwIfAborted()
        requireCredentialRevision(accountId, revision)
        const current = getStoredDotAccount(accountId)
        acc = current && current.accessToken !== acc.accessToken
          ? current
          : await waitForDotRequest(refreshDotAccessToken(accountId), signal)
        res = await doFetch(acc)
      }
      if (
        (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) &&
        attempt + 1 < maxAttempts
      ) {
        void res.body?.cancel().catch(() => undefined)
        continue
      }
      break
    } catch (err) {
      lastErr = err
      if (signal?.aborted || revision !== getDotCredentialRevision(accountId) || attempt + 1 >= maxAttempts) throw err
    }
  }
  if (!res) {
    throw lastErr instanceof Error ? lastErr : new DotApiError(0, 'Dot API network error')
  }

  const text = await res.text()
  signal?.throwIfAborted()
  requireCredentialRevision(accountId, revision)
  let parsed: unknown = text
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  if (!res.ok) {
    const detail =
      parsed && typeof parsed === 'object' && 'detail' in (parsed as Record<string, unknown>)
        ? JSON.stringify((parsed as Record<string, unknown>)['detail'])
        : typeof parsed === 'string'
          ? parsed.slice(0, 200)
          : `HTTP ${res.status}`
    throw new DotApiError(res.status, `Dot API ${method} ${relPath} failed (${res.status}): ${detail}`, parsed)
  }

  return parsed as T
}

function normalizeDotProfile(raw: Record<string, unknown>): DotProfile {
  const preview =
    raw['messaging_room_preview'] && typeof raw['messaging_room_preview'] === 'object'
      ? (raw['messaging_room_preview'] as Record<string, unknown>)
      : {}
  const rawName = String(
    raw['display_name'] || raw['displayName'] || preview['name'] || 'Dot'
  ).trim()
  return {
    id: String(raw['id'] ?? ''),
    displayName: rawName || 'Dot',
    avatarType: typeof raw['avatar_type'] === 'string' ? raw['avatar_type'] : null,
    avatarUrl: typeof raw['avatar_url'] === 'string' ? raw['avatar_url'] : null,
    color: typeof raw['color'] === 'string' ? raw['color'] : null,
    aeonKind: typeof raw['aeon_kind'] === 'string' ? raw['aeon_kind'] : 'orbit',
    isPrimary: Boolean(raw['is_primary']),
    scope: typeof raw['scope'] === 'string' ? raw['scope'] : 'private',
    messagingRoomId: String(raw['messaging_room_id'] ?? raw['messagingRoomId'] ?? ''),
    activeRootThreadId: String(raw['active_root_thread_id'] ?? raw['activeRootThreadId'] ?? ''),
    status: String(raw['status'] ?? 'active'),
    isPaused: Boolean(raw['is_paused']),
    lastCheckInAt: typeof raw['last_check_in_at'] === 'string' ? raw['last_check_in_at'] : null,
    createdAt: typeof raw['created_at'] === 'string' ? raw['created_at'] : undefined,
    updatedAt: typeof raw['updated_at'] === 'string' ? raw['updated_at'] : undefined
  }
}

export async function listDots(
  accountId: string,
  signal?: AbortSignal
): Promise<{ items: DotProfile[]; activeDot?: DotProfile }> {
  let res: { items?: Record<string, unknown>[] }
  try {
    res = await callDotApi<{ items?: Record<string, unknown>[] }>(accountId, {
      method: 'GET',
      path: '/tbo',
      query: { limit: '25' },
      signal
    })
  } catch (err) {
    if (err instanceof DotApiError && (err.status === 404 || err.status === 403)) {
      throw new DotApiError(
        err.status,
        '该账号当前套餐未开通 Dot (/backend-api/tbo 404)，请选用 promax / pro / team 账号'
      )
    }
    throw err
  }

  const items = (Array.isArray(res?.items) ? res.items : [])
    .filter((item) => item && typeof item === 'object')
    .map(normalizeDotProfile)
    .filter((d) => d.id && d.status !== 'deleting')

  const acc = getStoredDotAccount(accountId)
  const activeDot =
    (acc?.activeDotId ? items.find((d) => d.id === acc.activeDotId) : undefined) ??
    items.find((d) => d.isPrimary) ??
    items[0]

  return { items, activeDot }
}

function activateDotProfile(accountId: string, profile: DotProfile, botId?: string): DotRoomTarget {
  if (!profile.id || !profile.messagingRoomId) throw new DotApiError(404, 'No active Dot room found')
  patchStoredDotAccount(accountId, {
    activeDotId: profile.id,
    roomId: profile.messagingRoomId,
    threadId: profile.activeRootThreadId,
    ...(botId ? { botId } : {})
  })
  void ensureCelsiusWatcher(accountId, profile.messagingRoomId)
  return {
    dotId: profile.id,
    roomId: profile.messagingRoomId,
    threadId: profile.activeRootThreadId,
    generation: getDotTargetGeneration(accountId)
  }
}

export async function initializeDots(accountId: string, signal?: AbortSignal) {
  requireStableDotProfile(accountId)
  const generation = getDotTargetGeneration(accountId)
  const revision = getDotCredentialRevision(accountId)
  const listed = await listDots(accountId, signal)
  signal?.throwIfAborted()
  requireCredentialRevision(accountId, revision)
  requireTargetGeneration(accountId, generation)
  const activeDot = listed.activeDot ?? await createDot(accountId, { hasExisting: false, signal })
  signal?.throwIfAborted()
  requireCredentialRevision(accountId, revision)
  requireTargetGeneration(accountId, generation)
  const target = activateDotProfile(accountId, activeDot)
  return { items: listed.activeDot ? listed.items : [activeDot], activeDot, target }
}

export async function createDot(
  accountId: string,
  opts?: { displayName?: string; color?: string; hasExisting?: boolean; signal?: AbortSignal }
): Promise<DotProfile> {
  const generation = getDotTargetGeneration(accountId)
  const revision = getDotCredentialRevision(accountId)
  const existing =
    opts?.hasExisting !== undefined
      ? opts.hasExisting
      : (
          await callDotApi<{ items?: unknown[] }>(accountId, {
            method: 'GET',
            path: '/tbo',
            query: { limit: '5' },
            signal: opts?.signal
          }).catch(() => ({ items: [] }))
        ).items?.length
        ? true
        : false

  requireTargetGeneration(accountId, generation)
  requireCredentialRevision(accountId, revision)
  const raw = await callDotApi<Record<string, unknown>>(accountId, {
    method: 'POST',
    path: '/tbo',
    signal: opts?.signal,
    body: {
      display_name: opts?.displayName?.trim() || 'Dot',
      ...(opts?.color ? { color: opts.color } : {}),
      create_thread: true,
      create_additional: Boolean(existing),
      should_initialize: true
    }
  })

  return normalizeDotProfile(raw)
}

export async function getDot(accountId: string, dotId: string, signal?: AbortSignal): Promise<DotProfile> {
  const raw = await callDotApi<Record<string, unknown>>(accountId, {
    method: 'GET',
    path: `/tbo/${encodeURIComponent(dotId)}`,
    signal
  })
  return normalizeDotProfile(raw)
}

export async function deleteDot(accountId: string, dotId: string): Promise<unknown> {
  const result = await callDotApi(accountId, {
    method: 'DELETE',
    path: `/tbo/${encodeURIComponent(dotId)}`
  })
  if (getStoredDotAccount(accountId)?.activeDotId === dotId) {
    patchStoredDotAccount(accountId, { activeDotId: undefined, roomId: undefined, threadId: undefined })
  }
  return result
}

interface DotRoomTarget extends DotTarget {
  roomId: string
  threadId?: string
  generation: number
}

interface DotTurn {
  id: string
  botId?: string
  target?: DotRoomTarget
  controller: AbortController
  interruptNative?: () => void
}

const activeDotTurns = new Map<string, DotTurn>()
const runtimeInterrupts = new Map<string, { promise: Promise<void>; controller: AbortController }>()
const nativeConnections = new Map<string, Set<(error: Error) => void>>()

function requireStableDotProfile(accountId: string): void {
  if (profileSelections.has(accountId)) throw new DotApiError(409, 'A Dot profile switch is in progress')
}

export async function selectDotProfile(accountId: string, dotId: string, botId?: string) {
  profileSelections.get(accountId)?.abort()
  const selection = new AbortController()
  profileSelections.set(accountId, selection)
  const { signal } = selection
  const generation = invalidateDotTarget(accountId)
  const revision = getDotCredentialRevision(accountId)
  try {
    const dot = await getDot(accountId, dotId, signal)
    requireTargetGeneration(accountId, generation)
    requireCredentialRevision(accountId, revision)
    if (dot.id !== dotId) throw new DotApiError(409, 'The Dot profile ID changed')
    if (!dot.messagingRoomId) throw new DotApiError(404, 'No active Dot room found')
    const history = await fetchRoomHistory(accountId, {
      dotId, roomId: dot.messagingRoomId, threadId: dot.activeRootThreadId, generation
    }, { signal })
    requireTargetGeneration(accountId, generation)
    requireCredentialRevision(accountId, revision)
    profileSelections.delete(accountId)
    const target = activateDotProfile(accountId, dot, botId)
    ensureRoomPoller(accountId, dot.messagingRoomId, history.messages)
    return { ...history, ...target, dot }
  } finally {
    if (profileSelections.get(accountId) === selection) {
      profileSelections.delete(accountId)
      void ensureCelsiusWatcher(accountId, getStoredDotAccount(accountId)?.roomId)
    }
  }
}

function beginDotTurn(accountId: string, id: string = randomUUID(), botId?: string): DotTurn {
  abortDotTurn(accountId)
  const turn = { id, botId, controller: new AbortController() }
  activeDotTurns.set(accountId, turn)
  return turn
}

function abortDotTurn(accountId: string, turnId?: string): DotTurn | undefined {
  const turn = activeDotTurns.get(accountId)
  if (!turn || (turnId && turn.id !== turnId)) return
  activeDotTurns.delete(accountId)
  try {
    turn.interruptNative?.()
  } catch {
    /* The socket can close before the interrupt is sent. */
  }
  turn.controller.abort(new DotApiError(499, 'Dot turn cancelled'))
  return turn
}

function invalidateDotTarget(accountId: string): number {
  const generation = getDotTargetGeneration(accountId) + 1
  targetGenerations.set(accountId, generation)
  abortDotTurn(accountId)
  closeCelsiusWatcher(accountId)
  return generation
}

export function disconnectDotAccount(accountId: string): void {
  profileSelections.get(accountId)?.abort()
  profileSelections.delete(accountId)
  invalidateDotTarget(accountId)
  runtimeInterrupts.get(accountId)?.controller.abort()
  for (const close of nativeConnections.get(accountId) ?? []) close(new DotApiError(499, 'Dot disconnected'))
}

export async function pauseDotRuntime(accountId: string, dotId?: string): Promise<unknown> {
  const acc = getStoredDotAccount(accountId)
  const targetDotId = dotId || acc?.activeDotId
  const turn = activeDotTurns.get(accountId)
  if (!turn?.target || !targetDotId || turn.target.dotId === targetDotId) abortDotTurn(accountId)
  if (!targetDotId) return { ok: true }
  return callDotApi(accountId, {
    method: 'POST',
    path: `/tbo/${encodeURIComponent(targetDotId)}/runtime/pause`,
    body: {}
  })
}

export async function resumeDotRuntime(accountId: string, dotId?: string): Promise<unknown> {
  const acc = getStoredDotAccount(accountId)
  const targetDotId = dotId || acc?.activeDotId
  if (!targetDotId) throw new DotApiError(400, 'dotId required')
  return callDotApi(accountId, {
    method: 'POST',
    path: `/tbo/${encodeURIComponent(targetDotId)}/runtime/resume`,
    body: {}
  })
}

export async function cancelDotTurn(accountId: string, dotId?: string, turnId?: string): Promise<unknown> {
  const turn = abortDotTurn(accountId, turnId)
  const targetDotId = turn ? turn.target?.dotId : turnId ? undefined : dotId || getStoredDotAccount(accountId)?.activeDotId
  if (!targetDotId) return { ok: true }

  const previous = runtimeInterrupts.get(accountId)
  if (previous) {
    await previous.promise
    return { ok: true }
  }

  const revision = getDotCredentialRevision(accountId)
  const controller = new AbortController()
  const { signal } = controller
  const promise = (async () => {
    try {
      await callDotApi(accountId, {
        method: 'POST',
        path: `/tbo/${encodeURIComponent(targetDotId)}/runtime/pause`,
        body: {},
        signal
      })
      await delayDotRequest(600, undefined, { signal })
      requireCredentialRevision(accountId, revision)
      await callDotApi(accountId, {
        method: 'POST',
        path: `/tbo/${encodeURIComponent(targetDotId)}/runtime/resume`,
        body: {},
        signal
      })
    } catch {
      /* A failed interrupt should not block the next turn. */
    }
  })()
  runtimeInterrupts.set(accountId, { promise, controller })
  try {
    await promise
  } finally {
    if (runtimeInterrupts.get(accountId)?.promise === promise) runtimeInterrupts.delete(accountId)
  }
  return { ok: true }
}

export async function listDotThreads(accountId: string, dotId?: string): Promise<unknown> {
  requireStableDotProfile(accountId)
  const generation = getDotTargetGeneration(accountId)
  const acc = getStoredDotAccount(accountId)
  const targetDotId = dotId || acc?.activeDotId || (await listDots(accountId)).activeDot?.id
  if (!targetDotId) return { items: [] }
  requireTargetGeneration(accountId, generation)
  const result = await callDotApi(accountId, {
    method: 'GET',
    path: `/tbo/${encodeURIComponent(targetDotId)}/threads`
  })
  requireTargetGeneration(accountId, generation)
  return result
}

export function inferDotFileMimeType(name?: string, rawMime?: string): string {
  const guessed = guessMediaMimeFromName(name)
  if (guessed) return guessed
  const lower = (name || '').toLowerCase()
  if (lower.endsWith('.py')) return 'text/x-python'
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.ts') || lower.endsWith('.tsx')) {
    return 'text/javascript'
  }
  if (lower.endsWith('.css')) return 'text/css'
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain'
  if (rawMime && rawMime !== 'application/octet-stream') return rawMime
  return rawMime || 'application/octet-stream'
}

export function isDotAckMessage(msg: DotRoomMessage): boolean {
  if (
    msg.attachments &&
    msg.attachments.some((a) => a.type === 'file' || a.downloadUrl || a.fileId)
  ) {
    return false
  }
  if (msg.turnTrigger === 'aeon_transplant') {
    return true
  }
  if (msg.text.length < 260) {
    if (
      /做好后|发给你|稍等|正在|马上|开始|我现在就|我会创建|先帮你|我去|为你生成|我先|请稍候|继续处理|I'll|I will|working on|one moment|let me|了解しました|送ります|作成します|少々お待ち|今すぐ|処理します|Je vais|Un instant/i.test(
        msg.text
      )
    ) {
      return true
    }
  }
  return false
}

export function dotAttachmentsToMedia(
  attachments?: DotRoomAttachment[]
): MuseMediaPartView[] | undefined {
  if (!attachments || attachments.length === 0) return undefined
  const out: MuseMediaPartView[] = []
  for (const att of attachments) {
    if (att.type === 'widget' || (!att.downloadUrl && !att.fileId && !att.name)) {
      continue
    }
    const name = att.name || att.fileId || att.attachmentId || 'attachment'
    const mimeType = inferDotFileMimeType(name, att.mimeType)
    const isImg =
      mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(name)
    const path =
      att.downloadUrl ||
      (att.fileId ? `dotfile://${att.fileId}` : '')
    if (!path) continue
    out.push({
      kind: isImg ? 'image' : 'file',
      path,
      name,
      mimeType
    })
  }
  return out.length > 0 ? out : undefined
}

export function normalizeRoomMessage(raw: Record<string, unknown>, fallbackRoomId = ''): DotRoomMessage {
  const id = String(raw['id'] ?? raw['message_id'] ?? '')
  const roomId = String(raw['room_id'] ?? fallbackRoomId)
  const accountUserId = String(raw['account_user_id'] ?? '')
  const isBot =
    accountUserId.startsWith('calpico-member-') ||
    String(raw['role'] ?? '').toLowerCase() === 'assistant'
  const contentObj =
    raw['content'] && typeof raw['content'] === 'object'
      ? (raw['content'] as Record<string, unknown>)
      : {}
  const text = String(contentObj['text'] ?? raw['text'] ?? '').trim()
  const rawAtts: unknown[] = [
    ...(Array.isArray(contentObj['attachments']) ? (contentObj['attachments'] as unknown[]) : []),
    ...(Array.isArray(contentObj['images']) ? (contentObj['images'] as unknown[]) : []),
    ...(Array.isArray(contentObj['videos']) ? (contentObj['videos'] as unknown[]) : []),
    ...(Array.isArray(contentObj['media']) ? (contentObj['media'] as unknown[]) : []),
    ...(Array.isArray(contentObj['files']) ? (contentObj['files'] as unknown[]) : [])
  ]
  const seenAtt = new Set<string>()
  const attachments: DotRoomAttachment[] = []
  for (const a of rawAtts) {
    if (!a || typeof a !== 'object') continue
    const ao = a as Record<string, unknown>
    const fileObj =
      ao['file'] && typeof ao['file'] === 'object'
        ? (ao['file'] as Record<string, unknown>)
        : {}
    const name =
      (typeof fileObj['name'] === 'string' && fileObj['name']) ||
      (typeof ao['name'] === 'string' && ao['name']) ||
      (typeof ao['file_name'] === 'string' && ao['file_name']) ||
      undefined
    const rawMime =
      (typeof fileObj['mime_type'] === 'string' && fileObj['mime_type']) ||
      (typeof ao['mime_type'] === 'string' && ao['mime_type']) ||
      (typeof ao['content_type'] === 'string' && ao['content_type']) ||
      undefined
    const fileId =
      (typeof ao['file_id'] === 'string' && ao['file_id']) ||
      (typeof fileObj['id'] === 'string' && fileObj['id']) ||
      undefined
    const downloadUrl =
      (typeof fileObj['download_url'] === 'string' && fileObj['download_url']) ||
      (typeof fileObj['url'] === 'string' && fileObj['url']) ||
      (typeof ao['download_url'] === 'string' && ao['download_url']) ||
      (typeof ao['url'] === 'string' && ao['url']) ||
      undefined
    const attachmentId = String(ao['attachment_id'] ?? fileObj['id'] ?? fileId ?? '')
    const dedupKey = downloadUrl || fileId || attachmentId || name || ''
    if (!dedupKey || seenAtt.has(dedupKey)) continue
    seenAtt.add(dedupKey)
    attachments.push({
      attachmentId,
      type: String(ao['type'] ?? 'file'),
      fileId,
      name,
      mimeType: inferDotFileMimeType(name, rawMime),
      downloadUrl
    })
  }

  const metadata =
    raw['message_metadata'] && typeof raw['message_metadata'] === 'object'
      ? (raw['message_metadata'] as Record<string, unknown>)
      : raw['metadata'] && typeof raw['metadata'] === 'object'
        ? (raw['metadata'] as Record<string, unknown>)
        : {}
  const createdStr = typeof raw['created_at'] === 'string' ? raw['created_at'] : ''
  const createdAtMs = createdStr ? Date.parse(createdStr) || Date.now() : Date.now()

  return {
    id,
    roomId,
    role: isBot ? 'bot' : 'user',
    accountUserId,
    text,
    createdAtMs,
    turnTrigger: typeof metadata['turn_trigger'] === 'string' ? metadata['turn_trigger'] : undefined,
    threadTurnId: typeof metadata['thread_turn_id'] === 'string' ? metadata['thread_turn_id'] : undefined,
    ...(attachments.length > 0 ? { attachments } : {})
  }
}

async function pinDotRoom(accountId: string, requested: DotTarget, signal?: AbortSignal): Promise<DotRoomTarget> {
  requireStableDotProfile(accountId)
  const generation = getDotTargetGeneration(accountId)
  const acc = getStoredDotAccount(accountId)
  const target = resolveDotTarget(requested, acc)
  if (target.roomId && target.dotId === acc?.activeDotId) {
    return { ...target, roomId: target.roomId, threadId: acc?.threadId, generation }
  }
  if (!target.dotId) return (await initializeDots(accountId, signal)).target
  const profile = await getDot(accountId, target.dotId, signal)
  signal?.throwIfAborted()
  requireTargetGeneration(accountId, generation)
  if (target.dotId !== profile.id) throw new DotApiError(409, 'The Dot profile ID changed')
  return activateDotProfile(accountId, profile)
}

interface RoomHistoryOptions {
  limit?: number
  after?: string
  signal?: AbortSignal
}

async function fetchRoomHistory(accountId: string, target: DotRoomTarget, opts?: RoomHistoryOptions) {
  const { roomId } = target
  requireTargetGeneration(accountId, target.generation)
  // IMPORTANT: Calpico room messages API enforces `limit <= 32` (HTTP 422 if > 32).
  const limit = Math.max(1, Math.min(32, opts?.limit ?? 32))
  const res = await callDotApi<{
    items?: unknown[]
    data?: unknown[]
    has_more?: boolean
  }>(accountId, {
    method: 'GET',
    path: `/messaging/rooms/${encodeURIComponent(roomId)}/messages`,
    query: {
      limit: String(limit),
      ...(opts?.after ? { after: opts.after } : {})
    },
    signal: opts?.signal
  })
  requireTargetGeneration(accountId, target.generation)
  const list = Array.isArray(res?.items)
    ? res.items
    : Array.isArray(res?.data)
      ? res.data
      : []
  const messages: DotRoomMessage[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    try {
      const raw = item as Record<string, unknown>
      const id = raw['id'] ?? raw['message_id']
      if (typeof id !== 'string' && typeof id !== 'number') continue
      const message = normalizeRoomMessage(raw, roomId)
      if (message.id && message.roomId === roomId) messages.push(message)
    } catch {
      /* A malformed record does not invalidate the rest of the page. */
    }
  }
  return {
    ...target,
    messages,
    hasMore: Boolean(res?.has_more)
  }
}

export async function listRoomMessages(accountId: string, opts?: DotTarget & RoomHistoryOptions) {
  const account = getStoredDotAccount(accountId)
  if (account?.mode === 'native' && !opts?.dotId && !opts?.roomId) {
    return { roomId: '', messages: [], hasMore: false }
  }
  const target = await pinDotRoom(accountId, opts ?? {}, opts?.signal)
  const history = await fetchRoomHistory(accountId, target, opts)
  requireTargetGeneration(accountId, target.generation)
  ensureRoomPoller(accountId, target.roomId, history.messages)
  return history
}

export async function downloadDotFile(
  accountId: string,
  opts: { url?: string; fileId?: string; roomId?: string; name?: string }
): Promise<{
  name: string
  filename: string
  mimeType: string
  size: number
  dataBase64: string
  text?: string
}> {
  const revision = getDotCredentialRevision(accountId)
  const acc = await ensureValidDotAccount(accountId)
  let targetUrl = opts.url?.trim() || ''
  let fileId = opts.fileId?.trim() || ''
  let fileName = opts.name?.trim() || ''

  if (targetUrl.startsWith('dotfile://')) {
    fileId = targetUrl.slice('dotfile://'.length)
    targetUrl = ''
  }

  const resolveFreshUrlFromRoom = async (): Promise<string> => {
    const listed = await listRoomMessages(accountId, {
      roomId: opts.roomId || acc.roomId,
      limit: 32
    }).catch(() => ({ messages: [] as DotRoomMessage[] }))
    for (let i = listed.messages.length - 1; i >= 0; i--) {
      const m = listed.messages[i]!
      for (const att of m.attachments ?? []) {
        if (!att.downloadUrl) continue
        if (
          (fileId && (att.fileId === fileId || att.attachmentId === fileId)) ||
          (fileName && att.name === fileName)
        ) {
          if (!fileName && att.name) fileName = att.name
          return att.downloadUrl
        }
      }
    }
    return ''
  }

  const resolveFreshUrlFromLibrary = async (fid: string): Promise<string> => {
    if (!fid.startsWith('file_') && !fid.startsWith('file-')) return ''
    try {
      const info = await callDotApi<{
        download_url?: string
        file_name?: string
      }>(accountId, {
        method: 'GET',
        path: `/files/download/${encodeURIComponent(fid)}`
      })
      if (!fileName && info?.file_name) fileName = info.file_name
      return info?.download_url || ''
    } catch {
      return ''
    }
  }

  if (!targetUrl && fileId) {
    if (fileId.startsWith('libfile_')) {
      try {
        const lib = (await listDotLibraryNodes(accountId, 50)) as {
          items?: Array<Record<string, unknown>>
          nodes?: Array<Record<string, unknown>>
        }
        const nodes = Array.isArray(lib?.items)
          ? lib.items
          : Array.isArray(lib?.nodes)
            ? lib.nodes
            : []
        const matched = nodes.find((n) => n && (n['id'] === fileId || n['node_id'] === fileId))
        if (matched) {
          if (!fileName && typeof matched['title'] === 'string') fileName = matched['title']
          if (!fileName && typeof matched['name'] === 'string') fileName = matched['name']
          if (typeof matched['download_url'] === 'string' && matched['download_url']) {
            targetUrl = matched['download_url']
          } else if (typeof matched['file_id'] === 'string' && matched['file_id']) {
            fileId = matched['file_id']
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (!targetUrl && (fileId.startsWith('file_') || fileId.startsWith('file-'))) {
      targetUrl = await resolveFreshUrlFromLibrary(fileId)
    }
    if (!targetUrl) {
      targetUrl = await resolveFreshUrlFromRoom()
    }
  }

  if (!targetUrl && fileName) {
    targetUrl = await resolveFreshUrlFromRoom()
  }

  if (!targetUrl) {
    throw new DotApiError(404, '无法解析 Dot 文件下载链接')
  }

  const fetchUrl = async (rawUrl: string): Promise<Response> => {
    const expected = new URL(DOT_ORIGIN)
    const effectiveProxy = await resolveDotProxyUrl(accountId)
    const deadline = AbortSignal.timeout(30_000)
    let url = new URL(rawUrl, expected)
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new DotApiError(400, 'Invalid Dot file URL')
      }
      requireCredentialRevision(accountId, revision)
      const current = getStoredDotAccount(accountId) ?? acc
      const headers = url.origin === expected.origin
        ? {
            Authorization: `Bearer ${current.accessToken}`,
            ...(current.chatgptAccountId ? { 'chatgpt-account-id': current.chatgptAccountId } : {}),
            Origin: DOT_ORIGIN,
            Referer: `${DOT_ORIGIN}/dots`,
            'User-Agent': CHROME_UA
          }
        : { 'User-Agent': CHROME_UA }
      const response = await proxyFetch(effectiveProxy, url.href, { headers, redirect: 'manual', signal: deadline })
      const location = response.headers.get('location')
      if (response.status < 300 || response.status >= 400 || !location) return response
      void response.body?.cancel().catch(() => undefined)
      url = new URL(location, url)
    }
    throw new DotApiError(502, 'Too many Dot file redirects')
  }

  let res = await fetchUrl(targetUrl)
  if (!res.ok && (res.status === 401 || res.status === 403 || res.status === 404)) {
    const refreshedUrl =
      (fileId && (fileId.startsWith('file_') || fileId.startsWith('file-'))
        ? await resolveFreshUrlFromLibrary(fileId)
        : '') || (await resolveFreshUrlFromRoom())
    if (refreshedUrl && refreshedUrl !== targetUrl) {
      targetUrl = refreshedUrl
      res = await fetchUrl(targetUrl)
    }
  }

  if (!res.ok) {
    throw new DotApiError(res.status, `下载 Dot 文件失败 (${res.status})`)
  }

  const ab = await res.arrayBuffer()
  requireCredentialRevision(accountId, revision)
  const buf = Buffer.from(ab)
  const finalName = fileName || 'document'
  const mimeType = inferMediaMime({
    headerMime: res.headers.get('content-type') ?? undefined,
    nameOrPath: finalName,
    bytes: buf,
    fallback: inferDotFileMimeType(finalName)
  })
  const isTextLike =
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'image/svg+xml' ||
    /\.(html?|md|markdown|txt|json|csv|py|js|ts|tsx|css|svg|xml|yaml|yml)$/i.test(finalName)

  return {
    name: finalName,
    filename: finalName,
    mimeType,
    size: buf.byteLength,
    dataBase64: buf.toString('base64'),
    ...(isTextLike ? { text: buf.toString('utf8') } : {})
  }
}

/**
 * Maintain a persistent `POST /backend-api/messaging/rooms/{room_id}/live` SSE connection
 * while the room is active so the backend streams `calpico-room-live` / `calpico-message-add`
 * events onto both the SSE response and the user's Celsius WebSocket.
 */
interface RoomLiveStreamState {
  ac: AbortController
  startedAt: number
}

const activeRoomLiveStreams = new Map<string, RoomLiveStreamState>()

export function closeRoomLiveStream(accountId: string, roomId?: string): void {
  for (const [k, v] of activeRoomLiveStreams.entries()) {
    if (k === `${accountId}:${roomId}` || (!roomId && k.startsWith(`${accountId}:`))) {
      v.ac.abort()
      activeRoomLiveStreams.delete(k)
    }
  }
}

export async function triggerRoomLivePush(accountId: string, roomId: string): Promise<void> {
  const acc = getStoredDotAccount(accountId)
  if (!roomId || acc?.roomId !== roomId) return
  const target = { dotId: acc.activeDotId, roomId, generation: getDotTargetGeneration(accountId) }
  const key = `${accountId}:${roomId}`
  const existing = activeRoomLiveStreams.get(key)
  if (existing && Date.now() - existing.startedAt < 10 * 60 * 1000) {
    return
  }
  existing?.ac.abort()

  const ac = new AbortController()
  activeRoomLiveStreams.set(key, { ac, startedAt: Date.now() })
  // Refresh after 10 minutes
  const maxTimer = setTimeout(() => {
    ac.abort()
    if (activeRoomLiveStreams.get(key)?.ac === ac) activeRoomLiveStreams.delete(key)
  }, 10 * 60 * 1000)

  try {
    const acc = await ensureValidDotAccount(accountId, ac.signal)
    const effectiveProxy = await resolveDotProxyUrl(accountId)
    ac.signal.throwIfAborted()
    requireTargetGeneration(accountId, target.generation)
    const res = await proxyFetch(effectiveProxy, `${DOT_API_BASE}/messaging/rooms/${encodeURIComponent(roomId)}/live`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${acc.accessToken}`,
        ...(acc.chatgptAccountId ? { 'chatgpt-account-id': acc.chatgptAccountId } : {}),
        Accept: 'text/event-stream',
        Origin: DOT_ORIGIN,
        Referer: `${DOT_ORIGIN}/dots`,
        'User-Agent': CHROME_UA
      },
      redirect: 'error',
      signal: ac.signal
    })
    if (!res.ok || !res.body) return
    let buffer = ''
    const decoder = new TextDecoder()
    const processLines = (lines: string[]) => {
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const jsonStr = line.slice(5).trim()
        if (!jsonStr || jsonStr === '[DONE]') continue
        try {
          const ev = JSON.parse(jsonStr) as Record<string, unknown>
          handleCalpicoEventPayload(accountId, ev, target)
        } catch {
          /* ignore */
        }
      }
    }
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      ac.signal.throwIfAborted()
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      if (buffer.length > 1024 * 1024) return
      processLines(lines)
    }
    if (!ac.signal.aborted) processLines([buffer + decoder.decode()])
  } catch {
    /* stream closed or aborted */
  } finally {
    clearTimeout(maxTimer)
    if (activeRoomLiveStreams.get(key)?.ac === ac) {
      activeRoomLiveStreams.delete(key)
    }
  }
}

const NO_TOOLS_PROMPT_RE =
  /(do not (call|use) (or use )?any tools|without invoking any tools|いかなるツールも(呼び出したり使用したりしないで|使用しないで)|n'utilisez aucun outil|不要(调用|使用)任何工具)/i

export interface DotUploadAttachmentInput {
  name: string
  mimeType: string
  dataBase64: string
}

/**
 * Upload a user image / video / file to ChatGPT `/backend-api/files` so Dot can
 * inspect it inside a Calpico room message (`content.attachments`).
 */
export async function uploadDotRoomAttachment(
  accountId: string,
  file: DotUploadAttachmentInput,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const revision = getDotCredentialRevision(accountId)
  signal?.throwIfAborted()
  const bytes = Buffer.from(file.dataBase64, 'base64')
  const fileName = file.name || 'attachment'
  const mimeType = inferMediaMime({
    headerMime: file.mimeType,
    nameOrPath: fileName,
    bytes
  })
  const isImage = mimeType.startsWith('image/')
  const init = await callDotApi<{
    file_id?: string
    upload_url?: string
    status?: string
  }>(accountId, {
    method: 'POST',
    path: '/files',
    signal,
    body: {
      file_name: fileName,
      file_size: bytes.byteLength,
      use_case: isImage ? 'multimodal' : 'my_files',
      timezone_offset_min: new Date().getTimezoneOffset()
    }
  })

  const fileId = init?.file_id
  const uploadUrl = init?.upload_url
  if (!fileId || !uploadUrl) {
    throw new DotApiError(502, 'Dot 文件上传初始化失败（缺少 upload_url）')
  }

  const effectiveProxy = await resolveDotProxyUrl(accountId)
  signal?.throwIfAborted()
  requireCredentialRevision(accountId, revision)
  const deadline = AbortSignal.timeout(120_000)
  const isAzureBlob = /blob\.core\.windows\.net/i.test(uploadUrl)
  const putRes = await proxyFetch(effectiveProxy, uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      ...(isAzureBlob ? { 'x-ms-blob-type': 'BlockBlob' } : {})
    },
    body: new Uint8Array(bytes),
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline
  })
  if (!putRes.ok) {
    throw new DotApiError(putRes.status, `Dot 文件上传失败 (${putRes.status})`)
  }

  await callDotApi(accountId, {
    method: 'POST',
    path: `/files/${encodeURIComponent(fileId)}/uploaded`,
    body: {},
    signal
  }).catch(() => undefined)
  signal?.throwIfAborted()
  requireCredentialRevision(accountId, revision)

  return {
    attachment_id: randomUUID(),
    type: 'file',
    file_id: fileId,
    file: {
      id: fileId,
      name: fileName,
      mime_type: mimeType,
      size: bytes.byteLength
    }
  }
}

async function sendRoomMessage(
  accountId: string,
  target: DotRoomTarget,
  opts: { text: string; attachments?: DotUploadAttachmentInput[]; signal: AbortSignal }
): Promise<{ roomId: string; dotId?: string; message: DotRoomMessage }> {
  const { roomId, dotId, generation } = target
  opts.signal.throwIfAborted()
  requireTargetGeneration(accountId, generation)

  const uploadedAttachments: Record<string, unknown>[] = []
  if (opts.attachments && opts.attachments.length > 0) {
    for (const att of opts.attachments) {
      if (!att.dataBase64) continue
      uploadedAttachments.push(await uploadDotRoomAttachment(accountId, att, opts.signal))
    }
  }

  // In Calpico rooms (`aeon`), posting a reply into the user's chat room is itself an internal
  // messaging tool action. Prompts that strictly forbid *all* tools can cause the model to write
  // only to its internal thread stdout without posting the reply to the room.
  const wireText = NO_TOOLS_PROMPT_RE.test(opts.text)
    ? `${opts.text}\n\n(Note for room delivery: do not use any external/search/code/file tools, but do send your final response text directly into this chat room.)`
    : opts.text

  requireTargetGeneration(accountId, generation)
  const raw = await callDotApi<Record<string, unknown>>(accountId, {
    method: 'POST',
    path: `/messaging/rooms/${encodeURIComponent(roomId)}/messages`,
    signal: opts.signal,
    body: {
      content: {
        text: wireText,
        attachments: uploadedAttachments
      },
      request_id: randomUUID(),
      idempotency_token: randomUUID()
    }
  })
  requireTargetGeneration(accountId, generation)

  const message = normalizeRoomMessage(raw, roomId)
  message.text = opts.text
  return { roomId, dotId, message }
}

// ============================================================================
// Persistent Celsius WebSocket Watcher (`GET /backend-api/celsius/ws/user`)
// & Continuous Room Message Sync Poller
// ============================================================================

interface CelsiusWatcherState {
  controller: AbortController
  ws?: WebSocket
  reconnectTimer?: NodeJS.Timeout
  pingTimer?: NodeJS.Timeout
}

interface RoomPollerState {
  target: DotRoomTarget
  controller: AbortController
  request?: AbortController
  timer?: NodeJS.Timeout
  lastActiveAt: number
  busy: boolean
  seeded: boolean
  seenMessageIds: Map<string, string>
}

const celsiusWatchers = new Map<string, CelsiusWatcherState>()
const roomPollers = new Map<string, RoomPollerState>()
const MAX_SEEN_MESSAGE_IDS = 512

function messageSignature(msg: DotRoomMessage): string {
  return JSON.stringify([msg.text, msg.attachments ?? []])
}

function rememberRoomMessage(poller: RoomPollerState | undefined, msg: DotRoomMessage): boolean {
  if (!poller) return true
  const signature = messageSignature(msg)
  if (poller.seenMessageIds.get(msg.id) === signature) return false
  poller.seenMessageIds.delete(msg.id)
  poller.seenMessageIds.set(msg.id, signature)
  if (poller.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
    const oldest = poller.seenMessageIds.keys().next().value
    if (oldest !== undefined) poller.seenMessageIds.delete(oldest)
  }
  return true
}

export function bumpDotRoomActivity(accountId: string, roomId?: string, busy = true): void {
  const poller = roomPollers.get(accountId)
  if (!poller || (roomId && poller.target.roomId !== roomId)) return
  poller.lastActiveAt = Date.now()
  poller.busy = busy
}

function turnForRoom(accountId: string, target: DotRoomTarget): DotTurn | undefined {
  const turn = activeDotTurns.get(accountId)
  if (turn?.target?.generation === target.generation && turn.target.roomId === target.roomId) return turn
  return undefined
}

export function ensureRoomPoller(accountId: string, roomId: string, seedMessages?: DotRoomMessage[]): void {
  const acc = getStoredDotAccount(accountId)
  if (!acc || !roomId || acc.roomId !== roomId) return
  const target = { dotId: acc.activeDotId, roomId, generation: getDotTargetGeneration(accountId) }
  const existing = roomPollers.get(accountId)
  if (existing) {
    if (seedMessages) {
      for (const message of seedMessages) rememberRoomMessage(existing, message)
      existing.seeded = true
    }
    return
  }

  const poller: RoomPollerState = {
    target,
    controller: new AbortController(),
    lastActiveAt: Date.now(),
    busy: false,
    seeded: Boolean(seedMessages),
    seenMessageIds: new Map()
  }
  for (const message of seedMessages ?? []) rememberRoomMessage(poller, message)
  roomPollers.set(accountId, poller)

  const tick = async () => {
    if (poller.controller.signal.aborted) return
    if (!turnForRoom(accountId, target)) {
      const request = new AbortController()
      poller.request = request
      try {
        const { messages } = await fetchRoomHistory(accountId, target, { limit: 12, signal: request.signal })
        request.signal.throwIfAborted()
        for (const message of messages) {
          const fresh = rememberRoomMessage(poller, message)
          if (poller.seeded && fresh && message.role === 'bot' && (message.text || message.attachments?.length)) {
            poller.lastActiveAt = Date.now()
            emitRealtime({
              type: 'message',
              accountId,
              botId: getStoredDotAccount(accountId)?.botId,
              target,
              message,
              done: true
            })
          }
        }
        poller.seeded = true
      } catch {
        /* Retry transient errors on the next interval. */
      } finally {
        poller.request = undefined
      }
    }
    if (!poller.controller.signal.aborted) {
      const recentlyActive = poller.busy || Date.now() - poller.lastActiveAt < 6 * 60 * 1000
      poller.timer = setTimeout(() => void tick(), recentlyActive ? 3000 : 12000)
    }
  }
  poller.timer = setTimeout(() => void tick(), 3500)
}

function handleCalpicoEventPayload(
  accountId: string,
  ev: Record<string, unknown>,
  target: DotRoomTarget
): void {
  if (getDotTargetGeneration(accountId) !== target.generation) return
  const acc = getStoredDotAccount(accountId)
  if (!acc || acc.roomId !== target.roomId || acc.activeDotId !== target.dotId) return
  const evType = String(ev['type'] ?? '')
  const payload = (ev['payload'] as Record<string, unknown> | undefined) ?? ev
  const evRoomId = String(payload['room_id'] ?? ev['room_id'] ?? target.roomId)
  if (evRoomId !== target.roomId) return

  const turn = turnForRoom(accountId, target)
  const route = {
    accountId,
    botId: turn?.botId ?? acc.botId,
    target,
    turnId: turn?.id
  }

  if (evType === 'calpico-message-add' || evType === 'calpico-message-update') {
    const msgRaw = payload['message'] as Record<string, unknown> | undefined
    if (!msgRaw || typeof msgRaw !== 'object') return
    const message = normalizeRoomMessage(msgRaw, evRoomId)
    if (!message.id || message.roomId !== target.roomId || message.role !== 'bot' || (!message.text && !message.attachments?.length)) return
    const poller = roomPollers.get(accountId)
    if (poller && !rememberRoomMessage(poller, message)) return
    bumpDotRoomActivity(accountId, target.roomId, true)
    emitRealtime({ type: 'message', ...route, message, done: true })
  } else if (evType === 'calpico-is-responding-heartbeat') {
    const busy = Boolean(payload['typing'])
    bumpDotRoomActivity(accountId, target.roomId, busy)
    emitRealtime({
      type: 'activity',
      ...route,
      code: busy ? 'thinking' : 'idle',
      text: busy ? 'Dot is responding…' : undefined,
      busy
    })
  } else if (evType === 'calpico-room-live' || evType === 'calpico-room-live-state') {
    const threads = Array.isArray(payload['threads']) ? payload['threads'] : []
    const first = threads[0] as Record<string, unknown> | undefined
    const activity = first?.['activity_status'] as Record<string, unknown> | undefined
    const statusType = String(activity?.['status_type'] ?? '').toLowerCase()
    const busy = first?.['turn_status'] === 'in_progress' || (statusType !== '' && statusType !== 'ready')
    bumpDotRoomActivity(accountId, target.roomId, busy)
    emitRealtime({
      type: 'activity',
      ...route,
      code: busy ? statusType || 'thinking' : 'idle',
      text: busy ? String(activity?.['status_label'] || first?.['summary'] || 'Thinking…') : undefined,
      busy
    })
  }
}

export function closeCelsiusWatcher(accountId: string): void {
  if (accountId === '*') {
    const ids = new Set([
      ...celsiusWatchers.keys(),
      ...roomPollers.keys(),
      ...activeDotTurns.keys(),
      ...nativeConnections.keys(),
      ...runtimeInterrupts.keys(),
      ...profileSelections.keys()
    ])
    for (const id of ids) disconnectDotAccount(id)
    return
  }

  closeRoomLiveStream(accountId)
  const poller = roomPollers.get(accountId)
  if (poller) {
    roomPollers.delete(accountId)
    poller.controller.abort()
    poller.request?.abort()
    clearTimeout(poller.timer)
  }
  const watcher = celsiusWatchers.get(accountId)
  if (watcher) {
    celsiusWatchers.delete(accountId)
    watcher.controller.abort()
    clearTimeout(watcher.reconnectTimer)
    clearInterval(watcher.pingTimer)
    watcher.ws?.terminate()
  }
}

export function rebindDotAccountNetwork(accountId: string): void {
  const wasWatching = celsiusWatchers.has(accountId) || roomPollers.has(accountId)
  disconnectDotAccount(accountId)
  // The account proxy settings have taken over this account's routing.
  patchStoredDotAccount(accountId, { proxyUrl: undefined })
  if (wasWatching) void ensureCelsiusWatcher(accountId, getStoredDotAccount(accountId)?.roomId)
}

export async function ensureCelsiusWatcher(accountId: string, roomId?: string): Promise<void> {
  const acc = getStoredDotAccount(accountId)
  if (!acc || !roomId || acc.roomId !== roomId || profileSelections.has(accountId)) return
  ensureRoomPoller(accountId, roomId)
  void triggerRoomLivePush(accountId, roomId)
  if (celsiusWatchers.has(accountId)) return

  const target = { dotId: acc.activeDotId, roomId, generation: getDotTargetGeneration(accountId) }
  const watcher: CelsiusWatcherState = { controller: new AbortController() }
  celsiusWatchers.set(accountId, watcher)
  const { signal } = watcher.controller
  const ownsWatcher = () => !signal.aborted &&
    celsiusWatchers.get(accountId) === watcher && getDotTargetGeneration(accountId) === target.generation
  const reconnect = () => {
    if (!ownsWatcher()) return
    clearInterval(watcher.pingTimer)
    watcher.ws = undefined
    watcher.reconnectTimer = setTimeout(() => {
      if (!ownsWatcher()) return
      celsiusWatchers.delete(accountId)
      void ensureCelsiusWatcher(accountId, roomId)
    }, 4000)
  }
  try {
    const info = await callDotApi<{ websocket_url?: string }>(accountId, {
      method: 'GET',
      path: '/celsius/ws/user',
      signal
    })
    const proxy = await resolveDotProxyUrl(accountId)
    if (!ownsWatcher()) return
    if (!info?.websocket_url) {
      reconnect()
      return
    }
    const socketUrl = new URL(info.websocket_url)
    if (socketUrl.protocol !== 'wss:') throw new DotApiError(502, 'Invalid Celsius WebSocket URL')
    const ws = new WebSocket(socketUrl, {
      agent: proxyWsAgent(proxy),
      handshakeTimeout: 15_000,
      headers: { Origin: DOT_ORIGIN, 'User-Agent': CHROME_UA }
    })
    watcher.ws = ws
    ws.on('error', () => ws.terminate())
    ws.once('close', reconnect)
    ws.once('open', () => {
      if (!ownsWatcher()) return
      watcher.pingTimer = setInterval(() => {
        if (ownsWatcher() && ws.readyState === WebSocket.OPEN) ws.ping()
      }, 25_000)
      ws.send(JSON.stringify([
        { command: { type: 'connect', presence: { type: 'presence', state: 'foreground' } }, id: 1 },
        { command: { type: 'subscribe', topic_id: 'calpico-chatgpt-messaging' }, id: 2 },
        { command: { type: 'subscribe', topic_id: `calpico-room-live:${roomId}` }, id: 3 }
      ]))
    })
    ws.on('message', (data) => {
      if (!ownsWatcher()) return
      try {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>
        const event = frame['payload']
        if (frame['type'] === 'message' && event && typeof event === 'object') {
          handleCalpicoEventPayload(accountId, event as Record<string, unknown>, target)
        }
      } catch {
        /* Ignore malformed frames. */
      }
    })
  } catch {
    reconnect()
  }
}

/**
 * Send a message to a Dot's Calpico room and watch both Celsius WS + room message polling
 * until Dot finishes its turn (including multi-minute code/file generation turns).
 */
export async function sendAndWatchDotRoomReply(
  accountId: string,
  opts: DotTarget & {
    turnId?: string
    botId?: string
    text: string
    attachments?: DotUploadAttachmentInput[]
    timeoutMs?: number
    onMessage?: (msg: DotRoomMessage, done: boolean, stillBusy?: boolean, target?: DotTarget) => void
    onActivity?: (code: string, text: string | undefined, busy: boolean) => void
    /** The user message is in the room (before any reply). */
    onSent?: () => void
  }
): Promise<{ roomId: string; sentMessage: DotRoomMessage; replies: DotRoomMessage[] }> {
  const turn = beginDotTurn(accountId, opts.turnId, opts.botId)
  const { signal } = turn.controller
  try {
    const target = await pinDotRoom(accountId, opts, signal)
    signal.throwIfAborted()
    requireTargetGeneration(accountId, target.generation)
    turn.target = target
    const poller = roomPollers.get(accountId)
    poller?.request?.abort()

    if (opts.botId && !isEphemeralRoomTurnBotId(opts.botId)) {
      patchStoredDotAccount(accountId, { botId: opts.botId })
    }
    void ensureCelsiusWatcher(accountId, target.roomId)
    const interrupt = runtimeInterrupts.get(accountId)
    if (interrupt) await waitForDotRequest(interrupt.promise, signal)
    const before = await fetchRoomHistory(accountId, target, { limit: 32, signal }).catch(() => undefined)
    signal.throwIfAborted()
    requireTargetGeneration(accountId, target.generation)
    const sent = await sendRoomMessage(accountId, target, { ...opts, signal })
    signal.throwIfAborted()
    opts.onSent?.()

    const { roomId } = target
    const beforeIds = new Set(before?.messages.map((m) => m.id))
    const sentId = sent.message.id
    const sentCreatedAtMs = sent.message.createdAtMs || Date.now()
    beforeIds.add(sentId)
    bumpDotRoomActivity(accountId, roomId, true)

    const startedAt = Date.now()
    const repliesById = new Map<string, DotRoomMessage>()
    const emittedSignatures = new Map<string, string>()
    let lastBusy = true
    let lastReplyAt = 0
    let idleEmptyChecks = 0
    let recoverySent = false
    let threadId = target.threadId

    opts.onActivity?.('thinking', 'Thinking…', true)

    return await new Promise((resolve, reject) => {
      let finished = false
      let pollTimer: NodeJS.Timeout | undefined
      const ownsTurn = () => !finished && !signal.aborted &&
        activeDotTurns.get(accountId) === turn && getDotTargetGeneration(accountId) === target.generation
      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(pollTimer)
        clearTimeout(deadline)
        signal.removeEventListener('abort', finish)
        unsub()
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        bumpDotRoomActivity(accountId, roomId, false)
        opts.onActivity?.('idle', undefined, false)
        resolve({ roomId, sentMessage: sent.message, replies: [...repliesById.values()] })
        turn.controller.abort()
      }

      const recordReply = (msg: DotRoomMessage) => {
        if (!ownsTurn() || msg.role !== 'bot' || (!msg.text && !msg.attachments?.length)) return
        if (beforeIds.has(msg.id) || msg.createdAtMs < sentCreatedAtMs - 5000) return
        const signature = messageSignature(msg)
        if (emittedSignatures.get(msg.id) === signature) return
        rememberRoomMessage(roomPollers.get(accountId), msg)
        repliesById.set(msg.id, msg)
        emittedSignatures.set(msg.id, signature)
        lastReplyAt = Date.now()
        idleEmptyChecks = 0
        if (opts.onMessage) {
          opts.onMessage(msg, true, isDotAckMessage(msg), target)
        } else {
          emitRealtime({
            type: 'message', accountId, botId: opts.botId ?? getStoredDotAccount(accountId)?.botId,
            target, message: msg, done: true
          })
        }
      }

      const recover = async (transplant: boolean) => {
        if (!ownsTurn() || recoverySent) return
        recoverySent = true
        idleEmptyChecks = 0
        lastBusy = true
        opts.onActivity?.(
          'thinking',
          transplant
            ? 'Dot 容器刚完成自动迁移，正在自动续发任务获取回复…'
            : 'Dot 已在内部完成计算，正在同步回复到聊天室…',
          true
        )
        try {
          const text = transplant
            ? `请继续直接完成刚才这条任务并把完整结果发到当前聊天室：\n\n${opts.text}`
            : '请把你刚才针对上一条消息生成的完整结果直接发送到当前聊天室中（不要只留在内部输出）。'
          const nudge = await sendRoomMessage(accountId, target, { text, signal })
          if (ownsTurn()) beforeIds.add(nudge.message.id)
        } catch {
          /* A failed recovery still allows any late reply to arrive. */
        }
      }

      const checkRootBusy = () => threadId ? isDotRootThreadBusy(accountId, threadId, signal) : Promise.resolve(null)
      const pollOnce = async () => {
        if (!ownsTurn()) return
        void triggerRoomLivePush(accountId, roomId)
        try {
          const listed = await fetchRoomHistory(accountId, target, { after: sentId, limit: 16, signal })
          if (!ownsTurn()) return
          for (const msg of listed.messages) recordReply(msg)
          const replies = [...repliesById.values()]
          const latest = replies.at(-1)
          if (latest && (!lastBusy || Date.now() - lastReplyAt > 2500)) {
            const transplant = latest.turnTrigger === 'aeon_transplant'
            if (transplant && target.dotId) {
              const profile = await getDot(accountId, target.dotId, signal)
              if (!ownsTurn()) return
              if (profile.messagingRoomId !== roomId) {
                finish()
                return
              }
              threadId = profile.activeRootThreadId
            }
            const rootBusy = await checkRootBusy()
            if (!ownsTurn()) return
            if (rootBusy || (isDotAckMessage(latest) && Date.now() - lastReplyAt < 8000)) {
              lastBusy = true
              opts.onActivity?.('thinking', 'Dot 正在后台处理并生成后续回复/文件…', true)
            } else if (!recoverySent && rootBusy === false && replies.every((m) => m.turnTrigger === 'aeon_transplant')) {
              await recover(true)
            } else {
              finish()
            }
          } else if (!latest && Date.now() - startedAt > 6000) {
            const rootBusy = await checkRootBusy()
            if (!ownsTurn()) return
            const quietFor = Date.now() - startedAt
            if (rootBusy === null) {
              if (quietFor > 60_000) idleEmptyChecks++
            } else if (!rootBusy && (!lastBusy || quietFor > 15_000)) {
              idleEmptyChecks++
            } else {
              idleEmptyChecks = 0
            }
            if (idleEmptyChecks >= 2) {
              if (!recoverySent && rootBusy === false) await recover(false)
              else if (idleEmptyChecks >= 4 || rootBusy === null) finish()
            }
          }
        } catch {
          /* Retry transient poll errors while the same turn is active. */
        }
        if (ownsTurn()) pollTimer = setTimeout(() => void pollOnce(), 1800)
      }

      const unsub = onDotRealtimeEvent((event) => {
        if (!ownsTurn() || event.accountId !== accountId || event.turnId !== turn.id) return
        if (event.type === 'activity') {
          lastBusy = event.busy
          opts.onActivity?.(event.code, event.text, event.busy)
        } else {
          recordReply(event.message)
        }
      })
      const deadline = setTimeout(finish, opts.timeoutMs ?? 300_000)
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
      else pollTimer = setTimeout(() => void pollOnce(), 1400)
    })
  } finally {
    if (activeDotTurns.get(accountId) === turn) activeDotTurns.delete(accountId)
  }
}

// ============================================================================
// Codex Cloud App-Server WebSocket (`wss://codex-cloud-backend.chatgpt.com/`)
// ============================================================================

async function withAppServerWs<T>(
  accountId: string,
  fn: (helpers: {
    call: (method: string, params?: unknown) => Promise<unknown>
    ws: WebSocket
    account: DotStoredAccount
    signal: AbortSignal
  }) => Promise<T>,
  timeoutMs = 35_000,
  turnSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController()
  const signal = turnSignal ? AbortSignal.any([turnSignal, controller.signal]) : controller.signal
  const close = (error: Error) => controller.abort(error)
  const connections = nativeConnections.get(accountId) ?? new Set()
  connections.add(close)
  nativeConnections.set(accountId, connections)
  const timeout = setTimeout(() => close(new DotApiError(504, 'Dot App-Server WebSocket timed out')), timeoutMs)
  const revision = getDotCredentialRevision(accountId)
  try {
    const account = await ensureValidDotAccount(accountId, signal)
    const effectiveProxy = await waitForDotRequest(resolveDotProxyUrl(accountId), signal)
    signal.throwIfAborted()
    requireCredentialRevision(accountId, revision)
    return await new Promise<T>((resolve, reject) => {
      const ws = new WebSocket(
        DOT_APP_SERVER_WS_URL,
        ['codex-app-server', 'codex-client.browser', `openai-bearer.${account.accessToken}`],
        {
          agent: proxyWsAgent(effectiveProxy),
          headers: { Origin: DOT_ORIGIN, 'User-Agent': CHROME_UA }
        }
      )

      let nextId = 1
      let settled = false
      const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
      const cleanup = (error: unknown) => {
        settled = true
        signal.removeEventListener('abort', onAbort)
        ws.off('message', onResponse)
        ws.off('open', onOpen)
        ws.off('close', onClose)
        for (const request of pending.values()) request.reject(error)
        pending.clear()
        controller.abort(error)
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate()
        else ws.close()
      }
      const fail = (error: unknown) => {
        if (settled) return
        cleanup(error)
        reject(error)
      }
      const onAbort = () => fail(signal.reason)
      const onClose = () => fail(new DotApiError(502, 'App-Server WebSocket closed unexpectedly'))

      const call = (method: string, params: unknown = {}): Promise<unknown> =>
        new Promise((resolveCall, rejectCall) => {
          signal.throwIfAborted()
          const id = nextId++
          pending.set(id, { resolve: resolveCall, reject: rejectCall })
          try {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (error) => {
              if (error) fail(error)
            })
          } catch (error) {
            fail(error)
          }
        })

      const onResponse = (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            id?: number
            result?: unknown
            error?: { message?: string }
          }
          if (typeof msg.id !== 'number') return
          const request = pending.get(msg.id)
          if (!request) return
          pending.delete(msg.id)
          if (msg.error) request.reject(new DotApiError(400, msg.error.message || 'JSON-RPC error', msg.error))
          else request.resolve(msg.result)
        } catch {
          /* Ignore malformed frames. */
        }
      }
      const onOpen = async () => {
        try {
          await call('initialize', {
            clientInfo: { name: 'chatgpt-web', title: 'ChatGPT Dot', version: '1.0.0' },
            capabilities: { experimentalApi: true }
          })
          signal.throwIfAborted()
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }))
          const out = await fn({ call, ws, account, signal })
          if (settled) return
          cleanup(new DotApiError(499, 'Dot App-Server request ended'))
          resolve(out)
        } catch (error) {
          fail(error)
        }
      }

      ws.on('error', fail)
      ws.once('close', () => ws.off('error', fail))
      ws.once('close', onClose)
      ws.on('message', onResponse)
      ws.once('open', onOpen)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  } finally {
    clearTimeout(timeout)
    connections.delete(close)
    if (connections.size === 0) nativeConnections.delete(accountId)
  }
}

export async function getDotRateLimits(accountId: string): Promise<unknown> {
  return withAppServerWs(accountId, ({ call }) => call('account/rateLimits/read', {}))
}

export async function listDotModels(accountId: string): Promise<unknown> {
  return withAppServerWs(accountId, ({ call }) =>
    call('model/list', { includeHidden: true, cursor: null, limit: 100 })
  )
}

export async function getDotThreadGoal(accountId: string, threadId?: string): Promise<unknown> {
  const acc = getStoredDotAccount(accountId)
  const tid = threadId || acc?.threadId
  if (!tid) return { goal: null }
  return withAppServerWs(accountId, ({ call }) =>
    call('thread/goal/get', { threadId: tid })
  ).catch(() => ({ goal: null }))
}

export async function setDotThreadGoal(
  accountId: string,
  goal: string,
  threadId?: string
): Promise<unknown> {
  const acc = getStoredDotAccount(accountId)
  const tid = threadId || acc?.threadId
  if (!tid) throw new DotApiError(400, 'threadId required')
  return withAppServerWs(accountId, ({ call }) =>
    call('thread/goal/set', { threadId: tid, goal })
  )
}

export async function clearDotThreadGoal(accountId: string, threadId?: string): Promise<unknown> {
  const acc = getStoredDotAccount(accountId)
  const tid = threadId || acc?.threadId
  if (!tid) throw new DotApiError(400, 'threadId required')
  return withAppServerWs(accountId, ({ call }) =>
    call('thread/goal/clear', { threadId: tid })
  )
}

/**
 * Stream a native turn directly on `wss://codex-cloud-backend.chatgpt.com/` using `gpt-6-astra`
 * (or any Sol/Luna/Terra model), emitting token-by-token deltas (`item/agentMessage/delta`) and
 * tool call status (`item/started` / `item/completed`).
 */
export async function streamDotNativeTurn(
  accountId: string,
  opts: {
    text: string
    turnId?: string
    threadId?: string
    signal?: AbortSignal
    model?: string
    effort?: string
    onSent?: () => void
    onDelta?: (args: {
      messageId: string
      text: string
      done: boolean
      tools?: MuseToolCallView[]
      richWidgets?: MuseRichWidgetView[]
    }) => void
    onActivity?: (code: string, text: string | undefined, busy: boolean) => void
  }
): Promise<{ messageId: string; text: string; threadId: string; tools: MuseToolCallView[] }> {
  requireStableDotProfile(accountId)
  opts.signal?.throwIfAborted()
  const turn = beginDotTurn(accountId, opts.turnId)
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, turn.controller.signal])
    : turn.controller.signal

  try {
    return await withAppServerWs(accountId, async ({ call, ws, account, signal }) => {
      const model = opts.model || account.model || 'gpt-6-astra'
      const effort = opts.effort || account.effort || 'medium'
      opts.onActivity?.('thinking', `Running ${model}…`, true)

      let threadId = ''
      const requestedThreadId = opts.threadId?.trim()
      if (requestedThreadId) {
        try {
          const resumed = (await call('thread/resume', {
            threadId: requestedThreadId,
            model,
            serviceTier: 'fast',
            approvalPolicy: 'never'
          })) as { thread?: { id?: string } } | undefined
          threadId = resumed?.thread?.id || requestedThreadId
        } catch {
          try {
            const readRes = (await call('thread/read', { threadId: requestedThreadId })) as
              | { thread?: { id?: string } }
              | undefined
            if (readRes?.thread?.id) {
              threadId = readRes.thread.id
            } else if (readRes) {
              threadId = requestedThreadId
            }
          } catch {
            /* fall back to thread/start */
          }
        }
      }
      if (!threadId) {
        const started = (await call('thread/start', {
          model,
          serviceTier: 'fast',
          approvalPolicy: 'never'
        })) as { thread?: { id?: string } }
        threadId = started?.thread?.id || randomUUID()
      }

      signal.throwIfAborted()
      let remoteTurnId: string | undefined
      const interrupt = () => {
        if (!remoteTurnId || ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 999,
          method: 'turn/interrupt',
          params: { threadId, turnId: remoteTurnId }
        }))
      }
      turn.interruptNative = interrupt
      let messageId = `dot_native_${randomUUID()}`
      let fullText = ''
      const toolsMap = new Map<string, MuseToolCallView>()
      let sentNotified = false
      const notifySent = () => {
        if (sentNotified) return
        sentNotified = true
        opts.onSent?.()
      }

      return new Promise<{
        messageId: string
        text: string
        threadId: string
        tools: MuseToolCallView[]
      }>((resolve, reject) => {
        let settled = false
        const cleanupSession = () => {
          ws.off('message', onMsg)
          signal.removeEventListener('abort', abortTurn)
          turn.interruptNative = undefined
        }
        const fail = (error: unknown) => {
          if (settled) return
          settled = true
          cleanupSession()
          reject(error)
        }
        const abortTurn = () => fail(signal.reason)

        const onMsg = (data: WebSocket.RawData) => {
          if (settled || signal.aborted || activeDotTurns.get(accountId) !== turn) return
          try {
            const frame = JSON.parse(data.toString()) as {
              method?: string
              params?: Record<string, unknown>
            }
            if (!frame.method) return
            const p = frame.params ?? {}
            const eventThreadId = p['threadId']
            const eventTurnId = p['turnId'] ?? (p['turn'] as { id?: unknown } | undefined)?.id
            if (typeof eventThreadId === 'string' && eventThreadId !== threadId) return
            if (remoteTurnId && typeof eventTurnId === 'string' && eventTurnId !== remoteTurnId) return

            if (frame.method === 'turn/started') {
              notifySent()
              const turn = p['turn'] as { id?: string } | undefined
              if (turn?.id) remoteTurnId = turn.id
            } else if (frame.method === 'item/started') {
              const item = p['item'] as Record<string, unknown> | undefined
              if (!item) return
              const itemType = String(item['type'] ?? '')
              const itemId = String(item['id'] ?? randomUUID())
              if (itemType === 'agentMessage') {
                messageId = `dot_${itemId}`
              } else if (itemType !== 'userMessage' && itemType !== 'reasoning') {
                toolsMap.set(itemId, {
                  id: itemId,
                  name: String(item['tool'] ?? item['command'] ?? itemType),
                  status: 'running',
                  summary: typeof item['command'] === 'string' ? item['command'] : undefined
                })
                opts.onActivity?.('tool', `Running ${itemType}…`, true)
                opts.onDelta?.({
                  messageId,
                  text: fullText,
                  done: false,
                  tools: [...toolsMap.values()]
                })
              }
            } else if (frame.method === 'item/agentMessage/delta') {
              const delta = typeof p['delta'] === 'string' ? p['delta'] : ''
              if (delta) {
                fullText += delta
                opts.onDelta?.({
                  messageId,
                  text: fullText,
                  done: false,
                  ...(toolsMap.size > 0 ? { tools: [...toolsMap.values()] } : {})
                })
              }
            } else if (frame.method === 'item/completed') {
              const item = p['item'] as Record<string, unknown> | undefined
              if (!item) return
              const itemType = String(item['type'] ?? '')
              const itemId = String(item['id'] ?? '')
              if (itemType === 'agentMessage') {
                const finalItemText = typeof item['text'] === 'string' ? item['text'] : ''
                if (finalItemText && finalItemText.length >= fullText.length) {
                  fullText = finalItemText
                }
              } else if (toolsMap.has(itemId)) {
                const prev = toolsMap.get(itemId)!
                toolsMap.set(itemId, { ...prev, status: 'completed' })
              }
            } else if (frame.method === 'turn/completed') {
              if (settled) return
              settled = true
              cleanupSession()
              opts.onActivity?.('idle', undefined, false)
              opts.onDelta?.({
                messageId,
                text: fullText,
                done: true,
                ...(toolsMap.size > 0 ? { tools: [...toolsMap.values()] } : {})
              })
              resolve({
                messageId,
                text: fullText,
                threadId,
                tools: [...toolsMap.values()]
              })
            }
          } catch {
            /* ignore */
          }
        }

        ws.on('message', onMsg)
        signal.addEventListener('abort', abortTurn, { once: true })
        if (signal.aborted) {
          abortTurn()
          return
        }

        call('turn/start', {
          threadId,
          input: [{ type: 'text', text: opts.text }],
          model,
          effort,
          serviceTier: 'fast'
        })
          .then((response) => {
            if (settled || signal.aborted) return
            const result = response as { turn?: { id?: string } } | undefined
            remoteTurnId ??= result?.turn?.id
            notifySent()
          }, fail)
      })
    }, 120_000, signal)
  } finally {
    if (activeDotTurns.get(accountId) === turn) activeDotTurns.delete(accountId)
  }
}

// ============================================================================
// Library & Dynamic Pages (`/backend-api/files/library/nodes` & `/backend-api/pages`)
// ============================================================================

export async function listDotLibraryNodes(accountId: string, limit = 25): Promise<unknown> {
  return callDotApi(accountId, {
    method: 'GET',
    path: '/files/library/nodes',
    query: {
      limit: String(limit),
      include_pages: 'true'
    }
  })
}

export async function createDotPage(
  accountId: string,
  title: string,
  layout: 'document' | 'spatial' = 'document'
): Promise<unknown> {
  return callDotApi(accountId, {
    method: 'POST',
    path: '/pages',
    body: {
      title: title.trim() || 'Untitled Page',
      layout
    }
  })
}

export async function deleteDotPage(accountId: string, pageId: string): Promise<unknown> {
  return callDotApi(accountId, {
    method: 'DELETE',
    path: `/pages/${encodeURIComponent(pageId)}`
  })
}

// ============================================================================
// Dot Root Thread Status & Cross-Account Memory Export / Migration
// ============================================================================

/**
 * Whether Dot's root thread is still working. `null` means unknown (no
 * thread id, or the read failed); callers must not treat that as idle,
 * because idle triggers an automatic follow-up message.
 */
export async function isDotRootThreadBusy(accountId: string, threadId?: string, signal?: AbortSignal): Promise<boolean | null> {
  const acc = getStoredDotAccount(accountId)
  const tid = threadId || acc?.threadId
  if (!tid) return null
  try {
    const res = (await withAppServerWs(
      accountId,
      ({ call }) => call('thread/read', { threadId: tid }),
      6_000,
      signal
    )) as { thread?: { status?: { type?: string } } }
    const statusType = res?.thread?.status?.type?.toLowerCase()
    if (!statusType) return null
    return statusType !== 'idle' && statusType !== 'ready' && statusType !== 'completed'
  } catch {
    return null
  }
}

export interface DotMemorySnapshotResult {
  markdown: string
  goal?: string
  globalMemoriesCount: number
  roomMessagesCount: number
  sourceHandle?: string
  sourceDotId?: string
  exportedAt: string
}

/**
 * Export a portable Markdown memory snapshot for a Dot account:
 * - `mode === 'deep'`: asks Dot (`aeon`) in its Calpico Room to compile a structured `# Dot 记忆快照`
 *   distinguishing user-stated facts from account history, then merges global `/backend-api/memories` & `thread/goal`.
 * - `mode === 'fast'` (default): immediately extracts any existing `# Dot 记忆快照` from the room,
 *   global `/backend-api/memories`, `thread/goal/get`, and recent room context without waiting 35s.
 */
export async function exportDotMemorySnapshot(
  accountId: string,
  opts?: {
    mode?: 'fast' | 'deep'
    dotId?: string
    roomId?: string
    onActivity?: (code: string, text: string | undefined, busy: boolean) => void
  }
): Promise<DotMemorySnapshotResult> {
  const acc = await ensureValidDotAccount(accountId)
  const mode = opts?.mode ?? 'fast'

  if (mode === 'deep') {
    opts?.onActivity?.('thinking', '正在请求 Dot (aeon) 整理完整记忆快照…', true)
    await sendAndWatchDotRoomReply(accountId, {
      dotId: opts?.dotId ?? acc.activeDotId,
      roomId: opts?.roomId ?? acc.roomId,
      timeoutMs: 75_000,
      text: '请把你目前记得的所有关于我的信息整理成一份结构化的 Markdown 记忆快照（以 `# Dot 记忆快照` 开头，包含：1. 身份 2. 项目与技术栈 3. 语言与回复偏好 4. 待办与目标 5. 历史重要上下文），并区分我明确告诉你的信息与账号历史背景，方便我备份或跨账号迁移。',
      onActivity: opts?.onActivity
    }).catch(() => undefined)
  }

  const [memRes, goalRes, roomRes] = await Promise.all([
    callDotApi<{
      memories?: Array<{ id?: string; content?: string; updated_at?: string }>
    }>(accountId, { method: 'GET', path: '/memories' }).catch(() => null),
    getDotThreadGoal(accountId, acc.threadId).catch(() => null),
    listRoomMessages(accountId, {
      roomId: opts?.roomId ?? acc.roomId,
      dotId: opts?.dotId ?? acc.activeDotId,
      limit: 40
    }).catch(() => ({ roomId: acc.roomId || '', messages: [] as DotRoomMessage[] }))
  ])

  const globalMemories = Array.isArray(memRes?.memories)
    ? memRes.memories.filter((m) => typeof m?.content === 'string' && m.content.trim())
    : []

  const goalObj =
    goalRes && typeof goalRes === 'object' ? (goalRes as Record<string, unknown>) : null
  const goalStr = typeof goalObj?.['goal'] === 'string' ? goalObj['goal'].trim() : ''

  // Find the latest `# Dot 记忆快照` compiled by Dot in the room (messages are newest-first or chronological; sort by createdAtMs)
  const sortedMsgs = [...roomRes.messages].sort((a, b) => a.createdAtMs - b.createdAtMs)
  const snapshotMsgs = sortedMsgs.filter(
    (m) =>
      m.role === 'bot' &&
      (m.text.includes('# Dot 记忆快照') ||
        (m.text.includes('## 1. 身份') && m.text.includes('## 2. 项目')))
  )
  const latestDotSnapshot =
    snapshotMsgs.length > 0 ? snapshotMsgs[snapshotMsgs.length - 1]!.text.trim() : ''

  const exportedAt = new Date().toISOString()
  const lines: string[] = []

  if (latestDotSnapshot) {
    lines.push(latestDotSnapshot)
    lines.push('')
    lines.push('---')
    lines.push(
      `> 元信息：导出自账号 \`${acc.email || acc.displayName || accountId}\` (${acc.planType || 'dot'}) · Dot \`${acc.activeDotId || 'default'}\` · ${exportedAt}`
    )
  } else {
    lines.push('# Dot 记忆快照')
    lines.push(
      `> 导出自账号 \`${acc.email || acc.displayName || accountId}\` (${acc.planType || 'dot'}) · Dot \`${acc.activeDotId || 'default'}\` · ${exportedAt}`
    )
  }

  if (goalStr) {
    lines.push('')
    lines.push('## 长期目标 (Thread Goal)')
    lines.push(`- ${goalStr}`)
  }

  if (globalMemories.length > 0) {
    lines.push('')
    lines.push('## ChatGPT 全局记忆库 (/backend-api/memories)')
    for (const m of globalMemories) {
      lines.push(`- ${m.content!.trim()}`)
    }
  }

  if (!latestDotSnapshot && sortedMsgs.length > 0) {
    lines.push('')
    lines.push('## 近期关键对话记录 (Calpico Room)')
    const recent = sortedMsgs.slice(-14)
    for (const m of recent) {
      const speaker = m.role === 'user' ? '用户' : 'Dot'
      const clean = m.text.replace(/\n{3,}/g, '\n\n').trim()
      lines.push(`- **${speaker}**：${clean}`)
    }
  }

  return {
    markdown: lines.join('\n').trim(),
    goal: goalStr || undefined,
    globalMemoriesCount: globalMemories.length,
    roomMessagesCount: sortedMsgs.length,
    sourceHandle: acc.email || acc.displayName,
    sourceDotId: acc.activeDotId,
    exportedAt
  }
}

/**
 * Import / migrate a `# Dot 记忆快照` Markdown document into the target Dot account:
 * 1. Restores `thread/goal/set` if a goal is present.
 * 2. Sends a structured memory-injection turn to the target Dot's Calpico Room so Dot (`aeon`)
 *    persists the user's identity, projects, preferences, and context in its long-term memory.
 */
export async function importDotMemorySnapshot(
  accountId: string,
  opts: {
    markdown: string
    goal?: string
    botId?: string
    dotId?: string
    roomId?: string
    onActivity?: (code: string, text: string | undefined, busy: boolean) => void
    onMessage?: (msg: DotRoomMessage, done: boolean, stillBusy?: boolean, target?: DotTarget) => void
  }
): Promise<{
  roomId: string
  sentMessage: DotRoomMessage
  replies: DotRoomMessage[]
  goalRestored?: string
}> {
  const markdown = opts.markdown.trim()
  if (!markdown) {
    throw new DotApiError(400, '记忆快照内容不能为空')
  }

  // Extract goal from markdown if not explicitly passed
  let goalToRestore = opts.goal?.trim()
  if (!goalToRestore) {
    const goalMatch = markdown.match(/##\s*长期目标[^\n]*\n+-\s*([^\n]+)/)
    if (goalMatch?.[1]) {
      goalToRestore = goalMatch[1].trim()
    }
  }

  if (goalToRestore) {
    await setDotThreadGoal(accountId, goalToRestore).catch(() => undefined)
  }

  const injectionPrompt = [
    '【Dot 跨账号记忆迁移与上下文注入】',
    '以下是我从上一个 Dot 账号导出的 `# Dot 记忆快照`。请将其中关于我的身份、项目与技术栈、语言与回复偏好、待办与长期目标以及关键上下文完整记入你的长期记忆中，并在后续所有对话中直接沿用（请用简明中文回复确认你已记住的核心要点）：',
    '',
    markdown
  ].join('\n')

  const result = await sendAndWatchDotRoomReply(accountId, {
    botId: opts.botId,
    dotId: opts.dotId,
    roomId: opts.roomId,
    text: injectionPrompt,
    timeoutMs: 75_000,
    onActivity: opts.onActivity,
    onMessage: opts.onMessage
  })

  return {
    ...result,
    goalRestored: goalToRestore
  }
}

