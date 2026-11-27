/**
 * GOXF fork: the user-installed Mihomo kernel and its processes.
 *
 * - Kernel: pinned official asset (goxfMihomoAssets), SHA-256 checked, unpacked
 *   into userData/mihomo/bin (portable: BotArk-Data). Never on PATH, never
 *   downloaded without the user pressing a button.
 * - Processes: one per Mihomo-served pool entry, loopback mixed inbound with
 *   random credentials, loopback controller with a random secret. The config goes
 *   through an owner-only file deleted once Mihomo has read it; never argv or a log.
 * - Latency tests: a throwaway controller-only process per subscription, stopped when idle.
 *
 * Ported in spirit from jlcodes99/cockpit-tools (codex_proxy_engine*.rs).
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer, connect } from 'node:net'
import { join } from 'node:path'
import { app } from 'electron'
import { readJsonFile, writeJsonAtomic } from './jsonFile'
import {
  anyPinnedAsset,
  assetNamePattern,
  compareVersions,
  extractMihomoBinary,
  matchPinnedAsset,
  mihomoBinaryName,
  MIHOMO_RELEASES_PAGE,
  MIHOMO_VERSION,
  parseMihomoVersion,
  selectMihomoAsset,
  sha256,
  type MihomoDownload
} from './goxfMihomoAssets'
import { buildCatalogConfig, buildEntryConfig, type MihomoTargetSnapshot } from './goxfMihomoConfig'
import type { MihomoKernelStatus, ProxySubDelay } from '@shared/goxfProxySubs'

const root = (): string => join(app.getPath('userData'), 'mihomo')
const binDir = (): string => join(root(), 'bin')
const binPath = (): string => join(binDir(), mihomoBinaryName())
const recordPath = (): string => join(root(), 'kernel.json')

interface KernelRecord {
  version: string
  binarySha256: string
  assetFile: string
  installedAt: number
}

let installing = false
/** Binary hash verified against kernel.json during this run. */
let verifiedSha: string | null = null

function readRecord(): KernelRecord | null {
  const rec = readJsonFile<KernelRecord | null>(recordPath(), null, (raw) => Boolean(raw) && typeof raw === 'object')
  return rec && typeof rec.binarySha256 === 'string' && typeof rec.version === 'string' ? rec : null
}

/** GOXF: newest official release for this OS/arch, as last checked (null = not checked / unavailable). */
let latest: MihomoDownload | null = null
export function setMihomoLatest(next: MihomoDownload | null): void {
  latest = next
}

export function mihomoKernelStatus(): MihomoKernelStatus {
  const rec = readRecord()
  const asset = selectMihomoAsset()
  const installed = Boolean(rec && existsSync(binPath()))
  return {
    installed,
    ...(rec ? { version: rec.version } : {}),
    pinnedVersion: MIHOMO_VERSION,
    ...(latest ? { latestVersion: latest.version } : {}),
    updateAvailable: Boolean(installed && rec && latest && compareVersions(latest.version, rec.version) > 0),
    asset: latest ? { file: latest.file, size: latest.size } : asset ? { file: asset.file, size: asset.size } : null,
    releasesPage: MIHOMO_RELEASES_PAGE,
    installing
  }
}

function execVersion(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(path, ['-v'], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err) reject(new Error('内核无法运行（可能被杀毒软件拦截，或与本机系统不匹配）'))
      else resolve(stdout)
    })
  })
}

/**
 * Install from an archive the caller already holds.
 * - `expect.sha256`: a download, checked against the digest GitHub published for that asset.
 * - otherwise the pinned official asset (hash known), or a local file whose name is this
 *   OS/arch's official asset name in any version (it must then run and report a version).
 */
export async function installMihomoArchive(archive: Buffer, expect?: { file: string; sha256?: string; size?: number }): Promise<MihomoKernelStatus> {
  if (installing) throw new Error('内核正在安装')
  const want = selectMihomoAsset()
  let asset: { file: string } | null = null
  if (expect?.sha256) {
    if ((expect.size && archive.length !== expect.size) || sha256(archive) !== expect.sha256) {
      throw new Error(`下载的 ${expect.file} 校验失败（SHA-256 和 GitHub 公布的不一致），请重试`)
    }
    asset = { file: expect.file }
  } else {
    asset = matchPinnedAsset(archive)
    if (!asset && expect?.file && assetNamePattern()?.test(expect.file)) asset = { file: expect.file }
  }
  if (!asset) {
    const other = anyPinnedAsset(archive)
    throw new Error(
      other
        ? `这是 ${other.file}，本机需要 ${want?.file ?? '（此系统没有官方构建）'}`
        : `认不出这个压缩包。请选本机对应的官方文件，文件名形如 ${want?.file ?? 'mihomo-<系统>-<架构>-v<版本>'}（不要改名）`
    )
  }
  installing = true
  try {
    const binary = extractMihomoBinary(archive, asset.file)
    const running = [...entries.keys()]
    await stopAllMihomo()
    mkdirSync(binDir(), { recursive: true })
    const tmp = `${binPath()}.new`
    writeFileSync(tmp, binary, { mode: 0o755 })
    chmodSync(tmp, 0o755)
    if (process.platform === 'darwin') {
      await new Promise<void>((resolve) => execFile('xattr', ['-d', 'com.apple.quarantine', tmp], () => resolve()))
    }
    const out = await execVersion(tmp).catch((err) => {
      rmSync(tmp, { force: true })
      throw err
    })
    const version = parseMihomoVersion(out)
    if (!version) {
      rmSync(tmp, { force: true })
      throw new Error('内核版本无法识别')
    }
    rmSync(binPath(), { force: true })
    renameSync(tmp, binPath())
    const binarySha256 = sha256(binary)
    writeJsonAtomic(recordPath(), { version, binarySha256, assetFile: asset.file, installedAt: Date.now() } satisfies KernelRecord)
    verifiedSha = binarySha256
    // Entries that were serving keep serving with the new binary.
    for (const id of running) void restartHook?.(id)
    return mihomoKernelStatus()
  } finally {
    installing = false
  }
}

/** The verified binary path, or a thrown, user-readable reason. */
function verifiedBinary(): string {
  const rec = readRecord()
  const path = binPath()
  if (!rec || !existsSync(path)) throw new Error('Mihomo 内核未安装（设置 → 代理池 → 下载并安装）')
  if (verifiedSha !== rec.binarySha256) {
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
    if (actual !== rec.binarySha256) throw new Error('Mihomo 内核文件被改动过，请重新安装')
    verifiedSha = actual
  }
  return path
}

// ---------------------------------------------------------------- ports & controller

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))))
    })
  })
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(800, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** Loopback controller GET; never through any proxy, never follows redirects; body capped. */
function controllerGet(port: number, secret: string, path: string, timeoutMs: number): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Authorization: `Bearer ${secret}` }, timeout: timeoutMs },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          body += c
          if (body.length > 65_536) req.destroy(new Error('response too large'))
        })
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(body)
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------- processes

interface RunningProcess {
  child: ChildProcess
  controllerPort: number
  secret: string
  names: Map<string, string>
  stopping: boolean
}

/** Every spawned child until it exits (sync kill on process exit). */
const liveChildren = new Set<ChildProcess>()

let runDirsReset = false
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function startProcess(key: string, yamlFor: (controllerPort: number, secret: string) => { yaml: string; names: Map<string, string> }, mixedPort?: number): Promise<RunningProcess> {
  const bin = verifiedBinary()
  if (!runDirsReset) {
    // First start this run: old runs' per-process homes go (nothing of ours runs yet).
    runDirsReset = true
    resetMihomoRunDirs()
  }
  if (mixedPort && !(await isPortFree(mixedPort))) throw new Error(`本地端口 ${mixedPort} 被其他程序占用（重启 BotArk 会自动换端口）`)
  const controllerPort = await freePort()
  const secret = randomBytes(24).toString('hex')
  const { yaml, names } = yamlFor(controllerPort, secret)
  const home = join(root(), 'run', createHash('sha256').update(key).digest('hex').slice(0, 16))
  mkdirSync(home, { recursive: true, mode: 0o700 })
  // Private file (owner-only), deleted as soon as Mihomo has read it. Not the
  // environment: Windows caps one variable at 32 767 chars (large groups exceed it).
  const configFile = join(home, `c-${randomBytes(6).toString('hex')}.yaml`)
  writeFileSync(configFile, yaml, { mode: 0o600 })
  const child = spawn(bin, ['-d', home, '-f', configFile], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SAFE_PATHS: home }
  })
  const dropConfig = () => rmSync(configFile, { force: true })
  liveChildren.add(child)
  child.once('exit', () => liveChildren.delete(child))
  let stderr = ''
  // Mihomo logs to stdout; kept in memory only for the start-failure reason.
  const collect = (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  let exited = false
  child.once('exit', () => (exited = true))
  const proc: RunningProcess = { child, controllerPort, secret, names, stopping: false }
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (exited) break
    const ok = await controllerGet(controllerPort, secret, '/version', 800).then((r) => r.status === 200, () => false)
    if (ok && (!mixedPort || (await portOpen(mixedPort)))) {
      dropConfig()
      return proc
    }
    await sleep(150)
  }
  child.kill()
  dropConfig()
  // Mihomo's message names the offending option, never the secret values we pass.
  const why = /level=(?:error|fatal) msg="?([^"\n]{1,160})/.exec(stderr)?.[1] ?? /(?:Parse config error|parse config error)[^\n]{0,160}/i.exec(stderr)?.[0]
  throw new Error(`Mihomo 启动失败${why ? `：${why}` : exited ? '' : '（超时）'}`)
}

function stopProcess(p: RunningProcess | undefined): Promise<void> {
  if (!p || p.child.exitCode !== null) return Promise.resolve()
  p.stopping = true
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      p.child.kill('SIGKILL')
      resolve()
    }, 2000)
    p.child.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
    p.child.kill()
  })
}

// ---- pool entries

export interface MihomoEntrySpec {
  snapshot: MihomoTargetSnapshot
  port: number
  username: string
  password: string
}

const entries = new Map<string, { spec: string; proc: Promise<RunningProcess>; restarts: number[] }>()
let restartHook: ((id: string) => Promise<void>) | null = null
/** Called after an unexpected exit or a kernel reinstall to bring an entry back. */
export function setMihomoRestartHook(hook: (id: string) => Promise<void>): void {
  restartHook = hook
}

/** Start (or reuse) the Mihomo process serving pool entry `id`. */
export async function ensureMihomoEntry(id: string, spec: MihomoEntrySpec): Promise<void> {
  const fingerprint = createHash('sha256').update(JSON.stringify(spec)).digest('hex')
  const cur = entries.get(id)
  if (cur && cur.spec === fingerprint) {
    const p = await cur.proc.catch(() => null)
    if (p && p.child.exitCode === null && !p.stopping) return
    if (entries.get(id) === cur) entries.delete(id)
  } else if (cur) {
    entries.delete(id)
    await stopProcess(await cur.proc.catch(() => undefined))
  }
  const again = entries.get(id)
  if (again) return void (await again.proc)
  const record = { spec: fingerprint, proc: null as unknown as Promise<RunningProcess>, restarts: cur?.restarts ?? [] }
  record.proc = startProcess(
    `entry:${id}`,
    (controllerPort, secret) => buildEntryConfig(spec.snapshot, { mixedPort: spec.port, username: spec.username, password: spec.password, controllerPort, secret }),
    spec.port
  )
  entries.set(id, record)
  try {
    const proc = await record.proc
    proc.child.once('exit', () => {
      if (proc.stopping || entries.get(id) !== record) return
      entries.delete(id)
      // Unexpected exit: bring it back a few times; never fall back to direct.
      const now = Date.now()
      record.restarts = record.restarts.filter((t) => now - t < 120_000)
      if (record.restarts.length >= 3) return
      record.restarts.push(now)
      setTimeout(() => void restartHook?.(id), 1000)
    })
  } catch (err) {
    if (entries.get(id) === record) entries.delete(id)
    throw err
  }
}

export async function stopMihomoEntry(id: string): Promise<void> {
  const cur = entries.get(id)
  entries.delete(id)
  if (cur) await stopProcess(await cur.proc.catch(() => undefined))
}

/** Current member of a running group entry (original name), else null. */
export async function mihomoEntryCurrent(id: string, groupName: string): Promise<string | null> {
  const cur = entries.get(id)
  const p = cur && (await cur.proc.catch(() => null))
  if (!p || p.child.exitCode !== null) return null
  const runtime = p.names.get(groupName)
  if (!runtime) return null
  const res = await controllerGet(p.controllerPort, p.secret, `/proxies/${encodeURIComponent(runtime)}`, 1500).catch(() => null)
  const now = (res?.json as { now?: unknown } | null)?.now
  if (typeof now !== 'string') return null
  for (const [orig, rt] of p.names) if (rt === now) return orig
  return null
}

// ---- latency tests for subscription nodes

const catalogs = new Map<string, { fingerprint: string; proc: Promise<RunningProcess>; timer?: NodeJS.Timeout }>()
let delaySlots = 3
const delayQueue: Array<() => void> = []
async function withDelaySlot<T>(fn: () => Promise<T>): Promise<T> {
  if (delaySlots === 0) await new Promise<void>((r) => delayQueue.push(r))
  else delaySlots--
  try {
    return await fn()
  } finally {
    const next = delayQueue.shift()
    if (next) next()
    else delaySlots++
  }
}

const DELAY_URL = 'https://www.gstatic.com/generate_204'
const CATALOG_IDLE_MS = 3 * 60_000

/** Measure node latency through Mihomo's controller (`/proxies/<name>/delay`). */
export async function mihomoDelays(
  sourceKey: string,
  nodes: MihomoTargetSnapshot['nodes'],
  wanted: string[]
): Promise<Record<string, ProxySubDelay>> {
  const fingerprint = createHash('sha256').update(JSON.stringify(nodes)).digest('hex')
  let cat = catalogs.get(sourceKey)
  if (cat && cat.fingerprint !== fingerprint) {
    catalogs.delete(sourceKey)
    clearTimeout(cat.timer)
    void cat.proc.then(stopProcess, () => undefined)
    cat = undefined
  }
  if (cat) {
    const p = await cat.proc.catch(() => null)
    if (!p || p.child.exitCode !== null) {
      catalogs.delete(sourceKey)
      cat = undefined
    }
  }
  if (!cat) {
    cat = { fingerprint, proc: startProcess(`catalog:${sourceKey}`, (controllerPort, secret) => buildCatalogConfig(nodes, { controllerPort, secret })) }
    catalogs.set(sourceKey, cat)
  }
  const current = cat
  clearTimeout(current.timer)
  let proc: RunningProcess
  try {
    proc = await current.proc
  } catch (err) {
    catalogs.delete(sourceKey)
    const error = err instanceof Error ? err.message : String(err)
    return Object.fromEntries(wanted.map((n) => [n, { ok: false, error }]))
  }
  const results = await Promise.all(
    wanted.map(async (name) => {
      const runtime = proc.names.get(name)
      if (!runtime) return [name, { ok: false, error: '节点不可测' }] as const
      return withDelaySlot(async () => {
        const path = `/proxies/${encodeURIComponent(runtime)}/delay?timeout=5000&url=${encodeURIComponent(DELAY_URL)}`
        const res = await controllerGet(proc.controllerPort, proc.secret, path, 7000).catch(() => null)
        const delay = (res?.json as { delay?: unknown } | null)?.delay
        if (res?.status === 200 && typeof delay === 'number' && delay > 0) return [name, { ok: true, ms: delay }] as const
        return [name, { ok: false, error: !res || res.status === 504 || res.status === 408 ? '超时' : '不可用' }] as const
      })
    })
  )
  current.timer = setTimeout(() => {
    if (catalogs.get(sourceKey) !== current) return
    catalogs.delete(sourceKey)
    void current.proc.then(stopProcess, () => undefined)
  }, CATALOG_IDLE_MS)
  current.timer.unref?.()
  return Object.fromEntries(results)
}

/** Stop every Mihomo process (app quit, reinstall). */
export async function stopAllMihomo(): Promise<void> {
  const all = [...entries.values(), ...catalogs.values()]
  entries.clear()
  for (const c of catalogs.values()) clearTimeout(c.timer)
  catalogs.clear()
  await Promise.allSettled(all.map(async (e) => stopProcess(await e.proc.catch(() => undefined))))
}

/** Last-resort synchronous kill (process `exit`). */
export function killAllMihomoSync(): void {
  for (const child of liveChildren) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
}

/** Clean leftovers of an older run's homes (cache files only). */
function resetMihomoRunDirs(): void {
  try {
    rmSync(join(root(), 'run'), { recursive: true, force: true })
  } catch {
    /* in use */
  }
}
