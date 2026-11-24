/**
 * Encrypted credential & endpoint store for Nous Research Hermes Agent accounts.
 *
 * Persists `hermes-accounts.json` in `userData` with `0600` atomic writes.
 * API keys (`API_SERVER_KEY`) are encrypted via Electron `safeStorage`
 * (fail-closed: refuses plaintext storage if keychain encryption is unavailable).
 * Raw API keys never cross IPC to the renderer process.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { createMutex } from '@shared/proxyPool'
import { readJsonFile, writeJsonAtomic } from '../jsonFile'

const STORE_FILE = 'hermes-accounts.json'
const withStoreLock = createMutex()
const accountRevisions = new Map<string, symbol>()
let defaultRevision = Symbol()

export interface StoredHermesAccountRecord {
  baseUrl: string
  displayName?: string
  model?: string
  /** Base64 safeStorage ciphertext for API_SERVER_KEY (omitted for unauthenticated local servers). */
  apiKeyEnc?: string
  updatedAtMs: number
}

type StoredHermesAccountMap = Record<string, StoredHermesAccountRecord>

export interface ResolvedHermesAccount {
  accountId: string
  baseUrl: string
  apiKey?: string
  hasApiKey: boolean
  displayName?: string
  model?: string
  updatedAtMs: number
}

export interface LocalHermesEnvInfo {
  baseUrl: string
  host: string
  port: number
  hasApiKey: boolean
  /** Kept strictly in main process; never returned to renderer. */
  apiKey?: string
}

/**
 * Normalize a user-supplied Hermes API server URL.
 * - Accepts `http://` and `https://` only (defaults bare `host:port` to `http://`).
 * - Strips trailing slashes and an accidental `/v1` or `/v1/chat/completions` suffix
 *   (common when users paste an Open WebUI base URL), while preserving `/p/<profile>`.
 */
export function normalizeHermesBaseUrl(raw: string): string {
  let trimmed = (raw ?? '').trim()
  if (!trimmed) {
    throw new Error('请输入 Hermes API Server 地址（例如 http://127.0.0.1:8642）')
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    trimmed = `http://${trimmed}`
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Hermes 地址格式无效：${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`仅支持 http:// 或 https:// 协议（当前为 ${parsed.protocol}）`)
  }
  if (!parsed.hostname) {
    throw new Error('Hermes 地址缺少主机名')
  }
  let pathname = parsed.pathname.replace(/\/+$/, '')
  pathname = pathname.replace(/\/v1\/chat\/completions$/i, '')
  pathname = pathname.replace(/\/v1$/i, '')
  pathname = pathname.replace(/\/+$/, '')
  return `${parsed.origin}${pathname}`
}

export function hermesHandleFromUrl(baseUrl: string, model?: string): string {
  try {
    const u = new URL(baseUrl)
    const hostPort = u.host + (u.pathname && u.pathname !== '/' ? u.pathname : '')
    return model && model !== 'hermes-agent' ? `${model} @ ${hostPort}` : hostPort
  } catch {
    return baseUrl
  }
}

function storePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

function readRawStore(): StoredHermesAccountMap {
  return readJsonFile<StoredHermesAccountMap>(
    storePath(),
    {},
    (raw) => Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
  )
}

function writeRawStore(data: StoredHermesAccountMap): void {
  writeJsonAtomic(storePath(), data, 0o600)
}

function isEncryptionAvailable(): boolean {
  try {
    return typeof safeStorage?.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encryptApiKey(secret: string): string {
  if (!isEncryptionAvailable()) {
    throw new Error('系统钥匙串加密（safeStorage）当前不可用，已拒绝明文保存 Hermes API Key')
  }
  return safeStorage.encryptString(secret).toString('base64')
}

function decryptApiKey(encBase64: string): string | undefined {
  if (!encBase64) return undefined
  if (!isEncryptionAvailable()) {
    throw new Error('系统钥匙串加密（safeStorage）不可用，无法解密 Hermes API Key')
  }
  return safeStorage.decryptString(Buffer.from(encBase64, 'base64'))
}

type HermesAccountMetadata = Omit<ResolvedHermesAccount, 'apiKey'>

function accountMetadata(accountId: string, rec: StoredHermesAccountRecord): HermesAccountMetadata {
  return {
    accountId,
    baseUrl: rec.baseUrl,
    hasApiKey: Boolean(rec.apiKeyEnc),
    displayName: rec.displayName,
    model: rec.model,
    updatedAtMs: rec.updatedAtMs
  }
}

export function getHermesAccount(accountId: string): ResolvedHermesAccount | null {
  const id = (accountId ?? '').trim()
  if (!id) return null
  const rec = readRawStore()[id]
  if (!rec?.baseUrl) return null
  return { ...accountMetadata(id, rec), apiKey: rec.apiKeyEnc ? decryptApiKey(rec.apiKeyEnc) : undefined }
}

export function getHermesAccountMetadata(accountId: string): HermesAccountMetadata | null {
  const rec = readRawStore()[accountId]
  return rec?.baseUrl ? accountMetadata(accountId, rec) : null
}

export function listHermesAccountRecords(): HermesAccountMetadata[] {
  return Object.entries(readRawStore())
    .filter(([, rec]) => rec?.baseUrl)
    .map(([accountId, rec]) => accountMetadata(accountId, rec))
}

export function getHermesAccountRevision(accountId: string): symbol {
  return accountRevisions.get(accountId) ?? defaultRevision
}

export function sameHermesOrigin(first: string, second: string): boolean {
  return new URL(first).origin === new URL(second).origin
}

export async function saveHermesAccount(args: {
  accountId: string
  baseUrl: string
  apiKey?: string
  keepExistingKey?: boolean
  expectedRevision: symbol
  displayName?: string
  model?: string
}): Promise<HermesAccountMetadata> {
  const id = (args.accountId ?? '').trim()
  if (!id) throw new Error('accountId required')
  const normalizedUrl = normalizeHermesBaseUrl(args.baseUrl)
  return withStoreLock(async () => {
    if (args.expectedRevision !== getHermesAccountRevision(id)) {
      throw new Error('验证期间 Hermes 账号配置已更改，请重试')
    }
    const store = readRawStore()
    const prev = store[id]
    let apiKeyEnc: string | undefined
    const trimmedKey = typeof args.apiKey === 'string' ? args.apiKey.trim() : ''
    if (trimmedKey) {
      apiKeyEnc = encryptApiKey(trimmedKey)
    } else if (args.keepExistingKey && prev?.apiKeyEnc && sameHermesOrigin(normalizedUrl, prev.baseUrl)) {
      apiKeyEnc = prev.apiKeyEnc
    }
    const next: StoredHermesAccountRecord = {
      baseUrl: normalizedUrl,
      displayName: args.displayName?.trim() || prev?.displayName || undefined,
      model: args.model !== undefined ? args.model.trim() || undefined : prev?.model,
      ...(apiKeyEnc ? { apiKeyEnc } : {}),
      updatedAtMs: Date.now()
    }
    store[id] = next
    writeRawStore(store)
    accountRevisions.set(id, Symbol())
    return accountMetadata(id, next)
  })
}

export async function updateHermesAccountModel(accountId: string, model: string): Promise<HermesAccountMetadata> {
  const id = (accountId ?? '').trim()
  if (!id) throw new Error('accountId required')
  return withStoreLock(async () => {
    const store = readRawStore()
    const prev = store[id]
    if (!prev) throw new Error('Hermes 账号尚未配置')
    const next: StoredHermesAccountRecord = {
      ...prev,
      model: model.trim() || undefined,
      updatedAtMs: Date.now()
    }
    store[id] = next
    writeRawStore(store)
    accountRevisions.set(id, Symbol())
    return accountMetadata(id, next)
  })
}

export async function clearHermesAccount(accountId: string): Promise<void> {
  const id = (accountId ?? '').trim()
  if (!id) return
  await withStoreLock(async () => {
    if (id === '*') {
      writeRawStore({})
      accountRevisions.clear()
      defaultRevision = Symbol()
      return
    }
    const store = readRawStore()
    if (id in store) {
      delete store[id]
      writeRawStore(store)
    }
    accountRevisions.set(id, Symbol())
  })
}

/**
 * Parse a dotenv-style file (`KEY=VALUE`) without executing shell code.
 */
export function parseDotEnvText(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    let key = line.slice(0, eq).trim()
    if (key.startsWith('export ')) key = key.slice(7).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let val = line.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1)
    } else {
      const hash = val.indexOf(' #')
      if (hash >= 0) val = val.slice(0, hash).trim()
    }
    out[key] = val
  }
  return out
}

/**
 * Inspect local `~/.hermes/.env` (or `$HERMES_HOME/.env`) for API_SERVER_HOST /
 * API_SERVER_PORT / API_SERVER_KEY. Purely local read inside main process;
 * the API key is never returned across IPC.
 */
export function readLocalHermesEnv(): LocalHermesEnvInfo {
  const hermesHome = process.env['HERMES_HOME']?.trim() || join(homedir(), '.hermes')
  const envFile = join(hermesHome, '.env')
  let parsed: Record<string, string> = {}
  try {
    if (existsSync(envFile)) {
      parsed = parseDotEnvText(readFileSync(envFile, 'utf8'))
    }
  } catch {
    /* ignore unreadable ~/.hermes/.env */
  }
  const rawHost = (parsed['API_SERVER_HOST'] || process.env['API_SERVER_HOST'] || '127.0.0.1').trim()
  const connectHost = rawHost === '0.0.0.0' || rawHost === '::' || !rawHost ? '127.0.0.1' : rawHost
  const rawPort = Number.parseInt(parsed['API_SERVER_PORT'] || process.env['API_SERVER_PORT'] || '8642', 10)
  const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 8642
  const apiKey = (parsed['API_SERVER_KEY'] || process.env['API_SERVER_KEY'] || '').trim() || undefined
  const hostForUrl = connectHost.includes(':') && !connectHost.startsWith('[') ? `[${connectHost}]` : connectHost
  return {
    baseUrl: `http://${hostForUrl}:${port}`,
    host: connectHost,
    port,
    hasApiKey: Boolean(apiKey),
    apiKey
  }
}
