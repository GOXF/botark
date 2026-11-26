import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DotAuthStatus } from '@shared/ipc'
import { asObj } from '@shared/parse'
import { readJsonFile } from '../jsonFile'
import { applyProxyToPartition, loadAccountProxyUrl, loadAccountTransportProxyUrl, ProxyConfigUnreadableError } from '../muse/accountProxy'
import { DIRECT_PROXY_URL, proxyFetch } from '../proxyTransport'
import { requireValidProxyUrl } from '../proxyUrl'

export const DOT_ORIGIN = 'https://chatgpt.com'
export const DOT_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const DOT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

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

interface DotAccountLifecycle {
  closeTransport(accountId: string): void
  targetChanged(accountId: string): void
}

let accountLifecycle: DotAccountLifecycle | undefined

/** The transport registers its cleanup so credential and target changes invalidate live work synchronously. */
export function setDotAccountLifecycle(lifecycle: DotAccountLifecycle): void {
  accountLifecycle = lifecycle
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

export async function resolveDotProxyUrl(accountId: string): Promise<string | undefined> {
  // GOXF fork (cbd4890): per-account network mode — 'direct' yields DIRECT_PROXY_URL so the stored
  // Dot proxy (if any) still wins; system/proxy modes resolve to the account's transport URL.
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

export function requireCredentialRevision(accountId: string, revision: number): void {
  if (getDotCredentialRevision(accountId) !== revision) {
    throw new DotApiError(409, 'Dot credentials changed during the request')
  }
}

export function getDotTargetGeneration(accountId: string): number {
  return targetGenerations.get(accountId) ?? 0
}

export function advanceDotTargetGeneration(accountId: string): number {
  const generation = getDotTargetGeneration(accountId) + 1
  targetGenerations.set(accountId, generation)
  return generation
}

export function requireTargetGeneration(accountId: string, generation: number): void {
  if (getDotTargetGeneration(accountId) !== generation) {
    throw new DotApiError(409, 'The active Dot profile changed during the request')
  }
}

function disconnectAccountTransport(accountId: string): void {
  if (accountLifecycle) accountLifecycle.closeTransport(accountId)
  else advanceDotTargetGeneration(accountId)
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
    advanceDotTargetGeneration(accountId)
    accountLifecycle?.targetChanged(accountId)
  }
  saveStore()
  return next
}

export function clearStoredDotAccount(accountId: string): void {
  ensureStoreLoaded()
  advanceCredentialRevision(accountId)
  signedOutAccounts.add(accountId)
  disconnectAccountTransport(accountId)
  accountStore.delete(accountId)
  unreadableEntries.delete(accountId)
  saveStore()
}

export function clearAllStoredDotAccounts(): void {
  ensureStoreLoaded()
  for (const id of new Set([...accountStore.keys(), ...unreadableEntries.keys(), ...credentialRevisions.keys()])) {
    advanceCredentialRevision(id)
    signedOutAccounts.add(id)
    disconnectAccountTransport(id)
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
    if (prev) disconnectAccountTransport(accountId)
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
    const obj = asObj(item)
    if (!obj) return null
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

export async function waitForDotRequest<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
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

export function dotClientHeaders(
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

export function dotSessionHeaders(cred: DotStoredAccount, accept?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${cred.accessToken}`,
    ...(cred.chatgptAccountId ? { 'chatgpt-account-id': cred.chatgptAccountId } : {}),
    ...(accept ? { Accept: accept } : {}),
    Origin: DOT_ORIGIN,
    Referer: `${DOT_ORIGIN}/dots`,
    'User-Agent': CHROME_UA
  }
}

export function dotFileHeaders(cred: DotStoredAccount, url: URL): Record<string, string> {
  return url.origin === DOT_ORIGIN ? dotSessionHeaders(cred) : { 'User-Agent': CHROME_UA }
}

export function dotSocketHeaders(): Record<string, string> {
  return { Origin: DOT_ORIGIN, 'User-Agent': CHROME_UA }
}

export function dotAppServerProtocols(cred: DotStoredAccount): string[] {
  return ['codex-app-server', 'codex-client.browser', `openai-bearer.${cred.accessToken}`]
}
