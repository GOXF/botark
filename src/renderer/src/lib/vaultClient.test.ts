import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotHubBridge } from '@shared/bridge'
import { clearVaultCredentials, loadDotMemoryDraft, saveDotMemoryDraft } from './vaultClient'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('vaultClient', () => {
  const originalWindow = globalThis.window
  let localStore: Record<string, string>
  let vaultStore: Record<string, string>
  const setSecret = vi.fn(async (key: string, value: string) => {
    vaultStore[key] = value
    return { ok: true, encrypted: true }
  })
  const deleteSecret = vi.fn(async (key: string) => {
    delete vaultStore[key]
    return { ok: true as const }
  })
  const clearAll = vi.fn(async () => {
    vaultStore = {}
    return { ok: true as const }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStore = {}
    vaultStore = {}
    ;(globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: vi.fn((k: string) => (k in localStore ? localStore[k]! : null)),
        setItem: vi.fn((k: string, v: string) => {
          localStore[k] = v
        }),
        removeItem: vi.fn((k: string) => {
          delete localStore[k]
        })
      },
      electron: {
        vault: {
          getSecret: vi.fn(async (k: string) => vaultStore[k] ?? null),
          setSecret,
          deleteSecret,
          clearAll,
          status: vi.fn(),
          hardenPermissions: vi.fn()
        }
      }
    }
  })

  afterEach(() => {
    ;(globalThis as unknown as { window: unknown }).window = originalWindow
  })

  it('migrates legacy plaintext localStorage Dot memory snapshot into encrypted vault and purges localStorage', async () => {
    localStore['bothub.dot.memorySnapshot'] = '# Secret Memory\n- Project codename Aurora'

    const loaded = await loadDotMemoryDraft()
    expect(loaded).toBe('# Secret Memory\n- Project codename Aurora')
    expect(vaultStore['dot.memory.snapshot.v1']).toBe('# Secret Memory\n- Project codename Aurora')
    expect(localStore['bothub.dot.memorySnapshot']).toBeUndefined()
  })

  it('saves and deletes Dot memory drafts strictly inside the encrypted vault without touching localStorage', async () => {
    const ok = await saveDotMemoryDraft('## Updated Memory')
    expect(ok).toBe(true)
    expect(vaultStore['dot.memory.snapshot.v1']).toBe('## Updated Memory')
    expect(localStore['bothub.dot.memorySnapshot']).toBeUndefined()

    await saveDotMemoryDraft('   ')
    expect(vaultStore['dot.memory.snapshot.v1']).toBeUndefined()
  })

  it('deletes a draft after a slow write has finished', async () => {
    const writeStarted = deferred()
    const finishWrite = deferred()
    setSecret.mockImplementationOnce(async (key, value) => {
      writeStarted.resolve()
      await finishWrite.promise
      vaultStore[key] = value
      return { ok: true, encrypted: true }
    })

    const write = saveDotMemoryDraft('Old draft')
    await writeStarted.promise
    const clear = saveDotMemoryDraft('')
    await Promise.resolve()
    expect(deleteSecret).not.toHaveBeenCalled()
    finishWrite.resolve()

    await expect(Promise.all([write, clear])).resolves.toEqual([true, true])
    expect(vaultStore['dot.memory.snapshot.v1']).toBeUndefined()
    await expect(loadDotMemoryDraft()).resolves.toBe('')
  })

  it('keeps newer edits in submission order after a rejected write', async () => {
    setSecret.mockRejectedValueOnce(new Error('Vault write failed'))

    await expect(Promise.all([
      saveDotMemoryDraft('First draft'),
      saveDotMemoryDraft(''),
      saveDotMemoryDraft('New draft')
    ])).resolves.toEqual([false, true, true])

    expect(deleteSecret).toHaveBeenCalledOnce()
    expect(vaultStore['dot.memory.snapshot.v1']).toBe('New draft')
  })

  it('waits for plaintext migration before purging the vault and clears the in-memory draft', async () => {
    localStore['bothub.dot.memorySnapshot'] = 'Legacy draft'
    const migrationStarted = deferred()
    const finishMigration = deferred()
    setSecret.mockImplementationOnce(async (key, value) => {
      migrationStarted.resolve()
      await finishMigration.promise
      vaultStore[key] = value
      return { ok: true, encrypted: true }
    })

    const migration = loadDotMemoryDraft()
    await migrationStarted.promise
    const purge = clearVaultCredentials()
    await Promise.resolve()
    expect(clearAll).not.toHaveBeenCalled()
    finishMigration.resolve()
    await Promise.all([migration, purge])

    expect(vaultStore).toEqual({})
    ;(globalThis.window as { electron?: BotHubBridge }).electron = undefined
    await expect(loadDotMemoryDraft()).resolves.toBe('')
  })

  it('reports a failed vault purge', async () => {
    localStore['bothub.dot.memorySnapshot'] = 'Legacy draft'
    clearAll.mockRejectedValueOnce(new Error('Vault is read-only'))

    await expect(clearVaultCredentials()).rejects.toThrow('Vault is read-only')
    expect(localStore['bothub.dot.memorySnapshot']).toBeUndefined()
  })
})
