import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nativeImage, type NativeImage } from 'electron'

let cachedIcon: NativeImage | string | undefined
let resolvedOnce = false

/**
 * Resolve the shared BotArk window icon (`build/icon.png`) for all Electron
 * `BrowserWindow`s (main window, platform login windows, and OAuth child popups).
 * Safely degrades to `undefined` or path string in unit/E2E mock environments.
 */
export function getAppWindowIcon(): NativeImage | string | undefined {
  if (resolvedOnce) return cachedIcon
  resolvedOnce = true

  const candidates = new Set([
    join(__dirname, '../../build/icon.png'),
    process.resourcesPath ? join(process.resourcesPath, 'app/build/icon.png') : '',
    join(process.cwd(), 'build/icon.png')
  ].filter(Boolean))

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    let imageApi: typeof nativeImage | undefined
    try {
      imageApi = nativeImage
    } catch {
      /* Electron mocks may omit nativeImage entirely. */
    }
    if (typeof imageApi?.createFromPath !== 'function') {
      cachedIcon = candidate
      return cachedIcon
    }
    try {
      const img = imageApi.createFromPath(candidate)
      if (img && typeof img.isEmpty === 'function' && !img.isEmpty()) {
        cachedIcon = img
        return cachedIcon
      }
    } catch {
      /* try the next candidate */
    }
  }

  return undefined
}
