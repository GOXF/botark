import type { Cookie, CookiesSetDetails } from 'electron'
import { beforeEach, expect, it, vi } from 'vitest'

const { get, set, flushStore } = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), flushStore: vi.fn() }))
vi.mock('electron', () => ({ session: { fromPartition: () => ({ cookies: { get, set, flushStore } }) } }))
vi.mock('../webContentsViewManager', () => ({ partitionForAccount: (id: string) => id }))
vi.mock('../muse/accountProxy', () => ({ applyProxyToPartition: vi.fn() }))

import { importHarkCredentials } from './harkClient'

const original: Cookie = {
  name: '__Secure-hark.session_token', value: 'signed-in', domain: '.app.hark.com', hostOnly: false,
  path: '/', secure: true, httpOnly: true, sameSite: 'strict'
}
let cookies: Cookie[]

beforeEach(() => {
  vi.clearAllMocks()
  cookies = [original]
  get.mockImplementation(async () => cookies.map((cookie) => ({ ...cookie })))
  set.mockImplementation(async (details: CookiesSetDetails) => {
    const { url, ...cookie } = details
    const domain = cookie.domain ? `.${cookie.domain.replace(/^\./, '')}` : new URL(url).hostname
    const path = cookie.path ?? '/'
    cookies = cookies.filter((c) => c.domain !== domain || c.path !== path || c.name !== cookie.name)
    if (cookie.expirationDate !== 1) cookies.push({
      ...cookie, name: cookie.name!, value: cookie.value!, domain, path, hostOnly: !cookie.domain,
      sameSite: cookie.sameSite ?? 'lax'
    })
  })
  flushStore.mockResolvedValue(undefined)
})

it.each([false, true])('restores the prior cookie jar when verification fails (throws: %s)', async (throws) => {
  const verify = vi.fn(async () => {
    expect(cookies.some((cookie) => cookie.value === original.value)).toBe(false)
    expect(cookies.find((cookie) => cookie.name === original.name)?.value).toBe('bad')
    cookies.push({ ...original, name: 'verification-cookie', value: 'attempt' })
    if (throws) throw new Error('offline')
    return null
  })
  const result = importHarkCredentials('account', '__Secure-hark.session_token=bad', verify)
  if (throws) await expect(result).rejects.toThrow('offline')
  else await expect(result).resolves.toBeNull()
  expect(verify).toHaveBeenCalledOnce()
  expect(cookies).toEqual([original])
  expect(flushStore).toHaveBeenCalledOnce()
})

it('keeps verified credentials in the account partition', async () => {
  const verified = { user: { id: 'replacement' } }
  await expect(importHarkCredentials('account', 'replacement-token', async () => verified)).resolves.toBe(verified)
  expect(cookies.map((cookie) => cookie.value)).toEqual(['replacement-token', 'replacement-token'])
})
