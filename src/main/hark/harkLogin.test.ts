import { beforeEach, describe, expect, it, vi } from 'vitest'

const { clearStorageData, fromPartition } = vi.hoisted(() => {
  const clearStorageData = vi.fn(async () => undefined)
  return { clearStorageData, fromPartition: vi.fn(() => ({ clearStorageData })) }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {},
  BrowserWindow: class {},
  WebContentsView: class {},
  shell: { openExternal: vi.fn() },
  session: { fromPartition }
}))

import { cancelHarkLogin, closeHarkLoginWindow } from './harkLogin'

beforeEach(() => {
  clearStorageData.mockClear()
  fromPartition.mockClear()
})

describe('Hark login window teardown', () => {
  it('closeHarkLoginWindow never clears the account partition (keeps imported cookies)', () => {
    expect(closeHarkLoginWindow('acc_1')).toBe(false)
    expect(fromPartition).not.toHaveBeenCalled()
    expect(clearStorageData).not.toHaveBeenCalled()
  })

  it('cancelHarkLogin wipes the partition — so it must not follow a successful import', async () => {
    await cancelHarkLogin('acc_1')
    expect(fromPartition).toHaveBeenCalledWith('persist:bothub-account-acc_1')
    expect(clearStorageData).toHaveBeenCalledTimes(1)
  })
})
