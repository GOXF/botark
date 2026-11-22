/**
 * GOXF fork only: replaces ./updater (electron-updater) for this fork.
 *
 * Why not electron-updater: it reads qybaihe's latest.yml and would install an
 * upstream build over the fork, and it cannot update a portable exe at all.
 * Instead two independent GitHub API checks run on the same 4h interval:
 *   a) upstream  qybaihe/botark releases/latest  > package.json version → "merge into your fork" (open page only)
 *   b) fork      GOXF/botark newest v*-goxf.*     > version+goxfBuild    → "your portable build has an update"
 *                portable on Windows: download exe next to the old one, swap via PowerShell after exit, relaunch
 *                otherwise: open the release page
 * Exposes the same registerUpdaterIpc/startAutoUpdater as ./updater so index.ts only swaps one import.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { UPDATE_CHANNELS, type UpdateStatusEvent } from '@shared/ipc'
import {
  GOXF_UPDATE_CHANNELS,
  type GoxfPortablePrompt,
  type GoxfUpdateEvent,
  type GoxfUpdateState,
  type GoxfUpstreamPrompt
} from '@shared/goxfUpdate'
import { checkFailedMessage } from './updateCheck'
import {
  buildReplaceScript,
  buildZipReplaceScript,
  decideUpdatePrompts,
  formatGoxfVersion,
  normalizeGoxfBuild,
  type GitHubRelease,
  type PortableKind,
  type ReleaseAsset
} from './goxfUpdateLogic'
import { PORTABLE_DIR, PORTABLE_FILE } from './goxfPortable'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const UPSTREAM_REPO = 'qybaihe/botark'
const FORK_REPO = 'GOXF/botark'
const UPSTREAM_API_LATEST = `https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`
const FORK_API_RELEASES = `https://api.github.com/repos/${FORK_REPO}/releases?per_page=30`
const FORK_RELEASES_PAGE = `https://github.com/${FORK_REPO}/releases`

let started = false
let installing = false
let upstreamPrompt: GoxfUpstreamPrompt | null = null
let portablePrompt: (GoxfPortablePrompt & { asset: ReleaseAsset | null }) | null = null

function readGoxfBuild(): number {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { goxfBuild?: unknown }
    return normalizeGoxfBuild(pkg.goxfBuild)
  } catch {
    return 0
  }
}

const baseVersion = (): string => app.getVersion()
let cachedBuild: number | null = null
const goxfBuild = (): number => (cachedBuild ??= readGoxfBuild())
const currentVersion = (): string => formatGoxfVersion(baseVersion(), goxfBuild())
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

async function check(manual: boolean): Promise<void> {
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
    platform: process.platform,
    upstreamRepo: UPSTREAM_REPO,
    forkRepo: FORK_REPO
  })
  upstreamPrompt = decision.upstream
  portablePrompt = decision.portable
  if (decision.upstream) broadcastGoxf({ type: 'upstream-available', prompt: decision.upstream })
  if (decision.portable && !installing) {
    const { asset: _asset, ...prompt } = decision.portable
    broadcastGoxf({ type: 'portable-available', prompt })
  }
  if (!manual) return
  if (decision.upstream || decision.portable) {
    // Ends the "checking…" spinner without a toast (UpdateBanner ignores 'dev-skip').
    broadcast({ type: 'error', message: 'dev-skip' })
  } else if (!up.ok && !fork.ok) {
    broadcast({ type: 'error', message: fork.message })
  } else {
    broadcast({ type: 'not-available', version: currentVersion() })
  }
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

async function installPortable(): Promise<void> {
  const prompt = portablePrompt
  if (!prompt) return
  if (!portableSelfUpdate() || !prompt.canSelfUpdate || !prompt.asset) {
    void shell.openExternal(prompt.url || FORK_RELEASES_PAGE)
    return
  }
  if (installing) return
  installing = true
  const zipMode = portableKind() === 'zip'
  // exe build: the launcher's exe; zip build: the folder holding BotArk.exe.
  const dir = zipMode ? PORTABLE_DIR! : dirname(PORTABLE_FILE!)
  const partial = join(dir, `.${basename(prompt.asset.name)}.download`)
  const ready = zipMode ? join(dir, '.botark-update.zip') : join(dir, `.${basename(prompt.asset.name)}.new`)
  try {
    broadcastGoxf({ type: 'portable-downloading', percent: 0 })
    for (const f of [partial, ready]) if (existsSync(f)) unlinkSync(f)
    await downloadTo(prompt.asset.browser_download_url, partial, prompt.asset.size)
    renameSync(partial, ready)
    const script = join(tmpdir(), `botark-portable-update-${Date.now()}.ps1`)
    const logFile = join(dir, 'BotArk-Data', 'portable-update.log')
    const body = zipMode
      ? buildZipReplaceScript({
          appDir: dir,
          zipFile: ready,
          exeName: basename(process.execPath),
          pid: process.pid,
          logFile
        })
      : buildReplaceScript({ oldExe: PORTABLE_FILE!, newExe: ready, pid: process.pid, logFile })
    // UTF-8 BOM so Windows PowerShell 5.1 reads non-ASCII paths correctly.
    writeFileSync(script, '\uFEFF' + body, 'utf8')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
      { detached: true, stdio: 'ignore', windowsHide: true }
    )
    child.unref()
    broadcastGoxf({ type: 'portable-restarting', version: prompt.version })
    setTimeout(() => app.quit(), 600)
  } catch (error) {
    installing = false
    for (const f of [partial, ready]) {
      try {
        if (existsSync(f)) unlinkSync(f)
      } catch {
        /* ignore */
      }
    }
    const raw = error instanceof Error ? error.message : String(error)
    broadcastGoxf({ type: 'portable-error', message: `便携版更新失败：${raw}。已为你打开发布页，可手动下载替换。` })
    void shell.openExternal(prompt.url || FORK_RELEASES_PAGE)
  }
}

function state(): GoxfUpdateState {
  return {
    currentVersion: currentVersion(),
    upstreamBaseVersion: baseVersion(),
    portable: Boolean(PORTABLE_DIR),
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
}

export function startAutoUpdater(): void {
  if (started) return
  started = true
  setTimeout(() => void check(false), 8_000)
  setInterval(() => void check(false), CHECK_INTERVAL_MS)
}
