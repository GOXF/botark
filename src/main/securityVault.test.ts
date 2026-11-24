import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { VAULT_CHANNELS } from '@shared/ipc'

const dir = mkdtempSync(join(tmpdir(), 'bothub-vault-'))
let encryptionAvailable = true
let useFixedKey = false

const encrypt = vi.fn(async (plain: string): Promise<Buffer> => Buffer.from(`enc:${plain}`, 'utf8'))
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: {
    getPath: () => dir,
    isPackaged: false
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler)
  },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    isAsyncEncryptionAvailable: async () => encryptionAvailable,
    getSelectedStorageBackend: () => useFixedKey ? 'basic_text' : 'gnome_libsecret',
    encryptStringAsync: encrypt,
    decryptStringAsync: async (buf: Buffer) => {
      const str = buf.toString('utf8')
      if (!str.startsWith('enc:')) throw new Error('corrupt ciphertext')
      return { result: str.slice(4), shouldReEncrypt: false }
    }
  },
  session: {
    fromPartition: () => ({ setProxy: vi.fn(async () => undefined) })
  }
}))

vi.mock('./webContentsViewManager', () => ({
  partitionForAccount: (id: string) => `persist:bothub-account-${id}`
}))

const {
  clearAllVaultSecrets,
  deleteVaultSecret,
  getSecurityVaultStatus,
  getVaultSecret,
  hardenVaultFilePermissions,
  registerVaultIpc,
  setVaultSecret
} = await import('./securityVault')
registerVaultIpc()

afterAll(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(async () => {
  encryptionAvailable = true
  useFixedKey = false
  encrypt.mockClear()
  await clearAllVaultSecrets()
})

describe('securityVault', () => {
  it('encrypts secrets via safeStorage with 0600 permissions and never writes plaintext', async () => {
    const secret = 'sensitive-dot-memory-snapshot-markdown'
    const res = await setVaultSecret('dot.memory.draft', secret)
    expect(res.ok).toBe(true)
    expect(res.encrypted).toBe(true)

    const diskRaw = readFileSync(join(dir, 'bothub-vault.json'), 'utf8')
    expect(diskRaw).not.toContain(secret)

    if (process.platform !== 'win32') {
      const mode = statSync(join(dir, 'bothub-vault.json')).mode & 0o777
      expect(mode).toBe(0o600)
    }

    await expect(getVaultSecret('dot.memory.draft')).resolves.toBe(secret)
    await deleteVaultSecret('dot.memory.draft')
    await expect(getVaultSecret('dot.memory.draft')).resolves.toBeNull()
  })

  it('fails closed when safeStorage is unavailable', async () => {
    encryptionAvailable = false
    await expect(setVaultSecret('dot.memory.draft', 'secret')).rejects.toThrow(/safeStorage/)
  })

  it('reports the Linux fixed-key fallback as unavailable and refuses to store secrets with it', async () => {
    const path = join(dir, 'bothub-vault.json')
    writeFileSync(path, JSON.stringify({ 'legacy.secret': { enc: Buffer.from('enc:saved').toString('base64'), updatedAtMs: 1 } }))
    useFixedKey = true
    expect((await getSecurityVaultStatus()).keychainAvailable).toBe(false)
    await expect(setVaultSecret('dot.memory.draft', 'secret')).rejects.toThrow(/safeStorage/)
    expect(encrypt).not.toHaveBeenCalled()
    await expect(getVaultSecret('legacy.secret')).resolves.toBe('saved')
  })

  it('clears only public keys through renderer IPC', async () => {
    await setVaultSecret('internal.slack.tokens', 'private')
    await setVaultSecret('dot.memory.draft', 'public')

    await expect(handlers.get(VAULT_CHANNELS.clearAll)!(undefined)).resolves.toEqual({ ok: true })
    await expect(getVaultSecret('dot.memory.draft')).resolves.toBeNull()
    await expect(getVaultSecret('internal.slack.tokens')).resolves.toBe('private')
    await expect(handlers.get(VAULT_CHANNELS.deleteSecret)!(undefined, ' internal.slack.tokens ')).rejects.toThrow('Private vault key')

    await clearAllVaultSecrets()
    await expect(getVaultSecret('internal.slack.tokens')).resolves.toBeNull()
  })

  it('serializes set, delete and clear before starting asynchronous encryption', async () => {
    let resolveFirst!: (value: Buffer) => void
    const first = new Promise<Buffer>((resolve) => { resolveFirst = resolve })
    encrypt.mockImplementationOnce(() => first)
    const set = setVaultSecret('pending.secret', 'first')
    const del = deleteVaultSecret('pending.secret')
    const clear = handlers.get(VAULT_CHANNELS.clearAll)!(undefined)
    const replace = setVaultSecret('pending.secret', 'latest')
    try {
      await vi.waitFor(() => expect(encrypt).toHaveBeenCalledWith('first'))
      expect(encrypt).toHaveBeenCalledTimes(1)
    } finally {
      resolveFirst(Buffer.from('enc:first'))
      await Promise.all([set, del, clear, replace])
    }
    await expect(getVaultSecret('pending.secret')).resolves.toBe('latest')
  })

  it('rejects unsafe vault keys', async () => {
    await expect(setVaultSecret('../escape', 'x')).rejects.toBeInstanceOf(TypeError)
  })

  it('audits and repairs loose file permissions to 0600', async () => {
    const looseFile = join(dir, 'dot-accounts.json')
    writeFileSync(looseFile, JSON.stringify({ acc_1: { encTokens: 'abc' } }), { mode: 0o644 })
    if (process.platform !== 'win32') {
      chmodSync(looseFile, 0o644)
      const before = await getSecurityVaultStatus({ accountId: 'acc_1', platformId: 'dot' })
      const dotStore = before.stores.find((s) => s.id === 'dot-tokens')
      expect(dotStore?.ownerOnly).toBe(false)

      const repaired = hardenVaultFilePermissions()
      expect(repaired).toBeGreaterThanOrEqual(1)

      const after = await getSecurityVaultStatus({ accountId: 'acc_1', platformId: 'dot' })
      expect(after.stores.find((s) => s.id === 'dot-tokens')?.ownerOnly).toBe(true)
      expect(after.accountAudit?.partition).toBe('persist:bothub-account-acc_1')
      expect(after.accountAudit?.failClosedGuard).toBe(true)
    }
  })
})
