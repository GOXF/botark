import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { UPDATE_CHANNELS, type UpdateStatusEvent } from '@shared/ipc'
import { checkFailedMessage, interpretLatestRelease } from './updateCheck'
import { inspectMacCodeSignature } from './securityVault'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const GITHUB_OWNER = 'qybaihe'
const GITHUB_REPO = 'botark'
const RELEASES_LATEST = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
const GITHUB_API_LATEST = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

let started = false
let lastInfo: UpdateInfo | null = null
let latestVersionTag: string | null = null
let downloaded = false

interface UpdateCheck {
  manual: boolean
  done: Promise<void>
}

let activeCheck: UpdateCheck | undefined
const SIGNING_ERROR = /ShipIt|code signature|代码不含资源|did not pass validation/i

/**
 * ShipIt (Squirrel.Mac) requires a valid Developer ID Application signature on macOS.
 * Unsigned/ad-hoc builds fall back to opening the GitHub Release download page;
 * Developer ID signed + notarized builds support native Squirrel auto-install.
 */
function canAutoInstall(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'darwin') {
    return inspectMacCodeSignature().codeSigned
  }
  return true
}

function hasAppUpdateConfig(): boolean {
  try {
    return existsSync(join(process.resourcesPath, 'app-update.yml'))
  } catch {
    return false
  }
}

function normalizeSemver(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]!
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0)
}

function isNewerVersion(remote: string, current: string): boolean {
  const r = normalizeSemver(remote)
  const c = normalizeSemver(current)
  const len = Math.max(r.length, c.length, 3)
  for (let i = 0; i < len; i++) {
    const rv = r[i] ?? 0
    const cv = c[i] ?? 0
    if (rv > cv) return true
    if (rv < cv) return false
  }
  return false
}

function releaseUrl(version?: string): string {
  const clean = version?.replace(/^v/i, '')
  return clean
    ? `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/v${clean}`
    : RELEASES_LATEST
}

function broadcast(event: UpdateStatusEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(UPDATE_CHANNELS.event, event)
  }
}

function openReleasePage(version?: string): void {
  void shell.openExternal(releaseUrl(version ?? latestVersionTag ?? lastInfo?.version))
}

async function checkViaGitHubApi(attempt: UpdateCheck): Promise<void> {
  const currentVersion = app.getVersion()
  try {
    const res = await fetch(GITHUB_API_LATEST, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `BotArk/${currentVersion}`
      },
      signal: AbortSignal.timeout(12_000)
    })
    const data: unknown = res.ok ? await res.json().catch(() => null) : null
    const outcome = interpretLatestRelease(res, data, currentVersion, isNewerVersion)
    if (outcome.type === 'available') {
      latestVersionTag = outcome.version
      broadcast({ type: 'available', version: outcome.version, releaseNotes: outcome.releaseNotes, manualInstall: true })
    } else if (attempt.manual) {
      broadcast(outcome.type === 'error' ? { type: 'error', message: outcome.message } : { type: 'not-available', version: currentVersion })
    }
  } catch (error) {
    if (attempt.manual) broadcast({ type: 'error', message: checkFailedMessage(error) })
  }
}

function configure(): void {
  const auto = canAutoInstall() && hasAppUpdateConfig()
  autoUpdater.autoDownload = auto
  autoUpdater.autoInstallOnAppQuit = auto
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = null

  autoUpdater.on('update-available', (info) => {
    lastInfo = info
    latestVersionTag = info.version
    downloaded = false
    broadcast({
      type: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      manualInstall: !auto
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    broadcast({
      type: 'downloading',
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    lastInfo = info
    latestVersionTag = info.version
    downloaded = true
    broadcast({
      type: 'downloaded',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
    })
  })

  autoUpdater.on('error', (error) => {
    const raw = error?.message || String(error)
    if (SIGNING_ERROR.test(raw)) {
      downloaded = false
      broadcast({
        type: 'available',
        version: latestVersionTag ?? lastInfo?.version ?? app.getVersion(),
        manualInstall: true
      })
    }
  })
}

async function runCheck(attempt: UpdateCheck): Promise<void> {
  if (canAutoInstall() && hasAppUpdateConfig()) {
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result) {
        if (!result.isUpdateAvailable && attempt.manual) {
          broadcast({ type: 'not-available', version: result.updateInfo.version || app.getVersion() })
        }
        void result.downloadPromise?.catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          if (attempt.manual && !SIGNING_ERROR.test(message)) broadcast({ type: 'error', message })
        })
        return
      }
    } catch {
      // A missing or unreadable native update manifest falls back to GitHub.
    }
  }
  await checkViaGitHubApi(attempt)
}

function check(manual = false): Promise<void> {
  if (activeCheck) {
    if (manual && !activeCheck.manual) {
      activeCheck.manual = true
      broadcast({ type: 'checking' })
    }
    return activeCheck.done
  }
  const attempt: UpdateCheck = {
    manual,
    done: Promise.resolve().then(() => runCheck(attempt)).finally(() => { activeCheck = undefined })
  }
  activeCheck = attempt
  if (manual) broadcast({ type: 'checking' })
  return attempt.done
}

function installOrOpenRelease(): void {
  if (canAutoInstall() && downloaded) {
    autoUpdater.quitAndInstall(false, true)
    return
  }
  openReleasePage(latestVersionTag ?? lastInfo?.version)
}

export function registerUpdaterIpc(): void {
  ipcMain.handle(UPDATE_CHANNELS.check, async () => {
    await check(true)
    return { ok: true as const }
  })
  ipcMain.handle(UPDATE_CHANNELS.install, async () => {
    installOrOpenRelease()
    return { ok: true as const }
  })
  ipcMain.handle(UPDATE_CHANNELS.version, () => app.getVersion())
}

export function startAutoUpdater(): void {
  if (started) return
  started = true
  configure()

  // Delay first background check so the window can load.
  setTimeout(() => {
    void check(false)
  }, 8_000)

  setInterval(() => {
    void check(false)
  }, CHECK_INTERVAL_MS)
}
