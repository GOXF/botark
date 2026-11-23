/**
 * GOXF fork only: replaces ./updater (electron-updater) for this fork.
 *
 * Why not electron-updater: it reads qybaihe's latest.yml and would install an
 * upstream build over the fork, and it cannot update a portable exe at all.
 * Instead two independent GitHub API checks run daily (1h→6h backoff after failures):
 *   a) upstream  qybaihe/botark releases/latest  > package.json version → "merge into your fork" (open page only)
 *   b) fork      GOXF/botark newest v*-goxf.*     > version+goxfBuild    → "your portable build has an update"
 *                portable on Windows: download exe next to the old one, swap via PowerShell after exit, relaunch
 *                zip build: delta first (manifest + patch zip, only changed resources/ files), else full zip;
 *                  unpacked and checked in-app (tar.exe, Expand-Archive fallback) BEFORE quitting, so the
 *                  script only kills leftover BotArk processes and renames; update-in-progress.lock keeps a
 *                  manual relaunch from grabbing the files mid-swap (see exitIfUpdating)
 *                otherwise: open the release page
 * Channel stable/test (see goxfUpdateLogic) is persisted in <userData>/goxf-update.json.
 * Every update writes BotArk-Data/update.log; update-pending.json lets the next start tell a failed swap.
 * Exposes the same registerUpdaterIpc/startAutoUpdater as ./updater so index.ts only swaps one import.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { UPDATE_CHANNELS, type UpdateStatusEvent } from '@shared/ipc'
import {
  GOXF_UPDATE_CHANNELS,
  type GoxfUpdateEvent,
  type GoxfUpdateState,
  type GoxfUpstreamPrompt
} from '@shared/goxfUpdate'
import { checkFailedMessage } from './updateCheck'
import {
  buildDeltaReplaceScript,
  buildReplaceScript,
  buildZipReplaceScript,
  decideUpdatePrompts,
  formatGoxfVersion,
  isUpdateLockFresh,
  nextCheckDelayMs,
  normalizeChannel,
  normalizeGoxfBuild,
  parseManifest,
  planDelta,
  psQuote,
  type GoxfChannel,
  type GitHubRelease,
  type PortableKind,
  type PromptDecision
} from './goxfUpdateLogic'
import { writeJsonAtomic } from './jsonFile'
import { PORTABLE_DATA_DIR, PORTABLE_DIR, PORTABLE_FILE } from './goxfPortable'
import { flushSessionCookies } from './goxfSessionCookies'

const UPSTREAM_REPO = 'qybaihe/botark'
const FORK_REPO = 'GOXF/botark'
const UPSTREAM_API_LATEST = `https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`
const FORK_API_RELEASES = `https://api.github.com/repos/${FORK_REPO}/releases?per_page=30`
const FORK_RELEASES_PAGE = `https://github.com/${FORK_REPO}/releases`

let started = false
let installing = false
let upstreamPrompt: GoxfUpstreamPrompt | null = null
let portablePrompt: PromptDecision['portable'] = null

/** package.json fork fields; goxfTag/goxfBuiltAt are stamped by CI (absent in local builds). */
function readPkg(): { goxfBuild: number; goxfTag: string | null; goxfBuiltAt: string | null } {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as Record<string, unknown>
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
    return { goxfBuild: normalizeGoxfBuild(pkg.goxfBuild), goxfTag: str(pkg.goxfTag), goxfBuiltAt: str(pkg.goxfBuiltAt) }
  } catch {
    return { goxfBuild: 0, goxfTag: null, goxfBuiltAt: null }
  }
}

const baseVersion = (): string => app.getVersion()
let cachedPkg: ReturnType<typeof readPkg> | null = null
const pkg = (): ReturnType<typeof readPkg> => (cachedPkg ??= readPkg())
const goxfBuild = (): number => pkg().goxfBuild
/** Our release tag without "v": CI stamp (also covers dev builds), else version-goxf.build. */
const currentVersion = (): string => pkg().goxfTag?.replace(/^v/i, '') || formatGoxfVersion(baseVersion(), goxfBuild())

const settingsFile = (): string => join(app.getPath('userData'), 'goxf-update.json')
function readChannel(): GoxfChannel {
  try {
    return normalizeChannel((JSON.parse(readFileSync(settingsFile(), 'utf8')) as { channel?: unknown }).channel)
  } catch {
    return 'stable'
  }
}
let channel: GoxfChannel | null = null
const currentChannel = (): GoxfChannel => (channel ??= readChannel())

const updateLog = PORTABLE_DATA_DIR ? join(PORTABLE_DATA_DIR, 'update.log') : null
const pendingFile = PORTABLE_DATA_DIR ? join(PORTABLE_DATA_DIR, 'update-pending.json') : null
const lockFile = PORTABLE_DATA_DIR ? join(PORTABLE_DATA_DIR, 'update-in-progress.lock') : null
function logUpdate(message: string): void {
  if (!updateLog) return
  try {
    appendFileSync(updateLog, `[${new Date().toISOString()}] ${message}\r\n`)
  } catch {
    /* ignore */
  }
}

/** Once per start: if the last self-update was meant to bring another version, it did not take. */
function takePendingFailure(): string | null {
  if (!pendingFile || !existsSync(pendingFile)) return null
  try {
    const { target } = JSON.parse(readFileSync(pendingFile, 'utf8')) as { target?: string }
    unlinkSync(pendingFile)
    if (!target || target === currentVersion()) {
      logUpdate(`now running ${currentVersion()}`)
      return null
    }
    logUpdate(`update to ${target} did not take; still ${currentVersion()}`)
    return `上次更新到 v${target} 没有成功，已保留 v${currentVersion()}。详情见 BotArk-Data/update.log`
  } catch {
    return null
  }
}
/**
 * Call before requestSingleInstanceLock: while a zip self-update swaps files, a copy the user starts
 * by hand would lock them (and then block the relaunch), so tell them to wait and exit.
 * A lock older than 3 min is left over from a crash: delete it and start normally.
 */
export function exitIfUpdating(): void {
  if (!lockFile) return
  try {
    if (!isUpdateLockFresh(statSync(lockFile).mtimeMs, Date.now())) {
      unlinkSync(lockFile)
      logUpdate('removed stale update lock')
      return
    }
  } catch {
    return
  }
  logUpdate('start refused: update in progress')
  dialog.showErrorBox('BotArk', 'BotArk 正在更新，请稍候…\n更新完成后会自动重新打开，不需要手动启动。')
  process.exit(0)
}

/** 'exe' = single portable exe (launcher env), 'zip' = unpacked folder with BotArk-Data beside BotArk.exe. */
const portableKind = (): PortableKind => (PORTABLE_FILE ? 'exe' : PORTABLE_DIR ? 'zip' : null)
const portableSelfUpdate = (): boolean => process.platform === 'win32' && portableKind() !== null

function sendAll(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}
const broadcast = (event: UpdateStatusEvent): void => sendAll(UPDATE_CHANNELS.event, event)
const broadcastGoxf = (event: GoxfUpdateEvent): void => sendAll(GOXF_UPDATE_CHANNELS.event, event)

type Fetched<T> = { ok: true; data: T | null } | { ok: false; message: string }

async function getJson<T>(url: string): Promise<Fetched<T>> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `BotArk/${currentVersion()}` },
      signal: AbortSignal.timeout(12_000)
    })
    // 404 = repo has no (latest) release yet: not an error.
    if (res.status === 404) return { ok: true, data: null }
    if (!res.ok) {
      const why = res.status === 403 || res.status === 429 ? '，GitHub 限流了，稍后再试' : res.status >= 500 ? '，GitHub 暂时不可用' : ''
      return { ok: false, message: `检查更新失败（HTTP ${res.status}${why}）` }
    }
    return { ok: true, data: (await res.json().catch(() => null)) as T | null }
  } catch (error) {
    return { ok: false, message: checkFailedMessage(error) }
  }
}

/** Returns false only when both GitHub requests failed (drives the retry backoff). */
async function check(manual: boolean): Promise<boolean> {
  if (manual) broadcast({ type: 'checking' })
  const [up, fork] = await Promise.all([
    getJson<GitHubRelease>(UPSTREAM_API_LATEST),
    getJson<GitHubRelease[]>(FORK_API_RELEASES)
  ])
  const decision = decideUpdatePrompts({
    version: baseVersion(),
    goxfBuild: goxfBuild(),
    upstreamLatest: up.ok ? up.data : null,
    forkReleases: fork.ok && Array.isArray(fork.data) ? fork.data : null,
    portable: portableKind(),
    channel: currentChannel(),
    buildTag: `v${currentVersion()}`,
    builtAt: pkg().goxfBuiltAt,
    platform: process.platform,
    upstreamRepo: UPSTREAM_REPO,
    forkRepo: FORK_REPO
  })
  upstreamPrompt = decision.upstream
  portablePrompt = decision.portable
  if (decision.upstream) broadcastGoxf({ type: 'upstream-available', prompt: decision.upstream })
  if (decision.portable && !installing) {
    const { asset: _asset, delta: _delta, fallback: _fallback, ...prompt } = decision.portable
    broadcastGoxf({ type: 'portable-available', prompt })
  }
  const reachable = up.ok || fork.ok
  if (!manual) return reachable
  if (decision.upstream || decision.portable) {
    // Ends the "checking…" spinner without a toast (UpdateBanner ignores 'dev-skip').
    broadcast({ type: 'error', message: 'dev-skip' })
  } else if (!up.ok && !fork.ok) {
    broadcast({ type: 'error', message: fork.message })
  } else {
    broadcast({ type: 'not-available', version: currentVersion() })
  }
  return reachable
}

async function downloadTo(url: string, dest: string, expected?: number): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': `BotArk/${currentVersion()}`, Accept: 'application/octet-stream' },
    redirect: 'follow'
  })
  if (!res.ok || !res.body) throw new Error(`下载失败（HTTP ${res.status}）`)
  const total = Number(res.headers.get('content-length')) || expected || 0
  let received = 0
  let lastPct = -1
  const body = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>)
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (!total) return
    const pct = Math.floor((received / total) * 100)
    if (pct !== lastPct) {
      lastPct = pct
      broadcastGoxf({ type: 'portable-downloading', percent: pct })
    }
  })
  await pipeline(body, createWriteStream(dest))
  if (total && received !== total) throw new Error(`下载不完整（${received}/${total} 字节）`)
}

function sha256File(path: string): Promise<string | null> {
  if (!existsSync(path)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', () => resolve(null))
  })
}

/** Files to replace when a delta fits this install, else null (→ full zip). Never throws. */
async function planDeltaFor(dir: string, manifestUrl: string): Promise<Array<{ path: string; sha256: string }> | null> {
  try {
    const res = await fetch(manifestUrl, {
      headers: { 'User-Agent': `BotArk/${currentVersion()}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`)
    const files = parseManifest(await res.json())
    if (!files) throw new Error('manifest invalid')
    const local: Record<string, string | null> = {}
    for (const f of files) local[f.path] = await sha256File(join(dir, ...f.path.split('/')))
    const plan = planDelta(files, local)
    if (plan.mode === 'full') {
      logUpdate(`delta not possible (${plan.reason}); using full zip`)
      return null
    }
    return plan.changed
  } catch (error) {
    logUpdate(`delta check failed (${error instanceof Error ? error.message : String(error)}); using full zip`)
    return null
  }
}

/** Run a hidden child process; rejects with its stderr on a non-zero exit. */
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()).length > 4000 && (stderr = stderr.slice(-2000)))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${basename(cmd)} exit ${code}: ${stderr.trim().slice(-300)}`))))
  })
}

/** Unpack into a fresh dest: Windows' bsdtar (seconds; Win10 1803+), else the slow Expand-Archive. */
async function unzip(zip: string, dest: string): Promise<void> {
  const fresh = (): void => {
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
  }
  fresh()
  try {
    await run(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest])
    logUpdate(`unpacked ${basename(zip)} with tar.exe`)
  } catch (error) {
    logUpdate(`tar.exe failed (${error instanceof Error ? error.message : String(error)}); trying Expand-Archive`)
    fresh()
    await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(dest)} -Force`
    ])
    logUpdate(`unpacked ${basename(zip)} with Expand-Archive`)
  }
}

/** Save session cookies, then quit; exit hard if a before-quit/close handler stalls or vetoes it. */
async function quitForUpdate(): Promise<void> {
  await Promise.race([flushSessionCookies().catch(() => undefined), new Promise((r) => setTimeout(r, 3_000))])
  logUpdate('quitting for update')
  setTimeout(() => {
    logUpdate('quit did not finish in 3s; forcing exit')
    app.exit(0)
  }, 3_000)
  app.quit()
}

async function installPortable(): Promise<void> {
  const prompt = portablePrompt
  if (!prompt) return
  if (!portableSelfUpdate() || !prompt.canSelfUpdate) {
    void shell.openExternal(prompt.url || FORK_RELEASES_PAGE)
    return
  }
  if (installing) return
  installing = true
  const zipMode = portableKind() === 'zip'
  // exe build: the launcher's exe; zip build: the folder holding BotArk.exe.
  const dir = zipMode ? PORTABLE_DIR! : dirname(PORTABLE_FILE!)
  broadcastGoxf({ type: 'portable-downloading', percent: 0 })
  logUpdate(`update ${currentVersion()} → ${prompt.version} (${currentChannel()} channel)`)
  const changed = zipMode && prompt.delta ? await planDeltaFor(dir, prompt.delta.manifest.browser_download_url) : null
  // A patch-only (fast CI) release that does not fit this install: take the newest full zip instead.
  let target = prompt.version
  let full = prompt.asset
  if (!changed && !full) {
    if (!prompt.fallback) {
      installing = false
      logUpdate(`${prompt.version} has only a delta patch, it does not fit this install, and no newer full build exists`)
      broadcastGoxf({ type: 'portable-error', message: `v${prompt.version} 只有增量补丁，且不适用于当前程序；暂无可用的完整包。已为你打开发布页。` })
      void shell.openExternal(prompt.url || FORK_RELEASES_PAGE)
      return
    }
    full = prompt.fallback.asset
    target = prompt.fallback.version
    logUpdate(`${prompt.version} has only a delta patch and it does not fit this install; skipping to newest full build ${target}`)
  }
  const asset = changed ? prompt.delta!.patch : full!
  const partial = join(dir, `.${basename(asset.name)}.download`)
  const ready = changed
    ? join(dir, '.botark-update-patch.zip')
    : zipMode
      ? join(dir, '.botark-update.zip')
      : join(dir, `.${basename(asset.name)}.new`)
  const stage = join(dir, '.botark-update-stage')
  try {
    for (const f of [partial, ready]) if (existsSync(f)) unlinkSync(f)
    await downloadTo(asset.browser_download_url, partial, asset.size)
    renameSync(partial, ready)
    logUpdate(`downloaded ${changed ? `delta (${changed.length} files)` : 'full'}: ${asset.name}`)
    const exeName = basename(process.execPath)
    const logFile = join(dir, 'BotArk-Data', 'update.log')
    let body: string
    if (zipMode) {
      broadcastGoxf({ type: 'portable-extracting', version: target })
      await unzip(ready, stage)
      const head = { appDir: dir, exeName, pid: process.pid, logFile, lockFile: lockFile! }
      if (changed) {
        for (const f of changed) {
          if ((await sha256File(join(stage, ...f.path.split('/')))) !== f.sha256) throw new Error(`补丁文件校验失败：${f.path}`)
        }
        body = buildDeltaReplaceScript({ ...head, patchZip: ready, stageDir: stage, files: changed })
      } else {
        // A zip with a single top-level folder: that folder is the new app root.
        const top = readdirSync(stage, { withFileTypes: true })
        const src = top.length === 1 && top[0].isDirectory() ? join(stage, top[0].name) : stage
        if (!existsSync(join(src, exeName))) throw new Error(`更新包里没有 ${exeName}`)
        body = buildZipReplaceScript({ ...head, zipFile: ready, stageDir: stage, srcDir: src })
      }
      logUpdate('staged and verified; handing over to the swap script')
    } else {
      body = buildReplaceScript({ oldExe: PORTABLE_FILE!, newExe: ready, pid: process.pid, logFile })
    }
    const script = join(tmpdir(), `botark-portable-update-${Date.now()}.ps1`)
    // UTF-8 BOM so Windows PowerShell 5.1 reads non-ASCII paths correctly.
    writeFileSync(script, '\uFEFF' + body, 'utf8')
    if (pendingFile) writeFileSync(pendingFile, JSON.stringify({ target, from: currentVersion() }))
    // Before quitting, so a relaunch in the gap before the script starts is turned away too.
    if (zipMode) writeFileSync(lockFile!, new Date().toISOString())
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
      { detached: true, stdio: 'ignore', windowsHide: true }
    )
    child.unref()
    logUpdate(`swap script started (${script})`)
    broadcastGoxf({ type: 'portable-restarting', version: target })
    setTimeout(() => void quitForUpdate(), 600)
  } catch (error) {
    installing = false
    for (const f of [partial, ready, ...(zipMode && lockFile ? [lockFile] : [])]) {
      try {
        if (existsSync(f)) unlinkSync(f)
      } catch {
        /* ignore */
      }
    }
    rmSync(stage, { recursive: true, force: true, maxRetries: 2 })
    const raw = error instanceof Error ? error.message : String(error)
    logUpdate(`failed before swap: ${raw}`)
    broadcastGoxf({ type: 'portable-error', message: `便携版更新失败：${raw}。已为你打开发布页，可手动下载替换。` })
    void shell.openExternal(prompt.url || FORK_RELEASES_PAGE)
  }
}

function state(): GoxfUpdateState {
  return {
    currentVersion: currentVersion(),
    upstreamBaseVersion: baseVersion(),
    portable: Boolean(PORTABLE_DIR),
    channel: currentChannel(),
    upstream: upstreamPrompt,
    portableUpdate: portablePrompt
      ? { version: portablePrompt.version, url: portablePrompt.url, canSelfUpdate: portablePrompt.canSelfUpdate }
      : null
  }
}

export function registerUpdaterIpc(): void {
  ipcMain.handle(UPDATE_CHANNELS.check, async () => {
    await check(true)
    return { ok: true as const }
  })
  // Legacy "install" button of the upstream banner: never emitted by this updater,
  // but keep it harmless.
  ipcMain.handle(UPDATE_CHANNELS.install, async () => {
    void shell.openExternal(portablePrompt?.url || FORK_RELEASES_PAGE)
    return { ok: true as const }
  })
  ipcMain.handle(UPDATE_CHANNELS.version, () => currentVersion())
  ipcMain.handle(GOXF_UPDATE_CHANNELS.openUpstream, async () => {
    void shell.openExternal(upstreamPrompt?.url || `https://github.com/${UPSTREAM_REPO}/releases/latest`)
    return { ok: true as const }
  })
  ipcMain.handle(GOXF_UPDATE_CHANNELS.installPortable, async () => {
    await installPortable()
    return { ok: true as const }
  })
  ipcMain.handle(GOXF_UPDATE_CHANNELS.state, () => state())
  ipcMain.handle(GOXF_UPDATE_CHANNELS.setChannel, async (_event, raw: unknown) => {
    channel = normalizeChannel(raw)
    writeJsonAtomic(settingsFile(), { channel })
    portablePrompt = null
    await check(false).catch(() => false)
    return state()
  })
}

export function startAutoUpdater(): void {
  if (started) return
  started = true
  let failures = 0
  let first = true
  const run = async (): Promise<void> => {
    failures = (await check(false).catch(() => false)) ? 0 : failures + 1
    if (first) {
      first = false
      // After the check so the "available" card cannot hide it.
      const failed = takePendingFailure()
      if (failed) broadcastGoxf({ type: 'portable-error', message: failed })
    }
    setTimeout(() => void run(), nextCheckDelayMs(failures)).unref()
  }
  setTimeout(() => void run(), 8_000)
}
