import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonStoreReadError, readJsonFile, writeJsonAtomic, writeJsonAtomicAsync } from './jsonFile'

vi.mock('node:fs/promises', async (load) => {
  const fs = await load<typeof import('node:fs/promises')>()
  return { ...fs, rename: vi.fn(fs.rename) }
})

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bothub-json-'))
})
afterEach(() => {
  vi.mocked(rename).mockClear()
  rmSync(dir, { recursive: true, force: true })
})

const isObject = (raw: unknown) => Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)

describe('jsonFile', () => {
  it('round-trips and leaves no temp file', () => {
    const p = join(dir, 'nested', 'store.json')
    writeJsonAtomic(p, { a: 1 })
    expect(readJsonFile(p, {}, isObject)).toEqual({ a: 1 })
    expect(readdirSync(join(dir, 'nested'))).toEqual(['store.json'])
  })

  it('backs off asynchronously on a transient rename failure', async () => {
    const p = join(dir, 'store.json')
    writeJsonAtomic(p, { previous: true })
    let attempted!: () => void
    const firstAttempt = new Promise<void>((resolve) => { attempted = resolve })
    vi.mocked(rename).mockImplementationOnce(async () => {
      attempted()
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })
    const write = writeJsonAtomicAsync(p, { next: true })
    await firstAttempt
    expect(readJsonFile(p, {}, isObject)).toEqual({ previous: true })
    await write
    expect(rename).toHaveBeenCalledTimes(2)
    expect(readJsonFile(p, {}, isObject)).toEqual({ next: true })
    expect(readdirSync(dir)).toEqual(['store.json'])
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  it('cleans up the temporary file after a permanent rename error', async () => {
    const p = join(dir, 'store.json')
    mkdirSync(p)
    expect(() => writeJsonAtomic(p, { a: 1 })).toThrow()
    await expect(writeJsonAtomicAsync(p, { a: 2 })).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['store.json'])
  })

  it('moves a corrupt file aside instead of losing it', () => {
    const p = join(dir, 'store.json')
    writeFileSync(p, '{"a":')
    expect(readJsonFile(p, { empty: true }, isObject)).toEqual({ empty: true })
    const kept = readdirSync(dir).find((f) => f.startsWith('store.json.corrupt-'))
    expect(kept).toBeDefined()
    expect(readFileSync(join(dir, kept!), 'utf8')).toBe('{"a":')
  })

  it('moves a wrong-shaped file aside before falling back', () => {
    const p = join(dir, 'store.json')
    writeJsonAtomic(p, [1, 2])
    expect(readJsonFile(p, {}, isObject)).toEqual({})
    expect(readdirSync(dir).some((f) => f.startsWith('store.json.corrupt-'))).toBe(true)
  })
  it('throws (and keeps the file) when it cannot be read right now', () => {
    const p = join(dir, 'store.json')
    mkdirSync(p) // EISDIR stands in for a locked file
    expect(() => readJsonFile(p, { empty: true }, isObject)).toThrow(JsonStoreReadError)
    expect(readdirSync(dir)).toEqual(['store.json'])
  })
})
