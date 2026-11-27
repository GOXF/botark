/**
 * GOXF fork: proxy-pool subscriptions.
 *
 * Sources (subscription URL or pasted links + their parsed catalog) are stored
 * encrypted with safeStorage in userData/goxf-proxy-subs.json. Neither the URL,
 * the links nor node secrets ever go over IPC or into a log.
 *
 * Adding a node/group to the pool snapshots it into a pool entry served by a
 * local Mihomo process (goxfMihomo) on 127.0.0.1 with random credentials; every
 * existing consumer sees an ordinary authenticated socks5h proxy. Refreshing a
 * source never changes an entry that is already in the pool.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { readJsonFile, writeJsonAtomic } from './jsonFile'
import {
  addMihomoPoolItems,
  listMihomoPoolKeys,
  listProxyPool,
  readMihomoPoolEntry,
  setMihomoPortCheck,
  setPoolRuntimeHook,
  type MihomoPoolMeta
} from './muse/accountProxy'
import {
  ensureMihomoEntry,
  installMihomoArchive,
  isPortFree,
  killAllMihomoSync,
  mihomoDelays,
  mihomoEntryCurrent,
  mihomoKernelStatus,
  setMihomoLatest,
  setMihomoRestartHook,
  stopAllMihomo,
  stopMihomoEntry
} from './goxfMihomo'
import { MIHOMO_RELEASE_BASE, pickReleaseAsset, selectMihomoAsset, type MihomoDownload } from './goxfMihomoAssets'
import { buildEntryConfig, type MihomoTargetSnapshot } from './goxfMihomoConfig'
import { poolThenSystemFetch, readCapped } from './goxfPoolFetch'
import {
  collectDependencies,
  NODE_ERROR_TEXT,
  parseSubscription,
  SUB_MAX_BYTES,
  sourceNameFromHeaders,
  SubParseError,
  type SubCatalog
} from './goxfSubParse'
import {
  GOXF_PROXYSUB_CHANNELS as CH,
  INSECURE_APPROVAL_NEEDED,
  type MihomoKernelEvent,
  type ProxySubAddRequest,
  type ProxySubDelay,
  type ProxySubListView,
  type ProxySubSourceView
} from '@shared/goxfProxySubs'

// ---------------------------------------------------------------- store

interface SourceSecret {
  url?: string
  links?: string
  name: string
  updatedAt: number
  catalog: SubCatalog
  lastError?: string
}

interface StoreFile {
  autoRefresh: boolean
  sources: Array<{ id: string; enc: string }>
}

const storePath = (): string => join(app.getPath('userData'), 'goxf-proxy-subs.json')

function readStore(): StoreFile {
  const raw = readJsonFile<StoreFile>(storePath(), { autoRefresh: false, sources: [] }, (r) => Boolean(r) && typeof r === 'object' && !Array.isArray(r))
  return { autoRefresh: raw.autoRefresh === true, sources: Array.isArray(raw.sources) ? raw.sources : [] }
}

const writeStore = (s: StoreFile): void => writeJsonAtomic(storePath(), s)

async function requireEncryption(): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('系统钥匙串不可用，无法加密保存订阅')
}

async function encrypt(secret: SourceSecret): Promise<string> {
  await requireEncryption()
  return (await safeStorage.encryptStringAsync(JSON.stringify(secret))).toString('base64')
}

async function decrypt(enc: string): Promise<SourceSecret | null> {
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return null
    const dec = await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'))
    return JSON.parse(dec.result) as SourceSecret
  } catch {
    return null
  }
}

let chain: Promise<unknown> = Promise.resolve()
/** Serialize read-modify-write of the subscription store. */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

async function loadSource(id: string): Promise<SourceSecret> {
  const entry = readStore().sources.find((s) => s.id === id)
  const src = entry && (await decrypt(entry.enc))
  if (!src) throw new Error('订阅来源不存在或无法解密')
  return src
}

// ---------------------------------------------------------------- views

const poolKey = (sourceId: string, kind: 'node' | 'group', name: string): string => JSON.stringify([sourceId, kind, name])

function sourceView(id: string, src: SourceSecret, keys: Set<string>): ProxySubSourceView {
  const { catalog } = src
  const nodeIdByName = new Map(catalog.nodes.map((n) => [n.name, n.id]))
  const inPool: string[] = []
  const nodes = catalog.nodes.map((n) => {
    if (keys.has(poolKey(id, 'node', n.name))) inPool.push(n.id)
    return {
      id: n.id,
      name: n.name,
      protocol: n.protocol,
      usable: Boolean(n.proxy),
      insecure: n.insecure,
      ...(n.error ? { reason: NODE_ERROR_TEXT[n.error] ?? '暂不支持' } : {})
    }
  })
  const groups = catalog.groups.map((g) => {
    if (keys.has(poolKey(id, 'group', g.name))) inPool.push(g.id)
    const deps = collectDependencies(catalog, g.name)
    return {
      id: g.id,
      name: g.name,
      kind: g.kind,
      nodeIds: deps.nodes.map((n) => nodeIdByName.get(n.name)!).filter(Boolean),
      usable: !g.error,
      insecure: deps.nodes.some((n) => n.insecure),
      ...(g.error ? { reason: NODE_ERROR_TEXT[g.error] ?? '暂不支持' } : {})
    }
  })
  return {
    id,
    name: src.name,
    kind: src.url ? 'url' : 'links',
    updatedAt: src.updatedAt,
    nodes,
    groups,
    inPool,
    ...(src.lastError ? { lastError: src.lastError } : {})
  }
}

async function listView(): Promise<ProxySubListView> {
  const store = readStore()
  const keys = await listMihomoPoolKeys()
  const sources: ProxySubSourceView[] = []
  for (const { id, enc } of store.sources) {
    const src = await decrypt(enc)
    if (src) sources.push(sourceView(id, src, keys))
  }
  return { sources, autoRefresh: store.autoRefresh }
}

// ---------------------------------------------------------------- download

const SUB_TIMEOUT_MS = 20_000

async function downloadSubscription(url: string): Promise<{ text: string; name: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('订阅地址无效')
  }
  if (parsed.protocol !== 'https:') throw new Error('订阅地址必须是 https://')
  let res: Response
  try {
    res = await poolThenSystemFetch(url, {
      headers: { 'User-Agent': 'clash.meta', Accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(SUB_TIMEOUT_MS),
      cache: 'no-store'
    })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    // The error text may contain the URL; only a generic reason leaves here.
    throw new Error(timedOut ? '下载订阅超时' : '下载订阅失败（网络错误）')
  }
  if (res.url && !res.url.startsWith('https://')) throw new Error('订阅被重定向到非 https 地址，已拒绝')
  if (!res.ok) throw new Error(`下载订阅失败（HTTP ${res.status}）`)
  const body = await readCapped(res, SUB_MAX_BYTES).catch(() => {
    throw new Error('订阅内容超过 2 MB')
  })
  return { text: body.toString('utf8'), name: sourceNameFromHeaders(res.headers, url) }
}

function parseOrThrow(text: string): SubCatalog {
  try {
    return parseSubscription(text)
  } catch (err) {
    if (err instanceof SubParseError) throw new Error(err.message)
    throw new Error('订阅内容无法识别')
  }
}

async function importSource(input: string): Promise<ProxySubListView> {
  const text = input.trim()
  if (!text) throw new Error('请粘贴订阅地址或节点链接')
  const isUrl = /^https?:\/\/\S+$/i.test(text)
  const secret: SourceSecret = isUrl
    ? await downloadSubscription(text).then(({ text: body, name }) => ({ url: text, name, updatedAt: Date.now(), catalog: parseOrThrow(body) }))
    : { links: text, name: '手动节点', updatedAt: Date.now(), catalog: parseOrThrow(text) }
  await locked(async () => {
    const store = readStore()
    // Same subscription again → replace it in place (keeps its id).
    let existing: string | undefined
    for (const s of store.sources) {
      const old = await decrypt(s.enc)
      if (old && ((secret.url && old.url === secret.url) || (secret.links && old.links === secret.links))) existing = s.id
    }
    const enc = await encrypt(secret)
    if (existing) store.sources = store.sources.map((s) => (s.id === existing ? { id: s.id, enc } : s))
    else store.sources.push({ id: `sub_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`, enc })
    writeStore(store)
  })
  return listView()
}

async function refreshSource(id: string, quiet = false): Promise<ProxySubListView> {
  const src = await loadSource(id)
  if (!src.url) return listView()
  let next: SourceSecret
  try {
    const { text, name } = await downloadSubscription(src.url)
    next = { ...src, name, updatedAt: Date.now(), catalog: parseOrThrow(text), lastError: undefined }
  } catch (err) {
    const message = err instanceof Error ? err.message : '刷新失败'
    await saveSource(id, { ...src, lastError: message })
    if (quiet) return listView()
    throw new Error(message)
  }
  await saveSource(id, next)
  return listView()
}

async function saveSource(id: string, secret: SourceSecret): Promise<void> {
  await locked(async () => {
    const store = readStore()
    const enc = await encrypt(secret)
    store.sources = store.sources.map((s) => (s.id === id ? { id, enc } : s))
    writeStore(store)
  })
}

async function removeSource(id: string): Promise<ProxySubListView> {
  await locked(async () => {
    const store = readStore()
    store.sources = store.sources.filter((s) => s.id !== id)
    writeStore(store)
  })
  return listView()
}

const AUTO_REFRESH_MS = 6 * 3600_000
let autoTimer: NodeJS.Timeout | undefined

function scheduleAutoRefresh(): void {
  clearInterval(autoTimer)
  autoTimer = setInterval(() => void autoRefreshDue(), 30 * 60_000)
  autoTimer.unref?.()
}

async function autoRefreshDue(): Promise<void> {
  const store = readStore()
  if (!store.autoRefresh) return
  for (const { id, enc } of store.sources) {
    const src = await decrypt(enc)
    if (src?.url && Date.now() - src.updatedAt >= AUTO_REFRESH_MS) await refreshSource(id, true).catch(() => undefined)
  }
}

// ---------------------------------------------------------------- latency

type SnapshotNode = MihomoTargetSnapshot['nodes'][number]
const snapNodes = (catalog: SubCatalog): SnapshotNode[] =>
  catalog.nodes.filter((n) => n.proxy).map((n) => ({ name: n.name, protocol: n.protocol, proxy: n.proxy! }))

async function testDelays(sourceId: string, nodeIds: string[]): Promise<Record<string, ProxySubDelay>> {
  const src = await loadSource(sourceId)
  const byId = new Map(src.catalog.nodes.map((n) => [n.id, n]))
  const wanted = nodeIds.map((id) => byId.get(id)).filter((n) => n?.proxy)
  const all = snapNodes(src.catalog)
  let res = await mihomoDelays(sourceId, all, wanted.map((n) => n!.name))
  // One node Mihomo rejects stops the whole test process: retry those alone.
  const failedStart = Object.values(res).some((r) => r.error?.startsWith('Mihomo 启动失败'))
  if (failedStart && all.length > 1) {
    res = {}
    for (const n of wanted) {
      const deps = collectDependencies(src.catalog, n!.name).nodes.map((d) => ({ name: d.name, protocol: d.protocol, proxy: d.proxy! }))
      Object.assign(res, await mihomoDelays(`${sourceId}:${n!.id}`, deps, [n!.name]))
    }
  }
  const out: Record<string, ProxySubDelay> = {}
  for (const id of nodeIds) {
    const n = byId.get(id)
    out[id] = n?.proxy ? (res[n.name] ?? { ok: false, error: '不可用' }) : { ok: false, error: '暂不支持' }
  }
  return out
}

// ---------------------------------------------------------------- pool entries

/** Loopback ports below every OS's ephemeral range, so outgoing sockets don't take them later. */
async function pickPort(taken: Set<number> = new Set()): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const port = 20000 + Math.floor(Math.random() * 12000)
    if (!taken.has(port) && (await isPortFree(port))) {
      taken.add(port)
      return port
    }
  }
  throw new Error('找不到可用的本地端口')
}

async function addToPool(req: ProxySubAddRequest): Promise<{ added: number; skipped: number }> {
  if (!mihomoKernelStatus().installed) throw new Error('请先安装 Mihomo 内核')
  const src = await loadSource(req.sourceId)
  const { catalog } = src
  const targets: Array<{ kind: 'node' | 'group'; name: string; protocol: string }> = []
  if (req.groupId) {
    const g = catalog.groups.find((x) => x.id === req.groupId)
    if (!g) throw new Error('分组不存在')
    if (g.error) throw new Error(`分组「${g.name}」不能加入：${NODE_ERROR_TEXT[g.error] ?? '暂不支持'}`)
    targets.push({ kind: 'group', name: g.name, protocol: 'group' })
  }
  for (const id of req.nodeIds ?? []) {
    const n = catalog.nodes.find((x) => x.id === id)
    if (n?.proxy) targets.push({ kind: 'node', name: n.name, protocol: n.protocol })
  }
  if (!targets.length) throw new Error('没有可加入的节点')

  const keys = await listMihomoPoolKeys()
  const taken = new Set<number>()
  const builds: Array<(id: string) => { cfg: { mode: 'socks5h'; host: string; port: number; username: string; password: string }; mihomo: MihomoPoolMeta }> = []
  let skipped = 0
  for (const t of targets) {
    const key = poolKey(req.sourceId, t.kind, t.name)
    if (keys.has(key)) {
      skipped++
      continue
    }
    const deps = collectDependencies(catalog, t.name)
    if (deps.nodes.some((n) => n.insecure) && !req.allowInsecure) throw new Error(INSECURE_APPROVAL_NEEDED)
    const snapshot: MihomoTargetSnapshot = {
      kind: t.kind,
      target: t.name,
      nodes: deps.nodes.map((n) => ({ name: n.name, protocol: n.protocol, proxy: n.proxy! })),
      groups: deps.groups.map(({ name, kind, members, options }) => ({ name, kind, members, options }))
    }
    const port = await pickPort(taken)
    const username = `ba${randomBytes(4).toString('hex')}`
    const password = randomBytes(18).toString('hex')
    // Fail now, not when an account first uses it.
    buildEntryConfig(snapshot, { mixedPort: port, username, password, controllerPort: 1, secret: 'x' })
    builds.push(() => ({
      cfg: { mode: 'socks5h', host: '127.0.0.1', port, username, password },
      mihomo: { key, sourceId: req.sourceId, sourceName: src.name, name: t.name, protocol: t.protocol, snapshot }
    }))
  }
  const added = builds.length ? await addMihomoPoolItems(builds) : 0
  return { added, skipped }
}

async function ensureEntry(id: string): Promise<void> {
  const entry = await readMihomoPoolEntry(id)
  if (!entry) throw new Error('订阅节点的代理配置无法读取（系统钥匙串）')
  const { cfg, mihomo } = entry
  if (!cfg.port || !cfg.username || !cfg.password) throw new Error('订阅节点的本地端口配置无效')
  await ensureMihomoEntry(id, { snapshot: mihomo.snapshot, port: cfg.port, username: cfg.username, password: cfg.password })
}

async function poolCurrent(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const item of await listProxyPool()) {
    if (!item.sub?.group) continue
    const now = await mihomoEntryCurrent(item.id, item.sub.name)
    if (now) out[item.id] = now
  }
  return out
}

// ---------------------------------------------------------------- kernel

function broadcast(event: MihomoKernelEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CH.kernelEvent, event)
  }
}

const LATEST_API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest'
let latestCheckedAt = 0

/** GOXF: newest official release for this OS/arch (cached 6 h); null when GitHub can't be reached. */
async function checkLatest(force = false): Promise<MihomoDownload | null> {
  if (!force && latestCached && Date.now() - latestCheckedAt < 6 * 3600_000) return latestCached
  try {
    const res = await poolThenSystemFetch(LATEST_API, {
      headers: { 'User-Agent': 'BotArk', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) return latestCached
    const next = pickReleaseAsset((await res.json()) as Parameters<typeof pickReleaseAsset>[0])
    if (next) {
      latestCached = next
      latestCheckedAt = Date.now()
      setMihomoLatest(next)
    }
  } catch {
    /* offline: keep what we had */
  }
  return latestCached
}
let latestCached: MihomoDownload | null = null

async function kernelDownload() {
  // Newest official release (digest-checked); the pinned build when GitHub's API is unreachable.
  const latest = await checkLatest(true)
  const pinned = selectMihomoAsset()
  const target = latest ?? (pinned ? { file: pinned.file, url: MIHOMO_RELEASE_BASE + pinned.file, size: pinned.size, sha256: pinned.sha256 } : null)
  if (!target) throw new Error(`Mihomo 没有 ${process.platform}-${process.arch} 的官方构建`)
  let res: Response
  try {
    res = await poolThenSystemFetch(target.url, {
      headers: { 'User-Agent': 'BotArk', Accept: 'application/octet-stream' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10 * 60_000)
    })
  } catch {
    throw new Error('下载内核失败（网络错误）。可以去 GitHub 下官方压缩包后点「本地导入」')
  }
  if (!res.ok) throw new Error(`下载内核失败（HTTP ${res.status}）`)
  let last = -1
  const data = await readCapped(res, target.size + 1024, (received) => {
    const percent = Math.floor((received / target.size) * 100)
    if (percent !== last) {
      last = percent
      broadcast({ type: 'progress', percent, totalMb: Math.round(target.size / 104857.6) / 10 })
    }
  })
  const status = await installMihomoArchive(data, { file: target.file, sha256: target.sha256, size: target.size })
  broadcast({ type: 'done', status })
  return status
}

async function kernelImport(event: Electron.IpcMainInvokeEvent) {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const asset = selectMihomoAsset()
  const opts: Electron.OpenDialogOptions = {
    title: '选择官方 Mihomo 压缩包',
    properties: ['openFile'],
    filters: [{ name: asset ? asset.file : 'Mihomo', extensions: ['zip', 'gz'] }]
  }
  const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  const file = picked.filePaths[0]
  if (picked.canceled || !file) return null
  if (statSync(file).size > 64 * 1024 * 1024) throw new Error('文件过大，不是官方内核压缩包')
  const status = await installMihomoArchive(readFileSync(file), { file: basename(file) })
  broadcast({ type: 'done', status })
  return status
}

// ---------------------------------------------------------------- wiring

// Registered at import time: accountProxy's startup pass (applyAllStoredProxies)
// needs both before any partition is applied.
setPoolRuntimeHook({
  ensure: ensureEntry,
  removed: (ids) => {
    for (const id of ids) void stopMihomoEntry(id)
  }
})
setMihomoPortCheck(isPortFree, () => pickPort())
setMihomoRestartHook((id) => ensureEntry(id).catch(() => undefined))
process.once('exit', killAllMihomoSync)

export async function stopProxySubs(): Promise<void> {
  clearInterval(autoTimer)
  await stopAllMihomo()
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new TypeError(`Invalid ${what}`)
  return v
}

export function registerProxySubsIpc(): void {
  scheduleAutoRefresh()
  void autoRefreshDue()
  ipcMain.handle(CH.kernelStatus, () => mihomoKernelStatus())
  ipcMain.handle(CH.kernelCheck, async () => {
    await checkLatest()
    return mihomoKernelStatus()
  })
  ipcMain.handle(CH.kernelDownload, () =>
    kernelDownload().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      broadcast({ type: 'error', message })
      throw new Error(message)
    })
  )
  ipcMain.handle(CH.kernelImport, (event) => kernelImport(event))
  ipcMain.handle(CH.list, () => listView())
  ipcMain.handle(CH.importSource, (_e, input: unknown) => {
    if (typeof input !== 'string' || input.length > SUB_MAX_BYTES) throw new TypeError('Invalid subscription input')
    return importSource(input)
  })
  ipcMain.handle(CH.refreshSource, (_e, id: unknown) => refreshSource(str(id, 'source id')))
  ipcMain.handle(CH.removeSource, (_e, id: unknown) => removeSource(str(id, 'source id')))
  ipcMain.handle(CH.setAutoRefresh, async (_e, on: unknown) => {
    await locked(async () => writeStore({ ...readStore(), autoRefresh: on === true }))
    if (on === true) void autoRefreshDue()
    return listView()
  })
  ipcMain.handle(CH.testDelays, (_e, sourceId: unknown, nodeIds: unknown) => {
    if (!Array.isArray(nodeIds)) throw new TypeError('Invalid node ids')
    return testDelays(str(sourceId, 'source id'), nodeIds.filter((x): x is string => typeof x === 'string').slice(0, 4096))
  })
  ipcMain.handle(CH.addToPool, (_e, req: unknown) => {
    if (!req || typeof req !== 'object') throw new TypeError('Invalid request')
    const r = req as Record<string, unknown>
    return addToPool({
      sourceId: str(r.sourceId, 'source id'),
      nodeIds: Array.isArray(r.nodeIds) ? r.nodeIds.filter((x): x is string => typeof x === 'string') : undefined,
      groupId: typeof r.groupId === 'string' ? r.groupId : undefined,
      allowInsecure: r.allowInsecure === true
    })
  })
  ipcMain.handle(CH.poolCurrent, () => poolCurrent())
}
