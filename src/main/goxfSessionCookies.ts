/**
 * GOXF fork only: keep session cookies across restarts (idea from stablyai/orca).
 *
 * Electron never writes cookies without an expiry to a partition's cookie DB,
 * so a site that signs in with one is signed out on every restart. For each
 * account partition we save those cookies (encrypted with safeStorage) a few
 * seconds after they change and put them back before the main window opens.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage, session, type Session } from 'electron'
import { accountPartitionName, sessionOnly, toSetDetails, type SavedCookie } from './goxfSessionCookieLogic'

const SAVE_DELAY_MS = 5_000
const tracked = new WeakMap<Session, Promise<void>>()
const live = new Map<string, Session>()

const storeDir = (): string => join(app.getPath('userData'), 'goxf-session-cookies')
const storeFile = (name: string): string => join(storeDir(), `${name}.bin`)

function read(name: string): SavedCookie[] {
  try {
    if (!safeStorage.isEncryptionAvailable() || !existsSync(storeFile(name))) return []
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(storeFile(name)))) as unknown
    return Array.isArray(parsed) ? (parsed as SavedCookie[]) : []
  } catch {
    return []
  }
}

async function save(ses: Session, name: string): Promise<void> {
  // Never write cookies in plain text.
  if (!safeStorage.isEncryptionAvailable()) return
  const cookies = sessionOnly((await ses.cookies.get({})) as SavedCookie[])
  mkdirSync(storeDir(), { recursive: true })
  writeFileSync(storeFile(name), safeStorage.encryptString(JSON.stringify(cookies)))
}

async function restore(ses: Session, name: string): Promise<void> {
  const live = new Set((await ses.cookies.get({})).map((c) => `${c.domain}|${c.path}|${c.name}`))
  for (const c of read(name)) {
    if (live.has(`${c.domain}|${c.path}|${c.name}`)) continue
    await ses.cookies.set(toSetDetails(c)).catch(() => undefined)
  }
}

/** Same promise for every caller, so startup can await a restore that session-created began. */
function track(ses: Session): Promise<void> {
  const name = accountPartitionName(ses.storagePath)
  if (!name) return Promise.resolve()
  let pending = tracked.get(ses)
  if (!pending) {
    pending = begin(ses, name)
    tracked.set(ses, pending)
  }
  return pending
}

async function begin(ses: Session, name: string): Promise<void> {
  live.set(name, ses)
  await restore(ses, name).catch(() => undefined)
  let timer: NodeJS.Timeout | null = null
  ses.cookies.on('changed', (_event, cookie) => {
    if (!cookie.session) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void save(ses, name).catch(() => undefined), SAVE_DELAY_MS)
  })
}

/** Call after app ready, before the main window: restores every account partition on disk. */
export async function startSessionCookiePersistence(): Promise<void> {
  app.on('session-created', (ses) => void track(ses))
  const partitionsDir = join(app.getPath('userData'), 'Partitions')
  const names = existsSync(partitionsDir) ? readdirSync(partitionsDir) : []
  await Promise.all(
    names.filter((n) => accountPartitionName(n)).map((n) => track(session.fromPartition(`persist:${n}`)))
  )
}

/** Before quitting for an update: write pending session cookies and flush every cookie store. */
export async function flushSessionCookies(): Promise<void> {
  await Promise.all(
    [...live].map(([name, ses]) =>
      Promise.all([save(ses, name), ses.cookies.flushStore()]).catch(() => undefined)
    )
  )
  await session.defaultSession.cookies.flushStore().catch(() => undefined)
}
