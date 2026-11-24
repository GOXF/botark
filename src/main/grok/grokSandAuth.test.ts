import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { encrypt, decrypt } = vi.hoisted(() => ({
  encrypt: vi.fn(async (s: string) => Buffer.from(s, 'utf8')),
  decrypt: vi.fn(async (b: Buffer) => ({ result: b.toString('utf8'), shouldReEncrypt: false }))
}))
const directory = mkdtempSync(join(tmpdir(), 'botark-grok-credentials-'))
const storePath = join(directory, 'grok-sand-tokens.json')

vi.mock('electron', () => ({
  app: { getPath: () => directory, isReady: () => false },
  BrowserWindow: class {},
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: encrypt,
    decryptStringAsync: decrypt
  }
}))

import {
  clearGrokCredentials,
  createSandPollWake,
  extractAccountHandleFromJwt,
  forceRefreshSandAccessToken,
  grokCredentialRevision,
  loadGrokCredential,
  parseAnyGrokCredentialInput,
  parseWorkosCookieOrToken,
  pollSandAuth,
  replaceGrokCredentials
} from './grokSandAuth'
import { ensureGrokAccountWatch, getGrokAccountWatch } from './grokWatchManager'
import type { GrokConnectClient } from './connectClient'

beforeEach(async () => {
  await clearGrokCredentials('*')
  vi.clearAllMocks()
})
afterAll(async () => {
  await clearGrokCredentials('*')
  rmSync(directory, { recursive: true, force: true })
})

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature_padding_value_for_valid_length_12345`
}

describe('grokSandAuth universal credential parser & wakeable poll', () => {
  it('extracts email handle from JWT payload', () => {
    const jwt = fakeJwt({ sub: 'auth0|user_123', email: 'alice@example.com', exp: 1999999999 })
    expect(extractAccountHandleFromJwt(jwt)).toBe('alice@example.com')
  })

  it('parses URL-encoded WorkosCursorSessionToken inside a full Cookie header', () => {
    const jwt = fakeJwt({ sub: 'user_01ABC', email: 'grok@x.ai' })
    const cookieHeader = `Cookie: theme=dark; WorkosCursorSessionToken=user_01ABC%3A%3A${jwt}; other=1`
    const parsed = parseWorkosCookieOrToken(cookieHeader)
    expect(parsed).toEqual({
      accessToken: jwt,
      accountSlot: 'grok@x.ai'
    })
  })

  it('parses xAI OAuth JSON and Cursor JSON via parseAnyGrokCredentialInput', async () => {
    const xaiJwt = fakeJwt({ sub: 'xai_u_99', email: 'elon@x.ai', client_id: 'xai_client_1' })
    const res = await parseAnyGrokCredentialInput(
      JSON.stringify({
        xaiAccessToken: xaiJwt,
        xaiRefreshToken: 'xai_rt_secret',
        xaiAccessTokenExpiresAt: 1999999999,
        xaiIssuer: 'https://auth.grok.com'
      })
    )
    expect(res).toMatchObject({
      accessToken: xaiJwt,
      refreshToken: 'xai_rt_secret',
      authId: 'elon@x.ai',
      xaiIssuer: 'https://auth.grok.com',
      authKind: 'xai'
    })
  })

  it('exchanges a Cursor/Grok API key when non-JWT credential is provided', async () => {
    const jwt = fakeJwt({ sub: 'user_api_1', email: 'dev@cursor.com' })
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ accessToken: jwt, refreshToken: 'rt_from_key' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
    const res = await parseAnyGrokCredentialInput('key_live_1234567890', {
      fetchImpl: mockFetch as unknown as typeof fetch
    })
    expect(mockFetch).toHaveBeenCalledOnce()
    expect(res).toMatchObject({
      accessToken: jwt,
      refreshToken: 'rt_from_key',
      authId: 'dev@cursor.com'
    })
  })

  it('wakes pollSandAuth immediately without waiting for backoff timer', async () => {
    const jwt = fakeJwt({ sub: 'user_wake', email: 'fast@grok.com' })
    const wake = createSandPollWake()
    let calls = 0
    const start = Date.now()
    const mockFetch = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        setTimeout(() => wake.wake(), 10)
        return new Response('not ready', { status: 404 })
      }
      return new Response(
        JSON.stringify({ accessToken: jwt, refreshToken: 'rt_wake' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const tokens = await pollSandAuth('uuid-1', 'verifier-1', {
      fetchImpl: mockFetch as unknown as typeof fetch,
      wake
    })
    expect(tokens.accessToken).toBe(jwt)
    expect(tokens.authId).toBe('fast@grok.com')
    expect(Date.now() - start).toBeLessThan(400)
  })
})

const identity = { iss: 'https://fixture.example', sub: 'original' }
const original = { accessToken: fakeJwt(identity), refreshToken: 'refresh-original', selectedTeamId: 'team-original' }

it('inherits refresh credentials and team only for an exact issuer and subject match', async () => {
  const matching = fakeJwt({ ...identity, email: 'new-handle@example.test' })
  await expect(parseAnyGrokCredentialInput(matching, { existing: original })).resolves.toMatchObject({
    refreshToken: original.refreshToken, selectedTeamId: original.selectedTeamId
  })
  for (const accessToken of [fakeJwt({ ...identity, sub: 'replacement' }),
    fakeJwt({ ...identity, iss: 'https://other.example' }), fakeJwt({ sub: identity.sub })]) {
    const result = await parseAnyGrokCredentialInput(accessToken, { existing: original })
    expect(result?.refreshToken).toBeUndefined()
    expect(result?.selectedTeamId).toBeUndefined()
  }
})

it.each(['sign-out', 'replacement', 'replacement after refresh rejection'] as const)('keeps a late refresh from undoing %s', async (operation) => {
  await replaceGrokCredentials('account', () => original)
  let respond!: (value: Response) => void
  const fetcher = vi.fn<typeof fetch>(() => new Promise((resolve) => { respond = resolve }))
  const refresh = forceRefreshSandAccessToken('account', fetcher)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  const replacement = { accessToken: fakeJwt({ ...identity, sub: 'replacement' }) }
  if (operation === 'sign-out') await clearGrokCredentials('account')
  else await replaceGrokCredentials('account', () => replacement)
  respond(operation === 'replacement after refresh rejection' ? new Response(null, { status: 401 }) : Response.json({
    access_token: fakeJwt({ ...identity, refreshed: true }), refresh_token: 'old-rotated'
  }))
  await expect(refresh).resolves.toBeUndefined()
  const stored = await loadGrokCredential('account')
  if (operation === 'sign-out') {
    expect(stored).toBeUndefined()
    expect(JSON.parse(readFileSync(storePath, 'utf8'))).toEqual({})
  } else expect(stored?.tokens).toEqual(replacement)
})

it('serializes legacy migration, re-encryption, and a replacement against the same file', async () => {
  writeFileSync(storePath, JSON.stringify({
    legacy: { plain: true, enc: Buffer.from(JSON.stringify(original)).toString('base64') },
    encrypted: { enc: Buffer.from(JSON.stringify(original)).toString('base64') }
  }))
  decrypt.mockResolvedValueOnce({ result: JSON.stringify(original), shouldReEncrypt: true })
  let finish!: () => void
  encrypt.mockImplementationOnce((payload) => new Promise((resolve) => { finish = () => resolve(Buffer.from(payload)) }))
  const migrating = loadGrokCredential('legacy')
  await vi.waitFor(() => expect(encrypt).toHaveBeenCalledOnce())
  const reencrypting = loadGrokCredential('encrypted')
  const newCredential = replaceGrokCredentials('new-account', () => ({ accessToken: 'replacement' }))
  finish()
  await Promise.all([migrating, reencrypting, newCredential])
  expect(encrypt).toHaveBeenCalledTimes(3)
  const disk = JSON.parse(readFileSync(storePath, 'utf8'))
  expect(Object.keys(disk).sort()).toEqual(['encrypted', 'legacy', 'new-account'])
  expect(disk.legacy.plain).toBeUndefined()
})

it('invalidates a pending login revision on sign-out and restarts an existing watch on identity change', async () => {
  await replaceGrokCredentials('account', () => original)
  const watchTranscripts = vi.fn(async function* (_params: unknown, signal?: AbortSignal) {
    yield { ping: {} }
    await new Promise<void>((resolve) => {
      if (signal?.aborted) resolve()
      else signal?.addEventListener('abort', () => resolve(), { once: true })
    })
  })
  const watch = ensureGrokAccountWatch({ accountId: 'account', emit: vi.fn(),
    createClient: async () => ({ watchTranscripts }) as unknown as GrokConnectClient })
  await vi.waitFor(() => expect(watchTranscripts).toHaveBeenCalledOnce())
  await replaceGrokCredentials('account', () => ({ accessToken: fakeJwt({ ...identity, sub: 'other' }) }))
  await vi.waitFor(() => expect(watchTranscripts).toHaveBeenCalledTimes(2))
  expect(watchTranscripts.mock.calls[0]?.[1]?.aborted).toBe(true)
  expect(getGrokAccountWatch('account')).not.toBe(watch)
  const oldRevision = grokCredentialRevision('account')
  await clearGrokCredentials('account')
  await expect(replaceGrokCredentials('account', () => original, { expectedRevision: oldRevision })).resolves.toBeNull()
})
