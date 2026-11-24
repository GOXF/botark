import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeAllLocalProxyBridges } from '../localProxyBridge'

const dir = mkdtempSync(join(tmpdir(), 'bothub-proxy-'))
const setProxy = vi.fn(async (_cfg: unknown) => undefined)
const closeAllConnections = vi.fn(async () => undefined)
/** Last proxy config applied per partition. */
const appliedByPartition = new Map<string, unknown>()
let encryptionAvailable = true

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => encryptionAvailable,
    encryptStringAsync: async (plain: string) => Buffer.from(`ok:${plain}`, 'utf8'),
    decryptStringAsync: async (buf: Buffer) => {
      const s = buf.toString('utf8')
      if (!s.startsWith('ok:')) throw new Error('bad key')
      return { result: s.slice(3), shouldReEncrypt: false }
    }
  },
  session: {
    fromPartition: (() => {
      const sessions = new Map<string, { setProxy: typeof setProxy; closeAllConnections: typeof closeAllConnections }>()
      return (partition: string) => {
        if (!sessions.has(partition))
          sessions.set(partition, {
            setProxy: (async (cfg: unknown) => {
              appliedByPartition.set(partition, cfg)
              return setProxy(cfg)
            }) as typeof setProxy,
            closeAllConnections
          })
        return sessions.get(partition)
      }
    })()
  }
}))
vi.mock('../webContentsViewManager', () => ({ partitionForAccount: (id: string) => `persist:test-${id}` }))

const {
  applyAllStoredProxies,
  applyProxyToPartition,
  assignProxyPoolToAccounts,
  buildAccountProxyUrl,
  importProxyPool,
  listProxyPool,
  loadAccountTransportProxyUrl,
  loadProxyConfig,
  parseProxyLine,
  ProxyConfigUnreadableError,
  reconcilePoolBindings,
  removeProxyPoolItem,
  saveProxyConfig,
  releaseProxyPoolAccount,
  setAccountProxy
} = await import('./accountProxy')
const { DIRECT_PROXY_URL } = await import('../proxyTransport')

const enc = (cfg: object) => Buffer.from(`ok:${JSON.stringify(cfg)}`, 'utf8').toString('base64')
const readJson = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'))

afterAll(async () => {
  await closeAllLocalProxyBridges()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  setProxy.mockClear()
  closeAllConnections.mockClear()
  encryptionAvailable = true
  writeFileSync(join(dir, 'muse-account-proxy.json'), JSON.stringify({ acc1: { enc: 'AAAA' } }))
  writeFileSync(join(dir, 'muse-proxy-pool.json'), '[]')
})

describe('account proxy fails closed', () => {
  it('does not close active connections on repeated or concurrent proxy preparation', async () => {
    const accountId = 'concurrent-hark-requests'
    await Promise.all([applyProxyToPartition(accountId), applyProxyToPartition(accountId)])
    expect(setProxy).toHaveBeenCalledTimes(1)
    expect(closeAllConnections).toHaveBeenCalledTimes(1)

    await applyProxyToPartition(accountId)
    expect(closeAllConnections).toHaveBeenCalledTimes(1)

    await applyProxyToPartition(accountId, { mode: 'socks5', host: '127.0.0.1', port: 1080 })
    expect(setProxy).toHaveBeenLastCalledWith(expect.objectContaining({ proxyRules: 'socks5://127.0.0.1:1080' }))
    expect(closeAllConnections).toHaveBeenCalledTimes(2)
  })

  it('does not report direct when a stored proxy cannot be decrypted', async () => {
    await expect(loadProxyConfig('acc1')).rejects.toBeInstanceOf(ProxyConfigUnreadableError)
    encryptionAvailable = false
    await expect(loadProxyConfig('acc1')).rejects.toBeInstanceOf(ProxyConfigUnreadableError)
  })

  it('blocks the partition instead of going direct', async () => {
    await expect(applyProxyToPartition('acc1')).rejects.toBeInstanceOf(ProxyConfigUnreadableError)
    expect(setProxy).toHaveBeenCalledWith(expect.objectContaining({ proxyRules: 'http://127.0.0.1:9' }))
  })

  it('accounts without a proxy use system network stack', async () => {
    await expect(loadProxyConfig('nobody')).resolves.toEqual({ mode: 'system' })
    await applyProxyToPartition('nobody')
    expect(setProxy).toHaveBeenCalledWith({ mode: 'system' })
  })

  it('applies every stored account at startup without throwing', async () => {
    const log = vi.fn()
    await applyAllStoredProxies(log)
    expect(setProxy.mock.calls.length).toBeGreaterThanOrEqual(1)
    for (const [cfg] of setProxy.mock.calls) expect(cfg).toMatchObject({ proxyRules: 'http://127.0.0.1:9' })
    expect(log).toHaveBeenCalledOnce()
  })
})

describe('HTTPS and authenticated proxy support', () => {
  it('preserves https:// scheme in parseProxyLine and buildAccountProxyUrl instead of turning it into http', () => {
    expect(parseProxyLine('https://alice:s3cr3t@proxy.example.com:8443')).toEqual({
      mode: 'https',
      host: 'proxy.example.com',
      port: 8443,
      username: 'alice',
      password: 's3cr3t'
    })
    expect(parseProxyLine('https://proxy.example.com')).toEqual({
      mode: 'https',
      host: 'proxy.example.com',
      port: 443,
      username: undefined,
      password: undefined
    })
    expect(parseProxyLine('https://gate.provider.com:7000:user1:pass:word')).toEqual({
      mode: 'https',
      host: 'gate.provider.com',
      port: 7000,
      username: 'user1',
      password: 'pass:word'
    })
    expect(parseProxyLine('user:p@ss%99@1.2.3.4:1080', 'socks5')).toEqual({
      mode: 'socks5',
      host: '1.2.3.4',
      port: 1080,
      username: 'user',
      password: 'p@ss%99'
    })
    expect(
      buildAccountProxyUrl({
        mode: 'https',
        host: 'proxy.example.com',
        port: 8443,
        username: 'alice',
        password: 'p@ss'
      })
    ).toBe('https://alice:p%40ss@proxy.example.com:8443')
  })

  it('auto-upgrades mode to https when a full https:// URL is saved via host field', async () => {
    const view = await saveProxyConfig('acc_https', {
      mode: 'http',
      host: 'https://u1:p1@tls-proxy.example.com:8443'
    })
    expect(view).toEqual({
      mode: 'https',
      host: 'tls-proxy.example.com',
      port: 8443,
      username: 'u1',
      hasPassword: true
    })
    // Chromium partition gets a loopback bridge URL rather than raw credentials or plain http
    expect(setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      proxyBypassRules: '<local>'
    })
    expect(closeAllConnections).toHaveBeenCalled()
  })

  it('maps unauthenticated socks5h to socks5:// for Chromium proxyRules', async () => {
    await applyProxyToPartition('acc_s5h', {
      mode: 'socks5h',
      host: '127.0.0.1',
      port: 1080
    })
    expect(setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080',
      proxyBypassRules: '<local>'
    })
  })
})

describe('network mode: 真直连 / 跟随系统 / 代理', () => {
  it('migrates an old stored "direct" to follow-system', async () => {
    writeFileSync(join(dir, 'muse-account-proxy.json'), JSON.stringify({ old: { enc: enc({ mode: 'direct' }) } }))
    await expect(loadProxyConfig('old')).resolves.toEqual({ mode: 'system' })
  })

  it('真直连 is stored unencrypted, applies mode direct, and bypasses the OS proxy in Node', async () => {
    encryptionAvailable = false // no keychain needed for direct
    await expect(saveProxyConfig('dir', { mode: 'direct' })).resolves.toEqual({ mode: 'direct', hasPassword: false })
    expect(readJson('muse-account-proxy.json').dir).toEqual({ mode: 'direct' })
    expect(appliedByPartition.get('persist:test-dir')).toEqual({ mode: 'direct' })
    await expect(loadAccountTransportProxyUrl('dir')).resolves.toBe(DIRECT_PROXY_URL)

    await saveProxyConfig('dir', { mode: 'system' })
    expect(readJson('muse-account-proxy.json').dir).toBeUndefined()
    expect(appliedByPartition.get('persist:test-dir')).toEqual({ mode: 'system' })
    await expect(loadAccountTransportProxyUrl('dir')).resolves.toBeUndefined()
  })
})

describe('pool removal reverts its accounts', () => {
  beforeEach(() => {
    writeFileSync(join(dir, 'muse-account-proxy.json'), '{}')
    writeFileSync(join(dir, 'muse-proxy-pool.json'), '[]')
  })

  it('removing a pool entry reverts auto- and manually-bound accounts to system, keeps 自定义', async () => {
    await importProxyPool('http://70.39.201.51:38080\nsocks5://9.9.9.9:1080')
    const [dead, live] = await listProxyPool()
    await assignProxyPoolToAccounts(['auto1'], undefined, undefined, 1) // auto → dead (least loaded, first)
    await setAccountProxy('manual1', { mode: 'system', poolId: dead!.id })
    await setAccountProxy('other', { mode: 'system', poolId: live!.id })
    await setAccountProxy('custom', { mode: 'http', host: '70.39.201.51', port: 38080 }) // same address, but 自定义
    expect((await listProxyPool())[0]!.assignedAccountIds).toEqual(['auto1', 'manual1'])

    const reverted: string[] = []
    await removeProxyPoolItem(dead!.id, async (id) => void reverted.push(id))
    expect(reverted.sort()).toEqual(['auto1', 'manual1'])
    for (const id of ['auto1', 'manual1']) {
      await expect(loadProxyConfig(id)).resolves.toEqual({ mode: 'system' })
      expect(appliedByPartition.get(`persist:test-${id}`)).toEqual({ mode: 'system' })
    }
    await expect(loadProxyConfig('other')).resolves.toMatchObject({ mode: 'socks5', host: '9.9.9.9' })
    await expect(loadProxyConfig('custom')).resolves.toMatchObject({ mode: 'http', host: '70.39.201.51' })
  })

  it('startup drops orphan bindings to pool entries that no longer exist and adopts legacy ones', async () => {
    await importProxyPool('socks5://9.9.9.9:1080')
    const [live] = await listProxyPool()
    writeFileSync(
      join(dir, 'muse-account-proxy.json'),
      JSON.stringify({
        orphan: { enc: enc({ mode: 'http', host: '70.39.201.51', port: 38080 }), poolId: 'px_deleted' },
        legacy: { enc: enc({ mode: 'socks5', host: '9.9.9.9', port: 1080 }) },
        custom: { enc: enc({ mode: 'http', host: '5.5.5.5', port: 8080 }) }
      })
    )
    await expect(reconcilePoolBindings()).resolves.toEqual(['orphan'])
    const store = readJson('muse-account-proxy.json')
    expect(store.orphan).toBeUndefined()
    expect(appliedByPartition.get('persist:test-orphan')).toEqual({ mode: 'system' })
    expect(store.legacy.poolId).toBe(live!.id)
    expect(store.custom.poolId).toBeUndefined()
  })
})

describe('saved credentials and pool ownership', () => {
  const original = { mode: 'http', host: 'proxy.example.com', port: 8080, username: 'alice', password: 'saved' } as const

  it('keeps a blank password only for the same normalized proxy identity', async () => {
    await saveProxyConfig('credentials', original)
    await expect(saveProxyConfig('credentials', {
      mode: 'socks5', host: ' HTTP://alice@PROXY.EXAMPLE.COM:8080 ', password: ''
    })).resolves.toMatchObject({ hasPassword: true })

    for (const change of [
      { mode: 'socks5' } as const, { host: 'other.example.com' }, { port: 8081 }, { username: 'bob' }, { username: '' }
    ]) {
      await saveProxyConfig('credentials', original)
      const view = await saveProxyConfig('credentials', { ...original, ...change, password: '' })
      expect(view.hasPassword).toBe(false)
      expect((await loadProxyConfig('credentials')).password).toBeUndefined()
    }
  })

  it('serializes release and reassignment through partition setup', async () => {
    await importProxyPool('http://proxy.example.com:8080')
    await assignProxyPoolToAccounts(['pool-owner'])
    let finishRelease!: () => void
    let enteredRelease!: () => void
    const entered = new Promise<void>((resolve) => { enteredRelease = resolve })
    setProxy.mockImplementationOnce(async () => {
      enteredRelease()
      await new Promise<void>((resolve) => { finishRelease = resolve })
    })
    const release = releaseProxyPoolAccount('pool-owner')
    await entered
    const reassign = assignProxyPoolToAccounts(['pool-owner'])
    finishRelease()
    await Promise.all([release, reassign])
    expect(await listProxyPool()).toMatchObject([{ assignedAccountIds: ['pool-owner'] }])
    expect(await loadProxyConfig('pool-owner')).toMatchObject({ host: 'proxy.example.com', port: 8080 })
    expect(setProxy).toHaveBeenLastCalledWith(expect.objectContaining({ proxyRules: 'http://proxy.example.com:8080' }))
  })

  it('releases a pool slot without deleting a newer manually saved configuration', async () => {
    await importProxyPool('http://proxy.example.com:8080')
    await assignProxyPoolToAccounts(['pool-manual'])
    await saveProxyConfig('pool-manual', { mode: 'http', host: 'manual.example.com', port: 9999 })
    await releaseProxyPoolAccount('pool-manual')
    expect((await listProxyPool())[0]?.assignedAccountIds).toEqual([])
    expect(await loadProxyConfig('pool-manual')).toMatchObject({ host: 'manual.example.com', port: 9999 })
  })
})
