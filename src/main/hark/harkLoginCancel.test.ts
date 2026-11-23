import { beforeEach, describe, expect, it, vi } from 'vitest'

const clearStorageData = vi.fn(async () => undefined)

vi.mock('electron', () => ({
  BrowserWindow: class {},
  shell: {},
  app: { getPath: () => '/tmp' },
  session: { fromPartition: () => ({ clearStorageData }) }
}))
vi.mock('../appIcon', () => ({ getAppWindowIcon: () => undefined }))
vi.mock('./harkSession', () => ({ probeHarkSession: vi.fn() }))

import { cancelHarkLogin } from './harkLogin'
import { probeHarkSession } from './harkSession'

const probe = vi.mocked(probeHarkSession)

beforeEach(() => {
  clearStorageData.mockClear()
  probe.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('cancelHarkLogin', () => {
  it('clears the partition when Hark says there is no session', async () => {
    probe.mockResolvedValue({ signedIn: false })
    await cancelHarkLogin('account')
    expect(probe).toHaveBeenCalledWith('account', { reportConnectionErrors: true })
    expect(clearStorageData).toHaveBeenCalledTimes(1)
  })

  it('keeps the partition on a network error', async () => {
    probe.mockRejectedValue(new Error('无法验证 Hark 会话'))
    await cancelHarkLogin('account')
    expect(clearStorageData).not.toHaveBeenCalled()
  })

  it('keeps the partition when the session is still valid', async () => {
    probe.mockResolvedValue({ session: { user: { id: 'u' } } })
    await cancelHarkLogin('account')
    expect(clearStorageData).not.toHaveBeenCalled()
  })
})
