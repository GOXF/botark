import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCueAccountAuth, loadCueTokens, parseAnyCueCredentialInput, persistCueTokens } from './cueAuth'
import { callCueApi, mapCueMembershipQuota } from './cueClient'

const fixture = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => fixture.path },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))
vi.mock('./cueDeviceId', () => ({ getOrCreateCueDeviceId: () => 'device' }))

describe('Cue multi-account credential parser & quota mapper', () => {
  it('parses all 5 supported Cue credential formats cleanly', () => {
    const apiKey = parseAnyCueCredentialInput('sk-manus-test-key-1234567890')
    expect(apiKey.authKind).toBe('api-key')
    expect(apiKey.apiKey).toBe('sk-manus-test-key-1234567890')

    const headerKey = parseAnyCueCredentialInput('x-manus-api-key: manus-secret-abcdef123456')
    expect(headerKey.authKind).toBe('api-key')
    expect(headerKey.apiKey).toBe('manus-secret-abcdef123456')

    const bearer = parseAnyCueCredentialInput(
      'Bearer eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImFsaWNlQGN1ZS5pbSIsImV4cCI6OTk5OTk5OTk5OX0.sig'
    )
    expect(bearer.authKind).toBe('oauth')
    expect(bearer.handle).toBe('alice@cue.im')

    const cookie = parseAnyCueCredentialInput('Cookie: session_id=sess_123456789; theme=dark')
    expect(cookie.authKind).toBe('session')
    expect(cookie.accessToken).toBe('sess_123456789')

    const arr = parseAnyCueCredentialInput(
      JSON.stringify([{ name: 'cue_session', value: 'cookie_val_999', domain: '.cue.im' }])
    )
    expect(arr.authKind).toBe('session')
    expect(arr.accessToken).toBe('cookie_val_999')
  })

  it('clamps over-reserved Cue membership credits to 0 and separates purchased balance', () => {
    const mapped = mapCueMembershipQuota({
      membership: { accessAllowed: true },
      limitCredits: 1000,
      usedCredits: 700,
      reservedCredits: 450,
      purchasedRemainingCredits: 500,
      windowStartMs: 100,
      windowEndMs: 200
    })
    expect(mapped.accessAllowed).toBe(true)
    expect(mapped.weeklyRemainingCredits).toBe(0)
    expect(mapped.remainingPercent).toBe(0)
    expect(mapped.purchasedRemainingCredits).toBe(500)
  })
})

describe('Cue credential revision', () => {
  beforeEach(async () => { fixture.path = await mkdtemp(join(tmpdir(), 'cue-auth-test-')) })
  afterEach(async () => {
    await clearCueAccountAuth('*')
    await rm(fixture.path, { recursive: true, force: true })
  })

  it.each(['replace', 'clear'])('does not commit a refresh after %s', async (action) => {
    const accountId = 'fixture'
    await persistCueTokens(accountId, { authKind: 'oauth', accessToken: 'old', refreshToken: 'refresh' })
    let refresh!: (res: Response) => void
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockImplementationOnce(() => new Promise((resolve) => { refresh = resolve }))
    const request = callCueApi(accountId, '/first', { fetchImpl })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    if (action === 'replace') await persistCueTokens(accountId, { authKind: 'session', accessToken: 'replacement' })
    else await clearCueAccountAuth(accountId)
    refresh(Response.json({ access_token: 'stale-refresh' }))
    expect((await request).status).toBe(401)
    expect((await loadCueTokens(accountId))?.accessToken).toBe(action === 'replace' ? 'replacement' : undefined)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('shares a refresh and retries only with credentials from the original identity', async () => {
    await persistCueTokens('fixture', { authKind: 'oauth', accessToken: 'old', refreshToken: 'refresh' })
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'new' })
      const token = new Headers(init?.headers).get('Authorization')
      return new Response(null, { status: token === 'Bearer new' ? 200 : 401 })
    })
    const results = await Promise.all([
      callCueApi('fixture', '/first', { fetchImpl }),
      callCueApi('fixture', '/second', { fetchImpl })
    ])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/oauth/token'))).toHaveLength(1)
  })

  it('does not retry a 401 using a replacement account without a refresh token', async () => {
    await persistCueTokens('fixture', { authKind: 'session', accessToken: 'old' })
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await persistCueTokens('fixture', { authKind: 'session', accessToken: 'other-user' })
      return new Response(null, { status: 401 })
    })
    expect((await callCueApi('fixture', '/first', { fetchImpl })).status).toBe(401)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('picks Cue cookies ahead of Manus mirrors and ignores lookalike domains', () => {
    const imported = parseAnyCueCredentialInput(JSON.stringify([
      { domain: '.cue.im.example', name: 'cue_session_id', value: 'unrelated' },
      { domain: '.manus.im', name: 'session_id', value: 'mirror' },
      { domain: '.cue.im', name: 'cue_session_id', value: 'primary', path: '/' },
      { domain: '.cue.im', name: 'cue_session_id', value: 'subpath', path: '/login' }
    ]))
    expect(imported.accessToken).toBe('primary')
    expect(imported.cookieHeader?.split('; ')[0]).toBe('cue_session_id=primary')
    expect(imported.cookieHeader).not.toMatch(/unrelated|mirror/)
  })
})
