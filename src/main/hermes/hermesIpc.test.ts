import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HERMES_CHANNELS, type HermesConfigureRequest } from '@shared/ipc'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { registerHermesIpc } from './hermesIpc'
import { clearHermesAccount, getHermesAccount, getHermesAccountRevision, saveHermesAccount, updateHermesAccountModel } from './hermesStore'

const mock = vi.hoisted(() => ({
  path: '',
  encryption: true,
  fetch: vi.fn<typeof fetch>(),
  handlers: new Map<string, (event: unknown, arg: unknown) => Promise<unknown>>()
}))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (channel: string, handler: (event: unknown, arg: unknown) => Promise<unknown>) => mock.handlers.set(channel, handler) },
  app: { getPath: () => mock.path },
  safeStorage: {
    isEncryptionAvailable: () => mock.encryption,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))
vi.mock('../muse/accountProxy', () => ({ loadAccountProxyUrl: async () => undefined, loadAccountTransportProxyUrl: async () => undefined }))
vi.mock('../proxyTransport', () => ({ proxyFetch: (_proxy: unknown, ...args: Parameters<typeof fetch>) => mock.fetch(...args) }))

beforeAll(() => registerHermesIpc())
beforeEach(async () => {
  mock.path = await mkdtemp(join(tmpdir(), 'hermes-ipc-test-'))
  mock.encryption = true
  mock.fetch.mockReset()
  mock.fetch.mockImplementation(async (url) => {
    if (String(url).endsWith('/v1/models')) return Response.json({ data: [{ id: 'hermes-agent' }] })
    if (String(url).endsWith('/health')) return Response.json({ status: 'ok' })
    return new Response(null, { status: 404 })
  })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(mock.path, { recursive: true, force: true })
})

const call = (channel: string, arg: unknown) => mock.handlers.get(channel)!(null, arg)
const configure = (request: HermesConfigureRequest) => call(HERMES_CHANNELS.configure, request)

it('does not send the local key to a different detection or configuration origin', async () => {
  vi.stubEnv('HERMES_HOME', mock.path)
  await writeFile(join(mock.path, '.env'), 'API_SERVER_HOST=gateway.local\nAPI_SERVER_PORT=8642\nAPI_SERVER_KEY=local-fixture')
  const localUrl = 'http://gateway.local:8642'
  const otherUrl = 'https://other.example'
  expect(await call(HERMES_CHANNELS.detectLocal, localUrl)).toMatchObject({ hasLocalEnvKey: true })
  expect(await call(HERMES_CHANNELS.detectLocal, otherUrl)).toMatchObject({ hasLocalEnvKey: false })
  await configure({ accountId: 'first', baseUrl: otherUrl, useLocalKey: true })
  expect(getHermesAccount('first')?.hasApiKey).toBe(false)
  const requests = mock.fetch.mock.calls.map(([url, init]) => ({
    url: String(url), key: new Headers(init?.headers).get('authorization'), redirect: init?.redirect
  }))
  expect(requests.filter(({ url }) => url.startsWith(otherUrl)).every(({ key }) => key === null)).toBe(true)
  expect(requests).toContainEqual({ url: localUrl + '/v1/models', key: 'Bearer local-fixture', redirect: 'error' })
})

it('reuses a blank saved key only at the original origin', async () => {
  const accountId = 'saved'
  await configure({ accountId, baseUrl: 'https://gateway.example/p/first', apiKey: 'old-key' })
  await configure({ accountId, baseUrl: 'https://gateway.example/p/second', keepExistingKey: true })
  expect(getHermesAccount(accountId)?.apiKey).toBe('old-key')
  await configure({ accountId, baseUrl: 'https://other.example', keepExistingKey: true })
  expect(getHermesAccount(accountId)?.hasApiKey).toBe(false)
  expect(mock.fetch.mock.calls.filter(([url]) => String(url).startsWith('https://other.example'))
    .every(([, init]) => !new Headers(init?.headers).has('authorization'))).toBe(true)
})

it('rejects a verified configure if the account was cleared during the probe', async () => {
  let completeProbe!: (res: Response) => void
  mock.fetch.mockImplementationOnce(() => new Promise((resolve) => { completeProbe = resolve }))
  const accountId = 'stale-config'
  const result = configure({ accountId, baseUrl: 'https://gateway.example', apiKey: 'fixture' })
  const outcome = result.catch((error: unknown) => error)
  await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalledOnce())
  await clearHermesAccount(accountId)
  completeProbe(Response.json({ status: 'ok' }))
  expect(await outcome).toMatchObject({ message: expect.stringContaining('配置已更改') })
  expect(getHermesAccount(accountId)).toBeNull()
})

it('returns saved model metadata even when the keychain cannot decrypt the existing key', async () => {
  const accountId = 'model'
  await saveHermesAccount({
    accountId, baseUrl: 'https://gateway.example', apiKey: 'key', expectedRevision: getHermesAccountRevision(accountId)
  })
  mock.encryption = false
  await expect(updateHermesAccountModel(accountId, 'saved-model')).resolves.toMatchObject({ model: 'saved-model', hasApiKey: true })
  expect(await call(HERMES_CHANNELS.listAccounts, null)).toContainEqual(expect.objectContaining({ accountId, model: 'saved-model' }))
})
