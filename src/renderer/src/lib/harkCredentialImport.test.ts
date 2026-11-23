import { describe, expect, it, vi } from 'vitest'
import { HARK_IMPORT_INVALID_MESSAGE, importHarkCredentialsForAccount } from './harkCredentialImport'

function bridge(signedIn: boolean) {
  return {
    importCredentials: vi.fn(async ({ accountId }: { accountId: string; rawInput: string }) => ({
      accountId,
      signedIn,
      handle: signedIn ? 'me@example.com' : undefined,
      displayName: signedIn ? 'Me' : undefined
    })),
    cancelLogin: vi.fn(async (accountId: string) => ({ accountId, signedIn: false }))
  }
}

describe('importHarkCredentialsForAccount', () => {
  it('imports into the given account with trimmed input and never calls cancelLogin', async () => {
    const b = bridge(true)
    const st = await importHarkCredentialsForAccount(b, 'acc_1', '  Cookie: __Secure-hark.session_token=abc  \n')
    expect(b.importCredentials).toHaveBeenCalledWith({
      accountId: 'acc_1',
      rawInput: 'Cookie: __Secure-hark.session_token=abc'
    })
    expect(b.cancelLogin).not.toHaveBeenCalled()
    expect(st).toMatchObject({ accountId: 'acc_1', signedIn: true, handle: 'me@example.com' })
  })

  it('rejects when the main process could not verify a session', async () => {
    const b = bridge(false)
    await expect(importHarkCredentialsForAccount(b, 'acc_1', 'token')).rejects.toThrow(
      HARK_IMPORT_INVALID_MESSAGE
    )
    expect(b.cancelLogin).not.toHaveBeenCalled()
  })

  it('rejects empty input and missing bridge without calling IPC', async () => {
    const b = bridge(true)
    await expect(importHarkCredentialsForAccount(b, 'acc_1', '   ')).rejects.toThrow()
    await expect(importHarkCredentialsForAccount(undefined, 'acc_1', 'x')).rejects.toThrow()
    expect(b.importCredentials).not.toHaveBeenCalled()
  })
})
