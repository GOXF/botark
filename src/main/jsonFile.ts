import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

/**
 * Write JSON via a temp file + rename so a crash mid-write cannot leave a
 * truncated file behind (which used to read back as `{}` and then be
 * overwritten, losing every entry).
 */
export function writeJsonAtomic(path: string, data: unknown, mode = 0o600): void {
  const payload = JSON.stringify(data, null, 2)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, payload, { encoding: 'utf8', mode, flag: 'wx' })
    try {
      chmodSync(tmp, mode)
    } catch {
      /* Windows / unsupported fs */
    }
    try {
      renameSync(tmp, path)
    } catch (error) {
      if (!isTransientRenameError(error)) throw error
      renameSync(tmp, path)
    }
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* best effort */
    }
    throw error
  }
}

/** Retry transient file locks without blocking the main thread. */
export async function writeJsonAtomicAsync(path: string, data: unknown, mode = 0o600): Promise<void> {
  const payload = JSON.stringify(data, null, 2)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, payload, { encoding: 'utf8', mode, flag: 'wx' })
    await chmod(tmp, mode).catch(() => undefined)
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, path)
        return
      } catch (error) {
        if (attempt >= 4 || !isTransientRenameError(error)) throw error
        await delay(50 * (attempt + 1))
      }
    }
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

/** The file exists but could not be read right now (locked, permissions). */
export class JsonStoreReadError extends Error {
  constructor(path: string, cause: unknown) {
    super(`Could not read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'JsonStoreReadError'
  }
}

function moveAside(path: string): void {
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`)
  } catch {
    /* best effort */
  }
}

/**
 * Read JSON. A file that does not parse or has the wrong shape is moved
 * aside (kept for recovery). A file that exists but cannot be read throws
 * JsonStoreReadError: returning the fallback there made the next
 * read-modify-write replace every entry.
 */
export function readJsonFile<T>(path: string, fallback: T, isValid: (raw: unknown) => boolean): T {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw new JsonStoreReadError(path, err)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    moveAside(path)
    return fallback
  }
  if (isValid(raw)) return raw as T
  moveAside(path)
  return fallback
}
