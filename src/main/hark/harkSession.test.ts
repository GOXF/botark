import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./harkClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./harkClient')>()),
  getAuthSession: vi.fn(),
  getProfile: vi.fn()
}))

import { getAuthSession, getProfile, HarkApiError } from './harkClient'
import { probeHarkSession } from './harkSession'

const getAuthSessionMock = vi.mocked(getAuthSession)

beforeEach(() => {
  getAuthSessionMock.mockReset()
  vi.mocked(getProfile).mockReset().mockResolvedValue(null)
})

describe('Hark session validation', () => {
  it.each([null, {}, { user: null, session: null }])(
    'does not authenticate an empty get-session response: %j',
    async (response) => {
      getAuthSessionMock.mockResolvedValue(response)
      await expect(probeHarkSession('account')).resolves.toEqual({ signedIn: false })
    }
  )

  it('does not authenticate when the get-session request throws', async () => {
    getAuthSessionMock.mockRejectedValue(new Error('unauthorized'))
    expect(await probeHarkSession('account')).toEqual({ signedIn: false })
  })

  it('distinguishes a failed refresh from an expired session', async () => {
    getAuthSessionMock.mockRejectedValueOnce(new Error('timeout'))
    await expect(probeHarkSession('account', { reportConnectionErrors: true })).rejects.toThrow('无法验证')
    getAuthSessionMock.mockRejectedValueOnce(new HarkApiError(401, 'Unauthorized'))
    await expect(probeHarkSession('account', { reportConnectionErrors: true })).resolves.toEqual({ signedIn: false })
  })

  it('stays signed in when get-session has a session even if /profile answers 401', async () => {
    getAuthSessionMock.mockResolvedValue({ user: { id: 'user', email: 'fixture@example.test' } })
    vi.mocked(getProfile).mockRejectedValue(new HarkApiError(401, 'Unauthorized'))
    await expect(probeHarkSession('account', { reportConnectionErrors: true })).resolves.toMatchObject({
      handle: 'fixture@example.test'
    })
  })

  it('takes the display name from /profile without letting it decide sign-in', async () => {
    getAuthSessionMock.mockResolvedValue({ user: { id: 'user', email: 'fixture@example.test' } })
    vi.mocked(getProfile).mockResolvedValue({ email: 'fixture@example.test', nickname: 'Nick' })
    await expect(probeHarkSession('existing-account', { reportConnectionErrors: true })).resolves.toMatchObject({
      handle: 'fixture@example.test',
      displayName: 'Nick'
    })
    expect(getProfile).toHaveBeenCalledWith('existing-account', true)
  })

  it('never asks /profile when get-session has no session', async () => {
    getAuthSessionMock.mockResolvedValue(null)
    vi.mocked(getProfile).mockResolvedValue({ email: 'fixture@example.test' })
    await expect(probeHarkSession('account', { reportConnectionErrors: true })).resolves.toEqual({ signedIn: false })
    expect(getProfile).not.toHaveBeenCalled()
  })

  it('returns profile data for a valid session', async () => {
    getAuthSessionMock.mockResolvedValue({ user: { id: 'user', name: 'Hark user' } })
    await expect(probeHarkSession('account')).resolves.toEqual({
      session: { user: { id: 'user', name: 'Hark user' } },
      handle: 'Hark user',
      displayName: 'Hark user',
      userId: 'user'
    })
  })
})
