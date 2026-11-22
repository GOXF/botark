/**
 * GOXF fork only: portable mode.
 *
 * electron-builder's portable launcher extracts the app to a temp dir and sets
 *   PORTABLE_EXECUTABLE_DIR  = folder holding the portable .exe
 *   PORTABLE_EXECUTABLE_FILE = full path of the portable .exe
 * When present, keep all data (accounts, sessions, persist: partitions) in
 * <exe dir>/BotArk-Data so it travels with the exe.
 *
 * Imported FIRST in src/main/index.ts so it runs before any module touches
 * userData and before app ready (setPath after ready does not move sessions).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export const PORTABLE_DIR = (process.env.PORTABLE_EXECUTABLE_DIR || '').trim() || null
export const PORTABLE_FILE = (process.env.PORTABLE_EXECUTABLE_FILE || '').trim() || null
export const PORTABLE_DATA_DIR = PORTABLE_DIR ? join(PORTABLE_DIR, 'BotArk-Data') : null

export function isPortable(): boolean {
  return PORTABLE_DIR !== null
}

if (PORTABLE_DATA_DIR) {
  try {
    mkdirSync(PORTABLE_DATA_DIR, { recursive: true })
    app.setPath('userData', PORTABLE_DATA_DIR)
    // Session data (cookies, IndexedDB, Partitions/<persist:name>) defaults to
    // userData; pin it explicitly so every persist: partition lands here too.
    app.setPath('sessionData', PORTABLE_DATA_DIR)
  } catch (error) {
    console.error('[goxf] portable data dir unavailable, using default userData:', error)
  }
}
