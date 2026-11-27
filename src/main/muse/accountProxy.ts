/**
 * Per-account BotHub client egress proxy (not a Muse RPC).
 * Persist via Electron safeStorage; apply to session partition + Noise WSS agent.
 */
import { isIP } from 'node:net'
import { join } from "node:path"
import { domainToASCII } from 'node:url'
import { app, safeStorage, session as electronSession, type Session } from "electron"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import type { Agent } from "node:https"
import { partitionForAccount } from "../webContentsViewManager"
import { readJsonFile, writeJsonAtomic } from "../jsonFile"
import { ensureLocalProxyBridge } from "../localProxyBridge"
import { remoteDnsProxyUrl } from "../proxyUrl"
import { DIRECT_PROXY_URL } from "../proxyTransport"
import { probeProxyUrl, runWithConcurrency, type ProxyProbeOptions } from "../proxyHealthCheck"
import type { MuseProxyTestResult } from "@shared/ipc"
import { bindPoolSlot, createMutex, migratePoolSlot, planPoolAssignment, releasePoolSlot } from "@shared/proxyPool"

/** One lock for both proxy files: every change is read-modify-write across awaits. */
const withProxyStoreLock = createMutex()

export type ProxyScheme = "http" | "https" | "socks5" | "socks5h"
/** `direct` = 真直连 (no proxy at all); `system` = 跟随系统 (default, what old "direct" did). */
export type MuseProxyMode = "direct" | "system" | ProxyScheme

const isProxyMode = (mode: MuseProxyMode): mode is ProxyScheme => mode !== "direct" && mode !== "system"

export interface MuseProxyConfig {
  mode: MuseProxyMode
  host?: string
  port?: number
  username?: string
  password?: string
}

/**
 * `mode: "direct"` marks 真直连 (nothing secret, so not encrypted); `enc` holds a proxy.
 * `poolId` says the proxy came from that pool entry, so removing it can revert the account.
 */
interface StoredEntry {
  enc?: string
  mode?: "direct"
  poolId?: string
}

type StoreFile = Record<string, StoredEntry>

function storePath(): string {
  return join(app.getPath("userData"), "muse-account-proxy.json")
}

function readStore(): StoreFile {
  return readJsonFile<StoreFile>(storePath(), {}, (raw) => Boolean(raw) && typeof raw === "object" && !Array.isArray(raw))
}

function writeStore(store: StoreFile): void {
  writeJsonAtomic(storePath(), store)
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function formatHostForUrl(host: string): string {
  const clean = host.trim()
  if (clean.includes(":") && !clean.startsWith("[")) return `[${clean}]`
  return clean
}

function splitHostAndPort(
  hostPort: string,
  fallbackPort?: number
): { host: string; port: number; extraParts?: string[] } | null {
  const raw = hostPort.trim()
  if (!raw) return null

  if (raw.startsWith("[")) {
    const closeIdx = raw.indexOf("]")
    if (closeIdx <= 1) return null
    const host = raw.slice(0, closeIdx + 1)
    const rest = raw.slice(closeIdx + 1)
    if (!rest) {
      if (!fallbackPort) return null
      return { host, port: fallbackPort }
    }
    if (!rest.startsWith(":")) return null
    const afterColon = rest.slice(1).split(":")
    const port = Number(afterColon[0])
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return {
      host,
      port,
      extraParts: afterColon.length > 1 ? afterColon.slice(1) : undefined
    }
  }

  const parts = raw.split(":")
  if (parts.length === 1) {
    if (!fallbackPort) return null
    const host = parts[0]!.trim()
    if (!host) return null
    return { host, port: fallbackPort }
  }

  // `host:port` or `host:port:username:password`
  const host = parts[0]!.trim()
  const port = Number(parts[1])
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return {
    host,
    port,
    extraParts: parts.length > 2 ? parts.slice(2) : undefined
  }
}

function normalize(cfg: MuseProxyConfig | null | undefined): MuseProxyConfig {
  if (!cfg || !isProxyMode(cfg.mode)) return { mode: cfg?.mode === "direct" ? "direct" : "system" }
  const rawHost = (cfg.host || "").trim()

  // If the user pasted a full URL (`https://user:pass@host:port`) or `host:port:user:pass`
  // into the single-account Host input, honor the scheme (`https` stays `https`) and credentials.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawHost) || (!cfg.port && rawHost.includes(":"))) {
    const parsed = parseProxyLine(rawHost, cfg.mode)
    if (parsed && isProxyMode(parsed.mode) && parsed.host && parsed.port) {
      const explicitPort = Number(cfg.port)
      const validExplicitPort = Number.isInteger(explicitPort) && explicitPort >= 1 && explicitPort <= 65535
      return {
        mode: /^[a-z][a-z0-9+.-]*:\/\//i.test(rawHost) ? parsed.mode : cfg.mode,
        host: parsed.host,
        port: /^[a-z][a-z0-9+.-]*:\/\//i.test(rawHost) ? parsed.port : validExplicitPort ? explicitPort : parsed.port,
        username: cfg.username?.trim() || parsed.username?.trim() || undefined,
        password: cfg.password || parsed.password || undefined
      }
    }
  }

  const host = rawHost
  // A bare host must not be able to introduce URL userinfo, a path, or another port.
  if ((host.includes(':') && isIP(host.replace(/^\[|\]$/g, '')) !== 6) || /[\s/@\\?#]/.test(host)) {
    throw new Error('Invalid proxy host')
  }
  const rawPort = cfg.port ?? (cfg.mode === 'https' ? 443 : cfg.mode === 'http' ? 80 : undefined)
  const port = Number(rawPort)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Proxy host and port (1–65535) are required")
  }
  return {
    mode: cfg.mode,
    host,
    port,
    username: cfg.username?.trim() || undefined,
    password: cfg.password || undefined
  }
}

function proxyIdentity(cfg: MuseProxyConfig): string {
  const rawHost = cfg.host?.trim().toLowerCase() ?? ''
  const address = rawHost.replace(/^\[|\]$/g, '')
  const host = isIP(address) === 6 && !address.includes('%')
    ? new URL(`http://[${address}]`).hostname
    : /^[\p{L}\p{N}\p{M}_.-]+$/u.test(rawHost)
      ? (domainToASCII(rawHost) || rawHost).replace(/\.$/, '')
      : rawHost
  return JSON.stringify([cfg.mode, host, cfg.port, cfg.username])
}

/** Public view never returns the password; only whether one is stored. */
export type MuseProxyView = {
  mode: MuseProxyMode
  host?: string
  port?: number
  username?: string
  hasPassword: boolean
}

/** A proxy is configured but cannot be read (keychain/safeStorage). Never go direct silently. */
export class ProxyConfigUnreadableError extends Error {
  constructor(detail?: string) {
    super(`代理配置无法读取（系统钥匙串/加密不可用${detail ? `：${detail}` : ""}），已阻止直连；请重新保存该账号的代理`)
    this.name = "ProxyConfigUnreadableError"
  }
}

/** Unreachable proxy used to block a partition whose real proxy cannot be read. */
const BLOCKING_PROXY_RULE = "http://127.0.0.1:9"

export async function loadProxyConfig(accountId: string): Promise<MuseProxyConfig> {
  const entry = readStore()[accountId]
  if (entry?.mode === "direct") return { mode: "direct" }
  if (!entry?.enc) return { mode: "system" }
  let available = false
  try {
    available = await safeStorage.isAsyncEncryptionAvailable()
  } catch {
    available = false
  }
  if (!available) throw new ProxyConfigUnreadableError()
  try {
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(entry.enc, "base64"))
    const cfg = normalize(JSON.parse(decrypted.result) as MuseProxyConfig)
    // Before 真直连 existed, a stored "direct" behaved as follow-system; keep that.
    return cfg.mode === "direct" ? { mode: "system" } : cfg
  } catch (err) {
    throw new ProxyConfigUnreadableError(err instanceof Error ? err.message : undefined)
  }
}

export async function getProxyView(accountId: string): Promise<MuseProxyView> {
  const cfg = await loadProxyConfig(accountId)
  if (!isProxyMode(cfg.mode)) return { mode: cfg.mode, hasPassword: false }
  return {
    mode: cfg.mode,
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    hasPassword: Boolean(cfg.password)
  }
}

export async function saveProxyConfig(accountId: string, input: MuseProxyConfig): Promise<MuseProxyView> {
  return withProxyStoreLock(() => saveProxyConfigUnlocked(accountId, input))
}

async function saveProxyConfigUnlocked(accountId: string, input: MuseProxyConfig, poolId?: string): Promise<MuseProxyView> {
  const next = normalize(input)
  const store = readStore()
  if (!isProxyMode(next.mode)) {
    if (next.mode === "direct") store[accountId] = { mode: "direct" }
    else delete store[accountId]
    writeStore(store)
    await applyProxyToPartition(accountId, next)
    return { mode: next.mode, hasPassword: false }
  }
  // A blank password in the editor can retain credentials for the same proxy identity.
  if (!next.password && !poolId) {
    const prev = await loadProxyConfig(accountId).catch(() => null)
    if (prev?.password && proxyIdentity(prev) === proxyIdentity(next)) next.password = prev.password
  }
  const available = await safeStorage.isAsyncEncryptionAvailable()
  if (!available) {
    throw new Error("safeStorage encryption unavailable; refusing to store proxy credentials in plaintext")
  }
  const enc = await safeStorage.encryptStringAsync(JSON.stringify(next))
  store[accountId] = poolId ? { enc: enc.toString("base64"), poolId } : { enc: enc.toString("base64") }
  writeStore(store)
  await applyProxyToPartition(accountId, next)
  return {
    mode: next.mode,
    host: next.host,
    port: next.port,
    username: next.username,
    hasPassword: Boolean(next.password)
  }
}

/**
 * The per-account 网络代理 save: `poolId` binds the account to that pool proxy
 * (manual, never limited); anything else (真直连 / 跟随系统 / 自定义) unbinds it from the pool.
 */
export async function setAccountProxy(
  accountId: string,
  input: MuseProxyConfig & { poolId?: string }
): Promise<MuseProxyView> {
  return withProxyStoreLock(async () => {
    const pool = readPoolStore()
    if (!input.poolId) {
      const view = await saveProxyConfigUnlocked(accountId, input)
      writePoolStore(releasePoolSlot(pool, accountId))
      return view
    }
    const slot = pool.find((p) => p.id === input.poolId)
    const cfg = slot && (await decryptPoolItem(slot))
    if (!cfg) throw new Error("代理池里找不到这个代理（可能已被移除或无法解密）")
    const view = await saveProxyConfigUnlocked(accountId, cfg, input.poolId)
    writePoolStore(bindPoolSlot(pool, accountId, input.poolId))
    return view
  })
}

export async function clearProxyConfig(accountId: string): Promise<void> {
  await withProxyStoreLock(() => {
    const store = readStore()
    delete store[accountId]
    writeStore(store)
  })
  await applyProxyToPartition(accountId, { mode: "system" })
}

export function buildAccountProxyUrl(cfg: MuseProxyConfig): string | null {
  if (!isProxyMode(cfg.mode) || !cfg.host || !cfg.port) return null
  const auth =
    cfg.username && cfg.password
      ? `${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@`
      : cfg.username
        ? `${encodeURIComponent(cfg.username)}@`
        : ""
  const host = formatHostForUrl(cfg.host)
  return `${cfg.mode}://${auth}${host}:${cfg.port}`
}

/**
 * Resolve the per-account proxy URL string (`http://...`, `https://...`, `socks5://...`, `socks5h://...`)
 * for Node-side `proxyFetch` / `proxyWsAgent` callers (Grok, Dot, Hermes, etc.).
 * Throws `ProxyConfigUnreadableError` if a proxy is configured on disk yet
 * `safeStorage` cannot decrypt it — never silently falls back to direct.
 */
export async function loadAccountProxyUrl(accountId: string): Promise<string | undefined> {
  const cfg = await loadProxyConfig(accountId)
  return buildAccountProxyUrl(cfg) ?? undefined
}

/** Like `loadAccountProxyUrl`, but 真直连 yields `DIRECT_PROXY_URL` so `proxyFetch` skips the OS proxy too. */
export async function loadAccountTransportProxyUrl(accountId: string): Promise<string | undefined> {
  const cfg = await loadProxyConfig(accountId)
  return buildAccountProxyUrl(cfg) ?? (cfg.mode === "direct" ? DIRECT_PROXY_URL : undefined)
}

/** Partition rules: `null` = follow system, `DIRECT_PROXY_URL` = no proxy, else Chromium proxy rules. */
async function resolvePartitionProxyRules(cfg: MuseProxyConfig): Promise<string | null> {
  if (cfg.mode === "direct") return DIRECT_PROXY_URL
  if (!isProxyMode(cfg.mode) || !cfg.host || !cfg.port) return null

  const hasAuth = Boolean(cfg.username || cfg.password)
  // Chromium's session.setProxy neither supports RFC 1929 SOCKS5 auth nor extracts
  // `user:pass@` from proxyRules, and HTTPS proxies need HTTP/1.1 ALPN CONNECT over TLS.
  // Route `https://` proxies and any authenticated proxy via a loopback-only local bridge.
  if (cfg.mode === "https" || hasAuth) {
    return ensureLocalProxyBridge({
      mode: cfg.mode,
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      password: cfg.password
    })
  }

  const host = formatHostForUrl(cfg.host)
  // Chromium's `socks5://` already performs remote DNS resolution on the SOCKS5 proxy,
  // whereas `socks5h://` is not a recognized scheme in Chromium's proxy string parser.
  const scheme = cfg.mode === "socks5h" ? "socks5" : cfg.mode
  return `${scheme}://${host}:${cfg.port}`
}

async function closePartitionConnections(ses: Electron.Session): Promise<void> {
  if (typeof ses.closeAllConnections === "function") {
    await ses.closeAllConnections().catch(() => undefined)
  }
}

function sessionProxyConfig(rules: string | null): Electron.ProxyConfig {
  if (rules === null) return { mode: "system" }
  if (rules === DIRECT_PROXY_URL) return { mode: "direct" }
  return { mode: "fixed_servers", proxyRules: rules, proxyBypassRules: rules === BLOCKING_PROXY_RULE ? "" : "<local>" }
}

const partitionProxies = new WeakMap<Session, {
  lock: ReturnType<typeof createMutex>
  applied?: string | null
}>()

export async function applyProxyToPartition(accountId: string, cfg?: MuseProxyConfig): Promise<void> {
  const ses = electronSession.fromPartition(partitionForAccount(accountId))
  let state = partitionProxies.get(ses)
  if (!state) {
    state = { lock: createMutex() }
    partitionProxies.set(ses, state)
  }
  const proxyState = state
  await proxyState.lock(async () => {
    const applyRules = async (rules: string | null): Promise<void> => {
      // Setting unchanged rules and closing the session would abort concurrent
      // requests and Hark's live response stream on this same partition.
      if (proxyState.applied === rules) return
      await ses.setProxy(sessionProxyConfig(rules))
      await closePartitionConnections(ses)
      proxyState.applied = rules
    }

    let rules: string | null
    try {
      rules = await resolvePartitionProxyRules(cfg ?? await loadProxyConfig(accountId))
    } catch (error) {
      // An unreadable or unusable configured proxy must not fall back to direct.
      await applyRules(BLOCKING_PROXY_RULE)
      throw error
    }
    await applyRules(rules)
  })
}

/** Node `ws` / HTTPS agent for Noise WSS (session.setProxy does not cover Node ws). */
export async function createProxyAgent(accountId: string): Promise<Agent | undefined> {
  const cfg = await loadProxyConfig(accountId)
  const url = buildAccountProxyUrl(cfg)
  if (!url) return undefined
  if (cfg.mode === "http" || cfg.mode === "https") return new HttpsProxyAgent(url) as unknown as Agent
  return new SocksProxyAgent(remoteDnsProxyUrl(url)) as unknown as Agent
}

export interface ProxyTestResult {
  ok: boolean
  ms?: number
  ip?: string
  error?: string
}

export interface MuseProxyPoolItemView {
  id: string
  mode: ProxyScheme
  host: string
  port: number
  username?: string
  hasPassword: boolean
  assignedAccountIds: string[]
  lastTest?: ProxyTestResult
}

interface StoredPoolItem {
  id: string
  enc: string
  assignedAccountIds: string[]
  lastTest?: ProxyTestResult
}

function poolStorePath(): string {
  return join(app.getPath("userData"), "muse-proxy-pool.json")
}

function readPoolStore(): StoredPoolItem[] {
  return readJsonFile<StoredPoolItem[]>(poolStorePath(), [], Array.isArray).map(migratePoolSlot<StoredPoolItem>)
}

function writePoolStore(list: StoredPoolItem[]): void {
  writeJsonAtomic(poolStorePath(), list)
}

/** Parse one proxy line (`https://u:p@h:p`, `socks5://u:p@h:p`, `http://h:p`, `h:p:u:p`, `h:p`). */
export function parseProxyLine(
  line: string,
  defaultMode: ProxyScheme = "socks5"
): MuseProxyConfig | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return null

  const schemeMatch = /^(https?|socks5h?|socks):\/\/(.+)$/i.exec(trimmed)
  if (schemeMatch) {
    const rawScheme = schemeMatch[1]!.toLowerCase()
    const mode: ProxyScheme =
      rawScheme === "https"
        ? "https"
        : rawScheme === "http"
          ? "http"
          : rawScheme === "socks5h"
            ? "socks5h"
            : "socks5"
    const rest = schemeMatch[2]!.replace(/[/?#].*$/, "")
    const atIdx = rest.lastIndexOf("@")
    const hostPortPart = atIdx >= 0 ? rest.slice(atIdx + 1) : rest
    const authPart = atIdx >= 0 ? rest.slice(0, atIdx) : ""
    const defaultPort = mode === "https" ? 443 : mode === "http" ? 80 : undefined
    const parsedHostPort = splitHostAndPort(hostPortPart, defaultPort)
    if (!parsedHostPort) return null

    let username: string | undefined
    let password: string | undefined
    if (authPart) {
      const cIdx = authPart.indexOf(":")
      if (cIdx >= 0) {
        username = safeDecodeURIComponent(authPart.slice(0, cIdx))
        password = safeDecodeURIComponent(authPart.slice(cIdx + 1))
      } else {
        username = safeDecodeURIComponent(authPart)
      }
    } else if (parsedHostPort.extraParts && parsedHostPort.extraParts.length > 0) {
      // Vendor format with scheme: `https://gate.provider.com:7000:user:pass`
      username = safeDecodeURIComponent(parsedHostPort.extraParts[0]?.trim() ?? "")
      password =
        parsedHostPort.extraParts.length > 1
          ? safeDecodeURIComponent(parsedHostPort.extraParts.slice(1).join(":"))
          : undefined
    }
    return {
      mode,
      host: parsedHostPort.host,
      port: parsedHostPort.port,
      username: username || undefined,
      password: password || undefined
    }
  }

  // `user:pass@host:port` without scheme
  if (trimmed.includes("@")) {
    const atIdx = trimmed.lastIndexOf("@")
    const authPart = trimmed.slice(0, atIdx)
    const hostPort = trimmed.slice(atIdx + 1)
    const parsedHostPort = splitHostAndPort(hostPort)
    if (!parsedHostPort) return null
    const cIdx = authPart.indexOf(":")
    const username = cIdx >= 0 ? safeDecodeURIComponent(authPart.slice(0, cIdx)).trim() : safeDecodeURIComponent(authPart).trim()
    const password = cIdx >= 0 ? safeDecodeURIComponent(authPart.slice(cIdx + 1)) : undefined
    return {
      mode: defaultMode,
      host: parsedHostPort.host,
      port: parsedHostPort.port,
      username: username || undefined,
      password: password || undefined
    }
  }

  // `host:port` or `host:port:user:pass` (including `[::1]:1080`)
  const parsedHostPort = splitHostAndPort(trimmed)
  if (parsedHostPort) {
    const username = parsedHostPort.extraParts?.[0]?.trim() || undefined
    const password =
      parsedHostPort.extraParts && parsedHostPort.extraParts.length > 1
        ? parsedHostPort.extraParts.slice(1).join(":")
        : undefined
    return {
      mode: defaultMode,
      host: parsedHostPort.host,
      port: parsedHostPort.port,
      username,
      password
    }
  }
  return null
}

async function decryptPoolItem(item: StoredPoolItem): Promise<MuseProxyConfig | null> {
  try {
    const available = await safeStorage.isAsyncEncryptionAvailable()
    if (!available) return null
    const dec = await safeStorage.decryptStringAsync(Buffer.from(item.enc, "base64"))
    return normalize(JSON.parse(dec.result) as MuseProxyConfig)
  } catch {
    return null
  }
}

/** Drop the account's config only if it came from `slot` (a 自定义 proxy is kept); it falls back to 跟随系统. */
async function clearPoolConfigUnlocked(accountId: string, slot: StoredPoolItem): Promise<void> {
  const entry = readStore()[accountId]
  if (!entry?.enc) return
  if (entry.poolId === undefined) {
    const config = await loadProxyConfig(accountId).catch(() => null)
    const poolConfig = await decryptPoolItem(slot)
    if (!config || !poolConfig || proxyIdentity(config) !== proxyIdentity(poolConfig) || config.password !== poolConfig.password) return
  } else if (entry.poolId !== slot.id) {
    return
  }
  await saveProxyConfigUnlocked(accountId, { mode: "system" })
}

export async function listProxyPool(): Promise<MuseProxyPoolItemView[]> {
  const list = readPoolStore()
  const out: MuseProxyPoolItemView[] = []
  for (const item of list) {
    const cfg = await decryptPoolItem(item)
    if (!cfg || !isProxyMode(cfg.mode) || !cfg.host || !cfg.port) continue
    out.push({
      id: item.id,
      mode: cfg.mode,
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      hasPassword: Boolean(cfg.password),
      assignedAccountIds: item.assignedAccountIds,
      lastTest: item.lastTest
    })
  }
  return out
}

export async function importProxyPool(
  rawText: string,
  defaultMode: ProxyScheme = "socks5"
): Promise<{ added: number; total: number; items: MuseProxyPoolItemView[] }> {
  const available = await safeStorage.isAsyncEncryptionAvailable()
  if (!available) {
    throw new Error("safeStorage encryption unavailable")
  }
  const added = await withProxyStoreLock(() => importIntoPoolUnlocked(rawText, defaultMode))
  const items = await listProxyPool()
  return { added, total: items.length, items }
}

async function importIntoPoolUnlocked(
  rawText: string,
  defaultMode: ProxyScheme
): Promise<number> {
  const existing = readPoolStore()
  const existingConfigs = await Promise.all(existing.map(decryptPoolItem))
  const seenKeys = new Set(
    existingConfigs
      .filter((c): c is MuseProxyConfig => Boolean(c && c.host && c.port))
      .map(proxyIdentity)
  )

  let added = 0
  for (const line of rawText.split(/\r?\n/)) {
    const parsed = parseProxyLine(line, defaultMode)
    if (!parsed || !isProxyMode(parsed.mode) || !parsed.host || !parsed.port) continue
    const key = proxyIdentity(normalize(parsed))
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const enc = await safeStorage.encryptStringAsync(JSON.stringify(parsed))
    existing.push({
      id: `px_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      enc: enc.toString("base64"),
      assignedAccountIds: []
    })
    added += 1
  }
  writePoolStore(existing)
  return added
}

/**
 * Revert every account whose proxy came from a pool entry that is gone to
 * 跟随系统 and re-apply its session now (a dead proxy otherwise keeps failing
 * with ERR_TUNNEL_CONNECTION_FAILED). Entries saved before `poolId` existed count
 * only when the removed entry listed them and the address matches; 自定义 proxies are kept.
 * With `adopt`, such legacy entries that match a live pool entry get its `poolId`.
 */
async function reconcilePoolBindingsUnlocked(
  pool: StoredPoolItem[],
  gone: StoredPoolItem[],
  adopt = false
): Promise<string[]> {
  const store = readStore()
  const liveIds = new Set(pool.map((p) => p.id))
  const goneIds = new Set(gone.map((p) => p.id))
  const keyOf = async (items: StoredPoolItem[]) =>
    new Map(
      (await Promise.all(items.map(async (p) => [await decryptPoolItem(p), p.id] as const)))
        .filter(([cfg]) => cfg)
        .map(([cfg, id]) => [proxyIdentity(cfg!), id])
    )
  const goneKeys = await keyOf(gone)
  const liveKeys = adopt ? await keyOf(pool) : new Map<string, string>()
  const reverted: string[] = []
  let dirty = false
  for (const [accountId, entry] of Object.entries(store)) {
    if (!entry.enc) continue
    if (entry.poolId) {
      if (liveIds.has(entry.poolId) && !goneIds.has(entry.poolId)) continue
    } else {
      const cfg = await loadProxyConfig(accountId).catch(() => null)
      if (!cfg || !isProxyMode(cfg.mode)) continue
      const live = liveKeys.get(proxyIdentity(cfg))
      if (live) {
        store[accountId] = { ...entry, poolId: live }
        dirty = true
        continue
      }
      // Legacy entry: ours only if the removed entry listed it and the address matches; else 自定义.
      const goneId = goneKeys.get(proxyIdentity(cfg))
      if (!goneId || !gone.find((p) => p.id === goneId)?.assignedAccountIds.includes(accountId)) continue
    }
    delete store[accountId]
    reverted.push(accountId)
    dirty = true
  }
  if (dirty) writeStore(store)
  for (const accountId of reverted) await applyProxyToPartition(accountId, { mode: "system" })
  return reverted
}

/** Remove one pool entry and revert the accounts using it. Returns the reverted account ids too. */
export async function removeProxyPoolItem(
  id: string,
  onReverted?: (accountId: string) => Promise<void>
): Promise<MuseProxyPoolItemView[]> {
  const reverted = await withProxyStoreLock(async () => {
    const pool = readPoolStore()
    const left = pool.filter((x) => x.id !== id)
    writePoolStore(left)
    return reconcilePoolBindingsUnlocked(left, pool.filter((x) => x.id === id))
  })
  for (const accountId of reverted) await onReverted?.(accountId)
  return listProxyPool()
}

export async function clearProxyPool(onReverted?: (accountId: string) => Promise<void>): Promise<MuseProxyPoolItemView[]> {
  const reverted = await withProxyStoreLock(async () => {
    const pool = readPoolStore()
    writePoolStore([])
    return reconcilePoolBindingsUnlocked([], pool)
  })
  for (const accountId of reverted) await onReverted?.(accountId)
  return []
}

/** Startup: drop bindings to pool entries that no longer exist; tag legacy pool-assigned accounts. */
export async function reconcilePoolBindings(): Promise<string[]> {
  return withProxyStoreLock(() => reconcilePoolBindingsUnlocked(readPoolStore(), [], true))
}

/**
 * Bind each account in `accountIds` to a pool proxy (see `planPoolAssignment`):
 * bound accounts keep theirs, the rest spread over the least-loaded proxies
 * under `limit` accounts each (0 = unlimited). Accounts set to 真直连 are a
 * deliberate choice and are left alone.
 */
export async function assignProxyPoolToAccounts(
  accountIds: string[],
  onAssigned?: (accountId: string) => Promise<void>,
  keep?: (accountId: string) => boolean,
  limit = 0,
  pauseAccount?: (accountId: string) => () => void
): Promise<{ assignedCount: number; items: MuseProxyPoolItemView[] }> {
  const configured = await withProxyStoreLock(async () => {
    const pool = readPoolStore()
    const store = readStore()
    const targets = accountIds.filter((id) => store[id]?.mode !== "direct")
    if (pool.length === 0 || targets.length === 0) return { changed: new Set<string>(), assignedCount: 0 }
    const plan = planPoolAssignment(pool, targets, keep, limit)
    const planned = new Map(plan.pool.map((slot) => [slot.id, new Set(slot.assignedAccountIds)]))
    const changed = new Set<string>()
    let assignedCount = 0
    // Bindings the plan dropped also drop that proxy from the account now.
    for (const slot of pool) {
      for (const accountId of slot.assignedAccountIds) {
        if (planned.get(slot.id)?.has(accountId)) continue
        const resume = pauseAccount?.(accountId)
        try {
          await clearPoolConfigUnlocked(accountId, slot)
          changed.add(accountId)
        } finally {
          resume?.()
        }
      }
    }
    for (const { accountId, slot } of plan.assigned) {
      const cfg = await decryptPoolItem(slot)
      if (cfg && isProxyMode(cfg.mode)) {
        const resume = pauseAccount?.(accountId)
        try {
          await saveProxyConfigUnlocked(accountId, cfg, slot.id)
          changed.add(accountId)
          assignedCount++
        } finally {
          resume?.()
        }
      }
    }
    writePoolStore(plan.pool)
    return { changed, assignedCount }
  })
  for (const accountId of configured.changed) await onAssigned?.(accountId)
  return { assignedCount: configured.assignedCount, items: await listProxyPool() }
}

/** Give an account's pool proxy back (failed/cancelled login) and drop its config. */
export async function releaseProxyPoolAccount(accountId: string): Promise<void> {
  await withProxyStoreLock(async () => {
    const pool = readPoolStore()
    const held = pool.filter((slot) => slot.assignedAccountIds.includes(accountId))
    if (!held.length) return
    for (const slot of held) await clearPoolConfigUnlocked(accountId, slot)
    writePoolStore(releasePoolSlot(pool, accountId))
  })
}

/**
 * Test connectivity & latency for an account's saved proxy or an unsaved draft config.
 * When `draft` omits `password` for the same proxy identity already saved on `accountId`,
 * the stored password is reused in memory without returning it to the renderer.
 */
export async function testAccountProxy(
  accountId: string,
  draft?: MuseProxyConfig,
  opts?: ProxyProbeOptions
): Promise<MuseProxyTestResult> {
  try {
    let resolved: MuseProxyConfig
    if (draft) {
      resolved = normalize(draft)
      if (resolved.mode !== "direct" && !resolved.password) {
        const prev = await loadProxyConfig(accountId).catch(() => null)
        if (prev?.password && proxyIdentity(prev) === proxyIdentity(resolved)) {
          resolved = { ...resolved, password: prev.password }
        }
      }
    } else {
      resolved = await loadProxyConfig(accountId)
    }
    const proxyUrl = buildAccountProxyUrl(resolved) ?? undefined
    return await probeProxyUrl(proxyUrl, opts)
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      checkedAt: Date.now()
    }
  }
}

/**
 * GOXF fork: the proxy-pool entry the updater goes through — the one that last
 * tested fastest, then untested ones, failed ones last. Chromium proxy rules
 * (authenticated / https proxies go through the loopback bridge), or null when
 * the pool has no usable entry (updater then follows the system proxy).
 */
export async function updaterPoolProxy(): Promise<{ rules: string; label: string } | null> {
  const rank = (p: StoredPoolItem): number =>
    p.lastTest?.ok ? (p.lastTest.ms ?? 5_000) : p.lastTest ? 1e9 : 1e6
  for (const item of [...readPoolStore()].sort((a, b) => rank(a) - rank(b))) {
    const cfg = await decryptPoolItem(item)
    if (!cfg || !isProxyMode(cfg.mode) || !cfg.host || !cfg.port) continue
    const rules = await resolvePartitionProxyRules(cfg)
    if (rules) return { rules, label: `${cfg.mode}://${formatHostForUrl(cfg.host)}:${cfg.port}` }
  }
  return null
}

/**
 * Test availability & latency for all (or selected) items in the encrypted proxy pool.
 */
export async function testProxyPoolItems(
  ids?: readonly string[],
  opts?: ProxyProbeOptions
): Promise<Record<string, MuseProxyTestResult>> {
  const pool = readPoolStore()
  const filter = ids && ids.length > 0 ? new Set(ids) : null
  const targets = filter ? pool.filter((item) => filter.has(item.id)) : pool
  const entries = await runWithConcurrency(targets, async (slot) => {
    const cfg = await decryptPoolItem(slot)
    if (!cfg || cfg.mode === "direct" || !cfg.host || !cfg.port) {
      return [
        slot.id,
        {
          ok: false,
          error: "代理配置无法解密或无效（请检查系统钥匙串）",
          checkedAt: Date.now()
        } satisfies MuseProxyTestResult
      ] as const
    }
    const proxyUrl = buildAccountProxyUrl(cfg) ?? undefined
    const result = await probeProxyUrl(proxyUrl, opts)
    return [slot.id, result] as const
  })
  const results: Record<string, MuseProxyTestResult> = Object.fromEntries(entries)
  // GOXF fork: keep the pool list's `lastTest` badge in step with the batch check.
  await withProxyStoreLock(async () => {
    writePoolStore(
      readPoolStore().map((p) => {
        const r = results[p.id]
        return r ? { ...p, lastTest: { ok: r.ok, ms: r.latencyMs, ip: r.exitIp, error: r.error } } : p
      })
    )
  }).catch(() => undefined)
  return results
}

/**
 * Apply every stored account proxy before any window or request runs.
 * Partitions start direct after a restart; Hark (no connect step) used to
 * stay direct until the proxy was saved again.
 */
export async function applyAllStoredProxies(log: (msg: string, err: unknown) => void = console.warn): Promise<void> {
  let ids: string[]
  try {
    ids = Object.keys(readStore())
  } catch (err) {
    log("[proxy] proxy store unreadable at startup", err)
    return
  }
  // Fail closed first (no decryption needed), so a slow keychain prompt
  // never lets the first requests out with the real IP.
  await Promise.all(
    ids.map((id) =>
      electronSession
        .fromPartition(partitionForAccount(id))
        .setProxy({ proxyRules: BLOCKING_PROXY_RULE, proxyBypassRules: "" })
        .catch((err: unknown) => log(`[proxy] ${id} not blocked`, err))
    )
  )
  await reconcilePoolBindings().catch((err) => log("[proxy] pool bindings not reconciled", err))
  await Promise.all(
    ids.map((id) => applyProxyToPartition(id).catch((err) => log(`[proxy] ${id} not applied`, err)))
  )
}

const IP_ECHO_URL = "https://api.ipify.org?format=json"
const TEST_TIMEOUT_MS = 8_000

/** Fetch an IP echo through `ses`: latency plus the exit IP the outside world sees. */
export async function measureEgress(ses: Pick<Session, "fetch">): Promise<ProxyTestResult> {
  const started = Date.now()
  try {
    const res = await ses.fetch(IP_ECHO_URL, { signal: AbortSignal.timeout(TEST_TIMEOUT_MS), cache: "no-store" })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const { ip } = (await res.json()) as { ip?: string }
    return { ok: true, ms: Date.now() - started, ip }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
    return { ok: false, error: timedOut ? "超时" : err instanceof Error ? err.message : String(err) }
  }
}

/** Throwaway in-memory session carrying exactly `cfg`'s routing (pool rows, unsaved drafts). */
async function scratchSession(key: string, cfg: MuseProxyConfig): Promise<Session> {
  const ses = electronSession.fromPartition(`proxy-test:${key}`)
  await ses.setProxy(sessionProxyConfig(await resolvePartitionProxyRules(cfg)))
  await closePartitionConnections(ses)
  return ses
}

/**
 * 测速 / 测试连通. `poolId` tests a pool proxy (result remembered: a timed-out
 * proxy is skipped by auto-assignment); `draft` tests an unsaved per-account
 * choice; `accountId` alone tests the account's own session as saved.
 */
export async function testProxy(target: {
  accountId?: string
  poolId?: string
  draft?: MuseProxyConfig & { poolId?: string }
}): Promise<ProxyTestResult> {
  const poolId = target.poolId ?? target.draft?.poolId
  if (poolId) {
    const slot = readPoolStore().find((p) => p.id === poolId)
    const cfg = slot && (await decryptPoolItem(slot))
    if (!cfg) return { ok: false, error: "代理不存在或无法解密" }
    const result = await measureEgress(await scratchSession(poolId, cfg))
    await withProxyStoreLock(() =>
      writePoolStore(readPoolStore().map((p) => (p.id === poolId ? { ...p, lastTest: result } : p)))
    )
    return result
  }
  if (target.draft && target.accountId) {
    const cfg = normalize(target.draft)
    if (isProxyMode(cfg.mode) && !cfg.password) {
      cfg.password = (await loadProxyConfig(target.accountId).catch(() => null))?.password
    }
    return measureEgress(await scratchSession(`draft:${target.accountId}`, cfg))
  }
  if (!target.accountId) return { ok: false, error: "缺少测试目标" }
  await applyProxyToPartition(target.accountId)
  return measureEgress(electronSession.fromPartition(partitionForAccount(target.accountId)))
}

/** What the OS proxy is right now (`PROXY 127.0.0.1:7890`, `DIRECT`, …) for the 跟随系统 hint. */
export async function describeSystemProxy(): Promise<string> {
  return electronSession.defaultSession.resolveProxy(IP_ECHO_URL)
}
